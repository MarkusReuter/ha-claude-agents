# Uebergabe: Drei Claude-Code-Agenten als Home-Assistant-Add-ons

Stand: 23.09.2026. Zusammenfassung eines Planungsgespraechs in der Claude-App.
Ziel dieser Session: das Repo als echtes HA-Add-on-Repository fertigstellen, Stufe 1
(Hausmeister-Grundgeruest) testen, danach MCP-Anbindung und die beiden anderen Rollen.

## 1. Feste Entscheidungen (nicht neu aufrollen)

1. Zwei Rechner: KimWeb-Entwicklung, Azure-DevOps-Build-Agent und Playwright laufen auf einem
   eigenen Rechner nur bei Bedarf – nicht Gegenstand dieses Repos.
2. Die drei Agenten laufen auf dem Dauerlaeufer mit **Home Assistant OS**; dort laeuft Paperless-ngx bereits.
3. Umsetzung als **HA-Add-ons** (ein Container je Rolle), eingebunden ueber dieses GitHub-Repo.
4. Drei Rollen, je eigenes Dateisystem und eigene Zugangsdaten (Anhang A des Plans):
   - **Hausmeister** – nur Home Assistant (risikoaermster Fall, wird zuerst gebaut)
   - **Archivar** – Paperless + Mail, nur lesend, kein Weg nach aussen
   - **Sekretaer** – Mail lesen und Entwuerfe schreiben
5. Bedienung per `claude remote-control` ueber die Claude-App (nur ausgehende Verbindungen).
6. Konto: alle drei Agenten unter dem privaten **Pro**-Abo. Sie teilen sich dessen Nutzungslimit.
7. MCP-Server fuer Paperless und IMAP schreibt der Nutzer selbst, per stdio im selben Container.

Plan-Datei: `claude/heimserver-plan.md` im KimWeb-Repo. Gueltig sind Teil 1 (Verbindungstest,
insb. 1.5 Abnahmekriterien, 1.7 Grenzen von Remote Control) und Anhang A (Sicherheitsmodell).
Teil 2/3 (Windows/Hyper-V) sind ueberholt. **Aufgabe:** 1.5 auf HAOS uebertragen und mit dem
Testplan unten abgleichen.

## 2. Hardware

- Dauerlaeufer: Lenovo ThinkCentre M910q Tiny, i5-7500T (4C/4T), amd64, aktuell 8 GB RAM,
  davon ca. 54 % belegt (HA + Paperless).
- Geplant: Aufruestung auf **32 GB** (2x 16 GB DDR4-2400 SO-DIMM, max. vom M910q unterstuetzt).
  CPU-Tausch lohnt nicht – die Modelle laufen bei Anthropic, fuer die Agenten zaehlt fast nur RAM.
  Lokale KI ist derzeit kein Thema.
- Ersatzrechner: zweiter identischer M910q. Bei Ausfall wird das letzte HA-Cloud-Backup eingespielt.
  Add-on-Daten (`/data`, inkl. Claude-Login) sind im Backup enthalten. Ohne mehr RAM laufen dort im
  Notfall HA und Paperless, die Agenten nicht sicher.
- Grobe RAM-Schaetzung Endausbau: HA+Add-ons 1–2 GB, Paperless 1–1,5 GB (OCR-Spitze bis 3 GB),
  3x Claude Code 1 GB normal bis 3–6 GB bei langen Sitzungen. 8 GB reichen fuer einen Test,
  nicht fuer den Endausbau. **Messwerte aus dem Test (Add-on-RAM Leerlauf / lange Sitzung) sammeln.**

## 3. Recherchierte Fakten (Claude-Code-Doku, Stand Sept. 2026)

- **Kein `claude setup-token`**: Langzeit-Tokens (auch `CLAUDE_CODE_OAUTH_TOKEN`) koennen nur
  Modellanfragen und keine Remote-Control-Sitzungen. Noetig ist ein voller `/login`.
- Nutzer berichten, dass der OAuth-Login nach Inaktivitaet bzw. ca. 28 Tagen ablaeuft ->
  gelegentliches Neu-Einloggen einplanen; run.sh erkennt Dauer-Abbrueche und pausiert.
- Einmalig interaktiv noetig: Workspace-Trust-Dialog im Projektordner, `/login`,
  Bestaetigung "Enable Remote Control? (y/n)".
