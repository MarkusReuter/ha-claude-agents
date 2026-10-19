// Tests fuer den Ablage-MCP-Server (Pakete fuer SendUserFile), ohne Abhaengigkeiten.
// Aufruf im Repo-Wurzelordner:  node --test claude_hausmeister/tests/*.test.mjs
// Der Server laeuft als echter Kindprozess ueber stdio gegen einen temporaeren Arbeitsordner.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'rootfs', 'opt', 'agent-mcp', 'ablage.mjs');

let tmp, root, proc, buf = '', nextId = 1;
const pending = new Map();

function rpc(method, params) {
  const id = nextId++;
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return new Promise((resolve) => pending.set(id, resolve));
}
async function call(args) {
  const r = await rpc('tools/call', { name: 'paket_erstellen', arguments: args });
  return { error: !!r.result.isError, text: r.result.content[0].text };
}
const filesIn = (text) => [...text.matchAll(/^- (\S+) \(/gm)].map((m) => m[1]);
const put = (rel, data) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); };

// Minimaler ZIP-Leser ueber das zentrale Verzeichnis
function unzip(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const n = buf.readUInt16LE(end + 10);
  let off = buf.readUInt32LE(end + 16);
  const out = {};
  for (let i = 0; i < n; i++) {
    const method = buf.readUInt16LE(off + 10), crc = buf.readUInt32LE(off + 16);
    const csize = buf.readUInt32LE(off + 20), nlen = buf.readUInt16LE(off + 28), local = buf.readUInt32LE(off + 42);
    const name = buf.subarray(off + 46, off + 46 + nlen).toString('utf8');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + csize);
    const data = method === 8 ? zlib.inflateRawSync(raw) : raw;
    assert.equal(zlib.crc32(data), crc, `CRC ${name}`);
    out[name] = data;
    off += 46 + nlen + buf.readUInt16LE(off + 30) + buf.readUInt16LE(off + 32);
  }
  return out;
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ablage-'));
  root = path.join(tmp, 'hausmeister');
  put('ha/abruf/states.json', JSON.stringify({ a: 1, text: 'Grüße ``` mit Zaun' }, null, 2));
  put('ha/backup/dashboard-x.json', '{"views":[]}\n');
  put('ausgang/bericht.md', '# Bericht\n\nAlles gut.\n');
  put('ha/bild.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1]));
  put('CLAUDE.md', 'Rolle');
  fs.mkdirSync(path.join(tmp, 'claude'));
  fs.writeFileSync(path.join(tmp, 'claude', '.credentials.json'), 'GEHEIM');
  fs.symlinkSync(path.join(tmp, 'claude', '.credentials.json'), path.join(root, 'ha', 'login.json'));
  fs.symlinkSync(path.join(tmp, 'claude'), path.join(root, 'ha', 'loginordner'));

  proc = spawn(process.execPath, [SERVER], {
    env: { ABLAGE_ROOT: root, ABLAGE_QUELLEN: 'ha ausgang', ABLAGE_ZIEL: 'ausgang', ABLAGE_ROLLE: 'Hausmeister', ABLAGE_MAX_MB: '25' },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  proc.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      pending.get(msg.id)?.(msg); pending.delete(msg.id);
    }
  });
  await rpc('initialize', {});
});
after(() => { proc.kill(); fs.rmSync(tmp, { recursive: true, force: true }); });

describe('Werkzeugliste', () => {
  test('genau ein Werkzeug paket_erstellen', async () => {
    const r = await rpc('tools/list', {});
    assert.deepEqual(r.result.tools.map((t) => t.name), ['paket_erstellen']);
  });
});

