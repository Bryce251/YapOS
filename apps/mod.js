import { defineApp } from '../engine/apps.js';
import { card, dialog, button, row, ICONS } from '../engine/ui.js';
import { MAX_TRIES } from '../engine/scheduler.js';
import { customId } from '../engine/router.js';
import { tokenize, parseDuration, takeDuration, formatDuration, didYouMean, fuzzyFind, normalizeName, userId, clip } from '../engine/parse.js';
import { friendly, permName, explain, looksLikeFeatureOff } from '../engine/errors.js';
import { accept, reject, isBlank, channelById } from '../engine/dashboard.js';

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
const MIN_MS = 60000;
const YEAR_MS = 365 * DAY_MS;
const MAX_NOTES = 2000;
const MAX_NOTES_PER_USER = 25;
const NOTE_MAX_LEN = 500;
const MAX_HISTORY = 10;
const UNBAN_KIND = 'mod.unban';
const UNINSTALLED_RETRY_MS = 6 * 3600000;
const PENDING_TTL_MS = 15 * 60000;
const MAX_PENDING = 500;

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
  unwarn: { perm: null, verb: 'remove the warning for', title: 'Warning removed', skipHierarchy: true },
  role_add: { perm: 'manage_roles', verb: 'change roles for', title: 'Role added' },
  role_remove: { perm: 'manage_roles', verb: 'change roles for', title: 'Role removed' },
  nick: { perm: 'manage_nicknames', verb: 'change the nickname of', title: 'Nickname changed' },
  note: { perm: null, verb: 'write a note about', title: 'Note saved', skipHierarchy: true },
};

const NICK_MAX = 32;
const REASON_MAX = 500;
const BANS_TTL_MS = 60_000;
const STATS_DAYS = 14;
const STATS_TYPE_DAYS = 30;
const MAX_DETAIL_NOTES = 25;

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
  note: 'note', unnote: 'unnote', notes: 'notes',
  user: 'user', lookup: 'user', whois: 'user', userinfo: 'user', member: 'user',
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
  ban: '`/mod ban @sam reason` (permanent) or `/mod ban @sam 7d reason` (lifted after 7 days)',
  unban: '`/mod unban <user id or mention>`',
  warn: '`/mod warn @sam reason`',
  warnings: '`/mod warnings @sam`',
  purge: '`/mod purge 20` or `/mod purge 20 @sam`',
  slowmode: '`/mod slowmode 10s` or `/mod slowmode off`',
  note: '`/mod note @sam keeps arguing in #general`',
  notes: '`/mod notes @sam`',
  unnote: '`/mod note remove 4`',
  user: '`/mod user @sam`',
  reason: '`/case 12 reason posted scam links`',
};

const emptyData = () => ({ seq: 0, cases: [], warns: [], locks: {}, noteSeq: 0, notes: [] });

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

async function displayNameFor(engine, sid, uid) {
  if (!uid) return 'someone';
  const members = await engine.cache.members(sid).catch(() => []);
  const m = members.find((x) => x.id === uid);
  return m?.nickname || m?.display_name || m?.username || 'someone';
}

const nowMs = (engine) => engine.scheduler?.now?.() ?? Date.now();

const when = (at) => `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad2 = (n) => String(n).padStart(2, '0');

function untilText(at, now) {
  const d = new Date(at);
  const year = d.getUTCFullYear() !== new Date(now).getUTCFullYear() ? ` ${d.getUTCFullYear()}` : '';
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}${year}, ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`;
}

