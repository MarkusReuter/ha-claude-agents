// Tests fuer paket_hochladen (Release-Anhaenge in einem privaten GitHub-Repo) gegen einen
// Mock-GitHub (node:http), der jede Anfrage mitschreibt. Ohne Abhaengigkeiten.
// Aufruf im Repo-Wurzelordner:  node --test claude_hausmeister/tests/*.test.mjs
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'rootfs', 'opt', 'agent-mcp', 'ablage.mjs');
const TOKEN = 'github_pat_geheim0123456789';
const REPO = 'markus/ablage';

let tmp, root, gh, base, requests, state;
const servers = [];

function fresh() {
  const alt = new Date(Date.now() - 40 * 86400000).toISOString();
  const neu = new Date().toISOString();
  return {
    private: true, empty: false, failAsset: false, nextId: 100,
    releases: [
      { id: 1, tag_name: 'paket-alt', created_at: alt },
      { id: 2, tag_name: 'paket-neu', created_at: neu },
      { id: 3, tag_name: 'v1.0', created_at: alt },
    ],
    assets: {},
  };
}

function startServer(env) {
  const proc = spawn(process.execPath, [SERVER], {
    env: { ABLAGE_ROOT: root, ABLAGE_QUELLEN: 'ha ausgang', ABLAGE_ZIEL: 'ausgang', ABLAGE_ROLLE: 'Hausmeister',
           ABLAGE_GITHUB_API: base, ABLAGE_GITHUB_UPLOADS: base + '/uploads', ...env },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  let buf = ''; let nextId = 1; const pending = new Map();
  proc.stdout.on('data', (d) => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      pending.get(msg.id)?.(msg); pending.delete(msg.id);
    }
  });
  const rpc = (method, params) => {
    const id = nextId++;
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return new Promise((resolve) => pending.set(id, resolve));
  };
  servers.push(proc);
  return async (args) => {
    const r = await rpc('tools/call', { name: 'paket_hochladen', arguments: args });
    return { error: !!r.result.isError, text: r.result.content[0].text };
  };
}

