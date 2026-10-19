// GitHub-Proxy des Architekten (Node, ohne Abhaengigkeiten). Laeuft als eigener Nutzer 'gitproxy'
// (UID 1001) und haelt als einziger Prozess den GitHub-Token. Der Agent (UID 1000, mit Bash und
// Internet) sieht den Token nie: /proc/<pid>/environ eines fremden Nutzers ist fuer ihn nicht lesbar.
//
// Nur auf 127.0.0.1. Drei Wege, alle auf die Repos von GITHUB_OWNER beschraenkt:
//   /git/<owner>/<repo>/...  Git Smart HTTP (clone/fetch/push) -> https://github.com/<owner>/<repo>.git/...
//                            Push nur auf refs/heads/<BRANCH_PREFIX>* – ausser im AUSTAUSCH_REPO
//                            (dort alle Branches); Tags per git nie (ein Tag startet z. B. den
//                            Release-Workflow von paperless-go mit den Signier-Secrets).
//   /api/...                 kleine Auswahl der REST-API (lesen, Pull Request anlegen/aendern,
//                            kommentieren). Kein Merge, keine Dateien per API, kein GraphQL, kein
//                            Workflow-Start. Im AUSTAUSCH_REPO zusaetzlich Pakete wie beim
//                            Hausmeister (paket_hochladen des ablage-Servers): Release mit Tag
//                            paket-*, Release loeschen, Tag paket-* loeschen (30-Tage-Aufraeumen).
//   /uploads/...             Release-Dateien hochladen (uploads.github.com), nur AUSTAUSCH_REPO.
// Grund: GitHub Free kennt fuer private Repos keinen Branch-Schutz, ein Fine-grained-Token mit
// Contents-Schreibrecht duerfte sonst auf main pushen, Tags setzen und Releases anlegen.

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { pathToFileURL } from 'node:url';

const ZERO_RE = /^0+$/;
export const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
export const OWNER_RE = /^[A-Za-z0-9-]{1,39}$/;
const OID = '(?:[0-9a-f]{40}|[0-9a-f]{64})';
const CMD_RE = new RegExp(`^(${OID}) (${OID}) (refs/[^\\x00\\s]+)$`);
const SHALLOW_RE = new RegExp(`^shallow ${OID}$`);
const MAX_COMMANDS_BYTES = 1 << 20;
const MAX_API_BODY = 1 << 20;

// ---------------------------------------------------------------------------------------------
// pkt-line

export function pkt(data) {
  const b = Buffer.isBuffer(data) ? data : Buffer.from(data);
  return Buffer.concat([Buffer.from((b.length + 4).toString(16).padStart(4, '0')), b]);
}

// Liest die Befehlsliste eines receive-pack-Requests (bis zum ersten Flush-Paket).
// Ergebnis: null = noch unvollstaendig, sonst {commands, caps} oder {error}.
export function parseCommands(buf) {
  const commands = [];
  let caps = [];
  let pos = 0;
  while (true) {
    if (buf.length < pos + 4) return null;
    const hex = buf.toString('latin1', pos, pos + 4);
    if (!/^[0-9a-f]{4}$/.test(hex)) return { error: 'ungueltiges pkt-line-Format' };
    const len = parseInt(hex, 16);
    if (len === 0) return { commands, caps };
    if (len < 5) return { error: 'ungueltige pkt-line-Laenge' };
    if (buf.length < pos + len) return null;
    let line = buf.toString('latin1', pos + 4, pos + len);
    pos += len;
    if (line.endsWith('\n')) line = line.slice(0, -1);
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      if (commands.length > 0) return { error: 'Faehigkeiten nach dem ersten Befehl' };
      caps = line.slice(nul + 1).split(' ').filter(Boolean);
      line = line.slice(0, nul);
    }
    if (commands.length === 0 && SHALLOW_RE.test(line)) continue;
    const m = CMD_RE.exec(line);
    if (!m) return { error: `unbekannte Zeile: ${line.slice(0, 80)}` };
    commands.push({ old: m[1], neu: m[2], ref: m[3] });
  }
}

