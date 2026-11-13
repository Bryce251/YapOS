import { defineApp } from '../engine/apps.js';
import { card, dialog, button, linkButton, row, rows, select, bar, ICONS } from '../engine/ui.js';
import { customId } from '../engine/router.js';
import { formatDuration, didYouMean, tokenize } from '../engine/parse.js';
import { VERSION } from '../engine/config.js';
import { VERSION as SDK_VERSION } from '../engine/sdk.js';
import { accept, reject, toBool, plainObject, SLUG_RE } from '../engine/dashboard.js';

const ID = 'system';
const cid = (action, ...args) => customId(ID, action, ...args);

const plain = (text) => String(text ?? '').replace(/[^a-z0-9_-]/gi, '').slice(0, 32);
const exact = (text) => (plain(text) === String(text ?? '') ? plain(text) : '');

async function adminHere(ctx) {
  if (!ctx.serverId) {
    await ctx.warn('Servers only', 'Apps are installed per server, so use **/apps** inside a server.');
    return false;
  }
  for (const key of [`m:${ctx.serverId}:${ctx.userId}`, `r:${ctx.serverId}`, `s:${ctx.serverId}`]) ctx.engine.perms.invalidate(key);
  await ctx.require('admin');
  return true;
}

async function showApps(ctx) {
  if (!(await adminHere(ctx))) return null;
  return ctx.ephemeral(appsView(ctx.engine, ctx.serverId));
}

async function toggleApp(ctx) {
  if (!(await adminHere(ctx))) return null;
  const id = exact(ctx.argv[0]);
  const a = ctx.engine.apps.get(id);
  if (!a || a.meta.core) return ctx.warn("Can't change that", 'System apps are always on.');
  const wanted = ctx.argv[1] === 'on' ? true : ctx.argv[1] === 'off' ? false : !ctx.engine.settings.isEnabled(ctx.serverId, id);
  ctx.engine.settings.setEnabled(ctx.serverId, id, wanted);
  return ctx.update(appsView(ctx.engine, ctx.serverId));
}

const HOME_ID = cid('home');
const MAX_ROWS = 5;
const MAX_IN_ROW = 5;
const TILE_ROWS = MAX_ROWS - 1;
const DEFAULT_PANEL_PERM = { mod: 'mod', automod: 'mod', welcome: 'admin', roles: 'admin', setup: 'admin' };

function appTiles(engine, sid) {
  return engine.apps.list().filter((a) => a.meta.id !== ID && a.def.panel && engine.settings.isEnabled(sid, a.meta.id));
}

function panelPerm(engine, a) {
  const asked = String(a.def.panelPerm ?? DEFAULT_PANEL_PERM[a.meta.id] ?? 'member').toLowerCase();
  return engine.perms.LEVELS.includes(asked) ? asked : 'member';
}

function visibleTiles(engine, sid, level) {
  return appTiles(engine, sid).filter((a) => engine.perms.atLeast(level, panelPerm(engine, a)));
}

async function homeView(ctx) {
  const { engine } = ctx;
  const level = await ctx.level();
  const isAdmin = engine.perms.atLeast(level, 'admin');
  const tiles = visibleTiles(engine, ctx.serverId, level);
  const shown = tiles.slice(0, TILE_ROWS * MAX_IN_ROW);
  const lines = tiles.map((a) => `${a.meta.icon} **${a.meta.name}** · ${a.meta.description}`);
  const intro = tiles.length ? "Your server's operating system. Pick an app to open it right here." : "Your server's operating system.";
  const empty = isAdmin ? 'No apps with a panel are installed yet. Add some with **🧩 Apps**.' : 'Nothing to open here yet. Try **❔ Help** to see what I can do.';
  const more = tiles.length > shown.length ? `\n-# More apps: type **/yap** and the app's name.` : '';
  const body = `${intro}\n\n${lines.length ? lines.join('\n') : empty}${more}`;
  const quick = [button('Help', cid('help'), 'secondary', '❔')];
  if (isAdmin) quick.push(button('Apps', cid('apps'), 'primary', '🧩'));
  if (engine.isBotOwner(ctx.userId)) quick.push(button('Status', cid('status'), 'secondary', '📊'));
  return {
    content: '',
    embeds: [card({ title: `${ICONS.system} ${VERSION.full}`, body, color: 'system' })],
    components: [...rows(shown.map((a) => button(a.meta.name, cid('open', a.meta.id), 'secondary', a.meta.icon))).slice(0, TILE_ROWS), row(quick)],
  };
}

