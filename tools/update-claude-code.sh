#!/bin/bash
# Hebt Claude Code in allen Rollen-Add-ons auf die aktuelle Stable-Version: Dockerfile-ARG,
# Add-on-Version (+1 Patch) und ein CHANGELOG-Eintrag, der in Home Assistant beim Update erscheint.
# Aus dem (sehr langen) Changelog von Claude Code kommt nur, was die Agenten betrifft: neue Modelle,
# Remote Control, Sicherheit/Rechte. Laeuft monatlich per .github/workflows/claude-code-update.yml,
# geht aber auch lokal im Repo-Wurzelordner:
#   tools/update-claude-code.sh            auf Stable heben (nichts tun, wenn aktuell)
#   tools/update-claude-code.sh 2.1.300    auf eine bestimmte Version heben
# Schreibt changed=true/false und die Versionen nach $GITHUB_OUTPUT (falls gesetzt).
set -euo pipefail
cd "$(dirname "$0")/.."

RELEASES=https://downloads.claude.ai/claude-code-releases
UPSTREAM=https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md
LINK=https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md
MAX=8    # hoechstens so viele Zeilen je Abschnitt

out() { [[ -n "${GITHUB_OUTPUT:-}" ]] && echo "$1" >> "$GITHUB_OUTPUT"; return 0; }

