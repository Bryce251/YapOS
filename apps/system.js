import { defineApp } from '../engine/apps.js';
import { card, dialog, button, row, rows, select, v2, onOff, bar, ICONS } from '../engine/ui.js';
import { customId } from '../engine/router.js';
import { formatDuration, didYouMean, tokenize } from '../engine/parse.js';
import { VERSION } from '../engine/config.js';
import { VERSION as SDK_VERSION } from '../engine/sdk.js';

const ID = 'system';
const cid = (action, ...args) => customId(ID, action, ...args);

function appTiles(engine, sid) {
  return engine.apps.list().filter((a) => a.meta.id !== ID && a.def.panel && engine.settings.isEnabled(sid, a.meta.id));
}

async function homeLayout(ctx) {
  const { engine } = ctx;
  const tiles = appTiles(engine, ctx.serverId);
  const core = ctx.core();
  const level = await ctx.level();
  const header = `## ${ICONS.system} ${VERSION.full}\nYour server's operating system.${core.setupDone ? '' : '\n**First boot:** run **/setup** to get going in a minute.'}`;
  const parts = [v2.text(header), v2.separator()];
  for (const a of tiles.slice(0, 8)) {
    parts.push(v2.section([`**${a.meta.icon} ${a.meta.name}**\n${a.meta.description}`], v2.button('Open', cid('open', a.meta.id), 'secondary')));
  }
  if (!tiles.length) parts.push(v2.text('No apps with a panel are installed yet. An admin can add some with **/apps**.'));
  parts.push(v2.separator());
  const quick = [v2.button('Help', cid('help'), 'secondary', '❔')];
  if (engine.isBotOwner(ctx.userId)) quick.push(v2.button('Status', cid('status'), 'secondary', '📊'));
  if (engine.perms.atLeast(level, 'admin')) quick.unshift(v2.button('Apps', cid('apps'), 'primary', '🧩'));
  parts.push(v2.row(...quick));
  return [v2.container(parts, 'system')];
}

function homeEmbed(ctx, tiles, isAdmin) {
  const lines = tiles.map((a) => `${a.meta.icon} **${a.meta.name}**: ${a.meta.description}`);
  const btns = tiles.slice(0, 15).map((a) => button(a.meta.name, cid('open', a.meta.id), 'secondary', a.meta.icon));
  const extra = [button('Help', cid('help'), 'secondary', '❔')];
  if (ctx.engine.isBotOwner(ctx.userId)) extra.push(button('Status', cid('status'), 'secondary', '📊'));
  if (isAdmin) extra.unshift(button('Apps', cid('apps'), 'primary', '🧩'));
  return {
    embeds: [card({ title: `${ICONS.system} ${VERSION.full}`, body: lines.join('\n') || 'No apps with a panel are installed yet.', color: 'system' })],
    components: [...rows(btns).slice(0, 4), row(extra)],
  };
}

async function showHome(ctx) {
  const isAdmin = ctx.engine.perms.atLeast(await ctx.level(), 'admin');
  const fallback = () => ctx.reply(homeEmbed(ctx, appTiles(ctx.engine, ctx.serverId), isAdmin));
  return ctx.engine.caps.attempt(ctx.serverId, 'v2', async () => ctx.reply({ layout: await homeLayout(ctx) }), fallback);
}

function helpView(engine, sid, appId) {
  if (appId) {
    const a = engine.apps.get(appId);
    if (!a) return { embeds: [dialog.warn('No such app', `I don't know **${appId}**.`)] };
    const cmds = Object.entries(a.def.commands || {}).map(([n, c]) => `**/${n}**: ${c.description}${c.perm && c.perm !== 'member' ? ` *(${c.perm})*` : ''}`);
    const extra = (a.def.help || []).map((l) => `• ${l}`);
    return { embeds: [card({ title: `${a.meta.icon} ${a.meta.name}`, body: [a.meta.description, '', ...cmds, ...(extra.length ? ['', ...extra] : [])].join('\n'), color: a.meta.id })], components: [row(button('All apps', cid('help'), 'secondary', '⬅️'))] };
  }
  const list = engine.apps.list();
  const fields = list.map((a) => ({
    name: `${a.meta.icon} ${a.meta.name}${sid && !engine.settings.isEnabled(sid, a.meta.id) ? ' (not installed)' : ''}`,
    value: Object.keys(a.def.commands || {}).map((n) => `/${n}`).join(' ') || '-',
    inline: true,
  }));
  const opts = list.map((a) => ({ label: a.meta.name, value: a.meta.id, emoji: a.meta.icon, description: a.meta.description.slice(0, 100) }));
  return {
    embeds: [card({ title: '❔ YapOS help', body: 'Every app has one main command that opens a panel. Many also take typed shortcuts, like `/mod timeout @sam 10m spam`.\n**/yap** understands plain words: `/yap timeout @sam 10m`, `/yap welcome`.', fields, color: 'info' })],
    components: [select(cid('helppick'), opts.slice(0, 25), { placeholder: 'Pick an app for details' })],
    fallbackComponents: rows(list.slice(0, 20).map((a) => button(a.meta.name, cid('helpapp', a.meta.id), 'secondary', a.meta.icon))),
  };
}

