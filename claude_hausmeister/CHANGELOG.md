# Changelog

## 0.1.0
- Erste Version: Claude Code als Remote-Control-Server mit Neustart-Schleife
- Home Assistant per ha-mcp 0.1.6 (stdio, ueber den Supervisor-Proxy), fest in
  `/etc/claude-code/managed-mcp.json`
- Managed Settings: Bash, WebFetch, WebSearch gesperrt; Config-Pfade und Workspace-Settings
  nicht editierbar; nur Managed Hooks
- Egress-Firewall mit nftables + dnsmasq (off/learn/enforce), in `enforce` auch DNS gefiltert
- Einrichtungs-Terminal per Ingress (ttyd), nur bei `setup_terminal: true`
