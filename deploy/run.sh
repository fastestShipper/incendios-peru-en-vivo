#!/usr/bin/env bash
# Publica el sitio y el actualizador en el servidor (peruvian.dev/incendios).
#   bash deploy/run.sh [host]     (host por defecto: lima)
# Primera vez en el servidor: scp -r deploy/server lima:/tmp/incendios-server && ssh lima 'bash /tmp/incendios-server/install.sh'
set -Eeuo pipefail
cd "$(dirname "$0")/.."
HOST="${1:-lima}"
v=$(git rev-parse --short HEAD 2>/dev/null || echo dev)
git diff --quiet 2>/dev/null || v="$v+local"
echo "$v" > VERSION
echo "publicando versión $v en $HOST…"
tar -czf - index.html mapa-2d.html estado.html manifest.json assets data/ref data/incidentes_curados.json scripts/update.py VERSION \
  | ssh "$HOST" /usr/local/sbin/incendios-deploy site
