import { tokenize, authorName, resolveUser, resolveRole, resolveChannel } from './parse.js';
import { explain } from './errors.js';
import { dialog, v2ToEmbed, row, button } from './ui.js';

const EPHEMERAL_FALLBACK_MS = 20_000;
const PANEL_TTL_MS = 10 * 60_000;

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

  let answered = false;
  const cleanUp = (sent, ttl, keep) => {
    if (!sent?.id || keep || !channelId) return;
    const t = setTimeout(() => bot.delete(channelId, sent.id).catch(() => {}), ttl);
    t.unref?.();
  };

  const ctx = {
    engine, bot, app, kind: type, source, serverId, channelId, userId,
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
    async findChannel(token, kindFilter = 'text') { return resolveChannel(token, await ctx.channels(kindFilter)); },

    async reply(payload, opts) {
      const p = normalize(payload, opts);
      answered = true;
      if (isInteraction) return p.layout ? source.reply('', { layout: p.layout }) : source.reply(p.content, p);
      if (isCommandEvent) return source.reply(p.content, p);
      if (!channelId) return null;
      return budget.send({ serverId, channelId, content: p.content, layout: p.layout, opts: { embeds: p.embeds, components: p.components, files: p.files, replyTo: source.dm ? undefined : source.id }, priority: 'high' });
    },

    async ephemeral(payload, opts) {
      const p = normalize(payload, opts);
      if (p.layout) Object.assign(p, v2ToEmbed(p.layout), { layout: undefined });
      answered = true;
      const hasButtons = Array.isArray(p.components) && p.components.length > 0;
      if (source.dm) return source.reply(p.content, { embeds: p.embeds, components: p.components });
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
      cleanUp(sent, ttl, p.keep);
      return sent;
    },

    async update(payload, opts) {
      const p = normalize(payload, opts);
      answered = true;
      if (isInteraction) {
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
      const { title, body } = explain(err, explainCtx);
      if (!err?.friendly) log.error(`[${app || 'core'}] ${type} failed:`, err);
      try { await ctx.error(title, body); } catch (e) { log.debug('could not show error dialog', e?.message); }
    },

    async form({ id, title, fields, action }) {
      const modal = {
        custom_id: engine.router.customId(app, action),
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
        const sid = engine.router.session({ modal, app, action, fields, userId });
        await ctx.reply({ embeds: [dialog.info(title, 'Press the button to fill in the form.')], components: [row(button('Open form', engine.router.customId('sys', 'form', sid), 'primary', '📝'))] });
        return 'button';
      }
      return engine.chatForm(ctx, { title, fields, action });
    },
  };
  return ctx;
}
