#!/usr/bin/env bash
# Keep everything except SSH, HTTP and HTTPS unreachable from the internet, on any provider
# (DigitalOcean and Contabo servers have no firewall by default). Run as root; safe to repeat.
#   - ufw allows only 22, 80 and 443 into the host itself.
#   - Docker's published ports (the DecMan UIs 8081-8083 and the Canton ledger API, which have no
#     authentication on LocalNet) bypass ufw through NAT, so a DOCKER-USER rule drops new
#     connections that arrive on the public interface. Replies to the containers' own outbound
#     connections still get through.
set -euo pipefail

ufw allow 22/tcp >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null

public_if=$(ip route show default | awk '{print $5; exit}')
iptables -N DOCKER-USER 2>/dev/null || true
if ! iptables -C DOCKER-USER -i "$public_if" -j DROP 2>/dev/null; then
  iptables -I DOCKER-USER -i "$public_if" -j DROP
fi
if ! iptables -C DOCKER-USER -i "$public_if" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN 2>/dev/null; then
  iptables -I DOCKER-USER -i "$public_if" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
fi
echo "firewall: only 22/80/443 are open; Docker ports are closed on $public_if"
