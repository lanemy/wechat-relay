#!/bin/sh
# Drops privileges to the "node" user after fixing ownership of the data
# volume (docker creates bind-mounted dirs as root when missing).
set -e

if [ "$(id -u)" = "0" ]; then
  chown -R node:node /app/data 2>/dev/null || true
  exec gosu node:node "$@"
fi

exec "$@"
