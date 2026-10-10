#!/usr/bin/env bash
# Instalación (una sola vez, como root en el servidor) del actualizador, el vigía y la ruta nginx.
# Idempotente: se puede volver a correr para actualizar unidades, scripts o snippets.
#   scp -r deploy/server lima:/tmp/incendios-server && ssh lima 'bash /tmp/incendios-server/install.sh'
set -Eeuo pipefail
cd "$(dirname "$0")"

id -u incendios >/dev/null 2>&1 || useradd --system --home-dir /opt/incendios --shell /usr/sbin/nologin incendios
mkdir -p /opt/incendios /srv/incendios-data /srv/incendios-releases /etc/incendios /var/lib/incendios-watchdog
chown incendios:incendios /srv/incendios-data
chmod 0755 /srv/incendios-data
[ -e /etc/incendios/env ] || { printf '# FIRMS_MAP_KEY=\n' > /etc/incendios/env; chmod 0640 /etc/incendios/env; chown root:incendios /etc/incendios/env; }

install -m 0755 incendios-deploy /usr/local/sbin/incendios-deploy
install -m 0755 incendios-watchdog /usr/local/sbin/incendios-watchdog
install -m 0644 incendios-update.service incendios-update.timer incendios-watchdog.service incendios-watchdog.timer /etc/systemd/system/
install -m 0644 nginx-incendios.conf /etc/nginx/snippets/incendios.conf
install -m 0644 nginx-incendios-headers.conf /etc/nginx/snippets/incendios-headers.conf

# include dentro del server { } de peruvian.dev, justo después del de erm2026 (una sola vez)
SITE=$(readlink -f /etc/nginx/sites-enabled/peruvian.dev)
if ! grep -q 'snippets/incendios.conf' "$SITE"; then
  mkdir -p /etc/nginx/backups      # nunca dentro de sites-enabled: nginx cargaría la copia
  cp -p "$SITE" "/etc/nginx/backups/peruvian.dev.pre-incendios-$(date -u +%Y%m%dT%H%M%SZ)"
  python3 - "$SITE" <<'PY'
import re, sys
p = sys.argv[1]
s = open(p, encoding="utf-8").read()
m = re.search(r"^([ \t]*)include /etc/nginx/snippets/erm2026\.conf;[ \t]*\n", s, re.M)
if not m:
    sys.exit("no encuentro el include de erm2026 en " + p)
s = s[:m.end()] + m.group(1) + "include /etc/nginx/snippets/incendios.conf;\n" + s[m.end():]
open(p, "w", encoding="utf-8").write(s)
PY
  echo "install: include añadido en $SITE"
fi

systemctl daemon-reload
systemctl enable --now incendios-update.timer incendios-watchdog.timer
nginx -t
systemctl reload nginx
echo "install: listo. Timers:"
systemctl list-timers --no-pager | grep incendios || true
