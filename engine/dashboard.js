import { VERSION, hideSecret } from './config.js';
import { parseBool, parseDuration } from './parse.js';
import { avatarUrl } from './links.js';
import { HARD_CAP } from './limits.js';
import { canGiveCurrency, CURRENCY, GLOBAL_KEY } from './global.js';

const IDLE_MS = 15_000;
const HOT_MS = 2_000;
const FIRST_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 60_000;
const START_DELAY_MS = 1_000;
const REQUEST_TIMEOUT_MS = 15_000;
const SNAPSHOT_EVERY_MS = 10 * 60_000;
const GRANT_FRESH_MS = 60 * 60_000;
const PUBLIC_EVERY_MS = 15 * 60_000;
const REFRESH_PER_TICK = 3;
const PART_MAX_BYTES = 512 * 1024;
const MAX_CASES = 2000;
const MAX_JOBS = 25;
const MAX_KEYS = 60;
const MAX_STRING = 4000;
const MAX_VALUE_CHARS = 20_000;
const MAX_DATA_CHARS = 100_000;
const MAX_PENDING_RESULTS = 100;
const TOP = 100;
const BOARD_SERVERS = 25;
const RECENT = 10;
const MEMBER_CASES = 50;
const APP_RE = /^[a-z0-9_-]{1,32}$/;
const SAFE_ID = /^[\w-]{1,64}$/;
const GRANT_LEVELS = new Set(['admin', 'owner']);
const NOT_ADMIN = 'You need to be an admin of this server.';
const LOOKUP_FAILED = "YapOS couldn't check your role just now. Try again in a minute.";
const TOO_BIG = 'YapOS sent an answer that was too big.';
const SERVER_ID = /^[0-9a-f-]{36}$/i;
const RESULT_MAX_BYTES = 500 * 1024;
const RESULTS_BATCH_BYTES = 1_500_000;
const RESULTS_PER_POST = 100;
const BOT_SERVERS_MS = 5 * 60_000;
const PAGE_SIZE = 50;
const MAX_PAGE = 100;
const MAX_QUERY = 100;
const MAX_REASON = 500;
const MAX_DURATION = 20;
const MAX_NICK = 32;
const MAX_NOTE = 500;
const MAX_CASE_NUMBER = 1_000_000_000;
const MEMBER_CACHE_CAP = 2000;
const STATS_DAYS = 14;
const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const YEAR_MS = 365 * DAY_MS;
const RESULT_ROOM = RESULT_MAX_BYTES - 8 * 1024;
const MEMBER_SORTS = new Set(['joined_new', 'joined_old', 'name']);
const TICKET_STATUSES = new Set(['open', 'closed', 'all']);
const TICKET_ACTIONS = new Set(['claim', 'unclaim', 'close']);
const MOD_ACTIONS = new Set(['warn', 'timeout', 'untimeout', 'kick', 'ban', 'unban', 'unwarn', 'role_add', 'role_remove', 'nick', 'note']);
const NO_CAN = Object.freeze({ warn: false, unwarn: false, timeout: false, kick: false, ban: false, unban: false, role: false, nick: false, note: false });
const MOD_OFF = "Mod isn't installed here. Install it first.";
const TICKETS_OFF = "Tickets isn't installed here. Install it first.";
const UNKNOWN_JOB = "I don't know that job.";
const BAD_LENGTH = "I couldn't read that length. Try something like 10m, 2h or 3d.";
const OWNER_ONLY = 'Only the bot owner can change this.';

export const SLUG_RE = /^[a-z0-9-]{3,32}$/;

export const accept = (value) => ({ value });
export const reject = (error) => ({ error });
export const isBlank = (v) => v === null || v === undefined || (typeof v === 'string' && !v.trim());
export const plainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

export function toBool(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number' && (v === 0 || v === 1)) return v === 1;
  return typeof v === 'string' ? parseBool(v) : null;
}

export function boolField(spec) {
  return {
    type: 'boolean',
    web: true,
    ...spec,
    validate: spec.validate || ((ctx, v) => {
      const b = toBool(v);
      return b === null ? reject('Use on or off.') : accept(b);
    }),
  };
}

export const safeId = (v) => {
  const s = String(v ?? '').trim();
  const m = /^<(?:#|@&|@!?)([\w-]+)>$/.exec(s);
  const id = m ? m[1] : s;
  return SAFE_ID.test(id) ? id : null;
};

export function idList(v) {
  if (v === null || v === undefined || v === '') return [];
  if (!Array.isArray(v)) return null;
  const out = [];
  for (const x of v) {
    const id = safeId(x);
    if (!id) return null;
    out.push(id);
  }
  return out;
}

export async function channelById(ctx, v, kind = 'text') {
  const id = safeId(v);
  if (!id) return null;
  const ch = await ctx.findChannel(`<#${id}>`, kind).catch(() => null);
  if (!ch || ch.id !== id) return null;
  if (ch.server_id && ch.server_id !== ctx.serverId) return null;
  return ch;
}

export async function roleById(ctx, v) {
  const id = safeId(v);
  if (!id) return null;
  const role = await ctx.findRole(`<@&${id}>`).catch(() => null);
  return role && role.id === id ? role : null;
}

function readPath(obj, key) {
  let cur = obj;
  for (const part of key.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

export function fieldValue(field, cfg, core) {
  if (typeof field.read === 'function') return field.read(cfg, core);
  if (field.key.startsWith('core.')) return readPath(core, field.key.slice(5));
  return readPath(cfg, field.key);
}

export async function saveField(ctx, field, value, all) {
  if (typeof field.save === 'function') return field.save(ctx, value, all);
  if (field.key.startsWith('core.')) {
    ctx.engine.settings.patchCore(ctx.serverId, { [field.key.slice(5)]: value });
    return undefined;
  }
  const dot = field.key.indexOf('.');
  if (dot < 0) {
    ctx.patchConfig({ [field.key]: value });
    return undefined;
  }
  const top = field.key.slice(0, dot);
  const rest = field.key.slice(dot + 1);
  const cur = ctx.config()[top];
  ctx.patchConfig({ [top]: { ...(plainObject(cur) ? cur : {}), [rest]: value } });
  return undefined;
}

function withLabels(out, field, cfg, core) {
  if (typeof field.labels !== 'function') return out;
  try {
    const labels = field.labels(cfg, core);
    if (plainObject(labels)) out.labels = Object.fromEntries(Object.entries(labels).filter(([, v]) => typeof v === 'string').slice(0, 50).map(([k, v]) => [k, v.slice(0, 60)]));
  } catch {}
  return out;
}

export function jsonSafe(value, depth = 0) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : value === Infinity ? 'inf' : null;
  if (depth > 6) return value;
  if (Array.isArray(value)) return value.map((v) => jsonSafe(v, depth + 1));
  if (plainObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, jsonSafe(v, depth + 1)]));
  return value;
}

