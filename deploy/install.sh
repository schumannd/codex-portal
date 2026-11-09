#!/usr/bin/env bash
# Run as root from the uploaded source directory on Debian/Ubuntu with Node 24 installed.
set -euo pipefail
if [[ $EUID -ne 0 ]]; then echo 'Run as root' >&2; exit 1; fi
node -e 'if(Number(process.versions.node.split(".")[0])<24)process.exit(1)'
command -v caddy >/dev/null || { echo 'Install Caddy from its official Debian repository first' >&2; exit 1; }
id codexportal >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/codex-portal --shell /bin/bash codexportal
install -d -m 755 /opt/codex-portal
# Do not upload local runtime data or secrets.
tar --exclude='./data' --exclude='./node_modules' --exclude='./.env' --exclude='./.git' -cf - . | tar -xf - -C /opt/codex-portal
cd /opt/codex-portal
if [[ -f package-lock.json ]]; then
  npm ci --omit=dev
else
  npm install --omit=dev
fi
npm install -g @openai/codex
chown -R root:root /opt/codex-portal
chmod -R go-w /opt/codex-portal
if [[ ! -f /etc/codex-portal.env ]]; then
  (umask 077; printf 'ORIGIN=https://app.schumann.com.de\n' > /etc/codex-portal.env)
fi
install -m 644 deploy/codex-portal.service /etc/systemd/system/codex-portal.service
# Preserve existing Caddy sites. Add an import rather than replacing the main config.
install -d -m 755 /etc/caddy/sites
install -m 644 deploy/Caddyfile /etc/caddy/sites/codex-portal.caddy
if ! grep -qF 'import /etc/caddy/sites/*.caddy' /etc/caddy/Caddyfile; then
  printf '\nimport /etc/caddy/sites/*.caddy\n' >> /etc/caddy/Caddyfile
fi
caddy validate --config /etc/caddy/Caddyfile
systemctl daemon-reload
systemctl enable --now codex-portal
systemctl reload caddy
if [[ -f /etc/codex-telegram.env ]]; then
  install -m 644 deploy/codex-telegram.service /etc/systemd/system/codex-telegram.service
  systemctl daemon-reload
  systemctl enable --now codex-telegram
fi
printf 'Portal installed. Authenticate Codex as codexportal, then manually create an account and issue an enrollment code.\n'
