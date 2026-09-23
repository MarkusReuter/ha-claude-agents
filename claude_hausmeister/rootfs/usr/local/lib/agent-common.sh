# Gemeinsame Funktionen fuer run.sh und agent-shell (wird gesourct, laeuft als root)
source /opt/agent/role.env

CONFIG_DIR=/data/claude
WORKSPACE=/data/workspace
# Wird vom Agenten selbst am Ende der Einrichtung angelegt (liegt in seinem Config-Ordner)
SETUP_MARKER="$CONFIG_DIR/.remote-control-enabled"
TTYD_PORT=7681

log() { echo "[$(date '+%F %T')] [$ROLE] $*"; }

# Name des Add-on-Containers fuer 'docker exec' (Repo-Add-ons: addon_<hash>_<slug>)
container_name() { echo "addon_$(hostname | tr '-' '_')"; }

# Supervisor-Token nur fuer Rollen behalten, die ihn brauchen – danach aus der Umgebung entfernen
HA_TOKEN=""
if [[ "${KEEP_HA_TOKEN:-0}" == "1" ]]; then HA_TOKEN="${SUPERVISOR_TOKEN:-}"; fi
unset SUPERVISOR_TOKEN HASSIO_TOKEN

# Befehl als 'agent' ausfuehren: eigene UID, keine Capabilities, keine Rechteausweitung, saubere Umgebung
as_agent() {
  local envs=(HOME=/home/agent USER=agent LOGNAME=agent SHELL=/bin/bash
              PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8 TERM="${TERM:-xterm-256color}"
              TZ="${TZ:-Europe/Berlin}" CLAUDE_CONFIG_DIR="$CONFIG_DIR" DISABLE_AUTOUPDATER=1
              ROLE="$ROLE" SESSION_NAME="$SESSION_NAME" SETUP_MARKER="$SETUP_MARKER"
              WORKSPACE="$WORKSPACE")
  if [[ -n "$HA_TOKEN" ]]; then envs+=(HA_URL=http://supervisor/core HA_TOKEN="$HA_TOKEN"); fi
  setpriv --reuid=1000 --regid=1000 --clear-groups \
          --inh-caps=-all --bounding-set=-all --no-new-privs \
          env -i "${envs[@]}" "$@"
}
