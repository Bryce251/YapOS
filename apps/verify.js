import { defineApp } from '../engine/apps.js';
import { card, dialog, button, row, rows, select, ICONS } from '../engine/ui.js';
import { customId } from '../engine/router.js';
import { tokenize, didYouMean, clip, fillTemplate } from '../engine/parse.js';
import { friendly, looksLikeFeatureOff, permName, explain } from '../engine/errors.js';
import { accept, reject } from '../engine/dashboard.js';

const ID = 'verify';
const ICON = ICONS.verify || '🛂';
const cid = (action, ...args) => customId(ID, action, ...args);

const METHODS = {
  button: { label: 'Button click', emoji: '👆', blurb: 'One press of **Verify**. Quickest, and stops the simplest bots.' },
  emoji: { label: 'Emoji pick', emoji: '🐱', blurb: 'Press **Verify**, then pick the emoji I name from a few buttons.' },
  math: { label: 'Math question', emoji: '➕', blurb: 'Press **Verify**, then answer a small sum like 4 + 7.' },
  rules: { label: 'Agree to rules', emoji: '📜', blurb: 'Press **Verify**, read the rules and press **I agree**.' },
};
const METHOD_WORDS = { button: 'button', click: 'button', press: 'button', emoji: 'emoji', captcha: 'emoji', pick: 'emoji', math: 'math', sum: 'math', maths: 'math', rules: 'rules', agree: 'rules' };
const AGES = [0, 1, 3, 7, 30];
const MAX_AGE_DAYS = 365;
const EMOJIS = [['🐱', 'cat'], ['🍕', 'pizza'], ['🚗', 'car'], ['🌵', 'cactus'], ['🎈', 'balloon'], ['🍩', 'donut'], ['⚽', 'football'], ['🌙', 'moon'], ['🐢', 'turtle'], ['🍎', 'apple']];
const DEFAULT_WELCOME = 'Welcome in, {user}! You can see the whole server now.';
const DEFAULT_RULES = 'Be kind to each other.\nNo spam, scams or adverts.\nKeep it safe for everyone and follow Yapin\'s rules.';
const ELEVATED_PERMS = ['administrator', 'manage_server', 'manage_roles', 'manage_channels', 'manage_messages', 'manage_webhooks', 'manage_nicknames', 'manage_threads', 'manage_emojis', 'manage_events', 'kick_members', 'ban_members', 'timeout_members', 'move_members', 'mute_members', 'deafen_members', 'mention_everyone'];
const STEPS = ['role', 'unverified', 'channel', 'method', 'age', 'message', 'lock', 'summary'];
const STEP_TITLES = {
  role: 'Verified role', unverified: 'Unverified role (optional)', channel: 'Verify channel', method: 'How people verify',
  age: 'Minimum account age (optional)', message: 'Welcome message', lock: 'Hide channels until verified (optional)', summary: 'Check and finish',
};
const WIZARD_TTL_MS = 15 * 60_000;
const CHALLENGE_TTL_MS = 5 * 60_000;
const MAX_TRIES = 3;
const COOLDOWN_MS = 60_000;
const ALERT_GAP_MS = 10 * 60_000;
const STRIKE_MS = 10 * 60_000;
const MAX_LOCK = 50;
const MAX_TRACKED = 5000;

const DEFAULTS = {
  enabled: false,
  channelId: null,
  roleId: null,
  unverifiedRoleId: null,
  method: 'button',
  minAccountDays: 0,
  welcome: '',
  rulesText: '',
  panelChannelId: null,
  panelMessageId: null,
  legacy: false,
  migrated: false,
};

const own = (table, key) => typeof key === 'string' && Object.hasOwn(table, key);
const now = () => Date.now();
const memories = new WeakMap();

function mem(engine) {
  let m = memories.get(engine);
  if (!m) {
    m = { alertAt: new Map(), cooldown: new Map(), strikes: new Map() };
    memories.set(engine, m);
  }
  return m;
}

function capMap(map) {
  while (map.size > MAX_TRACKED) map.delete(map.keys().next().value);
}

export function migrate(engine, sid) {
  if (!sid) return false;
  const doc = engine.settings.raw(sid) || {};
  const mine = doc.apps?.[ID]?.config;
  if (mine && mine.migrated) return false;
  const old = doc.apps?.automod?.config?.verify;
  const hasOld = old && typeof old === 'object' && (old.enabled === true || old.channelId || old.roleId);
  if (!hasOld) return false;
  if (mine && (mine.channelId || mine.roleId)) {
    engine.settings.patchApp(sid, ID, { migrated: true });
    return false;
  }
  engine.settings.patchApp(sid, ID, {
    enabled: old.enabled === true,
    channelId: typeof old.channelId === 'string' ? old.channelId : null,
    roleId: typeof old.roleId === 'string' ? old.roleId : null,
    method: 'button',
    legacy: true,
    migrated: true,
  });
  return true;
}

function cfgOf(engine, sid) {
  migrate(engine, sid);
  return engine.settings.appConfig(sid, ID);
}

function rawConfig(engine, sid) {
  const c = engine.settings.raw(sid)?.apps?.[ID]?.config;
  return c ? structuredClone(c) : { migrated: true };
}

function riskyRole(engine, sid, role) {
  if (!role) return null;
  const core = engine.settings.core(sid);
  if ([...(core.modRoles || []), ...(core.adminRoles || [])].includes(role.id)) return `**${role.name}** is a mod or admin role here. Everyone who verifies would get it, so pick a plain member role.`;
  const strong = ELEVATED_PERMS.filter((p) => role.perms?.[p] || role[p]);
  if (strong.length) return `**${role.name}** has moderator-level permissions (${strong.slice(0, 3).map(permName).join(', ')}). Everyone who verifies would get them, so pick a plain member role.`;
  return null;
}

const isEveryone = (r, sid) => /^@?everyone$/i.test(r?.name || '') || r?.id === 'everyone' || r?.id === sid;

async function rolesOf(engine, sid) {
  return (await engine.perms.roles(sid).catch(() => [])) || [];
}

async function roleProblem(engine, sid, roleId, { label = 'role' } = {}) {
  if (!roleId) return { reason: `No ${label} is picked yet.`, missing: true };
  const role = (await rolesOf(engine, sid)).find((r) => r.id === roleId);
  if (!role) return { reason: `The ${label} was deleted.`, missing: true };
  const can = await engine.perms.canManageRole(sid, roleId);
  if (!can.ok) return { reason: can.reason, role, position: /above|higher/i.test(can.reason), perm: /Manage Roles/i.test(can.reason) };
  return null;
}

async function gate(engine, sid, cfg) {
  const problem = await roleProblem(engine, sid, cfg.roleId, { label: 'Verified role' });
  if (problem) return { ok: false, kind: 'stuck', reason: problem.reason };
  const role = (await rolesOf(engine, sid)).find((r) => r.id === cfg.roleId);
  const risky = riskyRole(engine, sid, role);
  if (risky) return { ok: false, kind: 'paused', reason: risky, role };
  return { ok: true, role };
}

async function logChannelId(engine, sid) {
  const core = engine.settings.core(sid);
  if (core.logChannel) return core.logChannel;
  const found = await engine.detectChannels(sid).catch(() => ({}));
  return found.logs?.id || null;
}

async function postLog(engine, sid, embed, { content, priority = 'low' } = {}) {
  const mod = engine.service('mod');
  if (mod?.log && !content) {
    try { await mod.log(sid, embed); return true; } catch (e) { engine.log.debug('mod log failed', e?.message); }
  }
  const channelId = await logChannelId(engine, sid);
  if (!channelId) return false;
  try {
    await engine.budget.send({ serverId: sid, channelId, content: content || '', opts: { embeds: [embed] }, priority });
    return true;
  } catch (e) {
    engine.log.warn(`[verify] could not post to the log channel in ${sid}: ${e?.message}`);
    return false;
  }
}

function modPing(engine, sid) {
  return (engine.settings.core(sid).modRoles || []).map((r) => `<@&${r}>`).join(' ');
}

async function alert(engine, sid, kind, embed) {
  const { alertAt } = mem(engine);
  const key = `${sid}:${kind}`;
  const last = alertAt.get(key);
  if (last && now() - last < ALERT_GAP_MS) return;
  alertAt.set(key, now());
  capMap(alertAt);
  await postLog(engine, sid, embed, { content: modPing(engine, sid) || undefined, priority: 'normal' });
}

function clearAlerts(engine, sid) {
  for (const kind of ['stuck', 'paused', 'failed', 'join']) mem(engine).alertAt.delete(`${sid}:${kind}`);
}

async function serverName(engine, sid) {
  const s = await engine.perms.server(sid).catch(() => null);
  return s?.name || 'the server';
}

function methodOf(cfg) {
  return own(METHODS, cfg.method) ? cfg.method : 'button';
}

function ageText(days) {
  return days ? `${days} day${days === 1 ? '' : 's'}` : 'No minimum';
}

async function ageProblem(engine, sid, uid, cfg) {
  const min = Number(cfg.minAccountDays) || 0;
  if (min <= 0) return null;
  const user = await engine.bot.user(uid).catch(() => null);
  const created = Date.parse(user?.created_at || user?.createdAt || '');
  if (!Number.isFinite(created)) return null;
  const ready = created + min * 86_400_000;
  if (ready <= now()) return null;
  return `Accounts have to be at least **${ageText(min)}** old to join here. You can verify <t:${Math.floor(ready / 1000)}:R>.`;
}

function welcomeText(cfg, uid, name, username) {
  const text = String(cfg.welcome || '').trim() || DEFAULT_WELCOME;
  return clip(fillTemplate(text, { user: `<@${uid}>`, username: username || 'friend', server: name }), 1500);
}

function rulesBody(cfg, rulesChannelId) {
  const text = String(cfg.rulesText || '').trim();
  if (text) return clip(text, 1500);
  if (rulesChannelId) return `Please read <#${rulesChannelId}> first.\n\n${DEFAULT_RULES}`;
  return DEFAULT_RULES;
}