// Darf dieser Ref-Befehl durch? Liefert null (ja) oder den Grund der Ablehnung.
export function refDenied(cmd, repo, cfg) {
  const { ref, neu } = cmd;
  if (!ref.startsWith('refs/heads/')) return 'nur Branches, keine Tags oder anderen Refs';
  const branch = ref.slice('refs/heads/'.length);
  if (!branch || branch.includes('..') || /[\x00-\x20~^:?*[\\]/.test(branch)) return 'ungueltiger Branch-Name';
  if (branch.startsWith(cfg.prefix) && branch.length > cfg.prefix.length) return null;
  if (cfg.austausch && repo.toLowerCase() === cfg.austausch) {
    return ZERO_RE.test(neu) ? `Branches ausserhalb von ${cfg.prefix}* nicht loeschen` : null;
  }
  return `nur Branches ${cfg.prefix}* (Merge macht Markus per Pull Request)`;
}

// Antwort im receive-pack-Format: jede Ref "ng" mit Grund, damit git die Meldung anzeigt.
export function rejectReport(commands, reasons, caps) {
  const lines = [pkt('unpack ok\n')];
  commands.forEach((c, i) => lines.push(pkt(`ng ${c.ref} ${reasons[i] || 'abgelehnt, weil ein anderer Ref unzulaessig ist'}\n`)));
  lines.push(Buffer.from('0000'));
  const report = Buffer.concat(lines);
  if (!caps.includes('side-band-64k') && !caps.includes('side-band')) return report;
  const max = caps.includes('side-band-64k') ? 65515 : 995;
  const out = [];
  const msg = `Architekt-Proxy: Push abgelehnt. Erlaubt sind nur Branches ${reasons.prefix}*.\n`;
  out.push(pkt(Buffer.concat([Buffer.from([2]), Buffer.from(msg)])));
  for (let i = 0; i < report.length; i += max) {
    out.push(pkt(Buffer.concat([Buffer.from([1]), report.subarray(i, i + max)])));
  }
  out.push(Buffer.from('0000'));
  return Buffer.concat(out);
}

// ---------------------------------------------------------------------------------------------
// REST-API: erlaubte Aufrufe

const API_BODY_KEYS = {
  createPull: ['title', 'body', 'head', 'base', 'draft', 'maintainer_can_modify'],
  updatePull: ['title', 'body', 'state'],
  comment: ['body'],
  createIssue: ['title', 'body'],
  createRelease: ['tag_name', 'name', 'body', 'make_latest'],
};
// Gleiche Tags wie der ablage-Server: paket-<JJJJMMTT>-<HHMMSS>-<thema>
const PAKET_TAG_RE = /^paket-[a-z0-9_-]{1,80}$/;

// Liefert den Schluessel fuer die Body-Pruefung ('' = ohne Body) oder null (verboten).
export function apiRoute(method, path, owner, austausch = '') {
  if (path.includes('..') || path.includes('//') || /%2e|%2f/i.test(path)) return null;
  if (method === 'GET' && path === '/user/repos') return '';
  const m = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path);
  if (!m || m[1].toLowerCase() !== owner.toLowerCase() || !NAME_RE.test(m[2])) return null;
  const rest = m[3] || '';
  if (method === 'GET') {
    // Namen von Secrets/Variablen, Deploy-Keys, Webhooks gehen den Agenten nichts an
    if (/\/(secrets|variables|keys|hooks|environments)(\/|$)/.test(rest)) return null;
    return '';
  }
  if (method === 'POST' && rest === '/pulls') return 'createPull';
  if (method === 'PATCH' && /^\/pulls\/\d+$/.test(rest)) return 'updatePull';
  if (method === 'POST' && /^\/issues\/\d+\/comments$/.test(rest)) return 'comment';
  if (method === 'POST' && rest === '/issues') return 'createIssue';
  // Pakete (Releases paket-*) nur im Austausch-Repo, das keine Workflows mit Secrets hat
  if (austausch && m[2].toLowerCase() === austausch) {
    if (method === 'POST' && rest === '/releases') return 'createRelease';
    if (method === 'DELETE' && /^\/releases\/\d+$/.test(rest)) return '';
    const t = /^\/git\/refs\/tags\/(.+)$/.exec(rest);
    if (method === 'DELETE' && t && PAKET_TAG_RE.test(t[1])) return '';
  }
  return null;
}

