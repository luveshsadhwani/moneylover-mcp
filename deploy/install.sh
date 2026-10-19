#!/usr/bin/env bash
set -euo pipefail
[[ $EUID == 0 ]] || { echo 'Run with sudo.' >&2; exit 1; }
cd "$(dirname "$0")"
docker compose version >/dev/null
install -d -m 700 /opt/moneylover /opt/moneylover/secrets
install -m 600 compose.yaml /opt/moneylover/compose.yaml
install -m 700 firewall.sh /opt/moneylover/firewall.sh
install -m 700 update.sh /opt/moneylover/update.sh
if [[ ! -f /opt/moneylover/service.env ]]; then install -m 600 service.env.example /opt/moneylover/service.env; fi
install -m 644 moneylover-update.service moneylover-update.timer moneylover-firewall.service /etc/systemd/system/
systemctl daemon-reload
cat <<'TEXT'
Files installed. Automatic deployment is NOT enabled until configuration is ready.
1. Edit /opt/moneylover/service.env (replace every placeholder).
2. Create secret files without a trailing newline:
   /opt/moneylover/secrets/moneylover_email    owner 1000:1000, mode 400
   /opt/moneylover/secrets/moneylover_password owner 1000:1000, mode 400
   /opt/moneylover/secrets/tunnel_token        owner 65532:65532, mode 400
   Parent directories remain root-only; Docker mounts these files for the service UIDs.
3. If GHCR is private, run sudo docker login ghcr.io with a read:packages token.
4. Configure Tunnel/Access using README; the origin is http://mcp:3000.
5. Check 172.30.90.0/24 does not overlap existing Docker/VPC networks.
   Enable isolation: sudo systemctl enable --now moneylover-firewall.service
   Run sudo /opt/moneylover/update.sh and verify the service.
6. Enable deployment: sudo systemctl enable --now moneylover-update.timer
TEXT
