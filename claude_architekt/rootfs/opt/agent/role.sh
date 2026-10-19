# Rollenspezifischer Teil fuer agent-common.sh (wird als root gesourct): Architekt.
# Der Agent hat Bash und Internet. Deshalb kommt kein Geheimnis in seine Umgebung: Den GitHub-Token
# haelt nur der Proxy (eigener Nutzer gitproxy, UID 1001), der Agent spricht ihn ueber 127.0.0.1 an.

GITHUB_OWNER=$(opt github_owner MarkusReuter)
GITHUB_TOKEN=$(opt github_token "")
AUSTAUSCH_REPO=$(opt austausch_repo "")
[[ -z "$AUSTAUSCH_REPO" || "$AUSTAUSCH_REPO" =~ ^[A-Za-z0-9._-]{1,100}$ ]] || AUSTAUSCH_REPO=""
# Gemini (Bilder rendern): Key ebenfalls nur beim Proxy, Tageslimit gegen Kostenexplosion
GEMINI_API_KEY=$(opt gemini_api_key "")
GEMINI_MAX_PRO_TAG=$(opt gemini_max_pro_tag 100)
[[ "$GEMINI_MAX_PRO_TAG" =~ ^[0-9]{1,4}$ ]] || GEMINI_MAX_PRO_TAG=100
GEMINI_MODELL=$(opt gemini_modell gemini-2.5-flash-image)
[[ "$GEMINI_MODELL" =~ ^[a-z0-9][a-z0-9.-]{0,80}$ ]] || GEMINI_MODELL=gemini-2.5-flash-image
PROXY_TOKEN_DIR=/run/github-proxy
GITHUB_OWNER_OK=0
[[ "$GITHUB_OWNER" =~ ^[A-Za-z0-9-]{1,39}$ ]] && GITHUB_OWNER_OK=1

# git fragt nie nach Zugangsdaten (Remote Control hat kein Terminal).
# Werkzeuge, die der Agent selbst laedt (Flutter, Android-SDK, JDK, ...), liegen persistent in
# $TOOLS_DIR (nicht im HA-Backup); PATH ueberschreibt den aus as_agent (spaeterer Eintrag gewinnt).
AGENT_ENV+=(GIT_TERMINAL_PROMPT=0 GITHUB_OWNER="$GITHUB_OWNER" GITHUB_PROXY="http://127.0.0.1:$PROXY_PORT"
            AUSTAUSCH_REPO="$AUSTAUSCH_REPO" TOOLS_DIR="$TOOLS_DIR"
            PATH="$TOOLS_DIR/bin:$TOOLS_DIR/flutter/bin:$TOOLS_DIR/jdk/bin:$TOOLS_DIR/android/cmdline-tools/latest/bin:$TOOLS_DIR/android/platform-tools:/usr/local/bin:/usr/bin:/bin"
            JAVA_HOME="$TOOLS_DIR/jdk" ANDROID_HOME="$TOOLS_DIR/android" ANDROID_SDK_ROOT="$TOOLS_DIR/android"
            PUB_CACHE="$TOOLS_DIR/pub-cache" GRADLE_USER_HOME="$TOOLS_DIR/gradle"
            NPM_CONFIG_PREFIX="$TOOLS_DIR" PIP_CACHE_DIR="$TOOLS_DIR/cache/pip" npm_config_cache="$TOOLS_DIR/cache/npm"
            FLUTTER_SUPPRESS_ANALYTICS=true DART_SUPPRESS_ANALYTICS=true GEMINI_MODELL="$GEMINI_MODELL"
            GEMINI_API_BASE="http://127.0.0.1:$PROXY_PORT/gemini")
# Pakete (MCP-Server ablage, derselbe wie beim Hausmeister): Upload ins Austausch-Repo ueber den
# Proxy. Der "Token" ist nur ein Platzhalter – der Server braucht einen Wert, der Proxy ignoriert ihn.
if [[ -n "$AUSTAUSCH_REPO" && "$GITHUB_OWNER_OK" == "1" ]]; then
  AGENT_ENV+=(ABLAGE_GITHUB_REPO="$GITHUB_OWNER/$AUSTAUSCH_REPO" ABLAGE_GITHUB_TOKEN=ueber-proxy)
fi

