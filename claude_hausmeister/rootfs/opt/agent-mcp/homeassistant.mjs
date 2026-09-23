// MCP-Server (stdio) fuer den Hausmeister: Home Assistant lesen und aendern.
// Ohne Abhaengigkeiten (Node >= 22: fetch, WebSocket), damit er vollstaendig nachlesbar bleibt.
//
//   ha_read  – nur Befehle aus READ_WS bzw. REST-GET; per Managed Settings ohne Rueckfrage
//   ha_write – alles andere ausser BLOCK_*; per Managed Settings IMMER mit Rueckfrage.
//              Vor Dashboard-/Automations-/Skript-/Szenen-Aenderungen wird der alte Stand gesichert.
//
// Dateien (save_as, data_file) nur unter HA_FILES_DIR – der Server laeuft als 'agent' und
// koennte sonst z. B. den Claude-Login lesen, den die Read-Sperre der Managed Settings schuetzt.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const HA_URL = (process.env.HA_URL || '').replace(/\/$/, '');
const HA_TOKEN = process.env.HA_TOKEN || '';
const FILES = path.resolve(process.env.HA_FILES_DIR || '/data/workspace/ha');
const MAX_CHARS = 40000;
const TIMEOUT_MS = 60000;

const READ_WS = new Set([
  'get_states', 'get_config', 'get_services', 'get_panels',
  'lovelace/config', 'lovelace/dashboards/list', 'lovelace/resources',
  'config/entity_registry/list', 'config/entity_registry/list_for_display', 'config/entity_registry/get',
  'config/entity_registry/get_entries', 'config/device_registry/list', 'config/area_registry/list',
  'config/floor_registry/list', 'config/label_registry/list', 'config/category_registry/list',
  'search/related', 'automation/config', 'script/config', 'blueprint/list', 'trace/list', 'trace/get',
  'recorder/statistics_during_period', 'recorder/list_statistic_ids', 'recorder/get_statistics_metadata',
  'history/history_during_period', 'logbook/get_events', 'system_log/list', 'render_template',
  'energy/get_prefs', 'person/list', 'zone/list', 'schedule/list', 'timer/list', 'counter/list',
  'input_boolean/list', 'input_number/list', 'input_select/list', 'input_text/list',
  'input_datetime/list', 'input_button/list', 'manifest/list', 'config_entries/get',
]);
// Auch beim Schreiben gesperrt: Zugaenge, Integrationen, Supervisor/Add-ons, Backups
const BLOCK_WS = [/^auth\//, /^config\/auth/, /^config_entries\/(?!get$)/, /^application_credentials\//,
                  /^backup\//, /^hassio\//, /^supervisor\//, /^cloud\//];
const BLOCK_REST = [/^\/api\/hassio/, /^\/api\/auth/, /^\/api\/backup/, /^\/api\/config\/config_entries/,
                    /^\/api\/services\/(hassio|backup)\//];
const BLOCK_DOMAINS = ['hassio', 'backup'];
// Auch in Automationen/Skripten, die spaeter mit HA-Rechten laufen wuerden
const BLOCK_IN_PAYLOAD = new RegExp(`["'\\s](${BLOCK_DOMAINS.join('|')})\\.[a-z0-9_]+`);

// ---------------------------------------------------------------- Home Assistant
function wsCall(msg) {
  const url = HA_URL.replace(/^http/, 'ws') + '/api/websocket';
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(url);
    const timer = setTimeout(() => finish(reject, new Error('Timeout nach 60 s')), TIMEOUT_MS);
    function finish(fn, v) { clearTimeout(timer); try { sock.close(); } catch {} fn(v); }
    sock.onerror = (e) => finish(reject, new Error('WebSocket-Fehler: ' + (e.message || e.type)));
    sock.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.type === 'auth_required') sock.send(JSON.stringify({ type: 'auth', access_token: HA_TOKEN }));
      else if (m.type === 'auth_invalid') finish(reject, new Error('Anmeldung abgelehnt: ' + m.message));
      else if (m.type === 'auth_ok') sock.send(JSON.stringify({ ...msg, id: 1 }));
      else if (m.id === 1 && m.type === 'result') {
        if (!m.success) return finish(reject, new Error(`${m.error?.code}: ${m.error?.message}`));
        if (msg.type !== 'render_template') finish(resolve, m.result); // render_template: Ergebnis kommt als Event
      } else if (m.id === 1 && m.type === 'event') finish(resolve, m.event);
    };
  });
}

