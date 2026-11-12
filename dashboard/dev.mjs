import http from 'node:http';
import { readFile, stat, mkdir, rm } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createWorker } from './worker/app.js';
import { D1Database } from './test/d1-shim.js';
import { createHarness, IDS } from '../test/harness.js';
import { createDashboard } from '../engine/dashboard.js';
import { createLogger } from '../engine/log.js';
import { monthKey, shiftMonth } from '../apps/wrapped.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(HERE, 'web');
const DEV_DIR = path.join(HERE, '.dev');
const SCHEMA = readFileSync(path.join(HERE, 'schema.sql'), 'utf8');
const CLIENT_ID = 'b21fe402-0f20-43df-867b-8b346029fd8d';
const WORKER_FIRST = [/^\/api(\/|$)/, /^\/auth(\/|$)/, /^\/bot(\/|$)/];
const SKIP_HEADERS = new Set(['host', 'connection', 'keep-alive', 'transfer-encoding', 'cf-connecting-ip', 'upgrade']);
const CLEANUP_EVERY_MS = 15 * 60_000;
const CODE_TTL_MS = 5 * 60_000;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

export const OUTSIDER_ID = 'a0000000-0000-4000-8000-0000000000ff';

export const TEST_USERS = [
  { key: 'alex', id: IDS.admin, username: 'alex', display_name: 'Alex', role: 'Admin of Test Town' },
  { key: 'jolli', id: IDS.owner, username: 'jolli', display_name: 'Jolli', role: 'Owner of Test Town' },
  { key: 'morgan', id: IDS.mod, username: 'morgan', display_name: 'Morgan', role: 'Moderator of Test Town (not an admin)' },
  { key: 'sam', id: IDS.member, username: 'sam', display_name: 'Sam', role: 'Member of Test Town' },
  { key: 'taylor', id: OUTSIDER_ID, username: 'taylor', display_name: 'Taylor', role: 'Not in Test Town' },
];

export function parseHeadersFile(text) {
  const rules = [];
  let current = null;
  for (const raw of String(text).split(/\r?\n/)) {
    if (!raw.trim()) continue;
    if (!/^\s/.test(raw)) {
      const pattern = raw.trim();
      const source = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/:[A-Za-z]\w*/g, '[^/]+');
      current = { pattern, re: new RegExp(`^${source}$`), headers: [] };
      rules.push(current);
      continue;
    }
    if (!current) continue;
    const line = raw.trim();
    const i = line.indexOf(':');
    if (i <= 0) continue;
    current.headers.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]);
  }
  return rules;
}

function createAssets({ dir = WEB, secure = false } = {}) {
  const headersPath = path.join(dir, '_headers');
  const rules = existsSync(headersPath) ? parseHeadersFile(readFileSync(headersPath, 'utf8')) : [];
  async function resolve(pathname) {
    let decoded;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return null;
    }
    const parts = decoded.split('/').filter(Boolean);
    if (parts.some((p) => p === '..' || p.startsWith('.') || p.startsWith('_') || p.includes('\\'))) return null;
    const candidates = decoded.endsWith('/') ? [path.join(dir, ...parts, 'index.html')] : [path.join(dir, ...parts)];
    for (const file of candidates) {
      if (!file.startsWith(dir)) continue;
      const info = await stat(file).catch(() => null);
      if (info && info.isFile()) return file;
    }
    return null;
  }
  return {
    rules,
    async fetch(input, init) {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
      const file = await resolve(url.pathname);
      if (!file) return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      const body = await readFile(file);
      const headers = new Headers({
        'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'public, max-age=0, must-revalidate',
      });
      for (const rule of rules) {
        if (!rule.re.test(url.pathname)) continue;
        for (const [k, v] of rule.headers) {
          if (!secure && k.toLowerCase() === 'strict-transport-security') continue;
          headers.set(k, v);
        }
      }
      return new Response(request.method === 'HEAD' ? null : body, { status: 200, headers });
    },
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function toRequest(req, origin) {
  const headers = new Headers();
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i];
    if (SKIP_HEADERS.has(name.toLowerCase())) continue;
    headers.append(name, req.rawHeaders[i + 1]);
  }
  headers.set('CF-Connecting-IP', req.socket.remoteAddress || '127.0.0.1');
  const init = { method: req.method, headers };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const body = await readBody(req);
    if (body.length) init.body = body;
  }
  return new Request(new URL(req.url, origin).href, init);
}