role_prepare() {
  # Ohne Austausch-Repo kein paket_hochladen (wie beim Hausmeister ohne Repo/Token)
  local off=()
  [[ -n "$AUSTAUSCH_REPO" && "$GITHUB_OWNER_OK" == "1" ]] || off+=(mcp__ablage__paket_hochladen)
  jq --args '.permissions.deny += $ARGS.positional | .permissions.allow -= $ARGS.positional' "${off[@]}" \
     < /opt/agent/managed-settings.json > /etc/claude-code/managed-settings.json

  # Ergebnisse und Pakete wie beim Hausmeister: ausgang/, ausgang/pakete/, nach 30 Tagen geloescht
  for d in "$WORKSPACE/ausgang" "$WORKSPACE/ausgang/pakete"; do
    if [[ -L "$d" ]]; then rm -f "$d"; fi
    [[ -d "$d" ]] || install -d -o agent -g agent -m 0700 "$d"
  done
  find "$WORKSPACE/ausgang" -xdev -type f -mtime +30 -delete 2>/dev/null || true

  # git: Repos des Owners laufen ueber den Proxy, alles andere (oeffentliche Repos) direkt
  if [[ "$GITHUB_OWNER_OK" == "1" ]]; then
    cat > /etc/gitconfig <<EOF
[url "http://127.0.0.1:$PROXY_PORT/git/$GITHUB_OWNER/"]
	insteadOf = https://github.com/$GITHUB_OWNER/
	insteadOf = git@github.com:$GITHUB_OWNER/
	insteadOf = ssh://git@github.com/$GITHUB_OWNER/
[user]
	name = Claude (Architekt)
	email = noreply@anthropic.com
[init]
	defaultBranch = main
[push]
	autoSetupRemote = true
[credential]
	helper =
EOF
    chmod 0644 /etc/gitconfig
  else
    rm -f /etc/gitconfig
    log "WARNUNG: github_owner '$GITHUB_OWNER' ist ungueltig – kein Zugriff auf private Repos."
  fi

  # Werkzeugordner gehoert dem Agenten. root legt ihn nur an und folgt keinem Link, den der Agent
  # dort hinterlassen haben koennte (sonst chown auf ein beliebiges Ziel).
  if [[ -L "$TOOLS_DIR" ]]; then rm -f "$TOOLS_DIR"; log "WARNUNG: $TOOLS_DIR war ein Link – entfernt."; fi
  [[ -d "$TOOLS_DIR" ]] || install -d -o agent -g agent -m 0755 "$TOOLS_DIR"
  as_agent mkdir -p "$TOOLS_DIR/bin"

  # Token nur fuer gitproxy lesbar (tmpfs-Ordner, bei jedem Start neu)
  install -d -o gitproxy -g gitproxy -m 0700 "$PROXY_TOKEN_DIR"
  ( umask 077; printf '%s' "$GITHUB_TOKEN" > "$PROXY_TOKEN_DIR/token"; printf '%s' "$GEMINI_API_KEY" > "$PROXY_TOKEN_DIR/gemini" )
  chown gitproxy:gitproxy "$PROXY_TOKEN_DIR/token" "$PROXY_TOKEN_DIR/gemini"

  [[ -n "$GITHUB_TOKEN" ]] || log "WARNUNG: github_token ist leer – private Repos nicht erreichbar."
  log "GitHub: Repos von $GITHUB_OWNER ueber den Proxy, Push nur auf ${BRANCH_PREFIX}*, keine Tags"
  log "Gemini: $([[ -n "$GEMINI_API_KEY" ]] && echo "an, Modell $GEMINI_MODELL, max. $GEMINI_MAX_PRO_TAG Aufrufe/Tag" || echo "aus (Option gemini_api_key leer)")"
  log "Austausch-Repo: ${AUSTAUSCH_REPO:-keins} $([[ -n "$AUSTAUSCH_REPO" ]] && echo "(alle Branches, Releases mit Dateien)")"
}

# GitHub-Proxy als gitproxy starten und bei Absturz neu starten
role_start() {
  [[ "$GITHUB_OWNER_OK" == "1" ]] || return 0
  (
    pid=0
    trap '[[ $pid != 0 ]] && kill "$pid" 2>/dev/null; exit 0' TERM
    while true; do
      setpriv --reuid=1001 --regid=1001 --clear-groups --inh-caps=-all --bounding-set=-all --no-new-privs \
        env -i PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8 TZ="${TZ:-Europe/Berlin}" \
        GITHUB_OWNER="$GITHUB_OWNER" GITHUB_TOKEN_FILE="$PROXY_TOKEN_DIR/token" AUSTAUSCH_REPO="$AUSTAUSCH_REPO" \
        GEMINI_KEY_FILE="$PROXY_TOKEN_DIR/gemini" GEMINI_MAX_PRO_TAG="$GEMINI_MAX_PRO_TAG" \
        BRANCH_PREFIX="$BRANCH_PREFIX" PROXY_PORT="$PROXY_PORT" \
        node /opt/github-proxy/proxy.mjs &
      pid=$!
      wait "$pid"
      log "GitHub-Proxy beendet (Exit $?) – Neustart in 5 s."
      pid=0
      sleep 5
    done
  ) &
  children+=($!)
}
