import http from 'node:http';
import { readFile, stat, mkdir, rm } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { createWorker } from './worker/app.js';
import { approveCode } from './worker/activity-auth.js';
import { D1Database } from './test/d1-shim.js';
import { createHarness, IDS } from '../test/harness.js';
import { createDashboard } from '../engine/dashboard.js';
import { setCustomBadges, grantBadge } from '../engine/global.js';
import { createBudget } from '../engine/budget.js';
import { createLogger } from '../engine/log.js';
import { monthKey, shiftMonth } from '../apps/wrapped.js';
import { encodeStroke } from './web/activity/js/games/ink.js';
import { cleanReplay } from './worker/reports.js';
import { monthOf, prevMonth } from './worker/party-leaderboard.js';
import { dayKey } from './web/activity/js/daily.js';
import { customKey } from './web/activity/js/filter.js';
import { seedOwnerPanel, createOwnerSim, botHandlesOwner } from './dev/owner-sim.js';

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
export const DEV_REPORT_ID = 'devreport0001';
export const DEV_REPORT_DRAWER = 'de7e0000-0000-4000-8000-000000000003';
export const DEV_REPORT_REPORTER = 'de7e0000-0000-4000-8000-000000000004';
export const DEV_TEXT_REPORT_ID = 'devreport0002';
export const DEV_PACK_CODE = 'DEVPACK2';
export const DEV_FAKE_ACCOUNT = Object.freeze({ id: 'a0000000-0000-4000-8000-0000000000fa', username: 'mwa', name: 'mwa', shards: 50000, xp: 40 });

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

export const DEV_LINK_PATH = '/dev/link/approve';

export function devLinkUser(id) {
  const known = TEST_USERS.find((u) => u.id === id);
  if (known) return { id: known.id, username: known.username, display_name: known.display_name, avatar_url: null };
  const fake = fakeProfile(id);
  return fake ? { id: fake.id, username: fake.username, display_name: fake.display_name, avatar_url: null } : null;
}

export async function devLinkApprove(request, db, t = Date.now()) {
  const reply = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
  if (request.method !== 'POST') return reply(405, { error: 'method_not_allowed', message: 'Use POST.' });
  let body = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const user = body && typeof body.id === 'string' ? devLinkUser(body.id) : null;
  if (!user) return reply(400, { error: 'bad_user', message: 'Pick a person from the test call.' });
  const result = await approveCode(db, body.code, user, t, { confirm: true });
  if (!result.ok) return reply(result.status, { error: result.error, message: result.message });
  return reply(200, { ok: true, user });
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
  const banned = (Array.isArray(body.banned) ? body.banned : []).filter((id) => id !== DEV_PARTY_OWNER);
  const until = body.until && typeof body.until === 'object' ? Object.fromEntries(Object.entries(body.until).filter(([id]) => banned.includes(id))) : {};
  return new Response(JSON.stringify({ admins: ids.filter((id) => given.has(id)), owner: DEV_PARTY_OWNER, banned, ...(Object.keys(until).length ? { until, now: body.now } : {}) }), { status: 200, headers });
}

export function seedPartyAdmins(db, ownerId, t = Date.now()) {
  const juno = fakeProfile(DEV_PARTY_ADMIN);
  db.raw.prepare('INSERT INTO party_admins (id, added_by, added_at) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING').run(DEV_PARTY_ADMIN, ownerId, t);
  db.raw.prepare('INSERT INTO profiles (id, username, display_name, avatar_url, missing, fetched) VALUES (?, ?, ?, NULL, 0, ?) ON CONFLICT (id) DO UPDATE SET username = excluded.username, display_name = excluded.display_name, missing = 0, fetched = excluded.fetched').run(DEV_PARTY_ADMIN, juno.username, juno.display_name, t);
}

export const DEV_PACK = Object.freeze({
  name: 'Test Town classics',
  words: ['sunflower', 'treehouse', 'pancake stack', 'rubber duck', 'lighthouse', 'snow globe', 'paper plane', 'disco ball', 'campfire', 'roller skate', 'hot air balloon', 'jellyfish'],
  trivia: [
    { q: 'Which planet is known as the red planet?', a: 'Mars', w: ['Venus', 'Jupiter', 'Saturn'] },
    { q: 'How many legs does a spider have?', a: 'Eight', w: ['Six', 'Ten', 'Twelve'] },
    { q: 'What do bees make?', a: 'Honey', w: ['Milk', 'Silk', 'Wax paper'] },
  ],
});

export function seedPartyPack(db, ownerId, t = Date.now()) {
  db.raw.prepare('INSERT INTO party_packs (code, owner_id, name, words, trivia, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (code) DO NOTHING')
    .run(DEV_PACK_CODE, ownerId, DEV_PACK.name, JSON.stringify(DEV_PACK.words), JSON.stringify(DEV_PACK.trivia), t, t);
}

export function seedDailyScores(db, t = Date.now()) {
  const day = dayKey(t);
  const players = [
    { n: 3, hive: 42, scramble: 500, ms: 95_000, streak: 4 },
    { n: 5, hive: 31, scramble: 400, ms: 120_000, streak: 2 },
    { n: 6, hive: 18, scramble: 300, ms: 160_000, streak: 1 },
    { n: 7, hive: 9, scramble: 100, ms: 210_000, streak: 9 },
  ];
  const score = db.raw.prepare('INSERT INTO party_daily_scores (day, kind, user_id, name, username, score, ms, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (day, kind, user_id) DO NOTHING');
  const streak = db.raw.prepare('INSERT INTO party_daily_streaks (user_id, last_day, streak, best, updated) VALUES (?, ?, ?, ?, ?) ON CONFLICT (user_id) DO NOTHING');
  for (const p of players) {
    const id = `de7e0000-0000-4000-8000-${String(p.n).padStart(12, '0')}`;
    const prof = fakeProfile(id);
    score.run(day, 'hive', id, prof.display_name, prof.username, p.hive, p.ms, t);
    score.run(day, 'scramble', id, prof.display_name, prof.username, p.scramble, Math.round(p.ms / 2), t);
    streak.run(id, day, p.streak, Math.max(p.streak, 7), t);
  }
}

function ring(cx, cy, rx, ry, from, to, steps) {
  const pts = [];
  for (let i = 0; i <= steps; i += 1) {
    const a = from + ((to - from) * i) / steps;
    pts.push([Math.round(cx + Math.cos(a) * rx), Math.round(cy + Math.sin(a) * ry)]);
  }
  return pts;
}

