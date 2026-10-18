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

# Neue Modelle; bei Remote Control nur Neues/Geaendertes (keine Bugfixes); Sicherheit nur bei
# Begriffen, die das Sperrkonzept der Add-ons beruehren (Managed Settings, Deny-Regeln, Hooks)
modelle=$(grep -E '^- Added (Claude )?(Opus|Sonnet|Haiku|Fable) [0-9]' <<<"$rest" || true)
remote=$(grep -E 'Remote Control|remote-control|SendUserFile' <<<"$rest" \
         | grep -E '^- (\[Remote Control\] )?(Added|Changed|Improved|Removed)' || true)
sicher=$(grep -Ei 'managed settings|managed-settings|deny rule|permissions\.deny|bypassPermissions|allowManagedHooksOnly|security|vulnerab' <<<"$rest" \
         | grep -Evi 'mod |mods |mod.s |forceLogin|MDM|OpenTelemetry|Cowork|plugin' \
         | grep -vxF -f <(printf '%s\n' "$modelle" "$remote") || true)

zeilen() { [[ -n "$1" ]] && wc -l <<<"$1" | tr -d ' ' || echo 0; }
abschnitt() {  # Titel, Zeilen
  local n; n=$(zeilen "$2"); (( n > 0 )) || return 0
  printf '\n**%s**\n' "$1"
  head -n "$MAX" <<<"$2"
  (( n > MAX )) && echo "- … und $((n - MAX)) weitere"
  return 0
}
gezeigt=$(( $(zeilen "$modelle") + $(zeilen "$remote") + $(zeilen "$sicher") ))
weitere=$(( $(zeilen "$log") - gezeigt ))

entry() {  # neue Add-on-Version
  cat <<TXT
## $1
- Claude Code $old -> $new (automatisches Update, Stable-Kanal). Rechte, Managed Settings und
  Rollenanweisung unveraendert. Auszug aus dem Changelog von Claude Code (englisch):
$(abschnitt "Neue Modelle" "$modelle")
$(abschnitt "Neu bei Remote Control (Bedienung aus der App)" "$remote")
$(abschnitt "Sicherheit und Rechte" "$sicher")

Dazu $weitere weitere Aenderungen, vor allem Fehlerbehebungen sowie Terminal, IDE und andere
Plattformen: [vollstaendiger Changelog]($LINK)

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
