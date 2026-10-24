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

# Umzug aus einem frueheren Arbeitsordner (WORKSPACE_OLD in role.env): Inhalt verschieben und den
# Trust-Eintrag uebernehmen, damit die Einrichtung nicht wiederholt werden muss. Die .claude.json
# gehoert dem Agenten – deshalb bearbeitet er sie selbst (root folgt keinen Links in seinem Ordner).
if [[ -n "${WORKSPACE_OLD:-}" && "$WORKSPACE_OLD" != "$WORKSPACE" ]]; then
  if [[ -d "$WORKSPACE_OLD" && ! -L "$WORKSPACE_OLD" && ! -e "$WORKSPACE" ]]; then
    mv "$WORKSPACE_OLD" "$WORKSPACE" && log "Arbeitsordner umgezogen: $WORKSPACE_OLD -> $WORKSPACE"
  fi
  as_agent bash -c 'umask 077; f="$1/.claude.json"; [[ -f "$f" && ! -L "$f" ]] || exit 1
    jq -e --arg o "$2" --arg n "$3" ".projects[\$o] != null and .projects[\$n] == null" "$f" >/dev/null || exit 1
    jq --arg o "$2" --arg n "$3" ".projects[\$n] = .projects[\$o]" "$f" > "$f.tmp" && mv "$f.tmp" "$f"' \
    _ "$CONFIG_DIR" "$WORKSPACE_OLD" "$WORKSPACE" && log "Trust-Eintrag von $WORKSPACE_OLD fuer $WORKSPACE uebernommen."
fi

install -d -o root  -g agent -m "${WORKSPACE_MODE:-0755}" "$WORKSPACE"
install -d -o root  -g root  -m 0755 "$WORKSPACE/.claude"
install -o root -g root -m 0644 /opt/agent/CLAUDE.md "$WORKSPACE/CLAUDE.md"
echo '{"mcpServers":{}}' > "$WORKSPACE/.mcp.json"; chown root:root "$WORKSPACE/.mcp.json"; chmod 0644 "$WORKSPACE/.mcp.json"

log "Start – Claude Code $(as_agent claude --version 2>&1 | head -1), Container $(container_name)"

# Managed Settings (bei jedem Start aus der Vorlage im Image) und rollenspezifische Verzeichnisse,
# siehe role_prepare in /opt/agent/role.sh. Ohne gueltige Settings mit Bash-Verbot und
# abgeschalteten claude.ai-Connectoren (Gmail, Drive, Kalender des Kontos – sensible Daten, die
# keine Rolle braucht) startet der Agent nicht (fail closed). Rollen mit BASH_ERLAUBT=1 in
# role.env (Architekt) brauchen nur die Connector-Sperre.
install -d -o root -g root -m 0755 /etc/claude-code
rm -f /etc/claude-code/managed-settings.json
role_prepare
settings_ok='.env.ENABLE_CLAUDEAI_MCP_SERVERS == "false" and (.permissions.deny | type == "array")'
[[ "${BASH_ERLAUBT:-0}" == "1" ]] || settings_ok+=' and (.permissions.deny | index("Bash") != null)'
if ! jq -e "$settings_ok" /etc/claude-code/managed-settings.json >/dev/null 2>&1; then
  log "Managed Settings fehlen oder sind ungueltig – Agent wird NICHT gestartet."
  exec sleep infinity
fi
chown root:root /etc/claude-code/managed-settings.json; chmod 0644 /etc/claude-code/managed-settings.json

# Egress-Firewall. enforce schlaegt fehl -> Agent startet nicht (fail closed).
if ! ALLOW_INTERNAL_EXTRA="$ALLOW_INTERNAL_EXTRA" ALLOW_DOMAINS_EXTRA="$ALLOW_DOMAINS_EXTRA" \
     /usr/local/bin/firewall.sh "$FIREWALL_MODE"; then
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

# Rollenspezifische Hintergrunddienste (Architekt: GitHub-Proxy), PIDs landen in children
if declare -F role_start >/dev/null; then role_start; fi

