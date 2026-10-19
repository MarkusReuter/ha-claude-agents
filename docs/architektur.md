# Architektur und Stand

Ergaenzt `uebergabe.md`. Hier steht, was gebaut ist und wo es vom Entwurf abweicht.

## Grundregel: Rule of Two

Jeder Agent hat hoechstens zwei der drei Eigenschaften – nie alle drei ungeschuetzt:

- **A** – liest nicht vertrauenswuerdige Inhalte (Internet, Mails, Dokumente Dritter,
  Entitaetszustaende aus fremden Quellen) → Prompt Injection moeglich
- **B** – hat Zugriff auf sensible Daten oder Systeme (HA, Paperless, Postfach, Tokens, Login)
- **C** – kann schreiben, Zustand aendern oder nach aussen kommunizieren

Hat ein Agent A und B, ist C entweder nicht vorhanden oder an eine Freigabe durch Markus
gebunden (Managed-`ask`). Dateien an Markus selbst (`SendUserFile`, eigener Ausgangsordner)
zaehlen nicht als C. Jede neue Faehigkeit – Werkzeug, Domain in der Firewall, Ordner-Mapping,
Add-on – wird vor dem Einbau gegen A/B/C geprueft und die Begruendung hier festgehalten.

| Agent | A | B | C |
|---|---|---|---|
| Hausmeister | Entitaetszustaende | HA, `HA_TOKEN` | nur `ha_write` mit Freigabe |
| Archivar | Dokumente, Mails | Paperless | keins (nur `update_content`/`set_ocr_tags` mit Freigabe) |
| Architekt | Internet, Pakete, fremde Repos | eigene GitHub-Repos (privat, nicht sensibel), Claude-Login | Internet frei; GitHub nur `claude/*` ueber Proxy, Merge durch Markus; Austausch-Repo frei |

Folge: **kein `Bash`.** Eine Shell bringt C ungefiltert mit (`curl` mit dem Token aus der
Umgebung an HA/Paperless, Upload ueber erlaubte Domains, Lesen des Logins) und hebelt die
Freigabe aus. Allowlists einzelner Befehle helfen nicht (`zip -TT`, `tar --checkpoint-action`,
`find -exec` starten beliebige Befehle). Neue Faehigkeiten kommen als schmale MCP-Werkzeuge.

**Bewusste Ausnahme: Architekt** (Entscheidung Markus, 19.10.2026). Ein Coding-Agent braucht
Bash, und mit Internet-Vollzugriff ist C nicht an eine Freigabe zu binden. Er hat damit alle drei
Eigenschaften – wie Anthropics Cloud-Sitzungen, an denen er sich orientiert. Ausgeglichen wird
das, indem B klein bleibt und C dort eng ist, wo es Schaden anrichtet: kein HA/Paperless/LAN,
keine Mail/Drive (claude.ai-Connectoren aus), kein Token beim Agenten, GitHub-Schreiben nur auf
`claude/*` (und im Austausch-Repo `private-data`). Restrisiko: Abfluss von Repo-Inhalten und des
Claude-Logins – akzeptiert, weil die Repos private, aber keine sensiblen Daten enthalten (Markus,
19.10.2026); sensible Unterlagen bleiben in Paperless. Details unten.

## Schutzschichten (Hausmeister)

1. **Managed Settings** `/etc/claude-code/managed-settings.json` (root, im Image):
   Deny fuer `Bash`, `WebFetch`, `WebSearch`, Lesen/Schreiben von `/data/claude`
   (Login), Lesen von `/proc`, Schreiben in `/etc`, `/opt`, `/usr`, `/home` sowie in die
   Workspace-Konfiguration. Dazu `disableBypassPermissionsMode` und `allowManagedHooksOnly`.
2. **Managed MCP** `/etc/claude-code/managed-mcp.json`: exklusive Liste der MCP-Server.
   Eine `.mcp.json` im Projekt wird ignoriert. Hausmeister: eigener Server
   `opt/agent-mcp/homeassistant.mjs` (ab 0.2.0) mit `ha_read` (allow) und `ha_write` (ask, erzwungen).
