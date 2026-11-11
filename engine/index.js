import path from 'node:path';
import { ROOT, VERSION } from './config.js';
import { createLogger } from './log.js';
import { createMemoryStore } from './storage.js';
import { createSettings } from './settings.js';
import { createPerms } from './perms.js';
import { createCaps } from './caps.js';
import { createBudget } from './budget.js';
import { createRouter } from './router.js';
import { createPrompts } from './prompts.js';
import { createContext } from './context.js';
import { createAppRegistry, createYap } from './apps.js';
import { dialog } from './ui.js';
import { normalizeName } from './parse.js';

const CHANNEL_HINTS = {
  welcome: ['welcome', 'welcomes', 'arrivals', 'joins', 'greetings', 'say-hi', 'introductions', 'new-members'],
  goodbye: ['goodbye', 'goodbyes', 'leaves', 'departures', 'farewell'],
  rules: ['rules', 'server-rules', 'rule', 'guidelines', 'info', 'read-me', 'readme', 'start-here'],
  logs: ['mod-log', 'modlog', 'mod-logs', 'modlogs', 'logs', 'log', 'audit-log', 'bot-logs', 'staff-logs', 'action-log'],
  general: ['general', 'chat', 'main', 'lounge', 'general-chat', 'main-chat', 'talk'],
  announcements: ['announcements', 'announcement', 'news', 'updates'],
  roles: ['roles', 'get-roles', 'self-roles', 'role-select', 'pick-roles', 'reaction-roles'],
  verify: ['verify', 'verification', 'verify-here', 'gate'],
  bots: ['bot-commands', 'bots', 'commands', 'bot-spam', 'bot'],
};

export function detectChannels(channels) {
  const text = (channels || []).filter((c) => c.type === 'text' || c.kind === 'text');
  const found = {};
  for (const [slot, names] of Object.entries(CHANNEL_HINTS)) {
    let best = null;
    for (const c of text) {
      const n = normalizeName(c.name);
      const idx = names.findIndex((h) => n === h);
      const partial = idx < 0 ? names.findIndex((h) => n.split('-').includes(h) || n.endsWith(h)) : -1;
      const score = idx >= 0 ? idx : partial >= 0 ? 100 + partial : null;
      if (score !== null && (!best || score < best.score)) best = { score, channel: c };
    }
    if (best) found[slot] = best.channel;
  }
  return found;
}

