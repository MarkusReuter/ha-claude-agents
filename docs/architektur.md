# Architektur und Stand

Ergaenzt `uebergabe.md`. Hier steht, was gebaut ist und wo es vom Entwurf abweicht.

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

## Danach

- Feste Claude-Code-Version in `Dockerfile` pinnen (`CLAUDE_CODE_VERSION`).
- Archivar/Sekretaer als Kopie von `claude_hausmeister/`. Unterschiede: `config.yaml`
  (`homeassistant_api: false`), `role.env` (`KEEP_HA_TOKEN=0`, `ALLOW_INTERNAL`),
  `CLAUDE.md`, `managed-mcp.json`, ggf. Deny-Ergaenzungen. Gemeinsame Dateien dann per Skript
  synchron halten.