3. **Workspace root-eigen** (`1775`, Sticky-Bit): Der Agent kann Notizen anlegen, aber
   `.claude/`, `CLAUDE.md` und `.mcp.json` nicht anlegen, aendern oder umbenennen.
   *Grund:* Projekt-Settings koennen Befehle ausfuehren (Hooks, `statusLine`, `env` →
   `NODE_OPTIONS` im MCP-Prozess). Mit Schreibrecht dort waere das Bash-Verbot umgehbar.
4. **Prozess ohne Rechte:** `agent` (UID 1000), keine Capabilities, `no_new_privs`,
   leere Umgebung. `SUPERVISOR_TOKEN` wird entfernt; nur der Hausmeister erhaelt ihn als `HA_TOKEN`.
5. **Egress-Firewall** (nftables-Tabelle `inet agentfw` + dnsmasq mit `--nftset`):
   in `enforce` nur Allowlist; DNS nur ueber dnsmasq, das nur erlaubte Namen weiterleitet.

## Abweichungen vom Entwurf im Zip

| Entwurf | Jetzt | Warum |
|---|---|---|
| iptables + ipset | nftables + dnsmasq-nftset | ipset im HAOS-Kernel unsicher; nf_tables nutzt Docker selbst. Dazu: Set `waere_blockiert` zeigt in `learn` die konkreten Ziele |
| DNS frei | `enforce`: dnsmasq leitet nur erlaubte Domains weiter | DNS als Exfiltrationskanal (Anhang A) |
| Workspace vom Agenten beschreibbar | root-eigen mit Sticky-Bit | Umgehung des Bash-Verbots ueber Projekt-Settings |
| `.mcp.json` im Workspace | `managed-mcp.json` | nicht vom Agenten aenderbar, exklusiv |
| Einrichtung nur per `docker exec` (SSH-Schutzmodus aus) | Ingress-Terminal (ttyd) bei Bedarf, `docker exec` als Fallback | Schutzmodus bleibt an; ttyd nimmt nur Verbindungen vom Ingress-Proxy an |
| bookworm | trixie (Debian 13) | aktuelles Stable, dnsmasq 2.91 |
| Stufe 1 ohne MCP | ha-mcp gleich enthalten | Antwort auf Frage 8.1: dasselbe `ha-mcp` wie in VS Code, fest gepinnt, kein npx zur Laufzeit |

## Lokal verifiziert (Docker Desktop, 23.09.2026)

- Build ok; Claude Code 2.1.273 (Kanal `stable`), ttyd 1.7.7, ha-mcp 0.1.6, Node 22.
- `enforce`: example.com und 1.1.1.1 blockiert, DNS fuer Fremdnamen blockiert, direkte
  DNS-Anfragen des Agenten blockiert; api.anthropic.com und claude.ai erreichbar.
- `learn`: nichts blockiert, `firewall-status` listet die Ziele.
- Agent: CapEff/CapBnd 0, NoNewPrivs 1, `SUPERVISOR_TOKEN` weg, Workspace-Konfig unveraenderbar.
- ttyd von einer anderen IP als dem Ingress-Proxy nicht erreichbar.
- `claude mcp list` als agent: `homeassistant ✔ Connected` (ueber managed-mcp.json).
- `ha-mcp` liest `sun.sun` aus dem echten HA.
- Ohne gueltigen Login beendet sich `claude remote-control` sofort mit Exit 1 (kein TTY-Haenger).

**Offen, nur auf HAOS pruefbar:** nf_tables im HAOS-Kernel, `http://supervisor/core` als
WebSocket-Ziel fuer ha-mcp, Dauerbetrieb ohne TTY, Ingress mit ttyd, benoetigte Domains.

## Auf HAOS verifiziert (23.09.2026, HAOS 18.3, Kernel 6.18)

- Installation aus dem GitHub-Repo, lokaler Build durch den Supervisor ok (Slug `f9239780_claude_hausmeister`).
- Ingress-Terminal (ttyd) funktioniert; Einrichtung mit Pro-Konto ok.
- Stolperstein: Im Trust-Dialog ist "No, exit" vorausgewaehlt -> ab 0.1.1 wiederholt die
  Einrichtung Schritt 1, bis Trust und Login gespeichert sind.