export function devReportInk() {
  return [
    { c: 5, z: 2, pts: ring(240, 180, 110, 110, 0, Math.PI * 2, 48) },
    { c: 1, z: 3, pts: [[200, 150]] },
    { c: 1, z: 3, pts: [[280, 150]] },
    { c: 1, z: 2, pts: ring(240, 190, 60, 45, 0.15 * Math.PI, 0.85 * Math.PI, 16) },
    { c: 10, z: 1, pts: [[60, 60], [90, 40], [120, 70], [150, 45], [180, 75], [210, 50]] },
    { c: 5, z: 4, pts: [[240, 180]] },
  ].map(encodeStroke);
}

export function seedPartyReport(db, t = Date.now()) {
  const stmt = db.raw.prepare('INSERT INTO profiles (id, username, display_name, avatar_url, missing, fetched) VALUES (?, ?, ?, NULL, 0, ?) ON CONFLICT (id) DO UPDATE SET username = excluded.username, display_name = excluded.display_name, missing = 0, fetched = excluded.fetched');
  const rex = fakeProfile(DEV_REPORT_DRAWER);
  const mila = fakeProfile(DEV_REPORT_REPORTER);
  stmt.run(rex.id, rex.username, rex.display_name, t);
  stmt.run(mila.id, mila.username, mila.display_name, t);
  db.raw.prepare("INSERT INTO party_reports (id, game, drawer_id, drawer_name, drawer_username, reporter_id, reporter_name, ink, word, at, created, ip_hash, status) VALUES (?, 'draw', ?, ?, ?, ?, ?, ?, 'sunflower', ?, ?, 'dev', 'open') ON CONFLICT (id) DO NOTHING")
    .run(DEV_REPORT_ID, rex.id, rex.display_name, rex.username, mila.id, mila.display_name, JSON.stringify(devReportInk()), t - 5 * 60_000, t - 5 * 60_000);
  db.raw.prepare("INSERT INTO party_reports (id, game, drawer_id, drawer_name, drawer_username, reporter_id, reporter_name, ink, word, at, created, ip_hash, status) VALUES (?, 'hottakes', ?, ?, ?, ?, ?, '[]', NULL, ?, ?, 'dev', 'open') ON CONFLICT (id) DO NOTHING")
    .run(DEV_TEXT_REPORT_ID, rex.id, rex.display_name, rex.username, mila.id, mila.display_name, t - 2 * 60_000, t - 2 * 60_000);
  db.raw.prepare("INSERT INTO party_report_texts (id, text, context, ip_hash, created) VALUES (?, ?, ?, 'dev', ?) ON CONFLICT (id) DO NOTHING")
    .run(DEV_TEXT_REPORT_ID, 'Pineapple on pizza people should be kicked out of every call, no exceptions', 'What is the worst food opinion?', t - 2 * 60_000);
  const artists = DEV_ARTISTS.map(fakeProfile);
  for (const a of artists) stmt.run(a.id, a.username, a.display_name, t);
  const insert = db.raw.prepare("INSERT INTO party_reports (id, game, drawer_id, drawer_name, drawer_username, reporter_id, reporter_name, ink, word, at, created, ip_hash, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'dev', 'open') ON CONFLICT (id) DO NOTHING");
  const keep = db.raw.prepare('INSERT INTO party_report_replays (report_id, data, created) VALUES (?, ?, ?) ON CONFLICT (report_id) DO NOTHING');
  const odd = devOddReplay(artists);
  const last = artists[odd.lastArtist];
  insert.run(DEV_ODD_REPORT_ID, 'odd', last.id, last.display_name, last.username, mila.id, mila.display_name, JSON.stringify(odd.ink), 'lighthouse', t - 4 * 60_000, t - 4 * 60_000);
  keep.run(DEV_ODD_REPORT_ID, JSON.stringify(cleanReplay(odd.replay, 'odd', last.id)), t - 4 * 60_000);
  const pixel = devPixelReplay(artists.slice(0, 3));
  const top = artists[0];
  insert.run(DEV_PIXEL_REPORT_ID, 'pixel', top.id, top.display_name, top.username, mila.id, mila.display_name, '[]', 'a heart with wings', t - 3 * 60_000, t - 3 * 60_000);
  keep.run(DEV_PIXEL_REPORT_ID, JSON.stringify(cleanReplay(pixel, 'pixel', top.id)), t - 3 * 60_000);
  const DAY = 86_400_000;
  const past = db.raw.prepare("INSERT INTO party_reports (id, game, drawer_id, drawer_name, drawer_username, reporter_id, reporter_name, ink, word, at, created, ip_hash, status, dismissed_at, dismissed_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'dev', 'dismissed', ?, ?) ON CONFLICT (id) DO NOTHING");
  const ink = devReportInk();
  past.run(DEV_PAST_REPORT_IDS[0], 'draw', rex.id, rex.display_name, rex.username, artists[1].id, artists[1].display_name, JSON.stringify(ink), 'rainbow', t - 6 * DAY, t - 6 * DAY, t - 6 * DAY + 3_600_000, IDS.owner);
  keep.run(DEV_PAST_REPORT_IDS[0], JSON.stringify(cleanReplay({ v: 1, kind: 'ink', authors: [{ id: rex.id, name: rex.display_name }], events: ink.map((s, i) => [0, 1500 + i * 2600, s]) }, 'draw', rex.id)), t - 6 * DAY);
  past.run(DEV_PAST_REPORT_IDS[1], 'sketchduel', rex.id, rex.display_name, rex.username, artists[2].id, artists[2].display_name, JSON.stringify(ink.slice(0, 3)), 'snowman', t - 12 * DAY, t - 12 * DAY, t - 11 * DAY, IDS.owner);
  const flagged = db.raw.prepare("INSERT INTO party_reports (id, game, drawer_id, drawer_name, drawer_username, reporter_id, reporter_name, ink, word, at, created, ip_hash, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open') ON CONFLICT (id) DO NOTHING");
  flagged.run(DEV_FLAG_REPORT_IDS[0], 'telephone', rex.id, rex.display_name, rex.username, artists[1].id, artists[1].display_name, JSON.stringify(ink.slice(0, 4)), 'volcano', t - DAY, t - DAY, 'dev-flag-1');
  flagged.run(DEV_FLAG_REPORT_IDS[1], 'sketchduel', rex.id, rex.display_name, rex.username, artists[2].id, artists[2].display_name, JSON.stringify(ink.slice(1, 5)), 'robot', t - 3 * DAY, t - 3 * DAY, 'dev-flag-2');
  const why = db.raw.prepare('INSERT INTO party_report_reasons (report_id, reason, note, created) VALUES (?, ?, ?, ?) ON CONFLICT (report_id) DO NOTHING');
  why.run(DEV_TEXT_REPORT_ID, 'rude', null, t - 2 * 60_000);
  why.run(DEV_ODD_REPORT_ID, 'other', 'They drew over everyone else on purpose', t - 4 * 60_000);
  why.run(DEV_PIXEL_REPORT_ID, 'spam', null, t - 3 * 60_000);
  why.run(DEV_FLAG_REPORT_IDS[0], 'rude', null, t - DAY);
  why.run(DEV_FLAG_REPORT_IDS[1], 'cheating', null, t - 3 * DAY);
  const note = db.raw.prepare('INSERT INTO party_mod_notes (id, user_id, author_id, author_name, text, created) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING');
  const juno = fakeProfile(DEV_PARTY_ADMIN);
  note.run(DEV_NOTE_IDS[0], top.id, DEV_PARTY_ADMIN, juno.display_name, 'Warned in a Pixel Art game about copying other players and then taking credit.', t - 2 * DAY);
  note.run(DEV_NOTE_IDS[1], top.id, IDS.owner, 'Jolli', 'Watch: said sorry in chat. Give them another chance, but look again if a new report comes in.', t - 3 * 3_600_000);
  note.run(DEV_NOTE_IDS[2], rex.id, DEV_PARTY_ADMIN, juno.display_name, 'Ban appeal: asked to be unbanned after the Sketch Duel ban and promised to keep drawings friendly.', t - 9 * DAY);
  const log = db.raw.prepare('INSERT INTO party_ban_log (id, user_id, action, reason, by_id, at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING');
  log.run('devbanlog0001', rex.id, 'ban', 'Rude drawings in Sketch Duel', IDS.owner, t - 11 * DAY);
  log.run('devbanlog0002', rex.id, 'unban', null, IDS.owner, t - 9 * DAY);
}

