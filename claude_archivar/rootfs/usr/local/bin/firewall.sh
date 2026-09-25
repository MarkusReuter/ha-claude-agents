#!/bin/bash
# Egress-Filter im Container (nftables, eigene Tabelle inet agentfw). Modi:
#   off     – kein Egress-Filter (nur zum ersten Ausprobieren)
#   learn   – nichts wird blockiert; DNS-Anfragen werden geloggt, Ziele, die enforce
#             blockieren wuerde, landen im Set 'waere_blockiert' (firewall-status zeigt es)
#   enforce – nur erlaubte Domains (TCP 443), interne Ziele (role.env ALLOW_INTERNAL plus
#             ALLOW_INTERNAL_EXTRA aus der Umgebung, z. B. aus einer Add-on-Option) und DNS ueber dnsmasq;
#             dnsmasq loest nur noch erlaubte Domains auf (schliesst den DNS-Kanal)
# Unabhaengig vom Modus: Einrichtungs-Terminal (ttyd) nur vom Ingress-Proxy erreichbar.
# Exit != 0 heisst: Regeln nicht (vollstaendig) gesetzt.
set -euo pipefail
MODE="${1:-learn}"
EXTRA="${ALLOW_INTERNAL_EXTRA:-}"
source /opt/agent/role.env
log() { echo "[firewall] $*"; }

TTYD_PORT=7681
INGRESS_IP=172.30.32.2     # Supervisor (Ingress-Proxy) im hassio-Netz
ANTHROPIC_NET=160.79.104.0/23
ORIG_RESOLV=/etc/resolv.conf.orig

# Idempotent: alten Stand entfernen, urspruenglichen Resolver wiederherstellen
nft delete table inet agentfw 2>/dev/null || true
pkill -x dnsmasq 2>/dev/null || true
[[ -f "$ORIG_RESOLV" ]] || cp /etc/resolv.conf "$ORIG_RESOLV"
cat "$ORIG_RESOLV" > /etc/resolv.conf   # bind-mount: Inhalt ersetzen, nicht die Datei

# Eingehend: ttyd nur vom Ingress-Proxy
nft -f - <<EOF
table inet agentfw {
  chain input {
    type filter hook input priority filter; policy accept;
    tcp dport $TTYD_PORT ip saddr != $INGRESS_IP drop
    meta nfproto ipv6 tcp dport $TTYD_PORT drop
  }
}
EOF
log "Eingang: Port $TTYD_PORT nur von $INGRESS_IP"

if [[ "$MODE" == "off" ]]; then
  log "AUS – kein Egress-Filter aktiv."
  exit 0
fi

UPSTREAM_DNS=$(awk '/^nameserver/{print $2; exit}' "$ORIG_RESOLV")
[[ -n "$UPSTREAM_DNS" && "$UPSTREAM_DNS" != "127.0.0.1" ]] || { log "Kein Upstream-DNS gefunden"; exit 1; }
SEARCH_LINE=$(grep -E '^(search|options)' "$ORIG_RESOLV" || true)

# Interne Ziele aufloesen, solange noch der normale Resolver aktiv ist
INTERNAL_RULES=""
INTERNAL_HOSTS=()
for entry in ${ALLOW_INTERNAL:-} $EXTRA; do
  # Werte landen in nft-Regeln und dnsmasq-Argumenten: nur Hostname:Port zulassen
  [[ "$entry" =~ ^[A-Za-z0-9.-]+:[0-9]{1,5}$ ]] || { log "Ungueltiges internes Ziel: $entry"; exit 1; }
  host=${entry%%:*}; port=${entry##*:}
  ip=$(getent ahostsv4 "$host" | awk 'NR==1{print $1}') || ip=""
  [[ -n "$ip" ]] || { log "Kann $host nicht aufloesen"; exit 1; }
  INTERNAL_RULES+="    ip daddr $ip tcp dport $port accept"$'\n'
  INTERNAL_HOSTS+=("$host")
  log "intern erlaubt: $host ($ip) Port $port"
done

if [[ "$MODE" == "enforce" ]]; then
  FINAL='counter reject with icmpx type admin-prohibited'
else
  FINAL='meta nfproto ipv4 update @waere_blockiert { ip daddr . meta l4proto . th dport }
    counter accept comment "waere-blockiert"'
fi

nft -f - <<EOF
table inet agentfw {
  set allow4 {
    type ipv4_addr; flags timeout; timeout 1d;
  }
  set waere_blockiert {
    type ipv4_addr . inet_proto . inet_service; flags dynamic, timeout; timeout 7d;
  }
  chain output {
    type filter hook output priority filter; policy accept;
    # DNS nur ueber dnsmasq (127.0.0.1) – ausser root (dnsmasq selbst)
    meta skuid != 0 meta l4proto { tcp, udp } th dport 53 ip daddr != 127.0.0.1 counter reject
    meta skuid != 0 meta nfproto ipv6 meta l4proto { tcp, udp } th dport 53 counter reject
    oifname "lo" accept
    ct state established,related accept
    meta skuid 0 ip daddr $UPSTREAM_DNS meta l4proto { tcp, udp } th dport 53 accept
    ip daddr $ANTHROPIC_NET tcp dport 443 accept
    ip daddr @allow4 tcp dport 443 accept
$INTERNAL_RULES
    $FINAL
  }
}
EOF

# dnsmasq: traegt die IPs erlaubter Domains beim Aufloesen in @allow4 ein
NFTSET_SPEC=""
for d in $ALLOW_DOMAINS; do NFTSET_SPEC+="/$d"; done
NFTSET_SPEC+="/4#inet#agentfw#allow4"

DNSMASQ_ARGS=(--keep-in-foreground --no-resolv --no-hosts
              --listen-address=127.0.0.1 --bind-interfaces --user=root
              --cache-size=500 --max-cache-ttl=300 --filter-AAAA
              --nftset="$NFTSET_SPEC" --log-facility=-)
if [[ "$MODE" == "enforce" ]]; then
  # Nur erlaubte Domains und interne Namen werden weitergeleitet, alles andere: REFUSED
  for d in $ALLOW_DOMAINS "${INTERNAL_HOSTS[@]}"; do DNSMASQ_ARGS+=(--server="/$d/$UPSTREAM_DNS"); done
else
  DNSMASQ_ARGS+=(--server="$UPSTREAM_DNS" --log-queries)
fi
/usr/sbin/dnsmasq "${DNSMASQ_ARGS[@]}" 2>&1 | sed -u 's/^/[dns] /' &
sleep 1
pgrep -x dnsmasq >/dev/null || { log "dnsmasq startet nicht"; exit 1; }
{ echo "nameserver 127.0.0.1"; [[ -n "$SEARCH_LINE" ]] && echo "$SEARCH_LINE"; } > /etc/resolv.conf

if [[ "$MODE" == "enforce" ]]; then
  log "ENFORCE – nur Allowlist erlaubt ($ALLOW_DOMAINS, $ANTHROPIC_NET)."
else
  log "LEARN – nichts blockiert. Auswertung: firewall-status"
fi