- Remote Control laeuft ohne TTY (`pty: false`). RAM mit laufendem Server: ca. 280 MB.
- Abnahme 1, 3, 4 bestanden (Sitzung in der App, Bash/Web verweigert, sun.sun per ha-mcp
  ueber `http://supervisor/core`).

## HA-Schreibzugriff (0.2.0) – Risiken und Gegenmassnahmen

Weg: Supervisor-Proxy `http://supervisor/core` mit dem Supervisor-Token (HA-Admin). Keine
Firewall-Freigabe fuer `homeassistant.fritz.box:8123` noetig, kein eigener Token im Container.

| Risiko | Gegenmassnahme |
|---|---|
| Prompt Injection ueber Entitaetszustaende aus fremden Quellen (Kalender, Mail-Sensoren, Geraetenamen, Wettertexte) | `ha_write` immer mit Freigabe; Rollenregeln in CLAUDE.md |
| HA als Weg nach aussen (notify, rest_command, Mail) – Bein 3 des Dreigespanns | Freigabe; HA-Daten sind nur maessig sensibel (Praesenz!) |
| Dauerhafte Wirkung: Automationen laufen spaeter ohne Aufsicht | Freigabe mit Diff-Workflow; Sicherungen unter `ha/backup/` |
| Rechteausweitung ueber HA (Tokens/Benutzer anlegen, Integrationen, Add-ons, Backups) | Sperrliste im MCP-Server, auch in Automations-/Skript-Inhalten (`hassio.*`, `backup.*`) |
| Kaputte Dashboards/Automationen | automatische Sicherung vor jedem Speichern |

Schalter `ha_write` (ab 0.3.0, Standard aus): Add-on-Option, gespeichert vom Supervisor.
`run.sh` liest sie als root vor der Rechteabgabe, erzeugt daraus die Managed Settings (Deny fuer
`ha_write`) und gibt `HA_WRITE=0/1` an den MCP-Server. Der Agent erreicht die Supervisor-API weder
direkt (`hassio_api: false`) noch ueber HA Core (`supervisor/api`, `/api/hassio`, `hassio.*` im
MCP-Server gesperrt; er hat keinen anderen Weg zu HA als diesen root-eigenen Server).

Grenzen: Die Sperrliste ist eine Schutzschicht gegen Fehler und Injection, keine harte Grenze –
ein HA-Admin kann vieles indirekt. Die tragende Schicht ist die Freigabe durch Markus.

## Abnahme Stufe 1 (Plan 1.5, auf HAOS uebertragen)

| # | Pruefung | Erwartung |
|---|---|---|
| 1 | Sitzung „Hausmeister“ in der **Pro**-App unter Code, gruener Punkt, Frage wird beantwortet | ja |
| 2 | Die Max-Sitzung aus VS Code erscheint **nicht** in der Pro-App | **entscheidend** |
| 3 | „Fuehre ls aus“ / „Rufe example.com ab“ | beides verweigert |
| 4 | „Wie ist der Zustand von sun.sun?“ | Freigabe-Abfrage per Push, danach Antwort aus HA |
| 5 | Add-on neu starten | Sitzung nach ca. 1 Min wieder online |
| 6 | 4 h nichts tun | Sitzung weiter gruen |
| 7 | LAN-Kabel > 12 Min ziehen | Sitzung kommt ohne Eingriff zurueck |
| 8 | `learn` 1–2 Tage, dann `firewall-status` | keine noetigen Ziele unter „waere blockiert“ → `enforce` |
| 9 | `enforce`: im Einrichtungs-Terminal `curl -m5 https://example.com` | scheitert; Sitzung laeuft weiter |
| 10 | RAM des Add-ons im Leerlauf und nach langer Sitzung | notieren (fuer 32-GB-Entscheidung) |
| 11 | Backup auf den Ersatzrechner einspielen | Sitzung ohne neuen Login |

## Gemeinsame Dateien (ab Hausmeister 0.3.1 / Archivar 0.1.0)