function dayText(at) {
  const d = new Date(at);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function roughSpan(ms) {
  for (const [name, size] of [['year', YEAR_MS], ['month', 30 * DAY_MS], ['week', 7 * DAY_MS], ['day', DAY_MS], ['hour', 3600000], ['minute', MIN_MS]]) {
    if (ms >= size) {
      const n = Math.floor(ms / size);
      return `${n} ${name}${n === 1 ? '' : 's'}`;
    }
  }
  return 'less than a minute';
}

function longDuration(ms) {
  let left = Math.max(MIN_MS, Math.round(ms / MIN_MS) * MIN_MS);
  const parts = [];
  for (const [name, size] of [['year', YEAR_MS], ['day', DAY_MS], ['hour', 3600000], ['minute', MIN_MS]]) {
    if (left >= size) {
      const n = Math.floor(left / size);
      parts.push(`${n} ${name}${n === 1 ? '' : 's'}`);
      left -= n * size;
    }
  }
  return parts.slice(0, 2).join(' ');
}
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
  if (c.meta?.until) fields.push({ name: 'Ban ends', value: untilText(c.meta.until, c.at), inline: true });
  const history = (c.history || []).slice(-3).reverse();
  if (history.length) {
    const lines = history.map((h) => `Was: ${h.reason ? clip(h.reason, 120) : '*no reason*'} (edited by ${h.byName || 'someone'}, ${when(h.at)})`);
    fields.push({ name: 'Earlier reasons', value: lines.join('\n'), inline: false });
  }
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

  async function logCase(serverId, c, extra = '') {
    if (!c) return null;
    const sent = await log(serverId, caseEmbed(c, extra));
    if (sent?.id) {
      const channelId = sent.channel_id || engine.settings.core(serverId).logChannel;
      writeData(engine, serverId, (d) => {
        const x = d.cases.find((y) => y.id === c.id);
        if (!x) return;
        x.log = { channelId, messageId: sent.id };
        if (extra) x.logExtra = extra;
      });
    }
    return sent;
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
    logCase(serverId, c);
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
        else if (rule.action === 'ban') {
          await bot.ban(serverId, targetId);
          cancelUnban(engine, serverId, targetId);
        } else return null;
        c = await addCase(serverId, { action: rule.action, targetId, actorId, reason, source, targetName });
        logCase(serverId, c);
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
    logCase(serverId, c, `They now have **${count}** active warning${count === 1 ? '' : 's'}.`);
    const escalated = rule ? await escalate(serverId, targetId, rule, { count, source, targetName: c.targetName }) : null;
    if (escalated?.ok && escalated.case) linkEscalation(engine, serverId, c.id, escalated.case.id);
    return { case: c, count, escalated };
  }

  async function act(serverId, { actorId, actorName, kind, targetId, targetName, durationMs = null, reason: rawReason = '', roleId = null, nickname = null, note = null, caseNumber = null, source = 'mod' } = {}) {
    const def = ACTIONS[kind];
    if (!def) throw friendly("I don't know that action.", { title: "I can't do that" });
    if (!targetId && kind !== 'unwarn') throw friendly('Pick a member first.', { title: 'Who do you mean?' });
    refreshRoles(engine, serverId, actorId);
    await engine.perms.require(serverId, actorId, 'mod');
    const reason = String(rawReason || '').slice(0, REASON_MAX);
    const who = { actorId, actorName: actorName || await nameFor(engine, serverId, actorId), source };
    if (kind === 'unwarn') return unwarn(serverId, { ...who, caseNumber, targetId, reason });
    const label = targetName || await nameFor(engine, serverId, targetId);
    if (kind === 'note') return addNote(serverId, { ...who, targetId, label, text: note });
    if (kind === 'role_add' || kind === 'role_remove') return changeRole(serverId, { ...who, kind, def, targetId, label, roleId, reason });
    if (kind === 'nick') return changeNick(serverId, { ...who, def, targetId, label, nickname, reason });
    const base = { ...who, reason, targetName: label };
    if (kind === 'warn') {
      await checkCanAct(engine, serverId, actorId, targetId, def, label);
      const out = await warn(serverId, targetId, base);
      return { action: kind, ...out, message: warnMessage(engine, serverId, label, out) };
    }
    if (kind === 'timeout' || kind === 'untimeout') return timeoutAction(serverId, { kind, def, targetId, label, durationMs, base });
    return removalAction(serverId, { kind, def, targetId, label, durationMs, base });
  }

  async function timeoutAction(serverId, { kind, def, targetId, label, durationMs, base }) {
    const ms = kind === 'timeout' ? timeoutLength(durationMs) : 0;
    await checkCanAct(engine, serverId, base.actorId, targetId, def, label);
    const c = await timeout(serverId, targetId, { ...base, durationMs: ms });
    const dm = kind === 'timeout' ? await tryDm(engine, serverId, targetId, await dmText(engine, serverId, def, base.reason, ms)) : 'off';
    const text = kind === 'timeout' ? `Timed out ${label} for ${formatDuration(c.durationMs)}.` : `Removed the timeout for ${label}.`;
    return { action: kind, case: c, dm, durationMs: c.durationMs, until: null, message: `${text}${dmPlain(dm)}` };
  }

  async function removalAction(serverId, { kind, def, targetId, label, durationMs, base }) {
    const ms = kind === 'ban' && durationMs ? banLength(durationMs) : null;
    await checkCanAct(engine, serverId, base.actorId, targetId, def, label);
    const temp = ms ? scheduleUnban(engine, serverId, targetId, label, ms) : null;
    const dm = def.dm ? await tryDm(engine, serverId, targetId, await dmText(engine, serverId, def, base.reason, ms, temp?.until)) : 'off';
    if (kind === 'kick') await bot.kick(serverId, targetId);
    if (kind === 'ban') {
      try {
        await bot.ban(serverId, targetId);
      } catch (e) {
        dropTempBan(engine, serverId, temp);
        throw e;
      }
      forgetBans(engine, serverId);
      if (!temp) cancelUnban(engine, serverId, targetId);
    }
    if (kind === 'unban') {
      await bot.unban(serverId, targetId);
      forgetBans(engine, serverId);
      cancelUnban(engine, serverId, targetId);
    }
    const c = await addCase(serverId, { action: kind, targetId, ...base, durationMs: temp ? ms : null, meta: temp ? { until: temp.until } : undefined });
    logCase(serverId, c);
    const text = kind === 'kick' ? `Kicked ${label}.`
      : kind === 'unban' ? `Unbanned ${label}. They can join again with an invite.`
        : temp ? `Banned ${label} until ${untilText(temp.until, nowMs(engine))}. I'll lift the ban by myself when it ends.` : `Banned ${label}.`;
    return { action: kind, case: c, dm, durationMs: c.durationMs, until: temp?.until ?? null, message: `${text}${dmPlain(dm)}` };
  }

  async function unwarn(serverId, { actorId, actorName, source, caseNumber, targetId, reason }) {
    const n = Number(caseNumber);
    const data = readData(engine, serverId);
    const wc = Number.isInteger(n) ? data.cases.find((c) => c.id === n) : null;
    if (!wc || wc.action !== 'warn') throw friendly(`I couldn't find a warning with case #${Number.isInteger(n) ? n : '?'}.`, { title: 'Which warning?' });
    if (targetId && wc.targetId !== targetId) throw friendly(`Case #${n} is a warning for someone else.`, { title: 'Which warning?' });
    if (wc.undone) throw friendly(`The warning in case #${n} was already removed.`, { title: 'Already removed' });
    const label = wc.targetName || await nameFor(engine, serverId, wc.targetId);
    const esc = wc.meta?.escalation ? data.cases.find((c) => c.id === wc.meta.escalation && !c.undone) : null;
    const reverses = esc && (esc.action === 'ban' ? ACTIONS.unban : esc.action === 'timeout' ? ACTIONS.untimeout : null);
    if (reverses && actorId !== wc.actorId) await checkUndoRights(engine, serverId, actorId, reverses, wc.targetId, label);
    writeData(engine, serverId, (d) => { d.warns = d.warns.filter((w) => w.caseId !== n); });
    markUndone(engine, serverId, n);
    const notes = await reverseEscalation(serverId, esc, wc.targetId);
    const u = await addCase(serverId, { action: 'unwarn', targetId: wc.targetId, actorId, actorName, reason: reason ? `Undo of case #${n}: ${reason}` : `Undo of case #${n}`, targetName: label, source });
    logCase(serverId, u);
    const count = activeWarns(engine, serverId, wc.targetId).length;
    const message = [`Removed the warning in case #${n}. ${label} is back to ${count} warning${count === 1 ? '' : 's'}.`, ...notes].join(' ');
    return { action: 'unwarn', case: u, count, notes, message };
  }

  async function reverseEscalation(serverId, esc, targetId) {
    if (!esc) return [];
    if (esc.action === 'kick') return ["It also caused a kick, which can't be undone. They can rejoin with an invite."];
    if (esc.action !== 'timeout' && esc.action !== 'ban') return [];
    const isBan = esc.action === 'ban';
    const reversed = await (isBan ? bot.unban(serverId, targetId) : bot.timeout(serverId, targetId, 0)).then(() => true, () => false);
    if (!reversed) return [isBan ? "I couldn't lift the ban it caused, so do that by hand." : "I couldn't clear the timeout it caused, so do that by hand."];
    if (isBan) forgetBans(engine, serverId);
    markUndone(engine, serverId, esc.id);
    if (isBan) cancelUnban(engine, serverId, targetId);
    return [isBan ? 'I also lifted the ban it caused.' : 'I also cleared the timeout it caused.'];
  }

  async function changeRole(serverId, { actorId, actorName, kind, def, targetId, label, roleId, reason }) {
    const adding = kind === 'role_add';
    const role = roleId ? (await engine.perms.roles(serverId).catch(() => [])).find((r) => r.id === roleId) : null;
    if (!role) throw friendly("I couldn't find that role. It may have been deleted.", { title: 'Which role?' });
    if (isEveryoneRole(role, serverId)) throw friendly("Everyone has that role, so it can't be given or taken.", { title: "I can't change that role" });
    await checkCanAct(engine, serverId, actorId, targetId, def, label);
    const title = `I can't ${adding ? 'give' : 'take'} ${role.name}`;
    const can = await engine.perms.canManageRole(serverId, role.id);
    if (!can.ok) throw friendly(can.reason, { title });
    if (!(await actorAboveRole(engine, serverId, actorId, role))) throw friendly(`**${role.name}** is at or above your highest role, so you can't hand it out or take it away.`, { title });
    const member = await bot.member(serverId, targetId).catch(() => null);
    if (!member) throw friendly(`${label} isn't in the server right now.`, { title });
    const has = (member.roles || []).includes(role.id);
    if (adding && has) throw friendly(`${label} already has **${role.name}**.`, { title: 'Nothing to change' });
    if (!adding && !has) throw friendly(`${label} doesn't have **${role.name}**.`, { title: 'Nothing to change' });
    await (adding ? bot.addRole(serverId, targetId, role.id) : bot.removeRole(serverId, targetId, role.id));
    refreshRoles(engine, serverId, targetId);
    const line = adding ? `${label} got the **${role.name}** role.` : `${label} lost the **${role.name}** role.`;
    log(serverId, actionLine(def.title, line, { actorName, reason }));
    return { action: kind, case: null, role: { id: role.id, name: role.name }, message: adding ? `Gave ${label} the ${role.name} role.` : `Took the ${role.name} role from ${label}.` };
  }

  async function changeNick(serverId, { actorId, actorName, def, targetId, label, nickname, reason }) {
    const nick = String(nickname ?? '').trim().slice(0, NICK_MAX);
    await checkCanAct(engine, serverId, actorId, targetId, def, label);
    await bot.setNickname(serverId, targetId, nick);
    refreshRoles(engine, serverId, targetId);
    const line = nick ? `${label} is now called **${nick}**.` : `${label}'s nickname was cleared.`;
    log(serverId, actionLine(def.title, line, { actorName, reason }));
    return { action: 'nick', case: null, nickname: nick || null, message: nick ? `Changed ${label}'s nickname to ${nick}.` : `Cleared ${label}'s nickname.` };
  }

  function addNote(serverId, { actorId, actorName, targetId, label, text }) {
    const raw = String(text ?? '').trim();
    if (!raw) throw friendly('The note was empty, so nothing was saved.', { title: 'What should the note say?' });
    const out = storeNote(engine, serverId, { targetId, targetName: label, text: raw.slice(0, NOTE_MAX_LEN), by: actorId, byName: actorName });
    return { action: 'note', case: null, ...out, cut: raw.length > NOTE_MAX_LEN, message: `Saved a note about ${label}. Only mods can read it, and they weren't told.` };
  }

  return {
    addCase, warn, timeout, log, logCase, act,
    memberDetail: (sid, targetId, actorId) => memberDetail(engine, sid, targetId, actorId),
    stats: (sid) => modStats(engine, sid),
    explainError: (error, kind, targetName) => errorText(error, kind, targetName),
  };
}

function linkEscalation(engine, serverId, warnId, escId) {
  writeData(engine, serverId, (d) => {
    const x = d.cases.find((c) => c.id === warnId);
    if (x) x.meta = { ...(x.meta || {}), escalation: escId };
  });
}

