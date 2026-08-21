# syntax=docker/dockerfile:1
# Multi-stage build for CentOS 7 hosts (glibc 2.17 cannot run Node 20+ binaries;
# the container ships its own glibc 2.36 from Debian bookworm).
FROM node:22-slim AS build

# Toolchain fallback: better-sqlite3 normally downloads a prebuilt binary via
# prebuild-install; these are only needed if the download fails and it compiles.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-slim

# gosu for dropping privileges to the non-root "node" user (uid 1000).
RUN apt-get update \
  && apt-get install -y --no-install-recommends gosu \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY deploy/docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0755 /usr/local/bin/entrypoint.sh \
  && mkdir -p /app/data \
  && chown node:node /app/data

ENV NODE_ENV=production \
    HOST=127.0.0.1 \
    PORT=18794 \
    DB_PATH=/app/data/idempotency.sqlite3

EXPOSE 18794

# /v1/health is public and unauthenticated by design.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||18794)+'/v1/health').then(r=>{process.exit(r.ok?0:1)}).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "src/index.js"]