function panelView(cfg) {
  const method = methodOf(cfg);
  const lines = {
    button: "Press **Verify** to show you're a real person and unlock the rest of the server.",
    emoji: "Press **Verify**, then pick the emoji I name. It takes a few seconds and shows you're a real person.",
    math: "Press **Verify**, then answer a small sum. It shows you're a real person.",
    rules: 'Press **Verify**, read the rules and press **I agree** to unlock the rest of the server.',
  };
  const min = Number(cfg.minAccountDays) || 0;
  const body = `${lines[method]}${min ? `\n-# Accounts need to be at least ${ageText(min)} old.` : ''}`;
  return { embeds: [card({ title: '✅ Verify to join in', body, color: 'ok' })], components: [row(button('Verify', cid('go'), 'success', '✅'))] };
}

function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function makePuzzle(method) {
  if (method === 'emoji') {
    const picks = shuffle(EMOJIS).slice(0, 4);
    const answer = Math.floor(Math.random() * picks.length);
    return { prompt: `Pick the **${picks[answer][1]}**.`, options: picks.map(([e]) => e), answer };
  }
  if (method === 'math') {
    const a = 1 + Math.floor(Math.random() * 9);
    const b = 1 + Math.floor(Math.random() * 9);
    const right = a + b;
    const wrong = new Set();
    while (wrong.size < 3) {
      const n = right + (Math.floor(Math.random() * 9) - 4);
      if (n !== right && n > 0) wrong.add(n);
    }
    const options = shuffle([right, ...wrong]).map(String);
    return { prompt: `What is **${a} + ${b}**?`, options, answer: options.indexOf(String(right)) };
  }
  if (method === 'rules') return { prompt: null, options: ['I agree'], answer: 0 };
  return { prompt: 'Press the button to finish.', options: ['Verify'], answer: 0 };
}

async function challengeView(engine, sid, uid, cfg, { test = false, sess = null } = {}) {
  const method = methodOf(cfg);
  const puzzle = makePuzzle(method);
  let id = sess;
  const state = id ? engine.router.getSession(id) : null;
  if (state) Object.assign(state, { answer: puzzle.answer });
  else id = engine.router.session({ sid, uid, answer: puzzle.answer, tries: 0, test }, CHALLENGE_TTL_MS);
  const head = test ? `${ICON} Test run: what a new member sees` : `${ICON} Quick check`;
  let body = puzzle.prompt;
  if (method === 'rules') {
    const found = await engine.detectChannels(sid).catch(() => ({}));
    body = `**The rules**\n${rulesBody(cfg, found.rules?.id)}\n\nPress **I agree** to unlock the server.`;
  }
  const styles = method === 'rules' || method === 'button' ? 'success' : 'secondary';
  const answers = puzzle.options.map((label, i) => button(label, cid('ans', uid, id, i), styles, method === 'rules' ? '📜' : undefined));
  const extra = method === 'rules' ? [button("I don't agree", cid('nope', uid, id), 'secondary')] : [];
  return { embeds: [card({ title: head, body: `${body}${test ? '\n-# Test mode: passing gives no role.' : ''}`, color: 'verify' })], components: [row(...answers, ...extra)], ttl: CHALLENGE_TTL_MS };
}

async function say(ctx, how, embed) {
  if (how === 'update') return ctx.update({ embeds: [embed], components: [] });
  return ctx.ephemeral({ embeds: [embed] });
}

async function grant(ctx, cfg, how = 'ephemeral') {
  const { engine, serverId: sid, userId: uid } = ctx;
  const g = await gate(engine, sid, cfg);
  if (!g.ok) {
    await say(ctx, how, dialog.warn("I can't verify you right now", 'A mod has been told. Please try again a bit later.'));
    const body = g.kind === 'paused'
      ? `<@${uid}> tried to verify, but **${g.role.name}** now has moderator-level permissions, so I didn't hand it out. Pick a plain member role with \`/verify setup\`.`
      : `<@${uid}> tried to verify but I can't give the role: ${g.reason}\n-# \`/verify status\` shows how to fix it.`;
    await alert(engine, sid, g.kind, dialog.warn(g.kind === 'paused' ? 'Verification paused' : 'Verification is stuck', body));
    return null;
  }
  try {
    await engine.bot.addRole(sid, uid, cfg.roleId);
  } catch (e) {
    if (looksLikeFeatureOff(e)) engine.caps.mark(sid, 'roles', false, e?.message);
    await say(ctx, how, dialog.warn("I couldn't verify you", 'Something went wrong giving you the role. A mod has been told.'));
    await alert(engine, sid, 'failed', dialog.warn('Verification failed', `I couldn't give **${g.role.name}** to <@${uid}>. Role changes may not be available on this server yet, so please give it by hand.`));
    return null;
  }
  if (cfg.unverifiedRoleId) await engine.bot.removeRole(sid, uid, cfg.unverifiedRoleId).catch((e) => engine.log.debug('could not remove the unverified role', e?.message));
  engine.perms.invalidate(`m:${sid}:${uid}`);
  clearAlerts(engine, sid);
  mem(engine).cooldown.delete(`${sid}:${uid}`);
  mem(engine).strikes.delete(`${sid}:${uid}`);
  postLog(engine, sid, card({ title: `${ICON} Member verified`, body: `<@${uid}> passed the ${METHODS[methodOf(cfg)].label.toLowerCase()} check and got **${g.role.name}**.`, color: 'ok' })).catch(() => {});
  return say(ctx, how, dialog.ok("You're verified", welcomeText(cfg, uid, await serverName(engine, sid), ctx.username)));
}

async function press(ctx) {
  const { engine, serverId: sid, userId: uid } = ctx;
  if (!sid || !uid) return ctx.warn('Verification only works in a server', 'Press the Verify button in the server you want to join.');
  if (!engine.settings.isEnabled(sid, ID)) return ctx.warn("Verify isn't installed here", 'Ask a mod for help getting in.');
  const cfg = cfgOf(engine, sid);
  if (!cfg.enabled || !cfg.roleId) return ctx.warn('Verification is off', 'Ask a mod for help getting in.');
  const member = await engine.perms.member(sid, uid).catch(() => null);
  if (member?.roles?.includes(cfg.roleId)) return ctx.info("You're already verified", 'Enjoy the server!');
  const wait = mem(engine).cooldown.get(`${sid}:${uid}`);
  if (wait && wait > now()) return ctx.warn('Take a short break', `Too many wrong answers. Try again <t:${Math.ceil(wait / 1000)}:R>.`);
  const age = await ageProblem(engine, sid, uid, cfg);
  if (age) {
    postLog(engine, sid, card({ title: `${ICON} Account too new`, body: `<@${uid}> tried to verify, but their account is younger than ${ageText(cfg.minAccountDays)}.`, color: 'warn' })).catch(() => {});
    return ctx.warn('Your account is too new', age);
  }
  if (methodOf(cfg) === 'button') return grant(ctx, cfg);
  const g = await gate(engine, sid, cfg);
  if (!g.ok) return grant(ctx, cfg);
  return ctx.ephemeral(await challengeView(engine, sid, uid, cfg));
}

async function answer(ctx) {
  const { engine, serverId: sid, userId: uid } = ctx;
  const [, sess, pick] = ctx.argv;
  const s = engine.router.getSession(sess);
  if (!s || s.uid !== uid || s.sid !== sid) return say(ctx, 'update', dialog.warn('This check ran out', 'Press **Verify** again for a new one.'));
  const cfg = cfgOf(engine, sid);
  if (String(pick) !== String(s.answer)) {
    s.tries += 1;
    let strikes = 0;
    if (!s.test) {
      const key = `${sid}:${uid}`;
      const prev = mem(engine).strikes.get(key);
      strikes = (prev && now() - prev.at < STRIKE_MS ? prev.n : 0) + 1;
      mem(engine).strikes.set(key, { n: strikes, at: now() });
      capMap(mem(engine).strikes);
    }
    if (s.tries >= MAX_TRIES || strikes >= MAX_TRIES) {
      engine.router.dropSession(sess);
      mem(engine).strikes.delete(`${sid}:${uid}`);
      if (!s.test) {
        mem(engine).cooldown.set(`${sid}:${uid}`, now() + COOLDOWN_MS);
        capMap(mem(engine).cooldown);
      }
      return say(ctx, 'update', dialog.warn('Not quite', s.test ? 'That was the last try. A member would now wait a minute before trying again.' : 'That was the last try for now. Wait a minute, then press **Verify** again.'));
    }
    const next = await challengeView(engine, sid, uid, cfg, { test: s.test, sess });
    const left = MAX_TRIES - Math.max(s.tries, strikes);
    next.embeds.unshift(dialog.warn('Not quite', `Try again. ${left} ${left === 1 ? 'try' : 'tries'} left.`));
    return ctx.update({ embeds: next.embeds, components: next.components });
  }
  engine.router.dropSession(sess);
  if (s.test) {
    const role = (await rolesOf(engine, sid)).find((r) => r.id === cfg.roleId);
    return say(ctx, 'update', dialog.ok('Test passed', `A member would now get **${role?.name || 'the Verified role'}**${cfg.unverifiedRoleId ? ' and lose the Unverified role' : ''}, then see:\n> ${welcomeText(cfg, uid, await serverName(engine, sid), ctx.username)}`));
  }
  if (!cfg.enabled || !cfg.roleId) return say(ctx, 'update', dialog.warn('Verification is off', 'Ask a mod for help getting in.'));
  return grant(ctx, cfg, 'update');
}

async function decline(ctx) {
  const [, sess] = ctx.argv;
  ctx.engine.router.dropSession(sess);
  return say(ctx, 'update', dialog.info('No problem', 'You can press **Verify** again whenever you are ready.'));
}

function show(ctx, view) {
  if (ctx.kind === 'button' || ctx.kind === 'select') return ctx.update(view);
  return ctx.ephemeral({ ...view, ttl: view.ttl ?? WIZARD_TTL_MS });
}

function showPicker(ctx, views) {
  if (!views.withButtons) return show(ctx, views.withSelect);
  return ctx.engine.caps.attempt(ctx.serverId, 'selects', () => show(ctx, views.withSelect), () => show(ctx, views.withButtons));
}

async function textChannels(engine, sid) {
  return (await engine.cache.channels(sid).catch(() => [])).filter((c) => c.type === 'text' || c.kind === 'text');
}

async function channelExists(engine, sid, channelId) {
  if (!channelId) return null;
  const list = await textChannels(engine, sid);
  return list.find((c) => c.id === channelId) || null;
}