describe('Markdown-Paket', () => {
  test('eine Datei mit allen Textdateien, Binaerdatei uebergangen, Symlinks ignoriert', async () => {
    const r = await call({ dateien: ['ha', 'ausgang/bericht.md'], name: 'diagnose', format: 'md', einleitung: 'Fehlerbild: X' });
    assert.equal(r.error, false, r.text);
    const files = filesIn(r.text);
    assert.equal(files.length, 1);
    assert.match(files[0], /ausgang\/pakete\/diagnose-\d{8}-\d{4}\.md$/);
    const md = fs.readFileSync(files[0], 'utf8');
    assert.match(md, /^# Paket diagnose – Teil 1 von 1/);
    assert.match(md, /Fehlerbild: X/);
    assert.match(md, /## ha\/abruf\/states\.json/);
    assert.match(md, /## ha\/backup\/dashboard-x\.json/);
    assert.match(md, /## ausgang\/bericht\.md/);
    assert.match(md, /````json\n/, 'Zaun laenger als ``` im Inhalt');
    assert.match(md, /Grüße/);
    assert.match(r.text, /Nicht enthalten.*ha\/bild\.png/);
    assert.doesNotMatch(md, /GEHEIM/);
    assert.equal(fs.statSync(files[0]).mode & 0o777, 0o600);
  });

  test('aufgeteilt nach max_mb, grosse Datei in Abschnitten, Inhalt vollstaendig', async () => {
    const lines = Array.from({ length: 4000 }, (_, i) => `Zeile ${i} ${'x'.repeat(40)}\n`).join('');
    put('ha/gross.log', lines);
    put('ha/klein1.txt', 'eins\n');
    const r = await call({ dateien: ['ha/gross.log', 'ha/klein1.txt'], name: 'gross', format: 'md', max_mb: 0.05 });
    assert.equal(r.error, false, r.text);
    const files = filesIn(r.text);
    assert.ok(files.length >= 4, `mehrere Teile: ${files.length}`);
    files.forEach((f, i) => {
      assert.match(f, new RegExp(`-teil${i + 1}von${files.length}\\.md$`));
      assert.ok(fs.statSync(f).size <= 0.05 * 1048576, `Teil ${i + 1} zu gross`);
    });
    // Abschnitte wieder zusammensetzen
    let joined = '';
    for (const f of files) {
      for (const m of fs.readFileSync(f, 'utf8').matchAll(/## ha\/gross\.log – Abschnitt \d+ von \d+ .*\n\n(`{3,})\n([\s\S]*?)\n?\1\n/g)) joined += m[2];
    }
    assert.equal(joined.replace(/\n/g, ''), lines.replace(/\n/g, ''));
    const first = fs.readFileSync(files[0], 'utf8');
    assert.match(first, /- ha\/gross\.log \(.*\) – Teil 1 bis \d+/);
  });

  test('sehr lange Zeile ohne Umbruch wird nach Zeichen geteilt', async () => {
    put('ha/einzeilig.json', JSON.stringify({ d: 'ä'.repeat(80000) }));
    const r = await call({ dateien: ['ha/einzeilig.json'], name: 'zeile', format: 'md', max_mb: 0.05 });
    assert.equal(r.error, false, r.text);
    for (const f of filesIn(r.text)) assert.ok(fs.statSync(f).size <= 0.05 * 1048576);
  });

  test('Platzhalter', async () => {
    const r = await call({ dateien: ['ha/**/*.json'], name: 'glob', format: 'md' });
    const md = fs.readFileSync(filesIn(r.text)[0], 'utf8');
    assert.match(md, /## ha\/abruf\/states\.json/);
    assert.doesNotMatch(md, /## ausgang\/bericht\.md/);
  });

  test('eigene Pakete werden nicht wieder eingepackt', async () => {
    const r = await call({ dateien: ['ausgang'], name: 'nochmal', format: 'md' });
    const md = fs.readFileSync(filesIn(r.text)[0], 'utf8');
    assert.doesNotMatch(md, /## ausgang\/pakete\//);
  });
});

describe('ZIP-Paket', () => {
  test('nur eine Datei: nicht gepackt, Pfad zum direkten Schicken', async () => {
    const r = await call({ dateien: ['ausgang/bericht.md'], name: 'einzeln' });
    assert.equal(r.error, false, r.text);
    assert.match(r.text, /kein Paket noetig/);
    assert.deepEqual(filesIn(r.text), [path.join(root, 'ausgang', 'bericht.md')]);
    assert.ok(!fs.readdirSync(path.join(root, 'ausgang', 'pakete')).some((f) => f.startsWith('einzeln-')));
  });

  test('Standard ist ein einzelnes ZIP mit allen Dateien', async () => {
    const r = await call({ dateien: ['ha/abruf', 'ausgang/bericht.md'], name: 'standard' });
    assert.equal(r.error, false, r.text);
    const files = filesIn(r.text);
    assert.equal(files.length, 1);
    assert.match(files[0], /standard-\d{8}-\d{4}\.zip$/);
    assert.deepEqual(Object.keys(unzip(fs.readFileSync(files[0]))).sort(),
      ['LIESMICH.md', 'ausgang/bericht.md', 'ha/abruf/states.json']);
  });

  test('gueltiges ZIP mit Binaerdatei und LIESMICH', async () => {
    const r = await call({ dateien: ['ha/abruf', 'ha/bild.png'], name: 'zip', format: 'zip' });
    assert.equal(r.error, false, r.text);
    const files = filesIn(r.text);
    assert.equal(files.length, 1);
    const z = unzip(fs.readFileSync(files[0]));
    assert.deepEqual(Object.keys(z).sort(), ['LIESMICH.md', 'ha/abruf/states.json', 'ha/bild.png']);
    assert.deepEqual(z['ha/bild.png'], fs.readFileSync(path.join(root, 'ha/bild.png')));
    assert.match(z['LIESMICH.md'].toString(), /Teil 1 von 1/);
  });

  test('mehrere eigenstaendige ZIPs nach max_mb', async () => {
    const rnd = (n) => crypto.randomBytes(n); // nicht packbar
    for (let i = 0; i < 4; i++) put(`ha/z/daten${i}.bin`, rnd(20000 + i));
    const r = await call({ dateien: ['ha/z'], name: 'zipteile', format: 'zip', max_mb: 0.05 });
    assert.equal(r.error, false, r.text);
    const files = filesIn(r.text);
    assert.ok(files.length >= 2);
    const all = files.flatMap((f) => { assert.ok(fs.statSync(f).size <= 0.05 * 1048576); return Object.keys(unzip(fs.readFileSync(f))); });
    assert.equal(all.filter((n) => n.startsWith('ha/z/')).length, 4);
  });

  test('einzelne Datei groesser als max_mb: in Stuecke geteilt, wieder zusammensetzbar', async () => {
    const big = crypto.randomBytes(120000);
    put('ha/riesig.bin', big);
    const r = await call({ dateien: ['ha/riesig.bin'], name: 'x', max_mb: 0.05 });
    assert.equal(r.error, false, r.text);
    const files = filesIn(r.text);
    assert.ok(files.length >= 3);
    const pieces = {};
    for (const f of files) {
      assert.ok(fs.statSync(f).size <= 0.05 * 1048576, `${f} zu gross`);
      const z = unzip(fs.readFileSync(f));
      assert.match(z['LIESMICH.md'].toString(), /aneinanderhaengen/);
      for (const [n, d] of Object.entries(z)) if (n !== 'LIESMICH.md') pieces[n] = d;
    }
    const names = Object.keys(pieces).sort();
    assert.ok(names.every((n) => /^ha\/riesig\.bin\.stueck\d{3}$/.test(n)), names.join());
    assert.deepEqual(Buffer.concat(names.map((n) => pieces[n])), big);
  });
});

describe('Grenzen', () => {
  for (const [label, args, re] of [
    ['ausserhalb der Quellen', { dateien: ['CLAUDE.md'] }, /nur Dateien unter/],
    ['absoluter Pfad ausserhalb', { dateien: ['/etc/passwd'] }, /'\.\.' ist nicht erlaubt|nur Dateien unter/],
    ['..', { dateien: ['ha/../../claude/.credentials.json'] }, /'\.\.' ist nicht erlaubt/],
    ['Symlink auf Datei', { dateien: ['ha/login.json'] }, /Symlinks sind nicht erlaubt/],
    ['Symlink auf Ordner', { dateien: ['ha/loginordner'] }, /Symlinks sind nicht erlaubt/],
    ['Symlink-Ordner per Platzhalter', { dateien: ['ha/loginordner/*'] }, /keine passenden Dateien/],
    ['Name mit Pfad', { dateien: ['ha'], name: '../x' }, /name:/],
    ['max_mb zu gross', { dateien: ['ha'], max_mb: 100 }, /max_mb/],
    ['falsches Format', { dateien: ['ha'], format: 'tar' }, /format/],
    ['nichts angegeben', {}, /dateien/],
  ]) {
    test(label, async () => {
      const r = await call(args);
      assert.equal(r.error, true, r.text);
      assert.match(r.text, re);
      assert.doesNotMatch(r.text, /GEHEIM/);
    });
  }

  test('Quelltext: kein Netz, kein Kindprozess', () => {
    const src = fs.readFileSync(SERVER, 'utf8');
    assert.doesNotMatch(src, /fetch\(|WebSocket|node:(http|https|net|dgram|child_process)/);
  });
});
