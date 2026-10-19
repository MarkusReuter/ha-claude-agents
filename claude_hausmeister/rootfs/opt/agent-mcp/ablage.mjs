// MCP-Server (stdio): Dateien aus dem Arbeitsordner zu einem Paket fuer Markus zusammenfassen und
// auf Wunsch in ein privates GitHub-Repo hochladen. Ohne Abhaengigkeiten. Rollenneutral – Quellen,
// Ziel und Repo kommen aus der Umgebung.
//
//   paket_erstellen – packt Dateien zu einem ZIP (Standard) oder auf Wunsch einer Markdown-Datei
//                     und teilt das Ergebnis in mehrere Teile, wenn es groesser als max_mb wird.
//                     Die Teile landen unter ABLAGE_ZIEL/pakete/. Kein Netz.
//   paket_hochladen – laedt Dateien als Anhaenge eines Releases in EIN festes GitHub-Repo
//                     (ABLAGE_GITHUB_REPO) – ohne Commit, also ohne Git-Historie. Nur wenn das Repo
//                     privat ist. Releases mit Tag paket-* werden nach ABLAGE_HALTEN_TAGE geloescht.
//                     Per Managed Settings immer mit Rueckfrage; ohne Repo/Token verboten.
//                     Einziger Netzzugriff des Servers (ghRequest), nur zu GH_API/GH_UPLOADS.
//
// Der Server laeuft als 'agent' und koennte technisch alles lesen, was der Agent-Nutzer lesen darf
// (z. B. den Claude-Login). Deshalb nur regulaere Dateien unter ABLAGE_QUELLEN, keine Symlinks,
// Pruefung auf dem echten Pfad (realpath).
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import zlib from 'node:zlib';

const ROOT = path.resolve(process.env.ABLAGE_ROOT || '/data/hausmeister');
const SOURCES = (process.env.ABLAGE_QUELLEN || 'ha ausgang').split(/\s+/).filter(Boolean)
  .map((s) => path.resolve(ROOT, s));
const TARGET = path.resolve(ROOT, process.env.ABLAGE_ZIEL || 'ausgang', 'pakete');
const ROLE = process.env.ABLAGE_ROLLE || 'Agent';
const MAX_MB = Number(process.env.ABLAGE_MAX_MB || 25);
const DEFAULT_MB = Math.min(10, MAX_MB);
const MAX_INPUT = 500 * 1024 * 1024;
const MAX_FILES = 5000;
// GitHub (nur fuer paket_hochladen). API-Adressen nur fuer Tests ueberschreibbar (managed-mcp.json setzt sie nicht).
const GH_REPO = process.env.ABLAGE_GITHUB_REPO || '';
const GH_TOKEN = process.env.ABLAGE_GITHUB_TOKEN || '';
const GH_API = (process.env.ABLAGE_GITHUB_API || 'https://api.github.com').replace(/\/$/, '');
const GH_UPLOADS = (process.env.ABLAGE_GITHUB_UPLOADS || 'https://uploads.github.com').replace(/\/$/, '');
const KEEP_DAYS = Number(process.env.ABLAGE_HALTEN_TAGE || 30);
const TAG_PREFIX = 'paket-';
const UPLOAD_MAX = 100 * 1024 * 1024;
const UPLOAD_MAX_FILES = 20;

const bytes = (s) => Buffer.byteLength(s, 'utf8');
const kb = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
const inside = (p, dir) => p === dir || p.startsWith(dir + path.sep);

// ---------------------------------------------------------------- Dateien sammeln
function globRegex(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') { re += '.*'; i++; if (pattern[i + 1] === '/') i++; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, e.name);
    if (inside(p, TARGET)) continue; // eigene Pakete nicht wieder einpacken
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p); // Symlinks, Geraete usw. werden uebergangen
    if (out.length > MAX_FILES) throw new Error(`Mehr als ${MAX_FILES} Dateien – Auswahl eingrenzen`);
  }
}