export function createEngine({ bot, config = {}, store = createMemoryStore(), log = createLogger(), appsDir = path.join(ROOT, 'apps') } = {}) {
  const apps = createAppRegistry();
  const settings = createSettings({ store, apps });
  const perms = createPerms({ bot, settings });
  const caps = createCaps({ settings, log });
  const budget = createBudget({ bot, verified: !!config.verified, log });
  const prompts = createPrompts();
  const yap = createYap();
  const services = new Map();
  const startedAt = Date.now();
  const stats = { events: 0, commands: 0, interactions: 0, errors: 0, lastLatencyMs: null };

  const listCache = new Map();
  const cachedList = async (key, ttl, fn) => {
    const hit = listCache.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.value;
    const value = await fn();
    listCache.set(key, { at: Date.now(), value });
    return value;
  };
  const cache = {
    async members(sid) {
      return cachedList(`m:${sid}`, 120_000, async () => {
        const all = [];
        let after;
        for (let page = 0; page < 10; page++) {
          const batch = await bot.members(sid, after);
          all.push(...(batch || []));
          if (!batch || batch.length < 200) break;
          after = batch[batch.length - 1].id;
        }
        return all;
      });
    },
    channels: (sid) => cachedList(`c:${sid}`, 60_000, async () => (await bot.channels(sid)) || []),
    invalidate(sid) { for (const k of [...listCache.keys()]) if (k.endsWith(`:${sid}`)) listCache.delete(k); perms.invalidate(); },
  };

  const engine = {
    bot, config, store, log, apps, settings, perms, caps, budget, prompts, yap, services, cache, stats, startedAt, VERSION,
    router: null,
    dmRoutes: [],
    contextFor: (source, opts) => createContext(engine, source, opts),
    service: (id) => services.get(id) || null,
    isBotOwner: (uid) => !!uid && uid === (config.ownerId || bot.me?.bot?.owner_id),
    detectChannels: async (sid) => detectChannels(await cache.channels(sid)),

    async chatForm(ctx, { title, fields, action }) {
      if (ctx.source.ack && !ctx.answered) {
        await ctx.ephemeral({ embeds: [dialog.info(title, `Let's do this in chat. I'll ask ${fields.length} question${fields.length === 1 ? '' : 's'}; type **cancel** to stop.`)] }).catch(() => {});
      }
      const values = {};
      for (const f of fields) {
        const q = `**${f.label}**${f.required === false ? ' (or type **skip**)' : ''}${f.placeholder ? `\n-# e.g. ${f.placeholder}` : ''}`;
        await budget.send({ serverId: ctx.serverId, channelId: ctx.channelId, content: `<@${ctx.userId}> ${q}`, priority: 'high' });
        const r = await prompts.ask(ctx.channelId, ctx.userId);
        if (r.cancelled || r.timedOut) {
          await budget.send({ serverId: ctx.serverId, channelId: ctx.channelId, content: r.timedOut ? 'Form timed out. Run the command again when you are ready.' : 'Cancelled.', priority: 'high' });
          return 'cancelled';
        }
        values[f.id] = f.required === false && /^skip$/i.test(r.text) ? '' : r.text.slice(0, f.max || 4000);
      }
      const h = engine.router.handlers.get(`${ctx.app}:${action}`);
      if (!h) throw new Error(`No handler ${ctx.app}:${action} for chat form`);
      const source = { server_id: ctx.serverId, channel_id: ctx.channelId, user_id: ctx.userId, username: ctx.username, values };
      const formCtx = createContext(engine, source, { app: ctx.app, kind: 'modal_submit', values, args: [] });
      await h.run(formCtx);
      return 'chat';
    },

    async load(only = null) {
      if (only) for (const id of only) await bot.load(path.join(appsDir, `${id}.js`));
      else await bot.loadCogs(appsDir);
      log.info(`${VERSION.full}: ${apps.size} apps loaded (${apps.list().map((a) => a.meta.id).join(', ')})`);
    },

    gatewayState() {
      const ws = bot._ws;
      if (ws && ws.readyState === 1) return bot._gwRequests ? 'gateway (API calls over the socket)' : 'gateway';
      return bot.running ? 'long polling' : 'offline';
    },
  };

  bot.yapos = engine;
  engine.router = createRouter({ bot, engine, log });
  engine.router.attach();

  engine.router.register('sys', 'form', {
    run: async (ctx) => {
      const s = engine.router.getSession(ctx.argv[0]);
      if (!s) return ctx.warn('This form expired', 'Run the command again.');
      if (s.userId && s.userId !== ctx.userId) return ctx.warn('Not your form', 'Run the command yourself to get one.');
      try {
        await ctx.source.showModal(s.modal);
        caps.mark(ctx.serverId, 'modals', true);
      } catch (e) {
        caps.mark(ctx.serverId, 'modals', false, e?.message);
        const appCtx = createContext(engine, ctx.source, { app: s.app, kind: 'button', args: [] });
        await engine.chatForm(appCtx, { title: s.modal.title, fields: s.fields, action: s.action });
      }
    },
  });

  bot.on('message', (msg) => {
    stats.events++;
    if (prompts.offer(msg)) return;
    if (msg.command) stats.commands++;
  });
  bot.on('command', () => { stats.commands++; });
  bot.on('interaction', () => { stats.interactions++; });
  bot.on('member_join', (ev) => cache.invalidate(ev.server_id));
  bot.on('member_leave', (ev) => cache.invalidate(ev.server_id));
  bot.on('error', (e) => {
    stats.errors++;
    log.error(e?.cog ? `[${e.cog}${e.where ? ` ${e.where}` : ''}]` : '[sdk]', e);
  });

  return engine;
}
