import { defineApp } from '../engine/apps.js';
import { card, dialog, button, row, rows, select, ICONS } from '../engine/ui.js';
import { customId } from '../engine/router.js';
import { normalizeName, didYouMean, resolveChannel, clip } from '../engine/parse.js';
import { permName, explain } from '../engine/errors.js';

const ID = 'setup';
const cid = (action, ...args) => customId(ID, action, ...args);
const PANEL_TTL_MS = 15 * 60_000;
const PRESET_TIMEOUT_MS = 15_000;
const NOTE_TTL_MS = 2 * 60_000;

const PRESETS = [
  { id: 'gaming', label: 'Gaming', emoji: '🎮', blurb: 'Game nights, levels, looking-for-group' },
  { id: 'friends', label: 'Friends hangout', emoji: '🍕', blurb: 'Chill chat, fun and games' },
  { id: 'study', label: 'Study', emoji: '📚', blurb: 'Focus tools, reminders, quiet channels' },
  { id: 'community', label: 'Community', emoji: '🏘️', blurb: 'Welcomes, roles and solid moderation' },
  { id: 'roleplay', label: 'Roleplay', emoji: '🎭', blurb: 'Characters, scenes and story tools' },
  { id: 'custom', label: 'Custom', emoji: '🛠️', blurb: 'Start blank and pick everything yourself' },
];

const PRESET_ALIASES = {
  game: 'gaming', games: 'gaming', gamer: 'gaming', gamers: 'gaming',
  friend: 'friends', hangout: 'friends', 'friends-hangout': 'friends', chill: 'friends', social: 'friends',
  school: 'study', studying: 'study', class: 'study', homework: 'study',
  public: 'community', server: 'community',
  rp: 'roleplay', 'role-play': 'roleplay', story: 'roleplay',
  blank: 'custom', none: 'custom', manual: 'custom',
};

const SLOTS = [
  { id: 'welcome', label: 'Welcome', emoji: '👋', hint: 'where new people get greeted' },
  { id: 'rules', label: 'Rules', emoji: '📜', hint: 'your server rules' },
  { id: 'logs', label: 'Logs', emoji: '🗂️', hint: 'private staff log of mod actions' },
  { id: 'general', label: 'General', emoji: '💬', hint: 'the main chat' },
  { id: 'announcements', label: 'Announcements', emoji: '📣', hint: 'news and updates' },
  { id: 'roles', label: 'Roles', emoji: '🎭', hint: 'where people pick their roles' },
  { id: 'verify', label: 'Verify', emoji: '✅', hint: 'where newcomers prove they are human' },
];

const SLOT_ALIASES = {
  welcomes: 'welcome', greet: 'welcome', greetings: 'welcome', joins: 'welcome', arrivals: 'welcome',
  rule: 'rules', guidelines: 'rules', info: 'rules',
  log: 'logs', modlog: 'logs', 'mod-log': 'logs', 'mod-logs': 'logs', modlogs: 'logs', audit: 'logs', staff: 'logs',
  chat: 'general', main: 'general', lounge: 'general',
  announce: 'announcements', announcement: 'announcements', news: 'announcements', updates: 'announcements',
  role: 'roles', 'self-roles': 'roles', 'get-roles': 'roles',
  verification: 'verify', verified: 'verify', gate: 'verify',
};

const STEPS = ['preset', 'channels', 'apps', 'staff', 'perms', 'review'];
const STEP_TITLES = { preset: 'What kind of server is this?', channels: 'Channels', apps: 'Apps to install', staff: 'Staff roles', perms: 'Permission check', review: 'Review and boot' };

const APP_NEEDS = {
  mod: ['kick_members', 'ban_members', 'timeout_members', 'manage_messages'],
  automod: ['manage_messages', 'timeout_members'],
  welcome: ['manage_roles'],
  roles: ['manage_roles'],
  levels: ['manage_roles'],
  tickets: ['manage_channels'],
  voice: ['manage_channels'],
  tools: ['manage_messages'],
  engage: ['manage_messages'],
};
const ADMIN_PERMS = ['administrator', 'manage_server'];
const MOD_PERMS = ['kick_members', 'ban_members', 'timeout_members', 'manage_messages'];

const actives = new WeakMap();
function activeMap(engine) {
  let m = actives.get(engine);
  if (!m) { m = new Map(); actives.set(engine, m); }
  return m;
}
const activeKey = (sid, uid) => `${sid}:${uid}`;

function findPreset(text) {
  const n = normalizeName(text);
  if (!n) return null;
  const direct = PRESETS.find((p) => p.id === n || normalizeName(p.label) === n);
  if (direct) return direct;
  const alias = PRESET_ALIASES[n];
  if (alias) return PRESETS.find((p) => p.id === alias);
  const guess = didYouMean(n, PRESETS.map((p) => p.id), { limit: 1, max: 2 });
  return guess.length ? PRESETS.find((p) => p.id === guess[0]) : null;
}

function findSlot(text) {
  const n = normalizeName(text);
  if (!n) return null;
  const direct = SLOTS.find((s) => s.id === n);
  if (direct) return direct;
  const alias = SLOT_ALIASES[n];
  if (alias) return SLOTS.find((s) => s.id === alias);
  const guess = didYouMean(n, SLOTS.map((s) => s.id), { limit: 1, max: 2 });
  return guess.length ? SLOTS.find((s) => s.id === guess[0]) : null;
}