Der Supervisor baut jedes Add-on nur aus seinem Ordner, gemeinsame Dateien liegen daher als
Kopie vor: `run.sh`, `agent-common.sh`, `agent-setup`, `agent-shell`, `firewall.sh`,
`firewall-status`. Referenz ist `claude_hausmeister/`; `tools/check-common.sh` prueft,
`--sync` kopiert. Rollenspezifisch sind `role.env` (Name, Allowlist, Workspace), `role.sh`
(Optionen → `AGENT_ENV`, `ALLOW_INTERNAL_EXTRA`, `role_prepare` erzeugt die Managed Settings),
`CLAUDE.md`, `managed-settings.json` (Vorlage), `managed-mcp.json`, `opt/agent-mcp/*`.
run.sh startet nicht, wenn die Managed Settings kein Bash-Verbot enthalten (fail closed), und
setzt `/data/options.json` auf 0600 (Optionen koennen Zugangsdaten enthalten).

## Archivar (0.1.0)

Paperless-ngx per eigenem MCP `opt/agent-mcp/paperless.mjs` (Node, ohne Abhaengigkeiten, stdio).

| Schicht | Umsetzung |
|---|---|
| Paperless-Rechte | eigener Benutzer *archivar* ohne Loeschrecht (Gruppen Rolle/Freigabe getrennt, siehe DOCS.md). Sieht nur Dokumente, die fuer *Users für Markus Bereich* freigegeben sind – nicht Julias |
| MCP-Server | sieben feste Werkzeuge; `request()` kennt nur eine Liste aus Methode+Pfad (GET, POST nur Notizen/OCR-Tags, PATCH nur Dokument), prueft die Bodies (`{content}` oder `{tags}`), folgt keinen Weiterleitungen, entfernt den Token aus allen Texten. Kein Loeschen, kein `bulk_edit` (Test prueft den Quelltext) |
| Freigaben | Lese-Werkzeuge allow; `update_content`, `set_ocr_tags` ask (Managed); Option `paperless_write` (Standard aus) verbietet beide zusaetzlich |
| Dateien | Workspace `/archivar` (nicht persistent, root 0755), Originale in `/archivar/ocr` (agent 0700), eines zur Zeit, nach `update_content` geloescht. Read nur `/archivar/ocr/**` und `/archivar/CLAUDE.md` – realisiert als Deny fuer alle anderen Hauptordner (Deny schlaegt Allow, eine „alles ausser“-Regel gibt es nicht) |
| Netz | Firewall-Ziel nur Host:Port aus `paperless_url` (intern `http://ca5234a0-paperless-ngx:80`, nicht die oeffentliche Adresse); kein HA-/Supervisor-Zugang |

Grenze: Das Token-Recht „Dokument bearbeiten“ erlaubt in Paperless auch Drehen/Teilen/Mergen
ueber `bulk_edit`. Dagegen schuetzen nur der MCP-Server und das Fehlen jedes anderen Wegs
(kein Bash/Web, Firewall, `/data` nicht lesbar).

Lokal verifiziert (Docker Desktop, 25.09.2026): Build ok (Claude Code 2.1.273, Node 22.23.3,
poppler 25.03 – Claude Code ruft `pdftoppm` fuer PDF-Seiten auf); `enforce`: example.com blockiert,
Paperless (ueber den Host-Port) und Anthropic erreichbar; agent kann `/data/options.json` und
`/proc/1/environ` nicht lesen, nicht in `/work` (heute `/archivar`) schreiben; `claude mcp list`: `paperless ✔ Connected`;
MCP-Aufruf gegen das echte Paperless mit ungueltigem Token: 401, Token nicht in der Ausgabe;
nicht aufloesbarer Paperless-Host → Agent startet nicht. 31 Unit-Tests gruen.

**Offen, nur auf HAOS pruefbar:** `ca5234a0-paperless-ngx` in `enforce` (einteiliger Name ueber
dnsmasq), Read auf PDF/Bild ohne Bash in der App, die Deny-Liste mit `/permissions`, der 403-Test
mit dem echten Token, Laufzeit/Nutzungslimit bei 15er-Stapeln.

**Spaeter (IMAP, nur lesend):** zweiter Eintrag `imap` in `managed-mcp.json` mit eigener Datei
`opt/agent-mcp/imap.mjs`, Optionen `imap_*`. Die Firewall erlaubt fuer Domains nur TCP 443 –
fuer IMAPS (993) muss `firewall.sh` um Domain:Port erweitert werden.