async function writeResponse(res, response, method) {
  const headers = {};
  response.headers.forEach((v, k) => {
    if (k !== 'set-cookie') headers[k] = v;
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length) headers['set-cookie'] = cookies;
  const body = method === 'HEAD' || !response.body ? null : Buffer.from(await response.arrayBuffer());
  res.writeHead(response.status, headers);
  res.end(body);
}

function serve(handler, port) {
  const server = http.createServer(async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Internal error');
      console.error(`[dev] request failed: ${err?.name || 'Error'}`);
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, 'localhost', () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function htmlPage(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font:16px system-ui,sans-serif;max-width:480px;margin:48px auto;padding:0 16px;color:#1c1c1f;background:#f6f6f8}h1{font-size:20px}p{color:#55555c}ul{list-style:none;padding:0}li{margin:8px 0}a.user{display:block;padding:12px 16px;border:1px solid #d8d8de;border-radius:8px;background:#fff;color:inherit;text-decoration:none}a.user:hover,a.user:focus{border-color:#f2613f;outline:none}a.user small{display:block;color:#6b6b73}.cancel{color:#55555c}</style></head><body>${body}</body></html>`;
}

function createFakeOAuth({ users, clientId, clientSecret, redirectUri }) {
  const codes = new Map();
  const tokens = new Map();
  const byKey = new Map(users.map((u) => [u.key, u]));
  const json = (res, status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data));
  };
  const html = (res, status, title, body) => {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; frame-ancestors 'none'" });
    res.end(htmlPage(title, body));
  };
  const redirect = (res, location) => {
    res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
    res.end();
  };
  const checkClient = (q) => q.get('client_id') === clientId() && q.get('redirect_uri') === redirectUri() && /^[A-Za-z0-9_-]{1,128}$/.test(q.get('state') || '');

  async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const q = url.searchParams;
    if (req.method === 'GET' && url.pathname === '/oauth/authorize') {
      if (!checkClient(q) || q.get('response_type') !== 'code') return html(res, 400, 'Bad sign-in request', '<h1>Bad sign-in request</h1><p>The client id, redirect address or state is wrong.</p>');
      const pass = new URLSearchParams({ state: q.get('state'), redirect_uri: q.get('redirect_uri'), client_id: q.get('client_id') });
      const items = users.map((u) => `<li><a class="user" href="/oauth/approve?${escapeHtml(new URLSearchParams({ ...Object.fromEntries(pass), user: u.key }).toString())}">${escapeHtml(u.display_name)} <small>@${escapeHtml(u.username)} · ${escapeHtml(u.role)}</small></a></li>`).join('');
      return html(res, 200, 'Local test sign-in', `<h1>Local test sign-in</h1><p>This page stands in for Yapin' sign-in while you work on the dashboard locally. Pick who to sign in as.</p><ul>${items}</ul><p><a class="cancel" href="/oauth/deny?${escapeHtml(pass.toString())}">Cancel</a></p>`);
    }
    if (req.method === 'GET' && url.pathname === '/oauth/approve') {
      const user = byKey.get(q.get('user') || '');
      if (!checkClient(q) || !user) return html(res, 400, 'Bad sign-in request', '<h1>Bad sign-in request</h1>');
      const code = randomBytes(24).toString('base64url');
      codes.set(code, { user, expires: Date.now() + CODE_TTL_MS });
      const back = new URL(redirectUri());
      back.searchParams.set('code', code);
      back.searchParams.set('state', q.get('state'));
      return redirect(res, back.href);
    }
    if (req.method === 'GET' && url.pathname === '/oauth/deny') {
      if (!checkClient(q)) return html(res, 400, 'Bad sign-in request', '<h1>Bad sign-in request</h1>');
      const back = new URL(redirectUri());
      back.searchParams.set('error', 'access_denied');
      back.searchParams.set('state', q.get('state'));
      return redirect(res, back.href);
    }
    if (req.method === 'POST' && url.pathname === '/api/oauth/token') {
      const form = new URLSearchParams((await readBody(req)).toString('utf8'));
      if (form.get('client_id') !== clientId() || form.get('client_secret') !== clientSecret()) return json(res, 401, { error: 'invalid_client' });
      if (form.get('grant_type') !== 'authorization_code') return json(res, 400, { error: 'unsupported_grant_type' });
      if (form.get('redirect_uri') !== redirectUri()) return json(res, 400, { error: 'invalid_grant' });
      const entry = codes.get(form.get('code') || '');
      codes.delete(form.get('code') || '');
      if (!entry || entry.expires < Date.now()) return json(res, 400, { error: 'invalid_grant' });
      const token = randomBytes(24).toString('base64url');
      tokens.set(token, entry.user);
      return json(res, 200, { access_token: token, token_type: 'Bearer', expires_in: 3600, scope: 'identify' });
    }
    if (req.method === 'GET' && url.pathname === '/api/oauth/me') {
      const auth = req.headers.authorization || '';
      const user = tokens.get(auth.replace(/^Bearer\s+/i, ''));
      if (!user) return json(res, 401, { error: 'invalid_token' });
      return json(res, 200, { id: user.id, username: user.username, display_name: user.display_name, avatar_url: null });
    }
    return json(res, 404, { error: 'not_found' });
  }
  return { handler, codes, tokens };
}

