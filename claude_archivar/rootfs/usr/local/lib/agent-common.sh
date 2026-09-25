# Gemeinsame Funktionen fuer run.sh und agent-shell (wird gesourct, laeuft als root).
# Gemeinsame Datei aller Rollen – Unterschiede gehoeren nach /opt/agent/role.env und role.sh
# (tools/check-common.sh prueft, dass die Kopien identisch sind).
source /opt/agent/role.env

CONFIG_DIR=/data/claude
WORKSPACE="${WORKSPACE:-/data/workspace}"
# Wird vom Agenten selbst am Ende der Einrichtung angelegt (liegt in seinem Config-Ordner)
SETUP_MARKER="$CONFIG_DIR/.remote-control-enabled"
TTYD_PORT=7681

log() { echo "[$(date '+%F %T')] [$ROLE] $*"; }

# Add-on-Option lesen (vom Supervisor in /data/options.json), sonst Standardwert
opt() { jq -r --arg k "$1" '.[$k] | tostring' /data/options.json 2>/dev/null | grep -v '^null$' || echo "$2"; }

# Name des Add-on-Containers fuer 'docker exec' (Repo-Add-ons: addon_<hash>_<slug>)
container_name() { echo "addon_$(hostname | tr '-' '_')"; }

# Supervisor-Token nur fuer Rollen behalten, die ihn brauchen – danach aus der Umgebung entfernen
HA_TOKEN=""
if [[ "${KEEP_HA_TOKEN:-0}" == "1" ]]; then HA_TOKEN="${SUPERVISOR_TOKEN:-}"; fi
unset SUPERVISOR_TOKEN HASSIO_TOKEN

# Zusaetzliche Umgebung fuer den Agenten (und damit fuer seine MCP-Server), gefuellt von role.sh
AGENT_ENV=()
# Zusaetzliche interne Firewall-Ziele (host:port), gefuellt von role.sh
ALLOW_INTERNAL_EXTRA=""
# Rollenspezifisch: Optionen auswerten, AGENT_ENV fuellen, role_prepare() definieren
source /opt/agent/role.sh

# Befehl als 'agent' ausfuehren: eigene UID, keine Capabilities, keine Rechteausweitung, saubere Umgebung
as_agent() {
  local envs=(HOME=/home/agent USER=agent LOGNAME=agent SHELL=/bin/bash
              PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8 TERM="${TERM:-xterm-256color}"
              TZ="${TZ:-Europe/Berlin}" CLAUDE_CONFIG_DIR="$CONFIG_DIR" DISABLE_AUTOUPDATER=1
              ROLE="$ROLE" SESSION_NAME="$SESSION_NAME" SETUP_MARKER="$SETUP_MARKER"
              WORKSPACE="$WORKSPACE" "${AGENT_ENV[@]}")
  setpriv --reuid=1000 --regid=1000 --clear-groups \
          --inh-caps=-all --bounding-set=-all --no-new-privs \
          env -i "${envs[@]}" "$@"
}