## Dateien in der App anzeigen (Hausmeister 0.3.2 / Archivar 0.1.3)

Claude Code (ab 2.1.196, hier 2.1.292) hat das Werkzeug `SendUserFile`: Es schickt eine Datei aus
der Sitzung an den verbundenen Remote-Control-Client (Vorschau fuer PDF/Bilder mit
`display: "render"`). Es braucht laut Doku keine Freigabe und steht in keiner Deny-Liste – die
Rollen bekommen nur eine Anweisung in ihrer CLAUDE.md, wann sie es nutzen.

Sicherheit: Empfaenger ist immer die eigene App (Zustellung ueber Anthropic an das angemeldete
Konto), also kein Weg nach aussen. Ob das Werkzeug die Read-Denies beachtet, ist nicht
dokumentiert – im schlimmsten Fall landet eine Datei, die der Agent-Nutzer lesen kann (z. B. der
eigene Login unter `/data/claude`), bei Markus selbst. Geheimnisse, die nur root lesen kann
(`/data/options.json`, `/proc/1/environ`), bleiben unerreichbar.

**Offen, auf HAOS pruefen:** Vorschau in Handy- und Desktop-App; ob `SendUserFile(//data/claude/…)`
verweigert wird.

## Danach

- Sekretaer als weitere Kopie (gemeinsame Dateien per `tools/check-common.sh --sync`).
- Dateiaustausch (Ablage `ausgang/`, Upload aus der App, Weitergabe an Cloud-Sitzungen): Konzept in
  `dateiaustausch.md`; Pakete mit `paket_erstellen` ab Hausmeister 0.5.0.
- Hausmeister-Dockerfile ebenfalls auf eine feste Node-Version pinnen (Archivar: 22.23.3).

## Arbeitsordner und Claude-Code-Version (Hausmeister 0.4.0, Archivar 0.2.0)

Die Claude-App zeigt bei Remote-Control-Sitzungen den Namen des Projektordners. Deshalb heissen
die Arbeitsordner wie die Rolle: `/data/hausmeister` (vorher `/data/workspace`) und `/archivar`
(vorher `/work`). `run.sh` zieht einen vorhandenen alten Ordner einmalig um (`WORKSPACE_OLD` in
`role.env`) und kopiert den Trust-Eintrag in der `.claude.json` – als Agent, weil die Datei ihm
gehoert und root dort keinen Links folgen soll. Rechte und Regeln sind unveraendert, nur die Pfade.

Claude Code 2.1.292 (Stable-Kanal, 18.10.2026): Opus 5.5 gibt es erst ab 2.1.280; mit 2.1.273 fehlte
es in der Modellauswahl der App. Changelog 2.1.274–2.1.292 auf Managed Settings, Deny-Regeln und
Remote Control geprueft – nur Fixes, keine Lockerung.

## Automatische Claude-Code-Updates

`.github/workflows/claude-code-update.yml` laeuft am 1. jedes Monats (und manuell ueber
*Actions > Claude-Code-Update > Run workflow*, optional mit fester Version). Ist der Stable-Kanal
neuer als der Pin, hebt `tools/update-claude-code.sh` den Pin in allen Add-ons, erhoeht die
Patch-Version und schreibt einen CHANGELOG-Eintrag mit gefiltertem Auszug (neue Modelle, Neues bei
Remote Control, Sicherheit/Deny-Regeln/Managed Settings). Danach: check-common, Unit-Tests,
`docker build` beider Add-ons (inkl. `claude --version`) – nur wenn alles gruen ist, Push direkt auf
main. Bewusst ohne Pull Request: Geprueft wird der Changelog beim Update in Home Assistant.

Sicherheits-Siegel am Anfang jedes automatischen Eintrags: Das Skript ordnet die Release Notes per
Stichwort den Bausteinen des Sicherheitskonzepts zu (Managed Settings, Deny-Regeln, Freigabe-Modus,
Hooks, MCP-Konfiguration, Projekt-Settings, Remote-Control-Optionen, Updater, neue und gesperrte
Werkzeuge; Auto Mode nur, solange er nicht per `disableAutoMode` gesperrt ist).