export function publicSchema(field, defaults = {}) {
  const out = { key: field.key, label: field.label || field.key, help: field.help || '', type: field.type || 'string' };
  const def = field.default !== undefined ? field.default : field.key.startsWith('core.') ? null : readPath(defaults, field.key);
  out.default = def === undefined ? null : jsonSafe(structuredClone(def));
  for (const k of ['min', 'max', 'step', 'maxLength']) {
    const v = field[k];
    if (typeof v !== 'number') continue;
    if (Number.isFinite(v)) out[k] = v;
    else if (k === 'max') out[k] = HARD_CAP;
  }
  if (field.unlimited === true) out.unlimited = true;
  if (Array.isArray(field.options)) out.options = field.options.map((o) => (typeof o === 'object' ? { value: o.value, label: String(o.label ?? o.value) } : { value: o, label: String(o) }));
  out.web = field.web === true;
  out.owner = field.owner === true;
  if (typeof field.editor === 'string') out.editor = field.editor;
  if (field.note) out.note = field.note;
  return out;
}

function tooBig(value) {
  let big = false;
  const walk = (v, depth) => {
    if (big) return;
    if (depth > 6) { big = true; return; }
    if (typeof v === 'string') { if (v.length > MAX_STRING) big = true; return; }
    if (Array.isArray(v)) { if (v.length > 1000) big = true; else v.forEach((x) => walk(x, depth + 1)); return; }
    if (v && typeof v === 'object') { const e = Object.entries(v); if (e.length > 200) big = true; else e.forEach(([k, x]) => { if (k.length > 100) big = true; walk(x, depth + 1); }); }
  };
  walk(value, 0);
  if (big) return true;
  try { return JSON.stringify(value ?? null).length > MAX_VALUE_CHARS; } catch { return true; }
}