async function seedBot(h) {
  const { engine } = h;
  const S = IDS.server;
  const C = IDS.channels;
  const now = Date.now();
  const lastKey = shiftMonth(monthKey(now), -1);
  const hours = Array(24).fill(0);
  hours[19] = 140;
  hours[20] = 96;
  hours[13] = 41;
  const dow = [30, 22, 25, 28, 40, 75, 57];
  const person = (m, ch, rr = 0, vs = 0) => ({ m, ch, h: { 19: Math.ceil(m / 2), 20: Math.floor(m / 2) }, d: [1, 4, 9, 15, 22], rg: 0, rr, vs, e: {} });
  engine.store.set('wrapped', S, {
    v: 1,
    months: {
      [lastKey]: {
        msgs: 277,
        hours,
        dow,
        ch: { [C.general]: 190, [C.news]: 52, [C.roles]: 35 },
        emojis: { '🔥': 21, '😂': 17, '❤️': 9 },
        vs: 5 * 3600 + 1200,
        reacted: {},
        users: {
          [IDS.member]: person(121, { [C.general]: 100, [C.roles]: 21 }, 14, 3600),
          [IDS.member2]: person(83, { [C.general]: 60, [C.news]: 23 }, 6),
          [IDS.admin]: person(52, { [C.news]: 29, [C.general]: 23 }, 3, 7200),
          [IDS.mod]: person(21, { [C.general]: 7, [C.roles]: 14 }, 1),
        },
      },
    },
  });

  for (const id of ['mod', 'automod', 'levels', 'economy', 'welcome', 'wrapped', 'starboard', 'tickets', 'engage', 'games', 'voice']) {
    if (engine.apps.get(id)) engine.settings.setEnabled(S, id, true);
  }
  engine.settings.patchCore(S, { logChannel: C.modlog });

  const levels = engine.service('levels');
  const xp = [[IDS.member, 2650], [IDS.member2, 1480], [IDS.admin, 910], [IDS.mod, 420], [IDS.owner, 160]];
  for (const [uid, amount] of xp) await levels?.addXp?.(S, uid, amount, 'Seeded for local testing', { silent: true });

  const economy = engine.service('economy');
  const coins = [[IDS.member, 1250], [IDS.admin, 980], [IDS.member2, 640], [IDS.mod, 300]];
  for (const [uid, amount] of coins) economy?.add?.(S, uid, amount, 'Seeded for local testing');

  const mention = (id) => `<@${id}>`;
  await h.slash('warn', `${mention(IDS.member)} spamming links in general`, { user: IDS.admin });
  await h.slash('warn', `${mention(IDS.member2)} caps lock shouting`, { user: IDS.mod });
  await h.slash('timeout', `${mention(IDS.member2)} 10m kept arguing after a warning`, { user: IDS.admin });
  await h.slash('warn', `${mention(IDS.member)} posted an invite link`, { user: IDS.mod });
  await h.settle();
}

function quietLog() {
  return createLogger({ level: 'error', sink: () => {} });
}