async function sendWithSelectFallback(ctx, view, how = 'ephemeral') {
  const { fallbackComponents, ...main } = view;
  if (!fallbackComponents) return ctx[how](main);
  return ctx.engine.caps.attempt(ctx.serverId, 'selects', () => ctx[how](main), () => ctx[how]({ ...main, components: fallbackComponents }));
}

async function statusView(ctx) {
  const { engine, bot } = ctx;
  const t0 = Date.now();
  let latency = null;
  try { await bot.api('GET', '/me'); latency = Date.now() - t0; engine.stats.lastLatencyMs = latency; } catch { latency = null; }
  const head = engine.budget.headroom(ctx.serverId);
  const mem = process.memoryUsage();
  const capLines = engine.caps.summary(ctx.serverId).map((c) => `${c.state === true ? '🟢' : c.state === false ? '🔴' : '⚪'} ${c.label}${c.forced !== null ? ' *(forced)*' : ''}`);
  const fields = [
    { name: 'Latency', value: latency === null ? 'unreachable' : `${latency} ms`, inline: true },
    { name: 'Connection', value: engine.gatewayState(), inline: true },
    { name: 'Uptime', value: formatDuration(Date.now() - engine.startedAt), inline: true },
    { name: 'Message budget (this server)', value: `${bar(head.server / head.serverLimit)} ${head.server}/${head.serverLimit} a minute`, inline: false },
    { name: `Message budget (overall${engine.budget.verified ? ', verified' : ''})`, value: `${bar(head.global / head.globalLimit)} ${head.global}/${head.globalLimit} a minute${engine.budget.queued ? ` · ${engine.budget.queued} queued` : ''}`, inline: false },
    { name: 'Memory', value: `${Math.round(mem.rss / 1048576)} MB`, inline: true },
    { name: 'Apps', value: String(engine.apps.size), inline: true },
    { name: 'Handled', value: `${engine.stats.commands} commands · ${engine.stats.interactions} clicks`, inline: true },
    { name: 'Features on this server', value: capLines.join('\n'), inline: false },
  ];
  return { embeds: [card({ title: '📊 System monitor', fields, color: 'system', footer: `${VERSION.full} · SDK ${SDK_VERSION} · run /status again to refresh` })] };
}

async function showStatus(ctx) {
  if (!ctx.engine.isBotOwner(ctx.userId)) return ctx.warn('Not allowed', "Only YapOS's owner can open the system monitor.");
  return ctx.ephemeral(await statusView(ctx));
}

function appsView(engine, sid) {
  const list = engine.apps.list();
  const lines = list.map((a) => `${a.meta.core ? '🔒' : engine.settings.isEnabled(sid, a.meta.id) ? '🟢' : '⚪'} ${a.meta.icon} **${a.meta.name}**: ${a.meta.description}`);
  const toggles = list.filter((a) => !a.meta.core).map((a) => {
    const on = engine.settings.isEnabled(sid, a.meta.id);
    return button(`${on ? 'Uninstall' : 'Install'} ${a.meta.name}`, cid('toggle', a.meta.id), on ? 'secondary' : 'success', a.meta.icon);
  });
  return {
    embeds: [card({ title: '🧩 Apps', body: `${lines.join('\n')}\n\n-# 🔒 system apps are always on. Uninstalling keeps the app's settings, so you can install it again later.`, color: 'system' })],
    components: rows(toggles),
  };
}

