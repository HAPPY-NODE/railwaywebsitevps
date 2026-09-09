#!/bin/bash
# startup.sh — container entrypoint. Railway runs this as the main process.
set -e
echo "[startup] HAPPY NODE Sandbox Manager booting…"
mkdir -p "${DATA_DIR:-/data}" /home/abc/.vnc
chmod 777 "${DATA_DIR:-/data}" 2>/dev/null || true
cd /app
exec node src/server.js