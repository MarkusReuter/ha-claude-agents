# Changelog

## 0.1.4
🟡 **Sicherheits-Check: bitte lesen** – 6 Aenderung(en) beruehren das Sicherheitskonzept (unten), keine entfernt einen Baustein; 13 Fehlerbehebung(en) daran

- Claude Code 2.1.292 -> 2.1.309 (automatisches Update, Stable-Kanal). Rechte, Managed Settings und
  Rollenanweisung der Add-ons unveraendert. Auszug aus dem Changelog von Claude Code (englisch):

**Beruehrt das Sicherheitskonzept – bitte lesen**
- [MCP-Konfiguration] Changed `allowedMcpServers` to stop filtering `managed-mcp.json` stdio servers that use `${VAR}` only in `env`: one your allowlist left out now loads on upgrade; use `deniedMcpServers` to keep it off
- [Auto Mode (nicht gesperrt)] Improved session file size in auto mode: the safety classifier's context is no longer stored with every request
- [Auto Mode (nicht gesperrt)] Added `CLAUDE_CODE_AUTO_MODE_MODEL` to choose the model the client-side auto mode classifier uses; it does not change the model for server-side auto mode
- [Auto Mode (nicht gesperrt)] Improved auto mode with the server-side classifier: a conversation too long for the safety check is now compacted, instead of every checked tool call being denied
- [Auto Mode (nicht gesperrt)] Improved auto mode: a tool call that wasn't run because auto mode's check had no usable answer now shows as a dim "Not run" row instead of a red error
- [Auto Mode (nicht gesperrt)] Reverted the auto mode denial message change from 2.1.281 that told Claude a denial covers the outcome, not only the exact command

**Neue Modelle**
- Added Claude Haiku 5.5 (`claude-haiku-5-5`), now the default Haiku model on the Anthropic API — 1M context, $0.10/$0.50 per Mtok ($0.50/$2.50 for prompts over 100K)

**Neu bei Remote Control (Bedienung aus der App)**
- Improved Remote Control connect time for sessions whose transcript contains large pasted images or PDF reads
- Removed the `--sandbox` and `--no-sandbox` flags from `claude remote-control`, which had no effect; passing either now exits with an error. Set `sandbox.enabled` in settings to sandbox sessions
- Changed cloud session and Remote Control MCP connectors to negotiate MCP protocol version 2026-07-28 by default on installs that fetch no flags; `MCP_PROTOCOL_NEGOTIATION=legacy` opts out
- Improved the status shown in Remote Control, claude.ai and the desktop app for a session waiting on a permission prompt to name an MCP tool by its server and readable name instead of its `mcp__server__tool` identifier

**Fehlerbehebungen am Sicherheitskonzept**
- [Deny-Regeln] Fixed an `Edit(path)` deny rule not blocking a Bash redirect to that path in some commands that also held a subshell
- [Deny-Regeln] Fixed split-pane agent teammates not inheriting the tool deny and `--tools` rules given on the leader's command line
- [Auto Mode (nicht gesperrt)] Fixed `/permissions` > Recently denied not showing the denied shell command, and auto mode's local classifier ignoring an approval from there when it checks a retried command; approving a row now names the command, not its description
- [MCP-Konfiguration] Fixed `claude mcp list`, `claude doctor` and `/status` reporting an empty `.mcp.json` as invalid
- [Auto Mode (nicht gesperrt)] Fixed SDK and headless sessions staying in auto mode after the host switched to a model that doesn't support auto mode
- [Auto Mode (nicht gesperrt)] Fixed tools of an MCP server named `constructor` or `toString` asking for permission in auto mode and bypass permissions mode
- [Deny-Regeln] Fixed deny and ask rules for an MCP server (`mcp__<server>`) not applying when the server's normalized name contains a double underscore
- [Auto Mode (nicht gesperrt)] Fixed background subagents in auto mode sometimes sending their final report twice, once as the result and once as a message
- … und 5 weitere

Der Sicherheits-Check gleicht die Release Notes per Stichwort mit den Bausteinen des Konzepts ab
(Managed Settings, Deny-Regeln, Freigabe-Modus, Hooks, MCP, Projekt-Settings, Remote Control,
Updater, Werkzeuge) – er liest keinen Code. [Vollstaendiger Changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)

