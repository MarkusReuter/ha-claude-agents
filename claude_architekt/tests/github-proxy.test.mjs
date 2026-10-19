// Tests fuer den GitHub-Proxy des Architekten (ohne Abhaengigkeiten).
// Aufruf im Repo-Wurzelordner:  node --test claude_architekt/tests/
// Ein Fake-GitHub (node:http + 'git http-backend' als CGI) bedient Git Smart HTTP und eine Mini-API.
// Geprueft wird mit dem echten git-Client: clone/fetch, erlaubte und verbotene Pushes, grosse Pushes.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROXY = path.join(HERE, '..', 'rootfs', 'opt', 'github-proxy', 'proxy.mjs');
const { createProxy, parseCommands, refDenied, apiRoute, apiBodyError, uploadRoute, pkt } = await import(pathToFileURL(PROXY).href);

const OWNER = 'MarkusReuter';
const TOKEN = 'github_pat_geheim0123456789';
const BASIC = 'Basic ' + Buffer.from(`x-access-token:${TOKEN}`).toString('base64');
const Z = '0'.repeat(40);
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const cfg = { owner: OWNER, prefix: 'claude/', austausch: 'private-data' };

// ---------------------------------------------------------------- Unit-Tests

describe('parseCommands', () => {
  test('erste Zeile mit Faehigkeiten, weitere Zeilen, Flush', async () => {
    const buf = Buffer.concat([
      pkt(`${A} ${B} refs/heads/claude/x\0report-status side-band-64k\n`),
      pkt(`${Z} ${B} refs/tags/v1\n`),
      Buffer.from('0000PACK...'),
    ]);
    const r = parseCommands(buf);
    assert.deepEqual(r.commands.map((c) => c.ref), ['refs/heads/claude/x', 'refs/tags/v1']);
    assert.deepEqual(r.caps, ['report-status', 'side-band-64k']);
  });
  test('unvollstaendig -> null', async () => {
    const full = pkt(`${A} ${B} refs/heads/main\0report-status\n`);
    assert.equal(parseCommands(full.subarray(0, 10)), null);
    assert.equal(parseCommands(full), null);
  });
  test('nur Flush (Probe-Request) -> keine Befehle', async () => {
    assert.deepEqual(parseCommands(Buffer.from('0000')), { commands: [], caps: [] });
  });
  test('Muell und push-cert werden abgelehnt', async () => {
    assert.ok(parseCommands(Buffer.from('zzzz')).error);
    assert.ok(parseCommands(Buffer.concat([pkt('push-cert\0report-status\n'), Buffer.from('0000')])).error);
    assert.ok(parseCommands(Buffer.concat([pkt(`${A} ${B} refs/heads/a b\n`), Buffer.from('0000')])).error);
  });
});

describe('refDenied', () => {
  const d = (ref, repo = 'demo', neu = B) => refDenied({ old: A, neu, ref }, repo, cfg);
  test('claude/* erlaubt, auch loeschen', async () => {
    assert.equal(d('refs/heads/claude/feature-1'), null);
    assert.equal(d('refs/heads/claude/x', 'demo', Z), null);
  });
  test('main, andere Branches, Tags, Notes verboten', async () => {
    assert.ok(d('refs/heads/main'));
    assert.ok(d('refs/heads/claude'));
    assert.ok(d('refs/heads/claude/'));
    assert.ok(d('refs/heads/feature/claude/x'));
    assert.ok(d('refs/tags/v1.0.0'));
    assert.ok(d('refs/notes/commits'));
    assert.ok(d('refs/heads/claude/../main'));
  });
  test('Austausch-Repo: alle Branches, aber keine Tags und kein Loeschen ausserhalb claude/*', async () => {
    assert.equal(d('refs/heads/main', 'private-data'), null);
    assert.equal(d('refs/heads/main', 'Private-Data'), null);
    assert.ok(d('refs/heads/main', 'private-data', Z));
    assert.ok(d('refs/tags/v1', 'private-data'));
  });
});

