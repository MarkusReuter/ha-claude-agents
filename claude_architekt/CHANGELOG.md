# Changelog

## 0.1.0
- Erste Version: Coding-Agent fuer Code und Bauthemen mit Bash, Internet (IPv4) und den GitHub-Repos von `github_owner`.
  Lokales Netz (HA, Paperless, Router, andere Add-ons) und IPv6 per Firewall gesperrt
  (`EGRESS=internet`), DNS-Antworten mit privaten Adressen verworfen
- GitHub-Proxy als eigener Nutzer `gitproxy`: haelt den Token, laesst Pushes nur auf `claude/*`
  und nie Tags durch, REST-API nur lesen, Pull Request und Kommentar anlegen. Kein Merge, kein
  Workflow-Start. Austausch-Repo (`austausch_repo`, Standard `private-data`): alle Branches und
  Pakete als Release `paket-*`
- Pakete wie beim Hausmeister: derselbe MCP-Server `ablage` (`paket_erstellen`, `paket_hochladen`),
  Ordner `ausgang/`, Releases `paket-*` mit 30 Tagen Haltezeit. Der Upload laeuft ueber den Proxy,
  der Server bekommt nur einen Platzhalter statt des Tokens
- Werkzeugordner `/data/architekt/.werkzeuge` (persistent, nicht im Backup) mit vorbereiteten
  Pfaden fuer Flutter, Android-SDK, JDK, npm -g
- claude.ai-Connectoren (Gmail, Drive, Kalender) abgeschaltet; ohne diese Einstellung startet der
  Agent nicht
