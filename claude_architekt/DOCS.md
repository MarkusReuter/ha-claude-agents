# Claude Architekt

Claude Code laeuft als Remote-Control-Server im Add-on und ist ueber die Claude-App erreichbar
(Konto: privates **Pro**-Abo). Anders als Hausmeister und Archivar ist das ein Coding-Agent:
Er hat **Bash**, freies **Internet** und arbeitet an deinen **GitHub-Repos** – Software wie
Bauthemen. In der Claude-App erscheint er mit dem Ordner `architekt`. Dafuer sieht er
weder Home Assistant noch Paperless noch sonst etwas im lokalen Netz, und er hat keinen
GitHub-Token in der Hand.

## GitHub-Token anlegen (einmalig)

GitHub > Settings > Developer settings > **Fine-grained personal access tokens** > Generate new token:

| Feld | Wert |
|---|---|
| Token name | `ha-claude-architekt` |
| Expiration | z. B. 1 Jahr (Erinnerung im Kalender) |
| Resource owner | dein Konto (`MarkusReuter`) |
| Repository access | **All repositories** – gilt auch fuer kuenftige Repos |
| Repository permissions | **Contents:** Read and write · **Pull requests:** Read and write · **Issues:** Read and write · **Actions:** Read-only (CI-Logs) · Metadata: Read-only (automatisch) |
| Alles andere | **No access** – vor allem **nicht** *Workflows*, *Administration*, *Secrets*, *Environments*, *Variables*, *Webhooks* |

Warum kein *Workflows*: Mit diesem Recht koennte der Agent in einem `claude/*`-Branch einen
Workflow anlegen, der beim Push mit den Actions-Secrets des Repos laeuft (z. B. die Android-
Signierschluessel von `paperless-go`). Ohne das Recht lehnt GitHub jeden Push ab, der Dateien
unter `.github/workflows/` aendert.

Den Token traegst du in der Add-on-Konfiguration unter `github_token` ein. Er landet in
`/data/options.json` (nur root) und in `/run/github-proxy/token` (nur Nutzer `gitproxy`).

## Einrichten

1. Add-on installieren (der Supervisor baut das Image lokal, das dauert einige Minuten).
2. Konfiguration: `github_token` eintragen, `austausch_repo` pruefen (Standard `private-data`). Starten.
3. **Web-UI oeffnen** und die Einrichtung wie beim Hausmeister durchgehen (Schritt 1: Trust
   und `/login` mit dem **privaten Pro-Konto**, Schritt 2: Remote Control freischalten).
4. In der Claude-App unter **Code** die Sitzung „Architekt“ oeffnen. Test:
   „Klone ha-claude-agents und zeig mir die letzten 3 Commits.“
5. `setup_terminal` wieder ausschalten und das Add-on neu starten.

## Optionen

| Option | Wirkung |
|---|---|
| `firewall_mode` | `enforce` (Standard): Internet (IPv4) frei, gesperrt sind private Netze (LAN, hassio-Netz mit HA/Supervisor/Add-ons, CGNAT, Link-Local) und IPv6 · `learn`: nichts sperren, Zugriffe ins lokale Netz nur protokollieren. Ein `off` gibt es bewusst nicht |
| `github_owner` | Konto, dessen Repos ueber den Proxy mit Token laufen |
| `github_token` | siehe oben |
| `austausch_repo` | Repo fuer den Datenaustausch (Standard `private-data`, leer = keins), siehe unten |
| `setup_terminal`, `pty` | wie beim Hausmeister |

## Was der Agent darf – und was nicht

| | |
|---|---|
| Bash, Pakete installieren (npm, pip, als Nutzer `agent`) | ja, ohne Rueckfrage |
| Internet (Websuche, Webseiten, Paket-Registries, fremde Repos) | ja |
| Lokales Netz: HA, Paperless, Router, NAS, andere Add-ons | **nein** (Firewall) |
| Deine Repos klonen, lesen, CI-Logs ansehen | ja, alle Repos von `github_owner` |
| Push auf `claude/<thema>` und Pull Request anlegen | ja |
| Push auf `main`/andere Branches, Tags, Releases, Merge, Repo-Einstellungen | **nein** (Proxy), Ausnahme Austausch-Repo |
| Im Austausch-Repo: Push auf alle Branches, Releases mit Dateien anlegen/aendern/loeschen | ja |
| Werkzeuge laden (Flutter, Android-SDK, JDK) nach `/data/architekt/.werkzeuge` | ja, persistent, nicht im Backup |
| Workflows aendern oder starten, Secrets lesen | **nein** (Token-Rechte + Proxy) |
| Gmail, Drive, Kalender (claude.ai-Connectoren) | **nein** (abgeschaltet) |

Gemergt wird von dir: Pull Request in GitHub ansehen und mergen. Das ist die Freigabe.

## Austausch-Repo (`private-data`)