async function pickableRoles(engine, sid) {
  const all = await rolesOf(engine, sid);
  const botTop = await engine.perms.topPosition(sid, engine.bot.me?.id).catch(() => -1);
  return all
    .filter((r) => !isEveryone(r, sid) && !(r.auto && r.auto !== 'none') && !riskyRole(engine, sid, r) && (typeof r.position !== 'number' || botTop < 0 || r.position < botTop))
    .sort((a, b) => (b.position ?? 0) - (a.position ?? 0))
    .slice(0, 25);
}

function newDraft(engine, ctx, cfg, step, detected) {
  return {
    sid: ctx.serverId, uid: ctx.userId, step,
    roleId: cfg.roleId, unverifiedRoleId: cfg.unverifiedRoleId,
    channelId: cfg.channelId || detected?.verify?.id || null,
    method: methodOf(cfg), minAccountDays: Number(cfg.minAccountDays) || 0,
    welcome: cfg.welcome || '', rulesText: cfg.rulesText || '',
    lock: false, note: null, created: { roles: [], channels: [] },
  };
}

async function startWizard(ctx, step = 'role') {
  await ctx.require('admin');
  const { engine, serverId: sid } = ctx;
  if (!sid) return ctx.warn('Servers only', 'Run **/verify setup** inside the server you want to protect.');
  const cfg = cfgOf(engine, sid);
  const detected = await engine.detectChannels(sid).catch(() => ({}));
  const d = newDraft(engine, ctx, cfg, STEPS.includes(step) ? step : 'role', detected);
  d.id = engine.router.session(d, WIZARD_TTL_MS);
  return renderStep(ctx, d);
}

function draftOf(ctx, sess) {
  const d = ctx.engine.router.getSession(sess);
  if (!d || d.sid !== ctx.serverId || d.uid !== ctx.userId || !d.step) return null;
  return d;
}

async function expired(ctx) {
  return show(ctx, { embeds: [dialog.warn('This setup ran out', 'Setups last 15 minutes. Start again and pick up where you left off: your saved settings are kept.')], components: [row(button('Start again', cid('setup'), 'primary', ICON))] });
}

function stepNumber(step) {
  return Math.min(STEPS.indexOf(step) + 1, STEPS.length - 1);
}

function navRow(d, extra = []) {
  const i = STEPS.indexOf(d.step);
  const btns = [
    ...extra,
    button('Back', cid('wgo', d.id, STEPS[Math.max(0, i - 1)]), 'secondary', '⬅️', { disabled: i === 0 }),
    d.step === 'summary' ? null : button('Skip', cid('wgo', d.id, STEPS[i + 1]), 'secondary', '⏭️'),
    button('Cancel', cid('wcancel', d.id), 'danger', '✖️'),
  ];
  return row(...btns);
}

function stepCard(d, body) {
  const head = d.step === 'summary' ? `${ICON} Verify setup: ${STEP_TITLES.summary}` : `${ICON} Verify setup · Step ${stepNumber(d.step)} of ${STEPS.length - 1}: ${STEP_TITLES[d.step]}`;
  const note = d.note;
  d.note = null;
  const embeds = [];
  if (note) embeds.push(note);
  embeds.push(card({ title: head, body, color: 'verify' }));
  return embeds;
}

async function roleName(engine, sid, roleId) {
  if (!roleId) return null;
  return (await rolesOf(engine, sid)).find((r) => r.id === roleId)?.name || null;
}

async function channelName(engine, sid, channelId) {
  return (await channelExists(engine, sid, channelId))?.name || null;
}

async function renderStep(ctx, d) {
  const { engine } = ctx;
  const sid = d.sid;
  if (d.step === 'role' || d.step === 'unverified') {
    const isMain = d.step === 'role';
    const current = await roleName(engine, sid, isMain ? d.roleId : d.unverifiedRoleId);
    const all = await rolesOf(engine, sid);
    const defaultName = isMain ? 'Verified' : 'Unverified';
    const existing = all.find((r) => r.name.toLowerCase() === defaultName.toLowerCase());
    const choices = (await pickableRoles(engine, sid)).filter((r) => r.id !== (isMain ? d.unverifiedRoleId : d.roleId));
    const body = isMain
      ? `People get this role once they pass the check. Pick a plain role with no mod powers, or press **${existing ? 'Use' : 'Make'} "Verified"**.\n\nPicked: ${current ? `**${current}**` : '*nothing yet*'}`
      : `New members get this role the moment they join and lose it once they verify. With it, I can hide channels from **new people only**, so everyone already here keeps their access.\nNo Unverified role? Then hiding works by hiding channels from everyone and showing them to **Verified**.\n\nPicked: ${current ? `**${current}**` : '*none*'}`;
    const kind = isMain ? 'role' : 'urole';
    const make = button(`${existing ? 'Use' : 'Make'} "${defaultName}"`, cid('wmk', d.id, kind), 'primary', '✨');
    const none = isMain ? null : button('No Unverified role', cid('wpick', d.id, 'urole', 'none'), 'secondary', '🚫');
    const opts = choices.map((r) => ({ label: r.name, value: r.id, default: r.id === (isMain ? d.roleId : d.unverifiedRoleId) }));
    const embeds = stepCard(d, `${body}${choices.length ? '' : '\n-# No plain roles below mine to pick from, so make one.'}`);
    const withSelect = { embeds, components: [opts.length ? select(cid('wsel', d.id, kind), opts, { placeholder: `Pick the ${defaultName} role` }) : null, row(make, none), navRow(d)].filter(Boolean) };
    const withButtons = { embeds, components: [...rows(choices.slice(0, 10).map((r) => button(r.name, cid('wpick', d.id, kind, r.id), r.id === (isMain ? d.roleId : d.unverifiedRoleId) ? 'success' : 'secondary'))).slice(0, 2), row(make, none), navRow(d)] };
    return showPicker(ctx, { withSelect, withButtons: opts.length ? withButtons : null });
  }
  if (d.step === 'channel') {
    const list = (await textChannels(engine, sid)).slice(0, 25);
    const detected = await engine.detectChannels(sid).catch(() => ({}));
    const current = await channelName(engine, sid, d.channelId);
    const body = `Where should the **Verify** button live? New members need to be able to see this channel.\nI looked for one called verify, verification or gate${detected.verify ? ` and found <#${detected.verify.id}>` : ", but didn't find one"}.\n\nPicked: ${current ? `<#${d.channelId}>` : '*nothing yet*'}`;
    const extra = [];
    if (detected.verify && detected.verify.id !== d.channelId) extra.push(button(`Use #${clip(detected.verify.name, 40)}`, cid('wpick', d.id, 'chan', detected.verify.id), 'success', '✅'));
    if (!detected.verify) extra.push(button('Make #verify', cid('wmk', d.id, 'chan'), 'primary', '✨'));
    const opts = list.map((c) => ({ label: `#${c.name}`, value: c.id, default: c.id === d.channelId }));
    const embeds = stepCard(d, body);
    const withSelect = { embeds, components: [opts.length ? select(cid('wsel', d.id, 'chan'), opts, { placeholder: 'Pick the verify channel' }) : null, extra.length ? row(extra) : null, navRow(d)].filter(Boolean) };
    const withButtons = { embeds, components: [...rows(list.slice(0, 10).map((c) => button(`#${clip(c.name, 40)}`, cid('wpick', d.id, 'chan', c.id), c.id === d.channelId ? 'success' : 'secondary'))).slice(0, 2), extra.length ? row(extra) : null, navRow(d)].filter(Boolean) };
    return showPicker(ctx, { withSelect, withButtons: opts.length ? withButtons : null });
  }
  if (d.step === 'method') {
    const body = `${Object.entries(METHODS).map(([k, m]) => `${m.emoji} **${m.label}**${k === d.method ? ' *(picked)*' : ''}: ${m.blurb}`).join('\n')}\n\n-# Every method checks the person themselves: nobody can verify someone else.`;
    const btns = Object.entries(METHODS).map(([k, m]) => button(m.label, cid('wpick', d.id, 'method', k), k === d.method ? 'success' : 'secondary', m.emoji));
    return show(ctx, { embeds: stepCard(d, body), components: [row(btns), navRow(d)] });
  }
  if (d.step === 'age') {
    const body = `Brand-new accounts are a common sign of raids and spam. I can make people wait until their account is a few days old.\n\nPicked: **${ageText(d.minAccountDays)}**\n-# If Yapin' doesn't tell me how old an account is, I let the person through.`;
    const btns = AGES.map((n) => button(ageText(n), cid('wpick', d.id, 'age', String(n)), n === d.minAccountDays ? 'success' : 'secondary'));
    return show(ctx, { embeds: stepCard(d, body), components: [row(btns), navRow(d)] });
  }
  if (d.step === 'message') {
    const welcome = d.welcome || DEFAULT_WELCOME;
    const rules = d.method === 'rules' ? `\n\n**Rules people agree to:**\n${clip(d.rulesText || '(your #rules channel, plus a short default list)', 600)}` : '';
    const body = `This is what people see once they're verified. Only they see it.\n> ${clip(welcome, 500)}${rules}\n\n-# Placeholders: {user} {username} {server}`;
    const btns = [button(d.method === 'rules' ? 'Write message and rules' : 'Write my own', cid('wform', d.id), 'primary', '📝'), button('Use the default', cid('wpick', d.id, 'msg', 'default'), 'secondary', '🔁')];
    return show(ctx, { embeds: stepCard(d, body), components: [row(btns), navRow(d)] });
  }
  if (d.step === 'lock') return renderLock(ctx, d);
  return renderSummary(ctx, d);
}

async function lockPlan(engine, sid, d) {
  const all = await engine.cache.channels(sid).catch(() => []);
  const found = await engine.detectChannels(sid).catch(() => ({}));
  const keepIds = [d.channelId, found.rules?.id].filter(Boolean);
  const keep = all.filter((c) => keepIds.includes(c.id));
  const eligible = all.filter((c) => (c.type === 'text' || c.type === 'voice') && !keepIds.includes(c.id) && !c.private);
  const targets = eligible.slice(0, MAX_LOCK);
  const mode = d.unverifiedRoleId ? 'unverified' : 'everyone';
  const keepers = mode === 'everyone' ? await keeperRoles(engine, sid, d) : [];
  const changes = [];
  for (const c of targets) {
    if (mode === 'unverified') changes.push({ channelId: c.id, name: c.name, target: d.unverifiedRoleId, allow: [], deny: ['view_channel'] });
    else {
      for (const k of keepers) changes.push({ channelId: c.id, name: c.name, target: k.id, allow: ['view_channel'], deny: [] });
      changes.push({ channelId: c.id, name: c.name, target: d.roleId, allow: ['view_channel'], deny: [] });
      changes.push({ channelId: c.id, name: c.name, target: 'everyone', allow: [], deny: ['view_channel'] });
    }
  }
  const verifyChannel = all.find((c) => c.id === d.channelId);
  if (verifyChannel) changes.push({ channelId: verifyChannel.id, name: verifyChannel.name, target: mode === 'unverified' ? d.unverifiedRoleId : 'everyone', allow: ['view_channel'], deny: [] });
  return { mode, targets, keep, keepers, changes, over: Math.max(0, eligible.length - MAX_LOCK), privateCount: all.filter((c) => c.private && !keepIds.includes(c.id)).length };
}

