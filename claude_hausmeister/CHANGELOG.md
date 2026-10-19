# Changelog

## 0.6.2
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

## 0.6.1
- `paket_erstellen` nennt als naechsten Schritt `paket_hochladen`, wenn das Hochladen eingerichtet
  ist (vorher immer `SendUserFile`, das in normalen Sitzungen ablehnt); sonst wie bisher `SendUserFile`
- Mehr als 20 Teile: `paket_erstellen` sagt, in wie vielen Aufrufen hochzuladen ist, statt dass
  `paket_hochladen` am Limit scheitert; Rollenanweisung entsprechend ergaenzt
- Kommentar in role.sh berichtigt: Der GitHub-Token steht in der Umgebung aller Prozesse als agent,
  nutzbar ist er nur fuer den Ablage-Server (kein Bash, kein Read auf /proc). Keine Aenderung der Rechte

## 0.6.0
- Neues Werkzeug `paket_hochladen` (MCP-Server `ablage`): laedt Pakete als Anhang eines Releases in
  ein **privates** GitHub-Repo und liefert den Link fuer den Chat – die Claude-App nimmt in normalen
  Sitzungen keine Dateien an. Kein Commit, keine Git-Historie; Releases `paket-*` werden nach
  30 Tagen geloescht. Neue Optionen `ablage_github_repo`, `ablage_github_token` (leer = aus)
- Sicherheitsrelevant: (1) Managed Settings: `paket_hochladen` immer mit Freigabe (`ask`), ohne
  Repo/Token verboten. (2) Firewall: `github.com` nur frei, wenn Repo und Token gesetzt sind
  (neu: `ALLOW_DOMAINS_EXTRA` in run.sh/firewall.sh, nur schlichte Domainnamen). (3) MCP: einziger
  Netzzugriff des Servers ist `ghRequest`, nur zu api/uploads.github.com, ohne Weiterleitungen,
  Token aus allen Meldungen entfernt. Das Werkzeug prueft vor jedem Upload, dass das Repo privat
  ist, laedt nur Dateien aus `ha/` und `ausgang/` (keine Symlinks) und raeumt halbe Releases
  wieder ab. Begruendung: Der Hausmeister bekommt damit einen zweiten Weg nach aussen (neben HA),
  begrenzt auf ein Repo von Markus, mit Freigabe je Upload. Ein Token mit nur „Contents“ kann
  Sichtbarkeit und Mitglieder nicht aendern
- Pakete sind jetzt standardmaessig **ein ZIP** (vorher Markdown): mehrere Dateien immer als ein
  ZIP statt einzeln. Ist das Ergebnis nur eine Datei, geht sie direkt raus, ohne ZIP (auch das
  Werkzeug packt eine einzelne Datei dann nicht). Markdown-Paket nur auf ausdruecklichen Wunsch
- ZIP: eine einzelne Datei, die auch gepackt nicht in einen Teil passt, wird in Stuecke
  (`.stueck001`, ...) geteilt statt abgelehnt; `LIESMICH.md` erklaert das Zusammensetzen
- `SendUserFile` stellt Dateien nur in Projekt-Threads zu (Ablage in der Library des Projekts).
  In einer normalen Remote-Control-Sitzung lehnt es ab („not on a project thread“). Deshalb
  `paket_hochladen` als Standardweg; `SendUserFile` nur noch als Rueckfall

## 0.5.0
- Neuer Ordner `ausgang/` fuer Ergebnisse (Berichte, Tabellen, Diagnosen), Dateien aelter als
  30 Tage werden beim Start geloescht
- Neues Werkzeug `paket_erstellen` (eigener MCP-Server `ablage`, ohne Netz): fasst mehrere Dateien
  zu einer Markdown-Datei oder einem ZIP zusammen und teilt sie in Teile, wenn eine Groesse
  (Standard 10 MB, hoechstens 25 MB) ueberschritten wird. Der Hausmeister schickt alle Teile in
  einem Schritt per `SendUserFile` in die App – zum Herunterladen oder Weitergeben, z. B. an eine
  Cloud-Sitzung
- Auftrag „Diagnosepaket“ in der Rollenanweisung, mit Schwaerzen persoenlicher Daten
- Sicherheitsrelevant (Managed Settings/MCP): `paket_erstellen` und Schreiben in `ausgang/` ohne
  Rueckfrage. Begruendung: kein Netz, liest nur regulaere Dateien unter `ha/` und `ausgang/`
  (keine Symlinks, Pruefung auf dem echten Pfad), schreibt nur neue Dateien nach
  `ausgang/pakete/`. Empfaenger ist ueber `SendUserFile` nur die eigene App

## 0.4.2
- Firewall `enforce` unter HAOS repariert: Docker leitet DNS-Anfragen ueber seinen eingebauten
  Resolver aus dem Container-Netz heraus an den HA-DNS weiter; diese Anfragen (als root) blockierte
  die Firewall, Folge: `getaddrinfo EAI_AGAIN api.anthropic.com`. Sicherheitsrelevant: root darf
  DNS jetzt an jeden Server schicken. Der Agent (UID 1000) bleibt auf dnsmasq beschraenkt, das
  unter `enforce` nur erlaubte Namen aufloest – der DNS-Kanal bleibt fuer ihn geschlossen.
  Neuer CI-Test `.github/workflows/firewall-test.yml` stellt den HAOS-Fall nach
- Bis zu 5 gleichzeitige Sitzungen (vorher 3), je offene Sitzung rund 180 MB RAM

## 0.4.1
- Add-on-Log aufgeraeumt: Die Statusanzeige von `claude remote-control` wurde alle paar Sekunden
  neu gezeichnet (zehntausende Zeilen pro Stunde). Jetzt ohne Steuerzeichen, Verbindung und
  Kapazitaet nur bei Aenderung, Sitzungen und Hinweise einmal, jeweils mit Zeit und Praefix `rc:`.
  Nur Ausgabe, keine Rechteaenderung

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
