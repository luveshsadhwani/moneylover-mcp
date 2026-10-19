#!/usr/bin/env bash
set -euo pipefail
umask 077
cd /opt/moneylover
exec 9>/run/lock/moneylover-update.lock
flock -n 9 || exit 0
# --rollback restores the last healthy digest and pauses automatic updates.
compose() { docker compose --env-file active.env -f compose.yaml "$@"; }
if [[ ${1:-} == --rollback ]]; then
  test -s previous.env
  cp previous.env active.env
  compose up -d --no-deps --wait --wait-timeout 120 mcp
  touch PAUSED
  echo 'Rolled back; remove /opt/moneylover/PAUSED to resume updates.'
  exit 0
fi
[[ ! -e PAUSED ]] || exit 0
image='ghcr.io/luveshsadhwani/moneylover-mcp:latest'
docker pull "$image"
digest=$(docker image inspect --format '{{index .RepoDigests 0}}' "$image")
[[ $digest =~ ^ghcr.io/luveshsadhwani/moneylover-mcp@sha256:[a-f0-9]{64}$ ]] || exit 1
current=$(cat active.env 2>/dev/null || true)
[[ "$current" != "MCP_IMAGE=$digest" ]] || exit 0
[[ ! -f rejected.env ]] || [[ $(cat rejected.env) != "MCP_IMAGE=$digest" ]] || exit 0
printf 'MCP_IMAGE=%s\n' "$digest" > candidate.env
had_previous=false
if [[ -s active.env ]]; then cp active.env rollback.env; had_previous=true; fi
mv candidate.env active.env
if compose up -d --no-deps --wait --wait-timeout 120 mcp; then
  # Confirm the container rejects unauthenticated MCP requests before promoting.
  if compose exec -T mcp node -e "fetch('http://127.0.0.1:3000/mcp',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})}).then(r=>process.exit(r.status===401?0:1)).catch(()=>process.exit(1))"; then
    if $had_previous; then mv rollback.env previous.env; fi
    compose up -d --no-deps tunnel
    echo "Installed $digest"
    exit 0
  fi
fi
cp active.env rejected.env
if $had_previous; then
  mv rollback.env active.env
  compose up -d --no-deps --wait --wait-timeout 120 mcp
  echo 'Candidate failed; restored previous image.' >&2
else
  compose stop mcp
  rm -f active.env
  echo 'Initial candidate failed; service stopped.' >&2
fi
exit 1
