import { defineApp } from '../engine/apps.js';
import { card, dialog, button, row, select, onOff, ICONS } from '../engine/ui.js';
import { customId } from '../engine/router.js';
import { tokenize, didYouMean, roleId as parseRoleId, channelId as parseChannelId, formatDuration, clip } from '../engine/parse.js';
import { looksLikeFeatureOff } from '../engine/errors.js';

const ID = 'automod';
const cid = (action, ...args) => customId(ID, action, ...args);

const FILTERS = {
  spam: { label: 'Spam & flood', emoji: '🌊', words: ['spam', 'flood', 'flooding', 'dupes', 'duplicates'] },
  mentions: { label: 'Mass mentions', emoji: '📣', words: ['mentions', 'mention', 'pings', 'ping', 'everyone'] },
  caps: { label: 'Caps lock', emoji: '🔠', words: ['caps', 'capitals', 'shouting', 'capslock'] },
  links: { label: 'Links', emoji: '🔗', words: ['links', 'link', 'urls', 'url'] },
  invites: { label: 'Invites', emoji: '✉️', words: ['invites', 'invite', 'invitelinks'] },
  words: { label: 'Word filter', emoji: '🤬', words: ['words', 'word', 'badwords', 'swears', 'filter'] },
  raid: { label: 'Raid shield', emoji: '🛡️', words: ['raid', 'raids', 'raidshield', 'antiraid'] },
};

const STRICTNESS = {
  relaxed: { label: 'Relaxed', emoji: '😌', scale: 1.5, caps: 85 },
  normal: { label: 'Normal', emoji: '🙂', scale: 1, caps: 70 },
  strict: { label: 'Strict', emoji: '😠', scale: 0.7, caps: 60 },
};

const NOTICES = {
  flood: 'slow down a little, please.',
  dupes: 'no need to repeat that.',
  mentions: "please don't mass-mention people.",
  everyone: 'only mods can ping everyone.',
  caps: 'easy on the caps, please.',
  links: "links aren't allowed here.",
  invites: "invite links aren't allowed here.",
  words: 'please watch your language.',
};

const REASONS = {
  flood: 'Sending messages too fast',
  dupes: 'Repeating the same message',
  mentions: 'Mass mentions',
  everyone: 'Tried to ping everyone',
  caps: 'Too many capital letters',
  links: 'Posted a link that is not allowed',
  invites: 'Posted an invite link',
  words: 'Used a filtered word',
};

const FILTER_OF = { flood: 'spam', dupes: 'spam', mentions: 'mentions', everyone: 'mentions', caps: 'caps', links: 'links', invites: 'invites', words: 'words' };

const ALL_OFF = { spam: false, mentions: false, caps: false, links: false, invites: false, words: false, raid: false };
const PRESETS = {
  gaming: { filters: { ...ALL_OFF, spam: true, mentions: true, invites: true, words: true }, strictness: 'normal', summary: 'spam and mention filters on' },
  friends: { filters: { ...ALL_OFF, spam: true, words: true }, strictness: 'relaxed', summary: 'a light spam filter, relaxed' },
  study: { filters: { ...ALL_OFF, spam: true, caps: true, links: true, words: true }, strictness: 'normal', summary: 'caps and link filters on' },
  community: { filters: { spam: true, mentions: true, caps: true, links: true, invites: true, words: true, raid: true }, strictness: 'normal', summary: 'every filter plus the raid shield' },
  roleplay: { filters: { ...ALL_OFF, spam: true, mentions: true }, strictness: 'normal', summary: 'spam and mention filters only' },
};

const DEFAULTS = {
  strictness: 'normal',
  filters: { spam: true, mentions: true, caps: false, links: false, invites: true, words: true, raid: false },
  spam: { max: 6, seconds: 8, dupes: 3, dupeSeconds: 30, timeoutMinutes: 5 },
  mentions: { max: 5 },
  caps: { percent: 70, minLetters: 12 },
  links: { allow: [] },
  words: { list: [] },
  raid: { joins: 8, seconds: 20, autoLiftMinutes: 15 },
  exempt: { channels: [], roles: [] },
  verify: { enabled: false, channelId: null, roleId: null },
};

const NOTICE_GAP_MS = 30_000;
const STRIKE_GAP_MS = 30_000;
const NOTICE_TTL_MS = 8_000;
const TRACK_MS = 60_000;
const MAX_TRACKED = 5000;
const LIFT_RETRY_MS = 5 * 60_000;
const RESUME_DELAY_MS = 15_000;
const VERIFY_ALERT_GAP_MS = 10 * 60_000;
const MAX_ALERTS = 200;
const ELEVATED_PERMS = ['administrator', 'manage_server', 'manage_roles', 'manage_channels', 'manage_messages', 'manage_webhooks', 'manage_nicknames', 'manage_threads', 'manage_emojis', 'manage_events', 'kick_members', 'ban_members', 'timeout_members', 'move_members', 'mute_members', 'deafen_members', 'mention_everyone'];
const own = (table, key) => typeof key === 'string' && Object.hasOwn(table, key);

const memories = new WeakMap();

function mem(engine) {
  let m = memories.get(engine);
  if (!m) {
    m = { tracker: new Map(), noticeAt: new Map(), strikeAt: new Map(), joins: new Map(), liftTimers: new Map(), warnedNoDelete: new Set(), busy: new Set(), verifyAlertAt: new Map(), alerts: new Set(), pruneTimer: null };
    memories.set(engine, m);
  }
  return m;
}

const now = () => Date.now();

function capMap(map) {
  while (map.size > MAX_TRACKED) map.delete(map.keys().next().value);
}

function prune(engine) {
  const { tracker, noticeAt, strikeAt, joins } = mem(engine);
  const cut = now() - TRACK_MS;
  for (const [k, v] of tracker) {
    v.msgs = v.msgs.filter((m) => m.t > cut);
    if (!v.msgs.length) tracker.delete(k);
  }
  for (const map of [noticeAt, strikeAt]) for (const [k, t] of map) if (t <= cut) map.delete(k);
  for (const [k, list] of joins) {
    const kept = list.filter((t) => t > cut);
    if (kept.length) joins.set(k, kept); else joins.delete(k);
  }
}

function limits(cfg) {
  const s = STRICTNESS[cfg.strictness] || STRICTNESS.normal;
  const scaled = (n) => Math.max(2, Math.round(n * s.scale));
  return {
    floodMax: scaled(cfg.spam.max),
    floodMs: cfg.spam.seconds * 1000,
    dupes: Math.max(2, cfg.spam.dupes + (s.scale > 1 ? 1 : s.scale < 1 ? -1 : 0)),
    dupeMs: cfg.spam.dupeSeconds * 1000,
    mentionMax: scaled(cfg.mentions.max),
    capsPercent: cfg.strictness === 'normal' ? cfg.caps.percent : s.caps,
    capsMin: cfg.caps.minLetters,
  };
}

const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's' };

