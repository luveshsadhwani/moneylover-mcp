#!/usr/bin/env bash
# Scope rules ONLY to this service's fixed Docker subnet; never flush host rules.
set -euo pipefail
[[ $EUID == 0 ]] || exit 1
subnet=172.30.90.0/24
iptables -w -N MONEYLOVER_EGRESS 2>/dev/null || true
add() { iptables -w -C "$@" 2>/dev/null || iptables -w -A "$@"; }
# Containers may talk to each other, but not MongoDB, the host, metadata or other LANs.
add MONEYLOVER_EGRESS -d "$subnet" -j RETURN
for target in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 127.0.0.0/8; do
  add MONEYLOVER_EGRESS -d "$target" -j REJECT
done
add MONEYLOVER_EGRESS -p tcp -m multiport --dports 443,7844 -j RETURN
add MONEYLOVER_EGRESS -p udp --dport 7844 -j RETURN
add MONEYLOVER_EGRESS -j REJECT
iptables -w -C DOCKER-USER -s "$subnet" -j MONEYLOVER_EGRESS 2>/dev/null || iptables -w -I DOCKER-USER 1 -s "$subnet" -j MONEYLOVER_EGRESS
iptables -w -C INPUT -s "$subnet" -j REJECT 2>/dev/null || iptables -w -I INPUT 1 -s "$subnet" -j REJECT