function collect(entries) {
  if (!Array.isArray(entries) || !entries.length) throw new Error('dateien: mindestens einen Pfad angeben');
  const realSources = SOURCES.filter((s) => fs.existsSync(s)).map((s) => fs.realpathSync(s));
  const allowed = (p) => SOURCES.some((s) => inside(p, s)) && !inside(p, TARGET);
  const found = new Set();
  for (const raw of entries) {
    if (typeof raw !== 'string' || !raw.trim()) throw new Error('dateien: nur Pfade als Text');
    const rel = path.isAbsolute(raw) ? path.relative(ROOT, raw) : raw;
    if (rel.split(/[\\/]/).includes('..')) throw new Error(`${raw}: '..' ist nicht erlaubt`);
    const wild = rel.search(/[*?]/);
    let hits = [];
    if (wild >= 0) {
      const base = path.resolve(ROOT, rel.slice(0, wild).replace(/[^/]*$/, ''));
      const re = globRegex(path.resolve(ROOT, rel));
      const isBaseOk = SOURCES.some((s) => inside(base, s) || inside(s, base));
      if (isBaseOk && fs.existsSync(base) && fs.lstatSync(base).isDirectory()) {
        const all = []; walk(base, all); hits = all.filter((p) => re.test(p) && allowed(p));
      }
      if (!hits.length) throw new Error(`${raw}: keine passenden Dateien`);
    } else {
      const p = path.resolve(ROOT, rel);
      if (!allowed(p)) throw new Error(`${raw}: nur Dateien unter ${SOURCES.map((s) => path.relative(ROOT, s) + '/').join(', ')}`);
      if (!fs.existsSync(p)) throw new Error(`${raw}: nicht gefunden`);
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) throw new Error(`${raw}: Symlinks sind nicht erlaubt`);
      if (st.isDirectory()) walk(p, hits); else if (st.isFile()) hits = [p];
    }
    for (const p of hits) {
      const real = fs.realpathSync(p);
      if (!realSources.some((s) => inside(real, s))) throw new Error(`${raw}: liegt ausserhalb der erlaubten Ordner`);
      found.add(p);
    }
  }
  let total = 0;
  const files = [...found].sort().map((p) => {
    const data = fs.readFileSync(p);
    total += data.length;
    if (total > MAX_INPUT) throw new Error(`Zusammen mehr als ${kb(MAX_INPUT)} – Auswahl eingrenzen`);
    return { rel: path.relative(ROOT, p).split(path.sep).join('/'), data };
  });
  if (!files.length) throw new Error('Keine Dateien gefunden');
  return files;
}

function asText(buf) {
  if (buf.includes(0)) return null;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return null; }
}

// ---------------------------------------------------------------- Markdown-Paket
const LANG = { json: 'json', yaml: 'yaml', yml: 'yaml', md: 'markdown', csv: 'csv', js: 'javascript',
               mjs: 'javascript', sh: 'bash', py: 'python', xml: 'xml', html: 'html', jinja: 'jinja' };
const fenceFor = (text) => '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)));

function partHeader(name, k, n, created) {
  return `# Paket ${name} – Teil ${k} von ${n}\n\n`
    + `Erstellt ${created} vom ${ROLE}. Die Dateien sind unveraendert eingefuegt. Grosse Dateien sind in `
    + `Abschnitte geteilt; aneinandergehaengt ergeben sie die Datei.\n`;
}
const partFooter = (k, n) => `\n---\nEnde von Teil ${k} von ${n}.\n`;
const sectionHead = (rel, size, piece, pieces) =>
  `\n## ${rel}${pieces > 1 ? ` – Abschnitt ${piece} von ${pieces}` : ''} (${kb(size)})\n\n`;