In allen anderen Repos aendert der Agent nichts direkt: Er arbeitet in einem Branch
`claude/<thema>` und schlaegt dir die Aenderung als Pull Request vor. Fuer den Datenaustausch
waere das umstaendlich, deshalb gilt im Austausch-Repo:

- **Du legst ihm etwas hin:** Datei in `private-data` committen (oder per GitHub-Web hochladen),
  ihm sagen „schau in private-data/…“.
- **Er legt dir etwas hin:** genau wie der Hausmeister – mit demselben Werkzeug `paket_hochladen`
  (MCP-Server `ablage`). Ergebnis ist ein Release `paket-<Datum>-<Thema>` mit der Datei bzw. dem
  ZIP als Anhang und dem Vermerk „Hochgeladen vom Architekten. Wird nach 30 Tagen automatisch
  geloescht.“ Den Link nennt er dir im Chat. Was bleiben soll, committet er ins Repo.
- Unterschied zum Hausmeister: Der Hausmeister fragt bei jedem Upload um Freigabe, der Architekt
  nicht. Eine Freigabe waere bei ihm wirkungslos, weil er mit Bash denselben Upload ueber den
  Proxy auch selbst ausloesen koennte. Den Token hat er trotzdem nicht: `paket_hochladen` laeuft
  ueber seinen Proxy, der nur Releases `paket-*` im Austausch-Repo zulaesst.
- Tags per git, andere Releases, Branches ausserhalb `claude/*` loeschen und alles an den
  Repo-Einstellungen bleiben auch hier gesperrt. Releases in anderen Repos (z. B. die
  APK-Releases von `paperless-go`, die der Workflow signiert) kann er nicht anlegen.
- **Pakete des Hausmeisters** liegen im selben Repo. Der Architekt kann sie lesen (z. B.
  Warmwasser-Daten fuer die Waermepumpe auswerten) und raeumt alte `paket-*` mit auf.

Warum das hier unbedenklich ist: `private-data` hat keine Workflows und keine Secrets, ein Tag
oder Release startet dort also nichts.

## Flutter (paperless-go)

Der Agent kann das Flutter-SDK selbst laden (aus dem oeffentlichen Repo `flutter/flutter` und
von Googles Servern) und damit `flutter analyze`, `flutter test` und Debug-Builds ausfuehren.
Das SDK liegt in `/data/architekt/.werkzeuge` und uebersteht Add-on-Updates; ins HA-Backup kommt
es nicht. Platz: Flutter allein ca. 2 GB, mit Android-SDK und JDK eher 6–8 GB. Ein Gradle-Build
braucht 2–4 GB RAM – das Add-on hat dafuer kein eigenes Limit, er konkurriert mit HA.
Signierte Release-APKs baut weiterhin nur der GitHub-Workflow (die Schluessel liegen nur dort).
Werkzeuge loeschen: Agent bitten, `$TOOLS_DIR` zu leeren.

## Restrisiken (bewusst in Kauf genommen)

Der Architekt hat alle drei Eigenschaften der Rule of Two: fremde Inhalte (Internet),
private Daten (deine privaten Repos) und einen Weg nach aussen (Internet). Gegen Prompt
Injection aus einer Webseite oder einem Paket helfen nur die Rollenregeln. Entscheidung
(19.10.2026): Die Repos enthalten private, aber keine sensiblen Daten – das Risiko ist akzeptiert.
Konkret:

- **Inhalt deiner privaten Repos** (auch `private-data`) kann abfliessen. Deshalb gehoeren dort
  auch kuenftig keine sensiblen Daten hin (Zugangsdaten, Kontoauszuege, Ausweise, Gesundheit) –
  die liegen in Paperless, das der Architekt nicht erreicht.
- **Claude-Login** unter `/data/claude` ist fuer die Shell lesbar (Claude Code braucht ihn).
  Bei Verdacht: in claude.ai unter Einstellungen die Sitzungen abmelden, neu einrichten.
- **Repo-Inhalt veraendern** kann der Agent nur in `claude/*`-Branches – solange du keinen
  boesartigen Pull Request mergst. Pull Requests auf **ha-claude-agents** (Sicherheitsregeln
  der Agenten!) besonders genau lesen.
- Ein ueber das Internet erreichbarer Dienst bei dir zu Hause (z. B. Paperless ueber deine
  oeffentliche Adresse) ist auch fuer den Agenten erreichbar – dort schuetzt nur der Login.

Den GitHub-Token selbst kann der Agent nicht abgreifen: Er liegt nur beim Proxy-Nutzer `gitproxy`,
den der Agent weder lesen noch debuggen kann.

## Wenn es klemmt

- **Push abgelehnt** mit „Architekt-Proxy: Push abgelehnt“: Branch muss `claude/…` heissen.
- **„GitHub lehnt den Token ab“**: Token abgelaufen oder Rechte fehlen – neuen Token eintragen,
  Add-on neu starten.
- **„refusing to allow a Personal Access Token to create or update workflow“**: gewollt, siehe oben.
- Sonst wie beim Hausmeister (Login abgelaufen, `pty`).
