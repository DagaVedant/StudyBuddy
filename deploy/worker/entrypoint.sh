#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${NEXT_PUBLIC_APP_URL:-}" ]]; then
  echo "entrypoint: NEXT_PUBLIC_APP_URL is unset; refusing to start with no destination to allow." >&2
  exit 1
fi

if ! iptables -L >/dev/null 2>&1; then
  echo "entrypoint: cannot manage iptables (NET_ADMIN missing?). Refusing to start:" >&2
  echo "  a worker that thinks it is contained and is not is worse than one that is not." >&2
  exit 1
fi

app_host="$(printf '%s' "$NEXT_PUBLIC_APP_URL" | sed -E 's#^[a-z]+://##; s#/.*$##; s#:.*$##')"
echo "entrypoint: allowing egress to ${app_host}, the host gateway (Ollama) and DNS."

iptables -P OUTPUT DROP
iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -o lo -j ACCEPT

iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT

for ip in $(getent ahostsv4 "$app_host" | awk '{print $1}' | sort -u); do
  echo "entrypoint:   ${app_host} -> ${ip}"
  iptables -A OUTPUT -p tcp -d "$ip" --dport 443 -j ACCEPT
done

gateway="$(ip route | awk '/default/ {print $3; exit}')"
if [[ -n "$gateway" ]]; then
  echo "entrypoint:   ollama -> ${gateway}:11434"
  iptables -A OUTPUT -p tcp -d "$gateway" --dport 11434 -j ACCEPT
fi

exec setpriv --reuid=node --regid=node --init-groups "$@"
