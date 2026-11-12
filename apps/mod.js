import { defineApp } from '../engine/apps.js';
import { card, dialog, button, row, ICONS } from '../engine/ui.js';
import { customId } from '../engine/router.js';
import { tokenize, parseDuration, takeDuration, formatDuration, didYouMean, fuzzyFind, normalizeName, userId, clip } from '../engine/parse.js';
import { friendly, permName, explain, looksLikeFeatureOff } from '../engine/errors.js';

const ID = 'mod';
const cid = (action, ...args) => customId(ID, action, ...args);

const MAX_TIMEOUT_MIN = 40320;
const MAX_SLOWMODE_S = 21600;
const DAY_MS = 864e5;
const MAX_CASES = 2000;
const MAX_WARNS = 2000;
const STEPS_MAX = 1000;
const STEPS_COUNT_MAX = 20;
const PURGE_BUTTON_DEFAULT = 10;

const DEFAULT_ESCALATION = [
  { at: 3, action: 'timeout', durationMs: 3600000 },
  { at: 5, action: 'kick' },
  { at: 7, action: 'ban' },
];
const STRICT_ESCALATION = [
  { at: 2, action: 'timeout', durationMs: 3600000 },
  { at: 3, action: 'timeout', durationMs: DAY_MS },
  { at: 4, action: 'kick' },
  { at: 5, action: 'ban' },
];

const ACTIONS = {
  timeout: { perm: 'timeout_members', verb: 'time out', title: 'Timed out', dm: 'timed out in' },
  untimeout: { perm: 'timeout_members', verb: 'remove the timeout for', title: 'Timeout removed' },
  kick: { perm: 'kick_members', verb: 'kick', title: 'Kicked', dm: 'kicked from' },
  ban: { perm: 'ban_members', verb: 'ban', title: 'Banned', dm: 'banned from' },
  unban: { perm: 'ban_members', verb: 'unban', title: 'Unbanned', skipHierarchy: true },
  warn: { perm: null, verb: 'warn', title: 'Warned' },
};

const ACTION_LABELS = {
  timeout: 'Timeout', untimeout: 'Timeout removed', kick: 'Kick', ban: 'Ban', unban: 'Unban', warn: 'Warning',
  purge: 'Purge', lock: 'Lock', unlock: 'Unlock', slowmode: 'Slowmode', unwarn: 'Warning removed',
};
const ACTION_ICONS = {
  timeout: '⏳', untimeout: '⌛', kick: '👢', ban: '🔨', unban: '🕊️', warn: '⚠️', purge: '🧹',
  lock: ICONS.lock, unlock: ICONS.unlock, slowmode: '🐢', unwarn: ICONS.undo,
};

const SUB_ALIASES = {
  timeout: 'timeout', mute: 'timeout', untimeout: 'untimeout', unmute: 'untimeout', kick: 'kick', ban: 'ban',
  unban: 'unban', warn: 'warn', warnings: 'warnings', warns: 'warnings', case: 'case', cases: 'cases',
  history: 'cases', purge: 'purge', clear: 'purge', slowmode: 'slowmode', slow: 'slowmode', lock: 'lock',
  unlock: 'unlock', settings: 'settings', config: 'settings', panel: 'panel', home: 'panel',
  log: 'log', logs: 'log', modlog: 'log', logchannel: 'log',
  modrole: 'modrole', modroles: 'modrole', staff: 'modrole',
  adminrole: 'adminrole', adminroles: 'adminrole',
};

const STAFF_KINDS = {
  modrole: { key: 'modRoles', label: 'mod role', who: 'admin', usage: '`/mod modrole add @Helpers`, `/mod modrole remove @Helpers`' },
  adminrole: { key: 'adminRoles', label: 'admin role', who: 'owner', usage: '`/mod adminrole add @Managers`, `/mod adminrole remove @Managers`' },
};

const USAGE = {
  timeout: '`/mod timeout @sam 10m spamming` (a bare number means minutes, `off` clears it; with no length I ask how long)',
  untimeout: '`/mod untimeout @sam`',
  kick: '`/mod kick @sam reason`',
  ban: '`/mod ban @sam reason`',
  unban: '`/mod unban <user id or mention>`',
  warn: '`/mod warn @sam reason`',
  warnings: '`/mod warnings @sam`',
  purge: '`/mod purge 20` or `/mod purge 20 @sam`',
  slowmode: '`/mod slowmode 10s` or `/mod slowmode off`',
};

const emptyData = () => ({ seq: 0, cases: [], warns: [], locks: {} });

function readData(engine, sid) {
  return { ...emptyData(), ...engine.store.get(ID, sid, emptyData()) };
}

function writeData(engine, sid, fn) {
  let out;
  engine.store.update(ID, sid, (d) => {
    const full = { ...emptyData(), ...d };
    out = fn(full);
    return full;
  }, emptyData());
  return out;
}

const tag = (user) => (user?.username ? `@${user.username}` : user?.id ? `<@${user.id}>` : 'them');

async function nameFor(engine, sid, uid) {
  if (!uid) return null;
  if (uid === engine.bot.me?.id) return '@YapOS';
  const members = await engine.cache.members(sid).catch(() => []);
  const m = members.find((x) => x.id === uid);
  return m ? `@${m.username}` : `<@${uid}>`;
}

const when = (at) => `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
const ago = (at) => `${formatDuration(Math.max(1000, Date.now() - at))} ago`;

function caseLine(c) {
  const dur = c.durationMs ? ` · ${formatDuration(c.durationMs)}` : '';
  const why = c.reason ? ` · ${clip(c.reason, 60)}` : '';
  const undone = c.undone ? ' · *undone*' : '';
  return `\`#${c.id}\` ${ACTION_ICONS[c.action] || '•'} **${ACTION_LABELS[c.action] || c.action}** ${c.targetName || ''}${dur}${why} · ${ago(c.at)}${undone}`;
}

function caseEmbed(c, extra = '') {
  const fields = [
    { name: 'Who', value: c.targetName || (c.targetId ? `<@${c.targetId}>` : '-'), inline: true },
    { name: 'By', value: c.actorName || (c.actorId ? `<@${c.actorId}>` : '-'), inline: true },
    { name: 'When', value: when(c.at), inline: true },
  ];
  if (c.durationMs) fields.push({ name: 'Length', value: formatDuration(c.durationMs), inline: true });
  if (c.channelId) fields.push({ name: 'Channel', value: `<#${c.channelId}>`, inline: true });
  if (c.source && c.source !== 'mod') fields.push({ name: 'Source', value: c.source === 'automod' ? 'Automod' : 'Manual', inline: true });
  if (c.undone) fields.push({ name: 'Status', value: 'Undone', inline: true });
  return card({
    title: `${ACTION_ICONS[c.action] || ICONS.mod} Case #${c.id}: ${ACTION_LABELS[c.action] || c.action}`,
    body: `${c.reason ? `**Reason:** ${c.reason}` : '*No reason given.*'}${extra ? `\n${extra}` : ''}`,
    fields,
    color: 'mod',
  });
}

function activeWarns(engine, sid, targetId, data = readData(engine, sid)) {
  const days = Number(engine.settings.appConfig(sid, ID).warnDecayDays) || 0;
  const cutoff = days > 0 ? Date.now() - days * DAY_MS : -Infinity;
  return data.warns.filter((w) => w.targetId === targetId && w.at >= cutoff);
}

function clampMinutes(ms) {
  if (!ms || ms <= 0) return 0;
  return Math.min(MAX_TIMEOUT_MIN, Math.max(1, Math.ceil(ms / 60000)));
}

