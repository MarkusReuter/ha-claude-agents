#!/bin/bash
# Einstiegspunkt des Add-ons. Laeuft als root, richtet alles ein und startet Claude Code ohne Rechte.
# Gemeinsame Datei aller Rollen – Rollenspezifisches steht in /opt/agent/role.env und role.sh.
set -uo pipefail
source /usr/local/lib/agent-common.sh

FIREWALL_MODE=$(opt firewall_mode learn)
SETUP_TERMINAL=$(opt setup_terminal false)
USE_PTY=$(opt pty false)

# Optionen koennen Zugangsdaten enthalten – nur root darf sie lesen
chmod 0600 /data/options.json 2>/dev/null

# Persistente Verzeichnisse. Der Arbeitsordner gehoert root: der Agent darf dort weder
# CLAUDE.md noch .claude/ oder .mcp.json anlegen/aendern – sonst koennte er ueber
# Projekt-Settings (Hooks, env, statusLine) das Bash-Verbot umgehen.
install -d -o agent -g agent -m 0700 "$CONFIG_DIR"
install -d -o root  -g agent -m "${WORKSPACE_MODE:-0755}" "$WORKSPACE"
install -d -o root  -g root  -m 0755 "$WORKSPACE/.claude"
install -o root -g root -m 0644 /opt/agent/CLAUDE.md "$WORKSPACE/CLAUDE.md"
echo '{"mcpServers":{}}' > "$WORKSPACE/.mcp.json"; chown root:root "$WORKSPACE/.mcp.json"; chmod 0644 "$WORKSPACE/.mcp.json"

log "Start – Claude Code $(as_agent claude --version 2>&1 | head -1), Container $(container_name)"

# Managed Settings (bei jedem Start aus der Vorlage im Image) und rollenspezifische Verzeichnisse,
# siehe role_prepare in /opt/agent/role.sh. Ohne gueltige Settings mit Bash-Verbot startet der
# Agent nicht (fail closed) – sonst liefe Claude Code ohne Sperren.
install -d -o root -g root -m 0755 /etc/claude-code
rm -f /etc/claude-code/managed-settings.json
role_prepare
if ! jq -e '.permissions.deny | index("Bash")' /etc/claude-code/managed-settings.json >/dev/null 2>&1; then
  log "Managed Settings fehlen oder sind ungueltig – Agent wird NICHT gestartet."
  exec sleep infinity
fi
chown root:root /etc/claude-code/managed-settings.json; chmod 0644 /etc/claude-code/managed-settings.json

# Egress-Firewall. enforce schlaegt fehl -> Agent startet nicht (fail closed).
if ! ALLOW_INTERNAL_EXTRA="$ALLOW_INTERNAL_EXTRA" /usr/local/bin/firewall.sh "$FIREWALL_MODE"; then
  if [[ "$FIREWALL_MODE" == "enforce" ]]; then
    log "Firewall (enforce) konnte nicht eingerichtet werden – Agent wird NICHT gestartet."
    exec sleep infinity
  fi
  log "WARNUNG: Firewall ($FIREWALL_MODE) nicht vollstaendig eingerichtet."
fi

children=()
child=0
on_term() {
  log "Stop-Signal erhalten – beende Agent."
  kill -TERM "$child" "${children[@]}" 2>/dev/null
  wait 2>/dev/null
  exit 0
}
trap on_term TERM INT

# Einrichtungs-Terminal (Ingress) – nur wenn gewuenscht und der Eingangsfilter steht
if [[ "$SETUP_TERMINAL" == "true" ]]; then
  if nft list chain inet agentfw input >/dev/null 2>&1; then
    log "Einrichtungs-Terminal aktiv: Add-on-Seite > 'Web-UI oeffnen'. Danach setup_terminal wieder ausschalten."
    ( cd "$WORKSPACE" && as_agent ttyd --port "$TTYD_PORT" --writable --ping-interval 30 \
        -t titleFixed="$SESSION_NAME – Einrichtung" -t fontSize=15 /usr/local/bin/agent-setup ) &
    children+=($!)
  else
    log "Einrichtungs-Terminal NICHT gestartet: Eingangsfilter fehlt."
  fi
fi

pause() { sleep "$1" & child=$!; wait "$child"; child=0; }

hinweis_gezeigt=0
fast_fails=0
while true; do
  if [[ ! -s "$CONFIG_DIR/.credentials.json" || ! -f "$SETUP_MARKER" ]]; then
    if (( hinweis_gezeigt % 10 == 0 )); then
      log "Noch nicht eingerichtet. setup_terminal einschalten und 'Web-UI oeffnen' – oder per SSH:"
      log "  docker exec -it $(container_name) agent-shell"
    fi
    hinweis_gezeigt=$((hinweis_gezeigt + 1))
    pause 30
    continue
  fi

  log "Starte Remote-Control-Server '$SESSION_NAME' (Firewall: $FIREWALL_MODE, PTY: $USE_PTY)"
  start=$(date +%s)
  cd "$WORKSPACE"
  cmd=(claude remote-control --name "$SESSION_NAME" --spawn same-dir --capacity "$CAPACITY")
  if [[ "$USE_PTY" == "true" ]]; then
    # Pseudo-TTY; 'sleep infinity' haelt stdin offen, damit script kein EOF weiterreicht
    sleep infinity | as_agent script -qfec "$(printf '%q ' "${cmd[@]}")" /dev/null &
  else
    as_agent "${cmd[@]}" </dev/null &
  fi
  child=$!; wait "$child"; rc=$?; child=0
  pkill -P $$ -x sleep 2>/dev/null   # stdin-Halter der PTY-Variante

  dur=$(( $(date +%s) - start ))
  log "Server beendet (Exit $rc nach ${dur}s)."
  if (( dur < 120 )); then fast_fails=$((fast_fails + 1)); else fast_fails=0; fi
  if (( fast_fails >= 3 )); then
    log "Mehrfach sofort beendet – Login abgelaufen? Einrichtung erneut (Schritt 1). Pause 10 Minuten."
    pause 600
  else
    pause 15
  fi
done
