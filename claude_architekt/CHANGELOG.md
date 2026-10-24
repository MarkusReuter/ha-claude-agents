# Changelog

## 0.1.2
- **Login-Seite im HA-Seitenmenue:** Ist `setup_terminal` aus, zeigt die Web-UI (Seitenmenue
  „Architekt“, auch in der HA-App) den Zustand des Dienstes und erneuert den Claude-Login ohne
  Terminal: „Neu anmelden“, Link im Browser bestaetigen, Code einfuegen. Kleiner Node-Server
  `/opt/agent-login/login.mjs` (gemeinsame Datei), der nur `claude auth login` startet
- Nach drei sofortigen Abbruechen (Login abgelaufen) endet die Pause von bis zu 10 Minuten, sobald
  ein neuer Login gespeichert ist; Start nach hoechstens 10 Sekunden. Fehlt der Login ganz (bei
  erledigter Einrichtung), wartet das Add-on ebenso auf die Login-Seite
- Sicherheitsrelevant: neuer eingehender Dienst auf dem bisherigen ttyd-Port 7681 – gleicher
  Eingangsfilter (nur Ingress-Proxy 172.30.32.2, Loopback und IPv6 gesperrt), also nur fuer
  HA-Admins. Laeuft als `agent` ohne `AGENT_ENV` (keine Tokens der Rolle), `claude` bekommt nur
  eine Positivliste der Umgebung. Der Code wird vor der Weitergabe geprueft (keine Leer- oder
  Steuerzeichen), angezeigt werden nur Links auf claude.com/claude.ai; POST nur mit eigenem
  Header (kein Formular von fremden Seiten). Der Agent bekommt keine neue Faehigkeit: Er erreicht
  die Seite nicht, und `claude auth login` konnte nur der Architekt (Bash) schon vorher starten
- `run.sh` schreibt den Zustand nach `/run/agent-status` (root, lesbar fuer alle, nichts Geheimes)

## 0.1.1
- **Gemini fuer Innenarchitektur, Bilder und Videos:** Neuer Weg `/gemini/…` im Proxy
  (`$GEMINI_API_BASE`) zur Google Gemini API, gleiche Pfade wie bei Google, ohne Key. Alle Aufrufe
  erlaubt (Text, Bild, Veo-Video, Interactions, Dateien). Werkzeug `gemini-bild` fuer Einzelbilder.
  Neue Optionen `gemini_api_key`, `gemini_modell`, `gemini_max_pro_tag`
- Sicherheitsrelevant: Der API-Key liegt wie der GitHub-Token nur beim Proxy (`/run/github-proxy/gemini`,
  Nutzer gitproxy), der Agent sieht ihn nicht; ein eigener `?key=` wird entfernt. Tageslimit
  (Standard 100 erzeugende Aufrufe) gegen Kosten durch Prompt Injection oder Schleifen.
  Neuer Weg nach aussen fuer Inhalte (Fotos, Plaene gehen an Google) – siehe DOCS
- Image: `python3-pil`, `python-is-python3`, `ffmpeg` (wie das Setup-Skript der Cloud-Umgebung,
  ffmpeg fuer Videos)

## 0.1.0
- Erste Version: Coding-Agent fuer Code und Bauthemen mit Bash, Internet (IPv4) und den GitHub-Repos von `github_owner`.
  Lokales Netz (HA, Paperless, Router, andere Add-ons) und IPv6 per Firewall gesperrt
  (`EGRESS=internet`), DNS-Antworten mit privaten Adressen verworfen
- GitHub-Proxy als eigener Nutzer `gitproxy`: haelt den Token, laesst Pushes nur auf `claude/*`
  und nie Tags durch, REST-API nur lesen, Pull Request und Kommentar anlegen. Kein Merge, kein
  Workflow-Start. Austausch-Repo (`austausch_repo`, Standard `private-data`): alle Branches und
  Pakete als Release `paket-*`
- Pakete wie beim Hausmeister: derselbe MCP-Server `ablage` (`paket_erstellen`, `paket_hochladen`),
  Ordner `ausgang/`, Releases `paket-*` mit 30 Tagen Haltezeit. Der Upload laeuft ueber den Proxy,
  der Server bekommt nur einen Platzhalter statt des Tokens
- Werkzeugordner `/data/architekt/.werkzeuge` (persistent, nicht im Backup) mit vorbereiteten
  Pfaden fuer Flutter, Android-SDK, JDK, npm -g
- claude.ai-Connectoren (Gmail, Drive, Kalender) abgeschaltet; ohne diese Einstellung startet der
  Agent nicht