let upload;
const put = (rel, data) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); };

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ablage-gh-'));
  root = path.join(tmp, 'hausmeister');
  put('ausgang/pakete/ww-teil1von2.zip', Buffer.from('PK\x03\x04eins'));
  put('ausgang/pakete/ww-teil2von2.zip', Buffer.from('PK\x03\x04zwei'));
  put('ausgang/bericht.md', '# Bericht\n');
  put('CLAUDE.md', 'Rolle');
  fs.writeFileSync(path.join(tmp, 'geheim.txt'), 'GEHEIM');
  fs.symlinkSync(path.join(tmp, 'geheim.txt'), path.join(root, 'ausgang', 'link.txt'));

  gh = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, 'http://x');
      requests.push({ method: req.method, path: url.pathname, query: url.search, auth: req.headers.authorization,
                      type: req.headers['content-type'], body });
      const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      const p = url.pathname;
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { message: 'Bad credentials' });
      if (req.method === 'GET' && p === `/repos/${REPO}`) return json(200, { full_name: REPO, private: state.private });
      if (req.method === 'GET' && p === `/repos/${REPO}/releases`) return json(200, state.releases);
      if (req.method === 'POST' && p === `/repos/${REPO}/releases`) {
        if (state.empty) return json(422, { message: 'Validation Failed', errors: [{ message: 'Repository is empty.' }] });
        const b = JSON.parse(body);
        const r = { id: state.nextId++, tag_name: b.tag_name, name: b.name, body: b.body, created_at: new Date().toISOString(),
                    html_url: `https://github.com/${REPO}/releases/tag/${b.tag_name}` };
        state.releases.push(r);
        return json(201, r);
      }
      let m;
      if (req.method === 'DELETE' && (m = p.match(new RegExp(`^/repos/${REPO}/releases/(\\d+)$`)))) {
        state.releases = state.releases.filter((r) => r.id !== Number(m[1]));
        res.writeHead(204); return res.end();
      }
      if (req.method === 'DELETE' && p.startsWith(`/repos/${REPO}/git/refs/tags/`)) { res.writeHead(204); return res.end(); }
      if (req.method === 'POST' && (m = p.match(new RegExp(`^/uploads/repos/${REPO}/releases/(\\d+)/assets$`)))) {
        if (state.failAsset && Object.keys(state.assets).length) return json(500, { message: `kaputt ${TOKEN}` });
        const name = url.searchParams.get('name');
        state.assets[name] = body;
        return json(201, { name, size: body.length, browser_download_url: `https://github.com/${REPO}/releases/download/x/${name}` });
      }
      json(404, { message: 'Not Found' });
    });
  });
  await new Promise((r) => gh.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${gh.address().port}`;
  upload = startServer({ ABLAGE_GITHUB_REPO: REPO, ABLAGE_GITHUB_TOKEN: TOKEN });
});
after(() => { servers.forEach((p) => p.kill()); gh.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
beforeEach(() => { requests = []; state = fresh(); });

describe('paket_hochladen', () => {
  test('Release mit allen Teilen als Anhang, Link zurueck, alte paket-Releases geloescht', async () => {
    const r = await upload({ dateien: ['ausgang/pakete/ww-teil1von2.zip', 'ausgang/pakete/ww-teil2von2.zip'],
                             titel: 'Warmwasser 19.10.', beschreibung: 'Temperaturen von heute' });
    assert.equal(r.error, false, r.text);
    assert.match(r.text, /https:\/\/github\.com\/markus\/ablage\/releases\/tag\/paket-\d{8}-\d{6}-warmwasser-19-10/);
    assert.match(r.text, /\[ww-teil1von2\.zip\]\(https:\/\/github\.com\/.*\)/);
    assert.deepEqual(state.assets['ww-teil2von2.zip'], Buffer.from('PK\x03\x04zwei'));
    assert.ok(requests.every((q) => q.auth === `Bearer ${TOKEN}`));
    const up = requests.find((q) => q.path.endsWith('/assets'));
    assert.equal(up.type, 'application/zip');
    // Aufraeumen: nur paket-* und nur alte
    const tags = state.releases.map((x) => x.tag_name);
    assert.ok(!tags.includes('paket-alt'));
    assert.ok(tags.includes('paket-neu') && tags.includes('v1.0'));
    assert.match(r.text, /Aufgeraeumt .*paket-alt/);
    const neu = state.releases.find((x) => x.name === 'Warmwasser 19.10.');
    assert.match(neu.body, /Temperaturen von heute[\s\S]*nach 30 Tagen/);
    assert.doesNotMatch(r.text, new RegExp(TOKEN));
  });

  test('einzelne Datei ausserhalb von pakete/ ist erlaubt', async () => {
    const r = await upload({ dateien: ['ausgang/bericht.md'], titel: 'Bericht' });
    assert.equal(r.error, false, r.text);
    assert.equal(requests.find((q) => q.path.endsWith('/assets')).type, 'text/markdown');
  });

  test('oeffentliches Repo: verweigert, nichts angelegt', async () => {
    state.private = false;
    const r = await upload({ dateien: ['ausgang/bericht.md'], titel: 'x' });
    assert.equal(r.error, true);
    assert.match(r.text, /nicht privat/);
    assert.ok(!requests.some((q) => q.method !== 'GET'), 'kein Schreibzugriff');
  });

  test('leeres Repo: verstaendlicher Hinweis', async () => {
    state.empty = true;
    const r = await upload({ dateien: ['ausgang/bericht.md'], titel: 'x' });
    assert.equal(r.error, true);
    assert.match(r.text, /README/);
  });

  test('Anhang scheitert: Release und Tag wieder geloescht, Token nicht in der Meldung', async () => {
    state.failAsset = true;
    const r = await upload({ dateien: ['ausgang/pakete/ww-teil1von2.zip', 'ausgang/pakete/ww-teil2von2.zip'], titel: 'kaputt' });
    assert.equal(r.error, true);
    assert.match(r.text, /abgebrochen/);
    assert.doesNotMatch(r.text, new RegExp(TOKEN));
    assert.ok(!state.releases.some((x) => x.name === 'kaputt'));
    assert.ok(requests.some((q) => q.method === 'DELETE' && q.path.includes('/git/refs/tags/paket-')));
  });

  for (const [label, args, re] of [
    ['ausserhalb der Quellen', { dateien: ['CLAUDE.md'], titel: 'x' }, /nur Dateien unter/],
    ['..', { dateien: ['ausgang/../../geheim.txt'], titel: 'x' }, /'\.\.'/],
    ['Symlink', { dateien: ['ausgang/link.txt'], titel: 'x' }, /Symlinks/],
    ['Ordner', { dateien: ['ausgang/pakete'], titel: 'x' }, /keine Datei/],
    ['ohne Titel', { dateien: ['ausgang/bericht.md'] }, /titel/],
    ['doppelter Name', { dateien: ['ausgang/bericht.md', 'ausgang/bericht.md'], titel: 'x' }, /doppelt/],
  ]) {
    test(`Grenze: ${label}`, async () => {
      const r = await upload(args);
      assert.equal(r.error, true, r.text);
      assert.match(r.text, re);
      assert.doesNotMatch(r.text, /GEHEIM/);
      assert.equal(requests.length, 0, 'keine Anfrage an GitHub');
    });
  }

  test('falscher Token: Fehlermeldung ohne Token', async () => {
    const bad = startServer({ ABLAGE_GITHUB_REPO: REPO, ABLAGE_GITHUB_TOKEN: 'github_pat_falsch999' });
    const r = await bad({ dateien: ['ausgang/bericht.md'], titel: 'x' });
    assert.equal(r.error, true);
    assert.match(r.text, /401/);
    assert.doesNotMatch(r.text, /github_pat_falsch999/);
  });
});
