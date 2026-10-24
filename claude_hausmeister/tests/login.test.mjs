// Tests fuer die Login-Seite (opt/agent-login/login.mjs) mit einem nachgebauten 'claude', das sich
// wie 'claude auth login' ohne Terminal verhaelt (Link ausgeben, Code von stdin lesen). Ohne Abhaengigkeiten.
// Aufruf im Repo-Wurzelordner:  node --test claude_hausmeister/tests/*.test.mjs
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'rootfs', 'opt', 'agent-login', 'login.mjs');
const GUTER_CODE = 'abcDEF123_-~.xyz#state987';

// Nachbau von 'claude auth status/login'. Datei 'boese' im Config-Ordner: Link auf fremden Host,
// Datei 'stumm': kein Link.
const FAKE = `
import fs from 'node:fs';
import path from 'node:path';
const dir = process.env.CLAUDE_CONFIG_DIR;
const cred = path.join(dir, '.credentials.json');
const [cmd, sub] = process.argv.slice(2);
fs.writeFileSync(path.join(dir, 'env.json'), JSON.stringify(Object.keys(process.env)));
if (cmd === 'auth' && sub === 'status') {
  const da = fs.existsSync(cred);
  console.log(JSON.stringify(da ? { loggedIn: true, email: 'markus@example.org', subscriptionType: 'pro' } : { loggedIn: false }));
  process.exit(0);
}
if (cmd === 'auth' && sub === 'login') {
  if (fs.existsSync(path.join(dir, 'stumm'))) { console.log('Irgendwas ging schief'); process.exit(3); }
  const host = fs.existsSync(path.join(dir, 'boese')) ? 'evil.example' : 'claude.com';
  process.stdout.write('Opening browser to sign in\\u2026\\nIf the browser didn\\'t open, visit: https://' + host +
    '/cai/oauth/authorize?code=true&client_id=x&state=abc\\nPaste code here if prompted > ');
  let buf = '';
  process.stdin.on('data', (d) => {
    buf += d;
    if (!buf.includes('\\n')) return;
    const code = buf.split('\\n')[0];
    fs.appendFileSync(path.join(dir, 'codes.log'), code + '\\n');
    if (code === '${GUTER_CODE}') {
      fs.writeFileSync(cred, '{"claudeAiOauth":{}}');
      console.log('Login successful.');
      process.exit(0);
    }
    console.log('Login failed: Request failed with status code 400');
    process.exit(1);
  });
}
`;

let tmp, cfg, statusFile, proc, base;

function freierPort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

const post = (pfad, daten, header = { 'x-agent-login': '1' }) =>
  fetch(base + pfad, { method: 'POST', headers: { 'content-type': 'application/json', ...header }, body: JSON.stringify(daten || {}) })
    .then(async (r) => ({ status: r.status, ...(await r.json()) }));
const status = () => fetch(base + '/status').then((r) => r.json());