function createService(engine) {
  const { bot } = engine;

  async function log(serverId, embed) {
    const channelId = engine.settings.core(serverId).logChannel;
    if (!channelId || !embed) return null;
    return engine.budget.send({ serverId, channelId, opts: { embeds: [embed] }, priority: 'low' }).catch((e) => {
      engine.log.debug('mod log failed', e?.message);
      return null;
    });
  }

  async function addCase(serverId, { action, targetId = null, actorId = null, reason = '', durationMs = null, source = 'mod', targetName, actorName, channelId = null, meta } = {}) {
    const tName = targetName ?? await nameFor(engine, serverId, targetId);
    const aName = actorName ?? await nameFor(engine, serverId, actorId);
    return writeData(engine, serverId, (d) => {
      d.seq += 1;
      const c = { id: d.seq, action, targetId, targetName: tName, actorId, actorName: aName, reason: String(reason || '').slice(0, 500), durationMs: durationMs || null, at: Date.now(), source, channelId };
      if (meta) c.meta = meta;
      d.cases.push(c);
      if (d.cases.length > MAX_CASES) d.cases.splice(0, d.cases.length - MAX_CASES);
      return c;
    });
  }

  async function timeout(serverId, targetId, { actorId = null, durationMs = 0, reason = '', source = 'mod', targetName, actorName } = {}) {
    const minutes = clampMinutes(durationMs);
    await bot.timeout(serverId, targetId, minutes, String(reason || '').slice(0, 200));
    const c = await addCase(serverId, { action: minutes ? 'timeout' : 'untimeout', targetId, actorId, reason, durationMs: minutes * 60000, source, targetName, actorName });
    log(serverId, caseEmbed(c));
    return c;
  }

  async function escalate(serverId, targetId, rule, { count, source, targetName }) {
    const reason = `Reached ${count} warnings`;
    const actorId = bot.me?.id ?? null;
    const durationMs = rule.action === 'timeout' ? clampMinutes(rule.durationMs || 3600000) * 60000 : null;
    try {
      let c;
      if (rule.action === 'timeout') c = await timeout(serverId, targetId, { actorId, durationMs, reason, source, targetName });
      else {
        if (rule.action === 'kick') await bot.kick(serverId, targetId);
        else if (rule.action === 'ban') await bot.ban(serverId, targetId);
        else return null;
        c = await addCase(serverId, { action: rule.action, targetId, actorId, reason, source, targetName });
        log(serverId, caseEmbed(c));
      }
      return { action: rule.action, durationMs, ok: true, case: c };
    } catch (error) {
      return { action: rule.action, durationMs, ok: false, error };
    }
  }

  async function warn(serverId, targetId, { actorId = null, reason = '', source = 'mod', targetName, actorName } = {}) {
    const c = await addCase(serverId, { action: 'warn', targetId, actorId, reason, source, targetName, actorName });
    writeData(engine, serverId, (d) => {
      d.warns.push({ caseId: c.id, targetId, at: c.at, reason: c.reason });
      if (d.warns.length > MAX_WARNS) d.warns.splice(0, d.warns.length - MAX_WARNS);
    });
    const count = activeWarns(engine, serverId, targetId).length;
    const rules = [].concat(engine.settings.appConfig(serverId, ID).escalation || []);
    const rule = rules.find((r) => Number(r.at) === count);
    log(serverId, caseEmbed(c, `They now have **${count}** active warning${count === 1 ? '' : 's'}.`));
    const escalated = rule ? await escalate(serverId, targetId, rule, { count, source, targetName: c.targetName }) : null;
    return { case: c, count, escalated };
  }

  return { addCase, warn, timeout, log };
}

const svc = (ctx) => ctx.engine.service(ID) || createService(ctx.engine);

function refreshRoles(engine, serverId, userId) {
  if (!serverId || !userId) return;
  engine.perms.invalidate(`m:${serverId}:${userId}`);
  engine.perms.invalidate(`r:${serverId}`);
}

const freshlyChecked = new WeakSet();

async function requireFresh(ctx, need) {
  if (!freshlyChecked.has(ctx)) {
    refreshRoles(ctx.engine, ctx.serverId, ctx.userId);
    freshlyChecked.add(ctx);
  }
  return ctx.require(need);
}

async function checkRank(engine, serverId, actorId, targetId, def, label) {
  refreshRoles(engine, serverId, targetId);
  const title = `I can't ${def.verb} ${label}`;
  const can = await engine.perms.canActOn(serverId, targetId, { actorId });
  if (!can.ok) throw friendly(can.reason, { title });
  const { LEVELS } = engine.perms;
  const [mine, theirs] = await Promise.all([engine.perms.level(serverId, actorId), engine.perms.level(serverId, targetId)]);
  if (LEVELS.indexOf(theirs) > LEVELS.indexOf(mine)) {
    throw friendly(`${label} is an admin here, so only admins or the server owner can ${def.verb} them.`, { title, need: theirs === 'owner' ? 'owner' : 'admin' });
  }
}

async function channelIsHere(ctx, channelId) {
  if (!ctx.serverId || !channelId) return false;
  const known = await ctx.channels().catch(() => []);
  if (known.some((c) => c.id === channelId)) return true;
  const ch = await ctx.bot.channel(channelId).catch(() => null);
  return !!ch && (ch.server_id ?? ctx.serverId) === ctx.serverId;
}

async function needChannelHere(ctx, channelId) {
  if (await channelIsHere(ctx, channelId)) return;
  throw friendly("That channel isn't part of this server, so I left it alone.", { title: 'Wrong place' });
}

async function checkCanAct(ctx, targetId, def, label) {
  const { engine, serverId } = ctx;
  if (def.perm && !(await engine.perms.actorCan(serverId, ctx.userId, def.perm))) {
    throw friendly(`You need **${permName(def.perm)}** to ${def.verb} people.`, { title: 'Needs Mod', need: 'mod', hint: 'Ask an admin to tick it on your role, or an admin can make your role a mod role with `/mod modrole add @role`.' });
  }
  if (!def.skipHierarchy) await checkRank(engine, serverId, ctx.userId, targetId, def, label);
  if (targetId === ctx.userId) throw friendly("You can't do that to yourself.", { title: `I can't ${def.verb} ${label}` });
  await needBotPerm(ctx, def.perm, `${def.verb} ${label}`);
}

async function needBotPerm(ctx, perms, what) {
  const list = [].concat(perms || []);
  if (!list.length) return;
  for (const p of list) {
    const can = await ctx.engine.perms.botCan(ctx.serverId, p);
    if (can.ok) return;
  }
  const botRole = await ctx.engine.perms.botRoleName(ctx.serverId).catch(() => 'my role');
  throw friendly(`My role needs **${list.map(permName).join('** or **')}** to ${what}.`, {
    title: `I can't ${what}`,
    hint: `Fix: Server settings → Roles → **${botRole}** → tick ${list.map(permName).join(' or ')}.`,
  });
}

async function takeTarget(ctx, tokens) {
  const first = tokens[0];
  if (!first) return { user: null, rest: [] };
  const user = await ctx.findUser(first);
  if (!user) throw friendly(`I couldn't find **${clip(first, 40)}** here. Mention them, like @sam, or use their user id.`, { title: 'Who do you mean?' });
  return { user, rest: tokens.slice(1) };
}

async function tryDm(ctx, userId, text) {
  const { engine, serverId } = ctx;
  if (!ctx.config().dmOnAction) return 'off';
  if (engine.caps.state(serverId, 'dms') === false) return 'failed';
  try {
    await ctx.bot.dmSend(userId, text);
    engine.caps.mark(serverId, 'dms', true);
    return 'sent';
  } catch (e) {
    if (looksLikeFeatureOff(e)) engine.caps.mark(serverId, 'dms', false, e?.message);
    return 'failed';
  }
}

async function dmText(ctx, def, reason, durationMs) {
  const server = await ctx.engine.perms.server(ctx.serverId).catch(() => null);
  const name = server?.name || 'the server';
  const length = durationMs ? ` for ${formatDuration(durationMs)}` : '';
  return `You were ${def.dm} **${name}**${length}.${reason ? `\nReason: ${reason}` : ''}`;
}

const dmNote = (state) => (state === 'failed' ? "\n-# I couldn't DM them about it (their DMs may be closed)." : state === 'sent' ? '\n-# I sent them a DM about it.' : '');

async function actorName(ctx) {
  return nameFor(ctx.engine, ctx.serverId, ctx.userId);
}

async function undoReply(i, embed) {
  await i.ephemeral('', { embeds: [embed] });
}

async function refuseUnless(ctx, need) {
  try {
    await requireFresh(ctx, need);
    return false;
  } catch (e) {
    await ctx.fail(e);
    return true;
  }
}

const staff = (need, fn) => async (ctx) => ((await refuseUnless(ctx, need)) ? undefined : fn(ctx));

async function undoGate(ctx, i, def = {}, targetId = null, label = 'them') {
  const { engine, serverId } = ctx;
  if (!engine.settings.isEnabled(serverId, ID)) {
    throw friendly('Undo buttons from Mod are switched off while it is uninstalled. An admin can install it again with **/apps**.', { title: "Mod isn't installed here" });
  }
  refreshRoles(engine, serverId, i.user_id);
  await engine.perms.require(serverId, i.user_id, 'mod');
  if (def.perm && !(await engine.perms.actorCan(serverId, i.user_id, def.perm))) {
    throw friendly(`You need **${permName(def.perm)}** to ${def.verb} people, so you can't undo this one.`, { title: 'Needs Mod', need: 'mod' });
  }
  if (targetId && !def.skipHierarchy && i.user_id !== ctx.userId) await checkRank(engine, serverId, i.user_id, targetId, def, label);
}

