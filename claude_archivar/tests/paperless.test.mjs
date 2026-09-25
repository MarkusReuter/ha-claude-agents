// Tests fuer den Paperless-MCP-Server des Archivars (ohne Abhaengigkeiten).
// Aufruf im Repo-Wurzelordner:  node --test claude_archivar/tests/
// Der Server laeuft als echter Kindprozess ueber stdio gegen einen Mock-Paperless (node:http),
// der jede Anfrage mitschreibt.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'rootfs', 'opt', 'agent-mcp', 'paperless.mjs');
const TOKEN = 'geheim-0123456789abcdef';

const PDF = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n');
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const TIFF = Buffer.from([0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0]);

// ---------------------------------------------------------------- Mock-Paperless
let state;
let requests = [];

function freshState() {
  return {
    failNotes: false,
    echoAuthOn404: false,
    tags: [
      { id: 1, name: 'Rechnung' }, { id: 2, name: 'Strom' },
      { id: 10, name: 'ocr-neu' }, { id: 11, name: 'ocr-claude' },
    ],
    correspondents: [{ id: 5, name: 'Stadtwerke Musterstadt' }],
    notes: {},
    docs: {
      1234: { id: 1234, title: 'Stromrechnung Januar', created: '2024-02-01', correspondent: 5,
              tags: [1, 2, 10], page_count: 2, mime_type: 'application/pdf',
              original_file_name: 'strom.pdf', archived_file_name: '1234.pdf',
              content: 'Stromrechnung\nBetrag: 12,34 EUR', notes: [], file: PDF, archive: PDF },
      2000: { id: 2000, title: 'Foto Quittung', created: '2024-03-05', correspondent: null,
              tags: [1], page_count: 1, mime_type: 'image/jpeg', original_file_name: 'q.jpg',
              archived_file_name: '2000.pdf', content: 'Quittung', notes: [], file: JPG, archive: PDF },
      3000: { id: 3000, title: 'Scan TIFF', created: '2023-11-11', correspondent: null,
              tags: [], page_count: 1, mime_type: 'image/tiff', original_file_name: 's.tif',
              archived_file_name: '3000.pdf', content: '', notes: [], file: TIFF, archive: PDF },
      4000: { id: 4000, title: 'Kaputte Umlaute', created: '2024-05-01', correspondent: null,
              tags: [], page_count: 1, mime_type: 'application/pdf', archived_file_name: null,
              content: 'GrÃ¼ÃŸe aus MÃ¼nchen, die GebÃ¼hr fÃ¼r die PrÃ¼fung betrÃ¤gt 12 EUR. '.repeat(8),
              notes: [], file: PDF },
      5000: { id: 5000, title: 'Sauberer Brief', created: '2024-06-01', correspondent: null,
              tags: [], page_count: 1, mime_type: 'application/pdf', archived_file_name: null,
              content: 'Sehr geehrte Damen und Herren, hiermit bestaetigen wir den Eingang Ihrer Zahlung. '.repeat(10),
              notes: [], file: PDF },
    },
  };
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}
const pub = (d) => Object.fromEntries(Object.entries(d).filter(([k]) => !['file', 'archive'].includes(k)));