function timeoutLength(ms) {
  if (!ms || ms < MIN_MS) throw friendly('A timeout has to last at least 1 minute.', { title: 'How long?' });
  if (ms > MAX_TIMEOUT_MIN * 60000) throw friendly("Yapin' timeouts go up to 28 days.", { title: 'Too long' });
  return clampMinutes(ms) * 60000;
}

function banLength(ms) {
  if (ms < MIN_MS) throw friendly('A temporary ban has to last at least 1 minute.', { title: 'Too short' });
  if (ms > YEAR_MS) throw friendly('Temporary bans go up to 1 year. Leave the length out for a permanent ban.', { title: 'Too long' });
  return Math.round(ms / MIN_MS) * MIN_MS;
}

const isEveryoneRole = (r, serverId) => /^@?everyone$/i.test(r?.name || '') || r?.id === 'everyone' || r?.id === serverId;

async function actorAboveRole(engine, serverId, actorId, role) {
  if (await engine.perms.isOwner(serverId, actorId)) return true;
  const top = await engine.perms.topPosition(serverId, actorId).catch(() => -1);
  return typeof role.position !== 'number' || role.position < top;
}

function actionLine(title, line, { actorName, reason }) {
  return card({
    title: `${ICONS.mod} ${title}`,
    body: `${line}${reason ? `\n**Reason:** ${reason}` : ''}`,
    fields: [{ name: 'By', value: actorName || '-', inline: true }, { name: 'When', value: when(Date.now()), inline: true }],
    color: 'mod',
  });
}

const plainText = (s) => String(s || '').replace(/\*\*|`/g, '').replace(/\s*\n+(-#\s*)?/g, ' ').trim();

const dmPlain = (state) => (state === 'failed' ? " I couldn't DM them about it (their DMs may be closed)." : state === 'sent' ? ' I sent them a DM about it.' : '');

function errorText(error, kind, targetName) {
  const def = ACTIONS[kind] || {};
  return plainText(explain(error, { action: def.verb, perm: def.perm, target: targetName }).body);
}

function warnMessage(engine, serverId, label, out) {
  const days = Number(engine.settings.appConfig(serverId, ID).warnDecayDays) || 0;
  const span = days > 0 ? ` in the last ${days} day${days === 1 ? '' : 's'}` : '';
  const lines = [`Warned ${label}. They now have ${out.count} warning${out.count === 1 ? '' : 's'}${span}.`];
  const esc = out.escalated;
  if (esc?.ok) lines.push(`That's ${out.count} warnings, so I ${escalationWhat(esc)} (case #${esc.case.id}).`);
  else if (esc) lines.push(`That's ${out.count} warnings, so I tried to ${ACTIONS[esc.action]?.verb || esc.action} them, but it didn't work: ${errorText(esc.error, esc.action, label)}`);
  return plainText(lines.join(' '));
}

const escalationWhat = (esc) => (esc.action === 'timeout' ? `timed them out for ${formatDuration(esc.durationMs)}` : esc.action === 'kick' ? 'kicked them' : 'banned them');

function storeNote(engine, serverId, { targetId, targetName, text, by, byName }) {
  return writeData(engine, serverId, (d) => {
    d.noteSeq += 1;
    const note = { id: d.noteSeq, targetId, targetName, text, by, byName, at: Date.now() };
    d.notes.push(note);
    const theirs = d.notes.filter((x) => x.targetId === targetId);
    const extra = theirs.length - MAX_NOTES_PER_USER;
    if (extra > 0) {
      const cut = new Set(theirs.slice(0, extra).map((x) => x.id));
      d.notes = d.notes.filter((x) => !cut.has(x.id));
    }
    if (d.notes.length > MAX_NOTES) d.notes.splice(0, d.notes.length - MAX_NOTES);
    return { note, count: Math.min(theirs.length, MAX_NOTES_PER_USER), dropped: Math.max(0, extra) };
  });
}

const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

const banLists = new WeakMap();

function forgetBans(engine, serverId) {
  banLists.get(engine)?.delete(serverId);
}

async function cachedBans(engine, serverId) {
  let list = banLists.get(engine);
  if (!list) { list = new Map(); banLists.set(engine, list); }
  const hit = list.get(serverId);
  const now = Date.now();
  if (hit && now - hit.at < BANS_TTL_MS) return hit.value;
  const value = await engine.bot.bans(serverId).catch(() => null);
  if (Array.isArray(value)) list.set(serverId, { at: now, value });
  return value;
}

async function memberDetail(engine, serverId, targetId, actorId) {
  forgetMember(engine, serverId, targetId);
  forgetMember(engine, serverId, actorId);
  const member = await engine.bot.member(serverId, targetId).catch(() => null);
  const now = nowMs(engine);
  const job = pendingUnban(engine, serverId, targetId);
  let banned = false;
  if (!member) {
    const bans = await cachedBans(engine, serverId);
    banned = Array.isArray(bans) ? bans.some((b) => (b.user_id ?? b.user?.id) === targetId) : !!job;
  }
  const label = member?.username ? `@${member.username}` : await nameFor(engine, serverId, targetId);
  const can = await abilities(engine, serverId, actorId, targetId, label, { inServer: !!member, banned });
  const t = member ? timeoutEnd(member, now) : null;
  const notes = readData(engine, serverId).notes.filter((n) => n.targetId === targetId).slice(-MAX_DETAIL_NOTES).reverse()
    .map((n) => ({ id: n.id, text: n.text, by: { id: n.by ?? null, name: n.byName || 'a mod' }, at: n.at }));
  return {
    id: targetId,
    inServer: !!member,
    username: member?.username ?? null,
    nickname: member?.nickname ?? null,
    joined_at: member?.joined_at ?? null,
    roles: member ? await memberRoles(engine, serverId, actorId, member, can.role) : [],
    assignable: member && can.role ? await assignableRoles(engine, serverId, actorId) : [],
    timeout: t ? { until: iso(t.at) } : null,
    banned,
    tempBan: banned && job ? { until: iso(job.at) } : null,
    notes,
    can,
  };
}

async function roleCeiling(engine, serverId, actorId) {
  const botTop = await engine.perms.topPosition(serverId, engine.bot.me?.id).catch(() => -1);
  const owner = await engine.perms.isOwner(serverId, actorId);
  const actorTop = owner ? Infinity : await engine.perms.topPosition(serverId, actorId).catch(() => -1);
  return { botTop, actorTop };
}

async function assignableRoles(engine, serverId, actorId) {
  const all = await engine.perms.roles(serverId).catch(() => []);
  const { botTop, actorTop } = await roleCeiling(engine, serverId, actorId);
  return all.filter((r) => !isEveryoneRole(r, serverId) && !(r.auto && r.auto !== 'none'))
    .filter((r) => { const pos = typeof r.position === 'number' ? r.position : 0; return pos < botTop && pos < actorTop; })
    .map((r) => r.id);
}

async function memberRoles(engine, serverId, actorId, member, canRole) {
  const mine = new Set(member.roles || []);
  const all = await engine.perms.roles(serverId).catch(() => []);
  const { botTop, actorTop } = await roleCeiling(engine, serverId, actorId);
  return all.filter((r) => mine.has(r.id) && !isEveryoneRole(r, serverId))
    .sort((a, b) => (b.position ?? 0) - (a.position ?? 0))
    .map((r) => {
      const pos = typeof r.position === 'number' ? r.position : 0;
      const manageable = !!canRole && !(r.auto && r.auto !== 'none') && pos < botTop && pos < actorTop;
      return { id: r.id, name: r.name, color: r.color || null, position: pos, manageable };
    });
}

async function abilities(engine, serverId, actorId, targetId, label, { inServer, banned }) {
  const can = { warn: false, unwarn: false, timeout: false, kick: false, ban: false, unban: false, role: false, nick: false, note: false };
  if (!actorId || !engine.perms.atLeast(await engine.perms.level(serverId, actorId), 'mod')) return can;
  const ok = (def) => checkCanAct(engine, serverId, actorId, targetId, def, label, { fresh: false }).then(() => true, () => false);
  if (inServer) {
    for (const [key, def] of [['warn', ACTIONS.warn], ['timeout', ACTIONS.timeout], ['kick', ACTIONS.kick], ['role', ACTIONS.role_add], ['nick', ACTIONS.nick]]) can[key] = await ok(def);
  }
  can.ban = !banned && await ok(ACTIONS.ban);
  can.unban = banned && await ok(ACTIONS.unban);
  can.note = true;
  can.unwarn = true;
  return can;
}

