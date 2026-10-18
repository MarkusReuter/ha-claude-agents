# Changelog

## 0.4.0
- Claude Code 2.1.273 -> 2.1.292 (Stable-Kanal): bringt Claude Opus 5.5 (ab 2.1.280) in die
  Modellauswahl der Claude-App. Managed Settings unveraendert
- Arbeitsordner `/data/workspace` -> `/data/hausmeister`, damit der Agent in der Claude-App am
  Ordnernamen erkennbar ist. Der alte Ordner (inkl. `ha/backup/`) wird beim ersten Start
  verschoben und der Trust-Eintrag uebernommen – keine neue Einrichtung noetig. Pfade in
  Managed Settings, MCP-Konfiguration und Rollenanweisung entsprechend angepasst (gleiche Rechte)

Auszug aus dem Changelog von Claude Code 2.1.274 bis 2.1.292 (englisch):

**Neue Modelle**
- Added Claude Sonnet 5.5 (`claude-sonnet-5-5`), now the default Sonnet model on the Anthropic API — 1M context, $2/$10 per Mtok with $0.20/Mtok cache reads
- Added Claude Opus 5.5 (`claude-opus-5-5`), now the default Opus model — 1M context, $4/$20 per Mtok with $0.20/Mtok cache reads

**Neu bei Remote Control (Bedienung aus der App)**
- Improved Remote Control's recovery from an expired server credential: sessions stay connected during renewal and are kept if it gives up after a server outage
- Improved delivery of files Claude sends from cloud sessions and Remote Control: an upload that fails on a timeout, a network error or a 502, 503 or 504 is now retried once
- Improved the explanation Claude gives when the server refuses a file it sends from a Remote Control or cloud session, such as an oversized image
- Improved Remote Control: a `/btw` side question asked of a session hosted by an app such as Claude Desktop now sees the turn in progress, not only the last finished one
- Changed `/claude-api` so it can no longer be run from Remote Control clients
- Improved `claude remote-control`: in a folder you haven't trusted yet, it now asks for workspace trust on the terminal instead of exiting
- Changed `/recap` to decline with a short notice when it arrives relayed from a chat thread (your own included) or from a routine or webhook; typed in the terminal, the Claude apps, Remote Control, `-p` or an SDK host, it runs as before
- Improved the `/plugin` plugin and marketplace details menus and the `/remote-control` already-connected menu: they now support Home/End and clicking a row
- … und 2 weitere

**Sicherheit und Rechte**
- Security: Fixed PreToolUse hook approvals and auto mode bypassing the permission prompt for file reads from network (UNC) paths
- Fixed a spurious "could not be examined" note for @-words that name no file when a Read deny rule is set and the working directory is under a symlink
- Added a warning when a managed settings file is a link to a file outside the managed settings folder
- Added a /status and doctor warning when managed settings ignore user-configured sandbox allowRead paths or allowed domains
- Fixed a project `CLAUDE.md`, rule or `AGENTS.md` symlinked outside the working directories loading under `permissions.blockReadsOutsideWorkingDirectories` or a `Read` deny rule
- Fixed Read deny rules not applying to image paths pasted or dragged into the prompt, or to file names listed for an @-mentioned folder
- Fixed slow or failed startup since 2.1.285 under SDK hosts such as the VS Code extension when managed settings deny reads of many paths on a slow filesystem (notably Windows drives under WSL)
- Fixed Bash permission checks not applying Read deny rules or the outside-directory read block to a wildcard in some option values of read-only commands
- … und 11 weitere

Dazu 1563 weitere Aenderungen, vor allem Fehlerbehebungen sowie Terminal, IDE und andere
Plattformen: [vollstaendiger Changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)

## 0.3.2
- Dateien in der App anzeigen: Auf Wunsch schickt der Hausmeister Dateien aus
  `/data/workspace/ha/` mit dem Claude-Code-Werkzeug `SendUserFile` in den Chat. Nur
  Rollenanweisung, keine Rechteaenderung

## 0.3.1
- Gemeinsame Dateien mit dem Archivar (run.sh, agent-common.sh, agent-setup, agent-shell,
  firewall.sh, firewall-status); Rollenspezifisches in `opt/agent/role.sh` und `role.env`.
  `tools/check-common.sh` prueft, dass die Kopien identisch sind. Verhalten unveraendert, ausser:
- Start bricht ab (fail closed), wenn die Managed Settings nicht erzeugt werden konnten
- `/data/options.json` nur noch fuer root lesbar
- firewall.sh prueft interne Ziele streng auf `host:port` und meldet nicht aufloesbare Ziele,
  statt still abzubrechen

## 0.3.0
- Neue Option `ha_write` (Standard: aus). Aus = der Hausmeister kann Home Assistant nur lesen:
  `ha_write` wird in den Managed Settings verboten und vom MCP-Server abgelehnt.
  Die Option verwaltet der Supervisor – der Agent kann sie nicht aendern.
- Managed Settings werden bei jedem Start aus `/opt/agent/managed-settings.json` erzeugt

## 0.2.0
- ha-mcp ersetzt durch eigenen MCP-Server `rootfs/opt/agent-mcp/homeassistant.mjs` (ohne Abhaengigkeiten)
  - `ha_read`: WebSocket-Befehle aus einer Lese-Liste und REST-GET, ohne Rueckfrage
  - `ha_write`: Dashboards, Automationen, Helfer, Entity-Registry, Services – immer mit Rueckfrage,
    vorher automatische Sicherung unter `ha/backup/`
  - gesperrt: Auth, Integrationen, Supervisor/Add-ons, Backups, Services `hassio.*`/`backup.*`
  - grosse Antworten und Arbeitskopien als Dateien unter `/data/workspace/ha/`
- Rollenbeschreibung (CLAUDE.md) mit HA-Arbeitsweise

## 0.1.1
- Einrichtung wiederholt Schritt 1, bis Ordner-Vertrauen und Login gespeichert sind; Statuszeile
- Claude Code fest auf 2.1.273 gepinnt (bisher Kanal `stable`)

## 0.1.0
- Erste Version: Claude Code als Remote-Control-Server mit Neustart-Schleife
- Home Assistant per ha-mcp 0.1.6 (stdio, ueber den Supervisor-Proxy), fest in
  `/etc/claude-code/managed-mcp.json`
- Managed Settings: Bash, WebFetch, WebSearch gesperrt; Config-Pfade und Workspace-Settings
  nicht editierbar; nur Managed Hooks
- Egress-Firewall mit nftables + dnsmasq (off/learn/enforce), in `enforce` auch DNS gefiltert
- Einrichtungs-Terminal per Ingress (ttyd), nur bei `setup_terminal: true`