const presetLabel = (id) => {
  const p = PRESETS.find((x) => x.id === id);
  return p ? `${p.emoji} ${p.label}` : 'not picked yet';
};

function installable(engine) {
  return engine.apps.list().filter((a) => !a.meta.core && a.meta.id !== ID);
}

function needsOf(app) {
  const own = app.def.botPerms || app.def.needs;
  return Array.isArray(own) ? own : APP_NEEDS[app.meta.id] || [];
}

function presetFor(app, preset) {
  const p = app.def.presets?.[preset];
  return p && typeof p === 'object' ? p : null;
}

function computeApps(engine, s) {
  const out = {};
  for (const a of installable(engine)) {
    const p = presetFor(a, s.preset);
    out[a.meta.id] = typeof p?.enabled === 'boolean' ? p.enabled : engine.settings.isEnabled(s.sid, a.meta.id);
  }
  s.apps = out;
}

const chName = (channels, id) => {
  const c = channels.find((x) => x.id === id);
  return c ? `<#${c.id}> (#${c.name})` : null;
};

async function newSession(ctx, extra = {}) {
  const { engine, serverId: sid } = ctx;
  const detected = await engine.detectChannels(sid).catch(() => ({}));
  const saved = ctx.store.server({}).channels || {};
  const core = ctx.core();
  const channels = {};
  for (const slot of SLOTS) {
    if (Object.hasOwn(saved, slot.id)) channels[slot.id] = saved[slot.id] || null;
    else channels[slot.id] = detected[slot.id]?.id || null;
  }
  if (core.logChannel && !Object.hasOwn(saved, 'logs')) channels.logs = core.logChannel;
  const extras = {};
  for (const [slot, c] of Object.entries(detected)) if (!SLOTS.some((x) => x.id === slot) && c?.id) extras[slot] = c.id;
  const s = {
    kind: 'setup', sid, userId: ctx.userId, step: 'preset', preset: core.preset || null,
    channels, detected: Object.fromEntries(Object.entries(detected).map(([k, c]) => [k, c?.id || null])), extras,
    apps: {}, modRoles: [...(core.modRoles || [])], warnings: [], ...extra,
  };
  computeApps(engine, s);
  s.id = engine.router.session(s, PANEL_TTL_MS);
  const map = activeMap(engine);
  for (const [k, id] of map) if (!engine.router.getSession(id)) map.delete(k);
  map.set(activeKey(sid, ctx.userId), s.id);
  return s;
}

function activeSession(ctx) {
  const map = activeMap(ctx.engine);
  const key = activeKey(ctx.serverId, ctx.userId);
  const id = map.get(key);
  const s = id ? ctx.engine.router.getSession(id) : null;
  if (s?.kind === 'setup' && s.userId === ctx.userId && s.sid === ctx.serverId) return s;
  map.delete(key);
  return null;
}

function endSession(engine, s) {
  engine.router.dropSession(s.id);
  const map = activeMap(engine);
  if (map.get(activeKey(s.sid, s.userId)) === s.id) map.delete(activeKey(s.sid, s.userId));
}

const stepHeader = (step) => `**Step ${STEPS.indexOf(step) + 1} of ${STEPS.length}: ${STEP_TITLES[step]}**`;

function navRow(s, { back = true, next = true, nextLabel = 'Next' } = {}) {
  const i = STEPS.indexOf(s.step);
  return row(
    back && i > 0 ? button('Back', cid('step', s.id, STEPS[i - 1]), 'secondary', '⬅️') : null,
    next && i < STEPS.length - 1 ? button(nextLabel, cid('step', s.id, STEPS[i + 1]), 'primary', '➡️') : null,
    button('Cancel', cid('cancel', s.id), 'secondary', '✖️'),
  );
}

function presetView(ctx, s) {
  const server = s.serverName ? `**${s.serverName}**` : 'your server';
  const lines = PRESETS.map((p) => `${p.emoji} **${p.label}**: ${p.blurb}`);
  const body = [
    `Hi! Let's get YapOS running on ${server}. It takes about a minute.`,
    'Nothing is posted and nothing changes until you press **Boot** at the end.',
    '',
    stepHeader('preset'),
    ...lines,
    s.preset ? `\nCurrent pick: **${presetLabel(s.preset)}**` : '',
  ].join('\n');
  const embeds = [card({ title: `${ICONS.setup} First boot`, body, color: 'setup', footer: 'Tip: type /setup preset gaming to skip ahead' })];
  const options = PRESETS.map((p) => ({ label: p.label, value: p.id, emoji: p.emoji, description: p.blurb, default: p.id === s.preset }));
  const buttons = PRESETS.map((p) => button(p.label, cid('preset', s.id, p.id), p.id === s.preset ? 'success' : 'secondary', p.emoji));
  const tail = row(s.preset ? button('Keep this and continue', cid('step', s.id, 'channels'), 'primary', '➡️') : null, button('Cancel', cid('cancel', s.id), 'secondary', '✖️'));
  return {
    embeds,
    components: [select(cid('preset', s.id), options, { placeholder: 'Pick a server type' }), tail],
    fallback: [...rows(buttons), tail],
  };
}

