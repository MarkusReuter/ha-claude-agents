// MCP-Server (stdio) fuer den Archivar: Paperless-ngx lesen, OCR-Inhalt und OCR-Tags aendern.
// Ohne Abhaengigkeiten (Node >= 22: fetch), damit er vollstaendig nachlesbar bleibt.
//
//   Lesen (ohne Rueckfrage): search_documents, list_documents_by_tag, get_document,
//                            download_original, find_suspicious_ocr
//   Aendern (nur mit PAPERLESS_WRITE=1, per Managed Settings IMMER mit Rueckfrage):
//     update_content – sichert den alten Inhalt zuerst als Notiz, dann PATCH nur {"content"}
//     set_ocr_tags   – setzt/entfernt nur die zwei OCR-Tags, PATCH nur {"tags"}, fremde Tags bleiben
//
// Sicherheitsgrenze: Jede Anfrage laeuft ueber request(), das nur die Kombinationen aus ROUTES
// kennt und die Bodies prueft (checkBody). Es gibt keine Loeschmethode, kein bulk_edit, keinen
// frei waehlbaren Pfad und keine Weiterleitungen (Token!). Der Token erscheint nie in Ausgaben.
// Dateien nur unter OCR_DIR (Originale zum Lesen); der Server raeumt sie selbst wieder weg.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const BASE = (process.env.PAPERLESS_URL || '').replace(/\/+$/, '');
const TOKEN = process.env.PAPERLESS_TOKEN || '';
// Schalter 'paperless_write' in der Add-on-Konfiguration (vom Supervisor, fuer den Agenten unerreichbar)
const WRITE_ENABLED = process.env.PAPERLESS_WRITE === '1';
const OCR_DIR = path.resolve(process.env.OCR_DIR || '/work/ocr');
const TAG_NEU = process.env.TAG_OCR_NEU || 'ocr-neu';
const TAG_CLAUDE = process.env.TAG_OCR_CLAUDE || 'ocr-claude';
const TZ = process.env.TZ || 'Europe/Berlin';
// Oeffentliche Paperless-Adresse nur fuer klickbare Links in den Antworten (wird nie angefragt)
const LINK_BASE = /^https?:\/\/[^\s"'<>()[\]]+$/.test(process.env.PAPERLESS_LINK_URL || '')
  ? process.env.PAPERLESS_LINK_URL.replace(/\/+$/, '') : '';
const TIMEOUT_MS = 60000;
const DOWNLOAD_TIMEOUT_MS = 180000;
const MAX_DOWNLOAD = 100 * 1024 * 1024;
const MAX_CONTENT = 60000;

// ---------------------------------------------------------------- Paperless-API
const ID = '[1-9][0-9]{0,9}';
const ROUTES = [
  ['GET', new RegExp(`^/api/documents/$`)],
  ['GET', new RegExp(`^/api/documents/${ID}/$`)],
  ['GET', new RegExp(`^/api/documents/${ID}/download/$`)],
  ['GET', /^\/api\/tags\/$/],
  ['GET', /^\/api\/correspondents\/$/],
  ['POST', new RegExp(`^/api/documents/${ID}/notes/$`)],
  ['POST', /^\/api\/tags\/$/],
  ['PATCH', new RegExp(`^/api/documents/${ID}/$`)],
];

function sameKeys(obj, keys) {
  const k = Object.keys(obj || {});
  return k.length === keys.length && keys.every((x) => k.includes(x));
}

// Zweite Sperre neben den Werkzeugen: was darf in einem Body stehen
function checkBody(method, p, body) {
  if (method === 'PATCH') {
    if (!(sameKeys(body, ['content']) && typeof body.content === 'string')
        && !(sameKeys(body, ['tags']) && Array.isArray(body.tags) && body.tags.every(Number.isInteger))) {
      throw new Error('PATCH darf nur {"content"} oder {"tags"} enthalten');
    }
  } else if (p.endsWith('/notes/')) {
    if (!sameKeys(body, ['note']) || typeof body.note !== 'string') throw new Error('Notiz: nur {"note"}');
  } else if (p === '/api/tags/') {
    if (![TAG_NEU, TAG_CLAUDE].includes(body?.name)) throw new Error('Es duerfen nur die beiden OCR-Tags angelegt werden');
  }
}

const redact = (s) => (TOKEN ? String(s).split(TOKEN).join('***') : String(s));

function httpError(status, text) {
  const hint = {
    401: 'Token ungueltig oder fehlt (Add-on-Option paperless_token)',
    403: 'keine Berechtigung fuer den Paperless-Benutzer des Archivars',
    404: 'nicht gefunden oder fuer den Archivar nicht sichtbar',
  }[status];
  const e = new Error(`HTTP ${status}${hint ? ` – ${hint}` : ''}: ${redact(text).slice(0, 300)}`);
  e.status = status;
  return e;
}

async function request(method, p, { query, body, binary = false, timeout = TIMEOUT_MS } = {}) {
  if (!ROUTES.some(([m, r]) => m === method && r.test(p))) throw new Error(`Nicht erlaubt: ${method} ${p}`);
  if (method !== 'GET') checkBody(method, p, body);
  const url = new URL(BASE + p);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  let res;
  try {
    res = await fetch(url, {
      method,
      redirect: 'error',
      headers: {
        Authorization: `Token ${TOKEN}`,
        Accept: binary ? '*/*' : 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
  } catch (e) {
    throw new Error(`Paperless nicht erreichbar (${e.cause?.code || e.name}) unter ${url.origin}`);
  }
  if (!res.ok) throw httpError(res.status, await res.text().catch(() => ''));
  if (binary) return res;
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}

// Alle Seiten einer Liste (Tags, Korrespondenten); Paperless liefert max. 100 je Seite
async function listAll(p, query = {}) {
  const out = [];
  for (let page = 1; page <= 50; page++) {
    const d = await request('GET', p, { query: { ...query, page, page_size: 100 } });
    out.push(...(d.results || []));
    if (!d.next) break;
  }
  return out;
}

let names = null;
async function lookups() {
  if (!names || Date.now() - names.at > 5 * 60000) {
    const [tags, corr] = await Promise.all([
      listAll('/api/tags/', { fields: 'id,name' }),
      listAll('/api/correspondents/', { fields: 'id,name' }),
    ]);
    names = { at: Date.now(), tags: new Map(tags.map((t) => [t.id, t.name])),
              corr: new Map(corr.map((c) => [c.id, c.name])) };
  }
  return names;
}

async function tagId(name, { create = false } = {}) {
  const d = await request('GET', '/api/tags/', { query: { name__iexact: name, fields: 'id,name' } });
  const hit = (d.results || []).find((t) => t.name.toLowerCase() === name.toLowerCase());
  if (hit) return hit.id;
  if (!create) return null;
  // Ohne Besitzer anlegen, damit alle Paperless-Benutzer den Tag sehen; keine automatische Zuordnung
  const t = await request('POST', '/api/tags/', {
    body: { name, matching_algorithm: 0, is_inbox_tag: false, owner: null },
  });
  names = null;
  return t.id;
}

// ---------------------------------------------------------------- Hilfen
function docId(v) {
  const s = String(v ?? '');
  if (!new RegExp(`^${ID}$`).test(s)) throw new Error('id muss eine positive ganze Zahl sein');
  return Number(s);
}

function dateArg(v, name) {
  if (v === undefined || v === null || v === '') return undefined;
  const s = String(v);
  const d = new Date(s + 'T00:00:00Z');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
    throw new Error(`${name} im Format JJJJ-MM-TT angeben`);
  }
  return d;
}

function limitArg(v, def, max) {
  const n = v === undefined ? def : Number(v);
  if (!Number.isInteger(n) || n < 1) throw new Error('limit muss eine positive ganze Zahl sein');
  return Math.min(n, max);
}

function now() {
  try { return new Date().toLocaleString('sv-SE', { timeZone: TZ }).slice(0, 16); }
  catch { return new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC'; }
}

function requireWrite() {
  if (!WRITE_ENABLED) {
    throw new Error('Schreibrecht ist aus (Add-on-Option paperless_write). Markus kann es in der Add-on-Konfiguration einschalten.');
  }
}

// Gemeinsame Filter fuer Suche, Tag-Liste und Pruefung
async function filterQuery({ query, date_from, date_to, tag, correspondent }) {
  const q = {};
  if (query) q.query = String(query);
  const from = dateArg(date_from, 'date_from');
  const to = dateArg(date_to, 'date_to');
  if (from) q.created__gte = from.toISOString().slice(0, 10);
  if (to) q.created__lt = new Date(to.getTime() + 86400000).toISOString().slice(0, 10);
  if (tag) {
    const id = await tagId(String(tag));
    if (!id) throw new Error(`Tag "${tag}" gibt es in Paperless nicht (oder er ist fuer den Archivar nicht sichtbar)`);
    q.tags__id__all = id;
  }
  if (correspondent) q.correspondent__name__icontains = String(correspondent);
  return q;
}

const link = (id) => (LINK_BASE ? `${LINK_BASE}/documents/${id}/details` : undefined);
const linkLine = (id) => (LINK_BASE ? `\nLink: ${link(id)}` : '');

function summary(d, n) {
  return {
    id: d.id,
    link: link(d.id),
    titel: d.title,
    datum: d.created ? String(d.created).slice(0, 10) : null,
    korrespondent: d.correspondent ? (n.corr.get(d.correspondent) ?? `#${d.correspondent}`) : null,
    tags: (d.tags || []).map((t) => n.tags.get(t) ?? `#${t}`),
    seiten: d.page_count ?? null,
  };
}

async function listDocs(filters, limit) {
  const q = {
    ...(await filterQuery(filters)),
    page_size: limit,
    truncate_content: 'true',
    fields: 'id,title,created,correspondent,tags,page_count,content',
  };
  if (!q.query) q.ordering = '-created';
  const [d, n] = await Promise.all([request('GET', '/api/documents/', { query: q }), lookups()]);
  const docs = (d.results || []).slice(0, limit).map((x) => ({
    ...summary(x, n),
    auszug: (x.content || '').replace(/\s+/g, ' ').trim().slice(0, 200),
  }));
  return JSON.stringify({ treffer_gesamt: d.count ?? docs.length, angezeigt: docs.length, dokumente: docs }, null, 1);
}

// ---------------------------------------------------------------- Dateien unter OCR_DIR
function ocrDir() {
  fs.mkdirSync(OCR_DIR, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(OCR_DIR).isSymbolicLink()) throw new Error(`${OCR_DIR} darf kein Symlink sein`);
  return OCR_DIR;
}

function clearOcrDir(onlyId) {
  const dir = ocrDir();
  for (const name of fs.readdirSync(dir)) {
    if (onlyId === undefined || name.startsWith(`${onlyId}.`)) {
      fs.rmSync(path.join(dir, name), { recursive: true, force: true }); // entfernt Symlinks, nicht ihr Ziel
    }
  }
}

// Formate, die Claude Code mit Read direkt lesen kann
const READABLE = {
  'application/pdf': { ext: 'pdf', ok: (b) => b.subarray(0, 1024).includes('%PDF-') },
  'image/jpeg': { ext: 'jpg', ok: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/png': { ext: 'png', ok: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  'image/gif': { ext: 'gif', ok: (b) => b.subarray(0, 4).toString('latin1') === 'GIF8' },
  'image/webp': { ext: 'webp', ok: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
};

// ---------------------------------------------------------------- Heuristik (ohne LLM)
// cp1252-Fehldeutung von UTF-8: ä→Ã¤, ö→Ã¶, ü→Ã¼, ß→ÃŸ, Ä→Ã„, Ö→Ã–, Ü→Ãœ, „→â€ž …
const MOJIBAKE = /Ã[\u0080-¿ŒœŠšŸŽžƒ–—‘-„†-•…‰‹›€™]|â€|Â[ -¿]/g;
const USUAL_MARKS = /[.,:;\-–/()%€$&+'"!?§@#*=]/g;

export function analyze(content, pages) {
  const text = content || '';
  const compact = text.replace(/\s+/g, '');
  const n = compact.length;
  if (n === 0) return { score: 100, gruende: ['leerer Inhalt'], zeichen: 0 };

  let score = 0;
  const gruende = [];
  const perPage = n / (pages > 0 ? pages : 1);
  if (perPage < 100) { score += 45; gruende.push(`sehr wenig Text: ${Math.round(perPage)} Zeichen pro Seite`); }
  else if (perPage < 300) { score += 20; gruende.push(`wenig Text: ${Math.round(perPage)} Zeichen pro Seite`); }

  const moji = text.match(MOJIBAKE) || [];
  if (moji.length) {
    score += Math.min(50, 20 + 5 * moji.length);
    gruende.push(`kaputte Umlaute (${moji.length}×, z. B. ${[...new Set(moji)].slice(0, 3).map((m) => `"${m}"`).join(', ')})`);
  }
  const repl = (text.match(/�/g) || []).length;
  if (repl) { score += Math.min(30, 10 + 2 * repl); gruende.push(`${repl}× Ersatzzeichen "�"`); }

  const letters = (compact.match(/\p{L}/gu) || []).length;
  const digits = (compact.match(/\p{N}/gu) || []).length;
  const marks = (compact.match(USUAL_MARKS) || []).length;
  const special = Math.max(0, n - letters - digits - marks) / n;
  if (special > 0.1) { score += 30; gruende.push(`${Math.round(special * 100)} % Sonderzeichen`); }
  else if (special > 0.05) { score += 15; gruende.push(`${Math.round(special * 100)} % Sonderzeichen`); }
  if (n >= 50 && letters / n < 0.4) { score += 15; gruende.push(`nur ${Math.round((letters / n) * 100)} % Buchstaben`); }

  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length >= 20) {
    const singles = tokens.filter((t) => /^\p{L}$/u.test(t)).length / tokens.length;
    if (singles > 0.15) { score += 30; gruende.push(`${Math.round(singles * 100)} % isolierte Einzelbuchstaben`); }
    else if (singles > 0.08) { score += 15; gruende.push(`${Math.round(singles * 100)} % isolierte Einzelbuchstaben`); }
  }
  return { score: Math.min(100, score), gruende, zeichen: n };
}

// ---------------------------------------------------------------- Werkzeuge
async function searchDocuments(a) {
  return listDocs(a, limitArg(a.limit, 25, 100));
}

async function listDocumentsByTag(a) {
  if (!a.tag) throw new Error('tag angeben');
  return listDocs({ tag: a.tag }, limitArg(a.limit, 25, 100));
}

async function getDocument(a) {
  const id = docId(a.id);
  const [d, n] = await Promise.all([request('GET', `/api/documents/${id}/`), lookups()]);
  const content = d.content || '';
  const info = {
    ...summary(d, n),
    dateiname: d.original_file_name ?? null,
    dateityp: d.mime_type ?? null,
    archiv_pdf: d.archived_file_name ? 'ja' : 'nein',
    notizen: Array.isArray(d.notes) ? d.notes.length : undefined,
  };
  const cut = content.length > MAX_CONTENT;
  return `${JSON.stringify(info, null, 1)}\n--- Inhalt (${content.length} Zeichen${cut ? `, gekuerzt auf ${MAX_CONTENT}` : ''}) ---\n`
    + (cut ? content.slice(0, MAX_CONTENT) : content);
}

async function downloadOriginal(a) {
  const id = docId(a.id);
  const d = await request('GET', `/api/documents/${id}/`);
  let type = READABLE[d.mime_type];
  let original = true;
  if (!type) {
    // z. B. TIFF, HEIC, Office: das Archiv-PDF von Paperless enthaelt die Seiten als PDF
    if (!d.archived_file_name) throw new Error(`Originalformat ${d.mime_type} kann nicht gelesen werden und es gibt kein Archiv-PDF`);
    type = READABLE['application/pdf'];
    original = false;
  }
  clearOcrDir(); // immer nur ein Dokument in der Ablage
  const res = await request('GET', `/api/documents/${id}/download/`, {
    query: original ? { original: 'true' } : {}, binary: true, timeout: DOWNLOAD_TIMEOUT_MS,
  });
  if (Number(res.headers.get('content-length') || 0) > MAX_DOWNLOAD) throw new Error('Datei groesser als 100 MB');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_DOWNLOAD) throw new Error('Datei groesser als 100 MB');
  if (!type.ok(buf)) throw new Error(`Heruntergeladene Datei ist kein gueltiges ${type.ext.toUpperCase()}`);
  const file = path.join(ocrDir(), `${id}.${type.ext}`);
  fs.writeFileSync(file, buf, { flag: 'wx', mode: 0o600 });
  const pages = d.page_count ?? null;
  return [
    `Gespeichert: ${file}`,
    `Dokument ${id} "${d.title}", ${original ? `Original (${d.mime_type})` : `Archiv-PDF, da Original ${d.mime_type}`}, `
      + `${pages ?? '?'} Seite(n), ${(buf.length / 1024).toFixed(0)} KB.`,
    ...(LINK_BASE ? [`Link: ${link(id)}`] : []),
    type.ext === 'pdf'
      ? 'Mit Read lesen; bei mehr als 20 Seiten abschnittsweise (pages: "1-20", "21-40", ...).'
      : 'Mit Read lesen (Bild).',
  ].join('\n');
}

async function updateContent(a) {
  requireWrite();
  const id = docId(a.id);
  if (typeof a.text !== 'string' || !a.text.trim()) throw new Error('text darf nicht leer sein');
  const d = await request('GET', `/api/documents/${id}/`);
  const old = d.content ?? '';
  if (old === a.text) return `Dokument ${id}: Inhalt ist bereits identisch – nichts geaendert.${linkLine(id)}`;

  const note = `Inhalt vor Claude-OCR (${now()})\n\n${old.trim() ? old : '(leer)'}`;
  try {
    await request('POST', `/api/documents/${id}/notes/`, { body: { note } });
  } catch (e) {
    throw new Error(`Notiz mit altem Inhalt konnte nicht angelegt werden – Inhalt NICHT geaendert. ${e.message}`);
  }
  let r;
  try {
    r = await request('PATCH', `/api/documents/${id}/`, { body: { content: a.text } });
  } catch (e) {
    throw new Error(`Inhalt NICHT geaendert (die Notiz mit dem alten Inhalt wurde angelegt). ${e.message}`);
  }
  clearOcrDir(id);
  const check = r?.content === a.text ? '' : '\nWARNUNG: Paperless meldet einen abweichenden Inhalt – bitte mit get_document pruefen.';
  return `Dokument ${id} "${d.title}": Inhalt ersetzt (${old.length} → ${a.text.length} Zeichen). `
    + `Alter Inhalt als Notiz gesichert. Heruntergeladene Datei geloescht.${check}${linkLine(id)}`;
}

const ACTIONS = {
  neu_setzen: { add: [TAG_NEU], remove: [] },
  neu_entfernen: { add: [], remove: [TAG_NEU] },
  claude_setzen: { add: [TAG_CLAUDE], remove: [] },
  claude_entfernen: { add: [], remove: [TAG_CLAUDE] },
  erledigt: { add: [TAG_CLAUDE], remove: [TAG_NEU] },
};

async function setOcrTags(a) {
  requireWrite();
  const id = docId(a.id);
  const act = ACTIONS[a.action];
  if (!act) throw new Error(`action muss eines von ${Object.keys(ACTIONS).join(', ')} sein`);
  const add = [];
  for (const name of act.add) add.push(await tagId(name, { create: true }));
  const remove = [];
  for (const name of act.remove) { const t = await tagId(name); if (t) remove.push(t); }

  const d = await request('GET', `/api/documents/${id}/`);
  const current = d.tags || [];
  const next = current.filter((t) => !remove.includes(t));
  for (const t of add) if (!next.includes(t)) next.push(t);
  if (next.length === current.length && next.every((t) => current.includes(t))) {
    return `Dokument ${id}: OCR-Tags bereits wie gewuenscht – nichts geaendert.${linkLine(id)}`;
  }
  const r = await request('PATCH', `/api/documents/${id}/`, { body: { tags: next } });
  const kept = current.filter((t) => !remove.includes(t));
  const lost = kept.filter((t) => !(r?.tags || next).includes(t));
  return `Dokument ${id} "${d.title}": ${[...act.remove.map((t) => `-${t}`), ...act.add.map((t) => `+${t}`)].join(' ')}.`
    + (lost.length ? `\nWARNUNG: Paperless meldet fehlende Tags ${lost.join(', ')} – bitte pruefen.` : '')
    + linkLine(id);
}

async function findSuspiciousOcr(a) {
  const limit = limitArg(a.limit, 20, 100);
  const maxScan = limitArg(a.max_scan, 1000, 5000);
  const minScore = a.min_score === undefined ? 25 : Number(a.min_score);
  const q = {
    ...(await filterQuery({ tag: a.tag, date_from: a.date_from, date_to: a.date_to })),
    ordering: '-created',
    fields: 'id,title,created,tags,page_count,content',
  };
  const skip = [await tagId(TAG_NEU), await tagId(TAG_CLAUDE)].filter(Boolean);
  const hits = [];
  let scanned = 0;
  let skipped = 0;
  let total = null;
  for (let page = 1; scanned < maxScan; page++) {
    const d = await request('GET', '/api/documents/', { query: { ...q, page, page_size: 100 } });
    total = d.count ?? total;
    for (const x of d.results || []) {
      if (scanned >= maxScan) break;
      scanned++;
      if ((x.tags || []).some((t) => skip.includes(t))) { skipped++; continue; }
      const r = analyze(x.content, x.page_count);
      if (r.score >= minScore) {
        hits.push({ id: x.id, link: link(x.id), titel: x.title, datum: x.created ? String(x.created).slice(0, 10) : null,
                    seiten: x.page_count ?? null, zeichen: r.zeichen, score: r.score, gruende: r.gruende });
      }
    }
    if (!d.next) break;
  }
  hits.sort((x, y) => y.score - x.score || x.id - y.id);
  return JSON.stringify({
    geprueft: scanned,
    dokumente_gesamt: total,
    uebersprungen_mit_ocr_tag: skipped,
    kandidaten_gesamt: hits.length,
    kandidaten: hits.slice(0, limit),
  }, null, 1);
}

const FILTER_PROPS = {
  date_from: { type: 'string', description: 'Ausstellungsdatum ab (JJJJ-MM-TT, einschliesslich)' },
  date_to: { type: 'string', description: 'Ausstellungsdatum bis (JJJJ-MM-TT, einschliesslich)' },
  tag: { type: 'string', description: 'Nur Dokumente mit diesem Tag (exakter Name)' },
};
const ID_PROP = { id: { type: 'integer', description: 'Paperless-Dokument-ID' } };

const TOOLS = [
  {
    name: 'search_documents',
    description: 'Dokumente in Paperless suchen (Volltext und Filter). Liefert ID, Titel, Datum, Korrespondent, Tags, Seiten und einen kurzen Auszug. Aendert nichts.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Volltextsuche (Paperless-Syntax), z. B. "Stromrechnung" oder "rechnung 2024"' },
        ...FILTER_PROPS,
        correspondent: { type: 'string', description: 'Korrespondent (Teil des Namens genuegt)' },
        limit: { type: 'integer', description: 'Max. Treffer, Standard 25, hoechstens 100' },
      },
    },
  },
  {
    name: 'list_documents_by_tag',
    description: 'Dokumente mit einem bestimmten Tag auflisten (neueste zuerst). Aendert nichts.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['tag'],
      properties: {
        tag: { type: 'string', description: `Tag-Name, z. B. "${TAG_NEU}"` },
        limit: { type: 'integer', description: 'Max. Treffer, Standard 25, hoechstens 100' },
      },
    },
  },
  {
    name: 'get_document',
    description: 'Ein Dokument lesen: Titel, Tags, Korrespondent, Datum, Seitenzahl, Dateityp und den aktuellen Inhalt (OCR-Text). Aendert nichts.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['id'], properties: ID_PROP },
  },
  {
    name: 'download_original',
    description: `Original eines Dokuments nach ${OCR_DIR}/<id>.<pdf|jpg|png|gif|webp> laden, um es mit Read zu lesen. `
      + `Ist das Original nicht lesbar (z. B. TIFF), wird das Archiv-PDF geladen. Leert vorher ${OCR_DIR}. Aendert nichts in Paperless.`,
    inputSchema: { type: 'object', additionalProperties: false, required: ['id'], properties: ID_PROP },
  },
  {
    name: 'update_content',
    description: 'Inhalt (OCR-Text) eines Dokuments ersetzen. Sichert zuerst den bisherigen Inhalt als Notiz '
      + '"Inhalt vor Claude-OCR" am Dokument, aendert dann ausschliesslich das Feld content. '
      + `Loescht danach die heruntergeladene Datei in ${OCR_DIR}.`,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'text'],
      properties: { ...ID_PROP, text: { type: 'string', description: 'Vollstaendiger neuer Inhalt (woertliche Transkription)' } },
    },
  },
  {
    name: 'set_ocr_tags',
    description: `Nur die OCR-Tags "${TAG_NEU}" und "${TAG_CLAUDE}" setzen oder entfernen; alle anderen Tags bleiben. `
      + `Aktionen: neu_setzen (+${TAG_NEU}), neu_entfernen (-${TAG_NEU}), claude_setzen (+${TAG_CLAUDE}), `
      + `claude_entfernen (-${TAG_CLAUDE}), erledigt (-${TAG_NEU} +${TAG_CLAUDE}). Fehlende OCR-Tags werden angelegt.`,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'action'],
      properties: { ...ID_PROP, action: { type: 'string', enum: Object.keys(ACTIONS) } },
    },
  },
  {
    name: 'find_suspicious_ocr',
    description: 'Dokumente mit vermutlich schlechter OCR finden (Heuristik ohne KI): leerer Inhalt, wenig Text je Seite, '
      + 'kaputte Umlaute (z. B. "Ã¤"), viele Sonderzeichen oder isolierte Einzelbuchstaben. '
      + `Dokumente mit "${TAG_NEU}" oder "${TAG_CLAUDE}" werden uebersprungen. Liefert Kandidaten mit Score (0–100) und Begruendung. Aendert nichts.`,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'integer', description: 'Max. Kandidaten, Standard 20, hoechstens 100' },
        ...FILTER_PROPS,
        min_score: { type: 'number', description: 'Mindest-Score, Standard 25' },
        max_scan: { type: 'integer', description: 'Max. gepruefte Dokumente (neueste zuerst), Standard 1000, hoechstens 5000' },
      },
    },
  },
];

