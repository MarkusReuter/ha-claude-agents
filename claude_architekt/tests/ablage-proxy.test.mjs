// Ende-zu-Ende: derselbe ablage-Server wie beim Hausmeister (paket_hochladen) laedt ueber den
// GitHub-Proxy des Architekten hoch. Der Server kennt nur einen Platzhalter-Token; den echten
// ergaenzt der Proxy. Mock-GitHub (node:http) schreibt jede Anfrage mit. Ohne Abhaengigkeiten.
// Aufruf im Repo-Wurzelordner:  node --test claude_architekt/tests/*.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'rootfs', 'opt', 'agent-mcp', 'ablage.mjs');
const { createProxy } = await import(pathToFileURL(path.join(HERE, '..', 'rootfs', 'opt', 'github-proxy', 'proxy.mjs')).href);
const OWNER = 'MarkusReuter';
const REPO = `${OWNER}/private-data`;
const TOKEN = 'github_pat_echt0123456789';

let tmp, root, gh, proxy, requests, state, proc, call;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ablage-proxy-'));
  root = path.join(tmp, 'architekt');
  fs.mkdirSync(path.join(root, 'ausgang'), { recursive: true });
  fs.writeFileSync(path.join(root, 'ausgang', 'heizlast.md'), '# Heizlast\n');
  const alt = new Date(Date.now() - 40 * 86400000).toISOString();
  state = { nextId: 100, releases: [
    { id: 1, tag_name: 'paket-20260901-120000-alt', created_at: alt },
    { id: 3, tag_name: 'v1.0', created_at: alt },
  ], assets: {} };
  requests = [];

  gh = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, 'http://x');
      const p = url.pathname;
      requests.push({ method: req.method, path: p, auth: req.headers.authorization, body });
      const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(obj === undefined ? '' : JSON.stringify(obj)); };
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { message: 'Bad credentials' });
      if (req.method === 'GET' && p === `/repos/${REPO}`) return json(200, { full_name: REPO, private: true });
      if (req.method === 'GET' && p === `/repos/${REPO}/releases`) return json(200, state.releases);
      if (req.method === 'POST' && p === `/repos/${REPO}/releases`) {
        const b = JSON.parse(body);
        const r = { id: state.nextId++, tag_name: b.tag_name, name: b.name, body: b.body, created_at: new Date().toISOString(),
                    html_url: `https://github.com/${REPO}/releases/tag/${b.tag_name}` };
        state.releases.push(r);
        return json(201, r);
      }
      let m;
      if (req.method === 'POST' && (m = /^\/uploads\/repos\/[^/]+\/[^/]+\/releases\/(\d+)\/assets$/.exec(p))) {
        state.assets[url.searchParams.get('name')] = body;
        return json(201, { name: url.searchParams.get('name'), size: body.length, browser_download_url: `https://github.com/${REPO}/releases/download/x/${url.searchParams.get('name')}` });
      }
      if (req.method === 'DELETE' && (m = /^\/repos\/[^/]+\/[^/]+\/releases\/(\d+)$/.exec(p))) {
        state.releases = state.releases.filter((r) => r.id !== Number(m[1]));
        return json(204);
      }
      if (req.method === 'DELETE' && /^\/repos\/[^/]+\/[^/]+\/git\/refs\/tags\//.test(p)) return json(204);
      return json(404, { message: 'Not Found' });
    });
  });
  await new Promise((r) => gh.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${gh.address().port}`;
  proxy = createProxy({ owner: OWNER, prefix: 'claude/', austausch: 'private-data', token: TOKEN,
                        gitBase: base, apiBase: base, uploadBase: `${base}/uploads`, log: () => {} });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  const pu = `http://127.0.0.1:${proxy.address().port}`;

  proc = spawn(process.execPath, [SERVER], {
    env: { ABLAGE_ROOT: root, ABLAGE_QUELLEN: '.', ABLAGE_ZIEL: 'ausgang', ABLAGE_ROLLE: 'Architekten',
           ABLAGE_GITHUB_REPO: REPO, ABLAGE_GITHUB_TOKEN: 'ueber-proxy',
           ABLAGE_GITHUB_API: `${pu}/api`, ABLAGE_GITHUB_UPLOADS: `${pu}/uploads`, ABLAGE_HALTEN_TAGE: '30' },
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
  call = (name, args) => {
    const id = nextId++;
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
    return new Promise((resolve) => pending.set(id, (r) => resolve({ error: !!r.result.isError, text: r.result.content[0].text })));
  };
});

after(() => {
  proc?.kill();
  proxy?.close();
  gh?.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

test('paket_hochladen ueber den Proxy: gleiches Release-Format wie beim Hausmeister, echter Token nur beim Proxy', async () => {
  const r = await call('paket_hochladen', { titel: 'Heizlast EG', beschreibung: 'Berechnung', dateien: ['ausgang/heizlast.md'] });
  assert.equal(r.error, false, r.text);
  const neu = state.releases.find((x) => x.name === 'Heizlast EG');
  assert.match(neu.tag_name, /^paket-\d{8}-\d{6}-heizlast-eg$/);
  assert.match(neu.body, /Hochgeladen vom Architekten\. Wird nach 30 Tagen automatisch geloescht\./);
  assert.equal(state.assets['heizlast.md'].toString(), '# Heizlast\n');
  // 30-Tage-Aufraeumen: altes paket-* weg (Release und Tag), v1.0 bleibt
  assert.ok(!state.releases.some((x) => x.id === 1));
  assert.ok(state.releases.some((x) => x.tag_name === 'v1.0'));
  assert.ok(requests.some((q) => q.method === 'DELETE' && q.path.endsWith('/git/refs/tags/paket-20260901-120000-alt')));
  // Upstream sieht nur den echten Token, nie den Platzhalter
  assert.ok(requests.every((q) => q.auth === `Bearer ${TOKEN}`));
  assert.ok(!r.text.includes(TOKEN));
});