export async function startDev({
  port = 8787,
  oauthPort = 8788,
  dbFile = path.join(DEV_DIR, 'dashboard.sqlite'),
  fresh = false,
  autoPoll = true,
  nudge = true,
  quiet = false,
} = {}) {
  if (dbFile !== ':memory:') {
    await mkdir(path.dirname(dbFile), { recursive: true });
    if (fresh) for (const suffix of ['', '-wal', '-shm', '-journal']) await rm(`${dbFile}${suffix}`, { force: true });
  }
  const db = new D1Database(dbFile);
  db.raw.exec(SCHEMA);

  const clientSecret = randomBytes(32).toString('base64url');
  const botSecret = randomBytes(48).toString('base64url');
  const env = {
    DB: db,
    ASSETS: null,
    YAPIN_CLIENT_ID: CLIENT_ID,
    PUBLIC_URL: '',
    YAPIN_BASE: '',
    YAPIN_CLIENT_SECRET: clientSecret,
    BOT_SECRET: botSecret,
  };

  const oauth = createFakeOAuth({
    users: TEST_USERS,
    clientId: () => env.YAPIN_CLIENT_ID,
    clientSecret: () => env.YAPIN_CLIENT_SECRET,
    redirectUri: () => `${env.PUBLIC_URL}/auth/callback`,
  });
  const oauthServer = await serve(oauth.handler, oauthPort);
  env.YAPIN_BASE = `http://localhost:${oauthServer.address().port}`;

  const workerLog = quiet ? () => {} : (...a) => console.error('[worker]', ...a);
  const worker = createWorker({ log: workerLog });
  let bot = null;
  let nudgeTimer = null;
  const poke = () => {
    if (!nudge || !bot || nudgeTimer) return;
    nudgeTimer = setTimeout(() => {
      nudgeTimer = null;
      bot.dashboard.tick().catch(() => {});
    }, 50);
    nudgeTimer.unref?.();
  };
  const ctx = { waitUntil() {}, passThroughOnException() {} };

  async function route(request) {
    const url = new URL(request.url);
    const workerFirst = WORKER_FIRST.some((re) => re.test(url.pathname));
    if (!workerFirst && (request.method === 'GET' || request.method === 'HEAD')) {
      const asset = await env.ASSETS.fetch(request);
      if (asset.status !== 404) return asset;
    }
    const response = await worker.fetch(request, env, ctx);
    if (url.pathname.startsWith('/api/') && (response.status === 202 || response.status === 403)) poke();
    return response;
  }

  const site = await serve(async (req, res) => {
    const request = await toRequest(req, env.PUBLIC_URL);
    const response = await route(request);
    await writeResponse(res, response, req.method);
  }, port);
  env.PUBLIC_URL = `http://localhost:${site.address().port}`;
  env.ASSETS = createAssets({ secure: false });

  const harness = await createHarness();
  await seedBot(harness);
  const dashLog = quiet ? quietLog() : createLogger({ level: process.env.YAPOS_LOG || 'info' });
  const dashboard = createDashboard({ engine: harness.engine, url: env.PUBLIC_URL, secret: botSecret, log: dashLog });
  harness.engine.dashboard = dashboard;
  bot = harness.engine;
  if (autoPoll) dashboard.start();

  const cleanupTimer = setInterval(() => {
    worker.scheduled({ cron: '*/15 * * * *', scheduledTime: Date.now() }, env, ctx).catch(() => {});
  }, CLEANUP_EVERY_MS);
  cleanupTimer.unref?.();

  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    clearInterval(cleanupTimer);
    if (nudgeTimer) clearTimeout(nudgeTimer);
    dashboard.stop();
    harness.engine.dispose?.();
    harness.engine.scheduler?.stop?.();
    await Promise.all([site, oauthServer].map((s) => new Promise((r) => { s.close(() => r()); s.closeAllConnections?.(); })));
    try { db.close(); } catch {}
  }

  return {
    url: env.PUBLIC_URL,
    oauthUrl: env.YAPIN_BASE,
    env,
    db,
    worker,
    harness,
    dashboard,
    oauth,
    users: TEST_USERS,
    serverId: IDS.server,
    close,
  };
}

async function main() {
  const fresh = process.argv.includes('--fresh');
  const dev = await startDev({ fresh });
  const lines = [
    '',
    `YapOS Dashboard (local) is running at ${dev.url}`,
    `Fake Yapin' sign-in is at ${dev.oauthUrl}`,
    `Test server: Test Town (${dev.serverId})`,
    '',
    'Test users (pick one on the sign-in page):',
    ...dev.users.map((u) => `  ${u.display_name.padEnd(8)} @${u.username.padEnd(8)} ${u.role}`),
    '',
    'Data: dashboard/.dev/dashboard.sqlite (run with -- --fresh to start clean). The test bot is in memory and reseeds on every start.',
    'Press Ctrl+C to stop.',
    '',
  ];
  console.log(lines.join('\n'));
  const stop = async () => {
    await dev.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((err) => {
    console.error(err?.code === 'EADDRINUSE' ? `[dev] port in use: ${err.message}` : err);
    process.exit(1);
  });
}