async function showHome(ctx) {
  return ctx.reply(await homeView(ctx));
}

async function goHome(ctx) {
  if (!ctx.serverId) return ctx.warn('Servers only', 'The home screen lives inside a server. Try **/menu** there.');
  const view = await homeView(ctx);
  if (ctx.source?.message_id) return ctx.update(view);
  return ctx.reply(view);
}

const isButton = (c) => c && (c.type === 'button' || c.type === 2);
const isButtonRow = (c) => c && (c.type === 'row' || c.type === 1) && Array.isArray(c.components) && c.components.every(isButton);
const hasHome = (list) => list.some(function walk(c) { return !!c && (c.custom_id === HOME_ID || (c.components || []).some(walk)); });

function withHomeRow(components) {
  const list = Array.isArray(components) ? components.filter(Boolean) : [];
  if (hasHome(list)) return list;
  const home = button('Home', HOME_ID, 'secondary', '⬅️');
  if (list.length < MAX_ROWS) return [...list, row(home)];
  const last = list[list.length - 1];
  if (isButtonRow(last) && last.components.length < MAX_IN_ROW) return [...list.slice(0, -1), { ...last, components: [...last.components, home] }];
  return null;
}

function asPayload(payload, opts) {
  if (payload == null) return { content: '', ...opts };
  if (typeof payload === 'string') return { content: payload, ...opts };
  return { ...payload, ...opts };
}

function showInPlace(appCtx) {
  const original = {};
  for (const name of ['reply', 'ephemeral', 'panel', 'update']) original[name] = appCtx[name];
  const edit = original.update;
  for (const name of ['reply', 'ephemeral', 'panel', 'update']) {
    appCtx[name] = async (payload, opts) => {
      const p = asPayload(payload, opts);
      const components = !p.layout && !(Array.isArray(p.files) && p.files.length) ? withHomeRow(p.components) : null;
      if (!components) return original[name === 'update' ? 'reply' : name](payload, opts);
      try {
        return await edit({ content: p.content ?? '', embeds: p.embeds ?? [], components });
      } catch (e) {
        appCtx.engine.log.debug('could not open the app in place', e?.message);
        return original[name === 'update' ? 'reply' : name](payload, opts);
      }
    };
  }
  return appCtx;
}

