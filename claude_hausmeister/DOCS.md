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
6. `setup_terminal` wieder ausschalten und das Add-on neu starten.

Ohne Ingress geht es auch per SSH-Add-on (Schutzmodus kurz aus):
`docker exec -it addon_<hash>_claude_hausmeister agent-shell`. Den genauen Namen zeigt das
Add-on-Log beim Start.

## Optionen

| Option | Wirkung |
|---|---|
| `firewall_mode` | `off` kein Filter · `learn` nichts blockieren, Ziele protokollieren · `enforce` nur `anthropic.com`, `claude.ai`, `claude.com` (+ Subdomains, 160.79.104.0/23) und der Supervisor-Proxy; DNS nur fuer diese Namen |
| `setup_terminal` | Web-Terminal fuer Login und Tests; eingehend nur vom HA-Ingress-Proxy erreichbar |
| `pty` | Server in einem Pseudo-Terminal starten – nur falls er ohne Terminal nicht laeuft |

## Freigaben

- `ha_read` (nur lesen) laeuft ohne Rueckfrage.
- `ha_write` fragt **jedes Mal** – das ist in den Managed Settings fest eingestellt und laesst
  sich in der App nicht auf „immer erlauben“ stellen. Vor dem Freigeben lesen, was geaendert wird.
- Vor Aenderungen an Dashboards, Automationen, Skripten und Szenen legt `ha_write` den alten
  Stand unter `/data/workspace/ha/backup/` ab. Zuruecksetzen: den Hausmeister bitten, die
  Sicherung zurueckzuschreiben.
- Gesperrt, auch mit Freigabe: Benutzer/Anmeldung, Integrationen hinzufuegen/entfernen,
  Supervisor/Add-ons, Backups, Services `hassio.*` und `backup.*`.

## Firewall auswerten (learn → enforce)

Im SSH-Terminal: `docker exec addon_<hash>_claude_hausmeister firewall-status`.
Unter „Ziele, die 'enforce' blockieren wuerde“ sollte nach 1–2 Tagen Nutzung nichts
Wichtiges stehen. Die DNS-Anfragen stehen im Add-on-Log (`[dns] … query[A] …`).
Fehlt eine Domain, gehoert sie in `ALLOW_DOMAINS` in `rootfs/opt/agent/role.env`.

## Wenn es klemmt

- **„Mehrfach sofort beendet“ im Log:** Login abgelaufen (ca. alle 4 Wochen).
  `setup_terminal` an, Schritt 1 erneut, danach wieder aus.
- **Server startet ohne Fehlermeldung nicht dauerhaft:** Option `pty` einschalten.
- **Firewall (enforce) konnte nicht eingerichtet werden:** Der Agent startet dann bewusst
  nicht. Zum Eingrenzen voruebergehend `learn`.