const CLEAR_WORDS = /^(off|0|none|clear|stop|remove)$/i;
const FOREVER_WORDS = /^(forever|permanent|permanently|perm|perma|permaban|infinite|infinity|always|indefinite|indefinitely|eternity|eternal|unlimited|never|max|maximum|lifetime|life)$/i;
const TIMEOUT_CHOICES = ['10m', '1h', '1d', '1w'];
const SLOWMODE_CHOICES = ['10s', '30s', '1m', '5m', 'off'];

const looksLikeLength = (word) => FOREVER_WORDS.test(word || '') || /^\d/.test(word || '');

function expiredQuestion(ctx) {
  return ctx.warn('That question has expired', 'Run the command again and I will ask again.');
}

function ownQuestion(ctx, s, kind) {
  return !!s && s.kind === kind && s.serverId === ctx.serverId && s.userId === ctx.userId;
}

function cancelled(ctx) {
  return ctx.update({ embeds: [dialog.info('Cancelled', 'Nothing changed.')], components: [] });
}

async function runAction(ctx, kind, tokens) {
  const def = ACTIONS[kind];
  const { user, rest } = await takeTarget(ctx, tokens);
  if (!user) return ctx.warn(`Who should I ${def.verb}?`, `Try ${USAGE[kind]}.`);
  if (kind !== 'timeout') return performAction(ctx, kind, user, { reason: rest.join(' ') });
  if (CLEAR_WORDS.test(rest[0] || '')) return performAction(ctx, 'untimeout', user, { reason: rest.slice(1).join(' ') });
  const d = takeDuration(rest);
  if (d.ms === null) return askTimeoutLength(ctx, user, rest);
  const reason = d.rest.join(' ');
  if (d.ms <= 0) return performAction(ctx, 'untimeout', user, { reason });
  const durationMs = clampMinutes(d.ms) * 60000;
  const note = d.ms > MAX_TIMEOUT_MIN * 60000 ? '\n-# Yapin\' timeouts go up to 28 days, so I used that.' : '';
  return performAction(ctx, 'timeout', user, { durationMs, reason, note });
}

async function askTimeoutLength(ctx, user, words) {
  const label = tag(user);
  try {
    await checkCanAct(ctx, user.id, ACTIONS.timeout, label);
  } catch (e) {
    return ctx.fail(e, { action: ACTIONS.timeout.verb, perm: ACTIONS.timeout.perm, target: label });
  }
  const tried = looksLikeLength(words[0]);
  const forever = FOREVER_WORDS.test(words[0] || '');
  const reason = (tried ? words.slice(1) : words).join(' ').slice(0, 200);
  const sid = ctx.engine.router.session({ kind: 'timeout', userId: ctx.userId, serverId: ctx.serverId, targetId: user.id, reason });
  const question = `How long should ${label} be timed out?`;
  const lead = forever
    ? "I can't time someone out forever. The longest is 28 days."
    : tried ? `I didn't understand **${clip(words[0], 30)}** as a length.` : '';
  const body = [lead, question, reason ? `**Reason:** ${reason}` : '', '-# You can also type it, like `/timeout @sam 2h30m spam`.'].filter(Boolean).join('\n');
  const buttons = [...TIMEOUT_CHOICES.map((c) => button(c, cid('tlen', sid, c), 'primary')), button('Cancel', cid('tlen', sid, 'cancel'), 'secondary')];
  return ctx.ephemeral({ embeds: [dialog.warn(forever ? 'Too long' : 'How long?', body, { color: 'mod' })], components: [row(...buttons)] });
}

async function pickTimeoutLength(ctx) {
  const [sid, choice] = ctx.argv;
  const s = ctx.engine.router.getSession(sid);
  if (!ownQuestion(ctx, s, 'timeout')) return expiredQuestion(ctx);
  ctx.engine.router.dropSession(sid);
  if (choice === 'cancel') return cancelled(ctx);
  if (!TIMEOUT_CHOICES.includes(choice)) return expiredQuestion(ctx);
  const user = (await ctx.findUser(s.targetId)) || { id: s.targetId };
  const durationMs = clampMinutes(parseDuration(choice)) * 60000;
  return performAction(ctx, 'timeout', user, { durationMs, reason: s.reason, respond: (p) => ctx.update(p) });
}

async function performAction(ctx, kind, user, { durationMs = null, reason: rawReason = '', note = '', respond } = {}) {
  const def = ACTIONS[kind];
  const label = tag(user);
  const reason = String(rawReason || '').slice(0, 200);
  const answer = respond || ((p) => ctx.reply(p));
  try {
    await checkCanAct(ctx, user.id, def, label);
    const aName = await actorName(ctx);
    const base = { actorId: ctx.userId, reason, source: 'mod', targetName: label, actorName: aName };
    const service = svc(ctx);
    if (kind === 'warn') return await replyWarn(ctx, user, label, base, service, answer);
    let dm = 'off';
    if (def.dm && kind !== 'timeout') dm = await tryDm(ctx, user.id, await dmText(ctx, def, reason, durationMs));
    let c;
    let undo = null;
    if (kind === 'timeout' || kind === 'untimeout') {
      c = await service.timeout(ctx.serverId, user.id, { ...base, durationMs: kind === 'timeout' ? durationMs : 0 });
      if (kind === 'timeout') {
        dm = await tryDm(ctx, user.id, await dmText(ctx, def, reason, durationMs));
        undo = ctx.engine.router.addUndo({
          serverId: ctx.serverId, actorId: ctx.userId, label: `timeout for ${label}`,
          manual: `/mod untimeout ${label}`,
          run: (i) => undoTimeout(ctx, i, user, label, c),
        });
      }
    } else {
      if (kind === 'kick') await ctx.bot.kick(ctx.serverId, user.id);
      if (kind === 'ban') await ctx.bot.ban(ctx.serverId, user.id);
      if (kind === 'unban') await ctx.bot.unban(ctx.serverId, user.id);
      c = await service.addCase(ctx.serverId, { action: kind, targetId: user.id, ...base });
      service.log(ctx.serverId, caseEmbed(c));
      if (kind === 'ban') {
        undo = ctx.engine.router.addUndo({
          serverId: ctx.serverId, actorId: ctx.userId, label: `ban of ${label}`,
          manual: `/mod unban ${user.id}`,
          run: (i) => undoBan(ctx, i, user, label, c),
        });
      }
    }
    const length = c.durationMs ? ` for **${formatDuration(c.durationMs)}**` : '';
    const body = `${label}${length}.${reason ? `\n**Reason:** ${reason}` : ''}\n-# Case #${c.id}${note}${dmNote(dm)}`;
    return answer({ embeds: [dialog.ok(def.title, body, { color: 'mod' })], components: undo ? [row(undo.button)] : [] });
  } catch (e) {
    return ctx.fail(e, { action: def.verb, perm: def.perm, target: label });
  }
}

async function replyWarn(ctx, user, label, base, service, answer = (p) => ctx.reply(p)) {
  const out = await service.warn(ctx.serverId, user.id, base);
  const days = Number(ctx.config().warnDecayDays) || 0;
  const span = days > 0 ? ` in the last ${days} day${days === 1 ? '' : 's'}` : '';
  const lines = [`${label} now has **${out.count}** warning${out.count === 1 ? '' : 's'}${span}.`];
  if (base.reason) lines.push(`**Reason:** ${base.reason}`);
  const esc = out.escalated;
  if (esc?.ok) {
    const what = esc.action === 'timeout' ? `timed them out for **${formatDuration(esc.durationMs)}**` : esc.action === 'kick' ? 'kicked them' : 'banned them';
    lines.push(`That's ${out.count} warnings, so I ${what} (case #${esc.case.id}).`);
  } else if (esc) {
    const { body } = explain(esc.error, { action: ACTIONS[esc.action]?.verb, perm: ACTIONS[esc.action]?.perm, target: label });
    lines.push(`That's ${out.count} warnings, so I tried to ${ACTIONS[esc.action]?.verb || esc.action} them, but it didn't work: ${body}`);
  }
  lines.push(`-# Case #${out.case.id}`);
  const undo = ctx.engine.router.addUndo({
    serverId: ctx.serverId, actorId: ctx.userId, label: `warning for ${label}`,
    manual: `/mod warnings ${label}`,
    run: (i) => undoWarn(ctx, i, user, label, out),
  });
  return answer({ embeds: [dialog.warn('Warned', lines.join('\n'), { color: 'mod' })], components: [row(undo.button)] });
}

function markUndone(engine, sid, caseId) {
  writeData(engine, sid, (d) => { const c = d.cases.find((x) => x.id === caseId); if (c) c.undone = true; });
}

async function guardedUndo(i, explainCtx, work) {
  try {
    await work();
  } catch (e) {
    const { title, body, embed } = explain(e, explainCtx);
    await undoReply(i, embed || dialog.error(title, body));
  }
}