describe('apiRoute / apiBodyError', () => {
  test('lesen im eigenen Owner erlaubt', async () => {
    assert.equal(apiRoute('GET', '/repos/MarkusReuter/demo/pulls', OWNER), '');
    assert.equal(apiRoute('GET', '/repos/markusreuter/demo', OWNER), '');
    assert.equal(apiRoute('GET', '/repos/MarkusReuter/demo/actions/runs/1/logs', OWNER), '');
    assert.equal(apiRoute('GET', '/user/repos', OWNER), '');
  });
  test('fremde Owner, Secrets, Schreib-APIs verboten', async () => {
    for (const [m, p] of [
      ['GET', '/repos/someone/demo'],
      ['GET', '/repos/MarkusReuter/demo/actions/secrets'],
      ['GET', '/repos/MarkusReuter/demo/environments'],
      ['GET', '/repos/MarkusReuter/demo/keys'],
      ['GET', '/user'],
      ['POST', '/graphql'],
      ['PUT', '/repos/MarkusReuter/demo/pulls/1/merge'],
      ['PUT', '/repos/MarkusReuter/demo/contents/README.md'],
      ['POST', '/repos/MarkusReuter/demo/releases'],
      ['POST', '/repos/MarkusReuter/demo/git/refs'],
      ['POST', '/repos/MarkusReuter/demo/actions/workflows/x.yml/dispatches'],
      ['PATCH', '/repos/MarkusReuter/demo'],
      ['DELETE', '/repos/MarkusReuter/demo'],
      ['GET', '/repos/MarkusReuter/../x/demo'],
      ['GET', '/repos/MarkusReuter/demo%2f..%2fsecrets'],
    ]) assert.equal(apiRoute(m, p, OWNER), null, `${m} ${p}`);
  });
  test('Pakete (Releases paket-*) nur im Austausch-Repo', async () => {
    const PD = 'private-data';
    assert.equal(apiRoute('POST', `/repos/${OWNER}/private-data/releases`, OWNER, PD), 'createRelease');
    assert.equal(apiRoute('DELETE', `/repos/${OWNER}/Private-Data/releases/5`, OWNER, PD), '');
    assert.equal(apiRoute('DELETE', `/repos/${OWNER}/private-data/git/refs/tags/paket-20261019-173511-warmwasser`, OWNER, PD), '');
    assert.equal(apiRoute('DELETE', `/repos/${OWNER}/private-data/git/refs/tags/v1.0`, OWNER, PD), null);
    assert.equal(apiRoute('DELETE', `/repos/${OWNER}/private-data/git/refs/heads/main`, OWNER, PD), null);
    assert.equal(apiRoute('PATCH', `/repos/${OWNER}/private-data/releases/5`, OWNER, PD), null);
    assert.equal(apiRoute('POST', `/repos/${OWNER}/paperless-go/releases`, OWNER, PD), null);
    assert.equal(apiRoute('DELETE', `/repos/${OWNER}/paperless-go/git/refs/tags/paket-x`, OWNER, PD), null);
    assert.equal(apiRoute('POST', `/repos/${OWNER}/private-data/releases`, OWNER, ''), null);
    assert.equal(apiRoute('DELETE', `/repos/${OWNER}/private-data`, OWNER, PD), null);
    assert.equal(apiRoute('PUT', `/repos/${OWNER}/private-data/contents/x`, OWNER, PD), null);
    assert.equal(apiBodyError('createRelease', Buffer.from('{"tag_name":"paket-20261019-180000-heizlast","name":"Heizlast","make_latest":"false","body":"x"}')), null);
    assert.ok(apiBodyError('createRelease', Buffer.from('{"tag_name":"v2.0.0","name":"Release"}')));
    assert.ok(apiBodyError('createRelease', Buffer.from('{"name":"ohne Tag"}')));
    assert.ok(apiBodyError('createRelease', Buffer.from('{"tag_name":"paket-x","target_commitish":"claude/boese"}')));
    const q = (s) => new URLSearchParams(s);
    assert.equal(uploadRoute('POST', `/repos/${OWNER}/private-data/releases/5/assets`, q('name=a.pdf'), OWNER, PD), true);
    assert.equal(uploadRoute('POST', `/repos/${OWNER}/paperless-go/releases/5/assets`, q('name=a.apk'), OWNER, PD), false);
    assert.equal(uploadRoute('POST', `/repos/${OWNER}/private-data/releases/5/assets`, q('name=a&x=1'), OWNER, PD), false);
    assert.equal(uploadRoute('GET', `/repos/${OWNER}/private-data/releases/5/assets`, q('name=a'), OWNER, PD), false);
  });
  test('Pull Request / Kommentar: nur bekannte Felder', async () => {
    assert.equal(apiRoute('POST', '/repos/MarkusReuter/demo/pulls', OWNER), 'createPull');
    assert.equal(apiBodyError('createPull', Buffer.from('{"title":"x","head":"claude/x","base":"main","body":"y"}')), null);
    assert.ok(apiBodyError('createPull', Buffer.from('{"title":"x","head":"claude/x","base":"main","merge":true}')));
    assert.equal(apiBodyError('updatePull', Buffer.from('{"state":"closed"}')), null);
    assert.ok(apiBodyError('updatePull', Buffer.from('{"state":"merged"}')));
    assert.ok(apiBodyError('updatePull', Buffer.from('{"base":"other"}')));
    assert.ok(apiBodyError('comment', Buffer.from('[1]')));
    assert.ok(apiBodyError('', Buffer.from('x')));
  });
});

