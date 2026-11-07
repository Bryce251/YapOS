import { explain } from './errors.js';
import { dialog } from './ui.js';

const PREFIX = 'yo';
const SEP = ':';
const AUTO_ACK_MS = 2200;

export function customId(app, action, ...args) {
  const id = [PREFIX, app, action, ...args.map((a) => String(a ?? '').replace(/:/g, '_'))].join(SEP);
  if (id.length > 100) throw new Error(`custom_id too long (${id.length}): ${id.slice(0, 40)}…`);
  return id;
}

export function parseCustomId(id) {
  const parts = String(id ?? '').split(SEP);
  if (parts[0] !== PREFIX || parts.length < 3) return null;
  const [, app, action, ...args] = parts;
  return { app, action, args };
}

export function guardInteraction(i, { autoAckMs = AUTO_ACK_MS, log } = {}) {
  let answered = false;
  let autoAcked = false;
  const mark = (p) => {
    answered = true;
    return Promise.resolve(p).catch((e) => { if (!autoAcked) answered = false; throw e; });
  };
  const timer = setTimeout(() => {
    if (answered) return;
    autoAcked = true;
    answered = true;
    Promise.resolve(i.ack?.()).catch((e) => log?.debug('auto-ack failed', e?.message));
  }, autoAckMs);
  timer.unref?.();
  const g = Object.create(i);
  for (const name of ['reply', 'ephemeral', 'update', 'ack', 'showModal']) {
    if (typeof i[name] !== 'function') continue;
    g[name] = (...a) => mark(i[name](...a));
  }
  Object.defineProperty(g, 'answered', { get: () => answered });
  Object.defineProperty(g, 'autoAcked', { get: () => autoAcked });
  g.done = () => clearTimeout(timer);
  return g;
}

export function createRouter({ bot, engine, log }) {
  const handlers = new Map();
  const sessions = new Map();
  const undos = new Map();
  let seq = 0;
  const shortId = () => (Date.now().toString(36).slice(-4) + (seq++).toString(36)).slice(-6);

  function register(app, action, spec) {
    const entry = typeof spec === 'function' ? { run: spec } : spec;
    handlers.set(`${app}:${action}`, { ...entry, app });
  }
  function unregisterApp(app) {
    for (const k of [...handlers.keys()]) if (k.startsWith(`${app}:`)) handlers.delete(k);
  }

  function session(data, ttlMs = 15 * 60_000) {
    const id = shortId();
    sessions.set(id, { data, expires: Date.now() + ttlMs });
    return id;
  }
  function getSession(id) {
    const s = sessions.get(id);
    if (!s) return null;
    if (Date.now() > s.expires) { sessions.delete(id); return null; }
    return s.data;
  }
  function dropSession(id) { sessions.delete(id); }

  function addUndo({ serverId, actorId, label, run, ttlMs = 10 * 60_000, perm = 'mod' }) {
    const id = shortId();
    undos.set(id, { serverId, actorId, label, run, perm, expires: Date.now() + ttlMs });
    return { id, button: { type: 'button', style: 'secondary', label: `Undo${label ? `: ${label}` : ''}`.slice(0, 80), custom_id: customId('sys', 'undo', id), emoji: '↩️' } };
  }

  setInterval(() => {
    const t = Date.now();
    for (const [k, v] of sessions) if (t > v.expires) sessions.delete(k);
    for (const [k, v] of undos) if (t > v.expires) undos.delete(k);
  }, 60_000).unref?.();

  async function fail(i, err, ctx = {}) {
    const { title, body } = explain(err, ctx);
    if (!err?.friendly) log.error(`interaction ${i.custom_id} failed:`, err);
    const card = dialog.error(title, body);
    try {
      await i.ephemeral('', { embeds: [card] });
    } catch (e) {
      log.debug('could not show error dialog', e?.message);
    }
  }

  async function dispatch(raw) {
    const parsed = parseCustomId(raw.custom_id);
    if (!parsed) return;
    const i = guardInteraction(raw, { log });
    try {
      if (parsed.app === 'sys' && parsed.action === 'undo') return await runUndo(i, parsed.args[0]);
      const h = handlers.get(`${parsed.app}:${parsed.action}`);
      if (!h) {
        await i.ephemeral('', { embeds: [dialog.warn('This button is from an older panel', 'Open the panel again to get fresh buttons.')] });
        return;
      }
      const sid = raw.server_id;
      if (sid && h.app !== 'sys' && !engine.settings.isEnabled(sid, h.app)) {
        const meta = engine.apps.get(h.app)?.meta;
        await i.ephemeral('', { embeds: [dialog.warn(`${meta?.name || h.app} isn't installed here`, 'An admin can install it with **/apps**.')] });
        return;
      }
      if (h.perm && sid) await engine.perms.require(sid, raw.user_id, h.perm);
      if (h.owner && raw.user_id !== parsed.args[h.ownerArg ?? 0]) {
        await i.ephemeral('', { embeds: [dialog.warn('Not your panel', 'Open your own with the same command.')] });
        return;
      }
      await h.run(engine.contextFor(i, { app: h.app, kind: raw.type || 'button', args: parsed.args, values: raw.values }));
    } catch (e) {
      await fail(i, e);
    } finally {
      i.done();
    }
  }

  async function runUndo(i, id) {
    const u = undos.get(id);
    if (!u) return i.ephemeral('', { embeds: [dialog.warn('Too late to undo', 'Undo buttons work for 10 minutes. Do it by hand instead.')] });
    if (u.serverId) await engine.perms.require(u.serverId, i.user_id, u.perm);
    undos.delete(id);
    await u.run(i);
    if (!i.answered) await i.ephemeral('', { embeds: [dialog.ok('Undone', u.label ? `Reverted: ${u.label}` : 'Reverted.')] });
  }

  function attach() {
    bot.onButton(/^yo:/, dispatch);
    bot.onSelect(/^yo:/, dispatch);
    bot.onModal(/^yo:/, dispatch);
  }

  return { register, unregisterApp, customId, parseCustomId, session, getSession, dropSession, addUndo, dispatch, attach, handlers };
}
