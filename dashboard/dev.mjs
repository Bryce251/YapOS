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
import { createBudget } from '../engine/budget.js';
import { createLogger } from '../engine/log.js';
import { monthKey, shiftMonth } from '../apps/wrapped.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(HERE, 'web');
const DEV_DIR = path.join(HERE, '.dev');
const SCHEMA = readFileSync(path.join(HERE, 'schema.sql'), 'utf8');
const CLIENT_ID = 'b21fe402-0f20-43df-867b-8b346029fd8d';
const ACTIVITY_DEV = path.join(HERE, 'dev', 'activity-dev');
const WORKER_FIRST = [/^\/api(\/|$)/, /^\/auth(\/|$)/, /^\/bot(\/|$)/, /^\/activity(\/|$)/];
const ACTIVITY_DEV_FILE = /^\/activity-dev\/([a-z0-9-]+\.(?:html|js|css))?$/;
export const ACTIVITY_DEV_CSP = "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
const SKIP_HEADERS = new Set(['host', 'connection', 'keep-alive', 'transfer-encoding', 'cf-connecting-ip', 'upgrade']);
const CLEANUP_EVERY_MS = 15 * 60_000;
const FAKE_PERSON = /^de7e0000-0000-4000-8000-(\d{12})$/;
const FAKE_AVATAR = /^\/activity-dev\/avatars\/(\d{1,3})\.svg$/;
const FAKE_NAMES = ['Pip', 'Juno', 'Rex', 'Mila', 'Ozzy', 'Tess', 'Bo', 'Kit'];
const FAKE_HANDLES = ['pipsqueak', 'junebug', 'rexplorer', 'milawaves', 'ozzyosprey', 'tessellate', 'bobaboba', 'kitkatz'];
const FAKE_COLORS = [['#f2613f', '#ff9a6b'], ['#8b5cf6', '#c4b5fd'], ['#ec4899', '#f9a8d4'], ['#0ea5e9', '#7dd3fc'], ['#22c55e', '#86efac'], ['#eab308', '#fde047'], ['#14b8a6', '#5eead4'], ['#6366f1', '#a5b4fc']];
const CODE_TTL_MS = 5 * 60_000;
export const DEV_PARTY_OWNER = 'de7e0000-0000-4000-8000-000000000001';
export const DEV_PARTY_ADMIN = 'de7e0000-0000-4000-8000-000000000002';

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
  '.mp3': 'audio/mpeg',
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
      current = { pattern, re: new RegExp(`^${source}$`), headers: [], detach: [] };
      rules.push(current);
      continue;
    }
    if (!current) continue;
    const line = raw.trim();
    if (line.startsWith('!')) {
      const name = line.slice(1).trim();
      if (name) current.detach.push(name);
      continue;
    }
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
      headersFor(rules, url.pathname, { secure }).forEach((v, k) => headers.set(k, v));
      return new Response(request.method === 'HEAD' ? null : body, { status: 200, headers });
    },
  };
}

export function headersFor(rules, pathname, { secure = false } = {}) {
  const headers = new Headers();
  for (const rule of rules) {
    if (!rule.re.test(pathname)) continue;
    for (const k of rule.detach) headers.delete(k);
    for (const [k, v] of rule.headers) {
      if (!secure && k.toLowerCase() === 'strict-transport-security') continue;
      headers.set(k, v);
    }
  }
  return headers;
}

export function allowDevFraming(response, url) {
  if (url.searchParams.get('dev') !== '1') return response;
  const csp = response.headers.get('Content-Security-Policy') || '';
  if (!/frame-ancestors https:/.test(csp)) return response;
  const out = new Response(response.body, response);
  out.headers.set('Content-Security-Policy', csp.replace('frame-ancestors ', "frame-ancestors 'self' "));
  return out;
}

export function fakeProfile(id) {
  const m = FAKE_PERSON.exec(String(id || ''));
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isInteger(n) || n < 1 || n > 999) return null;
  const i = (n - 1) % FAKE_NAMES.length;
  const round = Math.floor((n - 1) / FAKE_NAMES.length);
  return {
    id,
    username: round ? `${FAKE_HANDLES[i]}${round + 1}` : FAKE_HANDLES[i],
    display_name: round ? `${FAKE_NAMES[i]} ${round + 1}` : FAKE_NAMES[i],
    avatar: n % 4 === 0 ? null : `/activity-dev/avatars/${n}.svg`,
  };
}