const KEEPER_PERMS = ['manage_server', 'manage_roles', 'manage_channels', 'manage_messages', 'kick_members', 'ban_members', 'timeout_members'];
const MAX_KEEPERS = 6;

async function keeperRoles(engine, sid, d) {
  const roles = await rolesOf(engine, sid);
  const core = engine.settings.core(sid);
  const named = new Set([...(core.modRoles || []), ...(core.adminRoles || [])]);
  const botMember = await engine.perms.member(sid, engine.bot.me?.id).catch(() => null);
  const botRoles = new Set(botMember?.roles || []);
  const strong = (r) => r.perms?.administrator || r.administrator;
  const out = [];
  const add = (r) => {
    if (!r || isEveryone(r, sid) || r.id === d.roleId || r.id === d.unverifiedRoleId || strong(r) || out.some((x) => x.id === r.id)) return;
    out.push(r);
  };
  const byTop = [...roles].sort((a, b) => (b.position || 0) - (a.position || 0));
  if (!byTop.some((r) => botRoles.has(r.id) && strong(r))) add(byTop.find((r) => botRoles.has(r.id) && !isEveryone(r, sid)));
  for (const r of byTop) if (named.has(r.id)) add(r);
  for (const r of byTop) if (KEEPER_PERMS.some((p) => r.perms?.[p] || r[p])) add(r);
  return out.slice(0, MAX_KEEPERS);
}

async function lockBlocker(engine, sid, d) {
  if (engine.caps.state(sid, 'roles') === false) return "Channel permission changes aren't on for this server yet (Yapin' is still testing them). Skip this step and hide channels by hand in each channel's settings.";
  const p = await engine.perms.botCan(sid, 'manage_roles');
  const c = await engine.perms.botCan(sid, 'manage_channels');
  if (!p.ok && !c.ok) return `My role needs **${permName('manage_roles')}** or **${permName('manage_channels')}** to change channel permissions. Server settings → Roles → my role → tick one, then press **Check again**.`;
  if (!d.roleId) return 'Pick the Verified role first (step 1).';
  if (!d.channelId) return 'Pick the verify channel first (step 3), so I know which channel stays open.';
  const target = d.unverifiedRoleId || d.roleId;
  const problem = await roleProblem(engine, sid, target, { label: d.unverifiedRoleId ? 'Unverified role' : 'Verified role' });
  if (problem) return problem.reason;
  return null;
}

async function membersWithout(engine, sid, roleId) {
  const list = await engine.cache.members(sid).catch(() => []);
  const botId = engine.bot.me?.id;
  return list.filter((m) => m.id !== botId && !(m.roles || []).includes(roleId)).length;
}

async function renderLock(ctx, d) {
  const { engine } = ctx;
  const sid = d.sid;
  const blocker = await lockBlocker(engine, sid, d);
  if (blocker) {
    const body = `I can hide your other channels from people who haven't verified yet, but not right now:\n${blocker}`;
    return show(ctx, { embeds: stepCard(d, body), components: [row(button('Check again', cid('wgo', d.id, 'lock'), 'primary', '🔄'), button('Leave channels alone', cid('wlock', d.id, 'no'), 'secondary', '🚪')), navRow(d)] });
  }
  const plan = await lockPlan(engine, sid, d);
  const vName = await roleName(engine, sid, d.roleId);
  const uName = await roleName(engine, sid, d.unverifiedRoleId);
  const names = plan.targets.map((c) => `#${c.name}`);
  const listed = names.length > 12 ? `${names.slice(0, 12).join(', ')} and ${names.length - 12} more` : names.join(', ');
  const lines = [];
  if (!plan.targets.length) lines.push("There are no other public channels to hide, so there's nothing to lock.");
  else if (plan.mode === 'unverified') {
    lines.push(`For each of these **${plan.targets.length}** channels I'll add a channel override for **@${uName}**: deny **View Channel**.`);
    lines.push(`In <#${d.channelId}> I'll allow **View Channel** for **@${uName}**, so new people can find the button.`);
    lines.push('Members already here are not affected.');
  } else {
    lines.push(`For each of these **${plan.targets.length}** channels I'll set two channel overrides:`);
    lines.push('• **@everyone**: deny **View Channel**');
    lines.push(`• **@${vName}**: allow **View Channel**`);
    if (plan.keepers.length) lines.push(`• ${plan.keepers.map((r) => `**@${r.name}**`).join(', ')}: allow **View Channel**, so my role and your staff keep their access`);
    lines.push(`In <#${d.channelId}> I'll allow **View Channel** for **@everyone**.`);
    const missing = await membersWithout(engine, sid, d.roleId);
    if (missing) lines.push(`${ICONS.warn} **${missing}** member${missing === 1 ? '' : 's'} here ${missing === 1 ? "doesn't" : "don't"} have **${vName}** yet, so they lose access until they press Verify. Mods and admins with Administrator still see everything. Want only new people affected? Go **Back** and pick an Unverified role.`);
  }
  if (plan.targets.length) lines.push(`\nChannels: ${listed}`);
  if (plan.keep.length) lines.push(`Stays visible: ${plan.keep.map((c) => `#${c.name}`).join(', ')}`);
  if (plan.privateCount) lines.push(`-# ${plan.privateCount} private channel${plan.privateCount === 1 ? ' is' : 's are'} already hidden, so I leave ${plan.privateCount === 1 ? 'it' : 'them'} alone.`);
  if (plan.over) lines.push(`-# ${plan.over} more channel${plan.over === 1 ? '' : 's'} won't fit in one go. Hide ${plan.over === 1 ? 'it' : 'them'} by hand.`);
  lines.push(`-# Nothing changes until you press **Finish** at the end. Anything else already set on these channels stays. Undo puts every override back the way it was.${plan.changes.length > 25 ? ` That's ${plan.changes.length} changes and Yapin' allows 30 a minute, so it can take a couple of minutes.` : ''}`);
  const yes = plan.targets.length ? button(`Yes, lock ${plan.targets.length} channel${plan.targets.length === 1 ? '' : 's'}`, cid('wlock', d.id, 'yes'), d.lock ? 'success' : 'primary', ICONS.lock) : null;
  return show(ctx, { embeds: stepCard(d, lines.join('\n')), components: [row(yes, button('Leave channels alone', cid('wlock', d.id, 'no'), d.lock ? 'secondary' : 'success', '🚪')), navRow(d)] });
}

async function draftProblems(engine, sid, d) {
  const out = [];
  const main = await roleProblem(engine, sid, d.roleId, { label: 'Verified role' });
  if (main) out.push(`Verified role: ${main.reason}`);
  else {
    const role = (await rolesOf(engine, sid)).find((r) => r.id === d.roleId);
    const risky = riskyRole(engine, sid, role);
    if (risky) out.push(risky);
  }
  if (!d.channelId) out.push('Verify channel: none picked yet.');
  else if (!(await channelExists(engine, sid, d.channelId))) out.push("Verify channel: I can't find it anymore. Pick another one.");
  if (d.unverifiedRoleId) {
    if (d.unverifiedRoleId === d.roleId) out.push('The Unverified role has to be different from the Verified role.');
    else {
      const u = await roleProblem(engine, sid, d.unverifiedRoleId, { label: 'Unverified role' });
      if (u) out.push(`Unverified role: ${u.reason}`);
    }
  }
  return out;
}

async function renderSummary(ctx, d) {
  const { engine } = ctx;
  const sid = d.sid;
  const problems = await draftProblems(engine, sid, d);
  const vName = await roleName(engine, sid, d.roleId);
  const uName = await roleName(engine, sid, d.unverifiedRoleId);
  const m = METHODS[d.method] || METHODS.button;
  const lines = [
    `**Verified role:** ${vName ? `**${vName}**` : '*not picked*'}`,
    `**Unverified role:** ${uName ? `**${uName}**` : 'none'}`,
    `**Verify channel:** ${d.channelId && (await channelExists(engine, sid, d.channelId)) ? `<#${d.channelId}>` : '*not picked*'}`,
    `**Method:** ${m.emoji} ${m.label}`,
    `**Minimum account age:** ${ageText(d.minAccountDays)}`,
    `**Welcome message:** ${clip(d.welcome || DEFAULT_WELCOME, 200)}`,
    `**Hide channels:** ${d.lock ? 'yes, after posting the panel' : 'no'}`,
  ];
  if (problems.length) lines.push('', `${ICONS.warn} **Fix these first:**`, ...problems.map((p) => `• ${p}`));
  else lines.push('', 'Press **Finish** and I save this, post the Verify panel and give you an Undo button for 10 minutes.');
  const finish = button('Finish', cid('wfin', d.id), 'success', '🏁', { disabled: problems.length > 0 });
  return show(ctx, { embeds: stepCard(d, lines.join('\n')), components: [navRow(d, [finish])] });
}

function nextStep(step) {
  const i = STEPS.indexOf(step);
  return STEPS[Math.min(STEPS.length - 1, i + 1)];
}

async function heldTooWidely(engine, sid, role, actorId) {
  const list = await engine.cache.members(sid).catch(() => []);
  const holders = list.filter((m) => (m.roles || []).includes(role.id));
  if (holders.some((m) => m.id === engine.bot.me?.id)) return `I have **${role.name}** myself. Hiding channels from it would hide them from me, so pick or make a role only new members get.`;
  if (holders.some((m) => m.id === actorId)) return `You have **${role.name}**. Hiding channels from it would hide them from you too, so pick or make a role only new members get.`;
  if (list.length >= 4 && holders.length * 2 >= list.length) return `**${role.name}** is held by ${holders.length} of ${list.length} members. Hiding channels from it would lock most of the server out, so pick or make a role only new members get.`;
  return null;
}

async function pickRole(ctx, d, kind, roleId) {
  const { engine } = ctx;
  const sid = d.sid;
  const isMain = kind === 'role';
  if (!isMain && roleId === 'none') {
    d.unverifiedRoleId = null;
    d.step = nextStep(d.step);
    return renderStep(ctx, d);
  }
  const role = (await rolesOf(engine, sid)).find((r) => r.id === roleId);
  if (!role) d.note = dialog.warn("I couldn't find that role", 'It may have been deleted. Pick another one.');
  else if (roleId === (isMain ? d.unverifiedRoleId : d.roleId)) d.note = dialog.warn('Pick a different role', 'The Verified and Unverified roles have to be two different roles.');
  else {
    const risky = riskyRole(engine, sid, role) || (isMain ? null : await heldTooWidely(engine, sid, role, ctx.userId));
    const problem = risky ? null : await roleProblem(engine, sid, roleId);
    if (risky) d.note = dialog.warn(isMain ? 'That role is too powerful' : "That can't be the Unverified role", risky);
    else if (problem) d.note = dialog.warn(`I can't hand out ${role.name}`, problem.reason);
    else {
      if (isMain) d.roleId = roleId; else d.unverifiedRoleId = roleId;
      d.step = nextStep(d.step);
    }
  }
  return renderStep(ctx, d);
}

async function pickChannel(ctx, d, channelId) {
  const ch = await channelExists(ctx.engine, d.sid, channelId);
  if (!ch) d.note = dialog.warn("I couldn't find that channel", 'It may have been deleted. Pick another one.');
  else {
    d.channelId = ch.id;
    d.step = nextStep(d.step);
  }
  return renderStep(ctx, d);
}

async function makeRole(ctx, d, kind) {
  const { engine } = ctx;
  const sid = d.sid;
  const isMain = kind === 'role';
  const name = isMain ? 'Verified' : 'Unverified';
  const existing = (await rolesOf(engine, sid)).find((r) => r.name.toLowerCase() === name.toLowerCase());
  if (existing) return pickRole(ctx, d, kind, existing.id);
  const can = await engine.perms.botCan(sid, 'manage_roles');
  if (!can.ok) {
    d.note = dialog.warn(`I can't make the ${name} role`, `My role needs **${permName('manage_roles')}**. Server settings → Roles → my role → tick it, then press the button again.\n-# Or make a role called **${name}** yourself and pick it here.`);
    return renderStep(ctx, d);
  }
  let role;
  try {
    role = await engine.bot.createRole(sid, { name, mentionable: false, permissions: {} });
  } catch (e) {
    if (looksLikeFeatureOff(e)) {
      engine.caps.mark(sid, 'roles', false, e?.message);
      d.note = dialog.warn(`I can't make roles on this server yet`, `Yapin' is still testing role changes for bots. Make a role called **${name}** yourself (Server settings → Roles), then pick it here.`);
    } else {
      const ex = explain(e, { action: `make the ${name} role`, perm: 'manage_roles' });
      d.note = dialog.warn(ex.title, ex.body);
    }
    return renderStep(ctx, d);
  }
  engine.caps.mark(sid, 'roles', true);
  engine.cache.invalidate(sid);
  if (role?.id) d.created.roles.push(role.id);
  if (isMain) d.roleId = role?.id || null; else d.unverifiedRoleId = role?.id || null;
  d.note = dialog.ok(`Made the ${name} role`, `**${name}** has no permissions of its own. ${isMain ? 'People get it when they verify.' : 'New members get it when they join.'}`);
  d.step = nextStep(d.step);
  return renderStep(ctx, d);
}

async function makeChannel(ctx, d) {
  const { engine } = ctx;
  const sid = d.sid;
  const can = await engine.perms.botCan(sid, 'manage_channels');
  if (!can.ok) {
    d.note = dialog.warn("I can't make the channel", `My role needs **${permName('manage_channels')}**. Or make a channel called **#verify** yourself and pick it here.`);
    return renderStep(ctx, d);
  }
  let ch;
  try {
    ch = await engine.bot.createChannel(sid, 'verify', { kind: 'text' });
  } catch (e) {
    const ex = explain(e, { action: 'make #verify', perm: 'manage_channels' });
    d.note = dialog.warn(ex.title, ex.body);
    return renderStep(ctx, d);
  }
  engine.cache.invalidate(sid);
  if (ch?.id) d.created.channels.push(ch.id);
  d.channelId = ch?.id || null;
  d.note = dialog.ok('Made #verify', 'The Verify button goes there.');
  d.step = nextStep(d.step);
  return renderStep(ctx, d);
}

async function cleanupCreated(engine, sid, created) {
  const done = [];
  for (const roleId of created.roles || []) {
    try { await engine.bot.deleteRole(sid, roleId); done.push('role'); } catch (e) { engine.log.debug('could not delete a role made by verify setup', e?.message); }
  }
  for (const channelId of created.channels || []) {
    try { await engine.bot.deleteChannel(channelId); done.push('channel'); } catch (e) { engine.log.debug('could not delete a channel made by verify setup', e?.message); }
  }
  engine.cache.invalidate(sid);
  return done;
}

async function withRetry(fn, tries = 4) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (e?.status !== 429 || i >= tries) throw e;
      await new Promise((r) => setTimeout(r, Math.min(60_000, Math.max(1000, (Number(e.retryAfter) || 2) * 1000))));
    }
  }
}

