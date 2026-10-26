// Tests fuer den Filter der Remote-Control-Ausgabe (usr/local/lib/rc-log.pl): Zustand fuer HA und
// Login-Seite aus den Zeilen von 'claude remote-control', so wie die CLI sie zeichnet (Farben, Spinner, \r).
// Aufruf im Repo-Wurzelordner:  node --test claude_hausmeister/tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILTER = path.join(HERE, '..', 'rootfs', 'usr', 'local', 'lib', 'rc-log.pl');

const dim = (s) => `\x1b[2m${s}\x1b[22m`;
const gruen = (s) => `\x1b[32m${s}\x1b[39m`;
const gelb = (s) => `\x1b[33m${s}\x1b[39m`;
const NEU = '\x1b[1A\x1b[J';  // Statuszeile loeschen und neu zeichnen
const zeit = () => dim(`[${new Date().toTimeString().slice(0, 8)}]`);
const Z = {
  connecting: `${gelb('\u280b')} ${gelb('Connecting')}${dim(' \u00b7 ')}${dim('hausmeister')}\n`,
  ready: `${gruen('\u25cf')} ${gruen('Ready')}${dim(' \u00b7 ')}${dim('hausmeister')}${dim(' \u00b7 ')}${dim('HEAD')}\n`,
  connected: `\x1b[36m\u25cf\x1b[39m \x1b[36mConnected\x1b[39m${dim(' \u00b7 ')}${dim('hausmeister')}${dim(' \u00b7 ')}${dim('HEAD')}\n`,
  capacity: `    ${dim('Capacity: 0/5 \u00b7 New sessions will be created in the current directory')}\n`,
  reconnecting: `${gelb('\u280b')} ${gelb('Reconnecting')} ${dim('\u00b7')} ${dim('retrying in 1.8s')} ${dim('\u00b7')} ${dim('disconnected 0s')}\n`,
  reconnected: () => `${zeit()} ${gruen('Reconnected')} after 3s\n`,
  login: 'Error: You must be logged in to use Remote Control.\n',
};

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// Startet den Filter; schreib() schickt Ausgabe der CLI, zustand() liest die Statusdatei,
// ende() schliesst stdin und liefert das Add-on-Log.
function filter() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-log-'));
  const datei = path.join(dir, 'status');
  fs.writeFileSync(datei, JSON.stringify({ zustand: 'startet', text: 'Verbindet …', seit: 'start' }));
  const p = spawn('perl', [FILTER], { env: { ...process.env, ROLE: 'hausmeister', STATUS_FILE: datei } });
  let log = '';
  p.stdout.on('data', (d) => { log += d; });
  const zu = new Promise((r) => p.on('close', r));
  return {
    async schreib(...teile) { p.stdin.write(teile.join('')); await pause(150); },
    zustand: () => JSON.parse(fs.readFileSync(datei, 'utf8')),
    async ende() { p.stdin.end(); await zu; fs.rmSync(dir, { recursive: true, force: true }); return log; },
  };
}

test('Reconnecting -> Reconnected -> keine weitere Ausgabe: ok, seit = Wiederaufbau', async () => {
  const f = filter();
  await f.schreib(Z.connecting, NEU, Z.ready, Z.capacity);
  assert.equal(f.zustand().zustand, 'ok');
  await f.schreib(NEU, NEU, Z.reconnecting);
  const weg = f.zustand();
  assert.equal(weg.zustand, 'verbindung');
  await pause(1100);  // seit hat Sekundenaufloesung
  await f.schreib(NEU, Z.reconnected());
  // stdin bleibt offen: Zustand muss ohne weitere Zeile stimmen
  const da = f.zustand();
  assert.equal(da.zustand, 'ok');
  assert.equal(da.text, 'Verbunden');
  assert.notEqual(da.seit, weg.seit);
  assert.match(da.seit, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/);
  const log = await f.ende();
  assert.match(log, /\[hausmeister\] rc: \[\d\d:\d\d:\d\d\] Reconnected after 3s\n/);
});

test('Reconnected ohne Zeitstempel-Praefix', async () => {
  const f = filter();
  await f.schreib(Z.ready, Z.reconnecting);
  assert.equal(f.zustand().zustand, 'verbindung');
  await f.schreib(`${gruen('Reconnected')} after 12s\n`);
  assert.equal(f.zustand().zustand, 'ok');
  await f.ende();
});

test('Statuszeile nach dem Neuverbinden (Ready, ohne Reconnected-Zeile) gilt als ok', async () => {
  const f = filter();
  await f.schreib(Z.ready, Z.capacity, Z.reconnecting, Z.reconnecting, NEU, Z.ready, Z.capacity);
  assert.equal(f.zustand().zustand, 'ok');
  const log = await f.ende();
  // die wiederhergestellte Statuszeile erscheint auch im Log
  assert.equal(log.match(/rc: Ready · hausmeister · HEAD/g).length, 2);
});

test('Leerlauf nach dem Start (Ready) ist ok, nicht erst die erste Sitzung', async () => {
  const f = filter();
  await f.schreib(Z.connecting, NEU, Z.connecting, NEU);
  assert.equal(f.zustand().zustand, 'startet');
  await f.schreib(Z.ready, Z.capacity);
  assert.equal(f.zustand().zustand, 'ok');
  await f.schreib(NEU, Z.connected, Z.capacity);
  assert.equal(f.zustand().zustand, 'ok');
  await f.ende();
});

test('Statuszeile mit Sitzungstitel (Capacity 1): Kapazitaetszeile reicht', async () => {
  const f = filter();
  await f.schreib(Z.reconnecting, NEU, `${'\x1b[36m\u25cf\x1b[39m'} \x1b[36mWaermepumpe pruefen\x1b[39m\n`,
    `    ${dim('Capacity: 1/1 \u00b7 New sessions will be created in the current directory')}\n`);
  assert.equal(f.zustand().zustand, 'ok');
  await f.ende();
});

test('Aufblitzen der Statuszeile waehrend des Starts: zurueck auf startet, nicht verbindung', async () => {
  const f = filter();
  await f.schreib(Z.connecting, NEU, Z.ready, Z.capacity, NEU, Z.connecting);
  const z = f.zustand();
  assert.equal(z.zustand, 'startet');
  assert.equal(z.text, 'Verbindet …');
  await f.schreib(NEU, Z.ready);
  assert.equal(f.zustand().zustand, 'ok');
  await f.ende();
});

test('Login-Fehler und Sitzungszeilen', async () => {
  const f = filter();
  await f.schreib(Z.login);
  assert.equal(f.zustand().zustand, 'login');
  await f.ende();
  // Sitzungstitel, die mit "Ready"/"Connected" beginnen, sind keine Statuszeile
  const g = filter();
  await g.schreib(Z.reconnecting, '    Ready for review\n', '    Connected devices\n');
  assert.equal(g.zustand().zustand, 'verbindung');
  await g.ende();
});

test('Wiederholte Statuszeilen nur einmal im Log', async () => {
  const f = filter();
  await f.schreib(...Array(20).fill(NEU + Z.ready + Z.capacity));
  const log = await f.ende();
  assert.equal(log.match(/rc: Ready/g).length, 1);
  assert.equal(log.match(/rc: Capacity/g).length, 1);
});
