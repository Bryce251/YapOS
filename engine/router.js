import { randomBytes } from 'node:crypto';
import { explain } from './errors.js';
import { dialog, COLORS } from './ui.js';

const PREFIX = 'yo';
const SEP = ':';
const AUTO_ACK_MS = 2200;
const UNDO_TTL_MS = 10 * 60_000;
const MAX_USED_UNDOS = 2000;
const UNDO_FAILURE_COLORS = new Set([COLORS.error, COLORS.warn]);

export const newBootMarker = () => randomBytes(4).readUInt32BE(0).toString(36).padStart(5, '0').slice(-5);

const minutesText = (ms) => {
  const m = Math.max(1, Math.round(ms / 60_000));
  return `${m} minute${m === 1 ? '' : 's'}`;
};

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

export function markUndoneIn(components, targetId, label) {
  let hit = false;
  const walk = (c) => {
    if (!c || typeof c !== 'object') return c;
    if (c.custom_id === targetId && (c.type === 'button' || c.type === 2)) {
      hit = true;
      const isV2 = c.type === 2;
      return { ...c, label: String(label).slice(0, 80), disabled: true, style: isV2 ? 2 : 'secondary', emoji: isV2 ? { name: '↩️' } : '↩️' };
    }
    const out = { ...c };
    if (Array.isArray(c.components)) out.components = c.components.map(walk);
    if (c.accessory) out.accessory = walk(c.accessory);
    return out;
  };
  const next = (components || []).map(walk);
  return hit ? next : null;
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

export function createRouter({ bot, engine, log, bootMarker = newBootMarker() }) {
  const handlers = new Map();
  const sessions = new Map();
  const undos = new Map();
  const usedUndos = new Map();
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

  function addUndo({ serverId, actorId, label, run, ttlMs = UNDO_TTL_MS, perm = 'mod', manual }) {
    const id = shortId();
    const hint = manual ? String(manual).trim() : '';
    undos.set(id, { serverId, actorId, label, run, perm, manual: hint, ttlMs, expires: Date.now() + ttlMs });
    const plain = customId('sys', 'undo', id, bootMarker);
    const withHint = hint ? `${plain}${SEP}${hint.replace(/:/g, '_')}` : plain;
    const custom_id = Buffer.byteLength(withHint, 'utf8') <= 100 ? withHint : plain;
    return { id, button: { type: 'button', style: 'secondary', label: `Undo${label ? `: ${label}` : ''}`.slice(0, 80), custom_id, emoji: '↩️' } };
  }

  const panelOwners = new Map();
  const MAX_PANEL_LOCKS = 5000;
  function claimPanel(messageId, userId, ttlMs, serverId = null) {
    if (!messageId || !userId) return;
    if (panelOwners.size >= MAX_PANEL_LOCKS) panelOwners.delete(panelOwners.keys().next().value);
    panelOwners.set(messageId, { userId, serverId, expires: Date.now() + ttlMs });
  }
  function releasePanel(messageId) { panelOwners.delete(messageId); }
  function panelOwner(messageId) {
    const p = messageId && panelOwners.get(messageId);
    if (!p) return null;
    if (Date.now() > p.expires) { panelOwners.delete(messageId); return null; }
    return p.userId;
  }

  setInterval(() => {
    const t = Date.now();
    for (const [k, v] of panelOwners) if (t > v.expires) panelOwners.delete(k);
    for (const [k, v] of sessions) if (t > v.expires) sessions.delete(k);
    for (const [k, v] of undos) if (t > v.expires && !v.busy) undos.delete(k);
  }, 60_000).unref?.();

  async function fail(i, err, ctx = {}) {
    const { title, body, embed } = explain(err, ctx);
    if (!err?.friendly) log.error(`interaction ${i.custom_id} failed:`, err);
    const card = embed || dialog.error(title, body);
    try {
      await i.ephemeral('', { embeds: [card] });
    } catch (e) {
      log.debug('could not show error dialog', e?.message);
    }
  }

  function notYourPanel(ownerId) {
    const who = ownerId ? `<@${ownerId}>` : 'Someone else';
    return dialog.denied(null, { title: 'Not your panel', body: `${who} opened this one. Run the command yourself to get your own.` });
  }

  async function dispatch(raw) {
    const parsed = parseCustomId(raw.custom_id);
    if (!parsed) return;
    const i = guardInteraction(raw, { log });
    try {
      const owner = panelOwner(raw.message_id);
      const panelServer = panelOwners.get(raw.message_id)?.serverId || raw.server_id;
      if (owner && owner !== raw.user_id && owner !== engine.bot.me?.id && !(await engine.perms.isOwner(panelServer, raw.user_id))) {
        await i.ephemeral('', { embeds: [notYourPanel(owner)] });
        return;
      }
      if (parsed.app === 'sys' && parsed.action === 'undo') return await runUndo(i, parsed.args);
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
        await i.ephemeral('', { embeds: [notYourPanel(parsed.args[h.ownerArg ?? 0])] });
        return;
      }
      await h.run(engine.contextFor(i, { app: h.app, kind: raw.type || 'button', args: parsed.args, values: raw.values }));
    } catch (e) {
      await fail(i, e);
    } finally {
      i.done();
    }
  }

  function rememberUsed(id, name) {
    if (usedUndos.size >= MAX_USED_UNDOS) usedUndos.delete(usedUndos.keys().next().value);
    usedUndos.set(id, { by: name, at: Date.now() });
  }

  async function nameOf(serverId, userId, fallback) {
    if (serverId && userId && engine.perms?.member) {
      const m = await engine.perms.member(serverId, userId).catch(() => null);
      const name = m?.nickname || m?.display_name || m?.username;
      if (name) return name;
    }
    return fallback || 'someone';
  }

  function tooLate(body, manual) {
    const extra = manual ? `\n-# Do it by hand instead: ${manual}` : '\n-# Do it by hand instead.';
    return dialog.warn('Too late to undo', `${body}${extra}`);
  }

  function watchAnswers(i) {
    const seen = { failed: false };
    const w = Object.create(i);
    const look = (opts) => {
      for (const e of [].concat(opts?.embeds || [])) if (e && UNDO_FAILURE_COLORS.has(e.color)) seen.failed = true;
    };
    for (const name of ['reply', 'ephemeral']) {
      if (typeof i[name] !== 'function') continue;
      w[name] = (content, opts) => { look(opts); return i[name](content, opts); };
    }
    if (typeof i.update === 'function') w.update = (changes) => { look(changes); return i.update(changes); };
    return { i: w, seen };
  }

  async function showUndone(i, name, label) {
    const text = `Undone by ${name}`;
    if (i.message_id && i.channel_id) {
      try {
        const msg = await bot.message(i.channel_id, i.message_id);
        const next = markUndoneIn(msg?.components, i.custom_id, text);
        if (next) {
          const isV2 = (Number(msg.flags) & 32768) !== 0;
          if (!i.answered) await (isV2 ? i.update({ layout: next }) : i.update({ components: next }));
          else if (isV2) await bot.editLayout(i.channel_id, i.message_id, next);
          else await bot.edit(i.channel_id, i.message_id, undefined, { components: next });
          return;
        }
      } catch (e) {
        log.debug('could not mark the undo button as used', e?.message);
      }
    }
    if (!i.answered) await i.ephemeral('', { embeds: [dialog.ok('Undone', label ? `Reverted: ${label}` : 'Reverted.')] });
  }

  async function runUndo(i, [id, marker, ...hintParts]) {
    const shownHint = hintParts.join(SEP);
    const thisBoot = !!marker && marker === bootMarker;
    const used = thisBoot && usedUndos.get(id);
    if (used) return i.ephemeral('', { embeds: [dialog.info(`Already undone by ${used.by}`, 'There is nothing left to undo here.')] });
    const u = thisBoot ? undos.get(id) : null;
    if (!u) {
      const body = thisBoot ? `Undo works for ${minutesText(UNDO_TTL_MS)}.` : "I restarted since then, so this can't be undone any more.";
      return i.ephemeral('', { embeds: [tooLate(body, shownHint)] });
    }
    if (Date.now() > u.expires) {
      if (!u.busy) undos.delete(id);
      return i.ephemeral('', { embeds: [tooLate(`Undo works for ${minutesText(u.ttlMs)}.`, u.manual || shownHint)] });
    }
    if (u.busy) return i.ephemeral('', { embeds: [dialog.info('Already undoing', 'Someone just pressed this. Give it a second.')] });
    if (u.serverId) await engine.perms.require(u.serverId, i.user_id, u.perm);
    u.busy = true;
    const watched = watchAnswers(i);
    let result;
    try {
      result = await u.run(watched.i);
    } finally {
      u.busy = false;
    }
    if (result === false || watched.seen.failed) return;
    undos.delete(id);
    const name = await nameOf(u.serverId || i.server_id, i.user_id, i.username);
    rememberUsed(id, name);
    await showUndone(i, name, u.label);
  }

  function attach() {
    bot.onButton(/^yo:/, dispatch);
    bot.onSelect(/^yo:/, dispatch);
    bot.onModal(/^yo:/, dispatch);
  }

  return { claimPanel, releasePanel, panelOwner, register, unregisterApp, customId, parseCustomId, session, getSession, dropSession, addUndo, dispatch, attach, handlers, bootMarker };
}