function deaccent(text) {
  return String(text ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function wordTokens(text) {
  const raw = deaccent(text).split(/[\s,;:!?()"'[\]{}<>/\\|]+/).filter(Boolean);
  const mapped = raw.map((w) => [...w].map((c) => LEET[c] ?? c).join('').replace(/[^a-z0-9]/g, '')).filter(Boolean);
  const merged = [];
  let run = '';
  for (const w of mapped) {
    if (w.length === 1) { run += w; continue; }
    if (run) { merged.push(run); run = ''; }
    merged.push(w);
  }
  if (run) merged.push(run);
  return { tokens: mapped, merged };
}

export function normalizeWord(word) {
  return wordTokens(word).tokens.join(' ');
}

function wordPattern(entry) {
  const parts = normalizeWord(entry).split(' ').filter(Boolean);
  if (!parts.length) return null;
  const body = parts.map((p) => [...p].map((c) => `${c}+`).join('')).join(' ');
  return new RegExp(`(?:^| )${body}(?:$| )`);
}

export function findBadWord(text, list) {
  if (!list?.length) return null;
  const { tokens, merged } = wordTokens(text);
  const lines = [tokens.join(' '), merged.join(' ')];
  for (const entry of list) {
    const re = wordPattern(entry);
    if (re && lines.some((l) => re.test(l))) return entry;
  }
  return null;
}

const INVITE_RE = /(?:yapin\.gg\/invite\/|yapper\.website\/(?:invite\/|i\/)|discord\.gg\/|discord(?:app)?\.com\/invite\/)\S+/i;
const LINK_RE = /https?:\/\/[^\s<>]+/gi;
const EVERYONE_RE = /(?:^|[^\w.@-])@(?:everyone|here)(?![\w.-]*\w)/i;

function hostOf(link) {
  try { return new URL(link).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; }
}

export function cleanDomain(text) {
  const t = String(text ?? '').trim().toLowerCase();
  const host = hostOf(/^https?:\/\//.test(t) ? t : `https://${t}`);
  return host && /^[a-z0-9.-]+\.[a-z]{2,}$/.test(host) ? host : null;
}

function blockedLink(content, allow) {
  for (const link of String(content).match(LINK_RE) || []) {
    const host = hostOf(link);
    if (!host) continue;
    if (!allow.some((d) => host === d || host.endsWith(`.${d}`))) return host;
  }
  return null;
}

function capsShare(content) {
  const text = String(content).replace(/<[@#][!&]?[\w-]+>/g, '').replace(LINK_RE, '').replace(/:[\w-]+:/g, '');
  const letters = text.replace(/[^A-Za-z]/g, '');
  if (!letters.length) return { letters: 0, share: 0 };
  return { letters: letters.length, share: (letters.replace(/[^A-Z]/g, '').length / letters.length) * 100 };
}

function distinctMentions(content) {
  return new Set([...String(content).matchAll(/<@[!&]?([\w-]+)>/g)].map((m) => m[0].replace('!', ''))).size;
}

function trackMessage(engine, sid, uid, msg, lim) {
  const { tracker } = mem(engine);
  const key = `${sid}:${uid}`;
  const t = now();
  const entry = tracker.get(key) || { msgs: [] };
  const cut = t - Math.max(lim.floodMs, lim.dupeMs);
  entry.msgs = entry.msgs.filter((m) => m.t > cut);
  const text = deaccent(msg.content).replace(/\s+/g, ' ').trim();
  entry.msgs.push({ t, id: msg.id, channelId: msg.channel_id, text, deleted: false });
  if (entry.msgs.length > 50) entry.msgs.splice(0, entry.msgs.length - 50);
  tracker.delete(key);
  tracker.set(key, entry);
  capMap(tracker);
  const recent = entry.msgs.filter((m) => m.t > t - lim.floodMs);
  const same = text ? entry.msgs.filter((m) => m.t > t - lim.dupeMs && m.text === text) : [];
  return { entry, recent, same };
}

function checkMessage(cfg, msg, track) {
  const f = cfg.filters;
  const lim = limits(cfg);
  const content = String(msg.content || '');
  if (f.spam && track) {
    if (track.recent.length > lim.floodMax) return { kind: 'flood', burst: track.recent };
    if (track.same.length >= lim.dupes) return { kind: 'dupes', burst: track.same };
  }
  if (f.mentions) {
    if (EVERYONE_RE.test(content)) return { kind: 'everyone' };
    if (distinctMentions(content) > lim.mentionMax) return { kind: 'mentions' };
  }
  if (f.invites && INVITE_RE.test(content)) return { kind: 'invites' };
  if (f.links) {
    const host = blockedLink(content, cfg.links.allow || []);
    if (host) return { kind: 'links', detail: host };
  }
  if (f.words) {
    const hit = findBadWord(content, cfg.words.list);
    if (hit) return { kind: 'words', detail: hit };
  }
  if (f.caps) {
    const { letters, share } = capsShare(content);
    if (letters >= lim.capsMin && share > lim.capsPercent) return { kind: 'caps' };
  }
  return null;
}

async function logChannelId(engine, sid) {
  const core = engine.settings.core(sid);
  if (core.logChannel) return core.logChannel;
  const found = await engine.detectChannels(sid).catch(() => ({}));
  return found.logs?.id || null;
}

async function generalChannelId(engine, sid) {
  const found = await engine.detectChannels(sid).catch(() => ({}));
  return found.general?.id || null;
}

async function postLog(engine, sid, embed, { components, content, priority = 'low', fallbackToGeneral = false } = {}) {
  const mod = engine.service('mod');
  if (mod?.log && !components && !content) {
    try { await mod.log(sid, embed); return true; } catch (e) { engine.log.debug('mod log failed', e?.message); }
  }
  let channelId = await logChannelId(engine, sid);
  if (!channelId && fallbackToGeneral) channelId = await generalChannelId(engine, sid);
  if (!channelId) return false;
  try {
    const sent = await engine.budget.send({ serverId: sid, channelId, content: content || '', opts: { embeds: [embed], components }, priority });
    return sent || true;
  } catch (e) {
    engine.log.warn(`[automod] could not post to the log channel in ${sid}: ${e?.message}`);
    return false;
  }
}

function modPing(engine, sid) {
  const core = engine.settings.core(sid);
  return (core.modRoles || []).map((r) => `<@&${r}>`).join(' ');
}

async function isExempt(engine, sid, uid, channelIdValue, cfg) {
  if (!uid || uid === engine.bot.me?.id) return true;
  if ((cfg.exempt.channels || []).includes(channelIdValue)) return true;
  const level = await engine.perms.level(sid, uid).catch(() => 'member');
  if (engine.perms.atLeast(level, 'mod')) return true;
  const roles = cfg.exempt.roles || [];
  if (roles.length) {
    const m = await engine.perms.member(sid, uid).catch(() => null);
    if (m?.roles?.some((r) => roles.includes(r))) return true;
  }
  return false;
}

async function warnNoDelete(engine, sid) {
  const { warnedNoDelete } = mem(engine);
  if (warnedNoDelete.has(sid)) return;
  warnedNoDelete.add(sid);
  const name = await engine.perms.botRoleName(sid).catch(() => 'YapOS');
  await postLog(engine, sid, dialog.warn("Automod can't delete messages", `My role **${name}** needs **Manage Messages** to remove rule-breaking messages. Until then I'll only post reminders and log what I see.`), { content: modPing(engine, sid) || undefined, fallbackToGeneral: false });
}

async function deleteMessages(engine, sid, items) {
  const can = await engine.perms.botCan(sid, 'manage_messages').catch(() => ({ ok: true }));
  if (!can.ok) { await warnNoDelete(engine, sid); return 0; }
  mem(engine).warnedNoDelete.delete(sid);
  let done = 0;
  const pending = items.filter((item) => !item.deleted && item.id).slice(-10);
  for (const item of pending) {
    try {
      await engine.bot.delete(item.channelId, item.id);
      item.deleted = true;
      done++;
    } catch (e) {
      if (e?.status === 403) { await warnNoDelete(engine, sid); break; }
      item.deleted = true;
    }
  }
  return done;
}

async function postNotice(engine, sid, channelIdValue, uid, kind) {
  const { noticeAt } = mem(engine);
  const key = `${sid}:${uid}`;
  const last = noticeAt.get(key);
  if (last && now() - last < NOTICE_GAP_MS) return false;
  noticeAt.set(key, now());
  capMap(noticeAt);
  const p = engine.budget.send({ serverId: sid, channelId: channelIdValue, content: `<@${uid}>, ${NOTICES[kind]}`, priority: 'low', key: `automod:notice:${key}` });
  p.then((sent) => {
    if (!sent?.id) return;
    const t = setTimeout(() => engine.bot.delete(channelIdValue, sent.id).catch(() => {}), NOTICE_TTL_MS);
    t.unref?.();
  }, (e) => engine.log.debug('automod notice failed', e?.message));
  return true;
}

async function strike(engine, sid, uid, kind, cfg) {
  const key = `${sid}:${uid}:${kind}`;
  const { strikeAt } = mem(engine);
  const last = strikeAt.get(key);
  if (last && now() - last < STRIKE_GAP_MS) return null;
  strikeAt.set(key, now());
  capMap(strikeAt);
  const mod = engine.service('mod');
  const reason = `Automod: ${REASONS[kind]}`;
  const actorId = engine.bot.me?.id;
  if (!mod) return { kind: 'logged' };
  try {
    if (kind === 'flood' && mod.timeout) {
      const durationMs = cfg.spam.timeoutMinutes * 60_000;
      await mod.timeout(sid, uid, { actorId, durationMs, reason, source: 'automod' });
      return { kind: 'timeout', durationMs };
    }
    if (mod.warn) {
      const out = await mod.warn(sid, uid, { actorId, reason, source: 'automod' });
      return { kind: 'warn', count: out?.count ?? null };
    }
  } catch (e) {
    engine.log.warn(`[automod] strike failed in ${sid}: ${e?.message}`);
    return { kind: 'failed' };
  }
  return { kind: 'logged' };
}

async function handleViolation(engine, sid, msg, hit, cfg, uid) {
  const items = hit.burst?.length ? hit.burst : [{ id: msg.id, channelId: msg.channel_id, deleted: false }];
  const deleted = await deleteMessages(engine, sid, items);
  const noticed = await postNotice(engine, sid, msg.channel_id, uid, hit.kind);
  const s = await strike(engine, sid, uid, hit.kind, cfg);
  if (!noticed && !s) return;
  const strikeText = !s ? null : s.kind === 'timeout' ? `Timed out for ${formatDuration(s.durationMs)}` : s.kind === 'warn' ? `Warned${s.count ? ` (warning ${s.count})` : ''}` : s.kind === 'failed' ? "Couldn't add a strike" : 'Logged only (Mod app not installed)';
  const embed = card({
    title: `${ICONS.automod} Automod: ${REASONS[hit.kind]}`,
    body: `<@${uid}> in <#${msg.channel_id}>${hit.detail ? `\nMatched: \`${clip(hit.detail, 60)}\`` : ''}\n> ${clip(String(msg.content || '').replace(/\n/g, ' '), 200)}`,
    fields: [
      { name: 'Deleted', value: deleted ? `${deleted} message${deleted === 1 ? '' : 's'}` : 'No', inline: true },
      { name: 'Strike', value: strikeText || 'Already handled', inline: true },
    ],
    color: 'automod',
  });
  await postLog(engine, sid, embed);
}

async function onMessage(ctx, msg) {
  const { engine, serverId: sid } = ctx;
  if (!sid || msg.dm || msg.author_bot) return;
  const uid = msg.author_id || ctx.userId;
  await maybeExpireLock(engine, sid);
  const cfg = ctx.config();
  if (await isExempt(engine, sid, uid, msg.channel_id, cfg)) return;
  const lim = limits(cfg);
  const track = cfg.filters.spam ? trackMessage(engine, sid, uid, msg, lim) : null;
  if (msg.command) {
    const flood = track && track.recent.length > lim.floodMax ? { kind: 'flood', burst: track.recent } : null;
    if (flood) await handleViolation(engine, sid, msg, flood, cfg, uid);
    return;
  }
  const hit = checkMessage(cfg, msg, track);
  if (hit) await handleViolation(engine, sid, msg, hit, cfg, uid);
}

function lockState(engine, sid) {
  return engine.store.get(ID, sid, {}).lockdown || null;
}

function setLockState(engine, sid, value) {
  engine.store.update(ID, sid, (d) => { if (value) d.lockdown = value; else delete d.lockdown; }, {});
}

async function everyonePrior(engine, sid) {
  const roles = await engine.perms.roles(sid).catch(() => []);
  const everyone = roles.find((r) => /^@?everyone$/i.test(r.name) || r.id === 'everyone' || r.id === sid);
  const v = everyone?.perms?.send_messages;
  return typeof v === 'boolean' ? v : true;
}

async function lockChannel(engine, channelIdValue) {
  const overrides = await engine.bot.channelPermissions(channelIdValue).catch(() => []);
  const cur = (overrides || []).find((o) => o.role_id === null || o.role_id === 'everyone') || { allow: [], deny: [] };
  const prior = { allow: [...(cur.allow || [])], deny: [...(cur.deny || [])] };
  const allow = prior.allow.filter((p) => p !== 'send_messages');
  const deny = [...new Set([...prior.deny, 'send_messages'])];
  await engine.bot.setChannelPermissions(channelIdValue, 'everyone', { allow, deny });
  return prior;
}

async function exclusive(engine, sid, busyResult, fn) {
  const { busy } = mem(engine);
  if (busy.has(sid)) return busyResult;
  busy.add(sid);
  try { return await fn(); } finally { busy.delete(sid); }
}

export function lockdown(engine, sid, opts = {}) {
  return exclusive(engine, sid, { ok: false, already: true }, () => lockdownNow(engine, sid, opts));
}

export function liftLockdown(engine, sid, opts = {}) {
  return exclusive(engine, sid, { ok: false, busy: true }, () => liftNow(engine, sid, opts));
}

async function lockdownNow(engine, sid, { reason = 'raid', by = null, joinCount = null } = {}) {
  if (lockState(engine, sid)) return { ok: false, already: true };
  const cfg = engine.settings.appConfig(sid, ID);
  const minutes = Number(cfg.raid.autoLiftMinutes) || 15;
  const until = now() + minutes * 60_000;
  let state = null;
  let firstError = null;
  try {
    const prior = await everyonePrior(engine, sid);
    await engine.bot.setEveryonePerms(sid, { send_messages: false });
    engine.caps.mark(sid, 'roles', true);
    state = { mode: 'everyone', prior, at: now(), until, reason, by };
  } catch (e) {
    firstError = e;
    if (looksLikeFeatureOff(e)) engine.caps.mark(sid, 'roles', false, e?.message);
    const general = await generalChannelId(engine, sid);
    if (general) {
      try {
        const prior = await lockChannel(engine, general);
        state = { mode: 'channel', channelId: general, prior, at: now(), until, reason, by };
      } catch (e2) {
        firstError = e2;
      }
    }
  }
  const ping = modPing(engine, sid);
  const who = by ? `Started by <@${by}>.` : `${joinCount ? `${joinCount} people` : 'A lot of people'} joined in a short time.`;
  if (!state) {
    await postLog(engine, sid, dialog.error('Raid detected, but I could not lock the server', `${who}\nI tried to stop everyone from sending messages and then to lock the general channel, and both failed${firstError?.status === 403 ? ' (my role is missing permissions)' : ''}.\n**Mods: please lock things down by hand** (Server settings → Roles → everyone → Send messages off).`), { content: ping || '@here', priority: 'high', fallbackToGeneral: true });
    return { ok: false, error: firstError };
  }
  setLockState(engine, sid, state);
  scheduleLift(engine, sid, until);
  const scope = state.mode === 'everyone' ? 'Nobody without a role that allows it can send messages right now.' : `Server-wide lock wasn't available here, so I locked <#${state.channelId}> instead.`;
  const alert = await postLog(engine, sid, card({
    title: `${ICONS.lock} Lockdown on`,
    body: `${reason === 'raid' ? '**Raid shield:** ' : ''}${who}\n${scope}\nIt lifts by itself <t:${Math.floor(until / 1000)}:R>, or press the button.`,
    color: 'error',
  }), { components: [row(button('Lift lockdown', cid('lift'), 'success', ICONS.unlock))], content: ping || undefined, priority: 'high', fallbackToGeneral: true });
  rememberAlert(engine, sid, alert?.id);
  return { ok: true, state };
}

function rememberAlert(engine, sid, messageId) {
  if (!messageId) return;
  const { alerts } = mem(engine);
  alerts.add(messageId);
  while (alerts.size > MAX_ALERTS) alerts.delete(alerts.values().next().value);
  if (lockState(engine, sid)) engine.store.update(ID, sid, (d) => { if (d.lockdown) d.lockdown.alertId = messageId; }, {});
}

function clickedMessageId(ctx) {
  return ctx.source?.message_id || null;
}

function onOwnPanel(ctx) {
  const messageId = clickedMessageId(ctx);
  return !!messageId && ctx.engine.router.panelOwner(messageId) === ctx.userId;
}

function onLockdownAlert(ctx) {
  const messageId = clickedMessageId(ctx);
  if (!messageId) return false;
  return mem(ctx.engine).alerts.has(messageId) || lockState(ctx.engine, ctx.serverId)?.alertId === messageId;
}

async function verifyAlert(engine, sid, kind, embed) {
  const { verifyAlertAt } = mem(engine);
  const key = `${sid}:${kind}`;
  const last = verifyAlertAt.get(key);
  if (last && now() - last < VERIFY_ALERT_GAP_MS) return;
  verifyAlertAt.set(key, now());
  capMap(verifyAlertAt);
  await postLog(engine, sid, embed, { content: modPing(engine, sid) || undefined, priority: 'normal' });
}

function scheduleLift(engine, sid, until) {
  const { liftTimers } = mem(engine);
  clearTimeout(liftTimers.get(sid));
  const t = setTimeout(() => { liftTimers.delete(sid); liftLockdown(engine, sid, { auto: true }).catch((e) => engine.log.warn(`[automod] auto-lift failed: ${e?.message}`)); }, Math.max(0, until - now()));
  t.unref?.();
  liftTimers.set(sid, t);
}

async function liftNow(engine, sid, { auto = false, by = null } = {}) {
  const state = lockState(engine, sid);
  if (!state) return { ok: false, notLocked: true };
  const { liftTimers, joins } = mem(engine);
  clearTimeout(liftTimers.get(sid));
  liftTimers.delete(sid);
  try {
    if (state.mode === 'everyone') await engine.bot.setEveryonePerms(sid, { send_messages: state.prior !== false });
    else if (!state.prior.allow.length && !state.prior.deny.length) await engine.bot.clearChannelPermissions(state.channelId, 'everyone');
    else await engine.bot.setChannelPermissions(state.channelId, 'everyone', state.prior);
  } catch (e) {
    const retryAt = now() + LIFT_RETRY_MS;
    setLockState(engine, sid, { ...state, until: retryAt, liftFailed: true });
    scheduleLift(engine, sid, retryAt);
    if (!state.liftFailed) {
      await postLog(engine, sid, dialog.error("I couldn't lift the lockdown", `Please turn **Send messages** back on for everyone by hand${state.mode === 'channel' ? ` in <#${state.channelId}>` : ''}. I'll try again every few minutes, and you can press **Lift lockdown** once it's fixed.`), { content: modPing(engine, sid) || undefined, priority: 'high', fallbackToGeneral: true });
    }
    return { ok: false, error: e };
  }
  setLockState(engine, sid, null);
  joins.delete(sid);
  await postLog(engine, sid, dialog.ok('Lockdown lifted', auto ? 'The timer ran out, so everyone can chat again.' : `${by ? `<@${by}> lifted it.` : 'Lifted.'} Everyone can chat again.`), { priority: 'normal' });
  return { ok: true };
}

async function maybeExpireLock(engine, sid) {
  const state = lockState(engine, sid);
  const { liftTimers } = mem(engine);
  if (state && state.until <= now()) await liftLockdown(engine, sid, { auto: true }).catch(() => {});
  else if (state && !liftTimers.has(sid)) scheduleLift(engine, sid, state.until);
}

function resumeLocks(engine) {
  let saved = [];
  try { saved = engine.store.entries?.(ID) || []; } catch (e) { engine.log.debug('automod could not read saved lockdowns', e?.message); }
  for (const [sid, data] of saved) {
    const until = Number(data?.lockdown?.until);
    if (Number.isFinite(until)) scheduleLift(engine, sid, Math.max(until, now() + RESUME_DELAY_MS));
  }
}

async function onJoin(ctx, ev) {
  const { engine, serverId: sid } = ctx;
  if (!sid) return;
  await maybeExpireLock(engine, sid);
  const cfg = ctx.config();
  if (!cfg.filters.raid || lockState(engine, sid)) return;
  const { joins } = mem(engine);
  const t = now();
  const windowMs = cfg.raid.seconds * 1000;
  const list = (joins.get(sid) || []).filter((x) => x > t - windowMs);
  list.push(t);
  if (list.length > 500) list.splice(0, list.length - 500);
  joins.set(sid, list);
  capMap(joins);
  if (list.length > cfg.raid.joins) {
    joins.delete(sid);
    await lockdown(engine, sid, { reason: 'raid', joinCount: list.length });
  }
  void ev;
}

function panelView(engine, sid, { canEdit = true } = {}) {
  const cfg = engine.settings.appConfig(sid, ID);
  const lim = limits(cfg);
  const details = {
    spam: `more than ${lim.floodMax} in ${cfg.spam.seconds}s, or the same text ${lim.dupes}×`,
    mentions: `more than ${lim.mentionMax} people, or @everyone`,
    caps: `over ${lim.capsPercent}% capitals`,
    links: cfg.links.allow.length ? `allowed: ${clip(cfg.links.allow.join(', '), 80)}` : 'no sites allowed yet',
    invites: 'Yapin\' and other invite links',
    words: cfg.words.list.length ? `${cfg.words.list.length} word${cfg.words.list.length === 1 ? '' : 's'}` : 'list is empty',
    raid: `more than ${cfg.raid.joins} joins in ${cfg.raid.seconds}s locks the server`,
  };
  const fields = Object.entries(FILTERS).map(([k, f]) => ({ name: `${f.emoji} ${f.label}`, value: `${onOff(cfg.filters[k])}\n-# ${details[k]}`, inline: true }));
  const lock = lockState(engine, sid);
  const exempt = [...cfg.exempt.channels.map((c) => `<#${c}>`), ...cfg.exempt.roles.map((r) => `<@&${r}>`)];
  const s = STRICTNESS[cfg.strictness] || STRICTNESS.normal;
  const body = [
    `Strictness: **${s.emoji} ${s.label}**`,
    exempt.length ? `Exempt: ${exempt.join(' ')}` : 'Mods, admins and the owner are always exempt.',
    cfg.verify.enabled ? `Verification: on in <#${cfg.verify.channelId}>` : null,
    lock ? `${ICONS.lock} **Lockdown is on** (lifts <t:${Math.floor(lock.until / 1000)}:R>)` : null,
    canEdit ? '-# Tap a filter to turn it on or off. Typed: `/automod words add …`, `/automod links allow …`, `/automod exempt #channel`' : '-# Only admins can change these.',
  ].filter(Boolean).join('\n');
  const toggles = Object.entries(FILTERS).map(([k, f]) => button(f.label, cid('toggle', k), cfg.filters[k] ? 'success' : 'secondary', f.emoji, { disabled: !canEdit }));
  const strictOpts = Object.entries(STRICTNESS).map(([k, v]) => ({ label: v.label, value: k, emoji: v.emoji, default: k === cfg.strictness }));
  const extra = [button('Refresh', cid('panel'), 'secondary', '🔄')];
  if (lock) extra.unshift(button('Lift lockdown', cid('lift'), 'success', ICONS.unlock));
  const base = {
    embeds: [card({ title: `${ICONS.automod} Automod`, body, fields, color: 'automod' })],
    components: [row(toggles.slice(0, 5)), row(toggles.slice(5))],
  };
  const withSelect = { ...base, components: [...base.components, select(cid('strictpick'), strictOpts, { placeholder: 'Strictness', disabled: !canEdit }), row(extra)] };
  const withButtons = { ...base, components: [...base.components, row(Object.entries(STRICTNESS).map(([k, v]) => button(v.label, cid('strict', k), k === cfg.strictness ? 'primary' : 'secondary', v.emoji, { disabled: !canEdit }))), row(extra)] };
  return { withSelect, withButtons };
}

async function showPanel(ctx, how = 'ephemeral') {
  const { engine, serverId: sid } = ctx;
  const canEdit = engine.perms.atLeast(await ctx.require('mod'), 'admin');
  const view = panelView(engine, sid, { canEdit });
  return engine.caps.attempt(sid, 'selects', () => ctx[how](view.withSelect), () => ctx[how](view.withButtons));
}

function snapshot(ctx) {
  return structuredClone(ctx.config());
}

async function changed(ctx, title, body, before) {
  const { engine } = ctx;
  const u = engine.router.addUndo({
    serverId: ctx.serverId, actorId: ctx.userId, label: title, perm: 'admin',
    run: async (i) => {
      await engine.perms.require(ctx.serverId, i.user_id, 'admin');
      if (!engine.settings.isEnabled(ctx.serverId, ID)) {
        await i.ephemeral('', { embeds: [dialog.warn("Automod isn't installed here", 'An admin can install it with **/apps**.')] });
        return;
      }
      engine.settings.patchApp(ctx.serverId, ID, before);
      await i.ephemeral('', { embeds: [dialog.ok('Undone', `Automod is back to how it was before: ${title.toLowerCase()}.`)] });
    },
  });
  return ctx.ok(title, body, { components: [row(u.button, button('Open Automod', cid('panel'), 'secondary', ICONS.automod))] });
}

function filterKey(word) {
  const w = String(word || '').toLowerCase();
  return Object.entries(FILTERS).find(([k, f]) => k === w || f.words.includes(w))?.[0] || null;
}

function onOffWord(word) {
  const w = String(word || '').toLowerCase();
  if (/^(on|enable|enabled|yes|true|start)$/.test(w)) return true;
  if (/^(off|disable|disabled|no|false|stop)$/.test(w)) return false;
  return null;
}

async function setFilter(ctx, key, on) {
  const before = snapshot(ctx);
  const cfg = ctx.config();
  const value = on === null ? !cfg.filters[key] : on;
  ctx.patchConfig({ filters: { ...cfg.filters, [key]: value } });
  const f = FILTERS[key];
  const hint = key === 'words' && value && !cfg.words.list.length ? '\nThe list is empty: add words with `/automod words add <word>`.'
    : key === 'links' && value ? '\nAdd safe sites with `/automod links allow example.com`.'
      : key === 'raid' && value ? `\nIf more than ${cfg.raid.joins} people join within ${cfg.raid.seconds}s I'll pause chat for ${cfg.raid.autoLiftMinutes} minutes.` : '';
  return changed(ctx, `${f.label} ${value ? 'on' : 'off'}`, `${f.emoji} **${f.label}** is now ${value ? 'on' : 'off'}.${hint}`, before);
}

async function wordsCommand(ctx, rest) {
  const sub = (rest[0] || 'list').toLowerCase();
  const cfg = ctx.config();
  const list = [...cfg.words.list];
  const items = rest.slice(1).join(' ').split(/[,\n]+/).map((w) => w.trim()).filter(Boolean);
  if (/^(list|show)$/.test(sub)) {
    if (!list.length) return ctx.info('Word filter', 'The list is empty. Add one with `/automod words add <word>`.');
    return ctx.info('Word filter', `${list.map((w) => `||${w}||`).join(', ')}\n-# Matching ignores caps, leetspeak (like 4 for a), repeated letters and dots between letters, but only whole words, so "class" never trips "ass".`);
  }
  await ctx.require('admin');
  const before = snapshot(ctx);
  if (/^(add|\+|block|ban)$/.test(sub)) {
    if (!items.length) return ctx.warn('Which word?', 'Try `/automod words add badword` (commas for several).');
    const fresh = items.filter((w) => normalizeWord(w) && !list.some((x) => normalizeWord(x) === normalizeWord(w)));
    if (!fresh.length) return ctx.info('Already on the list', 'Those words are already filtered.');
    const next = [...list, ...fresh].slice(0, 500);
    ctx.patchConfig({ words: { ...cfg.words, list: next }, filters: { ...cfg.filters, words: true } });
    return changed(ctx, `Added ${fresh.length} word${fresh.length === 1 ? '' : 's'}`, `Now filtering ${fresh.map((w) => `||${w}||`).join(', ')}. The list has ${next.length} word${next.length === 1 ? '' : 's'}.`, before);
  }
  if (/^(remove|rm|delete|del|-|unblock|unban)$/.test(sub)) {
    const drop = new Set(items.map(normalizeWord));
    const next = list.filter((w) => !drop.has(normalizeWord(w)));
    if (next.length === list.length) return ctx.warn('Not on the list', `I couldn't find that. Check with \`/automod words list\`.`);
    ctx.patchConfig({ words: { ...cfg.words, list: next } });
    return changed(ctx, `Removed ${list.length - next.length} word${list.length - next.length === 1 ? '' : 's'}`, `The list has ${next.length} word${next.length === 1 ? '' : 's'} now.`, before);
  }
  if (/^(clear|reset|empty)$/.test(sub)) {
    ctx.patchConfig({ words: { ...cfg.words, list: [] } });
    return changed(ctx, 'Word list cleared', `Removed all ${list.length} words.`, before);
  }
  const on = onOffWord(sub);
  if (on !== null) return setFilter(ctx, 'words', on);
  return ctx.warn("I didn't get that", 'Try `/automod words add <word>`, `words remove <word>`, `words list` or `words clear`.');
}

async function linksCommand(ctx, rest) {
  const sub = (rest[0] || 'list').toLowerCase();
  const cfg = ctx.config();
  const allow = [...cfg.links.allow];
  const on = onOffWord(sub);
  if (on !== null) { await ctx.require('admin'); return setFilter(ctx, 'links', on); }
  if (/^(list|show)$/.test(sub)) return ctx.info('Allowed sites', allow.length ? allow.join(', ') : 'None yet. Add one with `/automod links allow example.com`.');
  await ctx.require('admin');
  const domains = rest.slice(1).map(cleanDomain);
  if (rest.slice(1).length && domains.some((d) => !d)) return ctx.warn("That doesn't look like a website", 'Use just the site name, like `example.com`.');
  const before = snapshot(ctx);
  if (/^(allow|add|\+|whitelist|permit)$/.test(sub)) {
    if (!domains.length) return ctx.warn('Which site?', 'Try `/automod links allow example.com`.');
    const next = [...new Set([...allow, ...domains])].slice(0, 100);
    ctx.patchConfig({ links: { ...cfg.links, allow: next } });
    return changed(ctx, `Allowed ${domains.join(', ')}`, `Links to ${domains.map((d) => `**${d}**`).join(', ')} (and its subdomains) are fine now.${cfg.filters.links ? '' : '\nThe link filter is off right now: turn it on with `/automod links on`.'}`, before);
  }
  if (/^(disallow|remove|rm|delete|del|-|block)$/.test(sub)) {
    const next = allow.filter((d) => !domains.includes(d));
    if (next.length === allow.length) return ctx.warn('Not on the list', 'That site was not allowed anyway.');
    ctx.patchConfig({ links: { ...cfg.links, allow: next } });
    return changed(ctx, `Removed ${domains.join(', ')}`, 'Links to it get filtered again.', before);
  }
  return ctx.warn("I didn't get that", 'Try `/automod links allow example.com`, `links remove example.com`, `links on` or `links off`.');
}

async function exemptCommand(ctx, rest, forceRemove = false) {
  await ctx.require('admin');
  let remove = forceRemove;
  let tokens = rest;
  if (/^(remove|rm|del|delete|-|off)$/i.test(tokens[0] || '')) { remove = true; tokens = tokens.slice(1); }
  else if (/^(add|\+|on)$/i.test(tokens[0] || '')) tokens = tokens.slice(1);
  const cfg = ctx.config();
  if (!tokens.length) {
    const list = [...cfg.exempt.channels.map((c) => `<#${c}>`), ...cfg.exempt.roles.map((r) => `<@&${r}>`)];
    return ctx.info('Exempt from automod', `${list.length ? list.join(' ') : 'Nothing yet.'}\n-# Add with \`/automod exempt #channel\` or \`/automod exempt @role\`.`);
  }
  const channels = new Set(cfg.exempt.channels);
  const roles = new Set(cfg.exempt.roles);
  const names = [];
  for (const t of tokens) {
    const looksChannel = t.startsWith('#') || !!parseChannelId(t);
    const looksRole = t.startsWith('@') || !!parseRoleId(t);
    const channel = looksChannel ? await ctx.findChannel(t) : looksRole ? null : await ctx.findChannel(t);
    const role = channel || looksChannel ? null : await ctx.findRole(t);
    if (channel) { if (remove) channels.delete(channel.id); else channels.add(channel.id); names.push(`<#${channel.id}>`); }
    else if (role) { if (remove) roles.delete(role.id); else roles.add(role.id); names.push(`<@&${role.id}>`); }
    else return ctx.warn(`I couldn't find ${t}`, 'Mention a channel like #general or a role like @Helpers.');
  }
  const before = snapshot(ctx);
  ctx.patchConfig({ exempt: { channels: [...channels].slice(0, 50), roles: [...roles].slice(0, 50) } });
  return changed(ctx, remove ? 'Exemption removed' : 'Exempt from automod', remove ? `${names.join(' ')} ${names.length === 1 ? 'is' : 'are'} checked by automod again.` : `Automod now ignores ${names.join(' ')}.`, before);
}

async function strictCommand(ctx, level) {
  const key = String(level || '').toLowerCase();
  const alias = { low: 'relaxed', light: 'relaxed', chill: 'relaxed', lenient: 'relaxed', medium: 'normal', default: 'normal', high: 'strict', tough: 'strict', hard: 'strict' };
  const k = own(STRICTNESS, key) ? key : own(alias, key) ? alias[key] : null;
  if (!k) return ctx.warn('Pick a strictness', 'Use **relaxed**, **normal** or **strict**, like `/automod strictness strict`.');
  await ctx.require('admin');
  const before = snapshot(ctx);
  ctx.patchConfig({ strictness: k });
  const lim = limits(ctx.config());
  return changed(ctx, `Strictness: ${STRICTNESS[k].label}`, `Flood limit ${lim.floodMax} messages, mention limit ${lim.mentionMax}, caps over ${lim.capsPercent}%.`, before);
}

function applyPresetConfig(engine, sid, preset) {
  const p = own(PRESETS, preset) ? PRESETS[preset] : null;
  if (!p) return null;
  const cfg = engine.settings.appConfig(sid, ID);
  engine.settings.patchApp(sid, ID, { filters: { ...cfg.filters, ...p.filters }, strictness: p.strictness });
  return `${ICONS.automod} Automod: ${p.summary}.`;
}

async function presetCommand(ctx, name) {
  const key = String(name || '').toLowerCase();
  if (!own(PRESETS, key)) return ctx.warn('Which preset?', `Pick one of ${Object.keys(PRESETS).map((k) => `**${k}**`).join(', ')}.`);
  await ctx.require('admin');
  const before = snapshot(ctx);
  const line = applyPresetConfig(ctx.engine, ctx.serverId, key);
  return changed(ctx, `Preset: ${key}`, line, before);
}

function riskyVerifyRole(engine, sid, role) {
  const core = engine.settings.core(sid);
  if ([...(core.modRoles || []), ...(core.adminRoles || [])].includes(role.id)) return `**${role.name}** is a mod or admin role here. Anyone pressing Verify would get it, so pick a plain member role.`;
  const strong = ELEVATED_PERMS.filter((p) => role.perms?.[p] || role[p]);
  if (strong.length) return `**${role.name}** has moderator-level permissions. Anyone pressing Verify would get them, so pick a plain member role.`;
  return null;
}

async function verifyCommand(ctx, rest) {
  await ctx.require('admin');
  const { engine, serverId: sid } = ctx;
  const sub = (rest[0] || 'setup').toLowerCase();
  const cfg = ctx.config();
  if (/^(off|disable|stop|remove)$/.test(sub)) {
    const before = snapshot(ctx);
    ctx.patchConfig({ verify: { ...cfg.verify, enabled: false } });
    return changed(ctx, 'Verification off', 'The Verify button stops working. You can delete the old panel message.', before);
  }
  if (!/^(setup|set|on|post|panel|start)$/.test(sub)) return ctx.warn("I didn't get that", 'Try `/automod verify setup #verify @Verified` or `/automod verify off`.');
  let channel = null;
  let role = null;
  for (const t of rest.slice(1)) {
    const isChannel = t.startsWith('#') || !!parseChannelId(t);
    const found = isChannel ? await ctx.findChannel(t) : await ctx.findRole(t);
    if (!found) return ctx.warn(`I couldn't find ${clip(t, 60)}`, isChannel ? 'Mention the channel, like #verify.' : 'Mention the role, like @Verified.');
    if (isChannel) channel = found; else role = found;
  }
  if (!channel && cfg.verify.channelId) channel = (await ctx.channels('text')).find((c) => c.id === cfg.verify.channelId) || null;
  if (!channel) channel = (await engine.detectChannels(sid)).verify || null;
  if (!role && cfg.verify.roleId) role = (await ctx.roles()).find((r) => r.id === cfg.verify.roleId) || null;
  if (!channel) return ctx.warn('Which channel?', 'Make a channel like #verify, then run `/automod verify setup #verify @Verified`.');
  if (!role) return ctx.warn('Which role?', 'Tell me the role people get, like `/automod verify setup #verify @Verified`.');
  const risky = riskyVerifyRole(engine, sid, role);
  if (risky) return ctx.warn("That role is too powerful for a Verify button", risky);
  const can = await engine.perms.canManageRole(sid, role.id);
  if (!can.ok) return ctx.warn("I can't hand out that role", can.reason);
  const before = snapshot(ctx);
  ctx.patchConfig({ verify: { enabled: true, channelId: channel.id, roleId: role.id } });
  await ctx.ok('Verification is on', `Posting the Verify panel in <#${channel.id}>. Pressing it gives **${role.name}**.\n-# Tip: hide your other channels from everyone and show them to **${role.name}**.`);
  try {
    await ctx.send(channel.id, { embeds: [card({ title: '✅ Verify to join in', body: 'Press the button below to confirm you\'re a real person and unlock the rest of the server.', color: 'ok' })], components: [row(button('Verify', cid('verify'), 'success', '✅'))] }, { priority: 'high' });
  } catch (e) {
    engine.settings.patchApp(sid, ID, before);
    return ctx.fail(e, { action: 'post the Verify panel', target: `#${channel.name}` });
  }
  return null;
}

async function manualLockdown(ctx) {
  await ctx.require('mod');
  if (lockState(ctx.engine, ctx.serverId)) return ctx.info('Already locked', 'Use **Lift lockdown** or `/automod lift` to end it.');
  await ctx.ok('Locking down', 'Pausing chat for everyone. I\'ll post the result in the log channel.');
  const out = await lockdown(ctx.engine, ctx.serverId, { reason: 'manual', by: ctx.userId });
  if (!out.ok && !out.already) await ctx.error("Lockdown didn't work", 'I couldn\'t change permissions. Please lock channels by hand.').catch(() => {});
  return null;
}

async function manualLift(ctx) {
  await ctx.require('mod');
  if (!lockState(ctx.engine, ctx.serverId)) return ctx.info('Not locked', 'There is no lockdown right now.');
  const out = await liftLockdown(ctx.engine, ctx.serverId, { by: ctx.userId });
  if (out.busy) return ctx.info('Already on it', 'The lockdown is being changed right now. Check the log channel in a moment.');
  return out.ok ? ctx.ok('Lockdown lifted', 'Everyone can chat again.') : ctx.error("I couldn't lift it", 'Please turn Send messages back on for everyone by hand.');
}

const SUBCOMMANDS = ['words', 'links', 'exempt', 'unexempt', 'strictness', 'preset', 'verify', 'lockdown', 'lift', 'on', 'off', 'panel', ...Object.keys(FILTERS)];

async function runAutomod(ctx) {
  await ctx.require('mod');
  const tokens = ctx.argv?.length ? ctx.argv : tokenize(ctx.args);
  const first = (tokens[0] || '').toLowerCase();
  const rest = tokens.slice(1);
  if (!first || /^(panel|settings|status|show|open|menu|config)$/.test(first)) { await ctx.require('mod'); return showPanel(ctx); }
  if (/^(words?|badwords|swears|filter)$/.test(first)) { await ctx.require('mod'); return wordsCommand(ctx, rest); }
  if (/^(links?|urls?|allow|allowlist|whitelist)$/.test(first)) {
    await ctx.require('mod');
    return /^allow/.test(first) || first === 'whitelist' ? linksCommand(ctx, ['allow', ...rest]) : linksCommand(ctx, rest);
  }
  if (/^(exempt|ignore|bypass)$/.test(first)) return exemptCommand(ctx, rest);
  if (/^(unexempt|unignore)$/.test(first)) return exemptCommand(ctx, rest, true);
  if (/^(strictness|strict|level|sensitivity)$/.test(first)) return strictCommand(ctx, rest[0] || (first === 'strict' ? 'strict' : ''));
  if (own(STRICTNESS, first)) return strictCommand(ctx, first);
  if (first === 'preset') return presetCommand(ctx, rest[0]);
  if (own(PRESETS, first)) return presetCommand(ctx, first);
  if (/^(verify|verification|gate)$/.test(first)) return verifyCommand(ctx, rest);
  if (/^(lockdown|lock)$/.test(first)) return manualLockdown(ctx);
  if (/^(lift|unlock|unlockdown)$/.test(first)) return manualLift(ctx);
  const firstOnOff = onOffWord(first);
  if (firstOnOff !== null && filterKey(rest[0])) { await ctx.require('admin'); return setFilter(ctx, filterKey(rest[0]), firstOnOff); }
  const key = filterKey(first);
  if (key) {
    const on = onOffWord(rest[0]);
    if (key === 'raid' && /^(lock|lockdown|now)$/i.test(rest[0] || '')) return manualLockdown(ctx);
    if (key === 'raid' && /^(lift|unlock|end)$/i.test(rest[0] || '')) return manualLift(ctx);
    if (on === null && rest[0]) return ctx.warn("I didn't get that", `Try \`/automod ${first} on\` or \`/automod ${first} off\`.`);
    await ctx.require('admin');
    return setFilter(ctx, key, on);
  }
  const guess = didYouMean(first, [...SUBCOMMANDS, ...Object.keys(PRESETS)]);
  return ctx.warn("I didn't get that", `I don't know **${first}**.${guess.length ? ` Did you mean ${guess.map((g) => `**${g}**`).join(', ')}?` : ''}\nTry \`/automod\` for the settings panel.`);
}

async function runYap(ctx) {
  await ctx.require('mod');
  if (/^(raid|lockdown)$/.test(ctx.word)) {
    const a = (ctx.argv[0] || '').toLowerCase();
    if (ctx.word === 'lockdown' && (!a || /^(on|now|start)$/.test(a))) return manualLockdown(ctx);
    if (/^(off|lift|end|stop|unlock)$/.test(a) && (ctx.word === 'lockdown' || lockState(ctx.engine, ctx.serverId))) return manualLift(ctx);
    ctx.argv = [ctx.word === 'lockdown' ? 'lockdown' : 'raid', ...ctx.argv];
    return runAutomod(ctx);
  }
  if (ctx.word === 'filter') { ctx.argv = ['words', ...ctx.argv]; return runAutomod(ctx); }
  return runAutomod(ctx);
}

export const { setup, teardown, check } = defineApp({
  id: ID,
  name: 'Automod',
  icon: ICONS.automod,
  description: 'Spam, mention, caps, link and word filters plus a raid shield.',
  category: 'Moderation',
  defaults: DEFAULTS,

  commands: {
    automod: {
      description: 'Automod settings. Try /automod words add <word>, /automod raid on, /automod exempt #channel',
      run: runAutomod,
    },
  },

  components: {
    panel: { perm: 'mod', run: (ctx) => showPanel(ctx, ctx.kind === 'button' && onOwnPanel(ctx) ? 'update' : 'ephemeral') },
    toggle: {
      perm: 'admin',
      run: async (ctx) => {
        await ctx.require('admin');
        const key = ctx.argv[0];
        if (!own(FILTERS, key)) return ctx.warn('This button is from an older panel', 'Open `/automod` again.');
        const cfg = ctx.config();
        ctx.patchConfig({ filters: { ...cfg.filters, [key]: !cfg.filters[key] } });
        return showPanel(ctx, onOwnPanel(ctx) ? 'update' : 'ephemeral');
      },
    },
    strict: {
      perm: 'admin',
      run: async (ctx) => {
        await ctx.require('admin');
        if (!own(STRICTNESS, ctx.argv[0])) return ctx.warn('This button is from an older panel', 'Open `/automod` again.');
        ctx.patchConfig({ strictness: ctx.argv[0] });
        return showPanel(ctx, onOwnPanel(ctx) ? 'update' : 'ephemeral');
      },
    },
    strictpick: {
      perm: 'admin',
      run: async (ctx) => {
        await ctx.require('admin');
        const v = Array.isArray(ctx.values) ? ctx.values[0] : null;
        if (!own(STRICTNESS, v)) return ctx.warn('Pick a strictness', 'Choose relaxed, normal or strict.');
        ctx.patchConfig({ strictness: v });
        return showPanel(ctx, onOwnPanel(ctx) ? 'update' : 'ephemeral');
      },
    },
    lift: {
      perm: 'mod',
      run: async (ctx) => {
        await ctx.require('mod');
        const { engine, serverId: sid } = ctx;
        const how = onLockdownAlert(ctx) || onOwnPanel(ctx) ? 'update' : 'ephemeral';
        if (!lockState(engine, sid)) return ctx[how]({ content: `${ICONS.unlock} This lockdown was already lifted.`, components: [] });
        await ctx[how]({ content: `${ICONS.unlock} <@${ctx.userId}> is lifting the lockdown.`, components: [] });
        const out = await liftLockdown(engine, sid, { by: ctx.userId });
        if (!out.ok && !out.notLocked && !out.busy) await ctx.error("I couldn't lift the lockdown", 'Please turn **Send messages** back on for everyone by hand.');
        return null;
      },
    },
    verify: {
      run: async (ctx) => {
        const { engine, serverId: sid, userId: uid } = ctx;
        if (!sid || !uid) return ctx.warn('Verification only works in a server', 'Press the Verify button in the server you want to join.');
        const cfg = ctx.config();
        if (!cfg.verify.enabled || !cfg.verify.roleId) return ctx.warn('Verification is off', 'Ask a mod for help getting in.');
        const member = await engine.perms.member(sid, uid).catch(() => null);
        if (member?.roles?.includes(cfg.verify.roleId)) return ctx.info("You're already verified", 'Enjoy the server!');
        const can = await engine.perms.canManageRole(sid, cfg.verify.roleId);
        if (!can.ok) {
          await ctx.warn("I can't verify you right now", 'A mod has been told. Please try again a bit later.');
          await verifyAlert(engine, sid, 'stuck', dialog.warn('Verification is stuck', `<@${uid}> pressed Verify but I can't give the role: ${can.reason}`));
          return null;
        }
        if (riskyVerifyRole(engine, sid, can.role)) {
          await ctx.warn("I can't verify you right now", 'A mod has been told. Please try again a bit later.');
          await verifyAlert(engine, sid, 'paused', dialog.warn('Verification paused', `<@${uid}> pressed Verify, but **${can.role.name}** now has moderator-level permissions, so I didn't hand it out. Pick a plain member role with \`/automod verify setup\`.`));
          return null;
        }
        try {
          await engine.bot.addRole(sid, uid, cfg.verify.roleId);
        } catch (e) {
          if (looksLikeFeatureOff(e)) engine.caps.mark(sid, 'roles', false, e?.message);
          await ctx.warn("I couldn't verify you", 'Something went wrong giving you the role. A mod has been told.');
          await verifyAlert(engine, sid, 'failed', dialog.warn('Verification failed', `I couldn't give **${can.role.name}** to <@${uid}>. Role changes may not be available on this server yet, so please give it by hand.`));
          return null;
        }
        engine.perms.invalidate(`m:${sid}:${uid}`);
        for (const kind of ['stuck', 'paused', 'failed']) mem(engine).verifyAlertAt.delete(`${sid}:${kind}`);
        return ctx.ok("You're verified", `Welcome in! You now have **${can.role.name}**.`);
      },
    },
  },

  events: {
    message: onMessage,
    member_join: onJoin,
  },

  yap: [{ words: ['automod', 'filter', 'raid', 'lockdown'], run: runYap }],

  panel: (ctx) => showPanel(ctx),

  services: (engine) => ({
    findBadWord,
    normalizeWord,
    isLocked: (sid) => !!lockState(engine, sid),
    lockdown: (sid, opts) => lockdown(engine, sid, opts),
    lift: (sid, opts) => liftLockdown(engine, sid, opts),
  }),

  presets: Object.fromEntries(Object.entries(PRESETS).map(([k, p]) => [k, { enabled: true, config: { filters: p.filters, strictness: p.strictness } }])),

  applyPreset: async (engine, serverId, { preset } = {}) => applyPresetConfig(engine, serverId, preset) || `${ICONS.automod} Automod: kept the default filters.`,

  help: [
    'Mods, admins, the owner and anything you `/automod exempt` are never filtered.',
    'Word matching ignores caps, leetspeak and repeated letters but only matches whole words.',
    '`/automod raid on` pauses chat during a join flood; `/automod lockdown` and `/automod lift` do it by hand.',
    '`/automod verify setup #verify @Verified` posts a Verify button that gives the role.',
  ],

  init(engine) {
    const m = mem(engine);
    clearInterval(m.pruneTimer);
    m.pruneTimer = setInterval(() => prune(engine), TRACK_MS);
    m.pruneTimer.unref?.();
    resumeLocks(engine);
  },
  dispose(engine) {
    const m = mem(engine);
    clearInterval(m.pruneTimer);
    m.pruneTimer = null;
    for (const t of m.liftTimers.values()) clearTimeout(t);
    m.liftTimers.clear();
  },
});