- **Server-Modus beendet sich nach ca. 10 Min. Netzausfall** -> Neustart-Schleife in run.sh
  (ersetzt die geplanten Aufgaben aus Plan 3.5); `boot: auto` als zweite Absicherung.
- `DISABLE_TELEMETRY`, `DO_NOT_TRACK`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`,
  `DISABLE_GROWTHBOOK` **nicht setzen** – sie schalten die Feature-Flag-Abfrage ab, von der
  Remote Control abhaengt.
- Remote Control braucht nur ausgehend HTTPS/443 zur Anthropic-API.
- Session-URL steht im Add-on-Log; die Session erscheint aber auch per Name (`--name`)
  in der Claude-App unter "Code".
- Server-Flags genutzt: `--name`, `--capacity`. Weitere: `--spawn session|same-dir|worktree`,
  `--permission-mode`, `--verbose`, `--debug-file`.
- Claude Code braucht kein Node mehr (natives Binary per `https://claude.ai/install.sh`).

## 4. HAOS-Befunde und Designentscheidungen

- **Add-on** ist der richtige Weg. Kein `image:` in config.yaml -> der Supervisor baut lokal aus dem
  Dockerfile. (Vorgebaute Images in GHCR spaeter optional; dann muss das Package oeffentlich sein.)
- Basis `debian:bookworm-slim` statt HA-Base-Image: kein s6, damit run.sh als root die Umgebung
  bereinigen und die Rechte kontrolliert abgeben kann.
- `/data` ist persistent und im HA-Backup: `CLAUDE_CONFIG_DIR=/data/claude`, Arbeitsordner
  `/data/workspace`.
- **Egress pro Add-on gibt es im Supervisor nicht**, alle Add-ons haengen am selben Bridge-Netz.
  **Router-Regeln je Container-IP sind unmoeglich**: der Verkehr verlaesst den Host per NAT,
  der Router sieht nur die Host-IP.
  -> Loesung: Firewall **im Container** (iptables + ipset + dnsmasq), gesetzt von root in run.sh,
  danach laeuft Claude Code als `agent` (UID 1000) ohne Capabilities und mit `no-new-privs`.
  Das Add-on braucht dafuer `privileged: [NET_ADMIN]`.
- **Deny-Regeln in `/etc/claude-code/managed-settings.json`** (root-eigen im Image) statt nur in
  `.claude/settings.json` – der Agent koennte Dateien in seinem Arbeitsordner umschreiben.
  Das ist die wichtigste Schicht; die Firewall ist die zweite gegen Konfigurationsfehler.
- **HA/Supervisor-Zugriff**: Archivar und Sekretaer bekommen `homeassistant_api: false`,
  `hassio_api: false`, der `SUPERVISOR_TOKEN` wird vor dem Rechtewechsel entfernt, und die Firewall
  laesst das interne Netz 172.30.32.0/23 nur zu erlaubten Zielen (z. B. Paperless) durch.
  Der Hausmeister bekommt `homeassistant_api: true`, kein `hassio_api` (Token wird als
  `HA_TOKEN`, URL `http://supervisor/core` an den Agenten gereicht).
- Erstanmeldung: Add-on "Advanced SSH & Web Terminal", Schutzmodus kurz aus,
  `docker exec -it addon_<repo-hash>_claude_hausmeister agent-shell`, danach Schutzmodus wieder an.
  Kein dauerhaftes Ingress-Terminal im Agenten-Add-on (zusaetzlicher Weg in den Container).
  **Achtung:** Bei Repo-Add-ons heisst der Container nicht `addon_local_...`, sondern
  `addon_<hash>_claude_hausmeister` – mit `docker ps` nachsehen und den Hinweis in run.sh
  anpassen (z. B. Namen aus `hostname` ableiten).

## 5. Repo-Aufbau