async function undoBan(ctx, i, user, label, c) {
  await guardedUndo(i, { action: 'unban', perm: 'ban_members', target: label }, async () => {
    await undoGate(ctx, i, ACTIONS.unban, user.id, label);
    await ctx.bot.unban(ctx.serverId, user.id);
    markUndone(ctx.engine, ctx.serverId, c.id);
    const service = svc(ctx);
    const u = await service.addCase(ctx.serverId, { action: 'unban', targetId: user.id, actorId: i.user_id, reason: `Undo of case #${c.id}`, targetName: label });
    service.log(ctx.serverId, caseEmbed(u));
    await undoReply(i, dialog.ok('Ban undone', `${label} is unbanned. They can join again with an invite.\n-# Case #${u.id}`));
  });
}

async function undoTimeout(ctx, i, user, label, c) {
  await guardedUndo(i, { action: 'remove the timeout for', perm: 'timeout_members', target: label }, async () => {
    await undoGate(ctx, i, ACTIONS.untimeout, user.id, label);
    const u = await svc(ctx).timeout(ctx.serverId, user.id, { actorId: i.user_id, durationMs: 0, reason: `Undo of case #${c.id}`, targetName: label });
    markUndone(ctx.engine, ctx.serverId, c.id);
    await undoReply(i, dialog.ok('Timeout cleared', `${label} can talk again.\n-# Case #${u.id}`));
  });
}

async function undoWarn(ctx, i, user, label, out) {
  await guardedUndo(i, { action: 'undo the warning for', target: label }, async () => {
    await undoGate(ctx, i);
    const esc = out.escalated;
    const reverses = esc?.ok && (esc.action === 'ban' ? ACTIONS.unban : esc.action === 'timeout' ? ACTIONS.untimeout : null);
    if (reverses && i.user_id !== ctx.userId) await undoGate(ctx, i, reverses, user.id, label);
    writeData(ctx.engine, ctx.serverId, (d) => { d.warns = d.warns.filter((w) => w.caseId !== out.case.id); });
    markUndone(ctx.engine, ctx.serverId, out.case.id);
    const notes = [];
    if (esc?.ok && (esc.action === 'timeout' || esc.action === 'ban')) {
      const isBan = esc.action === 'ban';
      const reversed = await (isBan ? ctx.bot.unban(ctx.serverId, user.id) : ctx.bot.timeout(ctx.serverId, user.id, 0)).then(() => true, () => false);
      if (reversed) {
        markUndone(ctx.engine, ctx.serverId, esc.case.id);
        notes.push(isBan ? 'I also lifted the ban it caused.' : 'I also cleared the timeout it caused.');
      } else notes.push(isBan ? "I couldn't lift the ban it caused, so do that by hand." : "I couldn't clear the timeout it caused, so do that by hand.");
    } else if (esc?.ok && esc.action === 'kick') notes.push("It also caused a kick, which can't be undone. They can rejoin with an invite.");
    const service = svc(ctx);
    const u = await service.addCase(ctx.serverId, { action: 'unwarn', targetId: user.id, actorId: i.user_id, reason: `Undo of case #${out.case.id}`, targetName: label });
    service.log(ctx.serverId, caseEmbed(u));
    const count = activeWarns(ctx.engine, ctx.serverId, user.id).length;
    await undoReply(i, dialog.ok('Warning removed', [`${label} is back to **${count}** warning${count === 1 ? '' : 's'}.`, ...notes].join('\n')));
  });
}

async function runPurge(ctx, tokens) {
  let count = 20;
  let user = null;
  for (const t of tokens) {
    if (/^\d+$/.test(t)) count = Number(t);
    else if (!user) {
      user = await ctx.findUser(t);
      if (!user) return ctx.warn('Who do you mean?', `I couldn't find **${clip(t, 40)}** here. Try ${USAGE.purge}.`);
    }
  }
  count = Math.max(1, Math.min(100, count));
  const label = user ? tag(user) : null;
  try {
    if (!(await ctx.engine.perms.actorCan(ctx.serverId, ctx.userId, 'manage_messages'))) {
      throw friendly(`You need **${permName('manage_messages')}** to clear messages.`, { title: 'Needs Mod', need: 'mod', hint: 'Ask an admin to tick it on your role, or an admin can make your role a mod role with `/mod modrole add @role`.' });
    }
    await needChannelHere(ctx, ctx.channelId);
    await needBotPerm(ctx, 'manage_messages', 'delete messages');
  } catch (e) {
    return ctx.fail(e, { action: 'delete messages', perm: 'manage_messages' });
  }
  const ack = await ctx.info('Clearing messages', `Looking for the last **${count}** message${count === 1 ? '' : 's'}${label ? ` from ${label}` : ''}. I'll tell you when it's done.`);
  try {
    const recent = (await ctx.bot.messages(ctx.channelId, 100)) || [];
    const skip = new Set([ctx.source?.id, ack?.id].filter(Boolean));
    const picked = recent.filter((m) => !skip.has(m.id) && (!user || m.author_id === user.id)).slice(-count);
    if (!picked.length) return ctx.info('Nothing to clear', label ? `I didn't see any recent messages from ${label} here.` : "I didn't see any recent messages here.");
    const res = await ctx.bot.bulkDelete(ctx.channelId, picked.map((m) => m.id));
    const deleted = Array.isArray(res?.deleted) ? res.deleted.length : picked.length;
    const skipped = Array.isArray(res?.skipped) ? res.skipped.length : 0;
    const service = svc(ctx);
    const c = await service.addCase(ctx.serverId, { action: 'purge', targetId: user?.id ?? null, targetName: label, actorId: ctx.userId, reason: `${deleted} message${deleted === 1 ? '' : 's'} deleted${skipped ? `, ${skipped} skipped` : ''}`, channelId: ctx.channelId });
    service.log(ctx.serverId, caseEmbed(c));
    const skippedNote = skipped ? `\n${skipped} couldn't be removed. Yapin' only bulk deletes messages from the last 14 days.` : '';
    return ctx.ok(`Cleared ${deleted} message${deleted === 1 ? '' : 's'}`, `${label ? `From ${label} in` : 'In'} <#${ctx.channelId}>.${skippedNote}\n-# Case #${c.id}. Deleted messages can't be brought back.`);
  } catch (e) {
    return ctx.fail(e, { action: 'delete those messages', perm: 'manage_messages' });
  }
}

async function currentChannel(ctx, channelId = ctx.channelId) {
  await needChannelHere(ctx, channelId);
  const all = await ctx.channels().catch(() => []);
  return all.find((c) => c.id === channelId) || { id: channelId, name: null };
}

function closeChannel(word, list) {
  const q = normalizeName(word);
  if (q.length < 3) return null;
  const hit = fuzzyFind(q, list);
  if (hit?.item) return hit.item;
  const names = list.map((c) => normalizeName(c.name)).filter(Boolean);
  const guess = didYouMean(q, names, { limit: 1, max: 2 })[0];
  return guess ? list.find((c) => normalizeName(c.name) === guess) || null : null;
}