async function channelsView(ctx, s) {
  const channels = await ctx.channels('text');
  const lines = SLOTS.map((slot) => {
    const name = s.channels[slot.id] ? chName(channels, s.channels[slot.id]) : null;
    const tag = name && s.detected[slot.id] === s.channels[slot.id] ? ' *(found it)*' : '';
    return `${slot.emoji} **${slot.label}**: ${name ? `${name}${tag}` : '*skipped*'}\n-# ${slot.hint}`;
  });
  const body = [stepHeader('channels'), 'I looked through your channels. Press a button to change one, or skip it.', '', ...lines].join('\n');
  const slotButtons = SLOTS.map((slot) => button(slot.label, cid('slot', s.id, slot.id), s.channels[slot.id] ? 'secondary' : 'primary', slot.emoji));
  return {
    embeds: [card({ title: `${ICONS.setup} First boot`, body, color: 'setup', footer: 'Or type: /setup channel logs #mod-log' })],
    components: [...rows(slotButtons), navRow(s)],
  };
}

async function slotView(ctx, s, slotId) {
  const slot = SLOTS.find((x) => x.id === slotId);
  const channels = await ctx.channels('text');
  const current = s.channels[slot.id];
  const body = [
    `${slot.emoji} **${slot.label} channel**: ${slot.hint}.`,
    `Right now: ${current ? chName(channels, current) || 'a channel I can no longer see' : '*skipped*'}`,
    '',
    channels.length > 15 ? `Not in the list? Type \`/setup channel ${slot.id} #channel-name\`.` : `You can also type \`/setup channel ${slot.id} #channel-name\`.`,
  ].join('\n');
  const tail = row(
    button('Skip this one', cid('skipch', s.id, slot.id), 'secondary', '⏭️'),
    button('Back to channels', cid('step', s.id, 'channels'), 'secondary', '⬅️'),
  );
  const options = channels.slice(0, 25).map((c) => ({ label: `#${c.name}`, value: c.id, default: c.id === current }));
  const buttons = channels.slice(0, 15).map((c) => button(`#${c.name}`, cid('pickch', s.id, slot.id, c.id), c.id === current ? 'success' : 'secondary'));
  const embeds = [card({ title: `${ICONS.setup} Pick the ${slot.label.toLowerCase()} channel`, body, color: 'setup' })];
  if (!channels.length) return { embeds: [card({ title: `${ICONS.setup} No text channels`, body: "I can't see any text channels. Check that my role can view them, then come back.", color: 'warn' })], components: [tail] };
  return {
    embeds,
    components: [select(cid('pickch', s.id, slot.id), options, { placeholder: `Pick the ${slot.label.toLowerCase()} channel` }), tail],
    fallback: [...rows(buttons).slice(0, 3), tail],
  };
}

function appsView(ctx, s) {
  const list = installable(ctx.engine);
  const shown = list.slice(0, 20);
  const lines = shown.map((a) => `${s.apps[a.meta.id] ? '🟢' : '⚪'} ${a.meta.icon} **${a.meta.name}**: ${a.meta.description}`);
  const hasPresets = list.some((a) => presetFor(a, s.preset));
  const body = [
    stepHeader('apps'),
    list.length
      ? `${hasPresets ? `I picked these for a **${presetLabel(s.preset)}** server.` : 'Pick the apps you want.'} Press an app to switch it on or off.`
      : 'No other apps are installed in this copy of YapOS yet, so there is nothing to pick here.',
    '',
    ...lines,
    list.length > shown.length ? `\n-# ${list.length - shown.length} more apps can be switched on later with **/apps**.` : '',
  ].join('\n');
  const toggles = shown.map((a) => button(a.meta.name, cid('app', s.id, a.meta.id), s.apps[a.meta.id] ? 'success' : 'secondary', a.meta.icon));
  return {
    embeds: [card({ title: `${ICONS.setup} First boot`, body, color: 'setup', footer: '🟢 on · ⚪ off' })],
    components: [...rows(toggles).slice(0, 4), navRow(s)],
  };
}

async function botRoleIds(engine, sid) {
  const m = await engine.perms.member(sid, engine.bot.me?.id).catch(() => null);
  return new Set(m?.roles || []);
}

const isEveryone = (r, sid) => /^@?everyone$/i.test(r.name) || r.id === 'everyone' || r.id === sid;
const hasAny = (r, keys) => keys.some((k) => r.perms?.[k]);

async function staffInfo(ctx) {
  const { engine, serverId: sid } = ctx;
  const roles = await ctx.roles().catch(() => []);
  const mine = await botRoleIds(engine, sid);
  const people = roles.filter((r) => !mine.has(r.id) && !isEveryone(r, sid));
  const admins = people.filter((r) => hasAny(r, ADMIN_PERMS));
  const mods = people.filter((r) => !hasAny(r, ADMIN_PERMS) && hasAny(r, MOD_PERMS));
  const others = people.filter((r) => !hasAny(r, ADMIN_PERMS) && !hasAny(r, MOD_PERMS) && !(r.auto && r.auto !== 'none'));
  return { roles, admins, mods, others };
}