```
repository.yaml
CLAUDE.md
docs/uebergabe.md
claude_hausmeister/
  config.yaml          Rechte, Optionen (firewall_mode: off|learn|enforce)
  Dockerfile           debian:bookworm-slim, natives Claude-Binary, Nutzer agent
  README.md / CHANGELOG.md
  rootfs/run.sh                         Einstieg, Neustart-Schleife, Signal-Handling
  rootfs/usr/local/lib/agent-common.sh  as_agent() (setpriv), Token-Handling
  rootfs/usr/local/bin/firewall.sh      dnsmasq + ipset + iptables
  rootfs/usr/local/bin/agent-shell      interaktive Einrichtung
  rootfs/etc/claude-code/managed-settings.json   Deny: Bash, WebFetch, WebSearch, Config-Pfade
  rootfs/opt/agent/role.env             rollenspezifisch: Name, Token ja/nein, Allowlist
  rootfs/opt/agent/CLAUDE.md            Rollenbeschreibung fuer den Agenten
  rootfs/opt/agent/mcp.json             -> /data/workspace/.mcp.json (noch leer)
```

Archivar und Sekretaer entstehen als Kopie; unterschiedlich sind nur `config.yaml`,
`role.env`, `CLAUDE.md`, `mcp.json` und ggf. Deny-Ergaenzungen. Gemeinsame Dateien
kuenftig per Skript synchron halten.

## 6. Ungepruefte Punkte (im Test klaeren)

1. Laeuft `claude remote-control` ohne TTY im Hintergrund? Falls nein: Pseudo-TTY (`script`).
2. Erlaubt der HAOS-Kernel `ipset`/nftables im Container? Falls nein, bricht `enforce` bewusst ab
   (fail closed) -> Alternative: periodisches Aufloesen der Domains ohne ipset.
3. Welche Endpunkte braucht Remote Control wirklich (Login-Refresh, Feature-Flags)? Startliste:
   `anthropic.com`, `claude.ai`, `claude.com` inkl. Subdomains + 160.79.104.0/23. Im Learn-Modus
   aus dem dnsmasq-Log ermitteln.
4. Build mit `CLAUDE_CODE_VERSION=stable` – danach feste Version pinnen.
5. Gelten die Pfadregeln `Read(//data/claude/**)` / `Edit(//...)` wie erwartet? Mit `/permissions`
   in der agent-shell pruefen.
6. Supervisor-Watchdog: ob der Schalter fuer das Add-on angeboten wird.

## 7. Testplan Stufe 1 (Hausmeister ohne MCP)

1. Session "Hausmeister" erscheint in der App mit gruenem Punkt, eine Frage wird beantwortet.
2. Deny: "Fuehre ls aus" und "Rufe example.com ab" -> beides verweigert.
3. Add-on-Neustart -> Session nach ca. 1 Min wieder online.
4. LAN-Kabel > 12 Min ziehen -> Session kommt ohne Eingriff zurueck.
5. `firewall_mode: learn`, 1–2 Tage nutzen; `iptables -L OUTPUT -v -n` im Container:
   Regel "waere-blockiert" bleibt ~0 -> `enforce`.
6. `enforce`: in agent-shell `curl -m5 https://example.com` scheitert, Session laeuft weiter.
7. RAM des Add-ons im Leerlauf und nach langer Sitzung notieren.
8. Backup/Restore auf den Ersatzrechner: Session ohne neuen Login.

## 8. Offene Fragen an den Nutzer

1. Hausmeister-Werkzeug: eigener stdio-MCP gegen die HA-Core-API oder die eingebaute
   MCP-Server-Integration von Home Assistant (HTTP statt stdio)?
2. Sprache der eigenen MCP-Server (Node/Python/.NET) -> Laufzeit ins Image.
3. Welches Paperless-Add-on (Hostname/Port im Add-on-Netz)? IMAP-Server extern – welcher Anbieter/Host?
4. Sekretaer: Entwuerfe schreiben = IMAP APPEND in den Entwuerfe-Ordner, also nicht rein lesend.
   Bekommt sein MCP genau diese eine Schreiboperation?
5. `NET_ADMIN` fuers Add-on als Preis fuer die Container-Firewall – ok?

## 9. Naechste Schritte

1. Repo anlegen, Dateien uebernehmen, `GITHUB-NUTZER` in repository.yaml ersetzen, pushen.
2. In HA als Repository hinzufuegen, Hausmeister installieren, Testplan Stufe 1.
3. Container-Namen im run.sh-Hinweis korrigieren (siehe Abschnitt 4).
4. Abnahmekriterien aus Plan 1.5 uebertragen.
5. Stufe 2: HA-Zugriff fuer den Hausmeister (Frage 8.1).
6. Archivar, dann Sekretaer (nach Antworten zu 8.2–8.4).