// Text in Stuecke von hoechstens max Bytes, bevorzugt an Zeilenenden
function splitText(text, max) {
  const out = [];
  let cur = '';
  let curBytes = 0;
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) || ['']) {
    const lb = bytes(line);
    if (curBytes + lb <= max) { cur += line; curBytes += lb; continue; }
    if (cur) { out.push(cur); cur = ''; curBytes = 0; }
    if (lb <= max) { cur = line; curBytes = lb; continue; }
    let rest = line; // Zeile laenger als ein Stueck (z. B. JSON in einer Zeile): nach Zeichen teilen
    while (bytes(rest) > max) {
      let cut = Math.min(rest.length, max);
      while (bytes(rest.slice(0, cut)) > max) cut = Math.floor(cut * 0.9);
      if (/[\uD800-\uDBFF]/.test(rest[cut - 1])) cut--; // kein halbes Ersatzzeichenpaar
      out.push(rest.slice(0, cut)); rest = rest.slice(cut);
    }
    cur = rest; curBytes = bytes(rest);
  }
  if (cur || !out.length) out.push(cur);
  return out;
}

function buildMarkdown(files, { name, budget, einleitung, created }) {
  const texts = [];
  const skipped = [];
  for (const f of files) {
    const t = asText(f.data);
    if (t === null) skipped.push(f.rel); else texts.push({ ...f, text: t });
  }
  if (!texts.length) throw new Error('Nur Binaerdateien ausgewaehlt – format "zip" verwenden');

  // Platz fuer Kopf/Fuss (mit grosszuegigen Zahlen) und Inhaltsverzeichnis im ersten Teil reservieren
  const headReserve = bytes(partHeader(name, 999, 999, created) + partFooter(999, 999)) + 16;
  const intro = einleitung ? `\n${einleitung.trim()}\n` : '';
  const tocLine = (t, parts) => `- ${t.rel} (${kb(t.data.length)}) – ${parts}\n`;
  const tocHead = '\n## Inhalt\n\n';
  const skipText = skipped.length
    ? `\nNicht enthalten (Binaerdateien, dafuer format zip): ${skipped.join(', ')}\n` : '';
  const tocReserve = bytes(intro + tocHead + skipText) + texts.reduce((n, t) => n + bytes(tocLine(t, 'Teil 999 bis 999')), 0);
  if (headReserve + tocReserve > budget / 2) throw new Error('Einleitung oder Dateiliste zu lang fuer max_mb – max_mb erhoehen oder weniger Dateien');

  // Teile fuellen: jede Datei als Abschnitt; passt sie nicht, in neuen Teil; zu gross fuer einen Teil -> stueckeln
  const parts = [];
  let cur = { size: headReserve + tocReserve, items: [] };
  const newPart = () => { parts.push(cur); cur = { size: headReserve, items: [] }; };
  for (const t of texts) {
    const fence = fenceFor(t.text);
    const lang = LANG[path.extname(t.rel).slice(1).toLowerCase()] || '';
    const wrap = bytes(sectionHead(t.rel, t.data.length, 9999, 9999)) + bytes(`${fence}${lang}\n`) + bytes(`\n${fence}\n`);
    const whole = wrap + bytes(t.text);
    if (cur.size + whole > budget && cur.items.length && headReserve + whole <= budget) newPart();
    if (cur.size + whole <= budget) {
      cur.items.push({ t, fence, lang, text: t.text }); cur.size += whole; t.parts = [parts.length + 1];
      continue;
    }
    // Stueckeln: zuerst den Rest des aktuellen Teils nutzen (wenn noch nennenswert Platz ist)
    t.parts = [];
    let rest = t.text;
    while (rest.length) {
      let room = budget - cur.size - wrap;
      if (room < 4096) { newPart(); room = budget - cur.size - wrap; }
      const [piece] = splitText(rest, room);
      cur.items.push({ t, fence, lang, text: piece }); cur.size += wrap + bytes(piece);
      t.parts.push(parts.length + 1);
      rest = rest.slice(piece.length);
    }
  }
  if (cur.items.length) parts.push(cur);

  const n = parts.length;
  const range = (p) => p.length === 1 ? `Teil ${p[0]}` : `Teil ${p[0]} bis ${p[p.length - 1]}`;
  const toc = tocHead + texts.map((t) => tocLine(t, range(t.parts))).join('') + skipText;
  const piecesDone = new Map();
  return parts.map((part, i) => {
    let s = partHeader(name, i + 1, n, created) + (i === 0 ? intro + toc : '');
    for (const it of part.items) {
      const piece = (piecesDone.get(it.t) || 0) + 1;
      piecesDone.set(it.t, piece);
      s += sectionHead(it.t.rel, it.t.data.length, piece, it.t.parts.length)
        + `${it.fence}${it.lang}\n${it.text}${it.text.endsWith('\n') ? '' : '\n'}${it.fence}\n`;
    }
    return { ext: 'md', data: Buffer.from(s + partFooter(i + 1, n)), count: part.items.length };
  });
}