async function staffView(ctx, s) {
  const { admins, mods, others, roles } = await staffInfo(ctx);
  const names = (list) => list.map((r) => `**@${r.name}**`).join(', ') || '*none found*';
  const extra = s.modRoles.map((id) => roles.find((r) => r.id === id)).filter(Boolean);
  const body = [
    stepHeader('staff'),
    'People with these roles can use YapOS staff tools.',
    '',
    `👑 **Admins** (from permissions): ${names(admins)}`,
    `🛡️ **Mods** (from permissions): ${names(mods)}`,
    `➕ **Extra mod roles**: ${extra.length ? names(extra) : '*none*'}`,
    '',
    others.length ? 'Want another role to count as mod (like **Helper**)? Press it below.' : 'Every role already counts as staff or is handed out automatically.',
  ].join('\n');
  const toggles = others.slice(0, 15).map((r) => button(`@${r.name}`, cid('modrole', s.id, r.id), s.modRoles.includes(r.id) ? 'success' : 'secondary'));
  return {
    embeds: [card({ title: `${ICONS.setup} First boot`, body, color: 'setup', footer: 'Green roles are extra mod roles' })],
    components: [...rows(toggles).slice(0, 3), navRow(s)],
  };
}

async function permissionChecks(ctx, s) {
  const { engine, serverId: sid } = ctx;
  const botId = engine.bot.me?.id;
  engine.perms.invalidate(`r:${sid}`);
  engine.perms.invalidate(`m:${sid}:${botId}`);
  const chosen = installable(engine).filter((a) => s.apps[a.meta.id]);
  const neededBy = new Map();
  for (const a of chosen) for (const p of needsOf(a)) neededBy.set(p, [...(neededBy.get(p) || []), a.meta.name]);
  const botRole = await engine.perms.botRoleName(sid).catch(() => 'YapOS');
  const items = [];
  const warnings = [];
  for (const [perm, apps] of neededBy) {
    const res = await engine.perms.botCan(sid, perm).catch(() => ({ ok: true, unknown: true }));
    if (res.unknown) {
      items.push(`⚪ **${permName(perm)}**: I couldn't read my own permissions. Each app will tell you if it's missing.`);
    } else if (res.ok) {
      items.push(`✅ **${permName(perm)}**`);
    } else {
      const fix = `Server settings → Roles → **${botRole}** → turn on **${permName(perm)}**`;
      items.push(`❌ **${permName(perm)}**: needed by ${apps.join(', ')}\n-# Fix: ${fix}`);
      warnings.push(`${permName(perm)} is off (${apps.join(', ')})`);
    }
  }
  if (neededBy.has('manage_roles')) {
    const { roles } = await staffInfo(ctx);
    const top = await engine.perms.topPosition(sid, botId).catch(() => -1);
    const mine = await botRoleIds(engine, sid);
    if (top < 0) {
      items.push(`❌ **Role position**: I don't have a role yet.\n-# Fix: give me a role in Server settings → Roles, then drag it near the top.`);
      warnings.push('YapOS has no role');
    } else {
      const blocking = roles
        .filter((r) => !mine.has(r.id) && !isEveryone(r, sid) && !hasAny(r, ['administrator']) && !(r.auto && r.auto !== 'none') && typeof r.position === 'number' && r.position >= top)
        .sort((a, b) => b.position - a.position);
      if (blocking.length) {
        const list = blocking.slice(0, 3).map((r) => `@${r.name}`).join(', ');
        items.push(`❌ **Role position**: my role is below ${list}, so I can't hand those out.\n-# Fix: Drag **${botRole}** above **@${blocking[0].name}** in Server settings → Roles`);
        warnings.push(`Drag ${botRole} above @${blocking[0].name}`);
      } else {
        items.push('✅ **Role position**: my role is high enough to hand out your roles');
      }
    }
  }
  return { items, warnings, botRole };
}

async function permsView(ctx, s) {
  const { items, warnings } = await permissionChecks(ctx, s);
  s.warnings = warnings;
  const body = [
    stepHeader('perms'),
    items.length ? 'Here is what your chosen apps need from my role:' : 'The apps you picked need no special permissions. 🎉',
    '',
    ...items,
    '',
    warnings.length ? `${ICONS.warn} You can boot anyway. Fix these when you can, then press **Check again**.` : items.length ? '✅ All good.' : '',
  ].join('\n');
  return {
    embeds: [card({ title: `${ICONS.setup} First boot`, body, color: warnings.length ? 'warn' : 'setup' })],
    components: [row(
      button('Back', cid('step', s.id, 'staff'), 'secondary', '⬅️'),
      button('Check again', cid('recheck', s.id), 'secondary', '🔄'),
      button('Next', cid('step', s.id, 'review'), 'primary', '➡️'),
      button('Cancel', cid('cancel', s.id), 'secondary', '✖️'),
    )],
  };
}

async function reviewView(ctx, s) {
  const channels = await ctx.channels('text');
  const roles = await ctx.roles().catch(() => []);
  const on = installable(ctx.engine).filter((a) => s.apps[a.meta.id]);
  const chLines = SLOTS.filter((slot) => s.channels[slot.id]).map((slot) => `${slot.emoji} ${slot.label}: ${chName(channels, s.channels[slot.id]) || 'unknown channel'}`);
  const modNames = s.modRoles.map((id) => roles.find((r) => r.id === id)?.name).filter(Boolean).map((n) => `@${n}`);
  const fields = [
    { name: 'Server type', value: presetLabel(s.preset), inline: true },
    { name: 'Extra mod roles', value: modNames.join(', ') || 'none', inline: true },
    { name: 'Apps to install', value: on.map((a) => `${a.meta.icon} ${a.meta.name}`).join('\n') || 'none', inline: false },
    { name: 'Channels', value: chLines.join('\n') || 'none picked', inline: false },
  ];
  if (s.warnings.length) fields.push({ name: `${ICONS.warn} Permission notes`, value: s.warnings.map((w) => `• ${w}`).join('\n'), inline: false });
  return {
    embeds: [card({ title: `${ICONS.setup} First boot`, body: `${stepHeader('review')}\nLooks good? Press **Boot** to apply it. You can undo right after.`, fields, color: 'setup' })],
    components: [row(
      button('Back', cid('step', s.id, 'perms'), 'secondary', '⬅️'),
      button('Boot', cid('boot', s.id), 'success', '🚀'),
      button('Cancel', cid('cancel', s.id), 'secondary', '✖️'),
    )],
  };
}

