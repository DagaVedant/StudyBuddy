#!/usr/bin/env bash
#
# Denies the worker everything but the three destinations it needs, then drops
# privilege and runs it.
#
# The rules live in the container's own network namespace, so they bound this
# process and nothing else on the host. That needs NET_ADMIN, which compose
# grants; if the host refuses it, the same effect belongs in the host firewall
# or a Tailscale ACL instead, and this script says so rather than starting a
# worker that believes it is contained when it is not.
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

# Default deny on the way out. Established connections are allowed back so the
# replies to what we permit below can return.
iptables -P OUTPUT DROP
iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -o lo -j ACCEPT

# DNS, without which the app's hostname cannot be resolved at all.
iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT

# The deployed app. Resolved once, here, rather than trusted per request: a
# hostname re-resolved later is a hostname somebody else can point elsewhere.
for ip in $(getent ahostsv4 "$app_host" | awk '{print $1}' | sort -u); do
  echo "entrypoint:   ${app_host} -> ${ip}"
  iptables -A OUTPUT -p tcp -d "$ip" --dport 443 -j ACCEPT
done

# Ollama, on the host rather than in this container. compose maps
# host.docker.internal to the gateway; 11434 is Ollama's default.
gateway="$(ip route | awk '/default/ {print $3; exit}')"
if [[ -n "$gateway" ]]; then
  echo "entrypoint:   ollama -> ${gateway}:11434"
  iptables -A OUTPUT -p tcp -d "$gateway" --dport 11434 -j ACCEPT
fi

# Privilege was only ever needed for the rules above.
exec setpriv --reuid=node --regid=node --init-groups "$@"