// Upload einer Release-Datei: /repos/<owner>/<repo>/releases/<id>/assets, nur Austausch-Repo
export function uploadRoute(method, path, query, owner, austausch) {
  if (method !== 'POST' || !austausch) return false;
  const m = /^\/repos\/([^/]+)\/([^/]+)\/releases\/\d+\/assets$/.exec(path);
  if (!m || m[1].toLowerCase() !== owner.toLowerCase() || m[2].toLowerCase() !== austausch) return false;
  return [...query.keys()].every((k) => k === 'name' || k === 'label') && query.has('name');
}

export function apiBodyError(kind, body) {
  if (!kind) return body.length ? 'kein Body erlaubt' : null;
  let data;
  try { data = JSON.parse(body.toString('utf8')); } catch { return 'Body ist kein JSON'; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return 'Body muss ein JSON-Objekt sein';
  const bad = Object.keys(data).filter((k) => !API_BODY_KEYS[kind].includes(k));
  if (bad.length) return `nicht erlaubte Felder: ${bad.join(', ')}`;
  if (kind === 'updatePull' && 'state' in data && !['open', 'closed'].includes(data.state)) return 'state nur open/closed';
  if (kind === 'createRelease' && (typeof data.tag_name !== 'string' || !PAKET_TAG_RE.test(data.tag_name))) return 'tag_name muss paket-<datum>-<thema> sein (paket_hochladen benutzen)';
  return null;
}

// ---------------------------------------------------------------------------------------------
// Server

export function createProxy(cfg) {
  const gitBase = new URL(cfg.gitBase || 'https://github.com');
  const apiBase = new URL(cfg.apiBase || 'https://api.github.com');
  const uploadBase = new URL(cfg.uploadBase || 'https://uploads.github.com');
  const basic = 'Basic ' + Buffer.from(`x-access-token:${cfg.token}`).toString('base64');
  const scrub = (s) => (cfg.token ? String(s).split(cfg.token).join('***') : String(s));
  const log = cfg.log || ((...a) => console.log('[github-proxy]', ...a.map(scrub)));

  function fail(res, status, msg) {
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`Architekt-Proxy: ${msg}\n`);
  }

  function forward(req, res, target, headers, firstChunk) {
    const lib = target.protocol === 'https:' ? https : http;
    const up = lib.request(target, { method: req.method, headers }, (ur) => {
      const h = { ...ur.headers };
      delete h['set-cookie'];
      if (ur.statusCode === 401) {
        // Kein Login-Dialog im git-Client: Token fehlt/abgelaufen ist Sache von Markus
        delete h['www-authenticate'];
        log(`401 von GitHub fuer ${req.method} ${target.pathname} – Token ungueltig oder abgelaufen?`);
        ur.resume();
        return fail(res, 403, 'GitHub lehnt den Token ab (abgelaufen? Rechte?). Bitte Markus Bescheid geben.');
      }
      res.writeHead(ur.statusCode, h);
      ur.pipe(res);
    });
    up.on('error', (e) => { log(`Upstream-Fehler: ${e.message}`); fail(res, 502, 'GitHub nicht erreichbar'); });
    if (firstChunk && firstChunk.length) up.write(firstChunk);
    req.pipe(up);
  }

  function pickHeaders(req, names) {
    const h = {};
    for (const n of names) if (req.headers[n] !== undefined) h[n] = req.headers[n];
    return h;
  }

  function handleGit(req, res, url) {
    const m = /^\/git\/([^/]+)\/([^/]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(url.pathname);
    if (!m) return fail(res, 404, 'unbekannter Pfad');
    const [, owner, repo, op] = m;
    if (owner.toLowerCase() !== cfg.owner.toLowerCase()) return fail(res, 403, `nur Repos von ${cfg.owner}`);
    if (!NAME_RE.test(repo) || repo === '.' || repo === '..') return fail(res, 400, 'ungueltiger Repo-Name');
    let query = '';
    if (op === 'info/refs') {
      const svc = url.searchParams.get('service');
      if (req.method !== 'GET' || !['git-upload-pack', 'git-receive-pack'].includes(svc)) return fail(res, 400, 'nur Smart HTTP');
      query = `?service=${svc}`;
    } else if (req.method !== 'POST') {
      return fail(res, 405, 'nur POST');
    }
    const target = new URL(`${gitBase.pathname.replace(/\/$/, '')}/${cfg.owner}/${repo}.git/${op}${query}`, gitBase);
    const headers = {
      ...pickHeaders(req, ['content-type', 'accept', 'accept-encoding', 'content-encoding', 'content-length',
        'transfer-encoding', 'git-protocol', 'user-agent']),
      authorization: basic,
    };
    if (op !== 'git-receive-pack') return forward(req, res, target, headers);

    // Push: erst die Befehlsliste lesen und pruefen, dann (nur wenn alles erlaubt ist) weiterleiten
    if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') {
      return fail(res, 415, 'komprimierte Push-Anfragen werden nicht unterstuetzt');
    }
    const chunks = [];
    let size = 0;
    let decided = false;
    const onData = (c) => {
      if (decided) return;
      chunks.push(c);
      size += c.length;
      const buf = Buffer.concat(chunks);
      const parsed = parseCommands(buf);
      if (!parsed && size < MAX_COMMANDS_BYTES) return;
      decided = true;
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.pause();
      if (!parsed || parsed.error) {
        log(`Push ${repo} abgelehnt: ${parsed ? parsed.error : 'Befehlsliste zu gross'}`);
        req.resume();
        return fail(res, 400, parsed ? parsed.error : 'Befehlsliste zu gross');
      }
      const reasons = parsed.commands.map((c) => refDenied(c, repo, cfg));
      if (reasons.some(Boolean)) {
        log(`Push ${repo} abgelehnt: ${parsed.commands.map((c, i) => `${c.ref}${reasons[i] ? ' (' + reasons[i] + ')' : ''}`).join(', ')}`);
        reasons.prefix = cfg.prefix;
        // Rest des Requests (Pack-Daten) verwerfen, dann ein regulaeres receive-pack-Ergebnis senden
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result', 'cache-control': 'no-cache' });
          res.end(rejectReport(parsed.commands, reasons, parsed.caps));
        });
        req.resume();
        return;
      }
      if (parsed.commands.length) log(`Push ${repo}: ${parsed.commands.map((c) => c.ref).join(', ')}`);
      forward(req, res, target, headers, buf);
      req.resume();
    };
    // Sehr kleine Requests (z. B. die "0000"-Probe bei grossen Pushes) enden vor einer Entscheidung
    const onEnd = () => {
      if (decided) return;
      decided = true;
      const buf = Buffer.concat(chunks);
      const parsed = parseCommands(buf);
      if (!parsed || parsed.error) return fail(res, 400, parsed ? parsed.error : 'unvollstaendige Befehlsliste');
      const reasons = parsed.commands.map((c) => refDenied(c, repo, cfg));
      if (reasons.some(Boolean)) {
        reasons.prefix = cfg.prefix;
        res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result', 'cache-control': 'no-cache' });
        return res.end(rejectReport(parsed.commands, reasons, parsed.caps));
      }
      const lib = target.protocol === 'https:' ? https : http;
      const h = { ...headers, 'content-length': String(buf.length) };
      delete h['transfer-encoding'];
      const up = lib.request(target, { method: 'POST', headers: h }, (ur) => {
        const rh = { ...ur.headers };
        delete rh['set-cookie'];
        delete rh['www-authenticate'];
        res.writeHead(ur.statusCode === 401 ? 403 : ur.statusCode, rh);
        ur.pipe(res);
      });
      up.on('error', (e) => { log(`Upstream-Fehler: ${e.message}`); fail(res, 502, 'GitHub nicht erreichbar'); });
      up.end(buf);
    };
    req.on('data', onData);
    req.on('end', onEnd);
  }

  function handleApi(req, res, url) {
    const path = url.pathname.slice('/api'.length) || '/';
    const kind = apiRoute(req.method, path, cfg.owner, cfg.austausch);
    if (kind === null) {
      log(`API verweigert: ${req.method} ${path}`);
      return fail(res, 403, `${req.method} ${path} ist nicht freigegeben (erlaubt: lesen unter /repos/${cfg.owner}/…, Pull Request anlegen/aendern, Issue/Kommentar anlegen)`);
    }
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_API_BODY) { req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const err = apiBodyError(kind, body);
      if (err) return fail(res, 400, err);
      if (req.method !== 'GET') log(`API ${req.method} ${path}`);
      const target = new URL(`${apiBase.pathname.replace(/\/$/, '')}${path}${url.search}`, apiBase);
      const headers = {
        accept: req.headers.accept || 'application/vnd.github+json',
        'x-github-api-version': req.headers['x-github-api-version'] || '2022-11-28',
        'user-agent': 'ha-claude-architekt',
        authorization: `Bearer ${cfg.token}`,
      };
      if (body.length) { headers['content-type'] = 'application/json'; headers['content-length'] = String(body.length); }
      const lib = target.protocol === 'https:' ? https : http;
      const up = lib.request(target, { method: req.method, headers }, (ur) => {
        const h = { ...ur.headers };
        delete h['set-cookie'];
        res.writeHead(ur.statusCode, h);
        ur.pipe(res);
      });
      up.on('error', (e) => { log(`Upstream-Fehler: ${e.message}`); fail(res, 502, 'GitHub nicht erreichbar'); });
      up.end(body);
    });
  }

  // Datei-Upload wird gestreamt (APKs, PDFs), nicht gepuffert
  function handleUpload(req, res, url) {
    const path = url.pathname.slice('/uploads'.length);
    if (path.includes('..') || /%2e|%2f/i.test(path) || !uploadRoute(req.method, path, url.searchParams, cfg.owner, cfg.austausch)) {
      log(`Upload verweigert: ${req.method} ${path}`);
      return fail(res, 403, `Uploads nur als Release-Datei im Austausch-Repo (${cfg.austausch || 'keins konfiguriert'}): POST /uploads/repos/${cfg.owner}/<repo>/releases/<id>/assets?name=<datei>`);
    }
    if (!req.headers['content-length']) return fail(res, 411, 'Content-Length fehlt (curl --data-binary @datei setzt sie)');
    log(`Upload ${path}?${url.searchParams} (${req.headers['content-length']} Bytes)`);
    const target = new URL(`${uploadBase.pathname.replace(/\/$/, '')}${path}${url.search}`, uploadBase);
    forward(req, res, target, {
      'content-type': req.headers['content-type'] || 'application/octet-stream',
      'content-length': req.headers['content-length'],
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'ha-claude-architekt',
      authorization: `Bearer ${cfg.token}`,
    });
  }

  return http.createServer((req, res) => {
    let url;
    try { url = new URL(req.url, 'http://127.0.0.1'); } catch { return fail(res, 400, 'ungueltige URL'); }
    if (!cfg.token) return fail(res, 503, 'kein GitHub-Token konfiguriert (Add-on-Option github_token)');
    if (url.pathname.startsWith('/git/')) return handleGit(req, res, url);
    if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
    if (url.pathname.startsWith('/uploads/')) return handleUpload(req, res, url);
    return fail(res, 404, 'Pfade: /git/<owner>/<repo>.git (git), /api/… (REST-Auswahl), /uploads/… (Release-Dateien)');
  });
}