async function overridesOf(engine, channelId) {
  const list = await engine.bot.channelPermissions(channelId).catch(() => []);
  const out = new Map();
  for (const o of list || []) out.set(o.role_id ? o.role_id : 'everyone', { allow: [...(o.allow || [])], deny: [...(o.deny || [])] });
  return out;
}

function mergeOverride(prior, change) {
  const allow = new Set((prior?.allow || []).filter((p) => !change.deny.includes(p)));
  const deny = new Set((prior?.deny || []).filter((p) => !change.allow.includes(p)));
  for (const p of change.allow) allow.add(p);
  for (const p of change.deny) deny.add(p);
  return { allow: [...allow], deny: [...deny] };
}

async function applyLock(engine, sid, changes) {
  const entries = [];
  const failed = [];
  const seen = new Map();
  for (const change of changes) {
    if (!seen.has(change.channelId)) seen.set(change.channelId, await overridesOf(engine, change.channelId));
    const prior = seen.get(change.channelId).get(change.target) || null;
    try {
      await withRetry(() => engine.bot.setChannelPermissions(change.channelId, change.target, mergeOverride(prior, change)));
      entries.push({ channelId: change.channelId, target: change.target, prior });
    } catch (e) {
      if (looksLikeFeatureOff(e)) {
        engine.caps.mark(sid, 'roles', false, e?.message);
        failed.push({ name: change.name, reason: "channel permission changes aren't on for this server yet" });
        break;
      }
      failed.push({ name: change.name, reason: e?.status === 403 ? 'I was missing a permission there' : 'Yapin\' refused the change' });
    }
  }
  return { entries, failed };
}

async function restoreLock(engine, entries) {
  let failed = 0;
  for (const e of [...entries].reverse()) {
    try {
      if (!e.prior || (!e.prior.allow?.length && !e.prior.deny?.length)) await withRetry(() => engine.bot.clearChannelPermissions(e.channelId, e.target));
      else await withRetry(() => engine.bot.setChannelPermissions(e.channelId, e.target, e.prior));
    } catch (err) {
      if (err?.status !== 404) failed++;
    }
  }
  return failed;
}

function lockRecord(engine, sid) {
  const rec = engine.store.get(ID, sid, {})?.lock;
  return rec && Array.isArray(rec.entries) ? rec : null;
}

function saveLockRecord(engine, sid, entries, mode) {
  engine.store.update(ID, sid, (d) => {
    const old = d.lock && Array.isArray(d.lock.entries) ? d.lock.entries : [];
    const keyOf = (e) => `${e.channelId}:${e.target}`;
    const have = new Set(old.map(keyOf));
    d.lock = { mode, at: now(), entries: [...old, ...entries.filter((e) => !have.has(keyOf(e)))] };
  }, {});
}

function dropLockEntries(engine, sid, entries) {
  const keys = new Set(entries.map((e) => `${e.channelId}:${e.target}`));
  engine.store.update(ID, sid, (d) => {
    if (!d.lock) return;
    d.lock.entries = (d.lock.entries || []).filter((e) => !keys.has(`${e.channelId}:${e.target}`));
    if (!d.lock.entries.length) delete d.lock;
  }, {});
}

async function postPanel(engine, sid, cfg) {
  const sent = await engine.budget.send({ serverId: sid, channelId: cfg.channelId, content: '', opts: panelView(cfg), priority: 'high' });
  return sent?.id || null;
}

