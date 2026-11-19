import { tokenize, authorName, resolveUser, resolveRole, resolveChannel, didYouMean } from './parse.js';
import { explain, friendly, looksLikeFeatureOff } from './errors.js';
import { dialog, v2ToEmbed, row, button } from './ui.js';

export const EPHEMERAL_BUTTON_MS = 15 * 60_000;
const EPHEMERAL_FALLBACK_MS = 20_000;

const asPlain = (x) => (x && typeof x.toJSON === 'function' ? x.toJSON() : x);
const isButton = (c) => !!c && (c.type === 'button' || c.type === 2);
const isRow = (c) => !!c && (c.type === 'row' || c.type === 1);

export function buttonsOnly(components) {
  if (!Array.isArray(components) || !components.length || components.length > 5) return false;
  return components.every((r) => {
    const j = asPlain(r);
    return isRow(j) && Array.isArray(j.components) && j.components.length > 0 && j.components.length <= 5 && j.components.every((b) => isButton(asPlain(b)));
  });
}

export function ephemeralRefused(e) {
  const s = e?.status;
  if (s === 400) return true;
  return (s === 403 || s === 404 || s === 422) && (looksLikeFeatureOff(e) || /ephemeral|button|component/i.test(String(e?.message || '')));
}

const badComponent = (e) => /custom_id|duplicate|too long|characters|label/i.test(String(e?.message || ''));
const replyExpired = (e) => e?.status === 404 || e?.status === 410 || (e?.status === 400 && /expir|too old|no longer|15 min/i.test(String(e?.message || '')));
const replyIdOf = (out) => out?.reply_id ?? out?.reply?.id ?? out?.ephemeral?.id ?? null;

export function createEphemeralTracker({ now = () => Date.now(), max = 2000 } = {}) {
  const seen = new Map();
  const owners = new Map();
  const tracker = {
    now,
    touch(id, at, owner) {
      if (!id) return;
      seen.delete(id);
      seen.set(id, at ?? tracker.now());
      if (owner) owners.set(id, String(owner));
      while (seen.size > max) {
        const old = seen.keys().next().value;
        seen.delete(old);
        owners.delete(old);
      }
    },
    lastWrite: (id) => seen.get(id) ?? null,
    ownerOf: (id) => (id ? owners.get(id) ?? null : null),
    expired(id) {
      const at = id ? seen.get(id) : undefined;
      return at !== undefined && tracker.now() - at > EPHEMERAL_BUTTON_MS;
    },
    get size() { return seen.size; },
  };
  return tracker;
}

const expiredDialog = () => dialog.warn('This menu expired', 'Run the command again to get a fresh one.');
const PANEL_TTL_MS = 10 * 60_000;
const LOCK_GRACE_MS = 10 * 60_000;
const KEPT_PANEL_LOCK_MS = 24 * 3600_000;

function normalize(payload, opts = {}) {
  if (payload == null) return { content: '', ...opts };
  if (typeof payload === 'string') return { content: payload, ...opts };
  return { content: payload.content ?? '', ...payload, ...opts };
}