# Ingress (HA-Seitenmenue): Einrichtungs-Terminal, wenn gewuenscht, sonst die Login-Seite zum
# Erneuern des Logins vom Handy. Dazu immer der Status-Endpunkt fuer HA Core (Port 7682, nur
# Zustand). Alles nur, wenn der Eingangsfilter steht (firewall.sh). Login-Seite und Status bekommen
# AGENT_ENV nicht – sie brauchen keinen Token der Rolle.
status_set startet "Startet"
if ! nft list chain inet agentfw input >/dev/null 2>&1; then
  log "Einrichtungs-Terminal, Login-Seite und Status NICHT gestartet: Eingangsfilter fehlt."
else
  login_port="$TTYD_PORT"
  if [[ "$SETUP_TERMINAL" == "true" ]]; then
    login_port=""
    log "Einrichtungs-Terminal aktiv: Add-on-Seite > 'Web-UI oeffnen'. Danach setup_terminal wieder ausschalten."
    ( cd "$WORKSPACE" && as_agent ttyd --port "$TTYD_PORT" --writable --ping-interval 30 \
        -t titleFixed="$SESSION_NAME – Einrichtung" -t fontSize=15 /usr/local/bin/agent-setup ) &
    children+=($!)
  else
    log "Login-Seite aktiv: HA-Seitenmenue > '$SESSION_NAME' (auch in der HA-App)."
  fi
  ( AGENT_ENV=(LOGIN_PORT="$login_port" STATUS_PORT="$STATUS_PORT" AGENT_STATUS_FILE="$STATUS_FILE")
    cd "$WORKSPACE" && as_agent node /opt/agent-login/login.mjs ) &
  children+=($!)
  log "Status fuer HA: http://$(hostname):$STATUS_PORT/status (nur von HA Core erreichbar)"
fi

# Zustand 'login' (rc_log erkennt ihn an der Fehlermeldung) bleibt, bis die Verbindung steht
status_weich() { jq -e '.zustand == "login"' "$STATUS_FILE" >/dev/null 2>&1 || status_set "$@"; }

pause() { sleep "$1" & child=$!; wait "$child"; child=0; }

# Pause, die endet, sobald ein neuer Login gespeichert ist (Login-Seite oder Terminal).
# stat folgt keinem Link, den der Agent dort hinterlassen haben koennte.
login_stand() { stat -c '%s %y' "$CONFIG_DIR/.credentials.json" 2>/dev/null; }
warte_auf_login() {
  local vorher i
  vorher=$(login_stand)
  for (( i = 0; i < $1; i += 10 )); do
    pause 10
    if [[ "$(login_stand)" != "$vorher" ]]; then
      log "Neuer Login gespeichert – starte neu."
      status_set startet "Neuer Login – verbindet …"
      return
    fi
  done
}

