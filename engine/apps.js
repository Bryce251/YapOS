import { dialog } from './ui.js';

const NAME_RE = /^[a-z0-9_-]{1,32}$/;

export function defineApp(def) {
  const meta = {
    id: def.id,
    name: def.name || def.id,
    icon: def.icon || '🧩',
    description: def.description || '',
    category: def.category || 'Utility',
    core: !!def.core,
    defaultEnabled: def.defaultEnabled !== false,
    defaults: def.defaults || {},
    phase: def.phase || 1,
  };
  if (!NAME_RE.test(meta.id)) throw new Error(`Bad app id "${meta.id}"`);
  for (const [name, c] of Object.entries(def.commands || {})) {
    if (!NAME_RE.test(name)) throw new Error(`App ${meta.id}: bad command name "${name}"`);
    if (String(c.description || '').length > 100) throw new Error(`App ${meta.id}: /${name} description is over 100 characters`);
  }

  let engine = null;

  function setup(bot) {
    engine = bot.yapos;
    if (!engine) throw new Error(`App ${meta.id} needs the YapOS engine (bot.yapos) before it loads`);
    engine.apps.register(meta, def);

    for (const [name, c] of Object.entries(def.commands || {})) {
      bot.command(name, c.description || '', async (msg) => {
        const ctx = engine.contextFor(msg, { app: meta.id });
        try {
          if (c.perm && ctx.serverId) await ctx.require(c.perm);
          if (c.serverOnly !== false && !ctx.serverId) return ctx.reply("That command works in servers, not here.");
          await c.run(ctx);
        } catch (e) {
          await ctx.fail(e, c.explain || {});
        }
      });
    }

    for (const [action, spec] of Object.entries(def.components || {})) engine.router.register(meta.id, action, spec);

    for (const [event, fn] of Object.entries(def.events || {})) {
      bot.on(event, async (ev) => {
        const sid = ev?.server_id ?? null;
        if (sid && !engine.settings.isEnabled(sid, meta.id)) return;
        const ctx = engine.contextFor(ev, { app: meta.id, kind: event });
        try {
          await fn(ctx, ev);
        } catch (e) {
          engine.log.error(`[${meta.id}] ${event} handler failed:`, e);
        }
      });
    }

    if (def.yap) for (const y of [].concat(def.yap)) engine.yap.add(meta.id, y);
    if (def.dm) engine.dmRoutes.push({ app: meta.id, match: def.dm.match, run: def.dm.run });
    if (def.services) engine.services.set(meta.id, def.services(engine));
    if (def.init) return def.init(engine);
    return undefined;
  }

  async function teardown() {
    if (!engine) return;
    try { await def.dispose?.(engine); } finally {
      engine.router.unregisterApp(meta.id);
      engine.yap.removeApp(meta.id);
      for (let i = engine.dmRoutes.length - 1; i >= 0; i--) if (engine.dmRoutes[i].app === meta.id) engine.dmRoutes.splice(i, 1);
      engine.services.delete(meta.id);
      engine.apps.unregister(meta.id);
    }
  }

  async function check(msg) {
    const sid = msg?.server_id;
    if (!sid || !engine || engine.settings.isEnabled(sid, meta.id)) return true;
    const card = dialog.warn(`${meta.name} isn't installed here`, 'An admin can install it with **/apps**.');
    const ctx = engine.contextFor(msg, { app: meta.id });
    await ctx.ephemeral({ embeds: [card] }).catch(() => {});
    return false;
  }

  return { setup, teardown, check, meta, def };
}

export function createAppRegistry() {
  const apps = new Map();
  return {
    register(meta, def) { apps.set(meta.id, { meta, def }); },
    unregister(id) { apps.delete(id); },
    get: (id) => apps.get(id),
    has: (id) => apps.has(id),
    list: () => [...apps.values()].sort((a, b) => (a.meta.core === b.meta.core ? a.meta.name.localeCompare(b.meta.name) : a.meta.core ? -1 : 1)),
    get size() { return apps.size; },
  };
}

export function createYap() {
  const routes = [];
  return {
    add(app, { words, run, help }) { routes.push({ app, words: [].concat(words).map((w) => w.toLowerCase()), run, help }); },
    removeApp(app) { for (let i = routes.length - 1; i >= 0; i--) if (routes[i].app === app) routes.splice(i, 1); },
    find(word) { const w = String(word || '').toLowerCase(); return routes.find((r) => r.words.includes(w)) || null; },
    words: () => routes.flatMap((r) => r.words),
    routes: () => [...routes],
  };
}