const mock = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const url = new URL(req.url, 'http://x');
    const body = raw ? JSON.parse(raw) : undefined;
    requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body,
                    auth: req.headers.authorization });
    if (req.headers.authorization !== `Token ${TOKEN}`) return json(res, 401, { detail: 'Invalid token.' });
    const p = url.pathname;
    let m;
    if (req.method === 'GET' && p === '/api/tags/') {
      const n = url.searchParams.get('name__iexact');
      const r = state.tags.filter((t) => !n || t.name.toLowerCase() === n.toLowerCase());
      return json(res, 200, { count: r.length, next: null, results: r });
    }
    if (req.method === 'POST' && p === '/api/tags/') {
      const t = { id: 100 + state.tags.length, name: body.name, owner: body.owner };
      state.tags.push(t);
      return json(res, 201, t);
    }
    if (req.method === 'GET' && p === '/api/correspondents/') {
      return json(res, 200, { count: state.correspondents.length, next: null, results: state.correspondents });
    }
    if (req.method === 'GET' && p === '/api/documents/') {
      let r = Object.values(state.docs);
      const t = url.searchParams.get('tags__id__all');
      if (t) r = r.filter((d) => d.tags.includes(Number(t)));
      const page = Number(url.searchParams.get('page') || 1);
      if (page > 1) r = [];
      return json(res, 200, { count: r.length, next: null, results: r.map(pub) });
    }
    if ((m = p.match(/^\/api\/documents\/(\d+)\/$/))) {
      const d = state.docs[m[1]];
      if (!d) {
        return json(res, 404, { detail: state.echoAuthOn404 ? `Nicht gefunden (${req.headers.authorization})` : 'Nicht gefunden.' });
      }
      if (req.method === 'GET') return json(res, 200, pub(d));
      if (req.method === 'PATCH') { Object.assign(d, body); return json(res, 200, pub(d)); }
    }
    if (req.method === 'GET' && (m = p.match(/^\/api\/documents\/(\d+)\/download\/$/))) {
      const d = state.docs[m[1]];
      const buf = url.searchParams.get('original') === 'true' ? d.file : d.archive;
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': buf.length });
      return res.end(buf);
    }
    if (req.method === 'POST' && (m = p.match(/^\/api\/documents\/(\d+)\/notes\/$/))) {
      if (state.failNotes) return json(res, 403, { detail: 'Keine Berechtigung.' });
      (state.notes[m[1]] ||= []).push(body.note);
      return json(res, 200, state.notes[m[1]].map((note, i) => ({ id: i + 1, note })));
    }
    json(res, 405, { detail: 'Methode nicht erlaubt' });
  });
});

// ---------------------------------------------------------------- MCP-Client
class Client {
  constructor(env) {
    this.proc = spawn(process.execPath, [SERVER], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    this.pending = new Map();
    this.next = 1;
    this.stderr = '';
    let buf = '';
    this.proc.stdout.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        const msg = JSON.parse(line);
        this.pending.get(msg.id)?.(msg);
        this.pending.delete(msg.id);
      }
    });
    this.proc.stderr.on('data', (c) => { this.stderr += c; });
  }
  rpc(method, params) {
    const id = this.next++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  async call(name, args) {
    const r = await this.rpc('tools/call', { name, arguments: args });
    return { text: r.result.content[0].text, isError: !!r.result.isError };
  }
  close() { this.proc.stdin.end(); this.proc.kill(); }
}

let baseUrl;
let ocrDir;
let client;      // Schreibrecht an
let readOnly;    // Schreibrecht aus