async function finish(ctx, d) {
  const { engine } = ctx;
  const sid = d.sid;
  const problems = await draftProblems(engine, sid, d);
  if (problems.length) {
    d.step = 'summary';
    return renderStep(ctx, d);
  }
  engine.router.dropSession(d.id);
  const plan = d.lock ? await lockPlan(engine, sid, d) : null;
  await ctx.update({ embeds: [dialog.info('Setting up verification', `Saving your settings and posting the Verify panel${plan?.targets.length ? `, then hiding ${plan.targets.length} channel${plan.targets.length === 1 ? '' : 's'}` : ''}. One moment.`)], components: [] });
  const before = rawConfig(engine, sid);
  const next = {
    enabled: true, channelId: d.channelId, roleId: d.roleId, unverifiedRoleId: d.unverifiedRoleId || null,
    method: d.method, minAccountDays: d.minAccountDays, welcome: d.welcome || '', rulesText: d.rulesText || '', legacy: false, migrated: true,
  };
  engine.settings.patchApp(sid, ID, next);
  let messageId = null;
  try {
    messageId = await postPanel(engine, sid, cfgOf(engine, sid));
  } catch (e) {
    engine.settings.setApp(sid, ID, before);
    const ex = explain(e, { action: 'post the Verify panel', target: `in <#${d.channelId}>`, perm: 'send_messages' });
    return ctx.update({ embeds: [dialog.error(ex.title, `${ex.body}\n\nNothing was saved. Fix it, then run **/verify setup** again.`)], components: [row(button('Start again', cid('setup'), 'primary', ICON))] });
  }
  engine.settings.patchApp(sid, ID, { panelChannelId: d.channelId, panelMessageId: messageId });
  let lock = { entries: [], failed: [] };
  if (plan?.targets.length) {
    lock = await applyLock(engine, sid, plan.changes);
    if (lock.entries.length) saveLockRecord(engine, sid, lock.entries, plan.mode);
  }
  const created = structuredClone(d.created);
  const vName = await roleName(engine, sid, d.roleId);
  postLog(engine, sid, card({ title: `${ICON} Verification set up`, body: `<@${ctx.userId}> turned verification on in <#${d.channelId}>. People get **${vName}** after a ${METHODS[d.method].label.toLowerCase()} check.${plan?.targets.length && lock.entries.length ? ` ${plan.targets.length} channel${plan.targets.length === 1 ? ' is' : 's are'} hidden until people verify.` : ''}`, color: 'verify' }), { priority: 'normal' }).catch(() => {});
  const undo = engine.router.addUndo({
    serverId: sid, actorId: ctx.userId, label: 'verification setup', perm: 'admin',
    manual: '/verify off',
    run: async (i) => {
      await engine.perms.require(sid, i.user_id, 'admin');
      const failedRestores = await restoreLock(engine, lock.entries);
      dropLockEntries(engine, sid, lock.entries);
      if (messageId) await engine.bot.delete(d.channelId, messageId).catch(() => {});
      engine.settings.setApp(sid, ID, before);
      await cleanupCreated(engine, sid, created);
      postLog(engine, sid, card({ title: `${ICON} Verification setup undone`, body: `<@${i.user_id}> undid the verification setup.`, color: 'muted' }), { priority: 'normal' }).catch(() => {});
      if (failedRestores) {
        await i.ephemeral('', { embeds: [dialog.warn('Mostly undone', `Settings are back and the panel is gone, but I couldn't put back ${failedRestores} channel permission${failedRestores === 1 ? '' : 's'}. Check your channels' permissions by hand.`)] });
        return false;
      }
      return true;
    },
  });
  const lockedChannels = new Set(lock.entries.map((e) => e.channelId)).size;
  const lines = [
    `The Verify panel is up in <#${d.channelId}>. Pressing it gives **${vName}**.`,
    d.unverifiedRoleId ? `New members get **${await roleName(engine, sid, d.unverifiedRoleId)}** when they join, until they verify.` : null,
    lockedChannels ? `${ICONS.lock} Hid **${plan.targets.length}** channel${plan.targets.length === 1 ? '' : 's'} from people who aren't verified.` : null,
    lock.failed.length ? `${ICONS.warn} I couldn't change ${lock.failed.length} channel${lock.failed.length === 1 ? '' : 's'}: ${lock.failed.slice(0, 5).map((f) => `#${f.name} (${f.reason})`).join(', ')}.` : null,
    '',
    'Press **Test it** to try it as a new member. Undo works for 10 minutes and puts everything back, including channel permissions.',
  ].filter((x) => x !== null).join('\n');
  const embed = lock.failed.length ? dialog.warn('Verification is on, with a catch', lines) : dialog.ok('Verification is on', lines);
  return ctx.update({ embeds: [embed], components: [row(undo.button, button('Test it', cid('test'), 'primary', '🧪'), button('Status', cid('status'), 'secondary', '🩺'))] });
}

async function wizardAction(ctx, fn) {
  const d = draftOf(ctx, ctx.argv[0]);
  if (!d) return expired(ctx);
  return fn(d);
}

async function statusProblems(engine, sid, cfg) {
  const out = [];
  if (!cfg.roleId && !cfg.channelId) return [{ text: "Verification isn't set up yet.", fixes: [['Set it up', cid('setup'), 'primary', ICON]] }];
  if (engine.caps.state(sid, 'roles') === false) out.push({ text: "Role changes aren't on for this server yet (Yapin' is still testing them), so I can't give the role. Give it by hand with `/verify user @name` for now.", fixes: [] });
  const main = await roleProblem(engine, sid, cfg.roleId, { label: 'Verified role' });
  if (main?.missing) out.push({ text: `${main.reason} Pick a new one, or let me make one.`, fixes: [['Pick a new role', cid('setup', 'role'), 'primary', '🎭']] });
  else if (main?.position) out.push({ text: `${main.reason}\n-# Server settings → Roles → drag my role above **${main.role?.name}**, then press **Check again**.`, fixes: [['Check again', cid('status'), 'secondary', '🔄']] });
  else if (main?.perm) out.push({ text: `${main.reason}\n-# Server settings → Roles → my role → tick **${permName('manage_roles')}**, then press **Check again**.`, fixes: [['Check again', cid('status'), 'secondary', '🔄']] });
  else if (main) out.push({ text: main.reason, fixes: [['Pick a new role', cid('setup', 'role'), 'primary', '🎭']] });
  else {
    const role = (await rolesOf(engine, sid)).find((r) => r.id === cfg.roleId);
    const risky = riskyRole(engine, sid, role);
    if (risky) out.push({ text: `${risky} Verification is paused until you fix it.`, fixes: [['Pick a new role', cid('setup', 'role'), 'primary', '🎭']] });
  }
  if (cfg.unverifiedRoleId) {
    const u = await roleProblem(engine, sid, cfg.unverifiedRoleId, { label: 'Unverified role' });
    if (u) out.push({ text: `Unverified role: ${u.reason}`, fixes: [[u.missing ? 'Pick a new Unverified role' : 'Check again', u.missing ? cid('setup', 'unverified') : cid('status'), 'secondary', u.missing ? '🎭' : '🔄']] });
  }
  const ch = await channelExists(engine, sid, cfg.channelId);
  if (!cfg.channelId || !ch) out.push({ text: cfg.channelId ? 'The verify channel was deleted, or I can\'t see it anymore.' : 'No verify channel is picked.', fixes: [['Pick a channel', cid('setup', 'channel'), 'primary', '#️⃣']] });
  else if (cfg.panelMessageId && cfg.panelChannelId) {
    let missing = false;
    try { await engine.bot.message(cfg.panelChannelId, cfg.panelMessageId); } catch (e) { missing = e?.status === 404; }
    if (missing) out.push({ text: 'The Verify panel message was deleted, so new people have nothing to press.', fixes: [['Repost the panel', cid('repost'), 'primary', '📌']] });
  }
  if (!cfg.enabled) out.push({ text: 'Verification is turned off, so the Verify button does nothing.', fixes: [['Turn it on', cid('on'), 'success', '🟢']] });
  return out;
}

async function statusView(ctx) {
  const { engine, serverId: sid } = ctx;
  const cfg = cfgOf(engine, sid);
  const problems = await statusProblems(engine, sid, cfg);
  const setUp = !!(cfg.roleId || cfg.channelId);
  const vName = await roleName(engine, sid, cfg.roleId);
  const uName = await roleName(engine, sid, cfg.unverifiedRoleId);
  const rec = lockRecord(engine, sid);
  const locked = rec ? new Set(rec.entries.filter((e) => e.channelId !== cfg.channelId).map((e) => e.channelId)).size : 0;
  const m = METHODS[methodOf(cfg)];
  const fields = setUp ? [
    { name: 'Status', value: cfg.enabled ? '🟢 On' : '⚪ Off', inline: true },
    { name: 'Channel', value: cfg.channelId ? `<#${cfg.channelId}>` : 'not picked', inline: true },
    { name: 'Verified role', value: vName ? `**${vName}**` : 'missing', inline: true },
    { name: 'Unverified role', value: uName ? `**${uName}**` : 'none', inline: true },
    { name: 'Method', value: `${m.emoji} ${m.label}`, inline: true },
    { name: 'Account age', value: ageText(Number(cfg.minAccountDays) || 0), inline: true },
    { name: 'Hidden channels', value: locked ? `${locked} hidden until people verify` : 'none', inline: true },
    { name: 'Welcome message', value: clip(cfg.welcome || DEFAULT_WELCOME, 200), inline: false },
  ] : [];
  const body = problems.length
    ? `**What needs fixing:**\n${problems.map((p) => `${ICONS.warn} ${p.text}`).join('\n')}`
    : `${ICONS.ok} Everything checks out. New people press **Verify** in <#${cfg.channelId}> and get **${vName}**.${cfg.legacy ? '\n-# This is the panel from Automod. Press **Repost panel** for the new look; the old button keeps working.' : ''}`;
  const fixes = [];
  const seen = new Set();
  for (const p of problems) for (const [label, id, style, emoji] of p.fixes) if (!seen.has(id)) { seen.add(id); fixes.push(button(label, id, style, emoji)); }
  const tools = setUp ? [
    button('Set up again', cid('setup'), 'secondary', ICON),
    seen.has(cid('repost')) ? null : button('Repost panel', cid('repost'), 'secondary', '📌'),
    button('Test', cid('test'), 'secondary', '🧪'),
    cfg.enabled ? button('Turn off', cid('off'), 'danger', '⏸️') : null,
    seen.has(cid('status')) ? null : button('Refresh', cid('status'), 'secondary', '🔄'),
  ] : [];
  return {
    embeds: [card({ title: `${ICON} Verify status`, body, fields, color: problems.length ? 'warn' : 'verify', footer: 'Run /help verify for how it works' })],
    components: [fixes.length ? row(fixes) : null, tools.filter(Boolean).length ? row(tools) : null].filter(Boolean),
  };
}

async function showStatus(ctx) {
  await ctx.require('mod');
  const view = await statusView(ctx);
  if (ctx.kind === 'button' && (ctx.onEphemeral || (ctx.source?.message_id && ctx.engine.router.panelOwner(ctx.source.message_id) === ctx.userId))) return ctx.update(view);
  return ctx.ephemeral(view);
}

async function repost(ctx) {
  await ctx.require('admin');
  const { engine, serverId: sid } = ctx;
  const cfg = cfgOf(engine, sid);
  if (!cfg.roleId || !cfg.channelId) return ctx.warn("Verification isn't set up yet", 'Run **/verify setup** first. It walks you through it.', { components: [row(button('Set it up', cid('setup'), 'primary', ICON))] });
  if (!(await channelExists(engine, sid, cfg.channelId))) return ctx.warn("I can't find the verify channel", 'Pick a new one with **/verify setup**.', { components: [row(button('Pick a channel', cid('setup', 'channel'), 'primary', '#️⃣'))] });
  let id;
  try {
    id = await postPanel(engine, sid, cfg);
  } catch (e) {
    return ctx.fail(e, { action: 'post the Verify panel', target: `in #${await channelName(engine, sid, cfg.channelId)}`, perm: 'send_messages' });
  }
  const old = cfg.panelMessageId && cfg.panelChannelId ? { channelId: cfg.panelChannelId, id: cfg.panelMessageId } : null;
  engine.settings.patchApp(sid, ID, { panelChannelId: cfg.channelId, panelMessageId: id, legacy: false });
  if (old && old.id !== id) await engine.bot.delete(old.channelId, old.id).catch(() => {});
  return ctx.ok('Panel posted', `The Verify panel is up in <#${cfg.channelId}>.${cfg.enabled ? '' : '\n-# Verification is off, so it does nothing until you turn it on with **/verify status**.'}${cfg.legacy && !old ? '\n-# You can delete the old Automod panel now; its button keeps working until you do.' : ''}`);
}