const plainName = (text) => String(text ?? '').replace(/<[@#][!&]?[\w-]+>/g, '').replace(/[*_~`|\\<>@#]/g, '').replace(/\s+/g, ' ').trim().slice(0, 64) || 'Someone';
const memberName = (m) => plainName(m?.nickname || m?.display_name || m?.username || 'Someone');

function cleanBase(url) {
  if (!url || typeof url !== 'string') return { base: null, reason: null };
  let u;
  try { u = new URL(url.trim()); } catch { return { base: null, reason: "the dashboard address isn't a valid link" }; }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return { base: null, reason: 'the dashboard address has to start with https://' };
  return { base: `${u.origin}${u.pathname.replace(/\/+$/, '')}`, reason: null };
}

const blank = (v) => v === undefined || v === null || v === '';

function textArg(v, max) {
  if (blank(v)) return '';
  return typeof v === 'string' && v.length <= max ? v : null;
}

function intArg(v, min, max, fallback) {
  if (blank(v)) return fallback;
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,10}$/.test(v.trim()) ? Number(v.trim()) : NaN;
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

function optionalId(v) {
  if (blank(v)) return '';
  return typeof v === 'string' ? safeId(v) : null;
}

function durationArg(text) {
  const s = text.trim().toLowerCase();
  if (!s) return 0;
  const years = /^(\d{1,2})\s*(?:y|yr|yrs|year|years)$/.exec(s);
  if (years) return Number(years[1]) * YEAR_MS;
  const ms = parseDuration(s);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

const isBotMember = (m, botId) => !!m && (m.id === botId || m.bot === true || m.is_bot === true || (Array.isArray(m.badges) && m.badges.includes('bot')));
const joinedAt = (m) => { const t = Date.parse(m?.joined_at ?? ''); return Number.isFinite(t) ? t : null; };
const isEveryone = (r, sid) => /^@?everyone$/i.test(r?.name || '') || r?.id === sid || r?.id === 'everyone';

function utcDayStart(ms) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function emptyDays(t) {
  const first = utcDayStart(t) - (STATS_DAYS - 1) * DAY_MS;
  return Array.from({ length: STATS_DAYS }, (_, i) => ({ day: new Date(first + i * DAY_MS).toISOString().slice(0, 10), count: 0 }));
}

function sizeOf(value) {
  try { return Buffer.byteLength(JSON.stringify(value ?? null)); } catch { return Infinity; }
}

export function createDashboard({ engine, url, secret, fetch: fetchImpl = globalThis.fetch, now = () => Date.now(), setTimeout: setT = setTimeout, clearTimeout: clearT = clearTimeout, log = engine.log } = {}) {
  hideSecret(secret);
  const { base, reason } = cleanBase(url);
  const key = typeof secret === 'string' ? secret.trim() : '';
  const enabled = !!(base && key && typeof fetchImpl === 'function');
  const state = {
    timer: null, stopped: true, busy: false, failures: 0, delay: null, hot: false,
    used: new Map(), snapped: new Map(), published: new Map(), pending: [],
    gone: new Set(), botIds: null, botIdsAt: -Infinity, dirty: new Set(), boardAt: -Infinity,
  };

  async function request(method, path, body) {
    const headers = { authorization: `Bearer ${key}`, accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetchImpl(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    let data = null;
    try {
      const text = await res.text();
      data = text ? JSON.parse(text) : null;
    } catch { data = null; }
    return { ok: !!res.ok, status: res.status, data };
  }

  async function levelOf(sid, uid) {
    const { perms } = engine;
    perms.invalidateKey(`m:${sid}:${uid}`);
    let member;
    try {
      member = await perms.member(sid, uid);
    } catch (e) {
      throw Object.assign(new Error(LOOKUP_FAILED), { lookup: true, cause: e });
    }
    if (!member) return { level: 'member', member: null };
    const level = await perms.level(sid, uid).catch(() => 'member');
    return { level, member };
  }

  function ctxFor(sid, uid, member, app) {
    return engine.contextFor({ server_id: sid, user_id: uid, username: memberName(member), channel_id: null, dashboard: true }, { app, kind: 'dashboard', args: '' });
  }

  function compactCase(c) {
    const out = {
      n: c.id,
      type: c.action,
      user: { id: c.targetId ?? null, name: String(c.targetName ?? '') },
      mod: { id: c.actorId ?? null, name: String(c.actorName ?? '') },
      reason: String(c.reason ?? ''),
      at: c.at,
    };
    if (c.durationMs) out.duration = c.durationMs;
    const t = now();
    if (c.undone) out.active = false;
    else if (c.action === 'timeout' && c.durationMs) out.active = c.at + c.durationMs > t;
    else if (c.action === 'ban' && c.meta?.until) out.active = c.meta.until > t;
    return out;
  }

  function casesOf(sid) {
    const data = engine.store.get('mod', sid, null);
    const list = Array.isArray(data?.cases) ? data.cases : [];
    return list.slice(-MAX_CASES).reverse().map(compactCase);
  }

  async function overview(sid) {
    const { perms, settings, apps, stats, budget } = engine;
    const server = await perms.server(sid).catch(() => null);
    const counts = await engine.bot.memberCounts?.(sid).catch(() => null);
    const list = apps.list();
    const tickets = engine.store.get('tickets', sid, null);
    const stars = engine.store.get('starboard', `${sid}.posts`, null);
    const cases = casesOf(sid);
    const out = {
      id: sid,
      name: server?.name || 'Server',
      icon_url: avatarUrl(server?.icon_path ?? server?.icon ?? null),
      member_count: counts?.member_count ?? server?.member_count ?? 0,
      bot: {
        version: VERSION.full,
        uptimeSec: Math.max(0, Math.floor((Date.now() - engine.startedAt) / 1000)),
        gateway: engine.gatewayState(),
        latencyMs: stats.lastLatencyMs ?? null,
        verified: !!budget.verified,
      },
      apps: { enabled: list.filter((a) => settings.isEnabled(sid, a.meta.id)).length, total: list.length },
      recent: cases.slice(0, RECENT),
      counts: {
        cases: cases.length,
        openTickets: Object.values(tickets?.tickets || {}).filter((t) => t?.status === 'open' || t?.status === 'closing').length,
        starboardPosts: Object.keys(stars || {}).length,
      },
      stats: await overviewStats(sid),
    };
    const online = counts?.online_count ?? server?.online_count;
    if (typeof online === 'number') out.online_count = online;
    return out;
  }

  async function overviewStats(sid) {
    const t = now();
    const mod = engine.service('mod');
    let base = null;
    try { base = mod?.stats ? mod.stats(sid) : null; } catch (e) { log.debug('[dashboard] mod stats failed', e?.message); }
    const tickets = Object.values(engine.store.get('tickets', sid, null)?.tickets || {}).filter(plainObject);
    const members = await engine.cache.members(sid).catch(() => null);
    const count = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);
    const days = Array.isArray(base?.casesByDay) && base.casesByDay.length ? base.casesByDay.map((d) => ({ day: String(d?.day ?? ''), count: count(d?.count) })) : emptyDays(t);
    return {
      casesByDay: days,
      casesByType: plainObject(base?.casesByType) ? Object.fromEntries(Object.entries(base.casesByType).map(([k, v]) => [k, count(v)])) : {},
      activeWarns: count(base?.activeWarns),
      activeTimeouts: Number.isInteger(base?.activeTimeouts) ? base.activeTimeouts : null,
      tempBans: count(base?.tempBans),
      tickets: {
        open: tickets.filter((x) => x.status === 'open' || x.status === 'closing').length,
        closed7d: tickets.filter((x) => x.status === 'closed' && Number(x.closedAt) >= t - WEEK_MS).length,
      },
      newMembers7d: Array.isArray(members) && members.length ? members.filter((m) => (joinedAt(m) ?? -Infinity) >= t - WEEK_MS).length : null,
    };
  }

  function appsPart(sid) {
    return engine.apps.list().map(({ meta, def }) => ({
      id: meta.id,
      name: meta.name,
      icon: meta.icon,
      category: meta.category,
      description: meta.description,
      enabled: engine.settings.isEnabled(sid, meta.id),
      canDisable: !meta.core,
      settingsCount: (def.dashboard || []).length,
    }));
  }

  async function lookups(sid) {
    const channels = await engine.cache.channels(sid).catch(() => []);
    const cats = await engine.bot.categories?.(sid).catch(() => []) || [];
    const roles = await engine.perms.roles(sid).catch(() => []);
    const outRoles = [];
    for (const r of roles) {
      const everyone = /^@?everyone$/i.test(r.name || '') || r.id === sid || r.id === 'everyone';
      const can = everyone ? { ok: false } : await engine.perms.canManageRole(sid, r.id).catch(() => ({ ok: false }));
      outRoles.push({ id: r.id, name: r.name, color: r.color ?? null, position: r.position ?? 0, manageable: !!can.ok });
    }
    return {
      channels: [
        ...channels.map((c) => ({ id: c.id, name: c.name, kind: c.type || c.kind || 'text', category: c.category_id ?? null })),
        ...cats.filter((c) => c?.id).map((c) => ({ id: c.id, name: c.name, kind: 'category', category: null })),
      ],
      roles: outRoles,
    };
  }

  async function settingsPart(sid) {
    const core = engine.settings.core(sid);
    const out = {};
    for (const { meta, def } of engine.apps.list()) {
      const fields = Array.isArray(def.dashboard) ? def.dashboard : [];
      const cfg = engine.settings.appConfig(sid, meta.id);
      const values = {};
      for (const f of fields) {
        try { values[f.key] = jsonSafe(structuredClone(fieldValue(f, cfg, core) ?? null)); } catch { values[f.key] = null; }
      }
      out[meta.id] = { values, schema: fields.map((f) => withLabels(publicSchema(f, meta.defaults), f, cfg, core)) };
    }
    out.lookups = await lookups(sid);
    return out;
  }

  async function snapshot(sid) {
    const cases = casesOf(sid);
    while (cases.length && sizeOf(cases) > PART_MAX_BYTES) cases.splice(Math.floor(cases.length * 0.9));
    return { overview: await overview(sid), apps: appsPart(sid), settings: await settingsPart(sid), cases, updatedAt: now() };
  }

  async function pushSnapshot(sid) {
    const body = await snapshot(sid);
    const r = await request('PUT', `/bot/snapshot/${encodeURIComponent(sid)}`, body);
    if (r.ok) state.snapped.set(sid, now());
    else log.debug(`[dashboard] snapshot push for ${sid} answered ${r.status}`);
    return body;
  }

  async function namesFor(sid) {
    const members = await engine.cache.members(sid).catch(() => []);
    return new Map(members.map((m) => [m.id, m]));
  }

  function serverIds() {
    return engine.settings.servers().filter((sid) => sid !== GLOBAL_KEY && SERVER_ID.test(sid));
  }

  async function knownPeople() {
    const out = new Map();
    let left = BOARD_SERVERS;
    for (const sid of serverIds()) {
      if (left-- <= 0) break;
      for (const m of (await namesFor(sid).catch(() => new Map())).values()) if (m?.id && !out.has(m.id)) out.set(m.id, m);
    }
    return out;
  }

  async function globalBoard() {
    const known = await knownPeople();
    const who = (u) => {
      const m = known.get(u.id);
      const saved = typeof u.name === 'string' && u.name.trim() ? plainName(u.name) : null;
      return { name: m ? memberName(m) : saved || 'Someone', avatar_url: avatarUrl(m?.avatar_path ?? u.avatar_path ?? null) };
    };
    const levelsSvc = engine.service('levels');
    const econSvc = engine.service('economy');
    const levels = (levelsSvc?.ranked?.() || []).slice(0, TOP).map((u, i) => ({ rank: i + 1, id: u.id, ...who(u), level: u.level, xp: u.xp, messages: u.messages || 0 }));
    const economy = (econSvc?.ranked?.() || []).slice(0, TOP).map((u, i) => ({ rank: i + 1, id: u.id, ...who(u), balance: u.bal }));
    return { levels, economy, currency: { ...CURRENCY }, updatedAt: now() };
  }

  async function publicPage(sid) {
    const core = engine.settings.core(sid);
    const page = plainObject(core.publicPage) ? core.publicPage : {};
    const server = await engine.perms.server(sid).catch(() => null);
    return {
      enabled: page.enabled === true,
      slug: typeof page.slug === 'string' ? page.slug : null,
      name: server?.name || 'Server',
      icon: avatarUrl(server?.icon_path ?? server?.icon ?? null),
      global: await globalBoard(),
      updatedAt: now(),
    };
  }

  async function publishGlobal() {
    if (!enabled) return { ok: false, status: 0 };
    const r = await request('PUT', '/bot/global', await globalBoard());
    if (r.ok) state.boardAt = now();
    else log.debug(`[dashboard] the global board answered ${r.status}`);
    return { ok: r.ok, status: r.status };
  }

  async function publishPublic(sid) {
    if (!enabled) return { ok: false, status: 0 };
    const body = await publicPage(sid);
    const r = await request('PUT', `/bot/public/${encodeURIComponent(sid)}`, body);
    if (r.ok) {
      state.published.set(sid, now());
      state.boardAt = now();
    }
    return { ok: r.ok, status: r.status };
  }

  async function unpublishPublic(sid) {
    if (!enabled) return { ok: false, status: 0 };
    state.published.delete(sid);
    const r = await request('DELETE', `/bot/public/${encodeURIComponent(sid)}`);
    return { ok: r.ok || r.status === 404, status: r.status };
  }

  async function botServers() {
    const list = await engine.bot.servers().catch(() => null);
    return Array.isArray(list) ? list : [];
  }

  async function botServerIds() {
    const t = now();
    if (state.botIds && t - state.botIdsAt < BOT_SERVERS_MS) return state.botIds;
    const list = await engine.bot.servers().catch(() => null);
    if (!Array.isArray(list)) return state.botIds;
    state.botIds = new Set(list.map((s) => s?.id).filter(Boolean));
    state.botIdsAt = t;
    return state.botIds;
  }

  async function serverGone(sid) {
    state.used.delete(sid);
    state.snapped.delete(sid);
    state.botIds?.delete(sid);
    state.gone.add(sid);
    return unpublishPublic(sid);
  }

  async function modLog(sid, member, appName, labels) {
    const channelId = engine.settings.core(sid).logChannel;
    if (!channelId || !labels.length) return;
    const content = `⚙️ ${memberName(member)} changed ${plainName(appName)}: ${labels.join(', ')} on the dashboard`;
    await engine.budget.send({ serverId: sid, channelId, content: content.slice(0, 2000), priority: 'low' }).catch((e) => log.debug('[dashboard] mod log line failed', e?.message));
  }

  async function runChange(sid, uid, data) {
    const { level, member } = await levelOf(sid, uid);
    if (!GRANT_LEVELS.has(level)) return { result: { grant: false, level, error: NOT_ADMIN }, error: NOT_ADMIN };
    const applied = {};
    const errors = {};
    const labels = [];
    const appId = typeof data.app === 'string' && APP_RE.test(data.app) ? data.app : null;
    const app = appId ? engine.apps.get(appId) : null;
    if (!app) {
      errors.app = "That app doesn't exist.";
      return { result: { grant: true, level, applied, errors, snapshot: null } };
    }
    const { meta, def } = app;
    state.used.set(sid, now());
    if (data.enabled !== undefined) {
      if (typeof data.enabled !== 'boolean') errors.enabled = 'Use true or false.';
      else if (meta.core) errors.enabled = 'System apps are always on.';
      else {
        const was = engine.settings.isEnabled(sid, meta.id);
        engine.settings.setEnabled(sid, meta.id, data.enabled);
        applied.enabled = data.enabled;
        if (was !== data.enabled) labels.push(data.enabled ? 'installed' : 'uninstalled');
      }
    }
    if (data.settings !== undefined && data.settings !== null) {
      if (!plainObject(data.settings)) errors.settings = 'Settings have to be a list of names and values.';
      else {
        const entries = Object.entries(data.settings);
        if (entries.length > MAX_KEYS) errors.settings = 'That is too many settings at once.';
        else {
          const fields = Array.isArray(def.dashboard) ? def.dashboard : [];
          const ctx = ctxFor(sid, uid, member, meta.id);
          for (const [k, value] of entries) {
            const field = k.length <= 100 ? fields.find((f) => f.key === k) : null;
            if (!field) { errors[k.slice(0, 100)] = "That setting doesn't exist."; continue; }
            if (field.web !== true || typeof field.validate !== 'function') { errors[k] = field.note || "That setting can't be changed on the dashboard."; continue; }
            if (field.owner === true && !canGiveCurrency(engine, uid)) { errors[k] = OWNER_ONLY; continue; }
            if (!engine.settings.isEnabled(sid, meta.id)) { errors[k] = `${meta.name} isn't installed here. Install it first.`; continue; }
            if (tooBig(value)) { errors[k] = 'That value is too long.'; continue; }
            try {
              const checked = await field.validate(ctx, value, data.settings);
              if (!checked || checked.error) { errors[k] = checked?.error || "That value didn't work."; continue; }
              const safe = jsonSafe(checked.value);
              const saved = await saveField(ctx, field, safe, data.settings);
              if (saved?.error) { errors[k] = saved.error; continue; }
              if (saved?.applied) Object.assign(applied, jsonSafe(saved.applied));
              else applied[k] = safe;
              labels.push(field.label || k);
            } catch (e) {
              if (!e?.friendly) log.warn(`[dashboard] saving ${meta.id}.${k} failed:`, e);
              errors[k] = e?.friendly ? String(e.message) : "That didn't save. Try again in a minute.";
            }
          }
        }
      }
    }
    if (labels.length) modLog(sid, member, meta.name, [...new Set(labels)]).catch((e) => log.debug('[dashboard] mod log line failed', e?.message));
    const snap = await pushSnapshot(sid).catch((e) => { log.debug('[dashboard] snapshot after change failed', e?.message); return null; });
    const fresh = snap || { apps: appsPart(sid), settings: await settingsPart(sid) };
    return { result: { grant: true, level, applied, errors, snapshot: { apps: fresh.apps, settings: fresh.settings } } };
  }

  const denied = (level) => ({ result: { grant: false, level, error: NOT_ADMIN }, error: NOT_ADMIN });

  function guarded(fn) {
    return async (sid, uid, data) => {
      const { level, member } = await levelOf(sid, uid);
      if (!GRANT_LEVELS.has(level)) return denied(level);
      state.used.set(sid, now());
      return fn(sid, uid, data, { level, member });
    };
  }

  function fallbackDetail(m) {
    return { username: m?.username ?? null, nickname: m?.nickname ?? null, joined_at: m?.joined_at ?? null, roles: [], timeout: null, banned: false, tempBan: null, notes: [], can: { ...NO_CAN } };
  }

  function lastKnownName(cases) {
    const hit = cases.find((c) => c.user?.name);
    return hit ? plainName(hit.user.name) : null;
  }

  async function memberInfo(sid, uid, target) {
    engine.perms.invalidateKey(`m:${sid}:${target}`);
    const m = await engine.perms.member(sid, target).catch(() => null);
    const mod = engine.service('mod');
    const levels = engine.settings.isEnabled(sid, 'levels') ? engine.service('levels') : null;
    const econ = engine.settings.isEnabled(sid, 'economy') ? engine.service('economy') : null;
    const cases = casesOf(sid).filter((c) => c.user.id === target).slice(0, MEMBER_CASES);
    const warnings = (mod?.activeWarns?.(sid, target) || []).map((w) => ({ case: w.caseId, at: w.at, reason: w.reason || '' }));
    let lv = null;
    try { lv = levels?.getUser ? levels.getUser(sid, target) : null; } catch { lv = null; }
    let bal = null;
    try { bal = econ?.balance ? econ.balance(sid, target) : null; } catch { bal = null; }
    let detail = null;
    try { detail = mod?.memberDetail ? await mod.memberDetail(sid, target, uid) : null; } catch (e) { log.debug('[dashboard] member detail failed', e?.message); }
    if (!plainObject(detail)) detail = fallbackDetail(m);
    const can = plainObject(detail.can) && engine.settings.isEnabled(sid, 'mod') ? detail.can : NO_CAN;
    return {
      ...detail,
      id: target,
      name: m ? memberName(m) : lastKnownName(cases) || (detail.banned ? 'Banned member' : 'Not in the server'),
      avatar_url: avatarUrl(m?.avatar_path ?? null),
      bot: isBotMember(m, engine.bot.me?.id ?? null),
      warnings,
      cases,
      levels: lv ? { level: lv.level, xp: lv.xp, messages: lv.messages || 0, voiceSeconds: lv.voiceSeconds || 0 } : null,
      economy: bal === null ? null : { balance: bal },
      can: Object.fromEntries(Object.keys(NO_CAN).map((k) => [k, can[k] === true])),
    };
  }

  async function runMember(sid, uid, data, { level }) {
    const target = typeof data.user_id === 'string' ? safeId(data.user_id) : null;
    if (!target) return { result: { grant: true, level, member: null, error: "That member id doesn't look right." } };
    return { result: { grant: true, level, member: await memberInfo(sid, uid, target) } };
  }

  async function roleOrder(sid) {
    const roles = await engine.perms.roles(sid).catch(() => null);
    if (!Array.isArray(roles)) return null;
    return new Map(roles.filter((r) => r?.id && !isEveryone(r, sid)).map((r) => [r.id, typeof r.position === 'number' ? r.position : 0]));
  }

  function caseCounts(sid) {
    const data = engine.store.get('mod', sid, null);
    const counts = new Map();
    for (const c of Array.isArray(data?.cases) ? data.cases : []) if (c?.targetId) counts.set(c.targetId, (counts.get(c.targetId) || 0) + 1);
    return counts;
  }

  function sortMembers(list, sort) {
    const byName = (a, b) => memberName(a).toLowerCase().localeCompare(memberName(b).toLowerCase()) || String(a.id).localeCompare(String(b.id));
    if (sort === 'name') return list.sort(byName);
    const dir = sort === 'joined_old' ? 1 : -1;
    return list.sort((a, b) => {
      const x = joinedAt(a);
      const y = joinedAt(b);
      if (x === y) return byName(a, b);
      if (x === null) return 1;
      if (y === null) return -1;
      return (x - y) * dir;
    });
  }

  function memberRow(sid, m, { order, cases, mod, botId }) {
    const ids = (Array.isArray(m.roles) ? m.roles : []).filter((r) => typeof r === 'string' && r !== sid && (!order || order.has(r)));
    if (order) ids.sort((a, b) => order.get(b) - order.get(a));
    let warnings = 0;
    try { warnings = mod?.activeWarns ? mod.activeWarns(sid, m.id).length : 0; } catch { warnings = 0; }
    return {
      id: m.id,
      name: memberName(m),
      username: typeof m.username === 'string' ? m.username.slice(0, 64) : '',
      avatar_url: avatarUrl(m.avatar_path ?? null),
      joined_at: typeof m.joined_at === 'string' ? m.joined_at : null,
      roles: ids,
      bot: isBotMember(m, botId),
      warnings,
      cases: cases.get(m.id) || 0,
    };
  }

  async function runMembers(sid, uid, data, { level }) {
    const empty = { members: [], total: 0, page: 1, pages: 1, pageSize: PAGE_SIZE, capped: false };
    const bad = (error) => ({ result: { grant: true, level, ...empty, error } });
    const q = textArg(data.q, MAX_QUERY);
    if (q === null) return bad('That search is too long.');
    const role = optionalId(data.role);
    if (role === null) return bad("That role id doesn't look right.");
    const sort = blank(data.sort) ? 'joined_new' : MEMBER_SORTS.has(data.sort) ? data.sort : null;
    if (!sort) return bad('Sort by newest, oldest or name.');
    const page = intArg(data.page, 1, MAX_PAGE, 1);
    if (page === null) return bad(`Pick a page from 1 to ${MAX_PAGE}.`);
    const all = await engine.cache.members(sid).catch(() => null);
    if (!Array.isArray(all)) return bad("I couldn't load the member list just now. Try again in a minute.");
    const needle = q.trim().toLowerCase();
    const hit = (m) => !needle || [m.nickname, m.display_name, m.username, m.id].some((x) => typeof x === 'string' && x.toLowerCase().includes(needle));
    const hasRole = (m) => !role || (Array.isArray(m.roles) && m.roles.includes(role));
    const list = sortMembers(all.filter((m) => plainObject(m) && typeof m.id === 'string' && hasRole(m) && hit(m)), sort);
    const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
    const at = Math.min(page, pages);
    const ctx = { order: await roleOrder(sid), cases: caseCounts(sid), mod: engine.service('mod'), botId: engine.bot.me?.id ?? null };
    const members = list.slice((at - 1) * PAGE_SIZE, at * PAGE_SIZE).map((m) => memberRow(sid, m, ctx));
    const counts = await engine.bot.memberCounts?.(sid).catch(() => null);
    const total = counts?.member_count ?? (await engine.perms.server(sid).catch(() => null))?.member_count;
    const capped = all.length >= MEMBER_CACHE_CAP || (typeof total === 'number' && total > all.length);
    return { result: { grant: true, level, members, total: list.length, page: at, pages, pageSize: PAGE_SIZE, capped } };
  }

  function modArgs(data) {
    const action = typeof data.action === 'string' && MOD_ACTIONS.has(data.action) ? data.action : null;
    if (!action) return { error: "I don't know that action." };
    const target = typeof data.user_id === 'string' ? safeId(data.user_id) : null;
    if (!target) return { error: "That member id doesn't look right." };
    const reason = textArg(data.reason, MAX_REASON);
    if (reason === null) return { error: `Keep the reason under ${MAX_REASON} characters.` };
    const duration = textArg(data.duration, MAX_DURATION);
    if (duration === null) return { error: BAD_LENGTH };
    const nickname = textArg(data.nickname, MAX_NICK);
    if (nickname === null) return { error: `Nicknames can be up to ${MAX_NICK} characters.` };
    const note = textArg(data.note, MAX_NOTE);
    if (note === null) return { error: `Keep the note under ${MAX_NOTE} characters.` };
    const roleId = optionalId(data.role_id);
    if (roleId === null) return { error: "That role id doesn't look right." };
    const caseNumber = intArg(data.case, 1, MAX_CASE_NUMBER, 0);
    if (caseNumber === null) return { error: "That case number doesn't look right." };
    let durationMs = null;
    if (action === 'timeout' || action === 'ban') {
      const ms = durationArg(duration);
      if (ms === null) return { error: BAD_LENGTH };
      if (action === 'timeout' && !ms) return { error: 'Pick how long the timeout should last.' };
      durationMs = ms || null;
    }
    if ((action === 'role_add' || action === 'role_remove') && !roleId) return { error: 'Pick a role first.' };
    if (action === 'unwarn' && !caseNumber) return { error: 'Pick the warning to remove.' };
    if (action === 'note' && !note.trim()) return { error: 'The note was empty, so nothing was saved.' };
    return { value: { action, target, reason: reason.trim(), durationMs, nickname, note: note.trim(), roleId: roleId || null, caseNumber: caseNumber || null } };
  }

  async function modError(sid, mod, e, a) {
    if (!e?.friendly) log.debug(`[dashboard] ${a.action} from the dashboard failed`, e?.message);
    const who = await engine.perms.member(sid, a.target).catch(() => null);
    let text = null;
    try { text = typeof mod.explainError === 'function' ? mod.explainError(e, a.action, who ? memberName(who) : 'that member') : null; } catch { text = null; }
    return String(text || (e?.friendly ? e.message : "That didn't work. Try again in a minute.")).slice(0, 1000);
  }

  async function runModAction(sid, uid, data, { level }) {
    const no = (error) => ({ result: { grant: true, level, ok: false, error } });
    const args = modArgs(data);
    if (args.error) return no(args.error);
    const a = args.value;
    const mod = engine.service('mod');
    if (!engine.settings.isEnabled(sid, 'mod') || typeof mod?.act !== 'function') return no(MOD_OFF);
    let out;
    try {
      out = await mod.act(sid, {
        actorId: uid, kind: a.action, targetId: a.target, durationMs: a.durationMs, reason: a.reason,
        roleId: a.roleId, nickname: a.nickname, note: a.note, caseNumber: a.caseNumber, source: 'dashboard',
      });
    } catch (e) {
      return no(await modError(sid, mod, e, a));
    }
    const member = await memberInfo(sid, uid, a.target);
    state.dirty.add(sid);
    return {
      result: {
        grant: true,
        level,
        ok: true,
        action: a.action,
        case: plainObject(out?.case) ? compactCase(out.case) : null,
        message: String(out?.message || 'Done.').slice(0, 1000),
        member,
      },
    };
  }

  function ticketsService(sid) {
    if (!engine.settings.isEnabled(sid, 'tickets')) return null;
    const svc = engine.service('tickets');
    return svc && typeof svc.list === 'function' ? svc : null;
  }

  async function runTickets(sid, uid, data, { level }) {
    const empty = { tickets: [], total: 0, page: 1, pages: 1, pageSize: PAGE_SIZE, counts: { open: 0, closed: 0 }, rating: { average: null, count: 0 } };
    const bad = (error) => ({ result: { grant: true, level, ...empty, error } });
    const status = blank(data.status) ? 'open' : TICKET_STATUSES.has(data.status) ? data.status : null;
    if (!status) return bad('Show open, closed or all tickets.');
    const q = textArg(data.q, MAX_QUERY);
    if (q === null) return bad('That search is too long.');
    const page = intArg(data.page, 1, MAX_PAGE, 1);
    if (page === null) return bad(`Pick a page from 1 to ${MAX_PAGE}.`);
    const svc = ticketsService(sid);
    if (!svc) return bad(TICKETS_OFF);
    const out = await svc.list(sid, { status, q: q.trim(), page });
    return { result: { grant: true, level, ...empty, ...(plainObject(out) ? out : {}) } };
  }

  function fitTranscript(result) {
    let size = sizeOf(result);
    while (size > RESULT_ROOM && result.transcript?.text) {
      const text = result.transcript.text;
      result.transcript = { ...result.transcript, text: text.slice(Math.min(text.length, Math.max(1024, size - RESULT_ROOM))) };
      size = sizeOf(result);
    }
    return result;
  }

  async function runTicket(sid, uid, data, { level }) {
    const bad = (error) => ({ result: { grant: true, level, ticket: null, transcript: null, error } });
    const number = intArg(data.number, 1, MAX_CASE_NUMBER, null);
    if (!number) return bad("That ticket number doesn't look right.");
    const svc = ticketsService(sid);
    if (!svc) return bad(TICKETS_OFF);
    const ticket = await svc.get(sid, number);
    if (!plainObject(ticket)) return bad("I couldn't find that ticket.");
    let raw = null;
    try { raw = await svc.transcript(sid, number); } catch (e) { log.debug('[dashboard] ticket transcript failed', e?.message); }
    const transcript = plainObject(raw) && typeof raw.text === 'string'
      ? { text: raw.text, count: Number.isInteger(raw.count) ? raw.count : 0, live: raw.live === true }
      : null;
    return { result: fitTranscript({ grant: true, level, ticket, transcript }) };
  }

  async function ticketCall(svc, sid, number, uid, action, reason) {
    if (action === 'close') return svc.close(sid, number, { by: uid, reason });
    return action === 'claim' ? svc.claim(sid, number, uid) : svc.unclaim(sid, number, uid);
  }

  async function runTicketAction(sid, uid, data, { level }) {
    const no = (error) => ({ result: { grant: true, level, ok: false, message: error, error, ticket: null } });
    const number = intArg(data.number, 1, MAX_CASE_NUMBER, null);
    if (!number) return no("That ticket number doesn't look right.");
    const action = typeof data.action === 'string' && TICKET_ACTIONS.has(data.action) ? data.action : null;
    if (!action) return no('Pick claim, unclaim or close.');
    const reason = textArg(data.reason, MAX_REASON);
    if (reason === null) return no(`Keep the reason under ${MAX_REASON} characters.`);
    const svc = ticketsService(sid);
    if (!svc) return no(TICKETS_OFF);
    const out = await ticketCall(svc, sid, number, uid, action, reason.trim());
    const ok = out?.ok === true;
    const message = String(out?.message || (ok ? 'Done.' : "That didn't work.")).slice(0, 1000);
    if (ok) state.dirty.add(sid);
    const error = ok ? {} : { error: String(out?.error || message).slice(0, 1000) };
    return { result: { grant: true, level, ok, message, ...error, ticket: plainObject(out?.ticket) ? out.ticket : null } };
  }

  async function runServers(uid) {
    const out = [];
    for (const s of await botServers()) {
      if (!s?.id) continue;
      const { level } = await levelOf(s.id, uid).catch(() => ({ level: null }));
      if (!GRANT_LEVELS.has(level)) continue;
      out.push({ id: s.id, name: s.name || 'Server', icon_url: avatarUrl(s.icon_path ?? s.icon ?? null), member_count: s.member_count ?? 0, level });
    }
    return { result: { servers: out } };
  }

  async function runAccess(sid, uid) {
    const { level } = await levelOf(sid, uid);
    const grant = GRANT_LEVELS.has(level);
    if (grant) {
      state.used.set(sid, now());
      await pushSnapshot(sid).catch((e) => log.debug('[dashboard] snapshot for access failed', e?.message));
    }
    return { result: { grant, level } };
  }

  const handlers = Object.assign(Object.create(null), {
    servers: (sid, uid) => runServers(uid),
    access: (sid, uid) => runAccess(sid, uid),
    change: (sid, uid, data) => runChange(sid, uid, data),
    member: guarded(runMember),
    members: guarded(runMembers),
    modaction: guarded(runModAction),
    tickets: guarded(runTickets),
    ticket: guarded(runTicket),
    ticketaction: guarded(runTicketAction),
  });
  const jobTypes = new Set(Object.keys(handlers));

  function jobData(raw) {
    if (raw === null || raw === undefined) return {};
    if (typeof raw === 'string') {
      if (raw.length > MAX_DATA_CHARS) return null;
      try { const v = JSON.parse(raw); return plainObject(v) ? v : null; } catch { return null; }
    }
    return plainObject(raw) && sizeOf(raw) <= MAX_DATA_CHARS ? raw : null;
  }

  async function runJob(job) {
    if (!plainObject(job)) return null;
    const id = typeof job.id === 'string' || typeof job.id === 'number' ? job.id : null;
    if (id === null || String(id).length > 100) return null;
    const fail = (error) => ({ id, ok: false, error });
    if (typeof job.type !== 'string' || !jobTypes.has(job.type)) return fail(UNKNOWN_JOB);
    const uid = safeId(job.user_id);
    if (!uid) return fail('That job has no user.');
    const data = jobData(job.data);
    if (!data) return fail('That job has bad data.');
    let sid = null;
    if (job.type !== 'servers') {
      sid = safeId(job.server_id);
      if (!sid || !SERVER_ID.test(sid)) return fail('That job has no server.');
    }
    try {
      const out = await handlers[job.type](sid, uid, data);
      return { id, ok: true, result: out.result, ...(out.error ? { error: out.error } : {}) };
    } catch (e) {
      if (e?.lookup) {
        log.debug(`[dashboard] role lookup for a ${job.type} job failed`, e.cause?.message);
        return fail(LOOKUP_FAILED);
      }
      log.warn(`[dashboard] ${job.type} job failed:`, e);
      return fail('YapOS ran into a problem. Try again in a minute.');
    }
  }

  function fitResult(r) {
    if (sizeOf(r) <= RESULT_MAX_BYTES) return r;
    if (plainObject(r.result) && r.result.snapshot) {
      const slim = { ...r, result: { ...r.result, snapshot: null } };
      if (sizeOf(slim) <= RESULT_MAX_BYTES) return slim;
    }
    return { id: r.id, ok: false, error: TOO_BIG };
  }

  function nextBatch() {
    const batch = [];
    let bytes = 16;
    for (const r of state.pending) {
      const n = sizeOf(r) + 1;
      if (batch.length && (batch.length >= RESULTS_PER_POST || bytes + n > RESULTS_BATCH_BYTES)) break;
      batch.push(r);
      bytes += n;
    }
    return batch;
  }

  const retryable = (status) => status >= 500 || status === 401 || status === 403 || status === 408 || status === 429 || !status;

  async function postResults(results) {
    state.pending.push(...results.filter(Boolean).map(fitResult));
    if (state.pending.length > MAX_PENDING_RESULTS) state.pending.splice(0, state.pending.length - MAX_PENDING_RESULTS);
    while (state.pending.length) {
      const batch = nextBatch();
      const r = await request('POST', '/bot/results', { results: batch });
      if (!r.ok && retryable(r.status)) throw Object.assign(new Error(`results answered ${r.status}`), { status: r.status });
      if (!r.ok) log.warn(`[dashboard] the dashboard refused ${batch.length} job result(s) (${r.status}); dropping them.`);
      state.pending.splice(0, batch.length);
    }
  }

  async function pushDirty() {
    for (const sid of [...state.dirty]) {
      state.dirty.delete(sid);
      await pushSnapshot(sid).catch((e) => log.debug('[dashboard] snapshot after a change failed', e?.message));
    }
  }

  async function refresh() {
    const t = now();
    let budget = REFRESH_PER_TICK;
    for (const [sid, at] of [...state.used]) {
      if (t - at > GRANT_FRESH_MS) { state.used.delete(sid); continue; }
      if (budget <= 0) break;
      if (t - (state.snapped.get(sid) ?? -Infinity) < SNAPSHOT_EVERY_MS) continue;
      budget--;
      await pushSnapshot(sid).catch((e) => log.debug('[dashboard] snapshot refresh failed', e?.message));
    }
    if (budget > 0 && t - state.boardAt >= PUBLIC_EVERY_MS) {
      budget--;
      const g = await publishGlobal().catch(() => ({ ok: false }));
      if (!g.ok) state.boardAt = t;
    }
    for (const sid of serverIds()) {
      if (budget <= 0) break;
      const page = engine.settings.core(sid).publicPage;
      if (!plainObject(page) || page.enabled !== true) { state.published.delete(sid); continue; }
      if (t - (state.published.get(sid) ?? -Infinity) < PUBLIC_EVERY_MS) continue;
      const ids = await botServerIds();
      if (ids && !ids.has(sid)) {
        if (!state.gone.has(sid)) {
          budget--;
          await serverGone(sid).catch((e) => log.debug('[dashboard] unpublishing a server I left failed', e?.message));
        }
        state.published.set(sid, t);
        continue;
      }
      state.gone.delete(sid);
      budget--;
      const r = await publishPublic(sid).catch(() => ({ ok: false }));
      if (!r.ok) state.published.set(sid, t);
    }
  }

  async function tick() {
    if (!enabled) return null;
    if (state.busy) return state.delay;
    state.busy = true;
    let delay;
    try {
      const r = await request('GET', '/bot/poll?wait=0');
      if (!r.ok) throw Object.assign(new Error(`poll answered ${r.status}`), { status: r.status });
      const jobs = Array.isArray(r.data?.jobs) ? r.data.jobs.slice(0, MAX_JOBS) : [];
      state.hot = r.data?.hot === true;
      const results = [];
      for (const job of jobs) results.push(await runJob(job));
      await postResults(results);
      await pushDirty();
      await refresh();
      if (state.failures) log.info('[dashboard] connected again');
      state.failures = 0;
      delay = state.hot ? HOT_MS : IDLE_MS;
    } catch (e) {
      state.failures++;
      delay = Math.min(MAX_BACKOFF_MS, FIRST_BACKOFF_MS * 2 ** (state.failures - 1));
      const why = e?.status === 401 || e?.status === 403 ? 'the dashboard refused the bot secret' : e?.name === 'TimeoutError' ? 'it took too long to answer' : String(e?.message || e);
      if (state.failures === 1) log.warn(`[dashboard] couldn't reach the dashboard (${why}). Retrying in ${Math.round(delay / 1000)}s.`);
      else log.debug(`[dashboard] still can't reach the dashboard (${why})`);
    } finally {
      state.busy = false;
    }
    state.delay = delay;
    return delay;
  }

  function schedule(ms) {
    if (state.stopped) return;
    const t = setT(loop, ms);
    t?.unref?.();
    state.timer = t;
  }

  async function loop() {
    state.timer = null;
    if (state.stopped) return;
    const d = await tick();
    schedule(d ?? IDLE_MS);
  }

  return {
    get enabled() { return enabled; },
    get delay() { return state.delay; },
    get hot() { return state.hot; },
    get running() { return !state.stopped; },
    get jobTypes() { return [...jobTypes]; },
    start() {
      if (!enabled) {
        log.info(reason ? `[dashboard] off: ${reason}.` : '[dashboard] off: set YAPOS_DASHBOARD_URL and YAPOS_DASHBOARD_SECRET to turn it on.');
        return false;
      }
      if (!state.stopped) return true;
      state.stopped = false;
      log.info(`[dashboard] connecting to ${base}`);
      schedule(START_DELAY_MS);
      return true;
    },
    stop() {
      state.stopped = true;
      if (state.timer) clearT(state.timer);
      state.timer = null;
    },
    tick,
    runJob,
    snapshot,
    publicPage,
    globalBoard,
    publishGlobal,
    publishPublic,
    unpublishPublic,
    serverGone,
    pushSnapshot,
  };
}
