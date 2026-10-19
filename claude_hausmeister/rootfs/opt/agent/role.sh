# Rollenspezifischer Teil fuer agent-common.sh (wird als root gesourct): Hausmeister.
# Setzt AGENT_ENV (Umgebung fuer Claude Code und damit fuer den MCP-Server) und definiert
# role_prepare (von run.sh vor der Rechteabgabe aufgerufen).

[[ "$(opt ha_write false)" == "true" ]] && HA_WRITE=1 || HA_WRITE=0
AGENT_ENV+=(HA_WRITE="$HA_WRITE")
if [[ -n "$HA_TOKEN" ]]; then AGENT_ENV+=(HA_URL=http://supervisor/core HA_TOKEN="$HA_TOKEN"); fi

# Hochladen in ein privates GitHub-Repo (paket_hochladen): nur mit Repo UND Token. Dann – und nur
# dann – ist github.com in der Firewall frei. Der Token steht (wie HA_TOKEN) in der Umgebung von
# Claude Code und damit aller Prozesse als agent (MCP-Server, agent-shell). Benutzen kann ihn nur
# der Ablage-MCP-Server: Der Agent hat kein Bash und kein Read auf /proc, kommt an die Umgebung
# also nicht heran.
ABLAGE_GITHUB_REPO=$(opt ablage_github_repo "")
ABLAGE_GITHUB_TOKEN=$(opt ablage_github_token "")
ABLAGE_UPLOAD=0
if [[ -n "$ABLAGE_GITHUB_REPO" && -n "$ABLAGE_GITHUB_TOKEN" ]]; then
  if [[ "$ABLAGE_GITHUB_REPO" =~ ^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$ ]]; then
    ABLAGE_UPLOAD=1
    AGENT_ENV+=(ABLAGE_GITHUB_REPO="$ABLAGE_GITHUB_REPO" ABLAGE_GITHUB_TOKEN="$ABLAGE_GITHUB_TOKEN")
    ALLOW_DOMAINS_EXTRA="github.com"
  fi
fi

role_prepare() {
  # Managed Settings aus der Vorlage im Image erzeugen (root-eigen).
  # Schreibrecht aus: ha_write wird verboten (Claude Code bietet das Werkzeug dann gar nicht an);
  # zusaetzlich lehnt der MCP-Server Schreibbefehle ueber HA_WRITE=0 selbst ab.
  # Ohne Repo/Token wird paket_hochladen ebenso verboten.
  local off=()
  [[ "$HA_WRITE" == "1" ]] || off+=(mcp__homeassistant__ha_write)
  [[ "$ABLAGE_UPLOAD" == "1" ]] || off+=(mcp__ablage__paket_hochladen)
  jq --args '.permissions.deny += $ARGS.positional | .permissions.ask -= $ARGS.positional' "${off[@]}" \
     < /opt/agent/managed-settings.json > /etc/claude-code/managed-settings.json

  # Arbeitsdateien des MCP-Servers (Abrufe, bearbeitete Konfigurationen, automatische Sicherungen)
  install -d -o agent -g agent -m 0755 "$WORKSPACE/ha" "$WORKSPACE/ha/backup"
  # Ergebnisse fuer Markus (ausgang/) und daraus gebaute Pakete (ausgang/pakete/, MCP-Server ablage).
  # Aufraeumen: Dateien aelter als 30 Tage (-type f folgt keinen Links, loescht keine).
  install -d -o agent -g agent -m 0700 "$WORKSPACE/ausgang" "$WORKSPACE/ausgang/pakete"
  find "$WORKSPACE/ausgang" -xdev -type f -mtime +30 -delete 2>/dev/null || true

  log "Home Assistant: $([[ "$HA_WRITE" == "1" ]] && echo "lesen + SCHREIBEN (jede Aenderung mit Freigabe)" || echo "nur lesen (Option ha_write aus)")"
  if [[ "$ABLAGE_UPLOAD" == "1" ]]; then
    log "Ablage: Hochladen nach $ABLAGE_GITHUB_REPO (jedes Mal mit Freigabe), github.com in der Firewall frei"
  elif [[ -n "$ABLAGE_GITHUB_REPO$ABLAGE_GITHUB_TOKEN" ]]; then
    log "Ablage: Repo oder Token fehlt/ungueltig – Hochladen aus"
  fi
}