async function turnOff(ctx) {
  await ctx.require('admin');
  const { engine, serverId: sid } = ctx;
  const cfg = cfgOf(engine, sid);
  if (!cfg.enabled) return ctx.info('Verification is already off', 'Turn it on again from **/verify status**.');
  engine.settings.patchApp(sid, ID, { enabled: false });
  postLog(engine, sid, card({ title: `${ICON} Verification off`, body: `<@${ctx.userId}> turned verification off.`, color: 'muted' }), { priority: 'normal' }).catch(() => {});
  const undo = engine.router.addUndo({
    serverId: sid, actorId: ctx.userId, label: 'verification off', perm: 'admin', manual: '/verify status',
    run: async (i) => {
      await engine.perms.require(sid, i.user_id, 'admin');
      engine.settings.patchApp(sid, ID, { enabled: true });
    },
  });
  const rec = lockRecord(engine, sid);
  const btns = [undo.button];
  if (rec) btns.push(button('Show hidden channels again', cid('unlock'), 'secondary', ICONS.unlock));
  const body = `The Verify button stops working until you turn it back on.${rec ? `\n${ICONS.lock} ${new Set(rec.entries.map((e) => e.channelId)).size} channels are still hidden from people who aren't verified. Press **Show hidden channels again** to put their permissions back.` : ''}${cfg.unverifiedRoleId ? '\n-# New members no longer get the Unverified role.' : ''}`;
  return ctx.ok('Verification off', body, { components: [row(btns)] });
}

async function turnOn(ctx) {
  await ctx.require('admin');
  const { engine, serverId: sid } = ctx;
  const cfg = cfgOf(engine, sid);
  if (!cfg.roleId || !cfg.channelId) return startWizard(ctx);
  engine.settings.patchApp(sid, ID, { enabled: true });
  postLog(engine, sid, card({ title: `${ICON} Verification on`, body: `<@${ctx.userId}> turned verification back on.`, color: 'verify' }), { priority: 'normal' }).catch(() => {});
  return showStatus(ctx);
}

async function unlock(ctx) {
  await ctx.require('admin');
  const { engine, serverId: sid } = ctx;
  const rec = lockRecord(engine, sid);
  if (!rec) return ctx.info('Nothing is hidden', "I haven't hidden any channels here.");
  const failed = await restoreLock(engine, rec.entries);
  dropLockEntries(engine, sid, rec.entries);
  const count = new Set(rec.entries.map((e) => e.channelId)).size;
  postLog(engine, sid, card({ title: `${ICON} Channels shown again`, body: `<@${ctx.userId}> put the permissions back on ${count} channel${count === 1 ? '' : 's'} that verification had hidden.`, color: 'muted' }), { priority: 'normal' }).catch(() => {});
  if (failed) return ctx.warn('Mostly done', `I put back ${count - failed} channel permission${count - failed === 1 ? '' : 's'}, but ${failed} didn't work. Check those channels by hand.`);
  return ctx.ok('Channels are visible again', `I put the permissions on ${count} channel${count === 1 ? '' : 's'} back to how they were before.`);
}