async function pickChannel(ctx, tokens, { ask = false } = {}) {
  const first = tokens[0] || '';
  if (/^(<#|#)/.test(first)) {
    const ch = await ctx.findChannel(first);
    if (!ch) throw friendly(`I couldn't find the channel **${clip(first, 40)}**.`, { title: 'Which channel?' });
    return { channel: ch, rest: tokens.slice(1) };
  }
  if (first && !userId(first)) {
    const text = await ctx.channels('text').catch(() => []);
    const wanted = normalizeName(first);
    const exact = wanted && text.find((c) => normalizeName(c.name) === wanted);
    if (exact) return { channel: exact, rest: tokens.slice(1) };
    const close = ask ? closeChannel(first, text) : null;
    if (close) return { suggest: close, rest: tokens.slice(1) };
  }
  return { channel: await currentChannel(ctx), rest: tokens };
}

const chanLabel = (channel) => (channel?.name ? `#${clip(channel.name, 60)}` : 'this channel');

const isEveryoneOverride = (o, serverId) => !!o && (o.role_id == null || o.role_id === 'everyone' || o.role_id === serverId);

async function lockViaOverride(bot, channelId, serverId) {
  const list = (await bot.channelPermissions(channelId)) || [];
  const ev = list.find((o) => isEveryoneOverride(o, serverId));
  const prev = { allow: [...(ev?.allow || [])], deny: [...(ev?.deny || [])] };
  if (prev.deny.includes('send_messages')) return { via: 'override', prev, already: true };
  await bot.setChannelPermissions(channelId, 'everyone', { allow: prev.allow.filter((p) => p !== 'send_messages'), deny: [...prev.deny, 'send_messages'] });
  return { via: 'override', prev };
}

async function lockViaReadOnly(bot, channelId) {
  const ch = await bot.channel(channelId);
  const prevReadOnly = !!ch?.read_only;
  if (prevReadOnly) return { via: 'readonly', prevReadOnly, already: true };
  await bot.editChannel(channelId, { readOnly: true });
  return { via: 'readonly', prevReadOnly };
}

const canFallBack = (e) => looksLikeFeatureOff(e) || [400, 403, 404].includes(e?.status);

async function lockChannel(ctx, channelId) {
  const { engine, bot, serverId } = ctx;
  if (engine.caps.state(serverId, 'roles') === false) return { ...(await lockViaReadOnly(bot, channelId)), fellBack: true };
  try {
    const out = await lockViaOverride(bot, channelId, serverId);
    engine.caps.mark(serverId, 'roles', true);
    return out;
  } catch (e) {
    if (!canFallBack(e)) throw e;
    if (looksLikeFeatureOff(e)) engine.caps.mark(serverId, 'roles', false, e?.message);
    return { ...(await lockViaReadOnly(bot, channelId)), fellBack: true };
  }
}

async function unlockChannel(ctx, channelId) {
  const { bot, engine, serverId } = ctx;
  const rec = readData(engine, serverId).locks[channelId];
  if (rec?.via === 'override') {
    await bot.setChannelPermissions(channelId, 'everyone', { allow: rec.prev?.allow || [], deny: (rec.prev?.deny || []).filter((p) => p !== 'send_messages') });
    return { via: 'override' };
  }
  if (rec?.via === 'readonly') {
    await bot.editChannel(channelId, { readOnly: false });
    return { via: 'readonly' };
  }
  if (engine.caps.state(serverId, 'roles') !== false) {
    try {
      const list = (await bot.channelPermissions(channelId)) || [];
      const ev = list.find((o) => isEveryoneOverride(o, serverId));
      if (ev?.deny?.includes('send_messages')) {
        await bot.setChannelPermissions(channelId, 'everyone', { allow: ev.allow || [], deny: ev.deny.filter((p) => p !== 'send_messages') });
        return { via: 'override' };
      }
    } catch (e) {
      if (!canFallBack(e)) throw e;
    }
  }
  const ch = await bot.channel(channelId);
  if (ch?.read_only) {
    await bot.editChannel(channelId, { readOnly: false });
    return { via: 'readonly' };
  }
  return { via: null };
}

const viaNote = (r) => (r.via === 'override'
  ? '-# I used a channel permission override for @everyone.'
  : "-# Permission overrides aren't available here yet, so I made the channel read-only instead.");

async function runLock(ctx, tokens, locking) {
  let picked;
  try {
    picked = await pickChannel(ctx, tokens, { ask: true });
  } catch (e) {
    return ctx.fail(e);
  }
  if (picked.suggest) return askLockChannel(ctx, picked.suggest, tokens, locking);
  return doLock(ctx, picked.channel, picked.rest.join(' '), locking);
}

async function askLockChannel(ctx, suggest, tokens, locking) {
  const verb = locking ? 'Lock' : 'Unlock';
  const sameAsHere = suggest.id === ctx.channelId;
  const sid = ctx.engine.router.session({
    kind: 'lock', userId: ctx.userId, serverId: ctx.serverId, locking,
    suggestId: suggest.id, hereId: ctx.channelId,
    reasonThere: tokens.slice(1).join(' ').slice(0, 200), reasonHere: tokens.join(' ').slice(0, 200),
  });
  const buttons = [
    button(`${verb} ${chanLabel(suggest)}`, cid('lockpick', sid, 'there'), locking ? 'danger' : 'success', locking ? ICONS.lock : ICONS.unlock),
    sameAsHere ? null : button(`${verb} this channel`, cid('lockpick', sid, 'here'), 'secondary'),
    button('Cancel', cid('lockpick', sid, 'cancel'), 'secondary'),
  ].filter(Boolean);
  const body = `Did you mean #${suggest.name}?\n-# I didn't find a channel called **${clip(tokens[0], 40)}**.${sameAsHere ? '' : ` Pick **${verb} this channel** if that word was the reason.`}`;
  return ctx.ephemeral({ embeds: [dialog.info('Which channel?', body)], components: [row(...buttons)] });
}

async function pickLockChannel(ctx) {
  const [sid, choice] = ctx.argv;
  const s = ctx.engine.router.getSession(sid);
  if (!ownQuestion(ctx, s, 'lock')) return expiredQuestion(ctx);
  ctx.engine.router.dropSession(sid);
  if (choice === 'cancel') return cancelled(ctx);
  const respond = (p) => ctx.update(p);
  try {
    if (choice === 'here') return await doLock(ctx, await currentChannel(ctx, s.hereId), s.reasonHere, s.locking, respond);
    if (choice !== 'there') return expiredQuestion(ctx);
    const channel = (await ctx.channels('text').catch(() => [])).find((c) => c.id === s.suggestId);
    if (!channel) throw friendly("That channel isn't here anymore. Run the command again.", { title: 'Which channel?' });
    return await doLock(ctx, channel, s.reasonThere, s.locking, respond);
  } catch (e) {
    return ctx.fail(e);
  }
}

async function doLock(ctx, channel, rawReason, locking, respond) {
  const answer = respond || ((p) => ctx.reply(p));
  const chName = `<#${channel.id}>`;
  const verb = locking ? 'lock' : 'unlock';
  const reason = String(rawReason || '').slice(0, 200);
  try {
    await needBotPerm(ctx, ['manage_channels', 'manage_roles'], `${verb} ${chName}`);
    const service = svc(ctx);
    const aName = await actorName(ctx);
    if (locking) {
      const r = await lockChannel(ctx, channel.id);
      if (r.already) return respond ? answer({ embeds: [dialog.info('Already locked', `${chName} is already locked.`)], components: [] }) : ctx.info('Already locked', `${chName} is already locked.`);
      writeData(ctx.engine, ctx.serverId, (d) => { d.locks[channel.id] = { via: r.via, prev: r.prev || null, prevReadOnly: !!r.prevReadOnly, at: Date.now(), by: ctx.userId }; });
      const c = await service.addCase(ctx.serverId, { action: 'lock', actorId: ctx.userId, actorName: aName, targetName: chName, reason, channelId: channel.id, meta: { via: r.via } });
      service.log(ctx.serverId, caseEmbed(c, viaNote(r)));
      const undo = ctx.engine.router.addUndo({
        serverId: ctx.serverId, actorId: ctx.userId, label: `lock of #${channel.name || 'channel'}`,
        manual: channel.name ? `/unlock #${channel.name}` : `/unlock in ${chName}`,
        run: (i) => guardedUndo(i, { action: 'unlock', perm: 'manage_channels', target: chName }, async () => {
          await undoGate(ctx, i);
          const u = await doUnlock(ctx, channel, `Undo of case #${c.id}`, i.user_id);
          markUndone(ctx.engine, ctx.serverId, c.id);
          if (!u) return undoReply(i, dialog.info('Already unlocked', `${chName} was already open again, so there was nothing to undo.`));
          return undoReply(i, dialog.ok('Unlocked', `${chName} is open again.\n-# Case #${u.id}`));
        }),
      });
      return answer({ embeds: [dialog.ok('Channel locked', `${ICONS.lock} Only staff can post in ${chName} now.${reason ? `\n**Reason:** ${reason}` : ''}\n${viaNote(r)}\n-# Case #${c.id}`, { color: 'mod' })], components: [row(undo.button)] });
    }
    const c = await doUnlock(ctx, channel, reason, ctx.userId);
    if (!c) return respond ? answer({ embeds: [dialog.info('Not locked', `${chName} isn't locked, so there's nothing to undo.`)], components: [] }) : ctx.info('Not locked', `${chName} isn't locked, so there's nothing to undo.`);
    return answer({ embeds: [dialog.ok('Channel unlocked', `${ICONS.unlock} Everyone can post in ${chName} again.${reason ? `\n**Reason:** ${reason}` : ''}\n${viaNote(c.meta)}\n-# Case #${c.id}`, { color: 'mod' })], components: [] });
  } catch (e) {
    return ctx.fail(e, { action: `${verb} ${chName}`, perm: 'manage_channels' });
  }
}

async function doUnlock(ctx, channel, reason, actorId) {
  const r = await unlockChannel(ctx, channel.id);
  if (!r.via) return null;
  writeData(ctx.engine, ctx.serverId, (d) => { delete d.locks[channel.id]; });
  const service = svc(ctx);
  const c = await service.addCase(ctx.serverId, { action: 'unlock', actorId, targetName: `<#${channel.id}>`, reason, channelId: channel.id, meta: { via: r.via } });
  service.log(ctx.serverId, caseEmbed(c));
  return c;
}

async function runSlowmode(ctx, tokens) {
  let channel;
  let rest;
  try {
    ({ channel, rest } = await pickChannel(ctx, tokens));
  } catch (e) {
    return ctx.fail(e);
  }
  const raw = (rest[0] || '').toLowerCase();
  if (!raw) return askSlowmode(ctx, channel, '');
  let seconds;
  if (/^(off|0|none|stop|disable)$/.test(raw)) seconds = 0;
  else {
    const ms = parseDuration(raw, { bareUnit: 's' });
    if (ms === null) return askSlowmode(ctx, channel, rest[0]);
    seconds = Math.round(ms / 1000);
  }
  return applySlowmode(ctx, channel, seconds);
}

async function askSlowmode(ctx, channel, word) {
  const chName = `<#${channel.id}>`;
  try {
    await needBotPerm(ctx, 'manage_channels', `change slowmode in ${chName}`);
  } catch (e) {
    return ctx.fail(e, { action: `change slowmode in ${chName}`, perm: 'manage_channels' });
  }
  const sid = ctx.engine.router.session({ kind: 'slowmode', userId: ctx.userId, serverId: ctx.serverId, channelId: channel.id });
  const lead = !word ? '' : FOREVER_WORDS.test(word)
    ? "Slowmode can't last forever between messages. The longest gap is 6 hours."
    : `I didn't understand **${clip(word, 30)}** as a length.`;
  const body = [lead, `How long should people in ${chName} wait between messages?`, `-# You can also type it, like ${USAGE.slowmode}. A bare number means seconds.`].filter(Boolean).join('\n');
  const choices = SLOWMODE_CHOICES.map((c) => button(c === 'off' ? 'Off' : c, cid('slen', sid, c), c === 'off' ? 'secondary' : 'primary'));
  return ctx.ephemeral({ embeds: [dialog.warn('How slow?', body, { color: 'mod' })], components: [row(...choices), row(button('Cancel', cid('slen', sid, 'cancel'), 'secondary'))] });
}

async function pickSlowmode(ctx) {
  const [sid, choice] = ctx.argv;
  const s = ctx.engine.router.getSession(sid);
  if (!ownQuestion(ctx, s, 'slowmode')) return expiredQuestion(ctx);
  ctx.engine.router.dropSession(sid);
  if (choice === 'cancel') return cancelled(ctx);
  if (!SLOWMODE_CHOICES.includes(choice)) return expiredQuestion(ctx);
  let channel;
  try {
    channel = await currentChannel(ctx, s.channelId);
  } catch (e) {
    return ctx.fail(e);
  }
  const seconds = choice === 'off' ? 0 : Math.round(parseDuration(choice, { bareUnit: 's' }) / 1000);
  return applySlowmode(ctx, channel, seconds, (p) => ctx.update(p));
}

async function applySlowmode(ctx, channel, requested, respond) {
  const answer = respond || ((p) => ctx.reply(p));
  const capped = requested > MAX_SLOWMODE_S;
  const seconds = Math.max(0, Math.min(MAX_SLOWMODE_S, requested));
  const chName = `<#${channel.id}>`;
  try {
    await needBotPerm(ctx, 'manage_channels', `change slowmode in ${chName}`);
    const before = await ctx.bot.channel(channel.id);
    const prev = Number(before?.slowmode) || 0;
    await ctx.bot.editChannel(channel.id, { slowmode: seconds });
    const service = svc(ctx);
    const c = await service.addCase(ctx.serverId, { action: 'slowmode', actorId: ctx.userId, targetName: chName, durationMs: seconds * 1000, reason: seconds ? `${formatDuration(seconds * 1000)} between messages` : 'Slowmode off', channelId: channel.id });
    service.log(ctx.serverId, caseEmbed(c));
    const undo = ctx.engine.router.addUndo({
      serverId: ctx.serverId, actorId: ctx.userId, label: `slowmode back to ${prev ? formatDuration(prev * 1000) : 'off'}`,
      manual: `/mod slowmode ${channel.name ? `#${channel.name} ` : ''}${prev ? formatDuration(prev * 1000).replace(/\s+/g, '') : 'off'}`,
      run: (i) => guardedUndo(i, { action: `change slowmode in ${chName}`, perm: 'manage_channels' }, async () => {
        await undoGate(ctx, i);
        await ctx.bot.editChannel(channel.id, { slowmode: prev });
        markUndone(ctx.engine, ctx.serverId, c.id);
        await undoReply(i, dialog.ok('Slowmode restored', `${chName} is back to ${prev ? `**${formatDuration(prev * 1000)}**` : 'no slowmode'}.`));
      }),
    });
    const body = seconds ? `People in ${chName} can send one message every **${formatDuration(seconds * 1000)}**.` : `Slowmode is off in ${chName}.`;
    return answer({ embeds: [dialog.ok(seconds ? 'Slowmode on' : 'Slowmode off', `${body}${capped ? '\n-# 6 hours is the most Yapin\' allows, so I used that.' : ''}\n-# Case #${c.id}`, { color: 'mod' })], components: [row(undo.button)] });
  } catch (e) {
    return ctx.fail(e, { action: `change slowmode in ${chName}`, perm: 'manage_channels' });
  }
}

async function runWarnings(ctx, tokens) {
  const { user } = await takeTarget(ctx, tokens);
  if (!user) return ctx.warn('Whose warnings?', `Try ${USAGE.warnings}.`);
  const label = tag(user);
  const data = readData(ctx.engine, ctx.serverId);
  const all = data.warns.filter((w) => w.targetId === user.id);
  const active = activeWarns(ctx.engine, ctx.serverId, user.id, data);
  const days = Number(ctx.config().warnDecayDays) || 0;
  if (!all.length) return ctx.info(`${label} has no warnings`, 'A clean record.');
  const lines = active.slice(-15).reverse().map((w) => `\`#${w.caseId}\` ${w.reason ? clip(w.reason, 80) : '*no reason*'} · ${ago(w.at)}`);
  const old = all.length - active.length;
  const next = [].concat(ctx.config().escalation || []).filter((r) => Number(r.at) > active.length).sort((a, b) => a.at - b.at)[0];
  const nextLine = next ? `\nAt **${next.at}** they'll be ${next.action === 'timeout' ? `timed out for ${formatDuration(next.durationMs || 3600000)}` : next.action === 'kick' ? 'kicked' : 'banned'}.` : '';
  const body = `${lines.join('\n') || '*No active warnings.*'}\n${old ? `\n-# ${old} older warning${old === 1 ? '' : 's'} no longer count${old === 1 ? 's' : ''}${days ? ` (older than ${days} days)` : ''}.` : ''}${nextLine}`;
  return ctx.ephemeral({ embeds: [card({ title: `⚠️ ${label}: ${active.length} active warning${active.length === 1 ? '' : 's'}`, body, color: 'mod' })] });
}

async function runCase(ctx, tokens) {
  const n = Number(String(tokens[0] || '').replace(/^#/, ''));
  if (!tokens[0]) return showCases(ctx, []);
  if (!Number.isInteger(n) || n < 1) return ctx.warn('Which case?', 'Give me a case number, like `/case 12`.');
  const c = readData(ctx.engine, ctx.serverId).cases.find((x) => x.id === n);
  if (!c) return ctx.warn(`No case #${n}`, "I couldn't find that case. Cases are numbered per server, starting at 1.");
  return ctx.ephemeral({ embeds: [caseEmbed(c)] });
}

async function showCases(ctx, tokens) {
  let user = null;
  if (tokens[0]) ({ user } = await takeTarget(ctx, tokens));
  const cases = readData(ctx.engine, ctx.serverId).cases.filter((c) => !user || c.targetId === user.id);
  const title = user ? `${ICONS.mod} Cases for ${tag(user)}` : `${ICONS.mod} Recent cases`;
  const body = cases.slice(-10).reverse().map(caseLine).join('\n') || 'No cases yet.';
  return ctx.ephemeral({ embeds: [card({ title, body: `${body}\n\n-# Open one with \`/case 12\`.`, color: 'mod' })], components: [row(button('Mod panel', cid('home'), 'secondary', ICONS.mod))] });
}

function buttonCount(raw) {
  const n = Math.trunc(Number(raw));
  return Number.isFinite(n) && n >= 1 ? Math.min(100, n) : PURGE_BUTTON_DEFAULT;
}

function formatSteps(steps) {
  return [].concat(steps || []).slice().sort((a, b) => a.at - b.at)
    .map((s) => `${s.at} ${s.action}${s.action === 'timeout' ? ` ${formatDuration(s.durationMs || 3600000)}` : ''}`).join(', ');
}

function parseSteps(text) {
  const parts = String(text || '').slice(0, STEPS_MAX * 4).split(/[,\n;]+/).map((p) => p.trim()).filter(Boolean);
  if (parts.length > STEPS_COUNT_MAX) return { error: `That's ${parts.length} steps. Keep it to ${STEPS_COUNT_MAX} or fewer.` };
  const steps = [];
  for (const p of parts) {
    const m = /^(\d+)\s*(?:warns?|warnings?)?\s*[:=→>-]*\s*(timeout|mute|kick|ban)(?:\s+(.+))?$/i.exec(p);
    if (!m) return { error: `I didn't understand **${clip(p, 40)}**.` };
    const action = m[2].toLowerCase() === 'mute' ? 'timeout' : m[2].toLowerCase();
    const step = { at: Number(m[1]), action };
    if (action === 'timeout') {
      const ms = m[3] ? parseDuration(m[3]) : 3600000;
      if (!ms) return { error: `I didn't understand the length in **${clip(p, 40)}**.` };
      step.durationMs = Math.min(ms, MAX_TIMEOUT_MIN * 60000);
    }
    if (step.at < 1) return { error: 'Steps start at 1 warning.' };
    steps.push(step);
  }
  return { steps: steps.sort((a, b) => a.at - b.at) };
}

const roleList = (ids) => (ids || []).length ? ids.map((r) => `<@&${r}>`).join(' ') : 'None';

async function runLogChannel(ctx, tokens) {
  const first = (tokens[0] || '').toLowerCase();
  const current = ctx.core().logChannel;
  if (!first) {
    return ctx.info('Mod log channel', `${current ? `Mod actions are logged in <#${current}>.` : 'No log channel yet.'}\nSet one with \`/mod log #mod-log\`, or turn it off with \`/mod log off\`.`);
  }
  if (/^(off|none|clear|remove|disable)$/.test(first)) {
    ctx.engine.settings.patchCore(ctx.serverId, { logChannel: null });
    return ctx.ok('Log channel cleared', 'Mod actions are no longer logged anywhere.');
  }
  const ch = await ctx.findChannel(tokens.join(' '), 'text');
  if (!ch || ch.server_id && ch.server_id !== ctx.serverId) return ctx.warn("I couldn't find that channel", 'Mention it, like `/mod log #mod-log`.');
  ctx.engine.settings.patchCore(ctx.serverId, { logChannel: ch.id });
  return ctx.ok('Log channel saved', `Mod actions, Automod alerts and warnings from other apps now go to <#${ch.id}>.`);
}

async function runStaffRoles(ctx, sub, tokens) {
  const kind = STAFF_KINDS[sub];
  if (kind.who === 'owner' && (await ctx.level()) !== 'owner') {
    return ctx.ephemeral({ embeds: [dialog.denied('owner', { body: 'Only the server owner can choose admin roles.' })] });
  }
  const core = ctx.core();
  const current = [...(core[kind.key] || [])];
  const action = (tokens[0] || '').toLowerCase();
  if (!action || /^(list|show)$/.test(action)) {
    return ctx.info(`${kind.label[0].toUpperCase()}${kind.label.slice(1)}s`, `${roleList(current)}\n\nChange them with ${kind.usage}.`);
  }
  const adding = /^(add|\+)$/.test(action);
  const removing = /^(remove|rm|del|delete|-)$/.test(action);
  if (!adding && !removing) return ctx.warn("I didn't get that", `Try ${kind.usage}.`);
  const role = await ctx.findRole(tokens.slice(1).join(' '));
  if (!role) return ctx.warn("I couldn't find that role", `Mention it, like ${kind.usage.split(',')[0]}.`);
  if (removing) {
    if (!current.includes(role.id)) return ctx.info('Nothing to remove', `**${role.name}** isn't a ${kind.label}.`);
    ctx.engine.settings.patchCore(ctx.serverId, { [kind.key]: current.filter((r) => r !== role.id) });
    ctx.engine.perms.invalidate();
    return ctx.ok(`${kind.label[0].toUpperCase()}${kind.label.slice(1)} removed`, `**${role.name}** no longer counts as a ${kind.label}.`);
  }
  if (/^@?everyone$/i.test(role.name) || role.id === ctx.serverId) return ctx.warn("Can't use that role", `Everyone has that role, so it can't be a ${kind.label}.`);
  if (role.auto && role.auto !== 'none') return ctx.warn("Can't use that role", `**${role.name}** is given out automatically, so it can't be a ${kind.label}.`);
  if ((await ctx.level()) !== 'owner') {
    const mine = await ctx.engine.perms.topPosition(ctx.serverId, ctx.userId);
    if (typeof role.position === 'number' && role.position >= mine) return ctx.ephemeral({ embeds: [dialog.denied('owner', { body: `**${role.name}** is at or above your highest role, so only the server owner can make it a ${kind.label}.` })] });
  }
  if (current.includes(role.id)) return ctx.info('Already set', `**${role.name}** is already a ${kind.label}.`);
  if (current.length >= 10) return ctx.warn('Too many roles', `There can be up to 10 ${kind.label}s. Remove one first.`);
  ctx.engine.settings.patchCore(ctx.serverId, { [kind.key]: [...current, role.id] });
  ctx.engine.perms.invalidate();
  return ctx.ok(`${kind.label[0].toUpperCase()}${kind.label.slice(1)} added`, `People with **${role.name}** now count as YapOS ${kind.label === 'mod role' ? 'moderators' : 'admins'} here.`);
}

function settingsView(ctx) {
  const cfg = ctx.config();
  const core = ctx.core();
  const log = core.logChannel;
  const days = Number(cfg.warnDecayDays) || 0;
  const fields = [
    { name: 'DM people before kick, ban or timeout', value: cfg.dmOnAction ? '🟢 On' : '⚪ Off', inline: false },
    { name: 'Warnings count for', value: days ? `${days} day${days === 1 ? '' : 's'}` : 'Forever', inline: true },
    { name: 'Automatic steps', value: formatSteps(cfg.escalation) || 'None', inline: true },
    { name: 'Log channel', value: log ? `<#${log}>` : 'Not set. Type `/mod log #mod-log` to pick one.', inline: false },
    { name: 'Extra mod roles', value: `${roleList(core.modRoles)}\n-# \`/mod modrole add @role\``, inline: true },
    { name: 'Extra admin roles', value: `${roleList(core.adminRoles)}\n-# \`/mod adminrole add @role\` (owner)`, inline: true },
  ];
  return {
    embeds: [card({ title: `${ICONS.mod} Mod settings`, body: 'How moderation works on this server.', fields, color: 'mod' })],
    components: [row(
      button(cfg.dmOnAction ? 'Turn DMs off' : 'Turn DMs on', cid('dm'), 'secondary', '✉️'),
      button('Edit warning rules', cid('rules'), 'primary', '⚠️'),
      button('Mod panel', cid('home'), 'secondary', ICONS.mod),
    )],
  };
}

async function panelView(ctx) {
  const data = readData(ctx.engine, ctx.serverId);
  const now = Date.now();
  const lastDay = data.cases.filter((c) => now - c.at < DAY_MS).length;
  const days = Number(ctx.config().warnDecayDays) || 0;
  const cutoff = days ? now - days * DAY_MS : -Infinity;
  const activeWarnCount = data.warns.filter((w) => w.at >= cutoff).length;
  const locked = Object.keys(data.locks).length;
  const recent = data.cases.slice(-5).reverse().map(caseLine).join('\n') || 'No cases yet. Quiet server!';
  const fields = [
    { name: 'Cases', value: String(data.cases.length), inline: true },
    { name: 'Last 24h', value: String(lastDay), inline: true },
    { name: 'Active warnings', value: String(activeWarnCount), inline: true },
    { name: 'Locked channels', value: String(locked), inline: true },
    { name: 'Recent', value: recent, inline: false },
  ];
  const body = 'Type an action, like `/mod timeout @sam 10m spam`, `/mod warn @sam`, `/mod purge 20`, `/mod slowmode 10s`.\nShortcuts: /warn /timeout /kick /ban /purge /lock /unlock /case';
  return {
    embeds: [card({ title: `${ICONS.mod} Mod`, body, fields, color: 'mod' })],
    components: [
      row(
        button('Lock this channel', cid('lock'), 'danger', ICONS.lock),
        button('Unlock this channel', cid('unlock'), 'success', ICONS.unlock),
        button('Clear 10 messages', cid('purge', 10), 'secondary', '🧹'),
      ),
      row(
        button('Recent cases', cid('cases'), 'secondary', '📋'),
        button('Settings', cid('settings'), 'secondary', '⚙️'),
      ),
    ],
  };
}

async function showPanel(ctx) {
  if (await refuseUnless(ctx, 'mod')) return undefined;
  return ctx.ephemeral(await panelView(ctx));
}

async function route(ctx, sub, tokens) {
  try {
    await requireFresh(ctx, 'mod');
    if (sub === 'timeout' || sub === 'untimeout' || sub === 'kick' || sub === 'ban' || sub === 'unban' || sub === 'warn') {
      if (sub === 'untimeout') {
        if (!tokens.length) return await ctx.warn('Whose timeout should I remove?', `Try ${USAGE.untimeout}.`);
        return await runAction(ctx, 'timeout', [tokens[0], 'off', ...tokens.slice(1)]);
      }
      return await runAction(ctx, sub, tokens);
    }
    if (sub === 'warnings') return await runWarnings(ctx, tokens);
    if (sub === 'case') return await runCase(ctx, tokens);
    if (sub === 'cases') return await showCases(ctx, tokens);
    if (sub === 'purge') return await runPurge(ctx, tokens);
    if (sub === 'slowmode') return await runSlowmode(ctx, tokens);
    if (sub === 'lock') return await runLock(ctx, tokens, true);
    if (sub === 'unlock') return await runLock(ctx, tokens, false);
    if (sub === 'settings') return await ctx.ephemeral(settingsView(ctx));
    if (sub === 'log' || sub === 'modrole' || sub === 'adminrole') {
      await requireFresh(ctx, 'admin');
      if (sub === 'log') return await runLogChannel(ctx, tokens);
      return await runStaffRoles(ctx, sub, tokens);
    }
    return await showPanel(ctx);
  } catch (e) {
    return ctx.fail(e);
  }
}

async function runHub(ctx) {
  if (await refuseUnless(ctx, 'mod')) return undefined;
  const tokens = ctx.argv.length ? ctx.argv : tokenize(ctx.args);
  const first = (tokens[0] || '').toLowerCase();
  if (!first) return showPanel(ctx);
  const sub = SUB_ALIASES[first];
  if (sub) return route(ctx, sub, tokens.slice(1));
  const guess = didYouMean(first, Object.keys(SUB_ALIASES));
  return ctx.warn("I didn't get that", `I don't know **${clip(first, 30)}**.${guess.length ? ` Did you mean ${guess.map((g) => `**${g}**`).join(', ')}?` : ''}\nTry \`/mod\` on its own for the panel.`);
}

const shortcut = (sub) => (ctx) => route(ctx, sub, ctx.argv);

const YAP_WORDS = ['timeout', 'mute', 'unmute', 'untimeout', 'kick', 'ban', 'unban', 'warn', 'warnings', 'purge', 'clear', 'slowmode', 'lock', 'unlock', 'case'];

export const { setup, teardown, check } = defineApp({
  id: ID,
  name: 'Mod',
  icon: ICONS.mod,
  description: 'Timeouts, warnings, bans, purge, locks and case history.',
  category: 'Moderation',

  defaults: {
    dmOnAction: true,
    warnDecayDays: 30,
    escalation: DEFAULT_ESCALATION,
  },

  commands: {
    mod: { description: 'Mod panel, or type: /mod timeout @sam 10m spam, /mod purge 20, /mod lock', perm: 'mod', run: runHub },
    warn: { description: 'Warn someone: /warn @sam reason (repeat warnings add timeouts, kicks, bans)', perm: 'mod', run: shortcut('warn') },
    timeout: { description: 'Time someone out: /timeout @sam 10m reason (off clears it)', perm: 'mod', run: shortcut('timeout') },
    kick: { description: 'Kick someone: /kick @sam reason', perm: 'mod', run: shortcut('kick') },
    ban: { description: 'Ban someone: /ban @sam reason', perm: 'mod', run: shortcut('ban') },
    purge: { description: 'Delete recent messages: /purge 20, or /purge 20 @sam for one person', perm: 'mod', run: shortcut('purge') },
    lock: { description: 'Stop everyone posting here: /lock, or /lock announcements reason', perm: 'mod', run: shortcut('lock') },
    unlock: { description: 'Let everyone post again: /unlock or /unlock #channel', perm: 'mod', run: shortcut('unlock') },
    case: { description: 'Look up a mod case: /case 12, or /case for recent ones', perm: 'mod', run: shortcut('case') },
  },

  components: {
    home: { perm: 'mod', run: showPanel },
    cases: { perm: 'mod', run: staff('mod', (ctx) => showCases(ctx, [])) },
    settings: { perm: 'mod', run: staff('mod', (ctx) => ctx.ephemeral(settingsView(ctx))) },
    lock: { perm: 'mod', run: staff('mod', (ctx) => runLock(ctx, [], true)) },
    unlock: { perm: 'mod', run: staff('mod', (ctx) => runLock(ctx, [], false)) },
    tlen: { perm: 'mod', run: staff('mod', pickTimeoutLength) },
    lockpick: { perm: 'mod', run: staff('mod', pickLockChannel) },
    slen: { perm: 'mod', run: staff('mod', pickSlowmode) },
    purge: { perm: 'mod', run: staff('mod', (ctx) => runPurge(ctx, [String(buttonCount(ctx.argv[0]))])) },
    dm: {
      perm: 'admin',
      run: staff('admin', (ctx) => {
        ctx.patchConfig({ dmOnAction: !ctx.config().dmOnAction });
        return ctx.update(settingsView(ctx));
      }),
    },
    rules: {
      perm: 'admin',
      run: staff('admin', (ctx) => {
        const cfg = ctx.config();
        return ctx.form({
          title: 'Warning rules',
          action: 'rulesave',
          fields: [
            { id: 'days', label: 'Days a warning counts for (0 = forever)', style: 'short', value: String(cfg.warnDecayDays ?? 30), max: 4 },
            { id: 'steps', label: 'Steps, like: 3 timeout 1h, 5 kick, 7 ban', style: 'paragraph', value: clip(formatSteps(cfg.escalation), STEPS_MAX), required: false, max: STEPS_MAX },
          ],
        });
      }),
    },
    rulesave: {
      perm: 'admin',
      run: async (ctx) => {
        if (await refuseUnless(ctx, 'admin')) return undefined;
        const typedDays = String(ctx.values?.days ?? '').trim();
        const days = Number(typedDays);
        if (!/^\d{1,4}$/.test(typedDays) || days > 3650) return ctx.warn("That number didn't work", 'Use a whole number of days, like 30, or 0 to keep warnings forever.');
        const parsed = parseSteps(ctx.values?.steps || '');
        if (parsed.error) return ctx.warn("Those steps didn't work", `${parsed.error}\nWrite them like: \`3 timeout 1h, 5 kick, 7 ban\`.`);
        ctx.patchConfig({ warnDecayDays: days, escalation: parsed.steps });
        return ctx.ok('Warning rules saved', `Warnings count for ${days ? `${days} days` : 'forever'}.\nSteps: ${formatSteps(parsed.steps) || 'none'}.`);
      },
    },
  },

  yap: [{
    words: YAP_WORDS,
    run: async (ctx) => {
      if (await refuseUnless(ctx, 'mod')) return undefined;
      return route(ctx, SUB_ALIASES[ctx.word] || 'panel', ctx.argv);
    },
  }],

  panel: showPanel,

  services: (engine) => createService(engine),

  presets: {
    gaming: { enabled: true, config: {} },
    friends: { enabled: true, config: { dmOnAction: true } },
    study: { enabled: true, config: {} },
    community: { enabled: true, config: { escalation: STRICT_ESCALATION } },
    roleplay: { enabled: true, config: {} },
  },

  applyPreset: async (engine, serverId, { preset, channels } = {}) => {
    const notes = [];
    const core = engine.settings.core(serverId);
    if (!core.logChannel && channels?.logs?.id) {
      engine.settings.patchCore(serverId, { logChannel: channels.logs.id });
      notes.push(`logging to #${channels.logs.name}`);
    }
    if (preset === 'community') {
      engine.settings.patchApp(serverId, ID, { escalation: STRICT_ESCALATION });
      notes.push(`stricter warnings (${formatSteps(STRICT_ESCALATION)})`);
    }
    return `Mod is ready${notes.length ? `: ${notes.join(', ')}` : ''}.`;
  },

  help: [
    'Targets can be a mention, a user id, @username or just a name.',
    'Lengths: 10m, 2h, 1d. A bare number means minutes for timeouts and seconds for slowmode. Leave the length out and I ask.',
    'Channels can be named plainly: `/lock announcements raid` locks #announcements. If the name is close, I ask first.',
    'Every action gets a case number. /case 12 shows one, /mod warnings @sam lists warnings.',
    'Bans, timeouts, warnings, locks and slowmode changes come with an Undo button for 10 minutes.',
    'Admins: `/mod log #mod-log` picks where actions are logged. `/mod modrole add @Helpers` makes a role count as mods.',
    'Server owner: `/mod adminrole add @Managers` makes a role count as YapOS admins.',
  ],
});
