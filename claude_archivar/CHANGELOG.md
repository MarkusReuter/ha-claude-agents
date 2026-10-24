# Changelog

## 0.2.5
- **Login-Seite im HA-Seitenmenue:** Ist `setup_terminal` aus, zeigt die Web-UI (Seitenmenue
  „Archivar“, auch in der HA-App) den Zustand des Dienstes und erneuert den Claude-Login ohne
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

## 0.2.4
- **claude.ai-Connectoren aus** (Gmail, Google Drive, Google Kalender des Pro-Kontos): Sie koennen
  ueber den Login geladen werden (ob `managed-mcp.json` sie erfasst, ist nicht belegt) und haetten
  dem Agenten Mails und Dateien geliefert, die er nicht braucht (beim Archivar: fremde Inhalte + sensible Daten neben Paperless).
  Sicherheitsrelevant: `ENABLE_CLAUDEAI_MCP_SERVERS=false` in Managed Settings und Umgebung, dazu
  Deny fuer `mcp__claude_ai_Gmail/Google_Drive/Google_Calendar`. run.sh startet den Agenten nur,
  wenn die Sperre in den Managed Settings steht (fail closed)
- Gemeinsame Dateien fuer die neue Rolle Architekt, ohne Aenderung fuer dieses Add-on:
  `firewall.sh` kennt `EGRESS=internet` aus `role.env` (hier nicht gesetzt, also weiter
  Allowlist), `run.sh` startet optionale Hintergrunddienste (`role_start`); das Bash-Verbot bleibt
  Startbedingung

## 0.2.3
- Gemeinsame Dateien abgeglichen (run.sh, firewall.sh, agent-common.sh): Firewall kennt zusaetzliche
  Domains aus `ALLOW_DOMAINS_EXTRA` (fuer das Ablage-Repo des Hausmeisters). Der Archivar setzt sie
  nicht – keine Aenderung an Verhalten oder Rechten

## 0.2.2
- Firewall `enforce` unter HAOS repariert: Docker leitet DNS-Anfragen ueber seinen eingebauten
  Resolver aus dem Container-Netz heraus an den HA-DNS weiter; diese Anfragen (als root) blockierte
  die Firewall, Folge: `getaddrinfo EAI_AGAIN api.anthropic.com`. Sicherheitsrelevant: root darf
  DNS jetzt an jeden Server schicken. Der Agent (UID 1000) bleibt auf dnsmasq beschraenkt, das
  unter `enforce` nur erlaubte Namen aufloest – der DNS-Kanal bleibt fuer ihn geschlossen.
  Neuer CI-Test `.github/workflows/firewall-test.yml` stellt den HAOS-Fall nach
- Bis zu 3 gleichzeitige Sitzungen (vorher 2), je offene Sitzung rund 180 MB RAM

## 0.2.1
- Add-on-Log aufgeraeumt: Die Statusanzeige von `claude remote-control` wurde alle paar Sekunden
  neu gezeichnet (zehntausende Zeilen pro Stunde). Jetzt ohne Steuerzeichen, Verbindung und
  Kapazitaet nur bei Aenderung, Sitzungen und Hinweise einmal, jeweils mit Zeit und Praefix `rc:`.
  Nur Ausgabe, keine Rechteaenderung

## 0.2.0
- Claude Code 2.1.273 -> 2.1.292 (Stable-Kanal): bringt Claude Opus 5.5 (ab 2.1.280) in die
  Modellauswahl der Claude-App
- Arbeitsordner `/work` -> `/archivar`, damit der Agent in der Claude-App am Ordnernamen
  erkennbar ist. Der Trust-Eintrag wird beim ersten Start uebernommen – keine neue Einrichtung
  noetig. Read-/Edit-Regeln der Managed Settings auf den neuen Pfad umgestellt (gleiche Rechte)

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

## 0.1.3
- Dokumente in der App anzeigen: Auf Wunsch schickt der Archivar das Original aus `/work/ocr/`
  mit dem Claude-Code-Werkzeug `SendUserFile` in den Chat (PDF/Bild mit Vorschau). Nur
  Rollenanweisung, keine Rechteaenderung (das Werkzeug braucht keine Freigabe und liefert nur an
  die eigene App)

## 0.1.2
- Dokument-Links zeigen auf die Vorschau `<adresse>/api/documents/<id>/preview/` (PDF/Bild direkt
  im Browser) statt auf die Detailseite; der abschliessende Schraegstrich ist fuer Paperless noetig

## 0.1.1
- Neue Option `paperless_link_url`: Die Werkzeuge liefern zu jedem Dokument einen Link
  `<adresse>/documents/<id>/details`, der Archivar nennt Dokumente damit als klickbare Links
  (PDFs lassen sich in der App nicht anzeigen, im Browser mit eigenem Login schon).
  Nur Text – die Adresse wird nie abgerufen und ist kein Firewall-Ziel.
- MCP-Server beendet sich bei geschlossenem stdin erst nach offenen Anfragen

## 0.1.0
- Erste Version nach dem Muster des Hausmeisters (Remote Control, Managed Settings,
  Egress-Firewall, Einrichtungs-Terminal)
- Eigener MCP-Server `rootfs/opt/agent-mcp/paperless.mjs` (ohne Abhaengigkeiten) mit genau sieben
  Werkzeugen: `search_documents`, `list_documents_by_tag`, `get_document`, `download_original`,
  `find_suspicious_ocr` (ohne Rueckfrage) sowie `update_content` und `set_ocr_tags` (immer mit Rueckfrage)
  - feste Liste aus Methode und Pfad, keine Loeschanfragen, kein `bulk_edit`, keine Weiterleitungen
  - `update_content` sichert den alten Inhalt zuerst als Notiz, dann PATCH nur `{"content"}`
  - `set_ocr_tags` aendert nur die zwei OCR-Tags, PATCH nur `{"tags"}`
  - Originale unter `/work/ocr` (nicht persistent), Bilder direkt, TIFF u. a. als Archiv-PDF
- Optionen `paperless_url`, `paperless_token`, `paperless_write` (Standard aus), `tag_ocr_neu`, `tag_ocr_claude`
- Read nur fuer `/work/ocr` und die eigene CLAUDE.md; `/data` (Login, Optionen mit Token) gesperrt
- Firewall: einziges internes Ziel ist Host:Port aus `paperless_url`
- Node 22.23.3 fest gepinnt, `poppler-utils` fuer PDF-Seiten im Read-Werkzeug
- Tests: `node --test claude_archivar/tests/*.test.mjs` (Mock-Paperless)