export function createContext(engine, source, { app = null, kind, args, values } = {}) {
  const { bot, budget, perms, settings, caps, log } = engine;
  const isInteraction = typeof source.update === 'function' && typeof source.ack === 'function' && 'custom_id' in source;
  const isCommandEvent = !!source.interaction;
  const type = kind || (isInteraction ? source.type || 'button' : source.dm ? 'dm' : source.command ? (isCommandEvent ? 'command' : 'message') : 'event');
  const serverId = source.server_id ?? null;
  const channelId = source.channel_id ?? null;
  const userId = source.user_id ?? source.author_id ?? null;
  const argText = typeof args === 'string' ? args : typeof source.args === 'string' ? source.args : '';
  const replyId = isInteraction ? source.reply_id ?? null : null;
  const tracker = engine.ephemeralReplies || null;
  if (replyId && tracker?.expired(replyId)) throw friendly('Run the command again to get a fresh one.', { title: 'This menu expired' });

  let answered = false;
  const claim = (sent, p) => {
    if (!sent?.id || p.open || !serverId || !userId || userId === bot.me?.id) return;
    engine.router.claimPanel(sent.id, userId, p.keep ? KEPT_PANEL_LOCK_MS : (p.ttl ?? PANEL_TTL_MS) + LOCK_GRACE_MS, serverId);
  };
  const cleanUp = (sent, ttl, keep) => {
    if (!sent?.id || keep || !channelId) return;
    const t = setTimeout(() => bot.delete(channelId, sent.id).catch(() => {}), ttl);
    t.unref?.();
  };

  const ctx = {
    engine, bot, app, kind: type, source, serverId, channelId, userId, replyId,
    onEphemeral: !!replyId,
    canUpdate: isInteraction && !!(source.message_id || replyId),
    username: source.username ?? authorName(source),
    args: argText,
    argv: Array.isArray(args) ? args : tokenize(argText),
    values: values ?? source.values ?? null,
    get answered() { return answered || !!source.answered; },

    config: () => settings.appConfig(serverId, app),
    patchConfig: (patch) => settings.patchApp(serverId, app, patch),
    core: () => settings.core(serverId),
    level: () => perms.level(serverId, userId),
    require: (need) => perms.require(serverId, userId, need),
    cap: (name) => caps.state(serverId, name),
    store: {
      get: (key, fallback) => engine.store.get(app, key, fallback),
      set: (key, value) => engine.store.set(app, key, value),
      update: (key, fn, fallback) => engine.store.update(app, key, fn, fallback),
      delete: (key) => engine.store.delete(app, key),
      server: (fallback = {}) => engine.store.get(app, serverId, fallback),
      updateServer: (fn, fallback = {}) => engine.store.update(app, serverId, fn, fallback),
    },

    async members() { return engine.cache.members(serverId); },
    async roles() { return perms.roles(serverId); },
    async channels(kindFilter) { const all = await engine.cache.channels(serverId); return kindFilter ? all.filter((c) => c.type === kindFilter) : all; },
    async findUser(token) { return resolveUser(token, await ctx.members()); },
    async findRole(token) { return resolveRole(token, await ctx.roles()); },
    async findChannel(token, kindFilter = 'text') {
      const raw = String(token ?? '').replace(/[​-‍﻿]/g, '').trim();
      const idMatch = /<#([\w-]+)>/.exec(raw) || /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i.exec(raw);
      const query = idMatch ? `<#${idMatch[1]}>` : raw.replace(/^#+\s*/, '').replace(/[.,!?;:]+$/, '');
      if (!query) return null;
      const hit = resolveChannel(query, await ctx.channels(kindFilter));
      if (hit) return hit;
      engine.cache.invalidate(serverId);
      return resolveChannel(query, await ctx.channels(kindFilter));
    },

    async channelMissing(token, example, kindFilter = 'text') {
      const raw = String(token ?? '').replace(/[​-‍﻿]/g, '').trim();
      const mention = /<#([\w-]+)>/.exec(raw) || /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i.exec(raw);
      const name = raw.replace(/^#+\s*/, '').replace(/[.,!?;:]+$/, '').slice(0, 40).replace(/[`*_~|\\<>@]/g, '');
      const tip = 'If it is private, open its settings, go to Permissions and let the **YapOS** role in with View Channel and Send Messages, then try again.';
      const how = example ? `\n-# Or mention it, like \`${example}\`.` : '';
      if (mention) return `I can't see that channel. ${tip}${how}`;
      if (!name) return `Tell me which channel.${how}`;
      const all = await ctx.channels(kindFilter).catch(() => []);
      const names = all.map((c) => c.name).filter(Boolean);
      const q = name.toLowerCase();
      const part = q.length >= 3 ? names.filter((n) => { const l = n.toLowerCase(); return l.length >= 3 && (l.includes(q) || q.includes(l)); }) : [];
      const close = [...new Set([...part, ...didYouMean(name, names, { limit: 3 })])].slice(0, 3);
      const guess = close.length ? `\nDid you mean ${close.map((n) => `**#${n}**`).join(', ')}?` : '';
      return `I can't see a channel called **#${name}**. ${tip}${guess}${how}`;
    },

    async reply(payload, opts) {
      const p = normalize(payload, opts);
      answered = true;
      const clickable = (Array.isArray(p.components) && p.components.length > 0) || !!p.layout;
      if (isInteraction) {
        const out = await (p.layout ? source.reply('', { layout: p.layout }) : source.reply(p.content, p));
        if (clickable) claim(out?.message, { ...p, keep: true });
        return out;
      }
      if (isCommandEvent) {
        const sent = await source.reply(p.content, p);
        if (clickable) claim(sent, { ...p, keep: true });
        return sent;
      }
      if (!channelId) return null;
      const sent = await budget.send({ serverId, channelId, content: p.content, layout: p.layout, opts: { embeds: p.embeds, components: p.components, files: p.files, replyTo: source.dm ? undefined : source.id }, priority: 'high' });
      if (clickable) claim(sent, { ...p, keep: true });
      return sent;
    },

    async ephemeral(payload, opts) {
      const p = normalize(payload, opts);
      if (p.layout) Object.assign(p, v2ToEmbed(p.layout), { layout: undefined });
      answered = true;
      const hasButtons = Array.isArray(p.components) && p.components.length > 0;
      if (source.dm) return source.reply(p.content, { embeds: p.embeds, components: p.components });
      if (hasButtons && (isInteraction || isCommandEvent) && buttonsOnly(p.components) && caps.state(serverId, 'ephemeral_buttons') !== false) {
        try {
          const out = await source.ephemeral(p.content, { embeds: p.embeds, components: p.components });
          if (caps.state(serverId, 'ephemeral_buttons') !== true) caps.mark(serverId, 'ephemeral_buttons', true);
          tracker?.touch(replyIdOf(out), undefined, userId);
          return out;
        } catch (e) {
          if (!ephemeralRefused(e) || !channelId) throw e;
          if (!badComponent(e)) caps.mark(serverId, 'ephemeral_buttons', false, e?.message);
          return ctx.panel(p);
        }
      }
      if (hasButtons && channelId) return ctx.panel(p);
      if (isInteraction || isCommandEvent) return source.ephemeral(p.content, { embeds: p.embeds });
      if (!channelId) return null;
      const sent = await budget.send({ serverId, channelId, content: p.content, opts: { embeds: p.embeds, replyTo: source.id }, priority: 'high' });
      cleanUp(sent, p.ttl ?? EPHEMERAL_FALLBACK_MS, p.keep);
      return sent;
    },

    async panel(payload, opts) {
      const p = normalize(payload, opts);
      answered = true;
      const ttl = p.ttl ?? PANEL_TTL_MS;
      let sent;
      if (isInteraction) {
        const out = await source.reply(p.content, { embeds: p.embeds, components: p.components });
        sent = out?.message ?? null;
      } else if (isCommandEvent) {
        sent = await source.reply(p.content, { embeds: p.embeds, components: p.components });
      } else {
        sent = await budget.send({ serverId, channelId, content: p.content, opts: { embeds: p.embeds, components: p.components, replyTo: source.id }, priority: 'high' });
      }
      claim(sent, { ...p, ttl });
      cleanUp(sent, ttl, p.keep);
      return sent;
    },

    async update(payload, opts) {
      const p = normalize(payload, opts);
      answered = true;
      if (isInteraction) {
        const whole = !!p.layout || (p.embeds !== undefined && p.components !== undefined);
        if (whole && source.message_id) budget.cancelEdit?.(source.message_id);
        if (replyId) return updateEphemeral(p);
        if (p.layout) return source.update({ layout: p.layout });
        const changes = {};
        for (const k of ['content', 'embeds', 'components']) if (p[k] !== undefined) changes[k] = p[k];
        return source.update(changes);
      }
      return ctx.reply(p);
    },

    async ack() { answered = true; if (isInteraction || isCommandEvent) return source.ack(); return null; },

    async send(targetChannelId, payload, { priority = 'normal', key } = {}) {
      const p = normalize(payload);
      return budget.send({ serverId, channelId: targetChannelId, content: p.content, layout: p.layout, opts: { embeds: p.embeds, components: p.components, files: p.files }, priority, key });
    },

    ok: (title, body, extra) => ctx.ephemeral({ embeds: [dialog.ok(title, body)], ...extra }),
    info: (title, body, extra) => ctx.ephemeral({ embeds: [dialog.info(title, body)], ...extra }),
    warn: (title, body, extra) => ctx.ephemeral({ embeds: [dialog.warn(title, body)], ...extra }),
    error: (title, body, extra) => ctx.ephemeral({ embeds: [dialog.error(title, body)], ...extra }),

    async fail(err, explainCtx = {}) {
      const { title, body, embed } = explain(err, explainCtx);
      if (!err?.friendly) log.error(`[${app || 'core'}] ${type} failed:`, err);
      try { await ctx.ephemeral({ embeds: [embed || dialog.error(title, body)] }); } catch (e) { log.debug('could not show error dialog', e?.message); }
    },

    async form({ id, title, fields, action, args: formArgs = [] }) {
      const extra = [].concat(formArgs ?? []).map((a) => String(a ?? ''));
      const modal = {
        custom_id: engine.router.customId(app, action, ...extra),
        title: String(title).slice(0, 45),
        components: fields.slice(0, 5).map((f) => ({
          type: 'text_input', custom_id: f.id, label: String(f.label).slice(0, 45), style: f.style || 'short',
          required: f.required !== false, ...(f.placeholder ? { placeholder: f.placeholder } : {}),
          ...(f.value !== undefined && f.value !== null && f.value !== '' ? { value: String(f.value) } : {}),
          ...(f.max ? { max_length: f.max } : {}), ...(f.min ? { min_length: f.min } : {}),
        })),
      };
      const canModal = (isInteraction && source.type !== 'modal_submit') || isCommandEvent;
      if (canModal && caps.state(serverId, 'modals') !== false) {
        try {
          answered = true;
          await source.showModal(modal);
          caps.mark(serverId, 'modals', true);
          return 'modal';
        } catch (e) {
          answered = false;
          caps.mark(serverId, 'modals', false, e?.message);
        }
      }
      if (!isInteraction && !isCommandEvent && caps.state(serverId, 'modals') !== false) {
        const sid = engine.router.session({ modal, app, action, fields, userId, args: extra });
        await ctx.reply({ embeds: [dialog.info(title, 'Press the button to fill in the form.')], components: [row(button('Open form', engine.router.customId('sys', 'form', sid), 'primary', '📝'))] });
        return 'button';
      }
      return engine.chatForm(ctx, { title, fields, action, args: extra });
    },
  };

  async function updateEphemeral(payload) {
    const p = { ...payload };
    if (p.layout) Object.assign(p, v2ToEmbed(p.layout), { layout: undefined });
    if (Array.isArray(p.components) && p.components.length && !buttonsOnly(p.components)) return ctx.panel(p);
    const changes = {};
    for (const k of ['content', 'embeds', 'components']) if (p[k] !== undefined) changes[k] = p[k];
    try {
      const out = await source.update(changes);
      tracker?.touch(replyId);
      return out;
    } catch (e) {
      if (!replyExpired(e)) throw e;
      return source.ephemeral('', { embeds: [expiredDialog()] });
    }
  }

  return ctx;
}