async function viewFor(ctx, s) {
  if (s.step === 'channels') return channelsView(ctx, s);
  if (s.step === 'apps') return appsView(ctx, s);
  if (s.step === 'staff') return staffView(ctx, s);
  if (s.step === 'perms') return permsView(ctx, s);
  if (s.step === 'review') return reviewView(ctx, s);
  return presetView(ctx, s);
}

async function show(ctx, view, how = 'update') {
  const { fallback, ...main } = view;
  const send = (p) => (how === 'update' ? ctx.update(p) : ctx.ephemeral({ ...p, ttl: PANEL_TTL_MS }));
  if (!fallback) return send(main);
  return ctx.engine.caps.attempt(ctx.serverId, 'selects', () => send(main), () => send({ ...main, components: fallback }));
}

async function render(ctx, s, how = 'update', note) {
  const view = await viewFor(ctx, s);
  view.content = note || '';
  return show(ctx, view, how);
}

async function serverName(ctx) {
  const srv = await ctx.engine.perms.server(ctx.serverId).catch(() => null);
  return srv?.name || null;
}

async function startWizard(ctx, how = 'ephemeral') {
  const s = await newSession(ctx, { serverName: await serverName(ctx) });
  return render(ctx, s, how);
}

async function statusView(ctx) {
  const { engine, serverId: sid } = ctx;
  const core = ctx.core();
  const channels = await ctx.channels('text').catch(() => []);
  const roles = await ctx.roles().catch(() => []);
  const saved = ctx.store.server({}).channels || {};
  const on = installable(engine).filter((a) => engine.settings.isEnabled(sid, a.meta.id));
  const chLines = SLOTS.filter((slot) => saved[slot.id] || (slot.id === 'logs' && core.logChannel))
    .map((slot) => `${slot.emoji} ${slot.label}: ${chName(channels, saved[slot.id] || core.logChannel) || 'a channel I can no longer see'}`);
  const modNames = (core.modRoles || []).map((id) => roles.find((r) => r.id === id)?.name).filter(Boolean).map((n) => `@${n}`);
  const fields = [
    { name: 'First boot', value: core.setupDone ? '✅ done' : '⏳ not yet', inline: true },
    { name: 'Server type', value: presetLabel(core.preset), inline: true },
    { name: 'Extra mod roles', value: modNames.join(', ') || 'none', inline: true },
    { name: 'Installed apps', value: on.map((a) => `${a.meta.icon} ${a.meta.name}`).join('\n') || 'none', inline: false },
    { name: 'Channels', value: chLines.join('\n') || 'none set', inline: false },
  ];
  const body = core.setupDone ? 'YapOS is set up here. Run the wizard again to change things, or reset everything.' : 'First boot has not run yet. Press **Start setup** to begin.';
  return {
    embeds: [card({ title: `${ICONS.setup} Setup`, body, fields, color: 'setup' })],
    components: [row(
      button(core.setupDone ? 'Run again' : 'Start setup', cid('again'), 'primary', '🔁'),
      core.setupDone ? button('Reset to defaults', cid('reset'), 'danger', '🧹') : null,
      button('Open menu', cid('menu'), 'secondary', ICONS.system),
    )],
  };
}

function resetConfirmView() {
  return {
    embeds: [dialog.warn('Reset YapOS to defaults?', 'This turns every app back to its default, clears app settings, staff roles and channels, and marks first boot as not done.\nYou get an **Undo** button right after.')],
    components: [row(
      button('Yes, reset', cid('resetyes'), 'danger', '🧹'),
      button('Keep my settings', cid('resetno'), 'secondary'),
    )],
  };
}

function snapshot(ctx) {
  return { settings: ctx.engine.settings.raw(ctx.serverId), mine: ctx.store.server(null) };
}

function restore(ctx, snap) {
  ctx.engine.store.set('settings', ctx.serverId, snap.settings || { core: {}, apps: {} });
  if (snap.mine === null || snap.mine === undefined) ctx.store.delete(ctx.serverId);
  else ctx.store.set(ctx.serverId, snap.mine);
}

function undoButton(ctx, label, snap, after) {
  const u = ctx.engine.router.addUndo({
    serverId: ctx.serverId, actorId: ctx.userId, label, perm: 'admin',
    run: async (i) => {
      await ctx.engine.perms.require(ctx.serverId, i.user_id, 'admin');
      if (!ctx.engine.settings.isEnabled(ctx.serverId, ID)) {
        await i.ephemeral('', { embeds: [dialog.warn("Setup isn't installed here", 'Nothing was undone. An admin can install Setup again with **/apps**.')] });
        return;
      }
      restore(ctx, snap);
      await i.ephemeral('', { embeds: [dialog.ok('Undone', after)] });
    },
  });
  return u.button;
}

