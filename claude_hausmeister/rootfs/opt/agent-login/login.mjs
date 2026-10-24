// Login-Seite fuer das HA-Seitenmenue (Ingress), wenn das Einrichtungs-Terminal aus ist.
// Erneuert den Claude-Login vom Handy aus: 'claude auth login' starten, Link anzeigen, Code
// entgegennehmen. Laeuft als agent ohne die Tokens der Rolle (run.sh leert AGENT_ENV).
// Erreichbar nur ueber den Ingress-Proxy (Eingangsfilter in firewall.sh), also nur fuer HA-Admins.
// Gemeinsame Datei aller Rollen – nur in claude_hausmeister aendern, dann tools/check-common.sh --sync.
import http from 'node:http';
import fs from 'node:fs';
import { spawn, execFile } from 'node:child_process';

const PORT = Number(process.env.LOGIN_PORT || 7681);
const NAME = process.env.SESSION_NAME || 'Agent';
const STATUS_FILE = process.env.AGENT_STATUS_FILE || '/run/agent-status';
// Fuer Tests ersetzbar (JSON-Liste: Programm und erste Argumente); setzt nur run.sh bzw. der Test
const [CLAUDE, ...CLAUDE_ARGS] = JSON.parse(process.env.CLAUDE_CMD || '["claude"]');
const LOGIN_HOSTS = ['claude.com', 'claude.ai'];
// Code von der Callback-Seite: <code>#<state>, keine Leer- oder Steuerzeichen
const CODE_RE = /^[A-Za-z0-9._~#-]{10,2048}$/;
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const URL_WAIT_MS = 30 * 1000;
const CODE_WAIT_MS = 60 * 1000;

// Umgebung fuer claude: nur was es zum Anmelden braucht
const CLAUDE_ENV = Object.fromEntries(
  ['HOME', 'USER', 'LOGNAME', 'PATH', 'LANG', 'TZ', 'CLAUDE_CONFIG_DIR', 'DISABLE_AUTOUPDATER']
    .filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '');

// Kurzfassung der Ausgabe fuer die Seite, ohne Links und Steuerzeichen
function kurz(text) {
  return stripAnsi(text).split('\n').map((z) => z.trim())
    .filter((z) => z && !/https?:\/\//.test(z) && !/^Opening browser/.test(z))
    .map((z) => z.replace(/^Paste code here if prompted >\s*/, ''))
    .filter(Boolean).join(' ').slice(-400);
}

// Erst vollstaendige Zeile (Leerzeichen/Zeilenende dahinter), sonst koennte ein halber Link kommen
const rohUrl = (text) => stripAnsi(text).match(/https:\/\/\S+\/oauth\/authorize\?\S+(?=\s)/)?.[0] ?? null;

function loginUrl(text) {
  const roh = rohUrl(text);
  if (!roh) return null;
  try {
    const u = new URL(roh);
    return u.protocol === 'https:' && LOGIN_HOSTS.includes(u.hostname) ? u.href : null;
  } catch { return null; }
}

// Laufender Anmeldevorgang (hoechstens einer)
let login = null;

function beende(l) {
  if (!l || l.ende) return;
  clearTimeout(l.timer);
  l.proc.kill('SIGTERM');
}

function starteLogin() {
  beende(login);
  const proc = spawn(CLAUDE, [...CLAUDE_ARGS, 'auth', 'login', '--claudeai'], {
    env: CLAUDE_ENV, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const l = { proc, ausgabe: '', ende: null, warte: [] };
  const neu = (d) => {
    l.ausgabe = (l.ausgabe + d.toString()).slice(-20000);
    for (const w of l.warte.splice(0)) w();
  };
  proc.stdout.on('data', neu);
  proc.stderr.on('data', neu);
  proc.stdin.on('error', () => {});
  proc.on('error', (e) => { l.ausgabe += `\n${e.message}`; });
  proc.on('close', (code) => {
    clearTimeout(l.timer);
    l.ende = { code };
    for (const w of l.warte.splice(0)) w();
  });
  l.timer = setTimeout(() => proc.kill('SIGTERM'), LOGIN_TIMEOUT_MS);
  login = l;
  return l;
}

// Wartet, bis bedingung() wahr ist oder der Vorgang endet (Neuigkeit in der Ausgabe weckt auf)
function warteAuf(l, bedingung, ms) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), ms);
    const pruefe = () => {
      if (bedingung() || l.ende) { clearTimeout(t); resolve(bedingung()); } else l.warte.push(pruefe);
    };
    pruefe();
  });
}