function helpView(engine, sid, asked) {
  const appId = plain(asked).toLowerCase();
  if (asked) {
    const a = engine.apps.get(appId);
    if (!a) return { embeds: [dialog.warn('No such app', `I don't know ${appId ? `**${appId}**` : 'that app'}. Run **/help** to see every app.`)] };
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

function dashboardBase(engine) {
  const raw = String(engine.config?.dashboardUrl || '').trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') return null;
    return u.origin;
  } catch {
    return null;
  }
}

function dashboardView(engine, sid) {
  const base = dashboardBase(engine);
  if (!base) return { embeds: [dialog.warn("The web dashboard isn't on yet", "YapOS's owner hasn't connected the web dashboard. Everything still works from **/menu**.")] };
  const here = sid ? `${base}/servers/${encodeURIComponent(sid)}` : `${base}/servers`;
  const body = sid
    ? "Change this server's settings, read mod cases and see the global leaderboard from your browser. Log in with your Yapin' account. You only see servers you manage."
    : "Change your servers' settings from your browser. Log in with your Yapin' account.";
  const buttons = [linkButton(sid ? 'Open this server' : 'Open the dashboard', here, '🌐')];
  if (sid) buttons.push(linkButton('All my servers', `${base}/servers`, '🗂️'));
  return { embeds: [card({ title: '🌐 YapOS dashboard', body, color: 'system', footer: base.replace(/^https?:\/\//, '') })], components: [row(...buttons)] };
}

async function showStatus(ctx) {
  if (!ctx.engine.isBotOwner(ctx.userId)) return ctx.ephemeral({ embeds: [dialog.denied('botowner', { body: "Only YapOS's owner can open the system monitor." })] });
  return ctx.ephemeral(await statusView(ctx));
}

function appsView(engine, sid) {
  const list = engine.apps.list();
  const lines = list.map((a) => `${a.meta.core ? '🔒' : engine.settings.isEnabled(sid, a.meta.id) ? '🟢' : '⚪'} ${a.meta.icon} **${a.meta.name}**: ${a.meta.description}`);
  const toggles = list.filter((a) => !a.meta.core).map((a) => {
    const on = engine.settings.isEnabled(sid, a.meta.id);
    return button(`${on ? 'Uninstall' : 'Install'} ${a.meta.name}`, cid('toggle', a.meta.id, on ? 'off' : 'on'), on ? 'secondary' : 'success', a.meta.icon);
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
    if (!engine.apps.get(route.app)) return ctx.warn("I didn't get that", 'That app is not loaded right now. Try **/help** for everything I can do.');
    const sub = engine.contextFor(ctx.source, { app: route.app, args: tokens.slice(1).join(' ') });
    sub.argv = tokens.slice(1);
    sub.word = first;
    return route.run(sub);
  }
  const app = engine.apps.list().find((a) => a.meta.id === first || a.meta.name.toLowerCase() === first);
  if (app?.def.panel) return openApp(ctx, app.meta.id);
  const words = [...engine.yap.words(), ...engine.apps.list().map((a) => a.meta.id)];
  const guess = didYouMean(first, words);
  const shown = plain(first);
  return ctx.warn("I didn't get that", `I don't know ${shown ? `**${shown}**` : 'that'}.${guess.length ? ` Did you mean ${guess.map((g) => `**${g}**`).join(', ')}?` : ''}\nTry **/help** for everything I can do.`);
}

async function openApp(ctx, asked) {
  const appId = exact(asked);
  const a = ctx.engine.apps.get(appId);
  if (!a?.def.panel || appId === ID) return ctx.warn('Nothing to open', 'That app has no panel.');
  if (!ctx.serverId) return ctx.warn('Servers only', 'App panels open inside a server. Try **/menu** there.');
  if (!ctx.engine.settings.isEnabled(ctx.serverId, appId)) return ctx.warn(`${a.meta.name} isn't installed here`, 'An admin can install it with **/apps**.');
  const appCtx = ctx.engine.contextFor(ctx.source, { app: appId, args: '' });
  const onHome = ctx.kind !== 'select' && ctx.kind !== 'modal_submit' && !!ctx.source?.message_id && typeof ctx.source.update === 'function';
  return a.def.panel(onHome ? showInPlace(appCtx) : appCtx);
}

const SLUG_HELP = 'Use 3 to 32 lowercase letters, numbers or dashes, like my-server.';

function validatePublicPage(ctx, v) {
  if (!plainObject(v)) return reject('Turn the public page on or off.');
  const on = toBool(v.enabled);
  if (on === null) return reject('Turn the public page on or off.');
  const cur = ctx.core().publicPage;
  let slug = plainObject(cur) && typeof cur.slug === 'string' ? cur.slug : null;
  if (v.slug !== undefined && v.slug !== null && v.slug !== '') {
    const typed = typeof v.slug === 'string' ? v.slug.trim() : '';
    if (!SLUG_RE.test(typed)) return reject(SLUG_HELP);
    slug = typed;
  }
  if (on && !slug) return reject(`Pick a link name for the page first. ${SLUG_HELP}`);
  return accept({ enabled: on, slug });
}

async function savePublicPage(ctx, value) {
  const { engine, serverId } = ctx;
  const prev = engine.settings.core(serverId).publicPage ?? null;
  engine.settings.patchCore(serverId, { publicPage: value });
  const r = value.enabled ? await engine.dashboard?.publishPublic(serverId) : await engine.dashboard?.unpublishPublic(serverId);
  if (r?.ok) return undefined;
  engine.settings.patchCore(serverId, { publicPage: prev });
  if (r?.status === 409) return { error: 'That link name is taken. Pick another one.' };
  return { error: "I couldn't update the public page right now. Try again in a minute." };
}

const DASHBOARD = [
  {
    key: 'publicPage', label: 'Public page', type: 'complex', web: true,
    default: { enabled: false, slug: null },
    help: 'A public page with the one global leaderboard: levels and 💎 Shards across every server. Off until you turn it on.',
    note: 'Change it on the Public page tab.',
    read: (cfg, core) => (plainObject(core.publicPage) ? { enabled: core.publicPage.enabled === true, slug: core.publicPage.slug ?? null } : { enabled: false, slug: null }),
    validate: validatePublicPage,
    save: savePublicPage,
  },
];

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
    dashboard: { description: 'Open the YapOS web dashboard to change settings in your browser', serverOnly: false, run: (ctx) => ctx.reply(dashboardView(ctx.engine, ctx.serverId)) },
    apps: { description: 'Install or uninstall YapOS apps (admins)', perm: 'admin', run: showApps },
    yap: { description: 'Do anything in plain words: /yap timeout @sam 10m, /yap welcome', run: runYap },
  },

  components: {
    open: { run: (ctx) => openApp(ctx, ctx.argv[0]) },
    home: { run: goHome },
    help: { run: (ctx) => sendWithSelectFallback(ctx, helpView(ctx.engine, ctx.serverId)) },
    helppick: { run: (ctx) => sendWithSelectFallback(ctx, helpView(ctx.engine, ctx.serverId, Array.isArray(ctx.values) ? ctx.values[0] : null)) },
    helpapp: { run: (ctx) => sendWithSelectFallback(ctx, helpView(ctx.engine, ctx.serverId, ctx.argv[0])) },
    status: { run: (ctx) => showStatus(ctx) },
    apps: { perm: 'admin', run: showApps },
    toggle: { perm: 'admin', run: toggleApp },
  },

  events: {
    dm_message: async (ctx, msg) => {
      if (msg.yaposPrompt) return;
      for (const route of ctx.engine.dmRoutes) {
        let claimed = false;
        try { claimed = !!(await route.match(msg)); } catch { claimed = false; }
        if (!claimed) continue;
        const appCtx = ctx.engine.contextFor(msg, { app: route.app, kind: 'dm' });
        try { await route.run(appCtx, msg); } catch (e) { await appCtx.fail(e); }
        return;
      }
      const pocket = ctx.engine.service('pocket');
      const help = typeof pocket?.dmHelp === 'function' ? pocket.dmHelp(msg.author_id) : null;
      if (help) {
        await msg.reply(help.content || '', { embeds: help.embeds }).catch(() => {});
        return;
      }
      await msg.reply(`👋 Hi! I'm ${VERSION.full}. **YapOS Pocket**, my DM assistant, isn't switched on right now. In a server, try **/menu**.`).catch(() => {});
    },
  },

  dashboard: DASHBOARD,

  help: ['/menu shows a tile for every app you can use. Tiles open right on the home screen, and **⬅️ Home** brings you back.', '/status shows the connection, message budget and which testing features work on this server.'],
});