function utcDay(ms) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function modStats(engine, serverId) {
  const data = readData(engine, serverId);
  const now = Date.now();
  const first = utcDay(now) - (STATS_DAYS - 1) * DAY_MS;
  const byDay = new Map();
  for (let i = 0; i < STATS_DAYS; i += 1) byDay.set(new Date(first + i * DAY_MS).toISOString().slice(0, 10), 0);
  const casesByType = {};
  const typeCutoff = now - STATS_TYPE_DAYS * DAY_MS;
  const latestTimeout = new Map();
  for (const c of data.cases) {
    if (c.at >= first) {
      const key = new Date(c.at).toISOString().slice(0, 10);
      if (byDay.has(key)) byDay.set(key, byDay.get(key) + 1);
    }
    if (c.at >= typeCutoff) casesByType[c.action] = (casesByType[c.action] || 0) + 1;
    if (c.targetId && (c.action === 'timeout' || c.action === 'untimeout')) latestTimeout.set(c.targetId, c);
  }
  const days = Number(engine.settings.appConfig(serverId, ID).warnDecayDays) || 0;
  const warnCutoff = days > 0 ? now - days * DAY_MS : -Infinity;
  let activeTimeouts = 0;
  for (const c of latestTimeout.values()) if (c.action === 'timeout' && !c.undone && c.at + (c.durationMs || 0) > now) activeTimeouts += 1;
  return {
    casesByDay: [...byDay].map(([day, count]) => ({ day, count })),
    casesByType,
    activeWarns: data.warns.filter((w) => w.at >= warnCutoff).length,
    activeTimeouts,
    tempBans: engine.scheduler ? engine.scheduler.list({ kind: UNBAN_KIND, serverId }).length : 0,
  };
}

function cancelUnban(engine, serverId, targetId) {
  if (!engine.scheduler || !serverId || !targetId) return 0;
  return engine.scheduler.cancelWhere({ kind: UNBAN_KIND, serverId, key: targetId });
}

function pendingUnban(engine, serverId, targetId) {
  if (!engine.scheduler || !serverId || !targetId) return null;
  return engine.scheduler.list({ kind: UNBAN_KIND, serverId, key: targetId })[0] || null;
}

const svc = (ctx) => ctx.engine.service(ID) || createService(ctx.engine);

function forgetMember(engine, serverId, userId) {
  if (serverId && userId) engine.perms.invalidateKey(`m:${serverId}:${userId}`);
}

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