async function restCall(method, p, body) {
  const res = await fetch(HA_URL + p, {
    method,
    headers: { Authorization: `Bearer ${HA_TOKEN}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}: ${(typeof data === 'string' ? data : JSON.stringify(data)).slice(0, 500)}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// ---------------------------------------------------------------- Dateien
function filePath(name) {
  const p = path.resolve(FILES, name);
  if (!p.startsWith(FILES + path.sep)) throw new Error(`Nur Dateien unter ${FILES} erlaubt`);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  if (!(fs.realpathSync(path.dirname(p)) + path.sep).startsWith(fs.realpathSync(FILES) + path.sep)
      || (fs.existsSync(p) && fs.lstatSync(p).isSymbolicLink())) throw new Error('Symlinks sind nicht erlaubt');
  return p;
}
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
function saveJson(name, data) {
  const p = filePath(name);
  fs.writeFileSync(p, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  return p;
}

// ---------------------------------------------------------------- Ausgabe
function shape(data, { select, grep, fields }) {
  if (select) {
    for (const key of String(select).split('.').filter(Boolean)) {
      if (data == null) throw new Error(`select: '${key}' nicht gefunden`);
      data = data[/^\d+$/.test(key) && Array.isArray(data) ? Number(key) : key];
    }
  }
  if (Array.isArray(data) && grep) {
    const g = String(grep).toLowerCase();
    data = data.filter((x) => JSON.stringify(x).toLowerCase().includes(g));
  }
  if (Array.isArray(data) && Array.isArray(fields) && fields.length) {
    data = data.map((x) => Object.fromEntries(fields.filter((f) => x && f in x).map((f) => [f, x[f]])));
  }
  return data;
}

function output(data, args, label) {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 1);
  const count = Array.isArray(data) ? ` (${data.length} Eintraege)` : '';
  if (args.save_as || text.length > MAX_CHARS) {
    const p = saveJson(args.save_as || `abruf/${label.replace(/[^\w-]+/g, '_')}-${stamp()}.json`, data);
    const why = args.save_as ? '' : ` – zu gross fuer die Antwort (${text.length} Zeichen); mit select/grep/fields eingrenzen oder die Datei mit Read lesen`;
    return `Gespeichert: ${p}${count}${why}\nVorschau:\n${text.slice(0, 1500)}`;
  }
  return text + (count ? `\n${count.trim()}` : '');
}

// ---------------------------------------------------------------- Werkzeuge
function checkWs(msg, write) {
  if (!msg || typeof msg.type !== 'string') throw new Error('ws braucht ein Feld "type"');
  if (!write && !READ_WS.has(msg.type)) throw new Error(`'${msg.type}' ist nicht in der Lese-Liste – fuer Aenderungen ha_write verwenden`);
  if (BLOCK_WS.some((r) => r.test(msg.type))) throw new Error(`'${msg.type}' ist gesperrt`);
  if (msg.type === 'call_service' && BLOCK_DOMAINS.includes(msg.domain)) throw new Error(`Services der Domain '${msg.domain}' sind gesperrt`);
}
function checkRest(p) {
  if (typeof p !== 'string' || !p.startsWith('/api/')) throw new Error('path muss mit /api/ beginnen');
  if (p.includes('..')) throw new Error('.. im Pfad ist nicht erlaubt');
  if (BLOCK_REST.some((r) => r.test(p))) throw new Error(`${p} ist gesperrt`);
}

async function haRead(args) {
  if (args.ws) {
    checkWs(args.ws, false);
    return output(shape(await wsCall(args.ws), args), args, args.ws.type);
  }
  if (args.get) {
    checkRest(args.get);
    return output(shape(await restCall('GET', args.get), args), args, args.get);
  }
  throw new Error('ws oder get angeben');
}

async function backup(kind, name, loader) {
  try {
    const data = await loader();
    return saveJson(`backup/${kind}-${name.replace(/[^\w-]+/g, '_')}-${stamp()}.json`, data);
  } catch (e) {
    if (e.status === 404) return null; // neu angelegt – nichts zu sichern
    throw new Error(`Sicherung des alten Stands fehlgeschlagen, nichts geaendert: ${e.message}`);
  }
}

async function haWrite(args) {
  let payload = args.data;
  if (args.data_file) payload = JSON.parse(fs.readFileSync(filePath(args.data_file), 'utf8'));

  if (args.ws) {
    const msg = { ...args.ws };
    if (payload !== undefined) msg[args.data_key || 'config'] = payload;
    checkWs(msg, true);
    if (BLOCK_IN_PAYLOAD.test(JSON.stringify(msg))) throw new Error(`Nachricht enthaelt gesperrte Services (${BLOCK_DOMAINS.join(', ')})`);
    let saved = null;
    if (msg.type === 'lovelace/config/save' || msg.type === 'lovelace/config/delete') {
      const up = msg.url_path ?? null;
      saved = await backup('dashboard', up || 'default', () => wsCall({ type: 'lovelace/config', url_path: up }));
    }
    const result = await wsCall(msg);
    return (saved ? `Alter Stand gesichert: ${saved}\n` : '') + output(result ?? 'OK', {}, msg.type);
  }

  if (args.path) {
    const method = (args.method || 'POST').toUpperCase();
    if (!['POST', 'DELETE'].includes(method)) throw new Error('method: POST oder DELETE');
    checkRest(args.path);
    if (payload !== undefined && BLOCK_IN_PAYLOAD.test(JSON.stringify(payload))) {
      throw new Error(`Daten enthalten gesperrte Services (${BLOCK_DOMAINS.join(', ')})`);
    }
    let saved = null;
    const m = args.path.match(/^\/api\/config\/(automation|script|scene)\/config\/([^/]+)$/);
    if (m) saved = await backup(m[1], m[2], () => restCall('GET', args.path));
    const result = await restCall(method, args.path, payload);
    return (saved ? `Alter Stand gesichert: ${saved}\n` : '') + output(result ?? 'OK', {}, args.path);
  }
  throw new Error('ws oder path angeben');
}

const SHAPE_PROPS = {
  select: { type: 'string', description: 'Teil der Antwort per Punkt-Pfad, z. B. "views.0.sections.2"' },
  grep: { type: 'string', description: 'Bei Listen: nur Eintraege, deren JSON diesen Text enthaelt (ohne Gross/Klein)' },
  fields: { type: 'array', items: { type: 'string' }, description: 'Bei Listen: nur diese Felder je Eintrag, z. B. ["entity_id","state"]' },
  save_as: { type: 'string', description: `Antwort als Datei unter ${FILES} speichern (relativer Name), z. B. "dashboard-internet.json"` },
};
const TOOLS = [
  {
    name: 'ha_read',
    description: 'Home Assistant lesen (WebSocket oder REST-GET). Aendert nichts. '
      + `Grosse Antworten (> ${MAX_CHARS} Zeichen) werden als Datei unter ${FILES} gespeichert. `
      + `Erlaubte WebSocket-Typen: ${[...READ_WS].join(', ')}.`,
    inputSchema: {
      type: 'object',
      properties: {
        ws: { type: 'object', description: 'WebSocket-Nachricht ohne id, z. B. {"type":"lovelace/config","url_path":"dashboard-internet"}' },
        get: { type: 'string', description: 'REST-Pfad fuer GET, z. B. "/api/config/automation/config/<id>" oder "/api/error_log"' },
        ...SHAPE_PROPS,
      },
    },
  },
  {
    name: 'ha_write',
    description: 'Home Assistant aendern (WebSocket-Befehl oder REST POST/DELETE), z. B. lovelace/config/save, '
      + 'input_number/create, config/entity_registry/update, call_service oder POST /api/config/automation/config/<id>. '
      + 'Dashboards, Automationen, Skripte und Szenen werden vorher unter backup/ gesichert. '
      + `Gesperrt: Auth, Integrationen (config_entries), Supervisor/Add-ons, Backups, Services der Domains ${BLOCK_DOMAINS.join('/')}.`,
    inputSchema: {
      type: 'object',
      properties: {
        ws: { type: 'object', description: 'WebSocket-Nachricht ohne id' },
        method: { type: 'string', enum: ['POST', 'DELETE'], description: 'fuer REST, Standard POST' },
        path: { type: 'string', description: 'REST-Pfad, z. B. "/api/config/automation/config/<id>"' },
        data: { description: 'JSON-Daten (REST-Body bzw. Feld data_key der WebSocket-Nachricht)' },
        data_file: { type: 'string', description: `statt data: JSON-Datei unter ${FILES}, z. B. die zuvor mit save_as geholte und bearbeitete Datei` },
        data_key: { type: 'string', description: 'Feldname fuer data/data_file in der WebSocket-Nachricht, Standard "config"' },
      },
    },
  },
];

// ---------------------------------------------------------------- MCP (JSON-RPC ueber stdio)
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

async function handle(msg) {
  switch (msg.method) {
    case 'initialize':
      return { protocolVersion: msg.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} },
               serverInfo: { name: 'hausmeister-homeassistant', version: '0.2.0' } };
    case 'ping': return {};
    case 'tools/list': return { tools: TOOLS };
    case 'tools/call': {
      const { name, arguments: args = {} } = msg.params || {};
      try {
        if (!HA_URL || !HA_TOKEN) throw new Error('HA_URL/HA_TOKEN fehlen in der Umgebung');
        const text = name === 'ha_read' ? await haRead(args)
                   : name === 'ha_write' ? await haWrite(args)
                   : (() => { throw new Error(`Unbekanntes Werkzeug ${name}`); })();
        return { content: [{ type: 'text', text }] };
      } catch (e) {
        return { content: [{ type: 'text', text: 'Fehler: ' + e.message }], isError: true };
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