function reasonOf(e) {
  const { body } = explain(e, { action: 'finish setting up' });
  return clip(String(body).split('\n')[0], 200);
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((resolve) => { timer = setTimeout(() => resolve({ timedOut: true }), ms); timer.unref?.(); }),
  ]);
}

async function channelObjects(ctx, s) {
  const all = await ctx.channels('text').catch(() => []);
  const out = {};
  for (const [slot, id] of Object.entries({ ...s.extras, ...s.channels })) {
    const c = id && all.find((x) => x.id === id);
    if (c) out[slot] = c;
  }
  return out;
}

async function boot(ctx, s) {
  const { engine, serverId: sid } = ctx;
  const lines = [];
  const list = installable(engine);
  const on = [];
  const off = [];
  for (const a of list) {
    const want = !!s.apps[a.meta.id];
    engine.settings.setEnabled(sid, a.meta.id, want);
    (want ? on : off).push(a);
  }
  engine.settings.patchCore(sid, { preset: s.preset || 'custom', logChannel: s.channels.logs || null, modRoles: [...s.modRoles], setupDone: true });
  ctx.store.updateServer((d) => ({ ...(d || {}), channels: { ...s.channels }, bootedAt: Date.now(), bootedBy: ctx.userId }), {});
  lines.push(`🏷️ Server type: **${presetLabel(s.preset || 'custom')}**`);
  lines.push(on.length ? `🧩 Installed: ${on.map((a) => `${a.meta.icon} ${a.meta.name}`).join(', ')}` : '🧩 No extra apps installed');
  if (off.length) lines.push(`⚪ Left off: ${off.map((a) => a.meta.name).join(', ')}`);
  lines.push(s.channels.logs ? `🗂️ Staff log goes to <#${s.channels.logs}>` : '🗂️ No log channel, so staff actions are not logged');
  if (s.modRoles.length) lines.push(`🛡️ ${s.modRoles.length} extra mod role${s.modRoles.length === 1 ? '' : 's'} saved`);
  const channels = await channelObjects(ctx, s);
  for (const a of on) {
    const p = presetFor(a, s.preset);
    if (p?.config && typeof p.config === 'object') engine.settings.patchApp(sid, a.meta.id, p.config);
    if (typeof a.def.applyPreset === 'function') {
      try {
        const out = await withTimeout(a.def.applyPreset(engine, sid, { preset: s.preset, channels }), PRESET_TIMEOUT_MS);
        if (out?.timedOut) lines.push(`${a.meta.icon} ${a.meta.name} is still setting up in the background.`);
        else {
          const got = [].concat(out ?? []).filter((x) => typeof x === 'string' && x.trim());
          if (got.length) for (const l of got) lines.push(`${a.meta.icon} ${l}`);
          else if (p?.config) lines.push(`${a.meta.icon} ${a.meta.name}: preset settings applied`);
        }
      } catch (e) {
        engine.log.warn(`[setup] ${a.meta.id} applyPreset failed:`, e?.message || e);
        lines.push(`${ICONS.warn} ${a.meta.name} couldn't finish its part: ${reasonOf(e)} You can set it up from its panel.`);
      }
    } else if (p?.config) {
      lines.push(`${a.meta.icon} ${a.meta.name}: preset settings applied`);
    }
  }
  if (s.warnings.length) lines.push(`${ICONS.warn} Still to fix: ${s.warnings.join('; ')}`);
  return lines;
}

const adminOnly = (fn) => ({
  perm: 'admin',
  run: async (ctx) => {
    await ctx.require('admin');
    return fn(ctx);
  },
});

const wiz = (fn) => ({
  perm: 'admin',
  run: async (ctx) => {
    await ctx.require('admin');
    const s = ctx.engine.router.getSession(ctx.argv[0]);
    if (!s || s.kind !== 'setup') return ctx.warn('This setup panel expired', 'Run **/setup** again to start fresh.');
    if (s.userId !== ctx.userId || s.sid !== ctx.serverId) return ctx.warn("That's someone else's setup", 'Run **/setup** to open your own.');
    return fn(ctx, s);
  },
});

async function openMenu(ctx) {
  const menu = ctx.engine.bot.commands?.get?.('menu');
  if (typeof menu?.fn === 'function' && ctx.source?.custom_id) {
    try { return await menu.fn(ctx.source); } catch (e) { ctx.engine.log.debug('[setup] menu shortcut failed', e?.message); }
  }
  return ctx.info('Open the home screen', 'Type **/menu** to see every installed app.');
}

async function presetShortcut(ctx, rest) {
  const wanted = rest.join(' ');
  if (!wanted) {
    const s = activeSession(ctx) || await newSession(ctx, { serverName: await serverName(ctx) });
    s.step = 'preset';
    return render(ctx, s, 'ephemeral');
  }
  const p = findPreset(wanted);
  if (!p) return ctx.warn("I don't know that server type", `Try one of: ${PRESETS.map((x) => `**${x.id}**`).join(', ')}.\nExample: \`/setup preset gaming\``);
  const s = activeSession(ctx) || await newSession(ctx, { serverName: await serverName(ctx) });
  s.preset = p.id;
  computeApps(ctx.engine, s);
  s.step = 'channels';
  return render(ctx, s, 'ephemeral', `${ICONS.ok} Server type set to **${p.label}**. Next, check your channels.`);
}