async function checkRank(engine, serverId, actorId, targetId, def, label, fresh = true) {
  if (fresh) refreshRoles(engine, serverId, targetId);
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

async function checkCanAct(engine, serverId, actorId, targetId, def, label, { fresh = true } = {}) {
  if (def.perm && !(await engine.perms.actorCan(serverId, actorId, def.perm))) {
    throw friendly(`You need **${permName(def.perm)}** to ${def.verb} people.`, { title: 'Needs Mod', need: 'mod', hint: 'Ask an admin to tick it on your role, or an admin can make your role a mod role with `/mod modrole add @role`.' });
  }
  if (!def.skipHierarchy) await checkRank(engine, serverId, actorId, targetId, def, label, fresh);
  if (targetId === actorId) throw friendly("You can't do that to yourself.", { title: `I can't ${def.verb} ${label}` });
  await needBotPerm(engine, serverId, def.perm, `${def.verb} ${label}`);
}

async function checkUndoRights(engine, serverId, actorId, def, targetId, label) {
  if (def.perm && !(await engine.perms.actorCan(serverId, actorId, def.perm))) {
    throw friendly(`You need **${permName(def.perm)}** to ${def.verb} people, so you can't undo this one.`, { title: 'Needs Mod', need: 'mod' });
  }
  if (targetId && !def.skipHierarchy) await checkRank(engine, serverId, actorId, targetId, def, label);
}

async function needBotPerm(engine, serverId, perms, what) {
  const list = [].concat(perms || []);
  if (!list.length) return;
  for (const p of list) {
    const can = await engine.perms.botCan(serverId, p);
    if (can.ok) return;
  }
  const botRole = await engine.perms.botRoleName(serverId).catch(() => 'my role');
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

async function tryDm(engine, serverId, userId, text) {
  if (!engine.settings.appConfig(serverId, ID).dmOnAction) return 'off';
  if (engine.caps.state(serverId, 'dms') === false) return 'failed';
  try {
    await engine.bot.dmSend(userId, text);
    engine.caps.mark(serverId, 'dms', true);
    return 'sent';
  } catch (e) {
    if (looksLikeFeatureOff(e)) engine.caps.mark(serverId, 'dms', false, e?.message);
    return 'failed';
  }
}

async function dmText(engine, serverId, def, reason, durationMs, until = null) {
  const server = await engine.perms.server(serverId).catch(() => null);
  const name = server?.name || 'the server';
  const length = until ? ` until ${untilText(until, nowMs(engine))} (${longDuration(durationMs)})` : durationMs ? ` for ${formatDuration(durationMs)}` : '';
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
  if (kind === 'ban') return runBan(ctx, user, rest);
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

const YEAR_WORD = /^(\d+(?:\.\d+)?)\s*(y|yr|yrs|year|years)$/i;
const BARE_NUMBER = /^\d+(\.\d+)?$/;

function takeBanLength(words) {
  const first = words[0] || '';
  if (FOREVER_WORDS.test(first)) return { ms: null, rest: words.slice(1) };
  const pair = `${first} ${words[1] || ''}`.trim();
  for (const [text, used] of [[first, 1], [pair, 2]]) {
    const y = YEAR_WORD.exec(text);
    if (y) return { ms: Math.round(Number(y[1]) * YEAR_MS), rest: words.slice(used) };
  }
  if (!/^\d/.test(first)) return { ms: null, rest: words };
  const d = takeDuration(words);
  if (d.ms === null) return { ms: null, rest: words };
  if (BARE_NUMBER.test(first) && d.rest.length === words.length - 1) return { ms: null, rest: words };
  return d;
}

async function runBan(ctx, user, words) {
  const { ms, rest } = takeBanLength(words);
  const reason = rest.join(' ');
  if (ms === null) return performAction(ctx, 'ban', user, { reason });
  if (ms < MIN_MS) return ctx.warn('Too short', `A temporary ban has to last at least 1 minute. Try ${USAGE.ban}.`);
  if (ms > YEAR_MS) return ctx.warn('Too long', 'Temporary bans go up to 1 year. Leave the length out for a permanent ban, like `/ban @sam spamming`.');
  return performAction(ctx, 'ban', user, { reason, durationMs: Math.round(ms / MIN_MS) * MIN_MS });
}

function scheduleUnban(engine, serverId, targetId, label, durationMs) {
  const s = engine.scheduler;
  if (!s) throw friendly("I can't lift bans by myself right now, so I didn't ban anyone. Leave the length out for a permanent ban.", { title: 'Temporary bans are off' });
  const until = s.now() + durationMs;
  const previous = pendingUnban(engine, serverId, targetId);
  const job = s.schedule({ kind: UNBAN_KIND, at: until, serverId, key: targetId, data: { userId: targetId, name: label, until } });
  return { job, until, previous };
}

function dropTempBan(engine, serverId, temp) {
  if (!temp) return;
  engine.scheduler.cancel(temp.job.id);
  const p = temp.previous;
  if (!p) return;
  try {
    engine.scheduler.schedule({ kind: UNBAN_KIND, at: p.at, serverId, key: p.key, data: p.data });
  } catch (e) {
    engine.log.debug('mod could not put back the earlier unban', e?.message);
  }
}

async function askTimeoutLength(ctx, user, words) {
  const label = tag(user);
  try {
    await checkCanAct(ctx.engine, ctx.serverId, ctx.userId, user.id, ACTIONS.timeout, label);
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
    const out = await svc(ctx).act(ctx.serverId, { actorId: ctx.userId, kind, targetId: user.id, targetName: label, durationMs, reason, source: 'mod' });
    if (kind === 'warn') return await replyWarn(ctx, user, label, reason, out, answer);
    const c = out.case;
    let undo = null;
    if (kind === 'timeout') {
      undo = ctx.engine.router.addUndo({
        serverId: ctx.serverId, actorId: ctx.userId, label: `timeout for ${label}`,
        manual: `/mod untimeout ${label}`,
        run: (i) => undoTimeout(ctx, i, user, label, c),
      });
    }
    if (kind === 'ban') {
      undo = ctx.engine.router.addUndo({
        serverId: ctx.serverId, actorId: ctx.userId, label: `ban of ${label}`,
        manual: `/mod unban ${user.id}`,
        run: (i) => undoBan(ctx, i, user, label, c),
      });
    }
    const length = out.until ? ` is banned until **${untilText(out.until, nowMs(ctx.engine))}** (in ${longDuration(out.durationMs)})` : c.durationMs ? ` for **${formatDuration(c.durationMs)}**` : '';
    const autoNote = out.until ? "\n-# I'll lift the ban by myself when it ends." : '';
    const body = `${label}${length}.${reason ? `\n**Reason:** ${reason}` : ''}\n-# Case #${c.id}${autoNote}${note}${dmNote(out.dm)}`;
    return answer({ embeds: [dialog.ok(def.title, body, { color: 'mod' })], components: undo ? [row(undo.button)] : [] });
  } catch (e) {
    return ctx.fail(e, { action: def.verb, perm: def.perm, target: label });
  }
}

async function replyWarn(ctx, user, label, reason, out, answer = (p) => ctx.reply(p)) {
  const days = Number(ctx.config().warnDecayDays) || 0;
  const span = days > 0 ? ` in the last ${days} day${days === 1 ? '' : 's'}` : '';
  const lines = [`${label} now has **${out.count}** warning${out.count === 1 ? '' : 's'}${span}.`];
  if (reason) lines.push(`**Reason:** ${reason}`);
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
    cancelUnban(ctx.engine, ctx.serverId, user.id);
    markUndone(ctx.engine, ctx.serverId, c.id);
    const service = svc(ctx);
    const u = await service.addCase(ctx.serverId, { action: 'unban', targetId: user.id, actorId: i.user_id, reason: `Undo of case #${c.id}`, targetName: label });
    service.logCase(ctx.serverId, u);
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
    const r = await svc(ctx).act(ctx.serverId, { actorId: i.user_id, kind: 'unwarn', targetId: user.id, caseNumber: out.case.id });
    await undoReply(i, dialog.ok('Warning removed', [`${label} is back to **${r.count}** warning${r.count === 1 ? '' : 's'}.`, ...r.notes].join('\n')));
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
    await needBotPerm(ctx.engine, ctx.serverId, 'manage_messages', 'delete messages');
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
    service.logCase(ctx.serverId, c);
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
    await needBotPerm(ctx.engine, ctx.serverId, ['manage_channels', 'manage_roles'], `${verb} ${chName}`);
    const service = svc(ctx);
    const aName = await actorName(ctx);
    if (locking) {
      const r = await lockChannel(ctx, channel.id);
      if (r.already) return respond ? answer({ embeds: [dialog.info('Already locked', `${chName} is already locked.`)], components: [] }) : ctx.info('Already locked', `${chName} is already locked.`);
      writeData(ctx.engine, ctx.serverId, (d) => { d.locks[channel.id] = { via: r.via, prev: r.prev || null, prevReadOnly: !!r.prevReadOnly, at: Date.now(), by: ctx.userId }; });
      const c = await service.addCase(ctx.serverId, { action: 'lock', actorId: ctx.userId, actorName: aName, targetName: chName, reason, channelId: channel.id, meta: { via: r.via } });
      service.logCase(ctx.serverId, c, viaNote(r));
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
  service.logCase(ctx.serverId, c);
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
    await needBotPerm(ctx.engine, ctx.serverId, 'manage_channels', `change slowmode in ${chName}`);
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
    await needBotPerm(ctx.engine, ctx.serverId, 'manage_channels', `change slowmode in ${chName}`);
    const before = await ctx.bot.channel(channel.id);
    const prev = Number(before?.slowmode) || 0;
    await ctx.bot.editChannel(channel.id, { slowmode: seconds });
    const service = svc(ctx);
    const c = await service.addCase(ctx.serverId, { action: 'slowmode', actorId: ctx.userId, targetName: chName, durationMs: seconds * 1000, reason: seconds ? `${formatDuration(seconds * 1000)} between messages` : 'Slowmode off', channelId: channel.id });
    service.logCase(ctx.serverId, c);
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
  if (/^(reason|why)$/i.test(tokens[1] || '')) return editCaseReason(ctx, c, tokens.slice(2).join(' '));
  return ctx.ephemeral({ embeds: [caseEmbed(c)] });
}

async function editCaseReason(ctx, c, text) {
  const { engine, serverId } = ctx;
  const reason = String(text || '').trim().slice(0, 500);
  if (!reason) return ctx.warn('What should the new reason be?', `Type it after the word reason, like ${USAGE.reason.replace('12', String(c.id))}.`);
  const isAdmin = engine.perms.atLeast(await ctx.level(), 'admin');
  if (!isAdmin && c.actorId !== ctx.userId) {
    return ctx.ephemeral({ embeds: [dialog.denied('admin', { body: `Case #${c.id} was made by ${c.actorName || 'someone else'}, so only they or an admin can change its reason.` })] });
  }
  if (reason === c.reason) return ctx.info('Nothing changed', `Case #${c.id} already has that reason.`);
  const byName = await displayNameFor(engine, serverId, ctx.userId);
  const updated = writeData(engine, serverId, (d) => {
    const x = d.cases.find((y) => y.id === c.id);
    if (!x) return null;
    x.history = [...(x.history || []), { reason: x.reason, by: ctx.userId, byName, at: Date.now() }].slice(-MAX_HISTORY);
    x.reason = reason;
    for (const w of d.warns) if (w.caseId === x.id) w.reason = reason;
    return { ...x };
  });
  if (!updated) return ctx.warn(`No case #${c.id}`, "That case isn't here any more.");
  let logNote = '';
  if (updated.log?.messageId && updated.log?.channelId) {
    try {
      await engine.budget.edit({ channelId: updated.log.channelId, messageId: updated.log.messageId, opts: { embeds: [caseEmbed(updated, updated.logExtra || '')] } });
      logNote = '\n-# I updated the log message too.';
    } catch (e) {
      engine.log.debug('mod log edit failed', e?.message);
      logNote = "\n-# I couldn't update the old log message. It may have been deleted.";
    }
  }
  return ctx.ephemeral({ embeds: [dialog.ok('Reason updated', `Case #${updated.id} now says: ${clip(reason, 300)}\n-# The old reason is kept in the case history.${logNote}`, { color: 'mod' })] });
}

const isStaffAbove = async (ctx) => ctx.engine.perms.atLeast(await ctx.level(), 'admin');

async function runNote(ctx, tokens) {
  const first = (tokens[0] || '').toLowerCase();
  if (/^(remove|delete|del|rm|forget)$/.test(first)) return removeNote(ctx, tokens.slice(1));
  const { user, rest } = await takeTarget(ctx, tokens);
  if (!user) return ctx.warn('Who is the note about?', `Try ${USAGE.note}.`);
  const raw = rest.join(' ').trim();
  if (!raw) return ctx.warn('What should the note say?', `Type it after their name, like ${USAGE.note}.`);
  return saveNote(ctx, user, raw);
}

async function saveNote(ctx, user, raw) {
  const label = tag(user);
  let out;
  try {
    out = await svc(ctx).act(ctx.serverId, { actorId: ctx.userId, kind: 'note', targetId: user.id, targetName: label, note: raw });
  } catch (e) {
    return ctx.fail(e);
  }
  const lines = [
    `**${label}:** ${clip(out.note.text, 300)}`,
    `-# Note #${out.note.id}. Only mods can read notes, and ${label} wasn't told. They have ${out.count} note${out.count === 1 ? '' : 's'}.`,
  ];
  if (out.cut) lines.push(`-# I kept the first ${NOTE_MAX_LEN} characters.`);
  if (out.dropped) lines.push(`-# People keep up to ${MAX_NOTES_PER_USER} notes, so I let go of the oldest one.`);
  return ctx.ok('Note saved', lines.join('\n'));
}

function noteLine(n) {
  return `\`#${n.id}\` ${clip(n.text, 160)} · ${n.byName || 'a mod'} · ${ago(n.at)}`;
}

async function showNotes(ctx, tokens) {
  const { user } = await takeTarget(ctx, tokens);
  if (!user) return ctx.warn('Whose notes?', `Try ${USAGE.notes}.`);
  return ctx.ephemeral(notesView(ctx, user));
}

function notesView(ctx, user) {
  const label = tag(user);
  const notes = readData(ctx.engine, ctx.serverId).notes.filter((n) => n.targetId === user.id);
  const body = notes.length
    ? `${notes.slice(-15).reverse().map(noteLine).join('\n')}\n\n-# Only mods can read these. Remove one with ${USAGE.unnote}.`
    : `Nothing written yet. Press **Add note** or type ${USAGE.note.replace('@sam', label)}.`;
  return {
    embeds: [card({ title: `🗒️ Notes on ${label} (${notes.length})`, body, color: 'mod' })],
    components: [row(button('Add note', cid('unote', user.id), 'primary', '📝'))],
  };
}

async function lookupNotes(ctx) {
  const user = await lookupTarget(ctx);
  if (!user) return expiredQuestion(ctx);
  return ctx.ephemeral(notesView(ctx, user));
}

async function lookupAddNote(ctx) {
  const user = await lookupTarget(ctx);
  if (!user) return expiredQuestion(ctx);
  return ctx.form({
    title: clip(`Note on ${tag(user)}`, 45),
    action: 'unotesave',
    args: [user.id],
    fields: [{ id: 'text', label: 'Note (only mods can read it)', style: 'paragraph', max: NOTE_MAX_LEN, placeholder: 'Was warned in DMs about spam' }],
  });
}

async function saveLookupNote(ctx) {
  const user = await lookupTarget(ctx);
  if (!user) return expiredQuestion(ctx);
  const raw = String(ctx.values?.text || '').trim();
  if (!raw) return ctx.warn('The note was empty', 'Nothing was saved.');
  return saveNote(ctx, user, raw);
}

async function removeNote(ctx, tokens) {
  const id = Number(String(tokens[0] || '').replace(/^#/, ''));
  if (!Number.isInteger(id) || id < 1) return ctx.warn('Which note?', `Give me the note number, like ${USAGE.unnote}.`);
  const note = readData(ctx.engine, ctx.serverId).notes.find((n) => n.id === id);
  if (!note) return ctx.warn(`No note #${id}`, "I couldn't find that note. `/mod notes @sam` lists someone's notes with their numbers.");
  if (note.by !== ctx.userId && !(await isStaffAbove(ctx))) {
    return ctx.ephemeral({ embeds: [dialog.denied('admin', { body: `Note #${id} was written by ${note.byName || 'another mod'}, so only they or an admin can remove it.` })] });
  }
  writeData(ctx.engine, ctx.serverId, (d) => { d.notes = d.notes.filter((n) => n.id !== id); });
  return ctx.ok('Note removed', `Note #${id} on ${note.targetName || 'them'} is gone.`);
}

function timeoutEnd(member, now) {
  const t = member?.timeout ?? member?.timeout_until ?? member?.timed_out_until ?? null;
  if (!t) return null;
  let raw = typeof t === 'object' ? (t.until ?? t.expires_at ?? t.ends_at ?? t.timeout_until ?? null) : t;
  if (raw === null || raw === undefined || raw === true) return { at: null };
  if (typeof raw === 'number' && raw < 1e12) raw *= 1000;
  const at = typeof raw === 'number' ? raw : Date.parse(raw);
  if (!Number.isFinite(at)) return { at: null };
  return at > now ? { at } : null;
}

function shortCaseLine(c) {
  const dur = c.durationMs ? ` · ${formatDuration(c.durationMs)}` : '';
  const why = c.reason ? ` · ${clip(c.reason, 50)}` : '';
  return `\`#${c.id}\` ${ACTION_ICONS[c.action] || '•'} **${ACTION_LABELS[c.action] || c.action}**${dur}${why} · ${ago(c.at)}${c.undone ? ' · *undone*' : ''}`;
}

async function topRoles(ctx, member) {
  const mine = new Set(member?.roles || []);
  if (!mine.size) return 'None';
  const all = await ctx.engine.perms.roles(ctx.serverId).catch(() => []);
  const list = all.filter((r) => mine.has(r.id) && !/^@?everyone$/i.test(r.name || '') && r.id !== ctx.serverId)
    .sort((a, b) => (b.position ?? 0) - (a.position ?? 0));
  if (!list.length) return 'None';
  const shown = list.slice(0, 5).map((r) => `**${clip(r.name, 40)}**`).join(', ');
  return list.length > 5 ? `${shown} and ${list.length - 5} more` : shown;
}

async function lookupView(ctx, user) {
  const { engine, serverId } = ctx;
  refreshRoles(engine, serverId, user.id);
  const member = await ctx.bot.member(serverId, user.id).catch(() => null);
  const label = tag(member || user);
  const now = nowMs(engine);
  const data = readData(engine, serverId);
  const fields = [];
  if (member) {
    const shown = member.nickname || member.display_name;
    fields.push({ name: 'Name', value: shown && shown !== member.username ? `${clip(shown, 60)} (@${member.username})` : `@${member.username}`, inline: true });
    const joined = Date.parse(member.joined_at || '');
    if (Number.isFinite(joined)) fields.push({ name: 'Joined', value: `${dayText(joined)} (${roughSpan(Math.max(0, now - joined))} ago)`, inline: true });
    fields.push({ name: 'Roles', value: await topRoles(ctx, member), inline: false });
    if (member.invite_code || member.inviter_id) {
      const inviter = member.inviter_id ? await nameFor(engine, serverId, member.inviter_id) : null;
      const code = member.invite_code ? `\`${clip(member.invite_code, 40)}\`` : 'an invite';
      fields.push({ name: 'Joined with', value: `${code}${inviter ? ` from ${inviter}` : ''}`, inline: true });
    }
    const t = timeoutEnd(member, now);
    fields.push({ name: 'Timeout', value: t ? (t.at ? `Until ${untilText(t.at, now)} (${longDuration(t.at - now)} left)` : 'Timed out right now') : 'None', inline: true });
  } else {
    fields.push({ name: 'Name', value: `${label}\nNot in the server right now.`, inline: true });
    const bans = await ctx.bot.bans(serverId).catch(() => null);
    const banned = Array.isArray(bans) && bans.some((b) => (b.user_id ?? b.user?.id) === user.id);
    const job = pendingUnban(engine, serverId, user.id);
    if (banned || job) fields.push({ name: 'Ban', value: job ? `Banned until ${untilText(job.at, now)} (in ${longDuration(Math.max(MIN_MS, job.at - now))})` : 'Banned', inline: true });
  }
  const warns = activeWarns(engine, serverId, user.id, data).length;
  const notes = data.notes.filter((n) => n.targetId === user.id);
  fields.push({ name: 'Active warnings', value: String(warns), inline: true });
  fields.push({ name: 'Notes', value: String(notes.length), inline: true });
  const cases = data.cases.filter((c) => c.targetId === user.id);
  fields.push({ name: `Last cases (${cases.length} in all)`, value: cases.slice(-5).reverse().map(shortCaseLine).join('\n') || 'None. A clean record.', inline: false });
  const buttons = [];
  if (member) {
    buttons.push(button('Warn', cid('uwarn', user.id), 'secondary', '⚠️'));
    buttons.push(button('Timeout', cid('uto', user.id), 'secondary', '⏳'));
  }
  const alreadyBanned = fields.some((f) => f.name === 'Ban');
  if (!alreadyBanned) buttons.push(button('Ban', cid('uban', user.id), 'danger', '🔨'));
  buttons.push(button(notes.length ? `Notes (${notes.length})` : 'Notes', cid('unotes', user.id), 'secondary', '🗒️'));
  buttons.push(button('Add note', cid('unote', user.id), 'secondary', '📝'));
  const body = notes.length ? `Press **Notes** to read what mods wrote about ${label}.` : 'No notes yet. Press **Add note** to write one only mods can see.';
  return {
    embeds: [card({ title: `🔎 ${label}`, body, fields, color: 'mod' })],
    components: buttons.length ? [row(...buttons)] : [],
  };
}

async function runLookup(ctx, tokens) {
  try {
    const { user } = await takeTarget(ctx, tokens);
    if (!user) return await ctx.warn('Who should I look up?', `Try ${USAGE.user}.`);
    return await ctx.ephemeral(await lookupView(ctx, user));
  } catch (e) {
    return ctx.fail(e);
  }
}

async function lookupTarget(ctx) {
  const id = userId(ctx.argv[0]);
  if (!id) return null;
  return (await ctx.findUser(id)) || { id };
}

const pendingWarns = new Map();

function rememberWarn(ctx, targetId) {
  const now = Date.now();
  for (const [k, v] of pendingWarns) if (v.expires < now) pendingWarns.delete(k);
  if (pendingWarns.size >= MAX_PENDING) pendingWarns.delete(pendingWarns.keys().next().value);
  pendingWarns.set(`${ctx.serverId}:${ctx.userId}`, { targetId, expires: now + PENDING_TTL_MS });
}

function takeWarn(ctx) {
  const k = `${ctx.serverId}:${ctx.userId}`;
  const p = pendingWarns.get(k);
  pendingWarns.delete(k);
  return p && p.expires >= Date.now() ? p : null;
}

async function lookupWarn(ctx) {
  const user = await lookupTarget(ctx);
  if (!user) return expiredQuestion(ctx);
  const label = tag(user);
  try {
    await checkCanAct(ctx.engine, ctx.serverId, ctx.userId, user.id, ACTIONS.warn, label);
  } catch (e) {
    return ctx.fail(e, { action: 'warn', target: label });
  }
  rememberWarn(ctx, user.id);
  return ctx.form({
    title: clip(`Warn ${label}`, 45),
    action: 'uwarnsave',
    fields: [{ id: 'reason', label: 'Reason (optional)', style: 'paragraph', required: false, max: 200, placeholder: 'Spamming links in general' }],
  });
}

async function saveLookupWarn(ctx) {
  const p = takeWarn(ctx);
  if (!p) return expiredQuestion(ctx);
  const user = (await ctx.findUser(p.targetId)) || { id: p.targetId };
  return performAction(ctx, 'warn', user, { reason: String(ctx.values?.reason || '').trim() });
}

async function lookupTimeout(ctx) {
  const user = await lookupTarget(ctx);
  if (!user) return expiredQuestion(ctx);
  return askTimeoutLength(ctx, user, []);
}

const BAN_CHOICES = { perm: { label: 'Permanent', ms: null }, '1d': { label: '1 day', ms: DAY_MS }, '7d': { label: '7 days', ms: 7 * DAY_MS }, '30d': { label: '30 days', ms: 30 * DAY_MS } };

async function lookupBan(ctx) {
  const user = await lookupTarget(ctx);
  if (!user) return expiredQuestion(ctx);
  const label = tag(user);
  try {
    await checkCanAct(ctx.engine, ctx.serverId, ctx.userId, user.id, ACTIONS.ban, label);
  } catch (e) {
    return ctx.fail(e, { action: ACTIONS.ban.verb, perm: ACTIONS.ban.perm, target: label });
  }
  const sid = ctx.engine.router.session({ kind: 'ban', userId: ctx.userId, serverId: ctx.serverId, targetId: user.id });
  const buttons = Object.entries(BAN_CHOICES).map(([k, v]) => button(v.label, cid('blen', sid, k), k === 'perm' ? 'danger' : 'primary'));
  buttons.push(button('Cancel', cid('blen', sid, 'cancel'), 'secondary'));
  const body = `How long should ${label} be banned?\n-# To add a reason, type it instead, like \`/ban ${label} 7d spamming\`.`;
  return ctx.ephemeral({ embeds: [dialog.warn('Ban', body, { color: 'mod' })], components: [row(...buttons)] });
}

async function pickBanLength(ctx) {
  const [sid, choice] = ctx.argv;
  const s = ctx.engine.router.getSession(sid);
  if (!ownQuestion(ctx, s, 'ban')) return expiredQuestion(ctx);
  ctx.engine.router.dropSession(sid);
  if (choice === 'cancel') return cancelled(ctx);
  const picked = BAN_CHOICES[choice];
  if (!picked) return expiredQuestion(ctx);
  const user = (await ctx.findUser(s.targetId)) || { id: s.targetId };
  return performAction(ctx, 'ban', user, { durationMs: picked.ms, respond: (p) => ctx.update(p) });
}

function askLookup(ctx) {
  return ctx.form({
    title: 'Look someone up',
    action: 'lookupsave',
    fields: [{ id: 'who', label: 'Who? A name, @mention or user id', style: 'short', max: 100, placeholder: 'sam' }],
  });
}

async function tellUnbanFailed(engine, serverId, targetId, name, error) {
  const service = engine.service(ID) || createService(engine);
  const { body } = explain(error, { action: 'unban', perm: 'ban_members', target: name || 'them' });
  const text = `${name || 'Someone'}'s temporary ban ended, but I couldn't lift it: ${body}\nUnban them by hand with \`/mod unban ${targetId}\`.`;
  await service.log(serverId, dialog.warn("I couldn't lift a ban", text, { color: 'mod' }));
}

async function runUnbanJob(job, engine) {
  const serverId = job.serverId;
  const targetId = job.data?.userId || job.key;
  if (!serverId || !targetId) return undefined;
  if (!engine.settings.isEnabled(serverId, ID)) {
    engine.scheduler.schedule({ kind: UNBAN_KIND, at: engine.scheduler.now() + UNINSTALLED_RETRY_MS, serverId, key: job.key || targetId, data: { ...(job.data || {}), userId: targetId, paused: true } });
    return undefined;
  }
  if (readData(engine, serverId).cases.some((c) => c.meta?.jobId === job.id)) return undefined;
  const bans = await engine.bot.bans(serverId).catch(() => null);
  if (Array.isArray(bans) && !bans.some((b) => (b.user_id ?? b.user?.id) === targetId)) return undefined;
  try {
    await engine.bot.unban(serverId, targetId);
  } catch (e) {
    if (e?.status !== 404) {
      if ((job.attempt || 1) < MAX_TRIES) throw e;
      await tellUnbanFailed(engine, serverId, targetId, job.data?.name, e);
      return undefined;
    }
  }
  const why = job.late ? ' (I was offline when it ended)' : job.data?.paused ? ' (Mod was uninstalled when it ended)' : '';
  const service = engine.service(ID) || createService(engine);
  const c = await service.addCase(serverId, { action: 'unban', targetId, targetName: job.data?.name, actorId: engine.bot.me?.id ?? null, actorName: '@YapOS', reason: `Ban expired${why}`, meta: { jobId: job.id, expired: true } });
  await service.logCase(serverId, c);
  return undefined;
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

const DECAY_HELP = 'Use a whole number of days, like 30, or 0 to keep warnings forever.';
const stepsHelp = (error) => `${error}\nWrite them like: \`3 timeout 1h, 5 kick, 7 ban\`.`;
const LOG_OFF = /^(off|none|clear|remove|disable)$/;
const LOG_MISSING = 'Mention it, like `/mod log #mod-log`.';

function checkDecayDays(raw) {
  const typed = String(raw ?? '').trim();
  const days = Number(typed);
  return /^\d{1,4}$/.test(typed) && days <= 3650 ? days : null;
}

const roleList = (ids) => (ids || []).length ? ids.map((r) => `<@&${r}>`).join(' ') : 'None';

async function runLogChannel(ctx, tokens) {
  const first = (tokens[0] || '').toLowerCase();
  const current = ctx.core().logChannel;
  if (!first) {
    return ctx.info('Mod log channel', `${current ? `Mod actions are logged in <#${current}>.` : 'No log channel yet.'}\nSet one with \`/mod log #mod-log\`, or turn it off with \`/mod log off\`.`);
  }
  if (LOG_OFF.test(first)) {
    ctx.engine.settings.patchCore(ctx.serverId, { logChannel: null });
    return ctx.ok('Log channel cleared', 'Mod actions are no longer logged anywhere.');
  }
  const ch = await ctx.findChannel(tokens.join(' '), 'text');
  if (!ch || ch.server_id && ch.server_id !== ctx.serverId) return ctx.warn("I couldn't find that channel", LOG_MISSING);
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
  const tempBans = ctx.engine.scheduler ? ctx.engine.scheduler.list({ kind: UNBAN_KIND, serverId: ctx.serverId }).length : 0;
  const recent = data.cases.slice(-5).reverse().map(caseLine).join('\n') || 'No cases yet. Quiet server!';
  const fields = [
    { name: 'Cases', value: String(data.cases.length), inline: true },
    { name: 'Last 24h', value: String(lastDay), inline: true },
    { name: 'Active warnings', value: String(activeWarnCount), inline: true },
    { name: 'Locked channels', value: String(locked), inline: true },
    { name: 'Temporary bans', value: String(tempBans), inline: true },
    { name: 'Recent', value: recent, inline: false },
  ];
  const body = 'Type an action, like `/mod timeout @sam 10m spam`, `/mod warn @sam`, `/ban @sam 7d spam`, `/mod purge 20`, `/mod slowmode 10s`.\nLook people up with `/mod user @sam`, keep private notes with `/mod note @sam text`.\nShortcuts: /warn /timeout /kick /ban /purge /lock /unlock /case';
  return {
    embeds: [card({ title: `${ICONS.mod} Mod`, body, fields, color: 'mod' })],
    components: [
      row(
        button('Lock this channel', cid('lock'), 'danger', ICONS.lock),
        button('Unlock this channel', cid('unlock'), 'success', ICONS.unlock),
        button('Clear 10 messages', cid('purge', 10), 'secondary', '🧹'),
      ),
      row(
        button('Look up', cid('lookup'), 'primary', '🔎'),
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
    if (sub === 'note') return await runNote(ctx, tokens);
    if (sub === 'unnote') return await removeNote(ctx, tokens);
    if (sub === 'notes') return await showNotes(ctx, tokens);
    if (sub === 'user') return await runLookup(ctx, tokens);
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

function stepsText(v) {
  if (typeof v === 'string') return v;
  if (!Array.isArray(v)) return null;
  const parts = [];
  for (const s of v) {
    if (!s || typeof s !== 'object') return null;
    const action = String(s.action ?? '');
    const len = action === 'timeout' && s.durationMs ? ` ${formatDuration(Number(s.durationMs))}` : '';
    parts.push(`${s.at} ${action}${len}`);
  }
  return parts.join(', ');
}

const DASHBOARD = [
  {
    key: 'dmOnAction', label: 'DM people before kick, ban or timeout', type: 'boolean', web: true,
    help: 'Sends the member a DM saying what happened and why.',
    validate: (ctx, v) => (typeof v === 'boolean' ? accept(v) : reject('Use on or off.')),
  },
  {
    key: 'warnDecayDays', label: 'Days a warning counts for', type: 'number', web: true, min: 0, max: 3650, step: 1,
    help: 'Warnings older than this stop counting toward the automatic steps. 0 keeps them forever.',
    validate: (ctx, v) => {
      const days = checkDecayDays(v);
      return days === null ? reject(DECAY_HELP) : accept(days);
    },
  },
  {
    key: 'escalation', label: 'Automatic warning steps', type: 'complex', web: true, maxLength: STEPS_MAX,
    help: 'What happens automatically when someone reaches a number of active warnings, like: 3 timeout 1h, 5 kick, 7 ban.',
    validate: (ctx, v) => {
      const text = stepsText(v);
      if (text === null) return reject(stepsHelp("I didn't understand those steps."));
      if (text.length > STEPS_MAX) return reject(stepsHelp(`Keep it under ${STEPS_MAX} characters.`));
      const parsed = parseSteps(text);
      return parsed.error ? reject(stepsHelp(parsed.error)) : accept(parsed.steps);
    },
  },
  {
    key: 'core.logChannel', label: 'Mod log channel', type: 'channel', web: true,
    help: 'Where mod cases, Automod alerts and warnings from other apps are posted. Empty turns logging off.',
    validate: async (ctx, v) => {
      if (isBlank(v) || (typeof v === 'string' && LOG_OFF.test(v.trim().toLowerCase()))) return accept(null);
      const ch = await channelById(ctx, v);
      return ch ? accept(ch.id) : reject(LOG_MISSING);
    },
  },
  { key: 'core.modRoles', label: 'Extra mod roles', type: 'roles', web: false, max: 10, help: 'People with these roles count as YapOS moderators.', note: 'Change these in the server with /mod modrole add @role.' },
  { key: 'core.adminRoles', label: 'Extra admin roles', type: 'roles', web: false, max: 10, help: 'People with these roles count as YapOS admins.', note: 'Only the server owner can change these, with /mod adminrole add @role.' },
];

const YAP_WORDS = ['timeout', 'mute', 'unmute', 'untimeout', 'kick', 'ban', 'unban', 'warn', 'warnings', 'purge', 'clear', 'slowmode', 'lock', 'unlock', 'case', 'whois'];

export const { setup, teardown, check } = defineApp({
  id: ID,
  name: 'Mod',
  icon: ICONS.mod,
  description: 'Timeouts, warnings, bans, purge, locks and case history.',
  category: 'Moderation',
  panelPerm: 'mod',

  defaults: {
    dmOnAction: true,
    warnDecayDays: 30,
    escalation: DEFAULT_ESCALATION,
  },

  commands: {
    mod: { description: 'Mod panel, or type: /mod timeout @sam 10m spam, /mod user @sam, /mod note @sam text', perm: 'mod', run: runHub },
    warn: { description: 'Warn someone: /warn @sam reason (repeat warnings add timeouts, kicks, bans)', perm: 'mod', run: shortcut('warn') },
    timeout: { description: 'Time someone out: /timeout @sam 10m reason (off clears it)', perm: 'mod', run: shortcut('timeout') },
    kick: { description: 'Kick someone: /kick @sam reason', perm: 'mod', run: shortcut('kick') },
    ban: { description: 'Ban someone: /ban @sam reason, or /ban @sam 7d reason to lift it after 7 days', perm: 'mod', run: shortcut('ban') },
    purge: { description: 'Delete recent messages: /purge 20, or /purge 20 @sam for one person', perm: 'mod', run: shortcut('purge') },
    lock: { description: 'Stop everyone posting here: /lock, or /lock announcements reason', perm: 'mod', run: shortcut('lock') },
    unlock: { description: 'Let everyone post again: /unlock or /unlock #channel', perm: 'mod', run: shortcut('unlock') },
    case: { description: 'Look up a mod case: /case 12, /case 12 reason new text, or /case for recent ones', perm: 'mod', run: shortcut('case') },
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
    lookup: { perm: 'mod', run: staff('mod', askLookup) },
    lookupsave: { perm: 'mod', run: staff('mod', (ctx) => runLookup(ctx, tokenize(String(ctx.values?.who || '')))) },
    uwarn: { perm: 'mod', run: staff('mod', lookupWarn) },
    uwarnsave: { perm: 'mod', run: staff('mod', saveLookupWarn) },
    uto: { perm: 'mod', run: staff('mod', lookupTimeout) },
    uban: { perm: 'mod', run: staff('mod', lookupBan) },
    unotes: { perm: 'mod', run: staff('mod', lookupNotes) },
    unote: { perm: 'mod', run: staff('mod', lookupAddNote) },
    unotesave: { perm: 'mod', run: staff('mod', saveLookupNote) },
    blen: { perm: 'mod', run: staff('mod', pickBanLength) },
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
        const days = checkDecayDays(ctx.values?.days);
        if (days === null) return ctx.warn("That number didn't work", DECAY_HELP);
        const parsed = parseSteps(ctx.values?.steps || '');
        if (parsed.error) return ctx.warn("Those steps didn't work", stepsHelp(parsed.error));
        ctx.patchConfig({ warnDecayDays: days, escalation: parsed.steps });
        return ctx.ok('Warning rules saved', `Warnings count for ${days ? `${days} days` : 'forever'}.\nSteps: ${formatSteps(parsed.steps) || 'none'}.`);
      },
    },
  },

  jobs: {
    unban: runUnbanJob,
  },

  onInstall: (engine, serverId) => {
    const s = engine.scheduler;
    if (!s) return;
    for (const job of s.list({ kind: UNBAN_KIND, serverId })) {
      if (job.data?.paused) s.schedule({ kind: UNBAN_KIND, at: s.now(), serverId, key: job.key, data: job.data });
    }
  },

  yap: [{
    words: YAP_WORDS,
    run: async (ctx) => {
      if (await refuseUnless(ctx, 'mod')) return undefined;
      return route(ctx, SUB_ALIASES[ctx.word] || 'panel', ctx.argv);
    },
  }],

  panel: showPanel,

  dashboard: DASHBOARD,

  services: (engine) => ({ ...createService(engine), activeWarns: (sid, uid) => activeWarns(engine, sid, uid) }),

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
    'Temporary bans: `/ban @sam 7d spamming` lifts the ban by itself after 7 days (up to 1 year). Leave the length out for a permanent ban.',
    'Fix a case reason with `/case 12 reason new text`. Mods can edit their own cases, admins any. The old reason stays in the history.',
    '`/mod user @sam` shows joins, roles, timeout, warnings, notes and recent cases, with Warn, Timeout and Ban buttons.',
    'Private notes: `/mod note @sam text` (no warning, no DM), `/mod notes @sam` to read them, `/mod note remove 4` to delete one.',
    'Bans, timeouts, warnings, locks and slowmode changes come with an Undo button for 10 minutes.',
    'Admins: `/mod log #mod-log` picks where actions are logged. `/mod modrole add @Helpers` makes a role count as mods.',
    'Server owner: `/mod adminrole add @Managers` makes a role count as YapOS admins.',
  ],
});
