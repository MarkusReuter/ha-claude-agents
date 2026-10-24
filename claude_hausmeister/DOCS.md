# Claude Hausmeister

Claude Code laeuft als Remote-Control-Server im Add-on und ist ueber die Claude-App erreichbar
(Konto: privates **Pro**-Abo). Der Agent sieht Home Assistant nur ueber den eingebauten
MCP-Server `homeassistant` mit den Werkzeugen `ha_read` und `ha_write` (Zustaende, Dashboards,
Automationen, Helfer, Services). Shell, Web-Abruf und Websuche sind gesperrt.

## Einrichten (einmalig)

1. Add-on installieren (der Supervisor baut das Image lokal, das dauert einige Minuten).
2. Konfiguration: `setup_terminal` an (Standard), `firewall_mode: learn`. Starten.
3. Auf der Add-on-Seite **Web-UI oeffnen**. Die gefuehrte Einrichtung laeuft als Nutzer `agent`:
   - **Schritt 1:** `claude` startet. Trust-Dialog bestaetigen, `/login` mit dem **privaten
     Pro-Konto** (Link am Handy/PC oeffnen, Code zurueck ins Terminal), dann `/exit`.
   - **Schritt 2:** `claude remote-control` startet. „Enable Remote Control?“ mit `y`
     bestaetigen, auf die Session-URL warten, dann `Strg+C` und die Frage mit `j` beantworten.
4. Innerhalb einer Minute startet das Add-on den Dauerbetrieb. Im Log steht
   „Starte Remote-Control-Server 'Hausmeister'“.
5. In der Claude-App unter **Code** die Sitzung „Hausmeister“ oeffnen und einmal
   `/config` → **Push when actions required** einschalten.
6. `setup_terminal` wieder ausschalten und das Add-on neu starten. Im Seitenmenue liegt dann
   die Login-Seite (siehe „Login erneuern“).

Ohne Ingress geht es auch per SSH-Add-on (Schutzmodus kurz aus):
`docker exec -it addon_<hash>_claude_hausmeister agent-shell`. Den genauen Namen zeigt das
Add-on-Log beim Start.

## Optionen

| Option | Wirkung |
|---|---|
| `firewall_mode` | `off` kein Filter · `learn` nichts blockieren, Ziele protokollieren · `enforce` nur `anthropic.com`, `claude.ai`, `claude.com` (+ Subdomains, 160.79.104.0/23) und der Supervisor-Proxy; DNS nur fuer diese Namen |
| `setup_terminal` | An: Web-Terminal fuer die Ersteinrichtung und Tests. Aus: Login-Seite zum Erneuern des Logins (auch vom Handy). Beides eingehend nur vom HA-Ingress-Proxy erreichbar |
| `ha_write` | Schreibrecht in Home Assistant (Standard **aus** = nur lesen). Wirkt nach Neustart des Add-ons |
| `pty` | Server in einem Pseudo-Terminal starten – nur falls er ohne Terminal nicht laeuft |

## Freigaben

- `ha_read` (nur lesen) laeuft ohne Rueckfrage.
- `ha_write` gibt es nur, wenn die Option `ha_write` an ist. Der Schalter liegt beim
  Supervisor; der Hausmeister selbst kann ihn nicht umlegen.
- `ha_write` fragt **jedes Mal** – das ist in den Managed Settings fest eingestellt und laesst
  sich in der App nicht auf „immer erlauben“ stellen. Vor dem Freigeben lesen, was geaendert wird.
- Vor Aenderungen an Dashboards, Automationen, Skripten und Szenen legt `ha_write` den alten
  Stand unter `/data/hausmeister/ha/backup/` ab. Zuruecksetzen: den Hausmeister bitten, die
  Sicherung zurueckzuschreiben.
- Gesperrt, auch mit Freigabe: Benutzer/Anmeldung, Integrationen hinzufuegen/entfernen,
  Supervisor/Add-ons, Backups, Services `hassio.*` und `backup.*`.
- Dateien aus `/data/hausmeister/ha/` (Konfigurationen, Sicherungen) schickt der Hausmeister auf
  Wunsch mit `SendUserFile` in den Chat – nur an deine eigene App, ohne Freigabe.