// ---------------------------------------------------------------- ZIP-Paket
function dosTime(d) {
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
           date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}

function zipEntry(rel, data, now) {
  const name = Buffer.from(rel, 'utf8');
  const deflated = zlib.deflateRawSync(data);
  const stored = deflated.length >= data.length;
  return { name, data: stored ? data : deflated, method: stored ? 0 : 8, crc: zlib.crc32(data),
           size: data.length, ...dosTime(now) };
}
const entrySize = (e) => 30 + e.name.length + e.data.length + 46 + e.name.length;

function writeZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6);
    h.writeUInt16LE(e.method, 8); h.writeUInt16LE(e.time, 10); h.writeUInt16LE(e.date, 12);
    h.writeUInt32LE(e.crc, 14); h.writeUInt32LE(e.data.length, 18); h.writeUInt32LE(e.size, 22);
    h.writeUInt16LE(e.name.length, 26);
    chunks.push(h, e.name, e.data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(e.method, 10); c.writeUInt16LE(e.time, 12); c.writeUInt16LE(e.date, 14);
    c.writeUInt32LE(e.crc, 16); c.writeUInt32LE(e.data.length, 20); c.writeUInt32LE(e.size, 24);
    c.writeUInt16LE(e.name.length, 28); c.writeUInt32LE(offset, 42);
    central.push(c, e.name);
    offset += 30 + e.name.length + e.data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cd, end]);
}

function buildZip(files, { name, budget, einleitung, created }) {
  const now = new Date();
  const readme = (k, n, list) => `# Paket ${name} – Teil ${k} von ${n}\n\nErstellt ${created} vom ${ROLE}.\n`
    + (einleitung ? `\n${einleitung.trim()}\n` : '') + '\n## Inhalt aller Teile\n\n' + list
    + (list.includes('.stueck') ? '\nDateien mit `.stueck001`, `.stueck002`, ... sind geteilt: Stuecke in Reihenfolge '
       + 'aneinanderhaengen (z. B. `cat datei.stueck* > datei`).\n' : '');
  const listLine = (x, p) => `- ${x.rel} (${kb(x.size)}) – Teil ${p}\n`;
  const overhead = (rel) => 30 + 46 + 2 * bytes(rel);
  const reserveFor = (items) => 22 + 2 * (30 + 46 + 12)
    + bytes(readme(999, 999, items.map((x) => listLine(x, 999)).join('')));

  // Dateien, die (auch gepackt) nicht in einen Teil passen, in rohe Stuecke teilen. Die Stueckgroesse
  // haengt vom Platz fuer LIESMICH ab und der von der Zahl der Stuecke – bis es stabil ist.
  let items = files.map((f) => ({ rel: f.rel, size: f.data.length, e: zipEntry(f.rel, f.data, now) }));
  for (let round = 0; round < 6; round++) {
    const reserve = reserveFor(items);
    if (reserve > budget / 2) throw new Error('Einleitung oder Dateiliste zu lang fuer max_mb – max_mb erhoehen oder weniger Dateien');
    const next = [];
    for (const f of files) {
      const whole = zipEntry(f.rel, f.data, now);
      if (reserve + overhead(f.rel) + whole.data.length <= budget) { next.push({ rel: f.rel, size: f.data.length, e: whole }); continue; }
      const chunk = budget - reserve - overhead(f.rel + '.stueck000');
      for (let i = 0, k = 1; i < f.data.length; i += chunk, k++) {
        const rel = `${f.rel}.stueck${String(k).padStart(3, '0')}`;
        const data = f.data.subarray(i, i + chunk);
        next.push({ rel, size: data.length, e: zipEntry(rel, data, now) });
      }
    }
    const stable = next.length === items.length;
    items = next;
    if (stable && reserveFor(items) <= reserve) break;
  }
  const reserve = reserveFor(items);
  const parts = [];
  let cur = { size: reserve, items: [] };
  for (const x of items) {
    if (cur.items.length && cur.size + entrySize(x.e) > budget) { parts.push(cur); cur = { size: reserve, items: [] }; }
    cur.items.push(x); cur.size += entrySize(x.e); x.part = parts.length + 1;
  }
  parts.push(cur);
  const list = items.map((x) => listLine(x, x.part)).join('');
  return parts.map((part, i) => {
    const r = zipEntry('LIESMICH.md', Buffer.from(readme(i + 1, parts.length, list)), now);
    return { ext: 'zip', data: writeZip([r, ...part.items.map((x) => x.e)]), count: part.items.length };
  });
}