async function testRun(ctx) {
  await ctx.require('admin');
  const { engine, serverId: sid, userId: uid } = ctx;
  const cfg = cfgOf(engine, sid);
  if (!cfg.roleId) return ctx.warn("Verification isn't set up yet", 'Run **/verify setup** first.', { components: [row(button('Set it up', cid('setup'), 'primary', ICON))] });
  const problems = await statusProblems(engine, sid, cfg);
  const checks = problems.length ? problems.map((p) => `${ICONS.warn} ${p.text}`).join('\n') : `${ICONS.ok} Role, channel and panel all check out.`;
  const view = await challengeView(engine, sid, uid, cfg, { test: true });
  const summary = card({ title: `${ICON} Test run`, body: `${checks}\n\nBelow is exactly what a new member sees after pressing **Verify**. Nothing you press here gives you a role.${Number(cfg.minAccountDays) ? `\n-# Accounts younger than ${ageText(cfg.minAccountDays)} are turned away before this step.` : ''}`, color: problems.length ? 'warn' : 'verify' });
  return ctx.ephemeral({ embeds: [summary, ...view.embeds], components: view.components, ttl: view.ttl });
}

async function verifyUser(ctx, token) {
  await ctx.require('mod');
  const { engine, serverId: sid } = ctx;
  const cfg = cfgOf(engine, sid);
  if (!cfg.roleId) return ctx.warn("Verification isn't set up yet", 'Run **/verify setup** first.');
  if (!token) return ctx.warn('Who?', 'Mention them, like `/verify user @sam`.');
  const target = await ctx.findUser(token);
  if (!target?.id) return ctx.warn(`I couldn't find ${clip(token, 60)}`, 'Mention them, like `/verify user @sam`.');
  const member = await engine.perms.member(sid, target.id).catch(() => null);
  if (!member) return ctx.warn("They aren't in the server", 'They have to join first.');
  const label = member.nickname || member.display_name || member.username || 'They';
  if ((member.roles || []).includes(cfg.roleId)) return ctx.info('Already verified', `${label} already has the Verified role.`);
  const g = await gate(engine, sid, cfg);
  if (!g.ok) throw friendly(g.reason, { title: `I can't verify ${label}`, hint: 'Run /verify status to fix it.' });
  try {
    await engine.bot.addRole(sid, target.id, cfg.roleId);
  } catch (e) {
    if (looksLikeFeatureOff(e)) engine.caps.mark(sid, 'roles', false, e?.message);
    return ctx.fail(e, { action: `give ${g.role.name} to`, target: label, perm: 'manage_roles' });
  }
  if (cfg.unverifiedRoleId) await engine.bot.removeRole(sid, target.id, cfg.unverifiedRoleId).catch(() => {});
  engine.perms.invalidate(`m:${sid}:${target.id}`);
  postLog(engine, sid, card({ title: `${ICON} Verified by hand`, body: `<@${ctx.userId}> verified <@${target.id}>, who got **${g.role.name}**.`, color: 'ok' }), { priority: 'normal' }).catch(() => {});
  return ctx.ok(`${label} is verified`, `They now have **${g.role.name}**${cfg.unverifiedRoleId ? ' and lost the Unverified role' : ''}.`);
}

function guideEmbed() {
  return card({
    title: `${ICON} How verification works`,
    body: [
      'Verification makes new people prove they are real before they can see and chat in your server. It stops most raid bots.',
      '',
      '**Set it up in about a minute:**',
      '1. Run **/verify setup**. I walk you through it with buttons.',
      '2. Pick the role people get after verifying, or let me make **Verified**.',
      '3. Pick the channel for the Verify button, or let me make **#verify**.',
      '4. Choose the check: one button, pick an emoji, a small sum, or agree to the rules.',
      '5. Optional: let me hide your other channels from people who aren\'t verified. I show every permission change before doing it.',
      '6. Press **Finish**. I post the Verify panel, and you get an Undo button for 10 minutes.',
      '',
      '**Example:** Sam joins, only sees #verify, presses **Verify**, picks the 🐱, gets **Verified** and can now see the whole server.',
      '',
      '**/verify status** shows what is set and fixes anything broken. **/verify test** tries it as a new member. **/verify user @sam** lets someone in by hand. **/verify off** pauses it.',
    ].join('\n'),
    color: 'verify',
  });
}

const SUBS = ['setup', 'panel', 'status', 'test', 'off', 'on', 'user', 'unlock', 'help'];

async function runVerify(ctx) {
  const tokens = ctx.argv?.length ? ctx.argv : tokenize(ctx.args);
  const first = String(tokens[0] || '').toLowerCase();
  const rest = tokens.slice(1);
  if (!first) {
    const level = await ctx.level();
    if (!ctx.engine.perms.atLeast(level, 'mod')) return press(ctx);
    return showStatus(ctx);
  }
  if (/^(setup|set|start|wizard|config|configure|edit)$/.test(first)) return startWizard(ctx, rest[0] && STEPS.includes(rest[0].toLowerCase()) ? rest[0].toLowerCase() : 'role');
  if (/^(panel|post|repost)$/.test(first)) return repost(ctx);
  if (/^(status|check|show|info|settings)$/.test(first)) return showStatus(ctx);
  if (/^(test|try|preview|dryrun|dry-run)$/.test(first)) return testRun(ctx);
  if (/^(off|disable|stop|pause)$/.test(first)) return turnOff(ctx);
  if (/^(on|enable|resume)$/.test(first)) return turnOn(ctx);
  if (/^(unlock|unhide|show-channels)$/.test(first)) return unlock(ctx);
  if (/^(user|member|let|approve|manual)$/.test(first)) return verifyUser(ctx, rest.join(' '));
  if (/^(help|guide|how)$/.test(first)) return ctx.ephemeral({ embeds: [guideEmbed()] });
  if (/^(me|now|go)$/.test(first)) return press(ctx);
  if (/^<@|^@/.test(first)) return verifyUser(ctx, tokens.join(' '));
  const guess = didYouMean(first, SUBS);
  return ctx.warn("I didn't get that", `I don't know **${clip(first, 40)}**.${guess.length ? ` Did you mean ${guess.map((g) => `**${g}**`).join(', ')}?` : ''}\nTry **/verify setup**, **/verify status** or **/help verify**.`);
}

async function onJoin(ctx, ev) {
  const { engine, serverId: sid } = ctx;
  if (!sid || !ev?.user_id) return;
  const cfg = cfgOf(engine, sid);
  if (!cfg.enabled || !cfg.unverifiedRoleId) return;
  if (ev.user_id === engine.bot.me?.id) return;
  try {
    await engine.bot.addRole(sid, ev.user_id, cfg.unverifiedRoleId);
    engine.perms.invalidate(`m:${sid}:${ev.user_id}`);
  } catch (e) {
    if (looksLikeFeatureOff(e)) engine.caps.mark(sid, 'roles', false, e?.message);
    const name = await roleName(engine, sid, cfg.unverifiedRoleId);
    await alert(engine, sid, 'join', dialog.warn("New members aren't getting the Unverified role", `I couldn't give **${name || 'the Unverified role'}** to <@${ev.user_id}>. Run \`/verify status\` to see why.`));
  }
}

function migrateAll(engine) {
  let ids = [];
  try { ids = engine.settings.servers() || []; } catch (e) { engine.log.debug('verify could not list servers to migrate', e?.message); }
  let moved = 0;
  for (const sid of ids) {
    try { if (migrate(engine, sid)) moved++; } catch (e) { engine.log.warn(`[verify] could not move the verification settings for ${sid}: ${e?.message}`); }
  }
  if (moved) engine.log.info(`[verify] moved the verification gate from Automod for ${moved} server${moved === 1 ? '' : 's'}`);
}

const methodKey = (v) => {
  const k = String(v ?? '').trim().toLowerCase();
  return own(METHODS, k) ? k : own(METHOD_WORDS, k) ? METHOD_WORDS[k] : null;
};

const DASHBOARD = [
  {
    key: 'enabled', label: 'Verification on', type: 'boolean', web: false,
    help: 'Whether the Verify button gives the Verified role.',
    note: 'Turn it on with /verify setup in the server (it posts the Verify panel), and off with /verify off.',
  },
  {
    key: 'method', label: 'How people verify', type: 'select', web: true,
    help: 'A button press, picking a named emoji, a small sum, or agreeing to the rules.',
    options: Object.entries(METHODS).map(([value, m]) => ({ value, label: m.label })),
    validate: (ctx, v) => {
      const k = methodKey(v);
      return k ? accept(k) : reject('Pick button, emoji, math or rules.');
    },
  },
  {
    key: 'minAccountDays', label: 'Minimum account age (days)', type: 'number', web: true, min: 0, max: MAX_AGE_DAYS, step: 1,
    help: 'Accounts younger than this are turned away. 0 means no minimum.',
    validate: (ctx, v) => {
      const n = typeof v === 'number' ? v : /^\s*\d+\s*$/.test(String(v ?? '')) ? Number(v) : NaN;
      return Number.isInteger(n) && n >= 0 && n <= MAX_AGE_DAYS ? accept(n) : reject(`Use a whole number from 0 to ${MAX_AGE_DAYS}.`);
    },
  },
  {
    key: 'welcome', label: 'Welcome message', type: 'text', web: true, maxLength: 1000,
    help: 'What people see once they are verified. Placeholders: {user} {username} {server}. Leave it empty for the default.',
    validate: (ctx, v) => (v === null || v === undefined || typeof v === 'string' ? accept(clip(String(v ?? '').trim(), 1000)) : reject('Write the message as text.')),
  },
  {
    key: 'rulesText', label: 'Rules people agree to', type: 'text', web: true, maxLength: 1500,
    help: 'Shown when the method is Agree to rules. Leave it empty to point at your #rules channel with a short default list.',
    validate: (ctx, v) => (v === null || v === undefined || typeof v === 'string' ? accept(clip(String(v ?? '').trim(), 1500)) : reject('Write the rules as text.')),
  },
  { key: 'channelId', label: 'Verify channel', type: 'channel', web: false, help: 'Where the Verify button lives.', note: 'Pick it in the server with /verify setup, which posts the Verify panel there.' },
  { key: 'roleId', label: 'Verified role', type: 'role', web: false, help: 'The role people get after verifying.', note: 'Pick it in the server with /verify setup, which checks my role can hand it out.' },
  { key: 'unverifiedRoleId', label: 'Unverified role', type: 'role', web: false, help: 'Optional role new members get until they verify.', note: 'Pick it in the server with /verify setup.' },
];

export const { setup, teardown, check } = defineApp({
  id: ID,
  name: 'Verify',
  icon: ICON,
  description: 'A verification gate: new people prove they are real before they see the server.',
  category: 'Security',
  defaults: DEFAULTS,

  commands: {
    verify: {
      description: 'Verification gate. /verify setup walks you through it. Also: status, test, panel, off, user @name',
      run: runVerify,
    },
  },

  components: {
    go: { run: press },
    ans: { owner: true, ownerArg: 0, run: answer },
    nope: { owner: true, ownerArg: 0, run: decline },
    setup: { perm: 'admin', run: (ctx) => startWizard(ctx, ctx.argv[0] || 'role') },
    status: { perm: 'mod', run: showStatus },
    repost: { perm: 'admin', run: repost },
    test: { perm: 'admin', run: testRun },
    off: { perm: 'admin', run: turnOff },
    on: { perm: 'admin', run: turnOn },
    unlock: { perm: 'admin', run: unlock },
    guide: { run: (ctx) => ctx.ephemeral({ embeds: [guideEmbed()] }) },
    wgo: {
      perm: 'admin',
      run: (ctx) => wizardAction(ctx, (d) => {
        const step = ctx.argv[1];
        if (STEPS.includes(step)) d.step = step;
        return renderStep(ctx, d);
      }),
    },
    wpick: {
      perm: 'admin',
      run: (ctx) => wizardAction(ctx, (d) => {
        const [, kind, value] = ctx.argv;
        if (kind === 'role' || kind === 'urole') return pickRole(ctx, d, kind, value);
        if (kind === 'chan') return pickChannel(ctx, d, value);
        if (kind === 'method' && own(METHODS, value)) { d.method = value; d.step = 'age'; return renderStep(ctx, d); }
        if (kind === 'age' && AGES.includes(Number(value))) { d.minAccountDays = Number(value); d.step = 'message'; return renderStep(ctx, d); }
        if (kind === 'msg') { d.welcome = ''; d.rulesText = ''; d.step = 'lock'; return renderStep(ctx, d); }
        return renderStep(ctx, d);
      }),
    },
    wsel: {
      perm: 'admin',
      run: (ctx) => wizardAction(ctx, (d) => {
        const kind = ctx.argv[1];
        const value = Array.isArray(ctx.values) ? ctx.values[0] : null;
        if (!value) return renderStep(ctx, d);
        if (kind === 'chan') return pickChannel(ctx, d, value);
        return pickRole(ctx, d, kind === 'urole' ? 'urole' : 'role', value);
      }),
    },
    wmk: {
      perm: 'admin',
      run: (ctx) => wizardAction(ctx, (d) => (ctx.argv[1] === 'chan' ? makeChannel(ctx, d) : makeRole(ctx, d, ctx.argv[1] === 'urole' ? 'urole' : 'role'))),
    },
    wform: {
      perm: 'admin',
      run: (ctx) => wizardAction(ctx, (d) => {
        const fields = [{ id: 'welcome', label: 'Welcome message', style: 'paragraph', required: false, value: d.welcome || DEFAULT_WELCOME, max: 1000, placeholder: DEFAULT_WELCOME }];
        if (d.method === 'rules') fields.push({ id: 'rules', label: 'Rules people agree to', style: 'paragraph', required: false, value: d.rulesText || '', max: 1500, placeholder: 'Be kind. No spam. No NSFW.' });
        return ctx.form({ title: 'Verify messages', action: 'wsave', args: [d.id], fields });
      }),
    },
    wsave: {
      perm: 'admin',
      run: (ctx) => wizardAction(ctx, (d) => {
        const v = ctx.values || {};
        const welcome = String(v.welcome ?? '').trim();
        d.welcome = welcome && welcome !== DEFAULT_WELCOME ? clip(welcome, 1000) : '';
        if (v.rules !== undefined) d.rulesText = clip(String(v.rules ?? '').trim(), 1500);
        d.note = dialog.ok('Saved', 'Your message is ready. It goes live when you press **Finish**.');
        d.step = 'lock';
        return renderStep(ctx, d);
      }),
    },
    wlock: {
      perm: 'admin',
      run: (ctx) => wizardAction(ctx, (d) => {
        d.lock = ctx.argv[1] === 'yes';
        d.step = 'summary';
        return renderStep(ctx, d);
      }),
    },
    wfin: { perm: 'admin', run: (ctx) => wizardAction(ctx, (d) => finish(ctx, d)) },
    wcancel: {
      perm: 'admin',
      run: (ctx) => wizardAction(ctx, async (d) => {
        ctx.engine.router.dropSession(d.id);
        const made = d.created.roles.length + d.created.channels.length;
        if (made) await ctx.update({ embeds: [dialog.info('Canceling', 'Removing what I made during setup.')], components: [] });
        const gone = await cleanupCreated(ctx.engine, d.sid, d.created);
        return ctx.update({ embeds: [dialog.info('Setup canceled', `Nothing was changed.${gone.length ? ` I removed the ${gone.length === 1 ? gone[0] : 'role and channel'} I made.` : ''}`)], components: [] });
      }),
    },
  },

  events: {
    member_join: onJoin,
  },

  yap: [{ words: ['verify', 'verification', 'captcha', 'gate'], run: runVerify }],

  panelPerm: 'mod',
  panel: (ctx) => showStatus(ctx),

  dashboard: DASHBOARD,

  services: (engine) => ({
    press: (ctx) => press(ctx),
    migrate: (sid) => migrate(engine, sid),
    config: (sid) => cfgOf(engine, sid),
  }),

  help: [
    '**Set it up:** run `/verify setup` and follow the buttons. Pick (or let me make) a **Verified** role and a **#verify** channel, choose the check, and press **Finish**.',
    '**Checks:** one button, pick the emoji I name, answer a small sum, or agree to the rules. You can also turn away accounts younger than a few days.',
    '**Hide channels:** setup can hide your other channels until people verify. It lists every permission change first, and Undo puts them all back.',
    '**Example:** Sam joins, only sees #verify, presses **Verify**, picks the 🐱, gets **Verified** and can now see everything.',
    '**Broken?** `/verify status` shows what is wrong (role above mine, missing Manage Roles, deleted channel) with buttons to fix it. `/verify test` tries it as a new member.',
    '`/verify user @sam` lets someone in by hand. `/verify off` pauses it. Verification moved here from Automod; old Verify buttons keep working.',
  ],

  init(engine) {
    migrateAll(engine);
  },
});
