# syntax=docker/dockerfile:1
# Multi-stage build for CentOS 7 hosts (glibc 2.17 cannot run Node 20+ binaries;
# the container ships its own glibc 2.36 from Debian bookworm).
#
# Optional mirror overrides for slow links (defaults are official sources):
#   docker compose build --build-arg APT_MIRROR=mirrors.tuna.tsinghua.edu.cn \
#                        --build-arg NPM_REGISTRY=https://registry.npmmirror.com
FROM node:22-slim AS build

ARG APT_MIRROR=deb.debian.org
ARG NPM_REGISTRY=

# bookworm slim uses deb822 format in sources.list.d/debian.sources; older
# images may still use /etc/apt/sources.list — patch whichever exists.
RUN set -eux; \
  if [ -f /etc/apt/sources.list.d/debian.sources ]; then \
    sed -i "s|deb.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources; \
  fi; \
  if [ -f /etc/apt/sources.list ]; then \
    sed -i "s|deb.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list || true; \
  fi

# Toolchain fallback: better-sqlite3 normally downloads a prebuilt binary via
# prebuild-install; these are only needed if the download fails and it compiles.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN if [ -n "${NPM_REGISTRY}" ]; then NPM_FLAG="--registry=${NPM_REGISTRY}"; else NPM_FLAG=""; fi \
  && npm ci --omit=dev ${NPM_FLAG}

FROM node:22-slim

ARG APT_MIRROR=deb.debian.org

RUN set -eux; \
  if [ -f /etc/apt/sources.list.d/debian.sources ]; then \
    sed -i "s|deb.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources; \
  fi; \
  if [ -f /etc/apt/sources.list ]; then \
    sed -i "s|deb.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list || true; \
  fi

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
