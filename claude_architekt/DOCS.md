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
5. `setup_terminal` wieder ausschalten und das Add-on neu starten. Im Seitenmenue liegt dann
   die Login-Seite zum Erneuern des Logins vom Handy (wie beim Hausmeister, „Login erneuern“).

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
| Gemini: Text, Bilder, Videos | ja, wenn `gemini_api_key` gesetzt, mit Tageslimit |

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

## Gemini (Innenarchitektur, Renderings)

Mit einem Gemini-API-Key erzeugt der Architekt Bilder und Videos: Raumideen, Umgestaltungen von
Fotos, 3D-Ansichten aus Grundrissen, Rundgaenge mit Veo. Er spricht die Gemini-API ueber seinen
Proxy an (`$GEMINI_API_BASE`, gleiche Pfade wie bei Google, ohne Key); Ergebnis als Paket in
`private-data`. Unterschied zur Cloud-Umgebung: Dort ergaenzte der Proxy den Key auch bei direkten
Aufrufen an `generativelanguage.googleapis.com`. Hier muessen Skripte wie `haus/tools/bild.py`
die Adresse aus `GEMINI_API_BASE` nehmen (kleine Aenderung, macht der Architekt selbst).

1. Key in [Google AI Studio](https://aistudio.google.com/apikey) anlegen. **Empfehlung: Projekt
   mit Abrechnung (bezahlte Stufe).** In der kostenlosen Stufe darf Google Eingaben und Ausgaben
   zur Verbesserung seiner Dienste nutzen – das waeren Fotos deiner Raeume.
2. In der Konfiguration `gemini_api_key` eintragen, ggf. `gemini_modell` (Standard
   `gemini-2.5-flash-image`) und `gemini_max_pro_tag` (Standard 100, 0 = gesperrt). Neu starten.
3. Im Log steht „Gemini: an, Modell …“. Test in der App: „Erzeuge ein Bild: gemuetliches
   Lesezimmer mit Dachschraege“.

Sicherheit: Der Key liegt nur beim Proxy, der Agent sieht ihn nicht. Alle Gemini-Aufrufe sind
erlaubt. Das Tageslimit (jeder erzeugende Aufruf zaehlt, Abfragen nicht) begrenzt die Kosten, falls eine Prompt Injection oder eine Schleife viele Aufrufe ausloest (der
Zaehler beginnt beim Neustart des Add-ons neu). Zusaetzlich in Google Cloud ein Budget mit
Warnung setzen. Was der Agent an Gemini schickt, verlaesst das Haus – leg ihm nur Fotos und
Plaene hin, die dafuer gedacht sind.

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
- Sonst wie beim Hausmeister (Login abgelaufen → Login-Seite im Seitenmenue, `pty`).