export function fakeAvatarSvg(n) {
  const i = (n - 1) % FAKE_NAMES.length;
  const [a, b] = FAKE_COLORS[i];
  const letter = FAKE_NAMES[i].slice(0, 1);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="128" height="128" fill="url(#g)"/><circle cx="64" cy="52" r="22" fill="#ffffff" fill-opacity="0.85"/><path d="M24 118c6-24 22-36 40-36s34 12 40 36z" fill="#ffffff" fill-opacity="0.85"/><text x="64" y="61" font-family="system-ui,sans-serif" font-size="24" font-weight="700" text-anchor="middle" fill="${a}">${letter}</text></svg>`;
}

async function withFakeProfiles(response, url) {
  if (response.status !== 200) return response;
  const ids = String(url.searchParams.get('ids') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const fakes = ids.map(fakeProfile).filter(Boolean);
  if (!fakes.length) return response;
  let body;
  try {
    body = await response.clone().json();
  } catch {
    return response;
  }
  const fakeIds = new Set(fakes.map((f) => f.id));
  const profiles = (Array.isArray(body.profiles) ? body.profiles : []).filter((p) => !fakeIds.has(p.id)).concat(fakes);
  const pending = (Array.isArray(body.pending) ? body.pending : []).filter((id) => !fakeIds.has(id));
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-store');
  headers.delete('Content-Length');
  return new Response(JSON.stringify({ profiles, pending }), { status: 200, headers });
}

export async function withDevPartyOwner(response, url) {
  if (response.status !== 200) return response;
  const ids = String(url.searchParams.get('ids') || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!ids.includes(DEV_PARTY_OWNER)) return response;
  let body;
  try {
    body = await response.clone().json();
  } catch {
    return response;
  }
  const given = new Set(Array.isArray(body.admins) ? body.admins : []);
  given.add(DEV_PARTY_OWNER);
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-store');
  headers.delete('Content-Length');
  return new Response(JSON.stringify({ admins: ids.filter((id) => given.has(id)), owner: DEV_PARTY_OWNER }), { status: 200, headers });
}

export function seedPartyAdmins(db, ownerId, t = Date.now()) {
  const juno = fakeProfile(DEV_PARTY_ADMIN);
  db.raw.prepare('INSERT INTO party_admins (id, added_by, added_at) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING').run(DEV_PARTY_ADMIN, ownerId, t);
  db.raw.prepare('INSERT INTO profiles (id, username, display_name, avatar_url, missing, fetched) VALUES (?, ?, ?, NULL, 0, ?) ON CONFLICT (id) DO UPDATE SET username = excluded.username, display_name = excluded.display_name, missing = 0, fetched = excluded.fetched').run(DEV_PARTY_ADMIN, juno.username, juno.display_name, t);
}

async function activityDev(request) {
  const url = new URL(request.url);
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  if (url.pathname === '/activity-dev') return new Response(null, { status: 308, headers: { Location: `/activity-dev/${url.search}`, 'Cache-Control': 'no-store' } });
  const pic = FAKE_AVATAR.exec(url.pathname);
  if (pic && Number(pic[1]) >= 1) {
    const headers = new Headers({
      'Content-Type': 'image/svg+xml',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    });
    return new Response(request.method === 'HEAD' ? null : fakeAvatarSvg(Number(pic[1])), { status: 200, headers });
  }
  const m = ACTIVITY_DEV_FILE.exec(url.pathname);
  const name = m ? m[1] || 'index.html' : null;
  const file = name ? path.join(ACTIVITY_DEV, name) : null;
  const info = file ? await stat(file).catch(() => null) : null;
  const headers = new Headers({
    'Content-Security-Policy': ACTIVITY_DEV_CSP,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
    'Cache-Control': 'no-store',
  });
  if (!info || !info.isFile()) {
    headers.set('Content-Type', 'text/plain; charset=utf-8');
    return new Response('Not found', { status: 404, headers });
  }
  headers.set('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
  return new Response(request.method === 'HEAD' ? null : await readFile(file), { status: 200, headers });
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

function freshBudget(engine) {
  engine.budget = createBudget({ bot: engine.bot, verified: engine.budget.verified, log: engine.log });
}

function followRealTime(clock) {
  let skew = 0;
  Object.defineProperty(clock, 't', { get: () => Date.now() + skew, set: (v) => { skew = v - Date.now(); }, enumerable: true, configurable: true });
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

  for (const id of ['mod', 'automod', 'levels', 'economy', 'welcome', 'wrapped', 'starboard', 'tickets', 'engage', 'games', 'casino', 'voice']) {
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
  await h.slash('mod', `note ${mention(IDS.member)} keeps arguing in general, talked to them in DMs`, { user: IDS.mod });
  await h.slash('mod', `note ${mention(IDS.member)} was much calmer this week`, { user: IDS.admin });
  await h.slash('mod', `note ${mention(IDS.member2)} new here, still learning the rules`, { user: IDS.mod });
  await h.settle();
  await seedTickets(h);
}

async function seedTickets(h) {
  const { engine } = h;
  const S = IDS.server;
  if (!engine.apps.get('tickets')) return;
  engine.settings.patchApp(S, 'tickets', { logChannelId: IDS.channels.modlog });
  const ticketOf = (uid) => Object.values(engine.store.get('tickets', S, { tickets: {} }).tickets || {})
    .filter((t) => t.openerId === uid && t.status === 'open')
    .pop() || null;
  const open = async (uid, topic) => {
    await h.slash('ticket', topic, { user: uid });
    await h.settle();
    return ticketOf(uid);
  };
  const say = async (t, uid, text) => {
    if (t?.channelId) await h.message(text, { user: uid, channel: t.channelId });
  };

  const done = await open(IDS.member, 'Refund for a shop role I bought by mistake');
  if (done) {
    await say(done, IDS.member, 'Hi! I bought the VIP role in the shop by accident.');
    await say(done, IDS.admin, 'No worries, I refunded the coins and removed the role.');
    await say(done, IDS.member, 'Thank you so much!');
    const closedAt = Date.now() - 2 * 3600_000;
    const stamp = (at) => new Date(at).toISOString().slice(0, 16).replace('T', ' ');
    const transcript = [
      `Ticket #${String(done.number).padStart(4, '0')} (Support)`,
      `Opened by sam on ${stamp(done.createdAt)} UTC`,
      `Claimed by alex`,
      `Closed by alex on ${stamp(closedAt)} UTC. Reason: Refunded`,
      `Topic: ${done.topic}`,
      '-'.repeat(40),
      `[${stamp(done.createdAt)}] sam: Hi! I bought the VIP role in the shop by accident.`,
      `[${stamp(done.createdAt)}] alex: No worries, I refunded the coins and removed the role.`,
      `[${stamp(done.createdAt)}] sam: Thank you so much!`,
      '',
    ].join('\n');
    engine.store.update('tickets', S, (d) => {
      const t = d.tickets[done.number];
      if (t) {
        Object.assign(t, {
          status: 'closed',
          claimedBy: IDS.admin,
          closedAt,
          closedBy: IDS.admin,
          reason: 'Refunded',
          rating: { stars: 5, at: closedAt + 60_000, comment: 'Super quick, thanks!', logMessageId: null },
          transcript,
        });
      }
      return d;
    }, { seq: 0, tickets: {} });
    await engine.bot.deleteChannel?.(done.channelId).catch(() => {});
    if (done.roleId) await engine.bot.deleteRole?.(S, done.roleId).catch(() => {});
    engine.cache.invalidate?.(S);
  }

  const help = await open(IDS.member, 'My level did not go up after the event');
  await say(help, IDS.member, 'I chatted a lot during the event but my level stayed the same.');

  const claimed = await open(IDS.member2, 'Can I get the Gamer role?');
  if (claimed?.channelId) {
    await h.slash('ticket', 'claim', { user: IDS.mod, channel: claimed.channelId });
    await say(claimed, IDS.member2, 'I play every weekend with the group.');
    await say(claimed, IDS.mod, 'Sure, checking with the admins now.');
  }
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
    PARTY_OWNER_ID: IDS.owner,
  };
  seedPartyAdmins(db, IDS.owner);

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
    if (url.pathname === '/activity-dev' || url.pathname.startsWith('/activity-dev/')) return activityDev(request);
    const workerFirst = WORKER_FIRST.some((re) => re.test(url.pathname));
    if (!workerFirst && (request.method === 'GET' || request.method === 'HEAD')) {
      const asset = await env.ASSETS.fetch(request);
      if (asset.status !== 404) return asset;
    }
    const response = await worker.fetch(request, env, ctx);
    if (url.pathname === '/activity' || url.pathname.startsWith('/activity/')) return allowDevFraming(response, url);
    if (url.pathname === '/api/activity/profiles' && request.method === 'GET') return withFakeProfiles(response, url);
    if (url.pathname === '/api/activity/admins' && request.method === 'GET') return withDevPartyOwner(response, url);
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
  followRealTime(harness.fake.clock);
  await seedBot(harness);
  freshBudget(harness.engine);
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
    `YapOS Party test call is at ${dev.url}/activity-dev/`,
    `Test server: Test Town (${dev.serverId})`,
    'YapOS Party: Pip (the first player) is the owner and Juno is an extra admin. Sign in as Jolli to manage party admins at /party.',
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