function authStatus() {
  return new Promise((resolve) => {
    execFile(CLAUDE, [...CLAUDE_ARGS, 'auth', 'status', '--json'], { env: CLAUDE_ENV, timeout: 20000 }, (err, stdout) => {
      try {
        const s = JSON.parse(stdout);
        resolve({ angemeldet: s.loggedIn === true, email: s.email || null, abo: s.subscriptionType || null });
      } catch { resolve({ angemeldet: false, email: null, abo: null, fehler: err ? 'Status nicht lesbar' : null }); }
    });
  });
}

function dienstStatus() {
  try { return fs.readFileSync(STATUS_FILE, 'utf8').trim().slice(0, 300); } catch { return 'unbekannt'; }
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function leseJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (d) => {
      body += d;
      if (body.length > 8192) { reject(new Error('zu gross')); req.destroy(); }
    });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('kein JSON')); } });
    req.on('error', reject);
  });
}

async function handle(req, res) {
  const pfad = new URL(req.url, 'http://x').pathname;
  if (req.method === 'GET' && pfad === '/') {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
      'referrer-policy': 'no-referrer',
    });
    return res.end(SEITE);
  }
  if (req.method === 'GET' && pfad === '/status') {
    return json(res, 200, { name: NAME, dienst: dienstStatus(), ...(await authStatus()), laeuft: !!(login && !login.ende) });
  }
  if (req.method !== 'POST') return json(res, 404, { fehler: 'Nicht gefunden' });
  // Eigener Header: ein fremdes Formular oder Skript kann ihn nicht ohne CORS-Freigabe setzen
  if (req.headers['x-agent-login'] !== '1') return json(res, 403, { fehler: 'Nicht erlaubt' });
  let daten;
  try { daten = await leseJson(req); } catch (e) { return json(res, 400, { fehler: e.message }); }

  if (pfad === '/start') {
    const l = starteLogin();
    await warteAuf(l, () => rohUrl(l.ausgabe), URL_WAIT_MS);
    const url = loginUrl(l.ausgabe);
    if (!url) {
      beende(l);
      return json(res, 502, { fehler: `Kein Anmelde-Link erhalten. ${kurz(l.ausgabe)}`.trim() });
    }
    return json(res, 200, { url });
  }

  if (pfad === '/code') {
    const code = typeof daten.code === 'string' ? daten.code.trim() : '';
    if (!CODE_RE.test(code)) return json(res, 400, { fehler: 'Das sieht nicht wie der Code von der Anmeldeseite aus.' });
    const l = login;
    if (!l || l.ende) return json(res, 409, { fehler: 'Kein Anmeldevorgang offen – bitte neu starten.' });
    const vorher = l.ausgabe.length;
    l.proc.stdin.write(`${code}\n`);
    await warteAuf(l, () => false, CODE_WAIT_MS);
    if (!l.ende) {
      beende(l);
      return json(res, 504, { fehler: 'Keine Antwort von claude – bitte neu starten.' });
    }
    const meldung = kurz(l.ausgabe.slice(vorher));
    if (l.ende.code !== 0) return json(res, 400, { fehler: meldung || `Anmeldung fehlgeschlagen (Exit ${l.ende.code}).` });
    return json(res, 200, { ok: true, meldung, ...(await authStatus()) });
  }

  if (pfad === '/abbrechen') {
    beende(login);
    return json(res, 200, { ok: true });
  }
  return json(res, 404, { fehler: 'Nicht gefunden' });
}