# Ausgabe von 'claude remote-control' fuers Add-on-Log. Die Statusanzeige wird alle paar Sekunden
# neu gezeichnet (sonst zehntausende Zeilen pro Stunde): Steuerzeichen entfernen, Verbindungs- und
# Kapazitaetszeile nur bei Aenderung, alle anderen Zeilen (Sitzungen, Hinweise, Fehler) beim ersten Mal.
# Dabei den Zustand fuer Login-Seite und HA nachfuehren (gleiche Form wie status_set):
# "Connected · <name> · <branch>" = ok, Abbruch danach = verbindung, Login-Fehler = login.
rc_log() {
  ROLE="$ROLE" STATUS_FILE="$STATUS_FILE" perl -MPOSIX=strftime -ne '
    BEGIN { $| = 1 }
    sub zustand {
      my ($z, $t) = @_;
      return if $z eq ($akt // ""); $akt = $z;
      my $s = strftime("%Y-%m-%dT%H:%M:%S%z", localtime); $s =~ s/(\d\d)$/:$1/;
      my $f = $ENV{STATUS_FILE};
      open(my $o, ">", "$f.tmp") or return;
      print $o qq({"zustand":"$z","text":"$t","seit":"$s"}\n); close $o;
      chmod 0644, "$f.tmp"; rename "$f.tmp", $f;
    }
    s/\e\][^\a\e]*(?:\a|\e\\)//g; s/\e\[[0-9;?]*[A-Za-z]//g; s/[\r\n]//g;
    s/^[^[:alnum:]\[]+//;  # Rahmen-/Spinnerzeichen am Anfang
    next unless length;
    if (/^Connected\b/) { zustand("ok", "Verbunden") }
    elsif (/^(?:Reconnecting|Disconnected|Offline)\b/i || (/^Connecting\b/ && ($akt // "") eq "ok")) {
      zustand("verbindung", "Verbindung unterbrochen – verbindet neu") }
    elsif (/must be logged in|requires a claude\.ai subscription/) {
      zustand("login", "Login ungueltig oder abgelaufen – bitte neu anmelden") }
    my $k = /^Capacity:/ ? "cap" : /Connected|Connecting|Reconnect|Disconnected|offline/ ? "status" : "";
    if ($k) { next if ($last{$k} // "") eq $_; $last{$k} = $_ }
    else    { next if $seen{$_}++; %seen = ($_ => 1) if keys %seen > 500 }
    my @t = localtime; printf "[%04d-%02d-%02d %02d:%02d:%02d] [%s] rc: %s\n",
      $t[5] + 1900, $t[4] + 1, @t[3, 2, 1, 0], $ENV{ROLE}, $_;'
}

hinweis_gezeigt=0
fast_fails=0
while true; do
  if [[ ! -f "$SETUP_MARKER" ]]; then
    status_set einrichtung "Nicht eingerichtet – setup_terminal einschalten"
    if (( hinweis_gezeigt % 10 == 0 )); then
      log "Noch nicht eingerichtet. setup_terminal einschalten und 'Web-UI oeffnen' – oder per SSH:"
      log "  docker exec -it $(container_name) agent-shell"
    fi
    hinweis_gezeigt=$((hinweis_gezeigt + 1))
    pause 30
    continue
  fi
  if [[ ! -s "$CONFIG_DIR/.credentials.json" ]]; then
    status_set login "Kein Login – bitte neu anmelden"
    if (( hinweis_gezeigt % 10 == 0 )); then
      log "Kein Login gespeichert. Neu anmelden: HA-Seitenmenue > '$SESSION_NAME' (Login-Seite)."
    fi
    hinweis_gezeigt=$((hinweis_gezeigt + 1))
    warte_auf_login 30
    continue
  fi

  status_weich startet "Verbindet …"
  log "Starte Remote-Control-Server '$SESSION_NAME' (Firewall: $FIREWALL_MODE, PTY: $USE_PTY)"
  start=$(date +%s)
  cd "$WORKSPACE"
  cmd=(claude remote-control --name "$SESSION_NAME" --spawn same-dir --capacity "$CAPACITY")
  if [[ "$USE_PTY" == "true" ]]; then
    # Pseudo-TTY; 'sleep infinity' haelt stdin offen, damit script kein EOF weiterreicht
    sleep infinity | as_agent script -qfec "$(printf '%q ' "${cmd[@]}")" /dev/null > >(rc_log) 2>&1 &
  else
    as_agent "${cmd[@]}" </dev/null > >(rc_log) 2>&1 &
  fi
  child=$!; wait "$child"; rc=$?; child=0
  pkill -P $$ -x sleep 2>/dev/null   # stdin-Halter der PTY-Variante

  dur=$(( $(date +%s) - start ))
  log "Server beendet (Exit $rc nach ${dur}s)."
  if (( dur < 120 )); then fast_fails=$((fast_fails + 1)); else fast_fails=0; fi
  if (( fast_fails >= 3 )); then
    status_set login "Login abgelaufen? Mehrfach sofort beendet – bitte neu anmelden"
    log "Mehrfach sofort beendet – Login abgelaufen? Neu anmelden: HA-Seitenmenue > '$SESSION_NAME'." \
        "Pause bis zu 10 Minuten (endet beim neuen Login)."
    warte_auf_login 600
    fast_fails=0
  else
    status_weich neustart "Server beendet (Exit $rc), Neustart in 15 Sekunden"
    pause 15
  fi
done