// ---------------------------------------------------------------- Integration mit git

const hasGit = spawnSync('git', ['--version']).status === 0
  && fs.existsSync(path.join(spawnSync('git', ['--exec-path']).stdout.toString().trim(), 'git-http-backend'));

describe('git ueber den Proxy', { skip: !hasGit && 'git http-backend fehlt' }, () => {
  let tmp, upstream, proxy, proxyUrl, upRequests, gitEnv, proxyLog;

  // Lokale git-Befehle synchron; alles mit Netz asynchron (Proxy und Fake-GitHub laufen in diesem Prozess)
  const run = (args, opts = {}) => spawnSync('git', args, { env: gitEnv, encoding: 'utf8', ...opts });
  const net = (args) => new Promise((resolve) => {
    const p = spawn('git', args, { env: gitEnv });
    let stdout = '', stderr = '';
    p.stdout.on('data', (c) => { stdout += c; });
    p.stderr.on('data', (c) => { stderr += c; });
    p.on('close', (status) => resolve({ status, stdout, stderr }));
  });
  const bare = (repo) => path.join(tmp, 'up', OWNER, `${repo}.git`);
  const upRef = (repo, ref) => {
    const r = spawnSync('git', ['--git-dir', bare(repo), 'rev-parse', '--verify', '-q', ref], { encoding: 'utf8' });
    return r.status === 0 ? r.stdout.trim() : null;
  };

  // Fake-GitHub: /<owner>/<repo>.git/... per git http-backend, /api/... als Echo
  function fakeGithub(req, res) {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      upRequests.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      const url = new URL(req.url, 'http://x');
      if (url.pathname.startsWith('/upl/')) {
        res.writeHead(201, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ path: url.pathname, name: url.searchParams.get('name'), size: body.length, auth: req.headers.authorization === `Bearer ${TOKEN}` }));
      }
      if (url.pathname.startsWith('/api/')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, path: url.pathname, auth: req.headers.authorization === `Bearer ${TOKEN}` }));
      }
      if (req.headers.authorization !== BASIC) {
        res.writeHead(401, { 'www-authenticate': 'Basic realm="GitHub"' });
        return res.end();
      }
      const env = {
        PATH: process.env.PATH, GIT_PROJECT_ROOT: path.join(tmp, 'up'), GIT_HTTP_EXPORT_ALL: '1',
        REMOTE_USER: 'x-access-token', REMOTE_ADDR: '127.0.0.1',
        PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1), REQUEST_METHOD: req.method,
        CONTENT_TYPE: req.headers['content-type'] || '', CONTENT_LENGTH: String(body.length),
      };
      if (req.headers['content-encoding']) env.HTTP_CONTENT_ENCODING = req.headers['content-encoding'];
      if (req.headers['git-protocol']) env.GIT_PROTOCOL = req.headers['git-protocol'];
      const cgi = spawn('git', ['http-backend'], { env });
      const out = [];
      cgi.stdout.on('data', (c) => out.push(c));
      cgi.on('close', () => {
        const all = Buffer.concat(out);
        const sep = all.indexOf('\r\n\r\n') >= 0 ? all.indexOf('\r\n\r\n') : all.indexOf('\n\n');
        const sepLen = all[sep] === 13 ? 4 : 2;
        const head = all.subarray(0, sep).toString();
        let status = 200;
        const headers = {};
        for (const line of head.split(/\r?\n/)) {
          const i = line.indexOf(':');
          if (i < 0) continue;
          const k = line.slice(0, i).trim().toLowerCase();
          const v = line.slice(i + 1).trim();
          if (k === 'status') status = parseInt(v, 10); else headers[k] = v;
        }
        res.writeHead(status, headers);
        res.end(all.subarray(sep + sepLen));
      });
      cgi.stdin.end(body);
    });
  }

  function initUpstream(repo) {
    const work = path.join(tmp, `init-${repo}`);
    fs.mkdirSync(work, { recursive: true });
    run(['init', '-q', '-b', 'main', work]);
    fs.writeFileSync(path.join(work, 'README.md'), `# ${repo}\n`);
    run(['-C', work, 'add', '.']);
    run(['-C', work, 'commit', '-qm', 'init']);
    fs.mkdirSync(path.dirname(bare(repo)), { recursive: true });
    run(['clone', '-q', '--bare', work, bare(repo)]);
  }

  function clone(repo, dir) {
    return net(['clone', '-q', `${proxyUrl}/git/${OWNER}/${repo}.git`, path.join(tmp, dir)]);
  }
  function commit(dir, file, content) {
    fs.writeFileSync(path.join(tmp, dir, file), content);
    run(['-C', path.join(tmp, dir), 'add', '.']);
    return run(['-C', path.join(tmp, dir), 'commit', '-qm', `add ${file}`]);
  }

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ghproxy-'));
    gitEnv = {
      PATH: process.env.PATH, HOME: tmp, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x',
    };
    upRequests = [];
    proxyLog = [];
    initUpstream('demo');
    initUpstream('private-data');
    upstream = http.createServer(fakeGithub);
    await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${upstream.address().port}`;
    proxy = createProxy({ ...cfg, token: TOKEN, gitBase: base, apiBase: `${base}/api`, uploadBase: `${base}/upl`, log: (...a) => proxyLog.push(a.join(' ')) });
    await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
    proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
  });
  after(() => {
    proxy?.close();
    upstream?.close();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('clone mit Token beim Upstream, ohne Token beim Client', async () => {
    const r = await clone('demo', 'c1');
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(path.join(tmp, 'c1', 'README.md')));
    assert.ok(upRequests.length > 0 && upRequests.every((q) => q.url.startsWith('/api/') || q.url.startsWith('/upl/') || q.auth === BASIC));
  });

  test('Push auf claude/* geht durch', async () => {
    commit('c1', 'a.txt', 'a\n');
    const r = await net(['-C', path.join(tmp, 'c1'), 'push', '-q', 'origin', 'HEAD:refs/heads/claude/feature']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(upRef('demo', 'refs/heads/claude/feature'), run(['-C', path.join(tmp, 'c1'), 'rev-parse', 'HEAD']).stdout.trim());
  });

  test('Push auf main wird mit Begruendung abgelehnt, main bleibt', async () => {
    const vorher = upRef('demo', 'refs/heads/main');
    const r = await net(['-C', path.join(tmp, 'c1'), 'push', 'origin', 'HEAD:main']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /claude\//);
    assert.equal(upRef('demo', 'refs/heads/main'), vorher);
  });

  test('Tag-Push wird abgelehnt', async () => {
    run(['-C', path.join(tmp, 'c1'), 'tag', 'v9.9.9']);
    const r = await net(['-C', path.join(tmp, 'c1'), 'push', 'origin', 'refs/tags/v9.9.9']);
    assert.notEqual(r.status, 0);
    assert.equal(upRef('demo', 'refs/tags/v9.9.9'), null);
  });

  test('gemischter Push (claude/* + main) wird komplett abgelehnt', async () => {
    commit('c1', 'b.txt', 'b\n');
    const r = await net(['-C', path.join(tmp, 'c1'), 'push', 'origin', 'HEAD:refs/heads/claude/zwei', 'HEAD:main']);
    assert.notEqual(r.status, 0);
    assert.equal(upRef('demo', 'refs/heads/claude/zwei'), null);
  });

  test('grosser Push (Probe-Request + chunked) auf claude/* geht durch', async () => {
    const big = Buffer.alloc(300 * 1024);
    for (let i = 0; i < big.length; i++) big[i] = (i * 7919 + (i >> 8) * 31) & 0xff;
    fs.writeFileSync(path.join(tmp, 'c1', 'big.bin'), big);
    run(['-C', path.join(tmp, 'c1'), 'add', '.']);
    run(['-C', path.join(tmp, 'c1'), 'commit', '-qm', 'big']);
    const r = await net(['-C', path.join(tmp, 'c1'), '-c', 'http.postBuffer=1024', 'push', '-q', 'origin', 'HEAD:refs/heads/claude/gross']);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(upRef('demo', 'refs/heads/claude/gross'));
  });

  test('grosser Push auf main wird abgelehnt', async () => {
    const r = await net(['-C', path.join(tmp, 'c1'), '-c', 'http.postBuffer=1024', 'push', 'origin', 'HEAD:main']);
    assert.notEqual(r.status, 0);
    assert.notEqual(upRef('demo', 'refs/heads/main'), run(['-C', path.join(tmp, 'c1'), 'rev-parse', 'HEAD']).stdout.trim());
  });

  test('claude/* loeschen geht', async () => {
    const r = await net(['-C', path.join(tmp, 'c1'), 'push', '-q', 'origin', ':refs/heads/claude/feature']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(upRef('demo', 'refs/heads/claude/feature'), null);
  });

  test('freies Repo: Push auf main geht, Loeschen von main nicht', async () => {
    assert.equal((await clone('private-data', 'pd')).status, 0);
    commit('pd', 'daten.txt', 'x\n');
    const r = await net(['-C', path.join(tmp, 'pd'), 'push', '-q', 'origin', 'HEAD:main']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(upRef('private-data', 'refs/heads/main'), run(['-C', path.join(tmp, 'pd'), 'rev-parse', 'HEAD']).stdout.trim());
    const d = await net(['-C', path.join(tmp, 'pd'), 'push', 'origin', ':main']);
    assert.notEqual(d.status, 0);
    assert.ok(upRef('private-data', 'refs/heads/main'));
  });

  test('fremder Owner wird nicht weitergeleitet', async () => {
    const n = upRequests.length;
    const r = await net(['ls-remote', `${proxyUrl}/git/someone/demo.git`]);
    assert.notEqual(r.status, 0);
    assert.equal(upRequests.length, n);
  });

  test('API: erlaubte Aufrufe mit Token, verbotene ohne Upstream-Kontakt', async () => {
    const get = await fetch(`${proxyUrl}/api/repos/${OWNER}/demo/pulls`);
    assert.equal(get.status, 200);
    assert.equal((await get.json()).auth, true);
    const n = upRequests.length;
    const merge = await fetch(`${proxyUrl}/api/repos/${OWNER}/demo/pulls/1/merge`, { method: 'PUT' });
    assert.equal(merge.status, 403);
    const extra = await fetch(`${proxyUrl}/api/repos/${OWNER}/demo/pulls`, { method: 'POST', body: '{"title":"x","head":"claude/x","base":"main","auto_merge":true}' });
    assert.equal(extra.status, 400);
    assert.equal(upRequests.length, n);
    const pr = await fetch(`${proxyUrl}/api/repos/${OWNER}/demo/pulls`, { method: 'POST', body: '{"title":"x","head":"claude/x","base":"main"}' });
    assert.equal(pr.status, 200);
  });

  test('Release-Datei hochladen: Austausch-Repo ja (gestreamt, mit Token), anderes Repo nein', async () => {
    const data = Buffer.alloc(2 * 1024 * 1024, 7);
    const ok = await fetch(`${proxyUrl}/uploads/repos/${OWNER}/private-data/releases/5/assets?name=plan.pdf`,
      { method: 'POST', body: data, headers: { 'content-type': 'application/pdf' } });
    assert.equal(ok.status, 201);
    const j = await ok.json();
    assert.deepEqual([j.path, j.name, j.size, j.auth], [`/upl/repos/${OWNER}/private-data/releases/5/assets`, 'plan.pdf', data.length, true]);
    const n = upRequests.length;
    const nein = await fetch(`${proxyUrl}/uploads/repos/${OWNER}/paperless-go/releases/5/assets?name=x.apk`, { method: 'POST', body: 'x' });
    assert.equal(nein.status, 403);
    assert.equal(upRequests.length, n);
  });

  test('Token taucht in keiner Proxy-Antwort und keinem Log auf', async () => {
    for (const p of ['/', '/git/someone/x.git/info/refs?service=git-upload-pack', `/api/repos/${OWNER}/demo/actions/secrets`]) {
      const t = await (await fetch(proxyUrl + p)).text();
      assert.ok(!t.includes(TOKEN));
    }
    assert.ok(!proxyLog.join('\n').includes(TOKEN));
  });
});