export const DEV_PAST_REPORT_IDS = Object.freeze(['devreport0005', 'devreport0006']);
export const DEV_FLAG_REPORT_IDS = Object.freeze(['devreport0007', 'devreport0008']);
export const DEV_NOTE_IDS = Object.freeze(['devnote0001', 'devnote0002', 'devnote0003']);

export const DEV_ODD_REPORT_ID = 'devreport0003';
export const DEV_PIXEL_REPORT_ID = 'devreport0004';
export const DEV_ARTISTS = Object.freeze([5, 6, 7, 8].map((n) => `de7e0000-0000-4000-8000-${String(n).padStart(12, '0')}`));

function line(points, steps = 8) {
  const out = [];
  for (let k = 0; k < points.length - 1; k += 1) {
    const [x0, y0] = points[k];
    const [x1, y1] = points[k + 1];
    for (let i = 0; i < steps; i += 1) out.push([Math.round(x0 + ((x1 - x0) * i) / steps), Math.round(y0 + ((y1 - y0) * i) / steps)]);
  }
  out.push(points[points.length - 1]);
  return out;
}

export function devOddReplay(artists) {
  const cols = [3, 8, 6, 9];
  const turns = [
    [0, line([[200, 320], [210, 140], [270, 140], [280, 320]])],
    [1, line([[195, 140], [240, 80], [285, 140]])],
    [2, ring(240, 110, 14, 14, 0, Math.PI * 2, 16)],
    [3, line([[60, 330], [140, 300], [240, 325], [340, 300], [430, 330]], 10)],
    [0, line([[205, 200], [275, 200]], 6)],
    [1, line([[210, 260], [270, 260]], 6)],
    [2, line([[254, 110], [440, 60]], 12)],
    [3, line([[254, 110], [440, 160]], 12)],
    [0, ring(90, 70, 30, 30, 0, Math.PI * 2, 20)],
    [1, line([[100, 140], [120, 130], [140, 140], [160, 130]], 4)],
    [2, line([[320, 230], [360, 215], [400, 232]], 6)],
    [3, line([[225, 320], [225, 290], [255, 290], [255, 320]], 4)],
  ];
  const times = [3200, 9800, 15100, 21400, 27900, 34600, 41800, 47200, 66500, 72100, 78800, 85300];
  const events = [];
  const ink = [];
  turns.forEach(([a, pts], i) => {
    const s = encodeStroke({ c: cols[a], z: 1, pts });
    events.push([a, times[i], s]);
    if (a === 3) ink.push(s);
  });
  return {
    lastArtist: 3,
    ink,
    replay: { v: 1, kind: 'ink', authors: artists.map((a) => ({ id: a.id, name: a.display_name })), events },
  };
}

function heartCells() {
  const inside = (c, r) => {
    const x = (c - 11.5) / 8.5;
    const y = (10.5 - r) / 8.5;
    const q = x * x + y * y - 1;
    return q * q * q - x * x * y * y * y <= 0;
  };
  const fill = [];
  const edge = [];
  for (let r = 0; r < 24; r += 1) {
    for (let c = 0; c < 24; c += 1) {
      if (!inside(c, r)) continue;
      const rim = !inside(c - 1, r) || !inside(c + 1, r) || !inside(c, r - 1) || !inside(c, r + 1);
      (rim ? edge : fill).push(r * 24 + c);
    }
  }
  return { fill, edge };
}

export function devPixelReplay(artists) {
  const { fill, edge } = heartCells();
  const grid = Array(576).fill('0');
  const events = [];
  let t = 1200;
  const paint = (a, i, c, gap = 110) => {
    t += gap;
    grid[i] = c;
    events.push([a, t, i, c]);
  };
  edge.forEach((i, k) => paint(0, i, '4', k % 8 === 7 ? 600 : 90));
  t += 6000;
  fill.forEach((i, k) => paint(1, i, k % 5 === 0 ? 'b' : '4', k % 12 === 11 ? 500 : 70));
  t += 2500;
  for (const i of [2, 3, 26, 27, 20, 21, 44, 45, 530, 531, 554, 555]) paint(2, i, '6', 160);
  paint(2, 27, '0', 900);
  for (const i of [100, 101, 124, 125]) paint(1, i, '2', 140);
  return { v: 1, kind: 'pixel', authors: artists.map((a) => ({ id: a.id, name: a.display_name })), events, grid: grid.join('') };
}