async function runYap(ctx) {
  const { engine } = ctx;
  const tokens = tokenize(ctx.args);
  const first = (tokens[0] || '').toLowerCase().replace(/^\//, '');
  if (!first) return showHome(ctx);
  const route = engine.yap.find(first);
  if (route) {
    if (ctx.serverId && !engine.settings.isEnabled(ctx.serverId, route.app)) {
      const meta = engine.apps.get(route.app)?.meta;
      return ctx.warn(`${meta?.name || route.app} isn't installed here`, 'An admin can install it with **/apps**.');
    }
    const sub = engine.contextFor(ctx.source, { app: route.app, args: tokens.slice(1).join(' ') });
    sub.argv = tokens.slice(1);
    sub.word = first;
    return route.run(sub);
  }
  const app = engine.apps.list().find((a) => a.meta.id === first || a.meta.name.toLowerCase() === first);
  if (app?.def.panel) return openApp(ctx, app.meta.id);
  const words = [...engine.yap.words(), ...engine.apps.list().map((a) => a.meta.id)];
  const guess = didYouMean(first, words);
  return ctx.warn("I didn't get that", `I don't know **${first}**.${guess.length ? ` Did you mean ${guess.map((g) => `**${g}**`).join(', ')}?` : ''}\nTry **/help** for everything I can do.`);
}

async function openApp(ctx, appId) {
  const a = ctx.engine.apps.get(appId);
  if (!a?.def.panel) return ctx.warn('Nothing to open', 'That app has no panel.');
  if (ctx.serverId && !ctx.engine.settings.isEnabled(ctx.serverId, appId)) return ctx.warn(`${a.meta.name} isn't installed here`, 'An admin can install it with **/apps**.');
  const appCtx = ctx.engine.contextFor(ctx.source, { app: appId, args: '' });
  return a.def.panel(appCtx);
}

export const { setup, teardown, check } = defineApp({
  id: ID,
  name: 'System',
  icon: ICONS.system,
  description: 'Home screen, help, status and app installs.',
  category: 'System',
  core: true,

  commands: {
    menu: { description: 'Open the YapOS home screen', run: showHome },
    help: { description: 'What YapOS can do. Try /help mod', serverOnly: false, run: (ctx) => sendWithSelectFallback(ctx, helpView(ctx.engine, ctx.serverId, ctx.argv[0]?.toLowerCase())) },
    status: { description: 'System monitor: latency, connection, message budget (bot owner only)', serverOnly: false, run: (ctx) => showStatus(ctx) },
    apps: { description: 'Install or uninstall YapOS apps (admins)', perm: 'admin', run: (ctx) => ctx.ephemeral(appsView(ctx.engine, ctx.serverId)) },
    yap: { description: 'Do anything in plain words: /yap timeout @sam 10m, /yap welcome', run: runYap },
  },

  components: {
    open: { run: (ctx) => openApp(ctx, ctx.argv[0]) },
    help: { run: (ctx) => sendWithSelectFallback(ctx, helpView(ctx.engine, ctx.serverId), ctx.kind === 'button' ? 'ephemeral' : 'ephemeral') },
    helppick: { run: (ctx) => ctx.ephemeral(helpView(ctx.engine, ctx.serverId, ctx.values?.[0])) },
    helpapp: { run: (ctx) => ctx.ephemeral(helpView(ctx.engine, ctx.serverId, ctx.argv[0])) },
    status: { run: (ctx) => showStatus(ctx) },
    apps: { perm: 'admin', run: (ctx) => ctx.ephemeral(appsView(ctx.engine, ctx.serverId)) },
    toggle: {
      perm: 'admin',
      run: async (ctx) => {
        const id = ctx.argv[0];
        const a = ctx.engine.apps.get(id);
        if (!a || a.meta.core) return ctx.warn("Can't change that", 'System apps are always on.');
        const on = !ctx.engine.settings.isEnabled(ctx.serverId, id);
        ctx.engine.settings.setEnabled(ctx.serverId, id, on);
        return ctx.update(appsView(ctx.engine, ctx.serverId));
      },
    },
  },

  events: {
    dm_message: async (ctx, msg) => {
      for (const route of ctx.engine.dmRoutes) {
        let claimed = false;
        try { claimed = !!(await route.match(msg)); } catch { claimed = false; }
        if (!claimed) continue;
        const appCtx = ctx.engine.contextFor(msg, { app: route.app, kind: 'dm' });
        try { await route.run(appCtx, msg); } catch (e) { await appCtx.fail(e); }
        return;
      }
      if (ctx.engine.services.get('pocket')) return;
      await msg.reply(`👋 Hi! I'm ${VERSION.full}. **YapOS Pocket**, your personal assistant here in DMs, is coming soon. In a server, try **/menu**.`).catch(() => {});
    },
  },

  help: ['/menu shows a tile for every installed app.', '/status shows the connection, message budget and which testing features work on this server.'],
});