const SEITE = `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${NAME.replace(/[<>&"]/g, '')} – Anmeldung</title>
<style>
  :root { --bg:#f6f7f9; --karte:#fff; --text:#1c1f23; --leise:#5f6670; --rand:#d9dde3; --akzent:#1f6feb; --ok:#1a7f37; --fehler:#cf222e; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#111418; --karte:#1b1f24; --text:#e6e8eb; --leise:#9aa3ad; --rand:#30363d; --akzent:#4c8dff; --ok:#3fb950; --fehler:#f85149; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width:560px; margin:0 auto; padding:20px 16px 40px; }
  h1 { font-size:1.4rem; margin:0 0 16px; }
  .karte { background:var(--karte); border:1px solid var(--rand); border-radius:12px; padding:16px; margin-bottom:16px; }
  dl { margin:0; display:grid; grid-template-columns:auto 1fr; gap:6px 12px; }
  dt { color:var(--leise); } dd { margin:0; overflow-wrap:anywhere; }
  button, .knopf { display:block; width:100%; padding:14px; border-radius:10px; border:0; font:inherit; font-weight:600;
    background:var(--akzent); color:#fff; text-align:center; text-decoration:none; cursor:pointer; }
  button.zweit { background:transparent; color:var(--akzent); border:1px solid var(--rand); margin-top:10px; }
  button:disabled { opacity:.5; cursor:default; }
  input { width:100%; padding:12px; font:inherit; border-radius:10px; border:1px solid var(--rand); background:var(--bg); color:var(--text); margin:10px 0; }
  ol { padding-left:1.2em; margin:0 0 14px; } li { margin-bottom:6px; }
  .leise { color:var(--leise); font-size:.9rem; }
  .meldung { margin-top:12px; overflow-wrap:anywhere; } .ok { color:var(--ok); } .fehler { color:var(--fehler); }
  [hidden] { display:none !important; }
</style>
</head>
<body>
<main>
  <h1 id="titel">Anmeldung</h1>
  <section class="karte">
    <dl>
      <dt>Dienst</dt><dd id="dienst">…</dd>
      <dt>Login</dt><dd id="login">…</dd>
    </dl>
  </section>

  <section class="karte" id="schritt1">
    <button id="start">Neu anmelden</button>
    <p class="leise">Startet eine neue Anmeldung mit dem privaten Pro-Konto. Ein bestehender Login
      wird erst ersetzt, wenn die neue Anmeldung klappt.</p>
  </section>

  <section class="karte" id="schritt2" hidden>
    <ol>
      <li>Link öffnen und mit dem <b>privaten Pro-Konto</b> bestätigen.</li>
      <li>Den angezeigten Code kopieren.</li>
      <li>Hierher zurück, Code einfügen, absenden.</li>
    </ol>
    <a class="knopf" id="link" target="_blank" rel="noopener noreferrer">Bei Claude anmelden</a>
    <input id="code" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Code einfügen">
    <button id="senden">Absenden</button>
    <button class="zweit" id="abbrechen">Abbrechen</button>
  </section>

  <p class="meldung" id="meldung" role="status"></p>
  <p class="leise">Die Ersteinrichtung (Ordner vertrauen, Remote Control freischalten) läuft weiter
    über die Option <code>setup_terminal</code>.</p>
</main>
<script>
const $ = (id) => document.getElementById(id);
const post = (pfad, daten) => fetch(pfad, { method: 'POST', headers: { 'content-type': 'application/json', 'x-agent-login': '1' },
  body: JSON.stringify(daten || {}) }).then(async (r) => ({ ok: r.ok, ...(await r.json().catch(() => ({ fehler: 'Antwort unlesbar' }))) }));
function meldung(text, art) { const m = $('meldung'); m.textContent = text || ''; m.className = 'meldung ' + (art || ''); }
function zeige(schritt) { $('schritt1').hidden = schritt !== 1; $('schritt2').hidden = schritt !== 2; }
function loginText(s) {
  if (!s.angemeldet) return 'kein Login gespeichert';
  return 'gespeichert' + (s.email ? ' (' + s.email + (s.abo ? ', ' + s.abo : '') + ')' : '');
}
async function status() {
  try {
    const s = await fetch('status', { cache: 'no-store' }).then((r) => r.json());
    $('titel').textContent = s.name + ' – Anmeldung'; document.title = $('titel').textContent;
    $('dienst').textContent = s.dienst; $('login').textContent = loginText(s);
  } catch { $('dienst').textContent = 'nicht erreichbar'; }
}
$('start').onclick = async () => {
  $('start').disabled = true; meldung('Starte Anmeldung …');
  const r = await post('start');
  $('start').disabled = false;
  if (!r.ok) return meldung(r.fehler, 'fehler');
  $('link').href = r.url; $('code').value = ''; zeige(2); meldung('');
};
$('senden').onclick = async () => {
  const code = $('code').value.trim();
  if (!code) return meldung('Bitte den Code einfügen.', 'fehler');
  $('senden').disabled = true; meldung('Prüfe Code …');
  const r = await post('code', { code });
  $('senden').disabled = false;
  if (!r.ok) { zeige(1); return meldung(r.fehler + ' – bitte mit „Neu anmelden“ erneut versuchen.', 'fehler'); }
  zeige(1); meldung('Angemeldet. Der Agent startet in wenigen Sekunden neu und erscheint dann wieder in der Claude-App.', 'ok');
  status();
};
$('abbrechen').onclick = async () => { await post('abbrechen'); zeige(1); meldung(''); };
status(); setInterval(status, 15000);
</script>
</body>
</html>
`;

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => json(res, 500, { fehler: e.message }));
});
server.listen(PORT, '0.0.0.0', () => console.log(`Login-Seite auf Port ${PORT}`));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { beende(login); process.exit(0); });
