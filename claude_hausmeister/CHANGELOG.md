# Changelog

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