async function channelShortcut(ctx, rest) {
  const [slotWord, ...chWords] = rest;
  const usage = 'Example: `/setup channel logs #mod-log`. Use `none` to skip one.';
  if (!slotWord) return ctx.info('Which channel?', `Slots: ${SLOTS.map((x) => `**${x.id}**`).join(', ')}.\n${usage}`);
  const slot = findSlot(slotWord);
  if (!slot) return ctx.warn(`I don't know the "${clip(slotWord, 30)}" slot`, `Slots: ${SLOTS.map((x) => `**${x.id}**`).join(', ')}.\n${usage}`);
  const token = chWords.join(' ').trim();
  if (!token) return ctx.info(`Which channel for ${slot.label.toLowerCase()}?`, usage.replace('logs', slot.id));
  let channel = null;
  if (!/^(none|off|skip|clear|remove|no)$/i.test(token)) {
    const all = await ctx.channels('text');
    channel = resolveChannel(token, all);
    if (!channel) return ctx.warn("I couldn't find that channel", `No text channel matches **${clip(token, 40)}**. Mention it like #mod-log.`);
  }
  const snap = snapshot(ctx);
  const s = activeSession(ctx);
  if (s) s.channels[slot.id] = channel?.id || null;
  ctx.store.updateServer((d) => ({ ...(d || {}), channels: { ...((d || {}).channels || {}), [slot.id]: channel?.id || null } }), {});
  const core = ctx.core();
  if (slot.id === 'logs' && core.setupDone) ctx.engine.settings.patchCore(ctx.serverId, { logChannel: channel?.id || null });
  const what = channel ? `**${slot.label}** channel is now <#${channel.id}>.` : `**${slot.label}** channel is now skipped.`;
  const tail = core.setupDone ? '' : '\nRun **/setup** to finish first boot.';
  const comps = [undoButton(ctx, `${slot.label.toLowerCase()} channel`, snap, `The ${slot.label.toLowerCase()} channel is back to how it was.`)];
  if (s) comps.unshift(button('Back to setup', cid('step', s.id, 'channels'), 'primary', '⬅️'));
  return ctx.ok('Saved', `${what}${tail}`, { components: [row(comps)], ttl: NOTE_TTL_MS });
}

async function runSetup(ctx) {
  await ctx.require('admin');
  const [first, ...rest] = ctx.argv;
  const word = normalizeName(first);
  if (!word) {
    if (ctx.core().setupDone) return ctx.ephemeral({ ...(await statusView(ctx)), ttl: PANEL_TTL_MS });
    return startWizard(ctx);
  }
  if (['status', 'info', 'show', 'config', 'current', 'settings'].includes(word)) return ctx.ephemeral({ ...(await statusView(ctx)), ttl: PANEL_TTL_MS });
  if (['preset', 'presets', 'type', 'template', 'mode', 'kind'].includes(word)) return presetShortcut(ctx, rest);
  if (['channel', 'channels', 'ch', 'chan', 'set'].includes(word)) return channelShortcut(ctx, rest);
  if (['start', 'again', 'run', 'rerun', 'boot', 'wizard', 'new', 'restart', 'begin'].includes(word)) return startWizard(ctx);
  if (['reset', 'defaults', 'wipe'].includes(word)) return ctx.ephemeral({ ...resetConfirmView(), ttl: PANEL_TTL_MS });
  if (rest.length && (SLOTS.some((x) => x.id === word) || SLOT_ALIASES[word])) return channelShortcut(ctx, [first, ...rest]);
  const p = PRESETS.find((x) => x.id === word) || (PRESET_ALIASES[word] && findPreset(word));
  if (p) return presetShortcut(ctx, [p.id]);
  const guess = didYouMean(word, ['status', 'preset', 'channel', 'start', 'reset', ...PRESETS.map((x) => x.id)]);
  return ctx.warn("I didn't get that", `I don't know **${clip(first, 30)}**.${guess.length ? ` Did you mean ${guess.map((g) => `**${g}**`).join(', ')}?` : ''}\nTry \`/setup\`, \`/setup status\`, \`/setup preset gaming\` or \`/setup channel logs #mod-log\`.`);
}