const HANDLERS = {
  search_documents: searchDocuments,
  list_documents_by_tag: listDocumentsByTag,
  get_document: getDocument,
  download_original: downloadOriginal,
  update_content: updateContent,
  set_ocr_tags: setOcrTags,
  find_suspicious_ocr: findSuspiciousOcr,
};

// ---------------------------------------------------------------- MCP (JSON-RPC ueber stdio)
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

async function handle(msg) {
  switch (msg.method) {
    case 'initialize':
      return { protocolVersion: msg.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} },
               serverInfo: { name: 'archivar-paperless', version: '0.1.0' } };
    case 'ping': return {};
    case 'tools/list': return { tools: TOOLS };
    case 'tools/call': {
      const { name, arguments: args = {} } = msg.params || {};
      try {
        const fn = Object.hasOwn(HANDLERS, name) ? HANDLERS[name] : null;
        if (!fn) throw new Error(`Unbekanntes Werkzeug ${name}`);
        if (!BASE || !TOKEN) throw new Error('PAPERLESS_URL/PAPERLESS_TOKEN fehlen (Add-on-Optionen paperless_url, paperless_token)');
        return { content: [{ type: 'text', text: redact(await fn(args)) }] };
      } catch (e) {
        return { content: [{ type: 'text', text: 'Fehler: ' + redact(e.message) }], isError: true };
      }
    }
    default: {
      const err = new Error(`Methode ${msg.method} nicht unterstuetzt`); err.code = -32601; throw err;
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Bei geschlossenem stdin erst beenden, wenn laufende Anfragen beantwortet sind
  let open = 0;
  let closed = false;
  const maybeExit = () => { if (closed && open === 0) process.exit(0); };
  readline.createInterface({ input: process.stdin }).on('line', async (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id === undefined) return; // Notification
    open++;
    try { send({ jsonrpc: '2.0', id: msg.id, result: await handle(msg) }); }
    catch (e) { send({ jsonrpc: '2.0', id: msg.id, error: { code: e.code || -32603, message: redact(e.message) } }); }
    finally { open--; maybeExit(); }
  }).on('close', () => { closed = true; maybeExit(); });
}