- Ist das Ergebnis nur eine Datei (z. B. ein Bericht als Markdown), schickt er sie direkt.
  Mehrere Dateien packt er immer zu **einem ZIP** zusammen (`paket_erstellen`, mit `LIESMICH.md`).
  Erst ueber 10 MB teilt er es in mehrere ZIPs und schickt alle auf einmal; eine einzelne sehr
  grosse Datei wird dabei in Stuecke geteilt. Eine lesbare Markdown-Datei statt ZIP gibt es auf
  Wunsch („als Textdatei“). Beispiel: „Mach ein Diagnosepaket zur Automation Flurlicht“.
  Persoenliche Daten schwaerzt er dabei.
- **Herunterladen ueber ein privates GitHub-Repo** (`paket_hochladen`): Die Claude-App nimmt in
  einer normalen Sitzung keine Dateien an (`SendUserFile` geht nur in Projekt-Threads). Deshalb
  laedt der Hausmeister das Paket – nach deiner Freigabe – als Anhang eines Releases in ein
  privates Repo und schreibt dir den Link in den Chat. Antippen, in der GitHub-App oder im
  Browser herunterladen. Kein Commit, also keine Git-Historie; Releases mit Tag `paket-*` loescht
  er nach 30 Tagen. Eine Cloud-Sitzung kann das Repo einbinden.

  Einrichtung:
  1. Auf GitHub ein **privates** Repo anlegen, z. B. `ha-ablage`, mit README (ein Commit ist noetig).
  2. *Settings > Developer settings > Fine-grained tokens*: Token nur fuer dieses Repo,
     Recht **Contents: Read and write** (sonst nichts), mit Ablaufdatum.
  3. Add-on-Optionen `ablage_github_repo` (z. B. `markus/ha-ablage`) und `ablage_github_token`
     setzen, Add-on neu starten. Im Log steht dann „Ablage: Hochladen nach …“.

  Schutz: Das Hochladen braucht jedes Mal deine Freigabe. Nur dann ist `github.com` in der
  Firewall frei. Ein oeffentliches Repo lehnt das Werkzeug ab. Mit „Contents“ allein kann der
  Token das Repo weder oeffentlich machen noch jemanden einladen.
- Alternativ ohne Repo: in claude.ai/code ein Projekt anlegen und die Aufgabe dort mit
  **+ > Work locally** (Ordner `/data/hausmeister`) stellen – dann landet die Datei per
  `SendUserFile` in der **Library** des Projekts.

## Login erneuern (auch vom Handy)

Der Claude-Login laeuft gelegentlich ab (ca. alle 4 Wochen oder wenn Anthropic Sitzungen
beendet). Dann ist die Sitzung in der Claude-App weg, und im Log steht „Mehrfach sofort beendet“.

1. In Home Assistant (auch in der HA-App) im Seitenmenue **Hausmeister** oeffnen. Ist
   `setup_terminal` aus, erscheint dort die Login-Seite mit dem Zustand des Dienstes.
2. **Neu anmelden** → **Bei Claude anmelden**: Im Browser mit dem **privaten Pro-Konto** bestaetigen.
3. Den angezeigten Code kopieren, zurueck in die HA-App, einfuegen, **Absenden**.
4. Das Add-on bemerkt den neuen Login innerhalb von 10 Sekunden und startet den Server neu.

Ein bestehender Login wird nur ersetzt, wenn die neue Anmeldung klappt. Die Seite startet nur
`claude auth login`, kennt keine Tokens der Rolle und ist nur ueber den Ingress-Proxy erreichbar
(HA-Admins).

## Firewall auswerten (learn → enforce)

Im SSH-Terminal: `docker exec addon_<hash>_claude_hausmeister firewall-status`.
Unter „Ziele, die 'enforce' blockieren wuerde“ sollte nach 1–2 Tagen Nutzung nichts
Wichtiges stehen. Die DNS-Anfragen stehen im Add-on-Log (`[dns] … query[A] …`).
Fehlt eine Domain, gehoert sie in `ALLOW_DOMAINS` in `rootfs/opt/agent/role.env`.

## Wenn es klemmt

- **„Mehrfach sofort beendet“ im Log:** Login abgelaufen. Ueber die Login-Seite neu anmelden
  (siehe oben). Ohne Ingress: `setup_terminal` an, Schritt 1 erneut, danach wieder aus.
- **Server startet ohne Fehlermeldung nicht dauerhaft:** Option `pty` einschalten.
- **Firewall (enforce) konnte nicht eingerichtet werden:** Der Agent startet dann bewusst
  nicht. Zum Eingrenzen voruebergehend `learn`.