export const { setup, teardown, check } = defineApp({
  id: ID,
  name: 'Setup',
  icon: ICONS.setup,
  description: 'First boot wizard: presets, channels, apps, staff.',
  category: 'System',
  core: false,
  defaultEnabled: true,

  commands: {
    setup: {
      description: 'First boot wizard (admins). Also: /setup status, /setup preset gaming, /setup channel logs #mod-log',
      perm: 'admin',
      run: runSetup,
    },
  },

  components: {
    preset: wiz(async (ctx, s) => {
      const p = findPreset(ctx.values?.[0] ?? ctx.argv[1]);
      if (!p) return ctx.warn('Pick a server type', 'That choice did not come through. Try again.');
      s.preset = p.id;
      computeApps(ctx.engine, s);
      s.step = 'channels';
      return render(ctx, s);
    }),
    step: wiz(async (ctx, s) => {
      const step = ctx.argv[1];
      if (!STEPS.includes(step)) return ctx.warn('Unknown step', 'Run **/setup** again.');
      if (step !== 'preset' && !s.preset) { s.step = 'preset'; return render(ctx, s, 'update', 'Pick a server type first.'); }
      s.step = step;
      return render(ctx, s);
    }),
    recheck: wiz(async (ctx, s) => { s.step = 'perms'; return render(ctx, s, 'update', '🔄 Checked again just now.'); }),
    slot: wiz(async (ctx, s) => {
      const slot = SLOTS.find((x) => x.id === ctx.argv[1]);
      if (!slot) return ctx.warn('Unknown channel slot', 'Open the channels step again.');
      return show(ctx, await slotView(ctx, s, slot.id));
    }),
    pickch: wiz(async (ctx, s) => {
      const slot = SLOTS.find((x) => x.id === ctx.argv[1]);
      const chId = ctx.values?.[0] ?? ctx.argv[2];
      const channels = await ctx.channels('text');
      const c = channels.find((x) => x.id === chId);
      if (!slot || !c) return ctx.warn("I couldn't use that channel", 'It may have been deleted. Pick another one.');
      s.channels[slot.id] = c.id;
      s.step = 'channels';
      return render(ctx, s, 'update', `${ICONS.ok} ${slot.label}: #${c.name}`);
    }),
    skipch: wiz(async (ctx, s) => {
      const slot = SLOTS.find((x) => x.id === ctx.argv[1]);
      if (slot) s.channels[slot.id] = null;
      s.step = 'channels';
      return render(ctx, s, 'update', slot ? `⏭️ Skipped ${slot.label.toLowerCase()}.` : undefined);
    }),
    app: wiz(async (ctx, s) => {
      const id = ctx.argv[1];
      if (!installable(ctx.engine).some((a) => a.meta.id === id)) return ctx.warn('That app is gone', 'It is not installed in this copy of YapOS anymore.');
      s.apps[id] = !s.apps[id];
      s.step = 'apps';
      return render(ctx, s);
    }),
    modrole: wiz(async (ctx, s) => {
      const id = ctx.argv[1];
      const { others } = await staffInfo(ctx);
      if (!s.modRoles.includes(id) && !others.some((r) => r.id === id)) return ctx.warn("I can't use that role", 'It may have been deleted, or it already counts as staff. Open the staff step again.');
      s.modRoles = s.modRoles.includes(id) ? s.modRoles.filter((r) => r !== id) : [...s.modRoles, id];
      s.step = 'staff';
      return render(ctx, s);
    }),
    cancel: wiz(async (ctx, s) => {
      endSession(ctx.engine, s);
      return ctx.update({ embeds: [dialog.info('Setup closed', 'Nothing changed. Run **/setup** any time.')], components: [] });
    }),
    boot: wiz(async (ctx, s) => {
      const snap = snapshot(ctx);
      endSession(ctx.engine, s);
      try {
        await ctx.update({ embeds: [dialog.info('Booting…', 'Applying your choices. This takes a moment.')], components: [] });
      } catch (e) {
        ctx.engine.log.debug('[setup] could not update the boot panel', e?.message);
      }
      const lines = await boot(ctx, s);
      const undo = undoButton(ctx, 'boot', snap, 'Your settings from before this boot are back. Anything apps already posted stays, so remove it by hand if you like.');
      return ctx.ephemeral({
        embeds: [card({ title: `${ICONS.setup} Boot complete`, body: `${lines.join('\n')}\n\n**/menu** shows your apps. Run **/setup** any time to change things.`, color: 'ok' })],
        components: [row(button('Open menu', cid('menu'), 'primary', ICONS.system), undo)],
      });
    }),
    again: adminOnly((ctx) => startWizard(ctx, 'update')),
    reset: adminOnly((ctx) => ctx.update(resetConfirmView())),
    resetno: adminOnly((ctx) => ctx.update({ embeds: [dialog.info('Kept your settings', 'Nothing changed.')], components: [] })),
    resetyes: adminOnly(async (ctx) => {
      const snap = snapshot(ctx);
      const caps = snap.settings?.core?.caps || {};
      ctx.engine.store.set('settings', ctx.serverId, { core: { caps }, apps: {} });
      ctx.store.delete(ctx.serverId);
      const undo = undoButton(ctx, 'reset', snap, 'Your settings from before the reset are back.');
      return ctx.update({
        embeds: [dialog.ok('Reset done', 'Everything is back to defaults. Run **/setup** to boot again.')],
        components: [row(button('Start setup', cid('again'), 'primary', '🔁'), undo)],
      });
    }),
    menu: { run: openMenu },
  },

  yap: [{
    words: ['setup', 'boot', 'preset'],
    run: async (ctx) => {
      await ctx.require('admin');
      if (ctx.word === 'preset') ctx.argv = ['preset', ...ctx.argv];
      return runSetup(ctx);
    },
  }],

  panel: async (ctx) => {
    if (!ctx.serverId) return ctx.warn('Setup works in servers', 'Open it from a server you help run.');
    if (!ctx.engine.perms.atLeast(await ctx.level(), 'admin')) return ctx.warn('Setup is for admins', 'Ask an admin to run **/setup**.');
    return ctx.ephemeral({ ...(await statusView(ctx)), ttl: PANEL_TTL_MS });
  },

  help: [
    '/setup runs the first boot wizard. Nothing is posted until you press Boot.',
    '/setup preset gaming jumps ahead with a server type.',
    '/setup channel logs #mod-log changes one channel.',
    '/setup status shows what is set up now.',
  ],
});
