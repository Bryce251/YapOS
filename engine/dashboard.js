import { VERSION, hideSecret } from './config.js';
import { parseBool } from './parse.js';
import { avatarUrl } from './links.js';

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
const RECENT = 10;
const MEMBER_CASES = 50;
const APP_RE = /^[a-z0-9_-]{1,32}$/;
const SAFE_ID = /^[\w-]{1,64}$/;
const JOB_TYPES = new Set(['servers', 'access', 'change', 'member']);
const GRANT_LEVELS = new Set(['admin', 'owner']);
const NOT_ADMIN = 'You need to be an admin of this server.';
const LOOKUP_FAILED = "YapOS couldn't check your role just now. Try again in a minute.";
const TOO_BIG = 'YapOS sent an answer that was too big.';
const SERVER_ID = /^[0-9a-f-]{36}$/i;
const RESULT_MAX_BYTES = 500 * 1024;
const RESULTS_BATCH_BYTES = 1_500_000;
const RESULTS_PER_POST = 100;
const BOT_SERVERS_MS = 5 * 60_000;

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

export function publicSchema(field, defaults = {}) {
  const out = { key: field.key, label: field.label || field.key, help: field.help || '', type: field.type || 'string' };
  const def = field.default !== undefined ? field.default : field.key.startsWith('core.') ? null : readPath(defaults, field.key);
  out.default = def === undefined ? null : structuredClone(def);
  for (const k of ['min', 'max', 'step', 'maxLength']) if (typeof field[k] === 'number') out[k] = field[k];
  if (Array.isArray(field.options)) out.options = field.options.map((o) => (typeof o === 'object' ? { value: o.value, label: String(o.label ?? o.value) } : { value: o, label: String(o) }));
  out.web = field.web === true;
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
    gone: new Set(), botIds: null, botIdsAt: -Infinity,
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
        openTickets: Object.values(tickets?.tickets || {}).filter((t) => t?.status === 'open').length,
        starboardPosts: Object.keys(stars || {}).length,
      },
    };
    const online = counts?.online_count ?? server?.online_count;
    if (typeof online === 'number') out.online_count = online;
    return out;
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
        try { values[f.key] = structuredClone(fieldValue(f, cfg, core) ?? null); } catch { values[f.key] = null; }
      }
      out[meta.id] = { values, schema: fields.map((f) => publicSchema(f, meta.defaults)) };
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

  async function plainWrapped(sid, wrapped, members) {
    if (!plainObject(wrapped) || !plainObject(wrapped.card)) return wrapped;
    const channels = await engine.cache.channels(sid).catch(() => []);
    const rooms = new Map(channels.map((c) => [c.id, c]));
    const clean = (text) => String(text ?? '')
      .replace(/\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/<@!?([\w-]+)>/g, (m, id) => (members.has(id) ? memberName(members.get(id)) : 'Former member'))
      .replace(/<#([\w-]+)>/g, (m, id) => (rooms.has(id) ? `#${String(rooms.get(id).name ?? 'channel').slice(0, 64)}` : '#channel'))
      .replace(/<@&[\w-]+>/g, '')
      .replace(/[ \t]*·[ \t]*$/gm, '')
      .trim();
    const { card } = wrapped;
    const out = { ...card };
    for (const k of ['title', 'description']) if (typeof card[k] === 'string') out[k] = clean(card[k]);
    if (plainObject(card.footer) && typeof card.footer.text === 'string') out.footer = { ...card.footer, text: clean(card.footer.text) };
    if (Array.isArray(card.fields)) {
      out.fields = card.fields.filter(plainObject).map((f) => ({ ...f, name: clean(f.name), value: clean(f.value) })).filter((f) => f.name && f.value);
    }
    return { ...wrapped, card: out };
  }

  async function publicPage(sid) {
    const { settings } = engine;
    const core = settings.core(sid);
    const page = plainObject(core.publicPage) ? core.publicPage : {};
    const server = await engine.perms.server(sid).catch(() => null);
    const members = await namesFor(sid);
    const who = (id) => {
      const m = members.get(id);
      return { name: m ? memberName(m) : 'Former member', avatar_url: avatarUrl(m?.avatar_path ?? null) };
    };
    const levelsSvc = settings.isEnabled(sid, 'levels') ? engine.service('levels') : null;
    const econSvc = settings.isEnabled(sid, 'economy') ? engine.service('economy') : null;
    const wrappedSvc = settings.isEnabled(sid, 'wrapped') ? engine.service('wrapped') : null;
    const levels = (levelsSvc?.ranked?.(sid) || []).slice(0, TOP).map((u, i) => ({ rank: i + 1, id: u.id, ...who(u.id), level: u.level, xp: u.xp, messages: u.messages || 0 }));
    const economy = (econSvc?.ranked?.(sid) || []).slice(0, TOP).map((u, i) => ({ rank: i + 1, id: u.id, ...who(u.id), balance: u.bal }));
    let wrapped = null;
    try { wrapped = wrappedSvc?.lastMonth ? await plainWrapped(sid, await wrappedSvc.lastMonth(sid, server?.name || 'this server'), members) : null; } catch (e) { log.debug('[dashboard] wrapped for the public page failed', e?.message); }
    return {
      enabled: page.enabled === true,
      slug: typeof page.slug === 'string' ? page.slug : null,
      name: server?.name || 'Server',
      icon: avatarUrl(server?.icon_path ?? server?.icon ?? null),
      levels,
      economy,
      wrapped,
      updatedAt: now(),
    };
  }

  async function publishPublic(sid) {
    if (!enabled) return { ok: false, status: 0 };
    const body = await publicPage(sid);
    const r = await request('PUT', `/bot/public/${encodeURIComponent(sid)}`, body);
    if (r.ok) state.published.set(sid, now());
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
            if (!engine.settings.isEnabled(sid, meta.id)) { errors[k] = `${meta.name} isn't installed here. Install it first.`; continue; }
            if (tooBig(value)) { errors[k] = 'That value is too long.'; continue; }
            try {
              const checked = await field.validate(ctx, value, data.settings);
              if (!checked || checked.error) { errors[k] = checked?.error || "That value didn't work."; continue; }
              const saved = await saveField(ctx, field, checked.value, data.settings);
              if (saved?.error) { errors[k] = saved.error; continue; }
              if (saved?.applied) Object.assign(applied, saved.applied);
              else applied[k] = checked.value;
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

  async function runMember(sid, uid, data) {
    const { level } = await levelOf(sid, uid);
    if (!GRANT_LEVELS.has(level)) return { result: { grant: false, level, error: NOT_ADMIN }, error: NOT_ADMIN };
    const target = safeId(data.user_id);
    if (!target) return { result: { grant: true, level, member: null, error: "That member id doesn't look right." } };
    state.used.set(sid, now());
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
    return {
      result: {
        grant: true,
        level,
        member: {
          id: target,
          name: m ? memberName(m) : 'Not in the server',
          avatar_url: avatarUrl(m?.avatar_path ?? null),
          warnings,
          cases,
          levels: lv ? { level: lv.level, xp: lv.xp, messages: lv.messages || 0, voiceSeconds: lv.voiceSeconds || 0 } : null,
          economy: bal === null ? null : { balance: bal },
        },
      },
    };
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
    if (!JOB_TYPES.has(job.type)) return fail("I don't know that job.");
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
      let out;
      if (job.type === 'servers') out = await runServers(uid);
      else if (job.type === 'access') out = await runAccess(sid, uid);
      else if (job.type === 'change') out = await runChange(sid, uid, data);
      else out = await runMember(sid, uid, data);
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
    for (const sid of engine.settings.servers()) {
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
    publishPublic,
    unpublishPublic,
    serverGone,
    pushSnapshot,
  };
}
