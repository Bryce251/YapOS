import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarness } from './helpers.js';
import { CSP, ACTIVITY_CSP, PERMISSIONS_POLICY, isActivityPath } from '../worker/security.js';
import { parseHeadersFile, headersFor, allowDevFraming, startDev, ACTIVITY_DEV_CSP } from '../dev.mjs';
import { createCall, LIMITS, jsonBytes } from '../dev/activity-dev/limits.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const devDir = path.join(root, 'dev', 'activity-dev');
const ACTIVITY_HTML = '<!doctype html><html><head><title>YapOS Party</title></head><body>party</body></html>';
const CONTRACT_CSP = "default-src 'self'; img-src 'self' https://files.yapper.website https://www.yapin.gg data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors https://www.yapin.gg https://yapin.gg https://www.yapper.website https://yapper.website; base-uri 'none'; form-action 'none'";

const WORDS_ETAG = '"words-1"';
const WORDS_BODY = ['aah', 'apple', 'zebra', ''].join('\n');

function activityAssets() {
  return {
    requests: [],
    async fetch(request) {
      const u = new URL(request.url);
      this.requests.push(u.pathname);
      const headers = { 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'" };
      if (u.pathname === '/activity/') return new Response(ACTIVITY_HTML, { status: 200, headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' } });
      if (u.pathname === '/activity/js/app.js') return new Response('export {};', { status: 200, headers: { ...headers, 'Content-Type': 'text/javascript' } });
      if (u.pathname === '/activity/data/words.txt') {
        const cache = { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=0, must-revalidate', ETag: WORDS_ETAG };
        if (request.headers.get('If-None-Match') === WORDS_ETAG) return new Response(null, { status: 304, headers: { ...headers, ...cache } });
        return new Response(WORDS_BODY, { status: 200, headers: { ...headers, ...cache } });
      }
      if (u.pathname === '/' || u.pathname === '/index.html') return new Response('<!doctype html><title>YapOS</title>', { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      return new Response('missing', { status: 404 });
    },
  };
}

function assertActivityHeaders(res, label, secure = true) {
  assert.equal(res.headers.get('Content-Security-Policy'), ACTIVITY_CSP, label);
  assert.equal(res.headers.get('X-Frame-Options'), null, label);
  assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff', label);
  assert.equal(res.headers.get('Permissions-Policy'), PERMISSIONS_POLICY, label);
  if (secure) assert.match(res.headers.get('Strict-Transport-Security') || '', /max-age=/, label);
}

function assertDashboardHeaders(res, label) {
  assert.equal(res.headers.get('Content-Security-Policy'), CSP, label);
  assert.equal(res.headers.get('X-Frame-Options'), 'DENY', label);
  assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff', label);
  assert.match(CSP, /frame-ancestors 'none'/);
}

test('the activity CSP matches the contract exactly and only lets Yapin pages frame it', () => {
  assert.equal(ACTIVITY_CSP, CONTRACT_CSP);
  const ancestors = /frame-ancestors ([^;]+)/.exec(ACTIVITY_CSP)[1].split(' ');
  assert.deepEqual(ancestors.sort(), ['https://www.yapin.gg', 'https://www.yapper.website', 'https://yapin.gg', 'https://yapper.website']);
  assert.equal(ACTIVITY_CSP.includes("'unsafe"), false);
  assert.equal(ACTIVITY_CSP.includes('*'), false);
});

test('only /activity and /activity/* count as activity paths', () => {
  for (const p of ['/activity', '/activity/', '/activity/js/app.js']) assert.equal(isActivityPath(p), true, p);
  for (const p of ['/', '/activity-dev/', '/activityx', '/activities', '/servers/activity', '/api/activity']) assert.equal(isActivityPath(p), false, p);
});

test('the Worker serves activity files from ASSETS with the activity headers', async () => {
  const assets = activityAssets();
  const h = createHarness({ ASSETS: assets });
  const page = await h.request('GET', '/activity/?dev=1');
  assert.equal(page.status, 200);
  assert.equal(await page.text(), ACTIVITY_HTML);
  assertActivityHeaders(page, 'page');
  const js = await h.request('GET', '/activity/js/app.js');
  assert.equal(js.status, 200);
  assertActivityHeaders(js, 'script');
  const head = await h.request('HEAD', '/activity/');
  assert.equal(head.status, 200);
  assertActivityHeaders(head, 'head');
  assert.deepEqual(assets.requests, ['/activity/', '/activity/js/app.js', '/activity/']);
});

test('the Worker serves the word list as cacheable text with the activity headers', async () => {
  const assets = activityAssets();
  const h = createHarness({ ASSETS: assets });
  const res = await h.request('GET', '/activity/data/words.txt');
  assert.equal(res.status, 200);
  assert.equal(await res.text(), WORDS_BODY);
  assert.match(res.headers.get('Content-Type') || '', /^text\/plain/);
  assert.doesNotMatch(res.headers.get('Cache-Control') || '', /no-store/);
  assert.equal(res.headers.get('ETag'), WORDS_ETAG);
  assertActivityHeaders(res, 'words');
  assert.match(ACTIVITY_CSP, /connect-src 'self'/);
  const again = await h.request('GET', '/activity/data/words.txt', { headers: { 'If-None-Match': WORDS_ETAG } });
  assert.equal(again.status, 304, 'a repeat visit can reuse the cached list');
  assertActivityHeaders(again, 'words 304');
});

test('the word list file is in place and loads with a relative URL', () => {
  const file = path.join(root, 'web', 'activity', 'data', 'words.txt');
  assert.equal(existsSync(file), true);
  const src = readFileSync(path.join(root, 'web', 'activity', 'js', 'dictionary.js'), 'utf8');
  assert.match(src, /new URL\('\.\.\/data\/words\.txt', import\.meta\.url\)/);
  assert.doesNotMatch(src, /https?:\/\//);
});

test('the activity headers drop HSTS on local http', async () => {
  const h = createHarness({ ASSETS: activityAssets(), PUBLIC_URL: 'http://localhost:8787' });
  const res = await h.request('GET', 'http://localhost:8787/activity/');
  assert.equal(res.status, 200);
  assertActivityHeaders(res, 'local', false);
  assert.equal(res.headers.get('Strict-Transport-Security'), null);
});

test('/activity redirects to /activity/ and keeps the query', async () => {
  const assets = activityAssets();
  const h = createHarness({ ASSETS: assets });
  const res = await h.request('GET', '/activity');
  assert.equal(res.status, 308);
  assert.equal(res.headers.get('Location'), '/activity/');
  assertActivityHeaders(res, 'redirect');
  const q = await h.request('GET', '/activity?dev=1&as=2');
  assert.equal(q.headers.get('Location'), '/activity/?dev=1&as=2');
  assert.deepEqual(assets.requests, []);
});

test('missing activity files are a plain 404 with the activity headers', async () => {
  const h = createHarness({ ASSETS: activityAssets() });
  for (const p of ['/activity/nope.js', '/activity/js/missing.js', '/activity/data/none.json']) {
    const res = await h.request('GET', p);
    assert.equal(res.status, 404, p);
    assert.equal(await res.text(), 'Page not found');
    assertActivityHeaders(res, p);
  }
});

test('activity paths only answer GET and HEAD', async () => {
  const assets = activityAssets();
  const h = createHarness({ ASSETS: assets });
  for (const m of ['POST', 'PUT', 'DELETE']) {
    const res = await h.request(m, '/activity/', { body: '{}' });
    assert.equal(res.status, 405, m);
    assertActivityHeaders(res, m);
  }
  assert.deepEqual(assets.requests, []);
});

test('a missing ASSETS binding gives a friendly 503 on activity paths', async () => {
  const h = createHarness({ ASSETS: undefined });
  const res = await h.request('GET', '/activity/');
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, 'not_configured');
  assertActivityHeaders(res, '503');
});

test('dashboard paths keep the strict headers', async () => {
  const h = createHarness({ ASSETS: activityAssets() });
  const responses = {
    spa: await h.request('GET', '/servers'),
    api: await h.request('GET', '/api/me'),
    missing: await h.request('GET', '/nope'),
    lookalike: await h.request('GET', '/activityx'),
    plural: await h.request('GET', '/activities/'),
    login: await h.request('GET', '/auth/login'),
  };
  for (const [label, res] of Object.entries(responses)) assertDashboardHeaders(res, label);
});

test('the Worker never serves the local test call', async () => {
  const assets = activityAssets();
  const h = createHarness({ ASSETS: assets });
  for (const p of ['/activity-dev', '/activity-dev/', '/activity-dev/harness.js', '/activity-dev/index.html']) {
    const res = await h.request('GET', p);
    assert.equal(res.status, 404, p);
    assertDashboardHeaders(res, p);
  }
  assert.deepEqual(assets.requests, []);
  assert.equal(existsSync(path.join(root, 'web', 'activity-dev')), false);
  assert.ok(existsSync(path.join(devDir, 'index.html')));
});

test('wrangler runs the Worker first for activity paths', () => {
  const toml = readFileSync(path.join(root, 'wrangler.toml'), 'utf8');
  const line = /^run_worker_first = (\[.*\])$/m.exec(toml);
  assert.ok(line);
  const list = JSON.parse(line[1]);
  for (const p of ['/api/*', '/auth/*', '/bot/*', '/activity', '/activity/*']) assert.ok(list.includes(p), p);
  assert.equal(list.some((p) => p.startsWith('/activity-dev')), false);
  assert.match(toml, /directory = "\.\/web"/);
});

test('_headers gives activity paths their own headers and keeps the rest strict', () => {
  const rules = parseHeadersFile(readFileSync(path.join(root, 'web', '_headers'), 'utf8'));
  for (const p of ['/', '/index.html', '/js/main.js', '/servers', '/activity-dev/', '/activityx']) {
    const hd = headersFor(rules, p, { secure: true });
    assert.equal(hd.get('Content-Security-Policy'), CSP, p);
    assert.equal(hd.get('X-Frame-Options'), 'DENY', p);
    assert.match(hd.get('Strict-Transport-Security') || '', /max-age=/, p);
  }
  for (const p of ['/activity', '/activity/', '/activity/js/app.js', '/activity/css/app.css']) {
    const hd = headersFor(rules, p, { secure: true });
    assert.equal(hd.get('Content-Security-Policy'), ACTIVITY_CSP, p);
    assert.equal(hd.get('X-Frame-Options'), null, p);
    assert.equal(hd.get('X-Content-Type-Options'), 'nosniff', p);
    assert.equal(hd.get('Permissions-Policy'), PERMISSIONS_POLICY, p);
  }
  const local = headersFor(rules, '/activity/', { secure: false });
  assert.equal(local.get('Strict-Transport-Security'), null);
});

test('dev framing is only loosened for ?dev=1 activity pages', () => {
  const make = () => new Response('x', { headers: { 'Content-Security-Policy': ACTIVITY_CSP } });
  const dev = allowDevFraming(make(), new URL('http://localhost:8787/activity/?dev=1&as=1'));
  assert.match(dev.headers.get('Content-Security-Policy'), /frame-ancestors 'self' https:\/\/www\.yapin\.gg/);
  const plain = allowDevFraming(make(), new URL('http://localhost:8787/activity/'));
  assert.equal(plain.headers.get('Content-Security-Policy'), ACTIVITY_CSP);
  const strict = new Response('x', { headers: { 'Content-Security-Policy': CSP } });
  assert.equal(allowDevFraming(strict, new URL('http://localhost:8787/activity/?dev=1')).headers.get('Content-Security-Policy'), CSP);
});

test('the test call files have no comments, no inline code and no forbidden wording', () => {
  const files = readdirSync(devDir);
  assert.deepEqual(files.sort(), ['harness.css', 'harness.js', 'index.html', 'limits.js']);
  for (const name of files) {
    const src = readFileSync(path.join(devDir, name), 'utf8');
    if (name.endsWith('.js')) assert.equal(src.includes('//') || src.includes('/*'), false, name);
    if (name.endsWith('.css')) {
      assert.equal(src.includes('/*'), false, name);
      assert.equal(/url\(/.test(src), false, name);
    }
    if (name.endsWith('.html')) {
      assert.equal(src.includes('<!--'), false, name);
      assert.equal(/style\s*=/.test(src), false, name);
      assert.equal(/<style/i.test(src), false, name);
      assert.equal(/\son[a-z]+\s*=/i.test(src), false, name);
      assert.equal(/<script(?![^>]*\bsrc=)[^>]*>/i.test(src), false, name);
    }
    for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function']) assert.equal(src.includes(bad), false, `${name} uses ${bad}`);
    assert.equal(/https?:\/\//.test(src), false, name);
    assert.equal(/\b(claude|anthropic)\b/i.test(src), false, name);
    assert.equal(/\bAI\b/.test(src), false, name);
    assert.equal(/\bgenerated\b/i.test(src), false, name);
  }
  const harness = readFileSync(path.join(devDir, 'harness.js'), 'utf8');
  assert.ok(harness.includes('/activity/?dev=1&as='));
  assert.ok(harness.includes("'allow-scripts allow-same-origin'"));
});

test('the test call enforces the key pattern and the 4 KB value limit', () => {
  const call = createCall({ now: () => 0 });
  for (const key of ['', 'a b', 'x'.repeat(65), 'no/slash', 'é', 5, null]) {
    const r = call.set('p1', key, 1);
    assert.equal(r.ok, false, String(key));
    assert.equal(r.code, 'bad_key');
  }
  for (const key of ['room', 'ink.0', 'a:b-c_d', 'x'.repeat(64)]) assert.equal(call.set('p1', key, 1).ok, true, key);
  const big = 'x'.repeat(LIMITS.valueBytes);
  assert.equal(call.set('p1', 'big', big).code, 'value_size');
  assert.equal(call.set('p1', 'fits', 'x'.repeat(LIMITS.valueBytes - 2)).ok, true);
  assert.equal(jsonBytes('x'.repeat(LIMITS.valueBytes - 2)), LIMITS.valueBytes);
  assert.equal(call.send('p1', { s: big }).code, 'message_size');
  assert.equal(call.set('p1', 'snow', '☃'.repeat(1400)).code, 'value_size');
  assert.equal(call.set('p1', 'room', null).ok, true);
  assert.equal('room' in call.snapshot(), false);
});

test('the test call enforces 256 keys and 64 KB of state', () => {
  let t = 0;
  const call = createCall({ now: () => t });
  for (let i = 0; i < LIMITS.keys; i += 1) {
    t += 200;
    assert.equal(call.set(`p${i % 50}`, `k${i}`, i).ok, true, `k${i}`);
  }
  assert.equal(call.keys, 256);
  t += 200;
  const over = call.set('p1', 'one-more', 1);
  assert.equal(over.code, 'too_many_keys');
  assert.equal(call.set('p1', 'k3', 'changed').ok, true);
  assert.equal(call.set('p1', 'k4', null).ok, true);
  assert.equal(call.set('p1', 'one-more', 1).ok, true);

  const roomy = createCall({ now: () => t });
  const chunk = 'x'.repeat(3900);
  let saved = 0;
  let last = null;
  for (let i = 0; i < 20; i += 1) {
    t += 200;
    last = roomy.set(`p${i}`, `ink.${i}`, chunk);
    if (!last.ok) break;
    saved += 1;
  }
  assert.equal(last.code, 'state_size');
  assert.ok(roomy.bytes <= LIMITS.stateBytes);
  assert.equal(saved, Math.floor(LIMITS.stateBytes / (3902 + 5)));
});

test('the test call enforces 100 ops per person and 600 per call in 10 seconds', () => {
  let t = 1000;
  const call = createCall({ now: () => t });
  for (let i = 0; i < LIMITS.perPerson; i += 1) assert.equal(call.send('p1', { i }).ok, true, `op ${i}`);
  const r = call.set('p1', 'room', 1);
  assert.equal(r.code, 'person_rate');
  assert.equal(r.personal, true);
  assert.equal(call.opsFor('p1'), 100);
  assert.equal(call.send('p2', 1).ok, true);
  t += LIMITS.windowMs;
  assert.equal(call.send('p1', 1).ok, true);

  const busy = createCall({ now: () => t });
  for (let p = 0; p < 6; p += 1) for (let i = 0; i < 100; i += 1) assert.equal(busy.send(`p${p}`, 1).ok, true);
  const full = busy.send('p9', 1);
  assert.equal(full.code, 'call_rate');
  assert.equal(full.personal, false);
  assert.equal(busy.callOpsCount(), 600);
  busy.clear();
  assert.equal(busy.callOpsCount(), 0);
  assert.deepEqual(busy.snapshot(), {});
});

let dev = null;

before(async () => {
  dev = await startDev({ port: 0, oauthPort: 0, dbFile: ':memory:', autoPoll: false, nudge: false, quiet: true });
});

after(async () => {
  await dev?.close();
});

test('the local server serves the test call only at /activity-dev/', async () => {
  const page = await fetch(`${dev.url}/activity-dev/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /YapOS Party test call/);
  assert.equal(page.headers.get('Content-Security-Policy'), ACTIVITY_DEV_CSP);
  assert.equal(page.headers.get('X-Frame-Options'), 'DENY');
  for (const f of ['harness.js', 'limits.js', 'harness.css']) {
    const res = await fetch(`${dev.url}/activity-dev/${f}`);
    assert.equal(res.status, 200, f);
    await res.arrayBuffer();
  }
  const redirect = await fetch(`${dev.url}/activity-dev`, { redirect: 'manual' });
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.get('Location'), '/activity-dev/');
  for (const p of ['/activity-dev/nope.js', '/activity-dev/../dev.mjs', '/activity-dev/%2e%2e/dev.mjs', '/activity-dev/sub/x.js']) {
    const res = await fetch(`${dev.url}${p}`);
    assert.equal(res.status, 404, p);
    await res.arrayBuffer();
  }
});

test('the local server serves the real word list as cacheable text', async () => {
  const file = path.join(root, 'web', 'activity', 'data', 'words.txt');
  const res = await fetch(`${dev.url}/activity/data/words.txt`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('Content-Type') || '', /^text\/plain/);
  assert.doesNotMatch(res.headers.get('Cache-Control') || '', /no-store/);
  assertActivityHeaders(res, 'words', false);
  const body = await res.text();
  assert.equal(body.length, readFileSync(file, 'utf8').length);
  assert.ok(body.startsWith('aaa\n'));
});

test('the local server mirrors the Worker for activity paths', async () => {
  const redirect = await fetch(`${dev.url}/activity?dev=1&as=1`, { redirect: 'manual' });
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.get('Location'), '/activity/?dev=1&as=1');
  const missing = await fetch(`${dev.url}/activity/nope-not-here.js`);
  assert.equal(missing.status, 404);
  await missing.arrayBuffer();
  assertActivityHeaders(missing, 'missing', false);
  const dash = await fetch(`${dev.url}/`);
  assert.equal(dash.headers.get('Content-Security-Policy'), CSP);
  assert.equal(dash.headers.get('X-Frame-Options'), 'DENY');
  await dash.arrayBuffer();
  if (existsSync(path.join(root, 'web', 'activity', 'index.html'))) {
    const page = await fetch(`${dev.url}/activity/`);
    assert.equal(page.status, 200);
    await page.arrayBuffer();
    assertActivityHeaders(page, 'page', false);
    const framed = await fetch(`${dev.url}/activity/?dev=1&as=2`);
    assert.equal(framed.status, 200);
    await framed.arrayBuffer();
    assert.match(framed.headers.get('Content-Security-Policy'), /frame-ancestors 'self' https:/);
    assert.equal(framed.headers.get('X-Frame-Options'), null);
  }
});