export const DEV_PUBLIC_PACKS = Object.freeze([
  Object.freeze({ code: 'DEVSPACE', owner: 'admin', name: 'Space adventure', words: ['rocket', 'astronaut', 'black hole', 'comet', 'moon base', 'satellite', 'alien', 'telescope'], likes: 5, daysAgo: 6 }),
  Object.freeze({ code: 'DEVSNACK', owner: 'member', name: 'Snack attack', words: ['popcorn', 'pretzel', 'nachos', 'cupcake', 'donut', 'milkshake', 'waffle', 'pizza slice'], likes: 3, daysAgo: 2 }),
  Object.freeze({ code: 'DEVBEACH', owner: 'owner', name: 'Beach day', words: ['sandcastle', 'seashell', 'surfboard', 'beach ball', 'sunscreen', 'crab', 'lifeguard', 'flip flops'], likes: 1, daysAgo: 0 }),
]);

function devRandom(seed) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 4294967296;
  };
}

function upsertProfile(db, id, username, displayName, t) {
  db.raw.prepare('INSERT INTO profiles (id, username, display_name, avatar_url, missing, fetched) VALUES (?, ?, ?, NULL, 0, ?) ON CONFLICT (id) DO UPDATE SET username = excluded.username, display_name = excluded.display_name, missing = 0, fetched = excluded.fetched').run(id, username, displayName, t);
}

export const DEV_SKILL_COUNTERS = Object.freeze({ winStreak: 1, bestWinStreak: 4, steals: 12, perfect: 1, comeback: 2, lightning: 9 });

export function seedPublicProfile(db, t = Date.now()) {
  const last = new Date(t);
  const month = (back) => {
    const d = new Date(Date.UTC(last.getUTCFullYear(), last.getUTCMonth() - back, 1));
    return d.toISOString().slice(0, 7);
  };
  const season = [{ month: month(1), rank: 2, kind: 'xp' }, { month: month(1), rank: 1, kind: 'shards' }, { month: month(2), rank: 4, kind: 'xp' }];
  db.raw.prepare("INSERT INTO public_profiles (user_id, username, username_key, name, level, xp, shards, badges, achievements, season, clan, hidden, updated) VALUES (?, 'jolli', 'jolli', 'Jolli', 27, 18450, NULL, ?, ?, ?, ?, 0, ?) ON CONFLICT (user_id) DO NOTHING")
    .run(IDS.owner, JSON.stringify(['first-game', 'games-10', 'wins-10']), JSON.stringify(['messages-10k', 'casino-50', 'tickets-100']), JSON.stringify(season), JSON.stringify({ name: 'Test Town Owls', tag: 'OWL', colour: '#7c5cff' }), t);
  db.raw.prepare('INSERT INTO party_stats (user_id, games, wins, by_game, counters, updated) VALUES (?, 64, 21, ?, ?, ?) ON CONFLICT (user_id) DO NOTHING')
    .run(IDS.owner, JSON.stringify({ draw: { p: 22, w: 9 }, trivia: { p: 18, w: 7 }, bluff: { p: 12, w: 3 }, hive: { p: 12, w: 2 } }), JSON.stringify(DEV_SKILL_COUNTERS), t);
  upsertProfile(db, IDS.owner, 'jolli', 'Jolli', t);
}

export const DEV_CUSTOM_BADGE = Object.freeze({ id: 'c-devstar1', name: 'Dev star', note: 'Made in the badge maker for local testing', emoji: '\u2B50' });

function pngChunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const body = Buffer.concat([head.subarray(4), data]);
  let c = ~0;
  for (const byte of body) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE((~c) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

export function devBadgePng(size = 32) {
  const rows = [];
  const mid = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    for (let x = 0; x < size; x++) {
      const dx = x - mid;
      const dy = y - mid;
      const r = Math.hypot(dx, dy);
      const a = Math.atan2(dy, dx);
      const edge = mid * (0.55 + 0.4 * Math.abs(Math.cos(2.5 * a)));
      const at = 1 + x * 4;
      if (r <= edge) {
        const glow = Math.max(0, 1 - r / edge);
        row[at] = 255;
        row[at + 1] = Math.round(170 + 70 * glow);
        row[at + 2] = Math.round(40 + 120 * glow);
        row[at + 3] = 255;
      }
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(Buffer.concat(rows))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

export function seedCustomBadge(db, ownerId, t = Date.now()) {
  const png = devBadgePng(32);
  const hash = createHash('sha256').update(png).digest('hex').slice(0, 16);
  const b = DEV_CUSTOM_BADGE;
  db.raw.prepare('INSERT INTO custom_badges (id, name, note, emoji, image, mime, hash, width, height, bytes, created, updated, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, 32, 32, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING')
    .run(b.id, b.name, b.note, b.emoji, new Uint8Array(png), 'image/png', hash, png.length, t, t, ownerId);
  const row = db.raw.prepare('SELECT badges FROM public_profiles WHERE user_id = ?').get(ownerId);
  if (row) {
    let list = [];
    try { list = JSON.parse(row.badges); } catch {}
    if (Array.isArray(list) && !list.includes(b.id)) db.raw.prepare('UPDATE public_profiles SET badges = ? WHERE user_id = ?').run(JSON.stringify([...list, b.id]), ownerId);
  }
  return { id: b.id, hash, bytes: png.length };
}

export const DEV_LOOKS = Object.freeze({
  owner: Object.freeze({
    v: 1,
    pins: ['c-devstar1', 'wins-10', 'ach:messages-10k'],
    order: ['about', 'stats', 'badges', 'favourites', 'achievements', 'placings'],
    hidden: [],
    nameColour: null,
    nameGradient: 'sunset',
    nameFont: 'default',
    accent: '#7c5cff',
    banner: 'aurora',
    bio: 'Making YapOS. Game night every Friday, bring snacks.\nAsk me about the badge maker.',
    pronouns: '',
    status: 'Hosting game night',
    statusEmoji: '\u{1F3AE}',
    ring: 'rainbow',
    density: 'cozy',
    featured: 'wins',
  }),
  member: Object.freeze({
    v: 1,
    pins: ['first-game'],
    order: ['stats', 'badges', 'about', 'favourites', 'achievements', 'placings'],
    hidden: ['placings'],
    nameColour: '#2fa84f',
    nameGradient: null,
    nameFont: 'rounded',
    accent: '#2fa84f',
    banner: 'image',
    bio: 'Draw & Guess main. I will guess your doodle in two seconds.',
    pronouns: 'they/them',
    status: 'Practising stick figures',
    statusEmoji: '\u{1F3A8}',
    ring: 'accent',
    density: 'compact',
    featured: 'level',
  }),
});

export const DEV_BANNER_ID = 'b-devbanner1';

export function devBannerPng(width = 640, height = 160) {
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x++) {
      const t = x / (width - 1);
      const wave = Math.sin((x / width) * Math.PI * 4 + (y / height) * Math.PI) * 0.5 + 0.5;
      const at = 1 + x * 3;
      row[at] = Math.round(30 + 40 * t + 30 * wave);
      row[at + 1] = Math.round(140 + 60 * (1 - t) + 30 * wave);
      row[at + 2] = Math.round(90 + 120 * t);
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(Buffer.concat(rows))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

export function seedProfileLooks(db, t = Date.now()) {
  db.raw.prepare("INSERT INTO public_profiles (user_id, username, username_key, name, level, xp, shards, badges, achievements, season, clan, hidden, updated) VALUES (?, 'sam', 'sam', 'Sam', 9, 2650, 1250, ?, ?, '[]', NULL, 0, ?) ON CONFLICT (user_id) DO NOTHING")
    .run(IDS.member, JSON.stringify(['first-game', 'games-10']), JSON.stringify(['messages-1k']), t);
  db.raw.prepare('INSERT INTO party_stats (user_id, games, wins, by_game, counters, updated) VALUES (?, 14, 4, ?, ?, ?) ON CONFLICT (user_id) DO NOTHING')
    .run(IDS.member, JSON.stringify({ draw: { p: 10, w: 4 }, odd: { p: 4, w: 0 } }), '{}', t);
  upsertProfile(db, IDS.member, 'sam', 'Sam', t);
  const png = devBannerPng();
  const hash = createHash('sha256').update(png).digest('hex').slice(0, 16);
  db.raw.prepare('INSERT INTO profile_banners (user_id, id, image, mime, hash, width, height, bytes, updated) VALUES (?, ?, ?, ?, ?, 640, 160, ?, ?) ON CONFLICT (user_id) DO NOTHING')
    .run(IDS.member, DEV_BANNER_ID, new Uint8Array(png), 'image/png', hash, png.length, t);
  const look = db.raw.prepare('INSERT INTO profile_custom (user_id, v, data, updated) VALUES (?, 1, ?, ?) ON CONFLICT (user_id) DO NOTHING');
  look.run(IDS.owner, JSON.stringify(DEV_LOOKS.owner), t);
  look.run(IDS.member, JSON.stringify(DEV_LOOKS.member), t);
  return { bannerHash: hash, bannerBytes: png.length };
}

export function seedPublicPacks(db, t = Date.now()) {
  const owners = { admin: IDS.admin, member: IDS.member, owner: IDS.owner };
  for (const u of TEST_USERS) upsertProfile(db, u.id, u.username, u.display_name, t);
  const pack = db.raw.prepare("INSERT INTO party_packs (code, owner_id, name, words, trivia, created, updated) VALUES (?, ?, ?, ?, '[]', ?, ?) ON CONFLICT (code) DO NOTHING");
  const flag = db.raw.prepare('INSERT INTO pack_public (code, public, blocked, published, updated) VALUES (?, 1, 0, ?, ?) ON CONFLICT (code) DO NOTHING');
  const like = db.raw.prepare('INSERT INTO pack_likes (code, user_id, at) VALUES (?, ?, ?) ON CONFLICT (code, user_id) DO NOTHING');
  for (const p of DEV_PUBLIC_PACKS) {
    const at = t - p.daysAgo * 86_400_000 - 3_600_000;
    pack.run(p.code, owners[p.owner], p.name, JSON.stringify(p.words), at, at);
    flag.run(p.code, at, at);
    for (let i = 1; i <= p.likes; i += 1) like.run(p.code, `de7e0000-0000-4000-8000-${String(10 + i).padStart(12, '0')}`, at + i * 60_000);
  }
}

export function seedSeason(db, t = Date.now()) {
  const now = new Date(t);
  const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
  const people = [
    [IDS.member, 'Sam', 'sam'],
    [IDS.owner, 'Jolli', 'jolli'],
    [IDS.member2, 'Riley', 'riley'],
    [IDS.admin, 'Alex', 'alex'],
    ...Array.from({ length: 8 }, (_, i) => {
      const id = `de7e0000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`;
      const f = fakeProfile(id);
      return [id, f.display_name, f.username];
    }),
  ];
  const xp = people.slice(0, 10).map(([id, name, username], i) => ({ rank: i + 1, id, name, username, value: 9200 - i * 740 }));
  const order = [1, 0, 3, 2, 5, 4, 7, 6, 9, 8];
  const shards = order.map((k, i) => {
    const [id, name, username] = people[k];
    return { rank: i + 1, id, name, username, value: 15400 - i * 1210 };
  });
  db.raw.prepare('INSERT INTO season_history (month, boards, updated) VALUES (?, ?, ?) ON CONFLICT (month) DO NOTHING').run(month, JSON.stringify({ xp, shards }), t);
}

export const DEV_LEADERBOARD_GAMES = ['trivia', 'draw', 'chain', 'wyr', 'odd', 'telephone', 'scramble', 'hive', 'emoji', 'hottakes', 'truths', 'reflex', 'bluff', 'pixel', 'higherlower', 'hangman', 'story', 'musicquiz', 'sketchduel', 'typerace', 'memory', 'beatdrop', 'closest', 'namefive'];

export const DEV_CHEATER_ID = 'de7e0000-0000-4000-8000-0000000000d0';

export function seedCheatAlerts(db, t = Date.now()) {
  db.raw.prepare('INSERT INTO party_points (user_id, name, username, points, games, wins, best, best_game, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (user_id) DO NOTHING').run(DEV_CHEATER_ID, 'XD', 'xd', 412_000, 180, 171, 50_000, 'trivia', t);
  db.raw.prepare("INSERT INTO party_stats (user_id, games, wins, by_game, counters, updated) VALUES (?, 180, 171, '{}', '{}', ?) ON CONFLICT (user_id) DO NOTHING").run(DEV_CHEATER_ID, t);
  const alert = db.raw.prepare("INSERT INTO party_cheat_alerts (id, user_id, kind, name, detail, first_at, last_at, count, status) VALUES (?, ?, ?, 'XD', ?, ?, ?, ?, 'open') ON CONFLICT (user_id, kind) DO NOTHING");
  alert.run('devcheat0001', DEV_CHEATER_ID, 'daily_points', 'Hit the 100,000 daily points cap on 3 of the last 7 days', t - 3 * 86_400_000, t - 3_600_000, 3);
  alert.run('devcheat0002', DEV_CHEATER_ID, 'game_cap', '50,000 in one Trivia game = the cap', t - 2 * 86_400_000, t - 7_200_000, 4);
  alert.run('devcheat0003', DEV_CHEATER_ID, 'win_rate', 'Won 171 of 180 Party games (95%)', t - 86_400_000, t - 600_000, 1);
}

export function seedBlockedWords(db, t = Date.now()) {
  const row = db.raw.prepare('INSERT INTO party_blocked_words (id, word, key, added_by, added_name, created) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (key) DO NOTHING');
  row.run('devword00001', 'pineapple pizza', 'pineaple piza', IDS.owner, 'Jolli', t - 86_400_000);
  const juno = fakeProfile(DEV_PARTY_ADMIN);
  row.run('devword00002', 'skibidi', customKey('skibidi'), DEV_PARTY_ADMIN, juno.display_name, t - 3_600_000);
  row.run('devword00003', 'sussy baka', customKey('sussy baka'), DEV_PARTY_ADMIN, juno.display_name, t - 20 * 60_000);
  db.raw.prepare('INSERT INTO party_blocked_patterns (id, pattern, added_by, added_name, created) VALUES (?, ?, ?, ?, ?) ON CONFLICT (pattern) DO NOTHING')
    .run('devpattern01', DEV_BLOCKED_PATTERN, IDS.owner, 'Jolli', t - 2 * 3_600_000);
}

export const DEV_BLOCKED_PATTERN = 'sk[i1]b+[i1]d[i1]+ ?t[o0]+[i1]l+e?t';

export const DEV_TEMP_BANNED = DEV_ARTISTS[3];
export const DEV_EXPIRED_BAN = DEV_ARTISTS[2];
export const DEV_WARNED = IDS.member;
export const DEV_WARNING_IDS = Object.freeze(['devwarn00001', 'devwarn00002']);

export function seedPartyModeration(db, t = Date.now()) {
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  const juno = fakeProfile(DEV_PARTY_ADMIN);
  const rex = fakeProfile(DEV_REPORT_DRAWER);
  const temp = fakeProfile(DEV_TEMP_BANNED);
  const gone = fakeProfile(DEV_EXPIRED_BAN);
  const top = fakeProfile(DEV_ARTISTS[0]);
  const sam = TEST_USERS.find((u) => u.id === DEV_WARNED);
  const samName = (sam && sam.display_name) || 'Sam';
  db.raw.prepare('INSERT INTO party_bans (id, name, username, reason, banned_by, banned_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING')
    .run(temp.id, temp.display_name, temp.username, 'Spamming the chat in Word Chain', DEV_PARTY_ADMIN, t - 2 * HOUR);
  db.raw.prepare("INSERT INTO party_ban_terms (user_id, until, duration, set_at) VALUES (?, ?, 'day', ?) ON CONFLICT (user_id) DO NOTHING")
    .run(temp.id, t - 2 * HOUR + DAY, t - 2 * HOUR);
  const banLog = db.raw.prepare('INSERT INTO party_ban_log (id, user_id, action, reason, by_id, at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING');
  banLog.run('devbanlog0003', temp.id, 'ban', 'Spamming the chat in Word Chain', DEV_PARTY_ADMIN, t - 2 * HOUR);
  banLog.run('devbanlog0004', gone.id, 'ban', 'Rude guesses in Draw', IDS.owner, t - 8 * DAY);
  banLog.run('devbanlog0005', gone.id, 'unban', 'The ban ran out', 'yapos', t - DAY);
  const warn = db.raw.prepare('INSERT INTO party_warnings (id, user_id, author_id, author_name, text, created, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING');
  warn.run(DEV_WARNING_IDS[0], DEV_WARNED, DEV_PARTY_ADMIN, juno.display_name, 'Keep drawings clean, please. Next time it is a ban.', t - 20 * MIN, null);
  warn.run(DEV_WARNING_IDS[1], rex.id, IDS.owner, 'Jolli', 'Keep drawings friendly in Sketch Duel.', t - 10 * DAY, t - 10 * DAY + HOUR);
  const log = db.raw.prepare('INSERT INTO party_mod_log (id, actor_id, actor_name, action, target_id, target_name, detail, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING');
  const rows = [
    ['devmodlog0001', IDS.owner, 'Jolli', 'ban', rex.id, rex.display_name, { duration: 'forever', reason: 'Rude drawings in Sketch Duel' }, t - 11 * DAY],
    ['devmodlog0002', IDS.owner, 'Jolli', 'dismiss', rex.id, rex.display_name, { report: DEV_PAST_REPORT_IDS[1], game: 'sketchduel' }, t - 11 * DAY + MIN],
    ['devmodlog0003', IDS.owner, 'Jolli', 'warn', rex.id, rex.display_name, { text: 'Keep drawings friendly in Sketch Duel.' }, t - 10 * DAY],
    ['devmodlog0004', DEV_PARTY_ADMIN, juno.display_name, 'note_add', rex.id, rex.display_name, { note: DEV_NOTE_IDS[2] }, t - 9 * DAY],
    ['devmodlog0005', IDS.owner, 'Jolli', 'unban', rex.id, rex.display_name, null, t - 9 * DAY + MIN],
    ['devmodlog0006', IDS.owner, 'Jolli', 'ban', gone.id, gone.display_name, { duration: 'week', reason: 'Rude guesses in Draw' }, t - 8 * DAY],
    ['devmodlog0007', IDS.owner, 'Jolli', 'dismiss', rex.id, rex.display_name, { report: DEV_PAST_REPORT_IDS[0], game: 'draw' }, t - 6 * DAY + HOUR],
    ['devmodlog0008', DEV_PARTY_ADMIN, juno.display_name, 'note_add', top.id, top.display_name, { note: DEV_NOTE_IDS[0] }, t - 2 * DAY],
    ['devmodlog0009', 'yapos', 'YapOS', 'ban_expire', gone.id, gone.display_name, { duration: 'week' }, t - DAY],
    ['devmodlog0010', IDS.owner, 'Jolli', 'word_add', null, null, { word: 'pineapple pizza' }, t - DAY],
    ['devmodlog0011', IDS.owner, 'Jolli', 'note_add', top.id, top.display_name, { note: DEV_NOTE_IDS[1] }, t - 3 * HOUR],
    ['devmodlog0012', DEV_PARTY_ADMIN, juno.display_name, 'ban', temp.id, temp.display_name, { duration: 'day', reason: 'Spamming the chat in Word Chain' }, t - 2 * HOUR],
    ['devmodlog0013', DEV_PARTY_ADMIN, juno.display_name, 'word_add', null, null, { word: 'skibidi' }, t - HOUR],
    ['devmodlog0014', DEV_PARTY_ADMIN, juno.display_name, 'warn', DEV_WARNED, samName, { text: 'Keep drawings clean, please. Next time it is a ban.' }, t - 20 * MIN],
    ['devmodlog0015', DEV_PARTY_ADMIN, juno.display_name, 'word_add', null, null, { word: 'sussy baka' }, t - 20 * MIN + 1],
    ['devmodlog0016', IDS.owner, 'Jolli', 'owner_pattern_add', null, null, { pattern: DEV_BLOCKED_PATTERN }, t - 2 * HOUR + 1],
  ];
  for (const [id, actor, actorName, action, target, targetName, detail, at] of rows) log.run(id, actor, actorName, action, target, targetName, detail ? JSON.stringify(detail) : null, at);
}

export function devGlobalBoard(t = Date.now()) {
  const levels = [
    { id: IDS.owner, name: 'Jolli', level: 27, xp: 18450, messages: 5210 },
    { id: IDS.member, name: 'Sam', level: 9, xp: 2650, messages: 640 },
    { id: IDS.member2, name: 'Riley', level: 6, xp: 1480, messages: 377 },
    { id: IDS.admin, name: 'Alex', level: 4, xp: 910, messages: 260 },
    { id: IDS.mod, name: 'Morgan', level: 2, xp: 420, messages: 98 },
    { id: DEV_FAKE_ACCOUNT.id, name: DEV_FAKE_ACCOUNT.name, level: 0, xp: DEV_FAKE_ACCOUNT.xp, messages: 3 },
  ].map((r, i) => ({ rank: i + 1, avatar_url: null, ...r }));
  const economy = [
    { id: DEV_FAKE_ACCOUNT.id, name: DEV_FAKE_ACCOUNT.name, balance: DEV_FAKE_ACCOUNT.shards },
    { id: IDS.member, name: 'Sam', balance: 1250 },
    { id: IDS.admin, name: 'Alex', balance: 980 },
    { id: IDS.member2, name: 'Riley', balance: 640 },
    { id: IDS.mod, name: 'Morgan', balance: 300 },
  ].map((r, i) => ({ rank: i + 1, avatar_url: null, ...r }));
  return { levels, economy, currency: { name: 'Shards', emoji: '\u{1F48E}' }, updatedAt: t };
}

export function seedGlobalBoard(db, t = Date.now()) {
  db.raw.prepare('INSERT INTO global_board (id, data, updated) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING').run('global', JSON.stringify(devGlobalBoard(t)), t);
  db.raw.prepare("INSERT INTO public_profiles (user_id, username, username_key, name, level, xp, shards, badges, achievements, season, clan, hidden, updated) VALUES (?, ?, ?, ?, 0, ?, ?, '[]', '[]', '[]', NULL, 0, ?) ON CONFLICT (user_id) DO NOTHING")
    .run(DEV_FAKE_ACCOUNT.id, DEV_FAKE_ACCOUNT.username, DEV_FAKE_ACCOUNT.username, DEV_FAKE_ACCOUNT.name, DEV_FAKE_ACCOUNT.xp, DEV_FAKE_ACCOUNT.shards, t);
  upsertProfile(db, DEV_FAKE_ACCOUNT.id, DEV_FAKE_ACCOUNT.username, DEV_FAKE_ACCOUNT.name, t);
}

export function seedPartyLeaderboard(db, t = Date.now()) {
  const rand = devRandom(4242);
  const people = [
    [IDS.owner, 'Jolli', 'jolli'],
    [IDS.member, 'Sam', 'sam'],
    [IDS.member2, 'Riley', 'riley'],
    [IDS.admin, 'Alex', 'alex'],
    ...Array.from({ length: 30 }, (_, i) => {
      const id = `de7e0000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`;
      const f = fakeProfile(id);
      return [id, f.display_name, f.username];
    }),
  ];
  const total = db.raw.prepare('INSERT INTO party_points (user_id, name, username, points, games, wins, best, best_game, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (user_id) DO NOTHING');
  const per = db.raw.prepare('INSERT INTO party_points_game (user_id, game, points, games, wins, best, updated) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (user_id, game) DO NOTHING');
  people.forEach(([id, name, username], i) => {
    const picks = DEV_LEADERBOARD_GAMES.filter(() => rand() < 0.45);
    if (!picks.length) picks.push(DEV_LEADERBOARD_GAMES[i % DEV_LEADERBOARD_GAMES.length]);
    let points = 0;
    let games = 0;
    let wins = 0;
    let best = 0;
    let bestGame = null;
    for (const game of picks) {
      const g = 1 + Math.floor(rand() * (40 - i));
      const w = Math.floor(g * rand() * 0.5);
      const top = 300 + Math.floor(rand() * 8000);
      const pts = Math.floor(g * top * (0.3 + rand() * 0.4));
      per.run(id, game, pts, g, w, top, t - i * 60_000);
      points += pts;
      games += g;
      wins += w;
      if (top > best) {
        best = top;
        bestGame = game;
      }
    }
    total.run(id, name, username, points, games, wins, best, bestGame, t - i * 60_000);
  });
  const month = monthOf(t);
  const monthRow = db.raw.prepare('INSERT INTO party_points_month (user_id, month, points, games, wins, best, best_game, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (user_id, month) DO NOTHING');
  people.slice(0, 24).forEach(([id], i) => {
    const games = 2 + Math.floor(rand() * 18);
    const best = 400 + Math.floor(rand() * 4000);
    const game = DEV_LEADERBOARD_GAMES[Math.floor(rand() * DEV_LEADERBOARD_GAMES.length)];
    monthRow.run(id, month, Math.max(100, 42_000 - i * 1650 - Math.floor(rand() * 900)), games, Math.floor(games * rand() * 0.5), best, game, t - i * 60_000);
  });
  const award = db.raw.prepare('INSERT INTO party_season_awards (month, rank, user_id, name, username, points, awarded) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (month, rank) DO NOTHING');
  const last = prevMonth(month);
  [[1, 1, 51_200], [2, 0, 47_850], [3, 3, 39_400]].forEach(([rank, k, pts]) => {
    const [id, name, username] = people[k];
    award.run(last, rank, id, name, username, pts, t);
  });
}

export function seedServerStats(db, serverId, t = Date.now()) {
  const HOUR = 3_600_000;
  const end = Math.floor(t / HOUR) * HOUR;
  const rand = devRandom(20261115);
  const curve = [3, 2, 1, 1, 1, 1, 2, 3, 5, 6, 7, 8, 9, 9, 10, 11, 13, 16, 22, 28, 30, 24, 14, 7];
  const stmt = db.raw.prepare('INSERT INTO server_stats (server_id, hour, messages, joins, leaves, active, updated) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (server_id, hour) DO NOTHING');
  for (let i = 30 * 24 - 1; i >= 0; i -= 1) {
    const hour = end - i * HOUR;
    const d = new Date(hour);
    const weekend = d.getUTCDay() === 0 || d.getUTCDay() === 6 ? 1.5 : 1;
    const base = curve[d.getUTCHours()] * weekend;
    const messages = Math.round(base * (0.6 + rand() * 0.8));
    const joins = rand() < 0.08 ? 1 + Math.floor(rand() * 2) : 0;
    const leaves = rand() < 0.04 ? 1 : 0;
    const active = Math.max(messages ? 1 : 0, Math.round(messages / 3));
    stmt.run(serverId, hour, messages, joins, leaves, active, t);
  }
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
  setCustomBadges(engine, [{ id: DEV_CUSTOM_BADGE.id, label: DEV_CUSTOM_BADGE.name, emoji: DEV_CUSTOM_BADGE.emoji, note: DEV_CUSTOM_BADGE.note }], '');
  grantBadge(engine, IDS.owner, DEV_CUSTOM_BADGE.id);
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
  h.fake.state.members['dev-fake-accounts'] = [{ id: DEV_FAKE_ACCOUNT.id, username: DEV_FAKE_ACCOUNT.username, display_name: DEV_FAKE_ACCOUNT.name, nickname: null, roles: [], joined_at: '2026-02-01T00:00:00Z' }];
  economy?.add?.(S, DEV_FAKE_ACCOUNT.id, DEV_FAKE_ACCOUNT.shards, 'Seeded fake account for local testing');
  await levels?.addXp?.(S, DEV_FAKE_ACCOUNT.id, DEV_FAKE_ACCOUNT.xp, 'Seeded fake account for local testing', { silent: true });

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
  ownerSim = 'auto',
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
  seedPartyReport(db);
  seedPartyPack(db, IDS.owner);
  seedDailyScores(db);
  seedPublicProfile(db);
  seedCustomBadge(db, IDS.owner);
  seedProfileLooks(db);
  seedPublicPacks(db);
  seedSeason(db);
  seedPartyLeaderboard(db);
  seedCheatAlerts(db);
  seedBlockedWords(db);
  seedPartyModeration(db);
  seedServerStats(db, IDS.server);
  seedOwnerPanel(db);
  seedGlobalBoard(db);

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
    if (url.pathname === DEV_LINK_PATH) return devLinkApprove(request, db);
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
    if (url.pathname === '/api/owner/actions' && response.status === 201) poke();
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

  const simulate = ownerSim === 'auto' ? !botHandlesOwner(path.join(HERE, '..', 'engine', 'dashboard.js')) : ownerSim === true;
  const owner = createOwnerSim({
    db,
    send: (results) => worker.fetch(new Request(`${env.PUBLIC_URL}/bot/owner/results`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${botSecret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ results }),
    }), env, ctx),
  });
  if (simulate) owner.start();

  const cleanupTimer = setInterval(() => {
    worker.scheduled({ cron: '*/15 * * * *', scheduledTime: Date.now() }, env, ctx).catch(() => {});
  }, CLEANUP_EVERY_MS);
  cleanupTimer.unref?.();

  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    clearInterval(cleanupTimer);
    owner.stop();
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
    owner,
    ownerSimulated: simulate,
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
    'YapOS Party: Pip (the first player) is the owner and Juno is an extra admin. Sign in as Jolli to manage party admins at /party and see a sample flagged drawing and a flagged Hot Takes answer at /party/reports. Rex is flagged as a repeat offender, so his reports sit at the top and under Flagged. Click Rex there to open his profile panel with every report, a past replay, his ban history and a mod note. The Pixel Art artist has a couple of mod notes too.',
    'Party leaderboard: the This month tab is filled in, and last month\'s top 3 have Party badges (Jolli is #2, with the new skill badges too).',
    `Word packs: sign in as Jolli and open /packs to edit the sample pack. Type the code ${DEV_PACK_CODE} into Draw & Guess or Trivia settings to play with it.`,
    "Daily puzzle: today's Letter Hive and Scramble already have a few scores on the leaderboard (/api/activity/daily/top?kind=hive).",
    `Owner panel: sign in as Jolli and open /owner to give people Shards, XP, achievements and badges. The Badge maker at the bottom has a sample picture badge, ${DEV_CUSTOM_BADGE.name}, that Jolli already has. ${dev.ownerSimulated ? 'A stand-in bot finishes each change about 2 seconds later.' : 'The test bot applies each change for real.'}`,
    `Global leaderboard: open /p/global?tab=shards and click any row to see their profile. Sign in as Jolli to get the mod view: "${DEV_FAKE_ACCOUNT.name}" is a fake account with ${DEV_FAKE_ACCOUNT.shards.toLocaleString('en-US')} Shards to set to 0 or hide.`,
    'Profile looks: sign in as Jolli and open /u/jolli, then press Customize profile to pin badges, pick name colours, banners and more. /u/sam shows someone else\'s look with an uploaded banner picture, which the owner can remove from /owner.',
    'Community: /u/jolli is a sample public profile, /packs/browse lists 3 public packs with likes, /seasons shows last month, and Test Town has 30 days of stats on its Stats page.',
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