export function configFromEnv(env) {
  const owner = env.GITHUB_OWNER || '';
  if (!OWNER_RE.test(owner)) throw new Error(`GITHUB_OWNER ungueltig: '${owner}'`);
  const prefix = env.BRANCH_PREFIX || 'claude/';
  if (!/^[A-Za-z0-9._-]+\/$/.test(prefix)) throw new Error(`BRANCH_PREFIX ungueltig: '${prefix}'`);
  const austausch = (env.AUSTAUSCH_REPO || '').trim().toLowerCase();
  if (austausch && !NAME_RE.test(austausch)) throw new Error(`AUSTAUSCH_REPO ungueltig: '${austausch}'`);
  // Token aus einer Datei, die nur gitproxy lesen kann – als Argument (env -i TOKEN=…) stuende er
  // kurz in /proc/<pid>/cmdline, und das darf jeder Nutzer lesen
  let token = '';
  if (env.GITHUB_TOKEN_FILE) {
    try { token = fs.readFileSync(env.GITHUB_TOKEN_FILE, 'utf8').trim(); } catch { token = ''; }
  }
  return { owner, prefix, austausch, token, port: Number(env.PROXY_PORT || 8099) };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const cfg = configFromEnv(process.env);
  createProxy(cfg).listen(cfg.port, '127.0.0.1', () => {
    console.log(`[github-proxy] lauscht auf 127.0.0.1:${cfg.port} – Owner ${cfg.owner}, Push nur ${cfg.prefix}*` +
      (cfg.austausch ? `, Austausch-Repo ${cfg.austausch} (alle Branches, Releases)` : '') + (cfg.token ? '' : ' – KEIN TOKEN'));
  });
}