new=${1:-$(curl -fsSL "$RELEASES/stable")}
[[ "$new" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Unerwartete Version: '$new'" >&2; exit 1; }
old=$(sed -n 's/^ARG CLAUDE_CODE_VERSION=//p' claude_hausmeister/Dockerfile)
[[ "$old" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Keine feste Version im Dockerfile: '$old'" >&2; exit 1; }

if [[ "$old" == "$new" || "$(printf '%s\n' "$old" "$new" | sort -V | tail -1)" != "$new" ]]; then
  echo "Claude Code ist aktuell ($old, Stable: $new)."
  out changed=false
  exit 0
fi
echo "Claude Code $old -> $new"

# Eintraege aller Versionen > old und <= new
log=$(curl -fsSL "$UPSTREAM" | awk -v lo="$old" -v hi="$new" '
  function num(v, a) { split(v, a, "."); return a[1] * 1e8 + a[2] * 1e4 + a[3] }
  /^## [0-9]+\.[0-9]+\.[0-9]+/ { v = num($2); p = (v > num(lo) && v <= num(hi)); next }
  p && /^- / { print }')
[[ -n "$log" ]] || { echo "Keine Changelog-Eintraege fuer $old..$new gefunden." >&2; exit 1; }

# Was die Agenten nicht betrifft (IDE, Code Review, andere Plattformen/Anbieter)
skip='\[(VSCode|JetBrains|Code Review|Desktop)\]|^- (Windows|macOS|Self-hosted|Self-Hosted)|/ultrareview|/code-review|Agent SDK|Bedrock|Vertex|Foundry|Mantle|gateway|Enterprise|Team plan|Chrome'
rest=$(grep -Ev "$skip" <<<"$log" || true)

# --- Sicherheits-Check -----------------------------------------------------------------------
# Abgleich der Release Notes mit den Bausteinen, auf denen das Sicherheitskonzept beruht
# (docs/architektur.md, Anhang A). Stichwortbasiert – ersetzt kein Lesen, findet aber zuverlaessig,
# wenn eine Aenderung einen dieser Bausteine erwaehnt. Bewertung je Zeile:
#   Fixed ...                               -> Fehlerbehebung (Sperren greifen besser)
#   Removed/Deprecated/"no longer"/"ignored" -> ROT: Baustein koennte wegfallen, kein Push
#   sonst (Added/Changed/Improved ...)      -> GELB: neues Verhalten, im Changelog hervorgehoben
BAUSTEINE=(
  "Managed Settings|managed settings|managed-settings|managed policy|policySettings"
  "Deny-Regeln|deny rule|permissions\.deny|[^a-z]deny[^a-z]|blockReadsOutsideWorkingDirectories"
  "Freigabe-Modus|bypassPermissions|disableBypassPermissionsMode|disableAutoMode|defaultMode|dangerously-skip"
  "Hooks|allowManagedHooksOnly|managed hooks"
  "MCP-Konfiguration|managed-mcp|managed MCP|allowedMcpServers|deniedMcpServers|\.mcp\.json"
  "Projekt-Settings|project settings|\.claude/settings|settings\.local\.json"
  "Remote Control|remote-control.*(--spawn|--capacity|--name)|SendUserFile"
  "Updater/Konfig|DISABLE_AUTOUPDATER|auto-?updat|CLAUDE_CONFIG_DIR"
  "Neues Werkzeug|^- Added (a |an |the )?(new )?\`?[A-Z][A-Za-z]+\`? tool"
  "Gesperrte Werkzeuge|(Bash|WebFetch|WebSearch|NotebookEdit)[^.;]*(deny|denied|disabl)"
)
# Treffer, die fuer die Add-ons keine Rolle spielen (Mods, Plugins, MDM/Org-Login, Telemetrie,
# andere Oberflaechen und Plattformen)
SEC_SKIP='(^|[^a-z])mod(s|.s)?([^a-z]|$)|forceLogin|MDM|OpenTelemetry|OTel|OTEL_|Cowork|plugin|sandbox|\[Claude Tag\]|Slack|screen reader|Windows|WSL|HKLM|HKCU|third-party provider|VS Code|Claude Desktop|MANAGED_BY_HOST|claude agents'
# Auto Mode zaehlt nur, solange ihn nicht alle Add-ons per disableAutoMode sperren
if ! jq -se 'all(.[]; .permissions.disableAutoMode == "disable")' claude_*/rootfs/opt/agent/managed-settings.json >/dev/null; then
  BAUSTEINE+=("Auto Mode (nicht gesperrt)|auto mode")
fi
ROT='^- (Removed|Deprecated)|no longer (appl|honou?r|support|respect|enforc|read|load)|(is|are) (now )?ignored|now ignore'

# Ein awk-Lauf statt grep je Zeile; Ausgabe "F|G|R<TAB>- [Baustein] Text", Muster ohne Gross/klein
bewertet=$(B="$(printf '%s\n' "${BAUSTEINE[@]}")" SKIP="$SEC_SKIP" ROT="$ROT" awk '
  BEGIN { n = split(ENVIRON["B"], b, "\n")
          for (i = 1; i <= n; i++) { p = index(b[i], "|"); name[i] = substr(b[i], 1, p - 1); re[i] = tolower(substr(b[i], p + 1)) }
          skip = tolower(ENVIRON["SKIP"]); rot = tolower(ENVIRON["ROT"]) }
  { z = tolower($0); if (z == "" || z ~ skip) next
    for (i = 1; i <= n; i++) if (z ~ re[i]) {
      k = (z ~ /^- (security: )?fixed/) ? "F" : (z ~ rot) ? "R" : "G"
      print k "\t- [" name[i] "] " substr($0, 3); next } }' <<<"$rest")
teil() { grep "^$1"$'\t' <<<"$bewertet" | cut -f2- || true; }
fixes=$(teil F); gelb=$(teil G); rot=$(teil R)

zeilen() { [[ -n "$1" ]] && wc -l <<<"$1" | tr -d ' ' || echo 0; }
nf=$(zeilen "$fixes"); ng=$(zeilen "$gelb"); nr=$(zeilen "$rot")
if (( nr > 0 )); then
  siegel="🔴 **Sicherheits-Check: nicht freigegeben** – $nr Aenderung(en) koennten einen Baustein des Sicherheitskonzepts entfernen"
elif (( ng > 0 )); then
  siegel="🟡 **Sicherheits-Check: bitte lesen** – $ng Aenderung(en) beruehren das Sicherheitskonzept (unten), keine entfernt einen Baustein"
else
  siegel="🟢 **Sicherheits-Check: unbedenklich** – keine Aenderung an Funktionen, auf die das Sicherheitskonzept baut"
fi
(( nf > 0 )) && siegel+="; $nf Fehlerbehebung(en) daran"
echo "$siegel"
[[ -n "${GITHUB_STEP_SUMMARY:-}" ]] && printf '%s\n\n%s\n%s\n' "$siegel" "$rot" "$gelb" >> "$GITHUB_STEP_SUMMARY"
if (( nr > 0 )) && [[ "${ACCEPT_RED:-0}" != "1" ]]; then
  printf '%s\n' "$rot" >&2
  echo "Kein Update: erst pruefen, dann ggf. mit ACCEPT_RED=1 (Action: Eingabe accept_red) erneut starten." >&2
  out changed=false
  exit 3
fi

# Neue Modelle; bei Remote Control nur Neues/Geaendertes (keine Bugfixes)
modelle=$(grep -E '^- Added (Claude )?(Opus|Sonnet|Haiku|Fable) [0-9]' <<<"$rest" || true)
remote=$(grep -E 'Remote Control|remote-control' <<<"$rest" \
         | grep -E '^- (\[Remote Control\] )?(Added|Changed|Improved|Removed)' || true)
abschnitt() {  # Titel, Zeilen
  local n; n=$(zeilen "$2"); (( n > 0 )) || return 0
  printf '\n**%s**\n' "$1"
  head -n "$MAX" <<<"$2"
  (( n > MAX )) && echo "- … und $((n - MAX)) weitere"
  return 0
}
entry() {  # neue Add-on-Version
  cat <<TXT
## $1
$siegel

- Claude Code $old -> $new (automatisches Update, Stable-Kanal). Rechte, Managed Settings und
  Rollenanweisung der Add-ons unveraendert. Auszug aus dem Changelog von Claude Code (englisch):
$(MAX=50 abschnitt "Entfernt womoeglich einen Baustein des Sicherheitskonzepts" "$rot")
$(MAX=20 abschnitt "Beruehrt das Sicherheitskonzept – bitte lesen" "$gelb")
$(abschnitt "Neue Modelle" "$modelle")
$(abschnitt "Neu bei Remote Control (Bedienung aus der App)" "$remote")
$(abschnitt "Fehlerbehebungen am Sicherheitskonzept" "$fixes")

Der Sicherheits-Check gleicht die Release Notes per Stichwort mit den Bausteinen des Konzepts ab
(Managed Settings, Deny-Regeln, Freigabe-Modus, Hooks, MCP, Projekt-Settings, Remote Control,
Updater, Werkzeuge) – er liest keinen Code. [Vollstaendiger Changelog]($LINK)

TXT
}

versionen=()
for addon in claude_*/; do
  addon=${addon%/}
  grep -q '^ARG CLAUDE_CODE_VERSION=' "$addon/Dockerfile" 2>/dev/null || continue
  cur=$(sed -n 's/^version: "\(.*\)"$/\1/p' "$addon/config.yaml")
  [[ "$cur" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]] || { echo "$addon: Version '$cur' unlesbar" >&2; exit 1; }
  ver="${BASH_REMATCH[1]}.${BASH_REMATCH[2]}.$((BASH_REMATCH[3] + 1))"

  sed "s/^ARG CLAUDE_CODE_VERSION=.*/ARG CLAUDE_CODE_VERSION=$new/" "$addon/Dockerfile" > "$addon/Dockerfile.tmp"
  mv "$addon/Dockerfile.tmp" "$addon/Dockerfile"
  sed "s/^version: \".*\"$/version: \"$ver\"/" "$addon/config.yaml" > "$addon/config.yaml.tmp"
  mv "$addon/config.yaml.tmp" "$addon/config.yaml"
  { sed -n '1,2p' "$addon/CHANGELOG.md"; entry "$ver" | cat -s; sed '1,2d' "$addon/CHANGELOG.md"; } > "$addon/CHANGELOG.md.tmp"
  mv "$addon/CHANGELOG.md.tmp" "$addon/CHANGELOG.md"

  echo "$addon: $cur -> $ver"
  versionen+=("$addon $ver")
done

out changed=true
out old="$old"
out new="$new"
out "addons=$(IFS=,; echo "${versionen[*]}")"