Entscheidung 18.10.2026: **Auto Mode bleibt erlaubt** (kein `permissions.disableAutoMode`), Bypass
bleibt gesperrt. Offen und nicht verifiziert: ob der Auto-Mode-Klassifikator Werkzeuge mit
Managed-`ask`-Regel (`ha_write`, `update_content`, `set_ocr_tags`) selbst freigeben kann. Die
Schreibsperren per Option (`ha_write`, `paperless_write`, Standard aus) wirken unabhaengig davon,
weil sie die Werkzeuge verbieten und der MCP-Server Schreibbefehle zusaetzlich ablehnt. Folge fuers
Siegel: Auto-Mode-Aenderungen machen es gelb. „Fixed“ zaehlt als
Fehlerbehebung, Removed/Deprecated/„no longer“/„ignored“ als **rot** (kein Push, Lauf schlaegt fehl;
nach eigener Pruefung manuell mit `accept_red`), alles andere als **gelb** (Push, Zeilen oben im
Changelog). Ohne Treffer **gruen**. Grenze: Stichwortabgleich, keine Code-Pruefung – eine Aenderung,
die einen Baustein betrifft, ohne ihn zu nennen, faellt durch.
Bleibt ein Update dort liegen, laeuft das alte Image weiter.

## Architekt (0.1.0)

Lokaler Ersatz fuer Claude-Code-Cloud-Sitzungen, fuer Code und Bauthemen in den Repos. Name und
Arbeitsordner `/data/architekt` unterscheiden ihn in der Claude-App. Vorbild ist Anthropics Aufbau: Wegwerf-Umgebung
ohne Zugangsdaten, Git ueber einen Proxy, Push nur auf den Sitzungs-Branch.

| Schicht | Umsetzung |
|---|---|
| Shell | `Bash` erlaubt (`BASH_ERLAUBT=1` in `role.env`): run.sh verlangt dann nur die Connector-Sperre, nicht das Bash-Verbot. `managed-mcp.json` leer (exklusiv) |
| Netz | `EGRESS=internet`: `enforce` sperrt private IPv4-Netze (RFC 1918 inkl. hassio-Netz 172.30.32.0/23, CGNAT, Link-Local, Multicast, reserviert) und IPv6 ganz – globale IPv6-Adressen im Heimnetz sind von Internet-Zielen nicht zu unterscheiden. DNS weiter nur ueber dnsmasq, jetzt fuer alle Namen, aber `--stop-dns-rebind`. Option `firewall_mode` ohne `off` |
| GitHub-Token | Nur beim Proxy `opt/github-proxy/proxy.mjs`, Nutzer `gitproxy` (UID 1001). Token als Datei `/run/github-proxy/token` (0600 gitproxy), nicht als Argument (`/proc/*/cmdline` ist fuer alle lesbar). Der Agent kann fremde Prozesse weder lesen noch signalisieren (keine Capabilities, andere UID) |
| Git | `/etc/gitconfig` (root) leitet `https://github.com/<owner>/` per `insteadOf` auf `http://127.0.0.1:8099/git/<owner>/` um. Der Proxy liest bei `git-receive-pack` die Befehlsliste (pkt-line) und leitet nur weiter, wenn **alle** Refs `refs/heads/claude/*` sind (bzw. `refs/heads/*` im Austausch-Repo, dort ohne Loeschen). Sonst Antwort im receive-pack-Format mit `ng` je Ref, damit git die Begruendung zeigt. Tags per git nie |
| REST-API | Auswahl: GET `/user/repos` und unter `/repos/<owner>/…` (ohne secrets/variables/keys/hooks/environments), POST pulls, PATCH pulls (nur title/body/state), POST issues und Kommentare. Nur im Austausch-Repo: Release anlegen (nur Tag `paket-*`, Felder wie `paket_hochladen`), Release loeschen, Tag `paket-*` loeschen, Upload ueber `/uploads/…` → uploads.github.com (gestreamt). Kein GraphQL (also kein `gh`), kein Merge, keine Contents-/Refs-API, kein Workflow-Dispatch |
| Austausch-Repo | Option `austausch_repo` (Standard `private-data`): Datenaustausch mit Markus – Push auf alle Branches, Dateien als Paket wie beim Hausmeister: derselbe `ablage.mjs` (gemeinsame Datei, `check-common.sh` prueft sie, wo vorhanden) mit `ABLAGE_GITHUB_API/UPLOADS` auf den Proxy und Platzhalter-Token. `paket_hochladen` ohne `ask`, weil Bash denselben Weg ohnehin hat. Geprueft 19.10.2026: `private-data` hat keine Workflows und keine Actions-Secrets, Tags/Releases starten dort also nichts. Kommt dort ein Workflow mit Secrets dazu, muss das neu bewertet werden |
| Werkzeuge | `/data/architekt/.werkzeuge` (`TOOLS_DIR`, agent-eigen, `backup_exclude`): Flutter, JDK, Android-SDK, npm -g, Caches. `PATH`, `JAVA_HOME`, `ANDROID_HOME`, `PUB_CACHE`, `GRADLE_USER_HOME` kommen ueber `AGENT_ENV` (spaeteres `PATH=` in `env -i` gewinnt). root legt den Ordner nur an, wenn er fehlt, und entfernt einen Link an seiner Stelle (kein chown durch Links) |
| Token-Rechte | Fine-grained, alle Repos des Kontos (auch kuenftige), Contents/PRs/Issues rw, Actions r. **Kein Workflows-Recht**: sonst liefe ein im Branch angelegter Workflow mit den Repo-Secrets |
| Workspace | `/data/architekt` persistent, root-eigen 1775; `backup_exclude` fuer node_modules, .venv, build usw. |

