# Rollenspezifischer Teil fuer agent-common.sh (wird als root gesourct): Archivar.
# Setzt AGENT_ENV (Umgebung fuer Claude Code und damit fuer den MCP-Server), das Firewall-Ziel
# fuer Paperless und definiert role_prepare (von run.sh vor der Rechteabgabe aufgerufen).
# Der Paperless-Token wird nie ausgegeben.

PAPERLESS_URL=$(opt paperless_url "http://ca5234a0-paperless-ngx:80")
PAPERLESS_URL=${PAPERLESS_URL%/}
PAPERLESS_TOKEN=$(opt paperless_token "")
# Oeffentliche Adresse nur fuer klickbare Links in den Antworten (kein Firewall-Ziel)
PAPERLESS_LINK_URL=$(opt paperless_link_url "")
[[ "$(opt paperless_write false)" == "true" ]] && PAPERLESS_WRITE=1 || PAPERLESS_WRITE=0
TAG_OCR_NEU=$(opt tag_ocr_neu ocr-neu)
TAG_OCR_CLAUDE=$(opt tag_ocr_claude ocr-claude)

# Firewall: genau das Ziel aus paperless_url freigeben (Host:Port)
PAPERLESS_URL_OK=0
if [[ "$PAPERLESS_URL" =~ ^(https?)://([A-Za-z0-9.-]+)(:([0-9]{1,5}))?(/[A-Za-z0-9._~/-]*)?$ ]]; then
  pl_port=${BASH_REMATCH[4]:-$([[ ${BASH_REMATCH[1]} == https ]] && echo 443 || echo 80)}
  ALLOW_INTERNAL_EXTRA="${BASH_REMATCH[2]}:$pl_port"
  PAPERLESS_URL_OK=1
fi

AGENT_ENV+=(PAPERLESS_URL="$PAPERLESS_URL" PAPERLESS_TOKEN="$PAPERLESS_TOKEN" PAPERLESS_LINK_URL="$PAPERLESS_LINK_URL"
            PAPERLESS_WRITE="$PAPERLESS_WRITE" OCR_DIR="$OCR_DIR"
            TAG_OCR_NEU="$TAG_OCR_NEU" TAG_OCR_CLAUDE="$TAG_OCR_CLAUDE")

WRITE_TOOLS='["mcp__paperless__update_content","mcp__paperless__set_ocr_tags"]'

role_prepare() {
  # Managed Settings aus der Vorlage im Image erzeugen (root-eigen).
  # Schreibrecht aus: update_content und set_ocr_tags werden verboten (Claude Code bietet sie dann
  # gar nicht an); zusaetzlich lehnt der MCP-Server Schreibbefehle ueber PAPERLESS_WRITE=0 ab.
  if [[ "$PAPERLESS_WRITE" == "1" ]]; then
    jq . /opt/agent/managed-settings.json > /etc/claude-code/managed-settings.json
  else
    jq --argjson w "$WRITE_TOOLS" '.permissions.deny += $w | .permissions.ask -= $w' \
       /opt/agent/managed-settings.json > /etc/claude-code/managed-settings.json
  fi

  # Ablage fuer heruntergeladene Originale: nur der Agent (bzw. sein MCP-Server), bei jedem Start leer
  install -d -o agent -g agent -m 0700 "$OCR_DIR"
  find "$OCR_DIR" -mindepth 1 -delete

  if [[ "$PAPERLESS_URL_OK" != "1" ]]; then
    log "WARNUNG: paperless_url '$PAPERLESS_URL' ist ungueltig (erwartet http://host:port) – kein Firewall-Ziel."
  fi
  [[ -n "$PAPERLESS_TOKEN" ]] || log "WARNUNG: paperless_token ist leer – der Archivar erreicht Paperless nicht."
  log "Paperless: $PAPERLESS_URL – $([[ "$PAPERLESS_WRITE" == "1" ]] && echo "lesen + Inhalt/OCR-Tags aendern (jede Aenderung mit Freigabe)" || echo "nur lesen (Option paperless_write aus)")"
  log "OCR-Tags: '$TAG_OCR_NEU', '$TAG_OCR_CLAUDE'"
  log "Links in Antworten: ${PAPERLESS_LINK_URL:-keine (Option paperless_link_url leer)}"
}
