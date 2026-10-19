# ha-claude-agents

Home-Assistant-Add-on-Repository fuer private Claude-Code-Agenten
(Hausmeister, Archivar, Architekt, geplant: Sekretaer) unter Home Assistant OS. Bedienung per
`claude remote-control` aus der Claude-App, Konto: privates **Pro**-Abo.

- Hintergrund und feste Entscheidungen: `docs/uebergabe.md`, Sicherheitsmodell:
  Anhang A in `KimWeb/claude/heimserver-plan.md`. Stand und Abweichungen: `docs/architektur.md`.
- **Grundregel „Rule of Two“ (nie verletzen):** Ein Agent hat hoechstens zwei von
  (A) nicht vertrauenswuerdige Inhalte lesen (Internet, Mails, fremde Dokumente/Entitaeten),
  (B) Zugriff auf sensible Daten, (C) schreiben/Zustand aendern/nach aussen senden.
  Hat er alle drei, muss C an eine Freigabe durch Markus gebunden sein (`ask`). Jede neue
  Faehigkeit (Werkzeug, Domain, Mapping, Add-on) dagegen pruefen, siehe `docs/architektur.md`.
  Deshalb kein `Bash`: eine Shell liefert C ungefiltert (Tokens in der Umgebung).
  Einzige bewusste Ausnahme: **Architekt** (Bash + Internet, dafuer kein HA/Paperless/LAN, keine
  Connectoren, kein Token beim Agenten, GitHub-Push nur `claude/*` ueber Proxy) – siehe architektur.md.
- Sprache: Deutsch. Alles mit LF-Zeilenenden (siehe .gitattributes).
- Keine Geheimnisse ins Repo (Tokens, Passwoerter, Mail-Zugangsdaten). Das Repo ist oeffentlich.
- Sicherheitsrelevante Aenderungen (managed-settings.json, managed-mcp.json, firewall.sh,
  agent-common.sh, config.yaml-Rechte, Rechte im Workspace) immer begruenden.
- Updates: `version` in `config.yaml` hochzaehlen + CHANGELOG, sonst baut der Supervisor nicht neu.
- Gemeinsame Dateien (run.sh, agent-common.sh, agent-setup, agent-shell, firewall*.sh) nur in
  `claude_hausmeister/` aendern, dann `tools/check-common.sh --sync`; alle betroffenen Add-ons hochzaehlen.
  Rollenspezifisches gehoert nach `rootfs/opt/agent/role.env` und `role.sh`.
- Tests MCP-Server und GitHub-Proxy: `node --test claude_archivar/tests/*.test.mjs claude_hausmeister/tests/*.test.mjs claude_architekt/tests/*.test.mjs`

## Zugriff auf Home Assistant (fuer Claude in VS Code)

WebSocket-Helper und Token liegen in `C:\Users\marku\OneDrive\Claude\HomeAssistant`
(`ha-ws.js`, `.mcp.json`). Add-on-Status z. B.:
`node ha-ws.js '{"type":"supervisor/api","endpoint":"/addons/<slug>/info","method":"get"}'`.
Add-on-Logs liefert die WS-Bridge nicht (Text statt JSON) – die liest der Nutzer in der HA-Oberflaeche.