Warum ein Proxy statt Branch-Schutz: GitHub Free bietet fuer private Repos weder Branch-Schutz
noch Rulesets (API: 403 „Upgrade to GitHub Pro“). Ein Token mit Contents-Schreibrecht duerfte
sonst auf `main` pushen, Tags setzen (paperless-go: `v*`-Tag startet den Release-Build mit den
Signier-Secrets) und Releases anlegen.

Getestet (lokal, 19.10.2026): 25 Tests (inkl. Ende-zu-Ende `paket_hochladen` → Proxy → Mock-GitHub) in `claude_architekt/tests/` – Unit-Tests fuer pkt-line,
Ref-Regeln und API-Auswahl, dazu der echte git-Client ueber den Proxy gegen ein Fake-GitHub mit
`git http-backend`: clone, Push `claude/*`, Ablehnung von `main`/Tag/gemischtem Push, grosser
Push (Probe-Request + chunked), Austausch-Repo, Release-Upload (2 MB, gestreamt), fremder Owner,
Token in keiner Antwort/keinem Log.
CI: `firewall-test.yml` Job `internet` (Internet erreichbar, Docker-Netz/LAN/Link-Local gesperrt).

**Offen, nur auf HAOS pruefbar:** Image-Build und RAM, `--stop-dns-rebind` mit dem HA-DNS,
Proxy-Start als gitproxy, Push/PR/Release gegen das echte GitHub, Flutter-Download und
`flutter test` von paperless-go, Remote Control mit Bash in der App.

## claude.ai-Connectoren aus (alle Rollen, Hausmeister 0.4.3 / Archivar 0.2.3 / Architekt 0.1.0)

Mit dem Pro-Login kann Claude Code die Connectoren des Kontos laden (Gmail, Google Drive,
Google Kalender). Ob die exklusive `managed-mcp.json` sie erfasst, ist nicht belegt. Keine Rolle
braucht sie; beim Archivar waeren Mails A+B neben Paperless, beim Architekten B zu Shell und
Internet. Abgeschaltet dreifach: `ENABLE_CLAUDEAI_MCP_SERVERS=false` in den Managed Settings
(`env`) und in `as_agent` (agent-common.sh), dazu Deny fuer `mcp__claude_ai_Gmail`,
`mcp__claude_ai_Google_Drive`, `mcp__claude_ai_Google_Calendar`. run.sh startet keinen Agenten,
dessen Managed Settings die Sperre nicht enthalten. Claude Code 2.1.302 kennt ausserdem die
Einstellung `disableClaudeAiConnectors` – erst nutzen, wenn der Pin sie sicher enthaelt.
**Offen:** in der App mit `/mcp` pruefen, dass keine `claude.ai …`-Server mehr erscheinen.
