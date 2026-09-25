#!/bin/bash
# Prueft, dass die gemeinsamen Dateien in allen Rollen-Add-ons identisch sind.
# Der Supervisor baut jedes Add-on nur aus seinem eigenen Ordner, deshalb liegen sie als Kopie vor.
# Referenz ist claude_hausmeister. Aufruf im Repo-Wurzelordner:
#   tools/check-common.sh          nur pruefen (Exit 1 bei Abweichung)
#   tools/check-common.sh --sync   Kopien aus claude_hausmeister ueberschreiben
set -euo pipefail
cd "$(dirname "$0")/.."

REF=claude_hausmeister
COMMON=(
  rootfs/run.sh
  rootfs/usr/local/lib/agent-common.sh
  rootfs/usr/local/bin/agent-setup
  rootfs/usr/local/bin/agent-shell
  rootfs/usr/local/bin/firewall.sh
  rootfs/usr/local/bin/firewall-status
)

rc=0
for addon in claude_*/; do
  addon=${addon%/}
  [[ "$addon" == "$REF" || ! -f "$addon/config.yaml" ]] && continue
  for f in "${COMMON[@]}"; do
    if ! cmp -s "$REF/$f" "$addon/$f"; then
      if [[ "${1:-}" == "--sync" ]]; then
        cp "$REF/$f" "$addon/$f"; echo "synchronisiert: $addon/$f"
      else
        echo "ABWEICHUNG: $addon/$f"; rc=1
      fi
    fi
  done
done
(( rc == 0 )) && echo "Gemeinsame Dateien identisch."
exit $rc