## 0.1.3
- **Zustand fuer Home Assistant:** Status-Endpunkt `http://<hostname>:7682/status` (JSON:
  `zustand`, `text`, `seit`) fuer einen REST-Sensor; eine HA-Automation meldet Stoerungen aufs
  Handy (Einrichtung in den DOCS des Hausmeisters). `zustand` = `ok` erst, wenn Remote Control
  wirklich verbunden ist („Connected“ in der Ausgabe); Unterbrechungen (`verbindung`) und
  Login-Fehler (`login`, sofort an der Fehlermeldung erkannt) werden sichtbar
- Login-Seite zeigt den Zustand mit Zeitpunkt und Farbe
- Sicherheitsrelevant: neuer eingehender Port 7682, Eingangsfilter nur von HA Core (172.30.32.1),
  Loopback und IPv6 gesperrt. Liefert nur den Zustand (nichts Geheimes), keine Login-Funktionen;
  laeuft im selben Prozess wie die Login-Seite (agent, ohne `AGENT_ENV`), auch wenn
  `setup_terminal` an ist. Keine neue Faehigkeit fuer den Agenten, kein HA-Zugang fuer
  Archivar/Architekt noetig (HA fragt ab)

## 0.1.2
- **Login-Seite im HA-Seitenmenue:** Ist `setup_terminal` aus, zeigt die Web-UI (Seitenmenue
  „Architekt“, auch in der HA-App) den Zustand des Dienstes und erneuert den Claude-Login ohne
  Terminal: „Neu anmelden“, Link im Browser bestaetigen, Code einfuegen. Kleiner Node-Server
  `/opt/agent-login/login.mjs` (gemeinsame Datei), der nur `claude auth login` startet
- Nach drei sofortigen Abbruechen (Login abgelaufen) endet die Pause von bis zu 10 Minuten, sobald
  ein neuer Login gespeichert ist; Start nach hoechstens 10 Sekunden. Fehlt der Login ganz (bei
  erledigter Einrichtung), wartet das Add-on ebenso auf die Login-Seite
- Sicherheitsrelevant: neuer eingehender Dienst auf dem bisherigen ttyd-Port 7681 – gleicher
  Eingangsfilter (nur Ingress-Proxy 172.30.32.2, Loopback und IPv6 gesperrt), also nur fuer
  HA-Admins. Laeuft als `agent` ohne `AGENT_ENV` (keine Tokens der Rolle), `claude` bekommt nur
  eine Positivliste der Umgebung. Der Code wird vor der Weitergabe geprueft (keine Leer- oder
  Steuerzeichen), angezeigt werden nur Links auf claude.com/claude.ai; POST nur mit eigenem
  Header (kein Formular von fremden Seiten). Der Agent bekommt keine neue Faehigkeit: Er erreicht
  die Seite nicht, und `claude auth login` konnte nur der Architekt (Bash) schon vorher starten
- `run.sh` schreibt den Zustand nach `/run/agent-status` (root, lesbar fuer alle, nichts Geheimes)

## 0.1.1
- **Gemini fuer Innenarchitektur, Bilder und Videos:** Neuer Weg `/gemini/…` im Proxy
  (`$GEMINI_API_BASE`) zur Google Gemini API, gleiche Pfade wie bei Google, ohne Key. Alle Aufrufe
  erlaubt (Text, Bild, Veo-Video, Interactions, Dateien). Werkzeug `gemini-bild` fuer Einzelbilder.
  Neue Optionen `gemini_api_key`, `gemini_modell`, `gemini_max_pro_tag`
- Sicherheitsrelevant: Der API-Key liegt wie der GitHub-Token nur beim Proxy (`/run/github-proxy/gemini`,
  Nutzer gitproxy), der Agent sieht ihn nicht; ein eigener `?key=` wird entfernt. Tageslimit
  (Standard 100 erzeugende Aufrufe) gegen Kosten durch Prompt Injection oder Schleifen.
  Neuer Weg nach aussen fuer Inhalte (Fotos, Plaene gehen an Google) – siehe DOCS
- Image: `python3-pil`, `python-is-python3`, `ffmpeg` (wie das Setup-Skript der Cloud-Umgebung,
  ffmpeg fuer Videos)

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