before(async () => {
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${mock.address().port}`;
  ocrDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archivar-ocr-'));
  const env = { PAPERLESS_URL: baseUrl, PAPERLESS_TOKEN: TOKEN, OCR_DIR: ocrDir, TZ: 'Europe/Berlin' };
  client = new Client({ ...env, PAPERLESS_WRITE: '1', PAPERLESS_LINK_URL: 'https://paperless.example.org/' });
  readOnly = new Client({ ...env, PAPERLESS_WRITE: '0' });
  await client.rpc('initialize', {});
  await readOnly.rpc('initialize', {});
});

after(() => {
  client.close();
  readOnly.close();
  mock.close();
  fs.rmSync(ocrDir, { recursive: true, force: true });
  // Ueber alle Tests: keine einzige Loeschanfrage und kein bulk_edit
  assert.equal(allRequests.filter((r) => r.method === 'DELETE').length, 0);
  assert.equal(allRequests.filter((r) => r.path.includes('bulk_edit')).length, 0);
});

const allRequests = [];
beforeEach(() => {
  allRequests.push(...requests);
  requests = [];
  state = freshState();
});
const writes = () => requests.filter((r) => r.method !== 'GET');

// ---------------------------------------------------------------- Tests
describe('Werkzeugliste und Quelltext', () => {
  test('genau die sieben vorgesehenen Werkzeuge', async () => {
    const r = await client.rpc('tools/list', {});
    assert.deepEqual(r.result.tools.map((t) => t.name).sort(), [
      'download_original', 'find_suspicious_ocr', 'get_document', 'list_documents_by_tag',
      'search_documents', 'set_ocr_tags', 'update_content',
    ]);
  });

  test('kein Werkzeug und kein Code sendet DELETE oder bulk_edit', () => {
    // Code ohne Kommentarzeilen und Zeilenend-Kommentare
    const src = fs.readFileSync(SERVER, 'utf8').split('\n')
      .filter((l) => !l.trim().startsWith('//')).map((l) => l.replace(/\s\/\/ .*$/, '')).join('\n');
    assert.doesNotMatch(src, /delete/i);
    assert.doesNotMatch(src, /bulk_edit/i);
    // Nur diese HTTP-Methoden kommen ueberhaupt vor
    const methods = [...src.matchAll(/\['(GET|POST|PUT|PATCH|[A-Z]+)',/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(methods)].sort(), ['GET', 'PATCH', 'POST']);
  });

  test('unbekanntes Werkzeug wird abgelehnt', async () => {
    const r = await client.call('api_request', { method: 'DELETE', path: '/api/documents/1234/' });
    assert.ok(r.isError);
    assert.equal(requests.length, 0);
  });
});

describe('update_content', () => {
  test('legt zuerst die Notiz an und sendet dann nur das Feld content', async () => {
    fs.writeFileSync(path.join(ocrDir, '1234.pdf'), PDF);
    const r = await client.call('update_content', { id: 1234, text: 'Neuer Text\n--- Seite 2 ---\nMehr', title: 'boese' });
    assert.ok(!r.isError, r.text);
    const w = writes();
    assert.equal(w.length, 2);
    assert.equal(w[0].method, 'POST');
    assert.equal(w[0].path, '/api/documents/1234/notes/');
    assert.deepEqual(Object.keys(w[0].body), ['note']);
    assert.match(w[0].body.note, /^Inhalt vor Claude-OCR \(\d{4}-\d{2}-\d{2} \d{2}:\d{2}\)/);
    assert.ok(w[0].body.note.includes('Stromrechnung\nBetrag: 12,34 EUR'));
    assert.equal(w[1].method, 'PATCH');
    assert.equal(w[1].path, '/api/documents/1234/');
    assert.deepEqual(w[1].body, { content: 'Neuer Text\n--- Seite 2 ---\nMehr' });
    assert.equal(state.docs[1234].title, 'Stromrechnung Januar');
    assert.ok(!fs.existsSync(path.join(ocrDir, '1234.pdf')), 'heruntergeladene Datei geloescht');
  });

  test('schlaegt die Notiz fehl, wird der Inhalt nicht geaendert', async () => {
    state.failNotes = true;
    const r = await client.call('update_content', { id: 1234, text: 'Neu' });
    assert.ok(r.isError);
    assert.match(r.text, /NICHT geaendert/);
    assert.equal(requests.filter((x) => x.method === 'PATCH').length, 0);
    assert.equal(state.docs[1234].content, 'Stromrechnung\nBetrag: 12,34 EUR');
  });

  test('leerer alter Inhalt wird als "(leer)" gesichert', async () => {
    await client.call('update_content', { id: 3000, text: 'Text' });
    assert.match(state.notes[3000][0], /\n\n\(leer\)$/);
  });

  test('ohne Schreibrecht: Fehler und keine Anfrage', async () => {
    const r = await readOnly.call('update_content', { id: 1234, text: 'Neu' });
    assert.ok(r.isError);
    assert.match(r.text, /paperless_write/);
    assert.equal(requests.length, 0);
  });

  test('ungueltige id wird abgelehnt', async () => {
    for (const id of ['1234/../1', -1, 0, '12a', 1.5]) {
      const r = await client.call('update_content', { id, text: 'x' });
      assert.ok(r.isError, String(id));
    }
    assert.equal(requests.length, 0);
  });
});

describe('set_ocr_tags', () => {
  test('erledigt: entfernt ocr-neu, setzt ocr-claude, fremde Tags bleiben', async () => {
    const r = await client.call('set_ocr_tags', { id: 1234, action: 'erledigt' });
    assert.ok(!r.isError, r.text);
    const w = writes();
    assert.equal(w.length, 1);
    assert.equal(w[0].method, 'PATCH');
    assert.deepEqual(Object.keys(w[0].body), ['tags']);
    assert.deepEqual(w[0].body.tags.sort((a, b) => a - b), [1, 2, 11]);
  });

  test('neu_setzen laesst vorhandene Tags unangetastet', async () => {
    await client.call('set_ocr_tags', { id: 2000, action: 'neu_setzen' });
    assert.deepEqual(state.docs[2000].tags, [1, 10]);
  });

  test('fehlender OCR-Tag wird ohne Besitzer angelegt', async () => {
    state.tags = state.tags.filter((t) => t.name !== 'ocr-claude');
    await client.call('set_ocr_tags', { id: 2000, action: 'claude_setzen' });
    const post = writes().find((x) => x.path === '/api/tags/');
    assert.deepEqual(post.body, { name: 'ocr-claude', matching_algorithm: 0, is_inbox_tag: false, owner: null });
    const created = state.tags.find((t) => t.name === 'ocr-claude');
    assert.deepEqual(state.docs[2000].tags, [1, created.id]);
  });

  test('keine Aenderung noetig: kein PATCH', async () => {
    const r = await client.call('set_ocr_tags', { id: 5000, action: 'neu_entfernen' });
    assert.match(r.text, /nichts geaendert/);
    assert.equal(writes().length, 0);
  });

  test('unbekannte Aktion wird abgelehnt', async () => {
    const r = await client.call('set_ocr_tags', { id: 1234, action: 'alle_entfernen' });
    assert.ok(r.isError);
    assert.equal(writes().length, 0);
  });

  test('ohne Schreibrecht: Fehler und keine Anfrage', async () => {
    const r = await readOnly.call('set_ocr_tags', { id: 1234, action: 'erledigt' });
    assert.ok(r.isError);
    assert.equal(requests.length, 0);
  });
});

describe('download_original', () => {
  test('PDF landet als <id>.pdf, alte Dateien werden entfernt', async () => {
    fs.writeFileSync(path.join(ocrDir, '999.pdf'), PDF);
    const r = await client.call('download_original', { id: 1234 });
    assert.ok(!r.isError, r.text);
    assert.deepEqual(fs.readdirSync(ocrDir), ['1234.pdf']);
    const dl = requests.find((x) => x.path.endsWith('/download/'));
    assert.equal(dl.query.original, 'true');
  });

  test('JPG-Original landet als <id>.jpg', async () => {
    await client.call('download_original', { id: 2000 });
    assert.deepEqual(fs.readdirSync(ocrDir), ['2000.jpg']);
  });

  test('TIFF: stattdessen das Archiv-PDF', async () => {
    const r = await client.call('download_original', { id: 3000 });
    assert.ok(!r.isError, r.text);
    assert.deepEqual(fs.readdirSync(ocrDir), ['3000.pdf']);
    const dl = requests.find((x) => x.path.endsWith('/download/'));
    assert.equal(dl.query.original, undefined);
    assert.match(r.text, /Archiv-PDF/);
  });

  test('Inhalt passt nicht zum Typ: Fehler', async () => {
    state.docs[1234].file = Buffer.from('<html>kein pdf</html>');
    const r = await client.call('download_original', { id: 1234 });
    assert.ok(r.isError);
    assert.deepEqual(fs.readdirSync(ocrDir), []);
  });

  test('aendert nichts in Paperless', async () => {
    await client.call('download_original', { id: 1234 });
    assert.equal(writes().length, 0);
  });
});

describe('Lesen', () => {
  test('get_document liefert Metadaten mit Namen und Inhalt', async () => {
    const r = await client.call('get_document', { id: 1234 });
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /"korrespondent": "Stadtwerke Musterstadt"/);
    assert.match(r.text, /"Rechnung"/);
    assert.match(r.text, /"seiten": 2/);
    assert.match(r.text, /Betrag: 12,34 EUR/);
  });

  test('search_documents setzt die Filter', async () => {
    const r = await client.call('search_documents', {
      query: 'strom', date_from: '2024-01-01', date_to: '2024-12-31', tag: 'Strom', correspondent: 'Stadtwerke', limit: 5,
    });
    assert.ok(!r.isError, r.text);
    const q = requests.find((x) => x.path === '/api/documents/').query;
    assert.equal(q.query, 'strom');
    assert.equal(q.created__gte, '2024-01-01');
    assert.equal(q.created__lt, '2025-01-01');
    assert.equal(q.tags__id__all, '2');
    assert.equal(q.correspondent__name__icontains, 'Stadtwerke');
    assert.equal(q.page_size, '5');
    assert.match(r.text, /Stromrechnung Januar/);
  });

  test('search_documents: ungueltiges Datum wird abgelehnt', async () => {
    const r = await client.call('search_documents', { date_from: '2024-02-30' });
    assert.ok(r.isError);
  });

  test('list_documents_by_tag', async () => {
    const r = await client.call('list_documents_by_tag', { tag: 'ocr-neu', limit: 10 });
    const data = JSON.parse(r.text);
    assert.deepEqual(data.dokumente.map((d) => d.id), [1234]);
  });
});

describe('find_suspicious_ocr', () => {
  test('findet leere und kaputte Inhalte, ueberspringt OCR-Tags, aendert nichts', async () => {
    const r = await client.call('find_suspicious_ocr', { limit: 10 });
    assert.ok(!r.isError, r.text);
    const data = JSON.parse(r.text);
    const ids = data.kandidaten.map((k) => k.id);
    assert.ok(ids.includes(3000), 'leerer Inhalt');
    assert.ok(ids.includes(4000), 'kaputte Umlaute');
    assert.ok(!ids.includes(5000), 'sauberer Text');
    assert.ok(!ids.includes(1234), 'hat ocr-neu');
    assert.equal(data.uebersprungen_mit_ocr_tag, 1);
    assert.match(data.kandidaten.find((k) => k.id === 4000).gruende.join(' '), /kaputte Umlaute/);
    assert.equal(writes().length, 0);
  });
});

describe('Links (paperless_link_url)', () => {
  const L = 'https://paperless.example.org/api/documents/1234/preview/';
  test('Lesewerkzeuge liefern den Link zum Dokument', async () => {
    assert.match((await client.call('get_document', { id: 1234 })).text, new RegExp(`"link": "${L}"`));
    const s = JSON.parse((await client.call('search_documents', { query: 'strom' })).text);
    assert.equal(s.dokumente.find((d) => d.id === 1234).link, L);
    const f = JSON.parse((await client.call('find_suspicious_ocr', {})).text);
    assert.equal(f.kandidaten.find((k) => k.id === 4000).link, 'https://paperless.example.org/api/documents/4000/preview/');
    assert.match((await client.call('download_original', { id: 1234 })).text, new RegExp(`Link: ${L}`));
  });

  test('Aenderungen nennen den Link', async () => {
    assert.match((await client.call('update_content', { id: 1234, text: 'Neu' })).text, new RegExp(`Link: ${L}$`));
    assert.match((await client.call('set_ocr_tags', { id: 1234, action: 'erledigt' })).text, new RegExp(`Link: ${L}$`));
  });

  test('ohne Option keine Links', async () => {
    const r = await readOnly.call('get_document', { id: 1234 });
    assert.doesNotMatch(r.text, /"link"|example\.org/);
  });

  test('die Link-Adresse wird nie angefragt', async () => {
    await client.call('get_document', { id: 1234 });
    assert.ok(requests.every((x) => !x.path.includes('example.org')));
  });
});

describe('Token', () => {
  test('wird mit jeder Anfrage gesendet, erscheint aber nie in Ausgaben', async () => {
    state.echoAuthOn404 = true;
    const r = await client.call('get_document', { id: 777 });
    assert.ok(r.isError);
    assert.ok(!r.text.includes(TOKEN), r.text);
    assert.match(r.text, /\*\*\*/);
    assert.ok(requests.every((x) => x.auth === `Token ${TOKEN}`));
    assert.ok(!client.stderr.includes(TOKEN));
  });
});

describe('Heuristik analyze()', async () => {
  const { analyze } = await import(pathToFileURL(SERVER).href);
  test('leerer Inhalt = 100', () => assert.equal(analyze('   ', 3).score, 100));
  test('sauberer Text ist unauffaellig', () => {
    assert.equal(analyze('Dies ist ein ganz normaler Brief mit genug Text. '.repeat(20), 1).score, 0);
  });
  test('wenig Text pro Seite', () => assert.ok(analyze('Rechnung 12,34', 5).score >= 25));
  test('Mojibake', () => assert.ok(analyze('Ã¤ Ã¶ Ã¼ ÃŸ Ã„ Ã– Ãœ '.repeat(30), 1).gruende.some((g) => g.includes('Umlaute'))));
  test('isolierte Einzelzeichen', () => {
    const r = analyze('R e c h n u n g Betrag a b c d e f g h i j k l m n o p q r s t '.repeat(10), 1);
    assert.ok(r.gruende.some((g) => g.includes('Einzelbuchstaben')));
  });
  test('Sonderzeichen', () => {
    assert.ok(analyze('~~|| ^^ ¦¦ ¬¬ ‰‰ Text ¤¤ '.repeat(30), 1).gruende.some((g) => g.includes('Sonderzeichen')));
  });
});
