// Tests fuer den Gemini-Weg des Proxys und das Werkzeug gemini-bild (ohne Abhaengigkeiten).
// Mock-Gemini (node:http) prueft den API-Key und liefert ein Bild als inlineData.
// Aufruf im Repo-Wurzelordner:  node --test claude_architekt/tests/*.test.mjs
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { createProxy, geminiRoute } = await import(pathToFileURL(path.join(HERE, '..', 'rootfs', 'opt', 'github-proxy', 'proxy.mjs')).href);
const TOOL = path.join(HERE, '..', 'rootfs', 'usr', 'local', 'bin', 'gemini-bild');
const KEY = 'AIzaGeheim0123456789';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

describe('geminiRoute', () => {
  test('alle Gemini-Pfade erlaubt, nur POST (ausser countTokens) kostet', () => {
    assert.deepEqual(geminiRoute('GET', '/v1beta/models'), { kostet: false });
    assert.deepEqual(geminiRoute('POST', '/v1beta/models/gemini-3.1-flash-image:generateContent'), { kostet: true });
    assert.deepEqual(geminiRoute('POST', '/v1beta/models/veo-3.1-generate-preview:predictLongRunning'), { kostet: true });
    assert.deepEqual(geminiRoute('GET', '/v1beta/models/veo-3.1-generate-preview/operations/abc'), { kostet: false });
    assert.deepEqual(geminiRoute('POST', '/v1beta/interactions'), { kostet: true });
    assert.deepEqual(geminiRoute('POST', '/upload/v1beta/files'), { kostet: true });
    assert.deepEqual(geminiRoute('GET', '/download/v1beta/files/x:download'), { kostet: false });
    assert.deepEqual(geminiRoute('POST', '/v1beta/models/gemini-2.5-flash:countTokens'), { kostet: false });
  });
  test('nur Gemini-API-Pfade', () => {
    assert.equal(geminiRoute('GET', '/'), null);
    assert.equal(geminiRoute('GET', '/v1beta/../x'), null);
    assert.equal(geminiRoute('GET', '/irgendwas'), null);
  });
});

describe('Proxy + gemini-bild', () => {
  let tmp, up, proxy, pu, seen, logs;
  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-'));
    seen = []; logs = [];
    up = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        seen.push({ method: req.method, url: req.url, key: req.headers['x-goog-api-key'], body });
        if (req.headers['x-goog-api-key'] !== KEY) { res.writeHead(400); return res.end('{"error":{"message":"API key not valid"}}'); }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ candidates: [{ content: { parts: [
          { text: 'Hier ist der Entwurf.' },
          { inlineData: { mimeType: 'image/png', data: PNG.toString('base64') } },
        ] }, finishReason: 'STOP' }] }));
      });
    });
    await new Promise((r) => up.listen(0, '127.0.0.1', r));
    proxy = createProxy({ owner: 'MarkusReuter', prefix: 'claude/', austausch: '', token: 'gh', geminiKey: KEY,
                          geminiMaxPerDay: 2, geminiBase: `http://127.0.0.1:${up.address().port}`, log: (...a) => logs.push(a.join(' ')) });
    await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
    pu = `http://127.0.0.1:${proxy.address().port}`;
  });
  after(() => { proxy?.close(); up?.close(); if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

  const tool = (args) => new Promise((resolve) => {
    const p = spawn(process.execPath, [TOOL, ...args], { env: { GITHUB_PROXY: pu, GEMINI_MODELL: 'gemini-2.5-flash-image', PATH: process.env.PATH } });
    let stdout = '', stderr = '';
    p.stdout.on('data', (c) => { stdout += c; });
    p.stderr.on('data', (c) => { stderr += c; });
    p.on('close', (status) => resolve({ status, stdout, stderr }));
  });

  test('gemini-bild: Foto + Beschreibung -> PNG im Zielordner, Key nur beim Upstream', async () => {
    const foto = path.join(tmp, 'wohnzimmer.jpg');
    fs.writeFileSync(foto, Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
    const r = await tool(['-a', '16:9', '-o', path.join(tmp, 'bilder'), '-i', foto, 'Wohnzimmer skandinavisch, helles Eichenparkett']);
    assert.equal(r.status, 0, r.stderr);
    const file = r.stdout.split('\n').find((l) => l.endsWith('.png'));
    assert.ok(file && fs.readFileSync(file).equals(PNG));
    assert.match(r.stdout, /Text von Gemini: Hier ist der Entwurf\./);
    const req = JSON.parse(seen.at(-1).body);
    assert.equal(seen.at(-1).url, '/v1beta/models/gemini-2.5-flash-image:generateContent');
    assert.equal(seen.at(-1).key, KEY);
    assert.deepEqual(req.generationConfig, { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '16:9' } });
    assert.equal(req.contents[0].parts[1].inline_data.mime_type, 'image/jpeg');
  });

  test('Tageslimit: danach 429 ohne Upstream-Kontakt; Modellliste zaehlt nicht', async () => {
    assert.equal((await fetch(`${pu}/gemini/v1beta/models`)).status, 200);
    const zwei = await tool(['-o', path.join(tmp, 'bilder'), 'Kueche']);
    assert.equal(zwei.status, 0, zwei.stderr);
    const n = seen.length;
    const drei = await tool(['-o', path.join(tmp, 'bilder'), 'Bad']);
    assert.equal(drei.status, 1);
    assert.match(drei.stderr, /429.*Tageslimit/);
    assert.equal(seen.length, n);
  });

  test('eigener ?key= des Agenten wird entfernt, Key in keiner Antwort und keinem Log', async () => {
    const r1 = await fetch(`${pu}/gemini/v1beta/models?key=falsch&pageSize=5`);
    assert.equal(r1.status, 200);
    assert.equal(seen.at(-1).url, '/v1beta/models?pageSize=5');
    assert.equal(seen.at(-1).key, KEY);
    assert.ok(!(await r1.text()).includes(KEY));
    assert.ok(!logs.join('\n').includes(KEY));
  });
});