// ---------------------------------------------------------------- GitHub-Release (paket_hochladen)
const hide = (t) => (GH_TOKEN ? String(t).split(GH_TOKEN).join('***') : String(t));

async function ghRequest(method, url, { json, body, type } = {}) {
  if (!url.startsWith(GH_API + '/') && !url.startsWith(GH_UPLOADS + '/')) throw new Error('Ziel nicht erlaubt');
  let res;
  try {
    res = await fetch(url, {
      method,
      redirect: 'manual', // keinen Weiterleitungen folgen (Token bliebe sonst im Header)
      headers: {
        Authorization: `Bearer ${GH_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'ha-claude-agents-ablage',
        ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(body !== undefined ? { 'Content-Type': type || 'application/octet-stream' } : {}),
      },
      body: json !== undefined ? JSON.stringify(json) : body,
      signal: AbortSignal.timeout(300000),
    });
  } catch (e) {
    throw new Error(hide(`GitHub nicht erreichbar: ${e.cause?.code || e.message}`));
  }
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = typeof data === 'object' && data ? [data.message, ...(data.errors || []).map((x) => x.message || x.code)].filter(Boolean).join('; ') : text;
    const err = new Error(hide(`GitHub ${res.status}: ${String(msg).slice(0, 300)}`));
    err.status = res.status;
    throw err;
  }
  return data;
}

function uploadFiles(entries) {
  if (!Array.isArray(entries) || !entries.length) throw new Error('dateien: mindestens eine Datei angeben');
  if (entries.length > UPLOAD_MAX_FILES) throw new Error(`Hoechstens ${UPLOAD_MAX_FILES} Dateien je Upload`);
  const realSources = SOURCES.filter((s) => fs.existsSync(s)).map((s) => fs.realpathSync(s));
  const names = new Set();
  return entries.map((raw) => {
    if (typeof raw !== 'string' || !raw.trim()) throw new Error('dateien: nur Pfade als Text');
    const rel = path.isAbsolute(raw) ? path.relative(ROOT, raw) : raw;
    if (rel.split(/[\\/]/).includes('..')) throw new Error(`${raw}: '..' ist nicht erlaubt`);
    const p = path.resolve(ROOT, rel);
    if (!SOURCES.some((s) => inside(p, s))) throw new Error(`${raw}: nur Dateien unter ${SOURCES.map((s) => path.relative(ROOT, s) + '/').join(', ')}`);
    if (!fs.existsSync(p)) throw new Error(`${raw}: nicht gefunden`);
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) throw new Error(`${raw}: Symlinks sind nicht erlaubt`);
    if (!st.isFile()) throw new Error(`${raw}: keine Datei (Ordner vorher mit paket_erstellen packen)`);
    if (!realSources.some((s) => inside(fs.realpathSync(p), s))) throw new Error(`${raw}: liegt ausserhalb der erlaubten Ordner`);
    if (st.size > UPLOAD_MAX) throw new Error(`${raw}: groesser als ${kb(UPLOAD_MAX)}`);
    const name = path.basename(p);
    if (names.has(name)) throw new Error(`${raw}: Dateiname doppelt`);
    names.add(name);
    return { name, data: fs.readFileSync(p) };
  });
}

const MIME = { zip: 'application/zip', md: 'text/markdown', csv: 'text/csv', json: 'application/json',
               txt: 'text/plain', yaml: 'text/yaml', yml: 'text/yaml', png: 'image/png', jpg: 'image/jpeg', pdf: 'application/pdf' };

async function aufraeumen(repoUrl) {
  const grenze = Date.now() - KEEP_DAYS * 86400000;
  const geloescht = [];
  const releases = await ghRequest('GET', `${repoUrl}/releases?per_page=100`);
  for (const r of releases || []) {
    if (!String(r.tag_name).startsWith(TAG_PREFIX) || Date.parse(r.created_at) > grenze) continue;
    await ghRequest('DELETE', `${repoUrl}/releases/${r.id}`);
    await ghRequest('DELETE', `${repoUrl}/git/refs/tags/${encodeURIComponent(r.tag_name)}`).catch(() => {});
    geloescht.push(r.tag_name);
  }
  return geloescht;
}

async function paketHochladen(args) {
  if (!GH_REPO || !GH_TOKEN) throw new Error('Hochladen ist nicht eingerichtet (Add-on-Optionen ablage_github_repo/ablage_github_token).');
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(GH_REPO)) throw new Error('ABLAGE_GITHUB_REPO ungueltig');
  const titel = String(args.titel || '').trim();
  if (!titel || titel.length > 100) throw new Error('titel: 1 bis 100 Zeichen');
  const files = uploadFiles(args.dateien);
  const repoUrl = `${GH_API}/repos/${GH_REPO}`;

  const repo = await ghRequest('GET', repoUrl);
  if (repo?.private !== true) throw new Error(`${GH_REPO} ist nicht privat – Hochladen verweigert (Releases waeren oeffentlich).`);

  let hinweis = '';
  try {
    const weg = await aufraeumen(repoUrl);
    if (weg.length) hinweis = `\nAufgeraeumt (aelter als ${KEEP_DAYS} Tage): ${weg.join(', ')}`;
  } catch (e) { hinweis = `\nAufraeumen fehlgeschlagen: ${e.message}`; }

  const slug = titel.toLowerCase().normalize('NFKD').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'paket';
  const tag = `${TAG_PREFIX}${new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)}-${slug}`;
  let release;
  try {
    release = await ghRequest('POST', `${repoUrl}/releases`, { json: {
      tag_name: tag, name: titel, make_latest: 'false',
      body: `${String(args.beschreibung || '').trim()}\n\nHochgeladen vom ${ROLE}. Wird nach ${KEEP_DAYS} Tagen automatisch geloescht.`.trim(),
    } });
  } catch (e) {
    if (e.status === 422 && /empty/i.test(e.message)) throw new Error(`${GH_REPO} ist leer – einmal eine README anlegen (ein Commit noetig fuer den Tag).`);
    throw e;
  }
  const assets = [];
  try {
    for (const f of files) {
      const ext = path.extname(f.name).slice(1).toLowerCase();
      const a = await ghRequest('POST', `${GH_UPLOADS}/repos/${GH_REPO}/releases/${release.id}/assets?name=${encodeURIComponent(f.name)}`,
                                { body: f.data, type: MIME[ext] || 'application/octet-stream' });
      assets.push({ name: a.name, size: a.size, url: a.browser_download_url });
    }
  } catch (e) {
    // Halbe Releases nicht stehen lassen
    await ghRequest('DELETE', `${repoUrl}/releases/${release.id}`).catch(() => {});
    await ghRequest('DELETE', `${repoUrl}/git/refs/tags/${encodeURIComponent(tag)}`).catch(() => {});
    throw new Error(`Hochladen abgebrochen, nichts gespeichert: ${e.message}`);
  }
  return `Hochgeladen nach ${GH_REPO} (privat), Release „${titel}“:\n${release.html_url}\n`
    + assets.map((a) => `- [${a.name}](${a.url}) (${kb(a.size)})`).join('\n')
    + `\nLoeschung automatisch nach ${KEEP_DAYS} Tagen.${hinweis}\n`
    + 'Markus den Release-Link als Markdown-Link nennen.';
}

// ---------------------------------------------------------------- Werkzeug
function paketErstellen(args) {
  const name = String(args.name || 'paket');
  if (!/^[\w-]{1,60}$/.test(name)) throw new Error('name: nur Buchstaben, Ziffern, - und _ (hoechstens 60 Zeichen)');
  const format = args.format || 'zip';
  if (!['md', 'zip'].includes(format)) throw new Error('format: "md" oder "zip"');
  const mb = args.max_mb === undefined ? DEFAULT_MB : Number(args.max_mb);
  if (!(mb >= 0.05 && mb <= MAX_MB)) throw new Error(`max_mb: zwischen 0.05 und ${MAX_MB}`);
  if (args.einleitung !== undefined && typeof args.einleitung !== 'string') throw new Error('einleitung: Text');

  const files = collect(args.dateien);
  // Nur eine Datei, die in die Grenze passt, und kein Format gewuenscht: nichts packen, direkt schicken
  if (files.length === 1 && args.format === undefined && files[0].data.length <= mb * 1048576) {
    return `Nur eine Datei – kein Paket noetig. Direkt mit SendUserFile schicken (display: "attach"):\n`
      + `- ${path.join(ROOT, files[0].rel)} (${kb(files[0].data.length)})`;
  }
  const now = new Date();
  const created = now.toLocaleString('de-DE', { timeZone: 'Europe/Berlin' });
  const opts = { name, budget: Math.floor(mb * 1048576), einleitung: args.einleitung, created };
  const parts = format === 'zip' ? buildZip(files, opts) : buildMarkdown(files, opts);

  fs.mkdirSync(TARGET, { recursive: true });
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13);
  const written = parts.map((p, i) => {
    const suffix = parts.length > 1 ? `-teil${i + 1}von${parts.length}` : '';
    const file = path.join(TARGET, `${name}-${stamp}${suffix}.${p.ext}`);
    fs.writeFileSync(file, p.data, { flag: 'wx', mode: 0o600 }); // nie ueberschreiben, keinem Link folgen
    return { file, size: p.data.length, count: p.count };
  });
  const skipped = format === 'md' ? files.filter((f) => asText(f.data) === null).map((f) => f.rel) : [];
  return `${files.length - skipped.length} Dateien in ${written.length} ${written.length === 1 ? 'Datei' : 'Teilen'} (Grenze ${mb} MB):\n`
    + written.map((w) => `- ${w.file} (${kb(w.size)}, ${w.count} ${format === 'zip' ? (w.count === 1 ? 'Datei' : 'Dateien') : (w.count === 1 ? 'Abschnitt' : 'Abschnitte')})`).join('\n')
    + (skipped.length ? `\nNicht enthalten (Binaerdateien, dafuer format "zip"): ${skipped.join(', ')}` : '')
    + `\nJetzt alle Teile in einem SendUserFile-Aufruf schicken (files: [...], display: "attach").`;
}

const TOOLS = [{
  name: 'paket_erstellen',
  description: 'Packt Dateien zu einem Paket fuer Markus und teilt es in mehrere Teile, wenn es groesser '
    + 'als max_mb wird. Bei nur einer Datei (ohne format) wird nichts gepackt – die Antwort nennt sie zum '
    + 'direkten Schicken. format "zip" (Standard): ein ZIP mit allen Dateien und LIESMICH.md, je Teil ein '
    + 'eigenstaendiges ZIP; einzelne zu grosse Dateien werden in Stuecke geteilt. format "md" nur auf Wunsch: '
    + 'eine Markdown-Datei mit allen Textdateien. '
    + `Erlaubt sind Dateien unter ${SOURCES.join(', ')}. `
    + `Ergebnis unter ${TARGET}, danach mit SendUserFile schicken.`,
  inputSchema: {
    type: 'object',
    required: ['dateien'],
    properties: {
      dateien: { type: 'array', items: { type: 'string' },
                 description: 'Dateien oder Ordner (relativ zu ' + ROOT + ' oder absolut), Platzhalter * und ** erlaubt, '
                   + 'z. B. ["ausgang/bericht.md", "ha/abruf/*.json", "ha/backup"]' },
      name: { type: 'string', description: 'Kurzname fuer die Paketdatei, z. B. "diagnose-heizung"' },
      format: { type: 'string', enum: ['zip', 'md'], description: 'Standard "zip"; "md" nur, wenn Markus eine lesbare Textdatei will' },
      max_mb: { type: 'number', description: `Hoechstgroesse je Teil in MB, Standard ${DEFAULT_MB}, hoechstens ${MAX_MB}` },
      einleitung: { type: 'string', description: 'Markdown-Text an den Anfang (Teil 1 bzw. LIESMICH.md), z. B. Ziel und Fehlerbild' },
    },
  },
}, {
  name: 'paket_hochladen',
  description: `Laedt fertige Dateien (z. B. die ZIP-Teile von paket_erstellen oder eine einzelne Ergebnisdatei) `
    + `als Anhaenge eines neuen Releases in das private GitHub-Repo ${GH_REPO || '(nicht eingerichtet)'} hoch – `
    + `ohne Commit, ohne Git-Historie. Liefert den Link fuer Markus. Releases werden nach ${KEEP_DAYS} Tagen `
    + `geloescht. Erlaubt sind Dateien unter ${SOURCES.join(', ')}, hoechstens ${UPLOAD_MAX_FILES}, je ${kb(UPLOAD_MAX)}.`,
  inputSchema: {
    type: 'object',
    required: ['dateien', 'titel'],
    properties: {
      dateien: { type: 'array', items: { type: 'string' }, description: 'Dateipfade (keine Ordner, keine Platzhalter), z. B. die von paket_erstellen genannten' },
      titel: { type: 'string', description: 'Titel des Releases, z. B. "Warmwasser 19.10.2026"' },
      beschreibung: { type: 'string', description: 'Kurzer Text zum Release (Markdown), z. B. was im Paket ist' },
    },
  },
}];

// ---------------------------------------------------------------- MCP (JSON-RPC ueber stdio)
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

async function handle(msg) {
  switch (msg.method) {
    case 'initialize':
      return { protocolVersion: msg.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} },
               serverInfo: { name: 'ablage', version: '0.1.0' } };
    case 'ping': return {};
    case 'tools/list': return { tools: TOOLS };
    case 'tools/call': {
      const { name, arguments: args = {} } = msg.params || {};
      try {
        const text = name === 'paket_erstellen' ? paketErstellen(args)
                   : name === 'paket_hochladen' ? await paketHochladen(args)
                   : (() => { throw new Error(`Unbekanntes Werkzeug ${name}`); })();
        return { content: [{ type: 'text', text }] };
      } catch (e) {
        return { content: [{ type: 'text', text: 'Fehler: ' + hide(e.message) }], isError: true };
      }
    }
    default: {
      const err = new Error(`Methode ${msg.method} nicht unterstuetzt`); err.code = -32601; throw err;
    }
  }
}

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return; // Notification
  try { send({ jsonrpc: '2.0', id: msg.id, result: await handle(msg) }); }
  catch (e) { send({ jsonrpc: '2.0', id: msg.id, error: { code: e.code || -32603, message: e.message } }); }
}).on('close', () => process.exit(0));