describe('Login-Seite', () => {
  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'login-'));
    cfg = path.join(tmp, 'claude'); fs.mkdirSync(cfg);
    const fake = path.join(tmp, 'fake-claude.mjs'); fs.writeFileSync(fake, FAKE);
    statusFile = path.join(tmp, 'agent-status'); fs.writeFileSync(statusFile, 'Login abgelaufen? Mehrfach sofort beendet\n');
    const port = await freierPort();
    base = `http://127.0.0.1:${port}`;
    proc = spawn(process.execPath, [SERVER], {
      env: { ...process.env, LOGIN_PORT: String(port), SESSION_NAME: 'Testagent', AGENT_STATUS_FILE: statusFile,
             CLAUDE_CONFIG_DIR: cfg, CLAUDE_CMD: JSON.stringify([process.execPath, fake]),
             // Darf nicht bis zu claude durchgereicht werden
             HA_TOKEN: 'geheim-ha', PAPERLESS_TOKEN: 'geheim-paperless' },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    await new Promise((resolve) => proc.stdout.once('data', resolve));
  });
  after(() => { proc?.kill(); fs.rmSync(tmp, { recursive: true, force: true }); });

  test('Seite mit CSP, ohne Cache', async () => {
    const r = await fetch(base + '/');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-security-policy'), /default-src 'none'/);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.match(await r.text(), /Neu anmelden/);
  });

  test('Status: Dienstzustand aus der Statusdatei, kein Login', async () => {
    const s = await status();
    assert.equal(s.name, 'Testagent');
    assert.equal(s.dienst, 'Login abgelaufen? Mehrfach sofort beendet');
    assert.equal(s.angemeldet, false);
  });

  test('POST ohne eigenen Header wird abgelehnt (kein Formular von fremden Seiten)', async () => {
    const r = await post('/start', {}, {});
    assert.equal(r.status, 403);
  });

  test('Code ohne offenen Vorgang: 409', async () => {
    const r = await post('/code', { code: GUTER_CODE });
    assert.equal(r.status, 409);
  });

  test('Code mit Leer- oder Steuerzeichen erreicht claude nicht', async () => {
    const s = await post('/start');
    assert.equal(s.status, 200);
    for (const code of ['abc def ghi jkl', 'abcdefghijk\nzweite-zeile', '<script>alert(1)</script>', 'kurz']) {
      const r = await post('/code', { code });
      assert.equal(r.status, 400, code);
    }
    assert.equal(fs.existsSync(path.join(cfg, 'codes.log')), false);
    await post('/abbrechen');
  });

  test('Falscher Code: Fehlermeldung von claude, kein Login', async () => {
    const s = await post('/start');
    assert.equal(s.status, 200);
    assert.match(s.url, /^https:\/\/claude\.com\/cai\/oauth\/authorize\?/);
    const r = await post('/code', { code: 'falscherCode#state123' });
    assert.equal(r.status, 400);
    assert.match(r.fehler, /Login failed: Request failed with status code 400/);
    assert.doesNotMatch(r.fehler, /https?:\/\//);
    assert.equal((await status()).angemeldet, false);
  });

  test('Richtiger Code: Login gespeichert', async () => {
    const s = await post('/start');
    assert.equal(s.status, 200);
    const r = await post('/code', { code: `  ${GUTER_CODE}  ` });
    assert.equal(r.status, 200, r.fehler);
    assert.equal(r.ok, true);
    assert.equal(r.angemeldet, true);
    assert.equal(r.email, 'markus@example.org');
    assert.equal(fs.existsSync(path.join(cfg, '.credentials.json')), true);
    // Danach ist kein Vorgang mehr offen
    assert.equal((await post('/code', { code: GUTER_CODE })).status, 409);
  });

  test('Neuer Start beendet den alten Vorgang', async () => {
    await post('/start');
    await post('/start');
    const r = await post('/code', { code: 'falscherCode#state123' });
    assert.equal(r.status, 400);
    const log = fs.readFileSync(path.join(cfg, 'codes.log'), 'utf8').trim().split('\n');
    assert.equal(log.at(-1), 'falscherCode#state123');
  });

  test('Link auf fremden Host wird nicht angezeigt', async () => {
    fs.writeFileSync(path.join(cfg, 'boese'), '');
    try {
      const r = await post('/start');
      assert.equal(r.status, 502);
      assert.equal(r.url, undefined);
    } finally { fs.rmSync(path.join(cfg, 'boese')); }
  });

  test('claude ohne Link: Fehlermeldung mit Ausgabe', async () => {
    fs.writeFileSync(path.join(cfg, 'stumm'), '');
    try {
      const r = await post('/start');
      assert.equal(r.status, 502);
      assert.match(r.fehler, /Irgendwas ging schief/);
    } finally { fs.rmSync(path.join(cfg, 'stumm')); }
  });

  test('Tokens der Rolle erreichen claude nicht', async () => {
    await post('/start');
    await post('/abbrechen');
    const keys = JSON.parse(fs.readFileSync(path.join(cfg, 'env.json'), 'utf8'));
    assert.ok(keys.includes('CLAUDE_CONFIG_DIR'));
    assert.ok(!keys.includes('HA_TOKEN') && !keys.includes('PAPERLESS_TOKEN') && !keys.includes('CLAUDE_CMD'), keys.join(','));
  });

  test('Unbekannte Pfade: 404', async () => {
    assert.equal((await fetch(base + '/etc/passwd')).status, 404);
    assert.equal((await post('/irgendwas')).status, 404);
  });
});
