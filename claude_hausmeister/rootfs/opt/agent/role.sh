# Rollenspezifischer Teil fuer agent-common.sh (wird als root gesourct): Hausmeister.
# Setzt AGENT_ENV (Umgebung fuer Claude Code und damit fuer den MCP-Server) und definiert
# role_prepare (von run.sh vor der Rechteabgabe aufgerufen).

[[ "$(opt ha_write false)" == "true" ]] && HA_WRITE=1 || HA_WRITE=0
AGENT_ENV+=(HA_WRITE="$HA_WRITE")
if [[ -n "$HA_TOKEN" ]]; then AGENT_ENV+=(HA_URL=http://supervisor/core HA_TOKEN="$HA_TOKEN"); fi

role_prepare() {
  # Managed Settings aus der Vorlage im Image erzeugen (root-eigen).
  # Schreibrecht aus: ha_write wird verboten (Claude Code bietet das Werkzeug dann gar nicht an);
  # zusaetzlich lehnt der MCP-Server Schreibbefehle ueber HA_WRITE=0 selbst ab.
  if [[ "$HA_WRITE" == "1" ]]; then
    jq . /opt/agent/managed-settings.json > /etc/claude-code/managed-settings.json
  else
    jq '.permissions.deny += ["mcp__homeassistant__ha_write"]
        | .permissions.ask -= ["mcp__homeassistant__ha_write"]' \
       /opt/agent/managed-settings.json > /etc/claude-code/managed-settings.json
  fi

  # Arbeitsdateien des MCP-Servers (Abrufe, bearbeitete Konfigurationen, automatische Sicherungen)
  install -d -o agent -g agent -m 0755 "$WORKSPACE/ha" "$WORKSPACE/ha/backup"
  # Ergebnisse fuer Markus (ausgang/) und daraus gebaute Pakete (ausgang/pakete/, MCP-Server ablage).
  # Aufraeumen: Dateien aelter als 30 Tage (-type f folgt keinen Links, loescht keine).
  install -d -o agent -g agent -m 0700 "$WORKSPACE/ausgang" "$WORKSPACE/ausgang/pakete"
  find "$WORKSPACE/ausgang" -xdev -type f -mtime +30 -delete 2>/dev/null || true

  log "Home Assistant: $([[ "$HA_WRITE" == "1" ]] && echo "lesen + SCHREIBEN (jede Aenderung mit Freigabe)" || echo "nur lesen (Option ha_write aus)")"
}
