# Claude Archivar

Claude Code laeuft als Remote-Control-Server im Add-on und ist ueber die Claude-App erreichbar
(Konto: privates **Pro**-Abo, Sitzung „Archivar“). Der Agent sieht Paperless-ngx nur ueber den
eingebauten MCP-Server `paperless` mit sieben festen Werkzeugen. Er sucht Dokumente, liest
Originale selbst (PDF und Bilder) und ersetzt den OCR-Text durch eine woertliche Abschrift.
Shell, Web-Abruf und Websuche sind gesperrt; lesen darf er nur die heruntergeladenen Originale.

## 1. Paperless-Benutzer „archivar“ anlegen (einmalig)

Der Archivar bekommt einen eigenen Paperless-Benutzer **ohne Loeschrecht**. Weil globale
Rechte in Paperless die *Summe* aus Benutzer- und Gruppenrechten sind, darf er nicht in einer
Gruppe mit Vollrechten sein. Deshalb werden Rollen (globale Rechte) und Freigaben
(Objektrechte an Dokumenten) getrennt:

| Gruppe | Globale Rechte | Mitglieder |
|---|---|---|
| **Users für Markus Bereich** (besteht) | **keine** (nur noch Freigabe von Markus' Dokumenten) | Markus, Jutta, archivar |
| **Vollzugriff** (neu) | wie bisher *Users für Markus Bereich* | Markus, Jutta |
| **Archivar** (neu) | siehe unten | archivar |

Reihenfolge – damit sich niemand aussperrt:

1. Pruefen, ob Markus **Superuser** ist (Einstellungen → Benutzer & Gruppen). Wenn nicht, bekommt
   er seine Rechte bisher ueber die Gruppe und muss in Schritt 2 mit in *Vollzugriff*.
2. Gruppe **Vollzugriff** anlegen, Rechte wie bisher bei *Users für Markus Bereich* setzen,
   Markus und Jutta aufnehmen.
3. Erst dann bei *Users für Markus Bereich* alle globalen Rechte entfernen.
4. Mit Jutta pruefen, ob sie weiter alles sieht und bearbeiten kann.
5. Gruppe **Archivar** anlegen, globale Rechte nur:

   | Typ | Hinzufuegen | Bearbeiten | Loeschen | Anzeigen |
   |---|---|---|---|---|
   | Document | – | ✔ | **–** | ✔ |
   | Tag | ✔ (nur falls der Archivar die OCR-Tags anlegen soll) | – | – | ✔ |
   | Correspondent | – | – | – | ✔ |
   | DocumentType | – | – | – | ✔ |
   | Note | ✔ | – | – | ✔ |
   | alles andere | – | – | – | – |

6. Benutzer **archivar** anlegen: kein Superuser, nicht aktiv als Mitarbeiter/Admin, langes
   Zufallspasswort (wird nicht gebraucht), Gruppen *Users für Markus Bereich* und *Archivar*.
7. Token erzeugen: Paperless-Admin-Oberflaeche `…/admin/` → **Auth Token → Tokens → Hinzufuegen**,
   Benutzer *archivar*. Den Schluessel in die Add-on-Option `paperless_token` kopieren – nirgends sonst.
8. Die Tags `ocr-neu` und `ocr-claude` am besten selbst anlegen (Zuweisung: „Keine“), freigegeben
   fuer *Users für Markus Bereich*. Sonst legt der Archivar sie beim ersten Setzen **ohne Besitzer** an.

Folgen:
- Der Archivar sieht und aendert nur Dokumente, die fuer *Users für Markus Bereich* freigegeben
  sind. **Julias Dokumente sieht er nicht.** Neue Dokumente erreicht er nur, wenn sie diese
  Freigabe bekommen (wie heute fuer Jutta, z. B. per Workflow).
- Tags und Korrespondenten, die er nicht sehen darf, erscheinen bei ihm als `#<id>`.
- Das Token verhindert **Loeschen**. Drehen, Teilen und Zusammenfuehren laufen in Paperless ueber
  `bulk_edit` mit dem Bearbeiten-Recht – davor schuetzt, dass der MCP-Server diese Endpunkte nicht
  kennt und der Agent keinen anderen Weg zu Paperless hat (kein Bash, kein Web, Firewall).

## 2. Add-on einrichten (einmalig)

1. Add-on installieren (der Supervisor baut das Image lokal, das dauert einige Minuten).
2. Konfiguration: `paperless_token` eintragen. `paperless_url` ist auf das Paperless-Add-on
   voreingestellt (`http://ca5234a0-paperless-ngx:80`, internes Add-on-Netz, **nicht** die
   oeffentliche Adresse). `paperless_write` erst nach dem Test in Abschnitt 3 einschalten.
   `setup_terminal` an, `firewall_mode: learn`. Starten.
3. Auf der Add-on-Seite **Web-UI oeffnen**. Die gefuehrte Einrichtung laeuft als Nutzer `agent`:
   - **Schritt 1:** `claude` startet. Trust-Dialog bestaetigen („Yes, I trust this folder“),
     `/login` mit dem **privaten Pro-Konto**, dann `/exit`.
   - **Schritt 2:** `claude remote-control` startet. „Enable Remote Control?“ mit `y`
     bestaetigen, auf die Session-URL warten, dann `Strg+C` und die Frage mit `j` beantworten.
4. Im Terminal den Test aus Abschnitt 3 machen.
5. Innerhalb einer Minute startet das Add-on den Dauerbetrieb („Starte Remote-Control-Server 'Archivar'“).
6. In der Claude-App unter **Code** die Sitzung „Archivar“ oeffnen, einmal `/config` →
   **Push when actions required** einschalten.
7. `setup_terminal` wieder ausschalten und das Add-on neu starten.

Ohne Ingress geht es auch per SSH-Add-on (Schutzmodus kurz aus):
`docker exec -it addon_<hash>_claude_archivar agent-shell`.

## 3. Test: Loeschen muss scheitern (403)

Im Einrichtungs-Terminal (dort sind `PAPERLESS_URL` und `PAPERLESS_TOKEN` gesetzt, der Token
wird nicht angezeigt). Vorher in Paperless ein **Wegwerf-Dokument** hochladen, fuer
*Users für Markus Bereich* freigeben und seine ID notieren:

```bash
ID=<id des Wegwerf-Dokuments>
# Lesen muss gehen: 200
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Token $PAPERLESS_TOKEN" "$PAPERLESS_URL/api/documents/$ID/"
# Loeschen muss scheitern: 403
curl -s -o /dev/null -w '%{http_code}\n' -X DELETE -H "Authorization: Token $PAPERLESS_TOKEN" "$PAPERLESS_URL/api/documents/$ID/"
# Loeschen ueber bulk_edit muss ebenfalls scheitern: 403
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H "Authorization: Token $PAPERLESS_TOKEN" \
     -H 'Content-Type: application/json' -d "{\"documents\":[$ID],\"method\":\"delete\"}" \
     "$PAPERLESS_URL/api/documents/bulk_edit/"
```

Erwartet: `200`, `403`, `403`. Kommt beim Loeschen `204`/`200`, hat der Benutzer zu viele Rechte
(meist ueber eine Gruppe) – das Dokument liegt dann im Papierkorb von Paperless. Rechte
korrigieren und den Test wiederholen, **bevor** der Archivar in Betrieb geht.
Ein Julia-Dokument muss beim Lesen `404` liefern.

## Optionen

| Option | Wirkung |
|---|---|
| `paperless_url` | interne Paperless-Adresse; zugleich das einzige interne Firewall-Ziel |
| `paperless_token` | Token des Benutzers *archivar* – wird nie geloggt, nur root kann die Optionen lesen |
| `paperless_link_url` | Adresse, unter der du Paperless im Browser oeffnest. Der Archivar zeigt Dokumente dann als Links `…/documents/<id>/details` – anzeigen mit deinem eigenen Paperless-Login. Nur Text, wird nie abgerufen und ist kein Firewall-Ziel. Leer = keine Links |
| `paperless_write` | Inhalt ersetzen und OCR-Tags setzen (Standard **aus** = nur lesen). Wirkt nach Neustart |
| `tag_ocr_neu`, `tag_ocr_claude` | Namen der beiden OCR-Tags (Standard `ocr-neu`, `ocr-claude`) |
| `firewall_mode` | `off` · `learn` (nichts blockieren, Ziele protokollieren) · `enforce` (nur Anthropic und Paperless; DNS nur fuer diese Namen) |
| `setup_terminal` | Web-Terminal fuer Login und Tests; eingehend nur vom HA-Ingress-Proxy |
| `pty` | Server in einem Pseudo-Terminal starten – nur falls er ohne Terminal nicht laeuft |

## Werkzeuge und Freigaben

| Werkzeug | Wirkung | Freigabe |
|---|---|---|
| `search_documents` | Volltext + Datum/Tag/Korrespondent | ohne |
| `list_documents_by_tag` | Dokumente mit einem Tag | ohne |
| `get_document` | Metadaten und aktueller Inhalt | ohne |
| `download_original` | Original nach `/work/ocr/<id>.<pdf/jpg/png/…>` (TIFF u. a.: Archiv-PDF) | ohne |
| `find_suspicious_ocr` | Heuristik ohne KI: leer, wenig Text/Seite, `Ã¤`-Umlaute, Sonderzeichen, Einzelbuchstaben | ohne |
| `update_content` | sichert alten Inhalt als Notiz „Inhalt vor Claude-OCR (Datum)“, dann nur `content` | **jedes Mal** |
| `set_ocr_tags` | nur die zwei OCR-Tags, andere Tags bleiben | **jedes Mal** |

- Die Rueckfrage ist in den Managed Settings fest eingestellt und laesst sich in der App nicht
  auf „immer erlauben“ stellen. In der Freigabe von `update_content` steht der komplette neue Text.
- Zuruecksetzen: Der alte Inhalt steht als Notiz am Dokument (Reiter **Notizen**) und kann in
  Paperless zurueckkopiert werden.
- Heruntergeladene Originale liegen nur im Container (`/work/ocr`, nicht im HA-Backup), immer
  nur eines, und werden nach `update_content` bzw. beim naechsten Download geloescht.
- Geaendert wird nur das Inhaltsfeld (Suche/Anzeige). Die Textebene des Archiv-PDFs bleibt, wie sie ist.

## Beispiele in der App

- „Lies die Dokumente mit Tag ocr-neu neu aus“
- „Bearbeite Dokument 1234“ / „Bearbeite die Stromrechnungen 2024“
- „Pruefe auf Ungereimtheiten“ (optional: „… bei Dokumenten von 2019“)

Der Archivar arbeitet in Stapeln von hoechstens 15 Dokumenten und fasst danach zusammen.

## Firewall auswerten (learn → enforce)

Im SSH-Terminal: `docker exec addon_<hash>_claude_archivar firewall-status`. Unter „Ziele, die
'enforce' blockieren wuerde“ sollte nach 1–2 Tagen nichts Wichtiges stehen.
Paperless wird aus `paperless_url` freigegeben; sonstige Domains in `ALLOW_DOMAINS` in
`rootfs/opt/agent/role.env`.

## Wenn es klemmt

- **„HTTP 401“:** Token falsch oder leer (Option `paperless_token`).
- **„HTTP 404 … nicht sichtbar“:** Das Dokument ist nicht fuer *Users für Markus Bereich* freigegeben.
- **„Paperless nicht erreichbar“:** `paperless_url` pruefen; nach einer Aenderung Add-on neu starten
  (die Firewall uebernimmt das Ziel nur beim Start). Bekommt das Paperless-Add-on eine neue
  interne IP, ebenfalls neu starten.
- **„Mehrfach sofort beendet“ im Log:** Login abgelaufen (ca. alle 4 Wochen).
  `setup_terminal` an, Schritt 1 erneut, danach wieder aus.
