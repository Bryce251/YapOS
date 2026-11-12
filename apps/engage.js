import { randomInt } from 'node:crypto';
import { defineApp } from '../engine/apps.js';
import { card, dialog, button, row, ICONS } from '../engine/ui.js';
import { customId } from '../engine/router.js';
import { tokenize, parseDuration, formatDuration, clip, didYouMean } from '../engine/parse.js';
import { friendly } from '../engine/errors.js';

const ID = 'engage';
const cid = (action, ...args) => customId(ID, action, ...args);

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const POLL_DEFAULT_MS = DAY;
const POLL_MAX_MS = 7 * DAY;
const GIVEAWAY_MAX_MS = 30 * DAY;
const SHORTEST_MS = MIN;
const EDIT_GAP_MS = 2500;
const PAUSED_RETRY_MS = HOUR;
const GIVE_UP_MS = 30 * DAY;
const LEAVE_WINDOW_MS = 30_000;
const LEAVE_MIN_GAP_MS = 1000;
const LEAVE_ASKS_MAX = 2000;
const MAX_ACTIVE = { poll: 20, giveaway: 20 };
const KEEP_ENDED = 20;
const MEMBER_POLLS = 3;
const MAX_OPTIONS = 10;
const MAX_WINNERS = 20;
const MAX_ENTRIES = 10_000;
const MAX_REROLLS = 20;
const MAX_CHECKS = 150;
const QUESTION_MAX = 200;
const OPTION_MAX = 80;
const PRIZE_MAX = 200;
const NUMBERS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
const BAR_WIDTH = 10;
const BAR_FILL = '🟦';
const BAR_WIN = '🟩';
const BAR_EMPTY = '⬜';
const FLAG_WORDS = { multi: 'multi', anon: 'anon', anonymous: 'anon' };
const GIVEAWAY_SUBS = ['list', 'end', 'reroll', 'help'];
const TYPE_NAMES = { poll: 'poll', giveaway: 'giveaway' };

const states = new WeakMap();
function stateOf(engine) {
  let s = states.get(engine);
  if (!s) {
    s = { timers: new Map(), last: new Map(), busy: new Set(), leaveAsks: new Map() };
    states.set(engine, s);
  }
  return s;
}

const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const num = (n) => Math.max(0, Math.round(Number(n) || 0)).toLocaleString('en-US');
const safe = (text) => String(text ?? '').replace(/<@/g, '<@​').replace(/@(everyone|here)/gi, '@​$1').replace(/\s+/g, ' ').trim();
const nowOf = (engine) => engine.scheduler.now();

function fitLines(lines, max) {
  const out = [];
  let used = 0;
  for (let i = 0; i < lines.length; i++) {
    const rest = lines.length - i - 1;
    const tail = rest ? `\n…and ${rest} more` : '';
    const add = (out.length ? 1 : 0) + lines[i].length;
    if (used + add + tail.length > max) {
      out.push(`…and ${lines.length - i} more`);
      return out.join('\n');
    }
    out.push(lines[i]);
    used += add;
  }
  return out.join('\n');
}
const idOf = (tok) => {
  const m = /^#?(\d{1,9})$/.exec(String(tok ?? '').trim());
  return m ? Number(m[1]) : null;
};

const indexKey = (sid) => sid;
const itemKey = (sid, type, id) => `${sid}.${type}.${id}`;
const blankIndex = () => ({ seqs: { poll: 0, giveaway: 0 }, poll: [], giveaway: [] });
const readIndex = (engine, sid) => ({ ...blankIndex(), ...(engine.store.get(ID, indexKey(sid), null) || {}) });
const readItem = (engine, sid, type, id) => (id === null || id === undefined ? null : engine.store.get(ID, itemKey(sid, type, id), null));

function changeItem(engine, sid, type, id, fn) {
  const key = itemKey(sid, type, id);
  if (!engine.store.has(ID, key)) return null;
  return engine.store.update(ID, key, (cur) => {
    if (!cur) return cur;
    fn(cur);
    return cur;
  });
}

function listItems(engine, sid, type) {
  return readIndex(engine, sid)[type].map((id) => readItem(engine, sid, type, id)).filter(Boolean);
}

function reserve(engine, sid, type, { userId, isMod }) {
  let id = null;
  const drop = [];
  engine.store.update(ID, indexKey(sid), (raw) => {
    const d = { ...blankIndex(), ...(raw || {}) };
    const items = d[type].map((x) => readItem(engine, sid, type, x)).filter(Boolean);
    const active = items.filter((x) => !x.ended);
    if (active.length >= MAX_ACTIVE[type]) {
      throw friendly(`This server already has ${MAX_ACTIVE[type]} ${TYPE_NAMES[type]}s running, which is the most I keep at once. End one first (\`/${type} list\` shows them).`, { title: `Too many ${TYPE_NAMES[type]}s` });
    }
    if (type === 'poll' && !isMod && active.filter((x) => x.createdBy === userId).length >= MEMBER_POLLS) {
      throw friendly(`You already have ${MEMBER_POLLS} polls running. End one with \`/poll end <number>\` or wait for one to finish.`, { title: 'Too many polls' });
    }
    const ended = items.filter((x) => x.ended).sort((a, b) => (a.endedAt || 0) - (b.endedAt || 0));
    const extra = Math.max(0, ended.length - (KEEP_ENDED - 1));
    for (const old of ended.slice(0, extra)) drop.push(old.id);
    const known = new Set(items.map((x) => x.id));
    d.seqs = { poll: 0, giveaway: 0, ...(d.seqs || {}) };
    d.seqs[type] += 1;
    id = d.seqs[type];
    d[type] = d[type].filter((x) => known.has(x) && !drop.includes(x));
    d[type].push(id);
    return d;
  }, blankIndex());
  for (const old of drop) engine.store.delete(ID, itemKey(sid, type, old));
  return id;
}

function forget(engine, sid, type, id) {
  engine.scheduler.cancelWhere({ kind: `${ID}.${type}end`, serverId: sid, key: String(id) });
  engine.store.delete(ID, itemKey(sid, type, id));
  engine.store.update(ID, indexKey(sid), (raw) => {
    const d = { ...blankIndex(), ...(raw || {}) };
    d[type] = d[type].filter((x) => x !== id);
    return d;
  }, blankIndex());
}

function timeLeft(ms) {
  if (ms <= 0) return 'any moment now';
  if (ms < MIN) return 'under a minute';
  return formatDuration(Math.ceil(ms / MIN) * MIN);
}

function whenText(engine, sid, ms) {
  let tz = engine.settings.core(sid).timezone || 'UTC';
  let f;
  try {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  } catch {
    tz = 'UTC';
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  }
  return `${f.format(new Date(ms))} ${tz === 'UTC' ? 'UTC' : `${tz.split('/').pop().replace(/_/g, ' ')} time`}`;
}

const isDurationToken = (t) => /^\d/.test(t) && /[a-z]/i.test(t) && parseDuration(t) !== null;

function takeTrailingFlags(segment, out) {
  const toks = String(segment).split(/\s+/).filter(Boolean);
  while (toks.length) {
    const last = toks[toks.length - 1];
    const low = last.toLowerCase();
    if (FLAG_WORDS[low]) { out[FLAG_WORDS[low]] = true; toks.pop(); continue; }
    if (out.durationMs === null && isDurationToken(last)) { out.durationMs = parseDuration(last); toks.pop(); continue; }
    const before = toks[toks.length - 2];
    if (out.durationMs === null && before && /^\d+(\.\d+)?$/.test(before) && /^[a-z]+$/.test(low) && parseDuration(`${before}${low}`) !== null) {
      out.durationMs = parseDuration(`${before}${low}`);
      toks.splice(-2);
      continue;
    }
    break;
  }
  return toks.join(' ');
}

const looksLikeDuration = (s) => /^\d/.test(s) && parseDuration(s) !== null;

export function parsePoll(text) {
  let out = { question: '', options: [], multi: false, anon: false, durationMs: null };
  const segs = String(text ?? '').split('|').map((s) => s.trim());
  let nearest = null;
  while (segs.length) {
    const before = { ...out };
    const seg = segs[segs.length - 1];
    const kept = takeTrailingFlags(seg, out);
    if (kept) { segs[segs.length - 1] = kept; break; }
    nearest = { seg, before, index: segs.length - 1 };
    segs.pop();
  }
  let options = segs.slice(1).map((s) => s.trim()).filter(Boolean);
  if (nearest && nearest.index >= 1 && options.length) {
    const tooFew = options.length < 2;
    const allTimes = looksLikeDuration(nearest.seg) && options.every(looksLikeDuration);
    if (tooFew || allTimes) {
      options = [...options, nearest.seg];
      out = nearest.before;
    }
  }
  out.question = segs[0] || '';
  out.options = options;
  return out;
}

export function parseExtras(text) {
  const out = { multi: false, anon: false, durationMs: null, unknown: [] };
  const toks = String(text ?? '').split(/\s+/).filter(Boolean);
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const low = t.toLowerCase();
    if (FLAG_WORDS[low]) out[FLAG_WORDS[low]] = true;
    else if (out.durationMs === null && isDurationToken(t)) out.durationMs = parseDuration(t);
    else if (out.durationMs === null && /^\d+(\.\d+)?$/.test(t) && toks[i + 1] && parseDuration(`${t}${toks[i + 1].toLowerCase()}`) !== null) { out.durationMs = parseDuration(`${t}${toks[i + 1].toLowerCase()}`); i++; }
    else out.unknown.push(t);
  }
  return out;
}

function leadingDuration(tokens) {
  for (let n = Math.min(tokens.length, 4); n >= 1; n--) {
    const s = tokens.slice(0, n).join(' ');
    if (!/^\d/.test(s) || !/[a-z]/i.test(s)) continue;
    const ms = parseDuration(s);
    if (ms !== null) return { ms, rest: tokens.slice(n) };
  }
  return { ms: null, rest: tokens };
}

const looksRole = (t) => /^<@&[\w-]+>$/.test(t || '') || /^@/.test(t || '') || /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(t || '');
const looksUser = (t) => /^<@!?[\w-]+>$/.test(t || '') || /^@/.test(t || '') || /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(t || '');

export function extractGiveawayOptions(tokens) {
  const out = { roleTok: null, level: null, hostTok: null, rest: [] };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const low = t.toLowerCase();
    const next = tokens[i + 1];
    if (/^(role|needs|need|requires|req)$/.test(low) && looksRole(next)) { out.roleTok = next; i++; continue; }
    if (/^<@&[\w-]+>$/.test(t)) { out.roleTok = t; continue; }
    const glued = /^(level|lvl|lv)(\d{1,4})\+?$/.exec(low);
    if (glued) { out.level = Number(glued[2]); continue; }
    if (/^(level|lvl|lv)$/.test(low) && /^\d{1,4}\+?$/.test(next || '')) { out.level = Number(String(next).replace('+', '')); i++; continue; }
    if (/^(host|hosted|hostedby|by)$/.test(low)) {
      const target = /^by$/i.test(next || '') ? tokens[i + 2] : next;
      if (looksUser(target)) { out.hostTok = target; i += target === next ? 1 : 2; continue; }
    }
    out.rest.push(t);
  }
  return out;
}

export function parseGiveaway(text) {
  const tokens = tokenize(text);
  const { ms, rest } = leadingDuration(tokens);
  const out = { durationMs: ms, winners: 1, prize: '', roleTok: null, level: null, hostTok: null, problem: null };
  let left = rest;
  if (/^\d+$/.test(left[0] || '')) {
    const n = Number(left[0]);
    const named = /^winners?$/i.test(left[1] || '');
    if (named || (n >= 1 && n <= MAX_WINNERS && left.length > 1)) {
      if (n < 1 || n > MAX_WINNERS) out.problem = 'winners';
      out.winners = n;
      left = left.slice(named ? 2 : 1);
    }
  }
  const opts = extractGiveawayOptions(left);
  Object.assign(out, { roleTok: opts.roleTok, level: opts.level, hostTok: opts.hostTok, prize: opts.rest.join(' ').trim() });
  return out;
}

function tally(p) {
  const counts = p.options.map(() => 0);
  const ballots = Object.values(p.votes || {});
  for (const picks of ballots) for (const i of [].concat(picks)) if (counts[i] !== undefined) counts[i]++;
  const total = counts.reduce((a, b) => a + b, 0);
  const top = counts.length ? Math.max(...counts) : 0;
  const leaders = top > 0 ? counts.map((c, i) => (c === top ? i : -1)).filter((i) => i >= 0) : [];
  return { counts, voters: ballots.length, total, top, leaders };
}

function emojiBar(frac, fill = BAR_FILL) {
  const f = Math.max(0, Math.min(1, Number(frac) || 0));
  const full = Math.round(f * BAR_WIDTH);
  return fill.repeat(full) + BAR_EMPTY.repeat(BAR_WIDTH - full);
}

function optionRows(count) {
  const perRow = count <= 5 ? count : Math.ceil(count / 2);
  const out = [];
  for (let i = 0; i < count; i += perRow) out.push(Array.from({ length: Math.min(perRow, count - i) }, (_, k) => i + k));
  return out;
}

function pollView(engine, p) {
  const t = tally(p);
  const base = p.multi ? t.voters : t.total;
  const winners = p.ended ? new Set(t.leaders) : new Set();
  const lines = p.options.map((name, i) => {
    const c = t.counts[i];
    const pct = base ? Math.round((c / base) * 100) : 0;
    const win = winners.has(i);
    return `${NUMBERS[i]} **${name}**${win ? ' 🏆' : ''}\n${emojiBar(base ? c / base : 0, win ? BAR_WIN : BAR_FILL)} **${pct}%** · ${plural(c, 'vote')}`;
  });
  const how = p.multi ? 'Pick as many as you like' : 'One vote each, you can change it';
  let head = '';
  let status;
  if (p.ended) {
    if (!t.leaders.length) head = 'Nobody voted.';
    else if (t.leaders.length === 1) head = `🏆 **${p.options[t.leaders[0]]}** wins with ${plural(t.top, 'vote')}${base ? ` (${Math.round((t.top / base) * 100)}%)` : ''}.`;
    else head = `🤝 It's a tie between ${t.leaders.map((i) => `**${p.options[i]}**`).join(' and ')} with ${plural(t.top, 'vote')} each.`;
    const why = p.endedBy ? 'ended early' : p.late ? `ended ${timeLeft(p.lateByMs)} late because I was offline` : 'ended';
    status = `👥 ${plural(t.voters, 'voter')} · 🏁 Poll ${why}${p.anon ? ' · 🕶️ anonymous' : ''}`;
  } else {
    status = `👥 ${plural(t.voters, 'voter')} · ⏳ Ends in **${timeLeft(p.endsAt - nowOf(engine))}** (${whenText(engine, p.serverId, p.endsAt)})\n-# ${how}${p.anon ? ' · 🕶️ anonymous, nobody sees who voted' : ''}`;
  }
  const body = `${head ? `${head}\n\n` : ''}${lines.join('\n')}\n\n${status}`;
  const embed = card({ title: `📊 ${p.question}`, body, color: p.ended ? 'ok' : 'engage', footer: `Poll #${p.id} · started by ${p.creatorName || 'someone'}` });
  embed.timestamp = new Date(p.ended ? p.endedAt || p.endsAt : p.endsAt).toISOString();
  const components = optionRows(p.options.length).map((idxs) => row(idxs.map((i) => button(
    clip(p.options[i], 80), cid('vote', p.id, i), winners.has(i) ? 'success' : 'secondary', NUMBERS[i], { disabled: !!p.ended },
  ))));
  const controls = [];
  if (!p.ended) controls.push(button('End now', cid('pend', p.id), 'danger', '🏁'));
  if (!p.anon) controls.push(button('Voters', cid('voters', p.id), 'secondary', '👥'));
  if (controls.length) components.push(row(controls));
  return { content: '', embeds: [embed], components };
}

function requirementText(g) {
  const parts = [];
  if (g.roleId) parts.push(`must have <@&${g.roleId}>`);
  if (g.level) parts.push(`level ${g.level}+`);
  return parts.join(' · ');
}

function giveawayView(engine, g) {
  const needs = requirementText(g);
  const host = g.hostId ? `🙋 Hosted by <@${g.hostId}>` : null;
  const entries = g.entries?.length || 0;
  let body;
  if (g.ended) {
    const rerolled = (g.rerolls || []).flatMap((r) => r.ids);
    const winnersLine = g.winnerIds?.length
      ? `🏆 ${g.winnerIds.length === 1 ? 'Winner' : 'Winners'}: ${g.winnerIds.map((u) => `<@${u}>`).join(', ')}`
      : entries ? '😕 Nobody who entered still qualifies, so nobody won.' : '😕 Nobody entered, so nobody won.';
    const why = g.endedBy ? 'Ended early' : g.late ? `Ended ${timeLeft(g.lateByMs)} late because I was offline` : 'Ended';
    body = [
      winnersLine,
      rerolled.length ? `🔁 Rerolled: ${rerolled.map((u) => `<@${u}>`).join(', ')}` : null,
      `🎟️ ${plural(entries, 'entry', 'entries')} · 🏁 ${why}`,
      host,
      needs ? `📋 Needed: ${needs}` : null,
    ].filter(Boolean).join('\n');
  } else {
    body = [
      'Press **🎉 Enter** to join!',
      `👑 **${g.winners}** ${g.winners === 1 ? 'winner' : 'winners'} · 🎟️ **${num(entries)}** ${entries === 1 ? 'entry' : 'entries'}`,
      `⏳ Ends in **${timeLeft(g.endsAt - nowOf(engine))}** (${whenText(engine, g.serverId, g.endsAt)})`,
      host,
      needs ? `📋 To enter: ${needs}` : null,
    ].filter(Boolean).join('\n');
  }
  const embed = card({ title: `🎉 ${g.prize}`, body, color: g.ended ? 'muted' : 'engage', footer: `Giveaway #${g.id}${g.ended ? '' : ' · winners are drawn at random'}` });
  embed.timestamp = new Date(g.ended ? g.endedAt || g.endsAt : g.endsAt).toISOString();
  const btn = g.ended ? button('Ended', cid('enter', g.id), 'secondary', '🎉', { disabled: true }) : button('Enter', cid('enter', g.id), 'primary', '🎉');
  return { content: '', embeds: [embed], components: [row(btn)] };
}

const viewOf = (engine, type, item) => (type === 'poll' ? pollView(engine, item) : giveawayView(engine, item));

function gapOf(engine) {
  const g = Number(engine.config?.liveEditGapMs);
  return Number.isFinite(g) && g >= 0 ? g : EDIT_GAP_MS;
}

function cancelLive(engine, key) {
  const st = stateOf(engine);
  const t = st.timers.get(key);
  if (t) clearTimeout(t);
  st.timers.delete(key);
}

async function refreshNow(engine, sid, type, id) {
  cancelLive(engine, itemKey(sid, type, id));
  const item = readItem(engine, sid, type, id);
  if (!item?.messageId || !item.channelId) return null;
  const view = viewOf(engine, type, item);
  try {
    return await engine.budget.edit({ channelId: item.channelId, messageId: item.messageId, content: '', opts: { embeds: view.embeds, components: view.components }, minGap: 0 });
  } catch (e) {
    if (e?.status === 404) {
      engine.log.debug(`[engage] ${type} #${id} card is gone`);
      return null;
    }
    throw e;
  }
}

function refreshSoon(engine, sid, type, id) {
  const st = stateOf(engine);
  const key = itemKey(sid, type, id);
  if (st.timers.has(key)) return;
  const last = st.last.get(key);
  const wait = last === undefined ? 0 : Math.max(0, last + gapOf(engine) - Date.now());
  const t = setTimeout(() => {
    st.timers.delete(key);
    st.last.set(key, Date.now());
    refreshNow(engine, sid, type, id).catch((e) => engine.log.debug(`[engage] live update of ${type} #${id} failed`, e?.message));
  }, wait);
  t.unref?.();
  st.timers.set(key, t);
}

async function isModHere(ctx) {
  return ctx.engine.perms.atLeast(await ctx.level().catch(() => 'member'), 'mod');
}

async function displayName(engine, sid, uid, fallback = 'someone') {
  const m = await engine.perms.member(sid, uid).catch(() => null);
  return clip(safe(m?.nickname || m?.display_name || m?.username || fallback), 40) || fallback;
}

async function requireManager(ctx, item, type) {
  if (item.createdBy === ctx.userId || item.hostId === ctx.userId) return;
  if (await isModHere(ctx)) return;
  const who = type === 'poll' ? 'the person who started this poll' : 'the host, the person who started it';
  throw friendly(`Only ${who} or a moderator can do that.`, { title: 'Needs Mod', need: 'mod' });
}

async function requireCreator(ctx, type) {
  const need = ctx.config()[type === 'poll' ? 'pollPerm' : 'giveawayPerm'];
  if (need === 'mod' || need === 'admin') await ctx.require(need);
}

async function logToServer(engine, sid, embed) {
  try {
    const mod = engine.service('mod');
    if (mod?.log && engine.settings.isEnabled(sid, 'mod')) { await mod.log(sid, embed); return; }
    const ch = engine.settings.core(sid).logChannel;
    if (!ch) return;
    await engine.budget.send({ serverId: sid, channelId: ch, opts: { embeds: [embed] }, priority: 'low' });
  } catch (e) {
    engine.log.debug('[engage] log failed', e?.message);
  }
}

function pollProblem(spec) {
  if (!spec.question) return ['What should people vote on?', 'Try `/poll Best snack? | Chips | Pretzels | Fruit 2h`.'];
  if (spec.question.length > QUESTION_MAX) return ['That question is long', `Keep it under ${QUESTION_MAX} characters.`];
  if (spec.options.length === 1) return ['Add another option', 'A poll needs at least 2 options, split with `|`: `/poll Best snack? | Chips | Pretzels`. Leave them all out for a quick yes/no poll.'];
  if (spec.options.length > MAX_OPTIONS) return ['Too many options', `A poll can have up to ${MAX_OPTIONS} options. You gave ${spec.options.length}.`];
  const long = spec.options.find((o) => o.length > OPTION_MAX);
  if (long) return ['One option is too long', `Keep each option under ${OPTION_MAX} characters. **${clip(long, 40)}** is ${long.length}.`];
  const seen = new Set();
  for (const o of spec.options) {
    const k = o.toLowerCase();
    if (seen.has(k)) return ['Two options are the same', `**${clip(o, 40)}** is in there twice.`];
    seen.add(k);
  }
  if (spec.durationMs !== null && spec.durationMs < SHORTEST_MS) return ['That is too short', 'A poll needs to run for at least 1 minute.'];
  if (spec.durationMs !== null && spec.durationMs > POLL_MAX_MS) return ['That is too long', 'Polls can run for up to 7 days.'];
  return null;
}

async function createPoll(ctx, raw) {
  const { engine, serverId: sid } = ctx;
  await requireCreator(ctx, 'poll');
  const spec = { ...raw, question: safe(raw.question), options: (raw.options || []).map(safe).filter(Boolean) };
  const problem = pollProblem(spec);
  if (problem) return ctx.warn(...problem);
  if (!spec.options.length) spec.options = ['Yes', 'No'];
  const durationMs = spec.durationMs ?? POLL_DEFAULT_MS;
  const id = reserve(engine, sid, 'poll', { userId: ctx.userId, isMod: await isModHere(ctx) });
  const now = nowOf(engine);
  const poll = {
    id, serverId: sid, channelId: ctx.channelId, messageId: null, question: spec.question, options: spec.options,
    multi: !!spec.multi, anon: !!spec.anon, createdBy: ctx.userId, creatorName: await displayName(engine, sid, ctx.userId, ctx.username),
    createdAt: now, endsAt: now + durationMs, votes: {}, ended: false, endedAt: null,
  };
  engine.store.set(ID, itemKey(sid, 'poll', id), poll);
  try {
    engine.scheduler.schedule({ kind: `${ID}.pollend`, at: poll.endsAt, serverId: sid, key: String(id), data: { id } });
    const msg = await ctx.send(ctx.channelId, pollView(engine, poll), { priority: 'high' });
    if (!msg?.id) throw friendly("Yapin' didn't give me the poll message back, so I took the poll down again. Try once more.", { title: "The poll didn't post" });
    changeItem(engine, sid, 'poll', id, (x) => { x.messageId = msg.id; });
  } catch (e) {
    forget(engine, sid, 'poll', id);
    return ctx.fail(e, { action: 'post the poll in this channel', perm: 'send_messages' });
  }
  if (ctx.kind === 'message') return null;
  return ctx.ok(`Poll #${id} is live`, `It ends in **${timeLeft(durationMs)}**. The bars update on the card every few seconds.\nEnd it early with **🏁 End now** or \`/poll end ${id}\`.`);
}

async function vote(ctx) {
  const { engine, serverId: sid, userId: uid } = ctx;
  const id = idOf(ctx.argv[0]);
  const pick = Number(ctx.argv[1]);
  const poll = readItem(engine, sid, 'poll', id);
  if (!poll) return ctx.warn('This poll is gone', 'It was cleaned up after it ended. Start a new one with **/poll**.');
  if (!Number.isInteger(pick) || pick < 0 || pick >= poll.options.length) return ctx.warn('That option is gone', 'Press one of the buttons on the poll.');
  if (poll.ended || nowOf(engine) >= poll.endsAt) return ctx.info('This poll has ended', 'Votes are closed. The card shows the final results.');
  let before = [];
  let after = [];
  changeItem(engine, sid, 'poll', id, (p) => {
    p.votes ||= {};
    before = [].concat(p.votes[uid] ?? []);
    if (p.multi) after = before.includes(pick) ? before.filter((x) => x !== pick) : [...before, pick].sort((a, b) => a - b);
    else after = before.includes(pick) ? [] : [pick];
    if (after.length) p.votes[uid] = after;
    else delete p.votes[uid];
  });
  refreshSoon(engine, sid, 'poll', id);
  const name = (i) => `**${poll.options[i]}**`;
  if (poll.multi) {
    if (!after.length) return ctx.ok('Votes taken back', `You took back your vote for ${name(pick)}. You have no votes on this poll now.`);
    const took = before.includes(pick);
    return ctx.ok(took ? 'Vote taken back' : 'Vote counted', `${took ? `You took back ${name(pick)}.` : `You voted for ${name(pick)}.`}\nYour votes: ${after.map(name).join(', ')}`);
  }
  if (!after.length) return ctx.ok('Vote taken back', `You took back your vote for ${name(pick)}. Press any option to vote again.`);
  if (before.length) return ctx.ok('Vote changed', `You voted for ${name(pick)} (was ${name(before[0])}).`);
  return ctx.ok('Vote counted', `You voted for ${name(pick)}. Press it again to take it back, or another option to change.`);
}

async function endPoll(engine, sid, id, { late = false, lateByMs = 0, by = null } = {}) {
  const now = nowOf(engine);
  let changed = false;
  const p = changeItem(engine, sid, 'poll', id, (x) => {
    if (x.ended) return;
    const lateMs = Math.max(Number(lateByMs) || 0, now - x.endsAt);
    x.ended = true;
    x.endedAt = now;
    x.endedBy = by;
    x.late = !by && (!!late || lateMs > MIN);
    x.lateByMs = x.late ? lateMs : 0;
    changed = true;
  });
  if (!p) return 'missing';
  if (by) engine.scheduler.cancelWhere({ kind: `${ID}.pollend`, serverId: sid, key: String(id) });
  stateOf(engine).last.delete(itemKey(sid, 'poll', id));
  await refreshNow(engine, sid, 'poll', id);
  return changed ? 'ended' : 'already';
}

async function endPollByHand(ctx, tok) {
  const { engine, serverId: sid } = ctx;
  const id = idOf(tok);
  const poll = readItem(engine, sid, 'poll', id);
  if (!poll) return ctx.warn("I couldn't find that poll", id === null ? 'Which one? Try `/poll end 4`. `/poll list` shows the numbers.' : `There's no poll #${id} here. \`/poll list\` shows the ones running.`);
  await requireManager(ctx, poll, 'poll');
  if (poll.ended) return ctx.info('Already ended', `Poll #${id} has already ended.`);
  try {
    await endPoll(engine, sid, id, { by: ctx.userId });
  } catch (e) {
    engine.log.debug('[engage] could not show final poll results', e?.message);
    return ctx.warn(`Poll #${id} ended`, "Votes are closed, but I couldn't update the card. It may have been deleted, or I can't edit there.");
  }
  const t = tally(readItem(engine, sid, 'poll', id));
  const result = !t.leaders.length ? 'Nobody voted.' : t.leaders.length === 1 ? `**${poll.options[t.leaders[0]]}** won.` : "It's a tie.";
  return ctx.ok(`Poll #${id} ended`, `${result} The card now shows the final results.`);
}

async function showVoters(ctx) {
  const { engine, serverId: sid } = ctx;
  const id = idOf(ctx.argv[0]);
  const poll = readItem(engine, sid, 'poll', id);
  if (!poll) return ctx.warn('This poll is gone', 'It was cleaned up after it ended.');
  if (poll.anon) return ctx.info('This poll is anonymous', 'Nobody can see who voted, not even mods.');
  const by = poll.options.map(() => []);
  for (const [uid, picks] of Object.entries(poll.votes || {})) for (const i of [].concat(picks)) by[i]?.push(uid);
  const room = Math.max(40, 3800 - poll.options.reduce((n, name) => n + name.length + 40, 0));
  const each = Math.max(1, Math.min(25, Math.floor(room / (poll.options.length * 46))));
  const lines = poll.options.map((name, i) => {
    const list = by[i];
    if (!list.length) return `${NUMBERS[i]} **${name}**: nobody yet`;
    const shown = list.slice(0, each).map((u) => `<@${u}>`).join(', ');
    return `${NUMBERS[i]} **${name}** (${list.length}): ${shown}${list.length > each ? ` and ${list.length - each} more` : ''}`;
  });
  return ctx.ephemeral({ embeds: [card({ title: `👥 Who voted: ${clip(poll.question, 200)}`, body: fitLines(lines, 4000), color: 'engage', footer: `Poll #${id}` })] });
}

function listLine(engine, type, x) {
  const where = x.channelId ? ` · in <#${x.channelId}>` : '';
  if (type === 'poll') {
    const t = tally(x);
    if (!x.ended) return `📊 **#${x.id}** ${clip(x.question, 60)} · ${plural(t.voters, 'voter')} · ends in ${timeLeft(x.endsAt - nowOf(engine))}${where}`;
    return `🏁 **#${x.id}** ${clip(x.question, 60)} · ${plural(t.voters, 'voter')} · ended`;
  }
  const entries = x.entries?.length || 0;
  if (!x.ended) return `🎉 **#${x.id}** ${clip(x.prize, 60)} · ${plural(entries, 'entry', 'entries')} · ends in ${timeLeft(x.endsAt - nowOf(engine))}${where}`;
  const won = x.winnerIds?.length ? x.winnerIds.slice(0, 5).map((u) => `<@${u}>`).join(', ') : 'nobody';
  return `🏁 **#${x.id}** ${clip(x.prize, 60)} · won by ${won}`;
}

function listView(engine, sid, type) {
  const all = listItems(engine, sid, type);
  const active = all.filter((x) => !x.ended).sort((a, b) => a.endsAt - b.endsAt);
  const ended = all.filter((x) => x.ended).sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0)).slice(0, 5);
  const name = type === 'poll' ? 'Polls' : 'Giveaways';
  const fields = [
    { name: `Running (${active.length}/${MAX_ACTIVE[type]})`, value: fitLines(active.map((x) => listLine(engine, type, x)), 1024) ||'None right now.' },
    ended.length ? { name: 'Recently ended', value: fitLines(ended.map((x) => listLine(engine, type, x)), 1024) } : null,
  ];
  const tip = type === 'poll' ? 'Start one: `/poll Best snack? | Chips | Pretzels 2h` · end early: `/poll end 4`' : 'Start one: `/giveaway 1d 2 Prize` · `/giveaway end 3` · `/giveaway reroll 3`';
  return { embeds: [card({ title: `${type === 'poll' ? '📊' : '🎉'} ${name}`, body: tip, fields, color: 'engage' })] };
}

function pollForm(ctx) {
  return ctx.form({
    title: 'New poll',
    action: 'pollsubmit',
    fields: [
      { id: 'question', label: 'Question', style: 'short', placeholder: 'Best snack?', max: QUESTION_MAX },
      { id: 'options', label: 'Options, one per line (2 to 10)', style: 'paragraph', placeholder: 'Chips\nPretzels\nFruit', required: false, max: 1000 },
      { id: 'extras', label: 'How long, and extras (optional)', style: 'short', placeholder: '2h multi anon', required: false, max: 60 },
    ],
  });
}

async function submitPollForm(ctx) {
  const v = ctx.values || {};
  const extras = parseExtras(v.extras);
  if (extras.unknown.length) return ctx.warn("I didn't get the extras", `I don't know **${clip(extras.unknown.join(' '), 40)}**. Use a length like \`2h\` or \`3d\`, plus \`multi\` and/or \`anon\`.`);
  const options = String(v.options ?? '').split(/\r?\n|\|/).map((s) => s.trim()).filter(Boolean);
  return createPoll(ctx, { question: String(v.question ?? '').replace(/\|/g, '/').trim(), options, multi: extras.multi, anon: extras.anon, durationMs: extras.durationMs });
}

async function runPoll(ctx) {
  const text = String(ctx.args ?? '').trim();
  if (!text) {
    await requireCreator(ctx, 'poll');
    return pollForm(ctx);
  }
  if (!text.includes('|')) {
    const toks = tokenize(text);
    const sub = (toks[0] || '').toLowerCase();
    if (/^(help|\?)$/.test(text.toLowerCase())) return ctx.info('Polls', pollHelpText());
    if (sub === 'list' && toks.length === 1) return ctx.ephemeral(listView(ctx.engine, ctx.serverId, 'poll'));
    if (['end', 'stop', 'close'].includes(sub) && toks.length === 2 && idOf(toks[1]) !== null) return endPollByHand(ctx, toks[1]);
    if (['end', 'stop', 'close'].includes(sub) && toks.length === 1) return ctx.warn('Which poll?', 'Try `/poll end 4`. `/poll list` shows the numbers.');
  }
  return createPoll(ctx, parsePoll(text));
}

const pollHelpText = () => [
  '`/poll Best snack? | Chips | Pretzels | Fruit 2h`',
  'Split the question and 2 to 10 options with `|`. Add a length at the end (default 24h, up to 7 days).',
  'Add `multi` to let people pick several, `anon` to hide who voted.',
  '`/poll Pizza tonight?` makes a quick yes/no poll. `/poll list` · `/poll end 4`',
].join('\n');

const levelsFor = (engine, sid) => {
  const svc = engine.service('levels');
  return svc?.getUser && engine.settings.isEnabled(sid, 'levels') ? svc : null;
};

async function freshMember(engine, sid, uid) {
  try {
    return await engine.bot.member(sid, uid);
  } catch (e) {
    if (e?.status === 404) return null;
    throw e;
  }
}

async function eligibility(engine, sid, g, uid, { atEnd = false } = {}) {
  const member = await freshMember(engine, sid, uid);
  if (!member) return { ok: false, left: true, reason: "You're not in this server." };
  if (g.roleId && !(member.roles || []).includes(g.roleId)) return { ok: false, reason: `You need the **@${g.roleName || 'required'}** role to enter.` };
  if (g.level) {
    const levels = levelsFor(engine, sid);
    if (!levels) {
      if (atEnd) return { ok: true };
      return { ok: false, reason: "This giveaway needs a level, but the Levels app isn't on here right now, so I can't check it. Ask a mod." };
    }
    const lvl = Number(levels.getUser(sid, uid)?.level) || 0;
    if (lvl < g.level) return { ok: false, reason: `You need to be **level ${g.level}** to enter. You're level ${lvl}. Keep chatting!` };
  }
  return { ok: true };
}

async function pickWinners(engine, sid, g, count, exclude) {
  const pool = (g.entries || []).filter((u) => !exclude.has(u));
  const winners = [];
  let checks = 0;
  while (pool.length && winners.length < count && checks < MAX_CHECKS) {
    const i = randomInt(pool.length);
    const uid = pool[i];
    pool[i] = pool[pool.length - 1];
    pool.pop();
    checks++;
    const e = await eligibility(engine, sid, g, uid, { atEnd: true });
    if (e.ok) winners.push(uid);
  }
  return winners;
}

async function announce(engine, g, ids, { reroll = false } = {}) {
  const mentions = ids.map((u) => `<@${u}>`).join(', ');
  const prize = `**${g.prize}**`;
  let text;
  if (reroll) text = `🔁 Reroll for ${prize}: congratulations ${mentions}! You won!`;
  else if (ids.length) text = `🎉 Congratulations ${mentions}! You won ${prize}!`;
  else if (g.entries?.length) text = `😕 The giveaway for ${prize} has ended, but nobody who entered still qualifies, so there's no winner.`;
  else text = `😕 The giveaway for ${prize} has ended with no entries, so there's no winner.`;
  const notes = [`Giveaway #${g.id}`];
  if (g.hostName) notes.push(`hosted by ${g.hostName}`);
  if (!reroll && g.late) notes.push(`sorry, this ended ${timeLeft(g.lateByMs)} late because I was offline`);
  const content = clip(`${text}\n-# ${notes.join(' · ')}`, 2000);
  return engine.budget.send({ serverId: g.serverId, channelId: g.channelId, content, priority: 'normal' });
}

async function logGiveaway(engine, g, ids, { reroll = false, by = null } = {}) {
  const body = [
    `**${g.prize}** (#${g.id}) in <#${g.channelId}>`,
    `${reroll ? 'New winner' : 'Winners'}: ${ids.length ? ids.map((u) => `<@${u}>`).join(', ') : 'nobody'}`,
    `Entries: ${num(g.entries?.length || 0)}`,
    by ? `By: <@${by}>` : null,
  ].filter(Boolean).join('\n');
  await logToServer(engine, g.serverId, card({ title: `${ICONS.engage} ${reroll ? 'Giveaway rerolled' : 'Giveaway ended'}`, body, color: 'engage' }));
}

async function withLock(engine, key, fn) {
  const st = stateOf(engine);
  if (st.busy.has(key)) return { status: 'busy' };
  st.busy.add(key);
  try {
    return await fn();
  } finally {
    st.busy.delete(key);
  }
}

async function endGiveaway(engine, sid, id, { late = false, lateByMs = 0, by = null } = {}) {
  return withLock(engine, itemKey(sid, 'giveaway', id), async () => {
    let g = readItem(engine, sid, 'giveaway', id);
    if (!g) return { status: 'missing' };
    let status = 'already';
    if (!g.ended) {
      const winners = await pickWinners(engine, sid, g, g.winners, new Set());
      const now = nowOf(engine);
      g = changeItem(engine, sid, 'giveaway', id, (x) => {
        if (x.ended) return;
        const lateMs = Math.max(Number(lateByMs) || 0, now - x.endsAt);
        x.ended = true;
        x.endedAt = now;
        x.endedBy = by;
        x.late = !by && (!!late || lateMs > MIN);
        x.lateByMs = x.late ? lateMs : 0;
        x.winnerIds = winners;
        status = 'ended';
      });
      if (by) engine.scheduler.cancelWhere({ kind: `${ID}.giveawayend`, serverId: sid, key: String(id) });
    }
    stateOf(engine).last.delete(itemKey(sid, 'giveaway', id));
    let editError = null;
    try { await refreshNow(engine, sid, 'giveaway', id); } catch (e) { editError = e; }
    g = readItem(engine, sid, 'giveaway', id);
    if (!g.announced) {
      try {
        await announce(engine, g, g.winnerIds || []);
      } catch (e) {
        if (e?.status !== 403 && e?.status !== 404) {
          if (by) engine.scheduler.schedule({ kind: `${ID}.giveawayend`, at: nowOf(engine) + MIN, serverId: sid, key: String(id), data: { id } });
          throw e;
        }
        await logToServer(engine, sid, card({ title: `${ICONS.warn} Giveaway announcement failed`, body: `I couldn't post the winners of **${g.prize}** (#${g.id}) in <#${g.channelId}>. My role may need **Send Messages** there, or the channel is gone.`, color: 'warn' }));
      }
      changeItem(engine, sid, 'giveaway', id, (x) => { x.announced = true; });
      await logGiveaway(engine, g, g.winnerIds || [], { by });
    }
    return { status, giveaway: readItem(engine, sid, 'giveaway', id), editError };
  });
}

async function createGiveaway(ctx, spec) {
  const { engine, serverId: sid } = ctx;
  await requireCreator(ctx, 'giveaway');
  const usage = 'Try `/giveaway 1d 2 Nitro-style prize`, with `role @VIP`, `level 5` or `host @sam` if you like.';
  if (spec.durationMs === null || spec.durationMs === undefined) return ctx.warn('How long should it run?', `Start with a length like \`1d\`, \`12h\` or \`30m\`.\n${usage}`);
  if (spec.durationMs < SHORTEST_MS) return ctx.warn('That is too short', 'A giveaway needs to run for at least 1 minute.');
  if (spec.durationMs > GIVEAWAY_MAX_MS) return ctx.warn('That is too long', 'Giveaways can run for up to 30 days.');
  if (spec.problem === 'winners' || !Number.isInteger(spec.winners) || spec.winners < 1 || spec.winners > MAX_WINNERS) return ctx.warn('How many winners?', `Pick 1 to ${MAX_WINNERS} winners.`);
  const prize = safe(spec.prize);
  if (!prize) return ctx.warn('What is the prize?', usage);
  if (prize.length > PRIZE_MAX) return ctx.warn('That prize name is long', `Keep it under ${PRIZE_MAX} characters.`);
  let role = null;
  if (spec.roleTok) {
    role = await ctx.findRole(spec.roleTok);
    if (!role) return ctx.warn("I couldn't find that role", `No role matches **${clip(safe(spec.roleTok), 40)}**.`);
    if (/^@?everyone$/i.test(role.name) || role.id === sid) return ctx.warn('Everyone has that role', 'Leave the role out to let everyone enter.');
  }
  if (spec.level !== null && spec.level !== undefined) {
    if (!Number.isInteger(spec.level) || spec.level < 1 || spec.level > 1000) return ctx.warn("That level didn't work", 'Use a level from 1 to 1000, like `level 5`.');
    if (!levelsFor(engine, sid)) return ctx.warn('Levels is off here', "A level requirement needs the Levels app. An admin can install it with **/apps**, or leave the level out.");
  }
  let host = null;
  if (spec.hostTok) {
    const found = await ctx.findUser(spec.hostTok);
    const member = found?.id ? await engine.perms.member(sid, found.id).catch(() => null) : null;
    if (!member) return ctx.warn("I couldn't find the host", `Nobody here matches **${clip(safe(spec.hostTok), 40)}**.`);
    if (member.id === engine.bot.me?.id) return ctx.warn('Pick a person to host', "I can run the giveaway, but the host should be a person.");
    host = member;
  }
  const hostId = host?.id || ctx.userId;
  const id = reserve(engine, sid, 'giveaway', { userId: ctx.userId, isMod: true });
  const now = nowOf(engine);
  const g = {
    id, serverId: sid, channelId: ctx.channelId, messageId: null, prize, winners: spec.winners,
    hostId, hostName: host ? clip(safe(host.nickname || host.display_name || host.username), 40) : await displayName(engine, sid, ctx.userId, ctx.username),
    createdBy: ctx.userId, createdAt: now, endsAt: now + spec.durationMs,
    roleId: role?.id || null, roleName: role ? clip(safe(role.name), 60) : null, level: spec.level || null,
    entries: [], ended: false, endedAt: null, winnerIds: [], rerolls: [], announced: false,
  };
  engine.store.set(ID, itemKey(sid, 'giveaway', id), g);
  try {
    engine.scheduler.schedule({ kind: `${ID}.giveawayend`, at: g.endsAt, serverId: sid, key: String(id), data: { id } });
    const msg = await ctx.send(ctx.channelId, giveawayView(engine, g), { priority: 'high' });
    if (!msg?.id) throw friendly("Yapin' didn't give me the giveaway message back, so I took it down again. Try once more.", { title: "The giveaway didn't post" });
    changeItem(engine, sid, 'giveaway', id, (x) => { x.messageId = msg.id; });
  } catch (e) {
    forget(engine, sid, 'giveaway', id);
    return ctx.fail(e, { action: 'post the giveaway in this channel', perm: 'send_messages' });
  }
  if (ctx.kind === 'message') return null;
  return ctx.ok(`Giveaway #${id} is live`, `It ends in **${timeLeft(spec.durationMs)}** and picks ${plural(spec.winners, 'winner')}.\nEnd it early with \`/giveaway end ${id}\`, or pick someone new later with \`/giveaway reroll ${id}\`.`);
}

async function enter(ctx) {
  const { engine, serverId: sid, userId: uid } = ctx;
  const id = idOf(ctx.argv[0]);
  const g = readItem(engine, sid, 'giveaway', id);
  if (!g) return ctx.warn('This giveaway is gone', 'It was cleaned up after it ended.');
  if (g.ended || nowOf(engine) >= g.endsAt) return ctx.info('This giveaway has ended', g.ended ? 'The card shows who won.' : "I'm drawing the winners right now.");
  if (uid === engine.bot.me?.id) return null;
  if ((g.entries || []).includes(uid)) return pressAgain(ctx, g);
  forgetLeaveAsk(engine, sid, id, uid);
  const ok = await eligibility(engine, sid, g, uid);
  if (!ok.ok) return ctx.warn("You can't enter yet", ok.reason);
  let result = null;
  let count = 0;
  changeItem(engine, sid, 'giveaway', id, (x) => {
    x.entries ||= [];
    if (x.ended) { result = 'ended'; return; }
    if (x.entries.includes(uid)) { result = 'already'; count = x.entries.length; return; }
    if (x.entries.length >= MAX_ENTRIES) { result = 'full'; return; }
    x.entries.push(uid);
    count = x.entries.length;
    result = 'in';
  });
  if (result === 'ended') return ctx.info('This giveaway has ended', 'The card shows who won.');
  if (result === 'full') return ctx.warn('This giveaway is full', `It already has ${num(MAX_ENTRIES)} entries, the most I keep.`);
  if (result === 'already') return ctx.info("You're already in", `There are **${plural(count, 'entry', 'entries')}** so far.`);
  refreshSoon(engine, sid, 'giveaway', id);
  const left = g.endsAt - nowOf(engine);
  return ctx.ok("You're in!", `Good luck! There ${count === 1 ? 'is' : 'are'} now **${plural(count, 'entry', 'entries')}**.\n-# Winners are drawn ${left < MIN ? 'any moment now' : `in ${timeLeft(left)}`}. Press Enter again if you want to leave.`);
}

const leaveAskKey = (sid, id, uid) => `${sid}.${id}.${uid}`;

function forgetLeaveAsk(engine, sid, id, uid) {
  stateOf(engine).leaveAsks.delete(leaveAskKey(sid, id, uid));
}

function rememberLeaveAsk(engine, key, at) {
  const asks = stateOf(engine).leaveAsks;
  for (const [k, t] of asks) if (at - t > LEAVE_WINDOW_MS) asks.delete(k);
  while (asks.size >= LEAVE_ASKS_MAX) asks.delete(asks.keys().next().value);
  asks.set(key, at);
}

function removeEntry(engine, sid, id, uid) {
  let result = 'missing';
  let count = 0;
  changeItem(engine, sid, 'giveaway', id, (x) => {
    if (x.ended) { result = 'ended'; return; }
    const before = (x.entries || []).length;
    x.entries = (x.entries || []).filter((u) => u !== uid);
    count = x.entries.length;
    result = x.entries.length < before ? 'left' : 'notin';
  });
  if (result === 'left') refreshSoon(engine, sid, 'giveaway', id);
  return { result, count };
}

async function pressAgain(ctx, g) {
  const { engine, serverId: sid, userId: uid } = ctx;
  const key = leaveAskKey(sid, g.id, uid);
  const asks = stateOf(engine).leaveAsks;
  const asked = asks.get(key);
  const now = Date.now();
  const entries = g.entries.length;
  if (asked !== undefined && now - asked <= LEAVE_WINDOW_MS && now - asked >= LEAVE_MIN_GAP_MS) {
    asks.delete(key);
    const { result, count } = removeEntry(engine, sid, g.id, uid);
    if (result === 'left') return ctx.ok('You left the giveaway', `You're out. There ${count === 1 ? 'is' : 'are'} now **${plural(count, 'entry', 'entries')}**. Press **🎉 Enter** again any time before it ends to rejoin.`);
    if (result === 'ended') return ctx.info('This giveaway has ended', 'It is too late to leave.');
    return ctx.info("You weren't in it", 'Nothing changed.');
  }
  if (asked === undefined || now - asked > LEAVE_WINDOW_MS) rememberLeaveAsk(engine, key, now);
  return ctx.info("You're already in", `There ${entries === 1 ? 'is' : 'are'} **${plural(entries, 'entry', 'entries')}** so far. Good luck!\n-# Want to leave? Press **🎉 Enter** once more in the next ${LEAVE_WINDOW_MS / 1000} seconds.`);
}

async function leave(ctx) {
  const { engine, serverId: sid, userId: uid } = ctx;
  const id = idOf(ctx.argv[0]);
  const { result, count } = removeEntry(engine, sid, id, uid);
  forgetLeaveAsk(engine, sid, id, uid);
  const embeds = {
    left: [dialog.ok('You left the giveaway', `You're out. There ${count === 1 ? 'is' : 'are'} now ${plural(count, 'entry', 'entries')}. Press Enter again any time before it ends to rejoin.`)],
    notin: [dialog.info("You weren't in it", 'Nothing changed.')],
    ended: [dialog.info('This giveaway has ended', 'It is too late to leave.')],
    missing: [dialog.warn('This giveaway is gone', 'It was cleaned up after it ended.')],
  }[result];
  return ctx.update({ embeds, components: [] });
}

async function findGiveaway(ctx, tok, verb) {
  const id = idOf(tok);
  const g = readItem(ctx.engine, ctx.serverId, 'giveaway', id);
  if (!g) {
    await ctx.warn("I couldn't find that giveaway", id === null ? `Which one? Try \`/giveaway ${verb} 3\`. \`/giveaway list\` shows the numbers.` : `There's no giveaway #${id} here. \`/giveaway list\` shows them.`);
    return null;
  }
  return g;
}

async function endGiveawayByHand(ctx, tok) {
  const g = await findGiveaway(ctx, tok, 'end');
  if (!g) return null;
  await requireManager(ctx, g, 'giveaway');
  if (g.ended) return ctx.info('Already ended', `Giveaway #${g.id} has already ended. Pick someone new with \`/giveaway reroll ${g.id}\`.`);
  let out;
  try {
    out = await endGiveaway(ctx.engine, ctx.serverId, g.id, { by: ctx.userId });
  } catch (e) {
    ctx.engine.log.debug('[engage] giveaway announcement failed', e?.message);
    return ctx.warn(`Giveaway #${g.id} ended`, "I drew the winners, but Yapin' didn't let me post the announcement just now. I'll try again in a minute.");
  }
  if (out.status === 'busy') return ctx.info('Already ending', "I'm drawing the winners right now. Give it a moment.");
  const won = out.giveaway?.winnerIds || [];
  const fix = out.editError ? "\n-# I couldn't update the giveaway card. It may have been deleted." : '';
  return ctx.ok(`Giveaway #${g.id} ended`, `${won.length ? `${won.length === 1 ? 'Winner' : 'Winners'}: ${won.map((u) => `<@${u}>`).join(', ')}` : 'Nobody could win.'}${fix}`);
}

async function rerollGiveaway(ctx, tok, countTok) {
  const { engine, serverId: sid } = ctx;
  const g = await findGiveaway(ctx, tok, 'reroll');
  if (!g) return null;
  await requireManager(ctx, g, 'giveaway');
  if (!g.ended) return ctx.warn('Still running', `Giveaway #${g.id} hasn't ended yet. End it first with \`/giveaway end ${g.id}\`.`);
  const count = countTok === undefined ? 1 : Number(countTok);
  if (!Number.isInteger(count) || count < 1 || count > MAX_WINNERS) return ctx.warn('How many new winners?', `Pick 1 to ${MAX_WINNERS}, like \`/giveaway reroll ${g.id} 2\`.`);
  if ((g.rerolls || []).length >= MAX_REROLLS) return ctx.warn('Too many rerolls', `Giveaway #${g.id} has been rerolled ${MAX_REROLLS} times, which is the most I allow. Start a new giveaway instead.`);
  const out = await withLock(engine, itemKey(sid, 'giveaway', g.id), async () => {
    const fresh = readItem(engine, sid, 'giveaway', g.id);
    const exclude = new Set([...(fresh.winnerIds || []), ...(fresh.rerolls || []).flatMap((r) => r.ids)]);
    const ids = await pickWinners(engine, sid, fresh, count, exclude);
    if (!ids.length) return { status: 'empty' };
    changeItem(engine, sid, 'giveaway', g.id, (x) => { x.rerolls = [...(x.rerolls || []), { at: nowOf(engine), by: ctx.userId, ids }]; });
    try { await refreshNow(engine, sid, 'giveaway', g.id); } catch (e) { engine.log.debug('[engage] reroll card update failed', e?.message); }
    const now = readItem(engine, sid, 'giveaway', g.id);
    try { await announce(engine, now, ids, { reroll: true }); } catch (e) { engine.log.debug('[engage] reroll announcement failed', e?.message); }
    await logGiveaway(engine, now, ids, { reroll: true, by: ctx.userId });
    return { status: 'ok', ids };
  });
  if (out.status === 'busy') return ctx.info('Busy', "I'm already drawing for this giveaway. Give it a moment.");
  if (out.status === 'empty') return ctx.warn('Nobody left to pick', 'Everyone else who entered has already won, left the server, or no longer meets the requirements.');
  return ctx.ok('Rerolled', `New ${out.ids.length === 1 ? 'winner' : 'winners'}: ${out.ids.map((u) => `<@${u}>`).join(', ')}. I announced it in <#${g.channelId}>.`);
}

function giveawayForm(ctx) {
  return ctx.form({
    title: 'New giveaway',
    action: 'givesubmit',
    fields: [
      { id: 'prize', label: 'Prize', style: 'short', placeholder: 'Nitro-style prize', max: PRIZE_MAX },
      { id: 'duration', label: 'How long? (like 1d, 12h, 30m)', style: 'short', placeholder: '1d', max: 20 },
      { id: 'winners', label: 'How many winners? (1 to 20)', style: 'short', placeholder: '1', required: false, max: 2 },
      { id: 'extras', label: 'Requirements and host (optional)', style: 'short', placeholder: 'role @VIP level 5 host @sam', required: false, max: 200 },
    ],
  });
}

async function submitGiveawayForm(ctx) {
  const v = ctx.values || {};
  const durText = String(v.duration ?? '').trim();
  const durationMs = /[a-z]/i.test(durText) ? parseDuration(durText) : parseDuration(durText, { bareUnit: 'h' });
  const winText = String(v.winners ?? '').trim();
  const winners = winText ? (/^\d+$/.test(winText) ? Number(winText) : NaN) : 1;
  const opts = extractGiveawayOptions(tokenize(v.extras));
  if (opts.rest.length) return ctx.warn("I didn't get the requirements", `I don't know **${clip(safe(opts.rest.join(' ')), 40)}**. Use \`role @VIP\`, \`level 5\` and/or \`host @sam\`.`);
  return createGiveaway(ctx, { durationMs, winners, prize: String(v.prize ?? ''), roleTok: opts.roleTok, level: opts.level, hostTok: opts.hostTok, problem: null });
}

const giveawayHelpText = () => [
  '`/giveaway 1d 2 Nitro-style prize` runs a 1 day giveaway with 2 winners.',
  'Extras: `role @VIP` (must have the role), `level 5` (needs Levels), `host @sam`. Up to 20 winners and 30 days.',
  '`/giveaway list` · `/giveaway end 3` · `/giveaway reroll 3` (host or mods)',
].join('\n');

async function runGiveaway(ctx) {
  const text = String(ctx.args ?? '').trim();
  const toks = tokenize(text);
  const sub = (toks[0] || '').toLowerCase();
  if (!text) {
    const cfg = ctx.config();
    const allowed = ctx.engine.perms.atLeast(await ctx.level(), cfg.giveawayPerm || 'mod');
    if (!allowed) return ctx.ephemeral(listView(ctx.engine, ctx.serverId, 'giveaway'));
    return giveawayForm(ctx);
  }
  if (sub === 'help' || sub === '?') return ctx.info('Giveaways', giveawayHelpText());
  if (sub === 'list') return ctx.ephemeral(listView(ctx.engine, ctx.serverId, 'giveaway'));
  if (['end', 'stop', 'finish'].includes(sub)) return endGiveawayByHand(ctx, toks[1]);
  if (['reroll', 'redraw'].includes(sub)) return rerollGiveaway(ctx, toks[1], toks[2]);
  const spec = parseGiveaway(text);
  if (spec.durationMs === null) {
    const guess = /^[a-z]+$/.test(sub) ? didYouMean(sub, GIVEAWAY_SUBS) : [];
    if (guess.length) return ctx.warn("I didn't get that", `Did you mean ${guess.map((g) => `**/giveaway ${g}**`).join(', ')}?\n${giveawayHelpText()}`);
  }
  return createGiveaway(ctx, spec);
}

async function onMemberLeave(ctx, ev) {
  const { engine } = ctx;
  const sid = ev.server_id;
  const uid = ev.user_id;
  if (!sid || !uid) return;
  for (const g of listItems(engine, sid, 'giveaway')) {
    if (g.ended || !(g.entries || []).includes(uid)) continue;
    changeItem(engine, sid, 'giveaway', g.id, (x) => { x.entries = (x.entries || []).filter((u) => u !== uid); });
    refreshSoon(engine, sid, 'giveaway', g.id);
  }
}

function pausedJob(engine, job, type) {
  const item = readItem(engine, job.serverId, type, job.data?.id);
  if (!item || item.ended) return undefined;
  if (nowOf(engine) - item.endsAt > GIVE_UP_MS) return undefined;
  return { reschedule: nowOf(engine) + PAUSED_RETRY_MS };
}

async function panelView(ctx) {
  const { engine, serverId: sid } = ctx;
  const level = await ctx.level().catch(() => 'member');
  const at = (need) => engine.perms.atLeast(level, need);
  const cfg = ctx.config();
  const canPoll = at(cfg.pollPerm || 'member');
  const canGive = at(cfg.giveawayPerm || 'mod');
  const polls = listItems(engine, sid, 'poll').filter((x) => !x.ended).sort((a, b) => a.endsAt - b.endsAt);
  const gives = listItems(engine, sid, 'giveaway').filter((x) => !x.ended).sort((a, b) => a.endsAt - b.endsAt);
  const fields = [
    { name: `📊 Polls running (${polls.length})`, value: fitLines(polls.map((x) => listLine(engine, 'poll', x)), 1024) || 'None right now.' },
    { name: `🎉 Giveaways running (${gives.length})`, value: fitLines(gives.map((x) => listLine(engine, 'giveaway', x)), 1024) || 'None right now.' },
  ];
  const tips = [];
  tips.push(canPoll ? 'Start a poll: `/poll Best snack? | Chips | Pretzels 2h`' : 'Polls are started by mods here. You can still vote on any poll.');
  tips.push(canGive ? 'Run a giveaway: `/giveaway 1d 2 Prize name`' : 'Press **🎉 Enter** on any giveaway card to join.');
  if (at('admin')) {
    fields.push({ name: 'Who can start things', value: `Polls: **${cfg.pollPerm === 'mod' ? 'mods' : 'everyone'}** · Giveaways: **${cfg.giveawayPerm === 'member' ? 'everyone' : 'mods'}**` });
  }
  const buttons = [];
  if (canPoll) buttons.push(button('New poll', cid('newpoll'), 'primary', '📊'));
  if (canGive) buttons.push(button('New giveaway', cid('newgive'), 'primary', '🎉'));
  buttons.push(button('All giveaways', cid('glist'), 'secondary', '📋'));
  const components = [row(buttons)];
  if (at('admin')) {
    components.push(row(
      button(cfg.pollPerm === 'mod' ? 'Polls: mods only' : 'Polls: everyone', cid('tpoll'), 'secondary', '📊'),
      button(cfg.giveawayPerm === 'member' ? 'Giveaways: everyone' : 'Giveaways: mods only', cid('tgive'), 'secondary', '🎉'),
    ));
  }
  return { embeds: [card({ title: `${ICONS.engage} Engage`, body: tips.join('\n'), fields, color: 'engage' })], components };
}

const adminToggle = (key, values) => ({
  perm: 'admin',
  run: async (ctx) => {
    await ctx.require('admin');
    const cur = ctx.config()[key];
    ctx.patchConfig({ [key]: cur === values[0] ? values[1] : values[0] });
    return ctx.update(await panelView(ctx));
  },
});

export const { setup, teardown, check } = defineApp({
  id: ID,
  name: 'Engage',
  icon: ICONS.engage,
  description: 'Polls with live results and fair giveaways.',
  category: 'Community',
  panelPerm: 'member',

  defaults: {
    pollPerm: 'member',
    giveawayPerm: 'mod',
  },

  commands: {
    poll: { description: 'Start a poll: /poll Best snack? | Chips | Pretzels 2h (add multi or anon). /poll end 4', run: runPoll },
    giveaway: { description: 'Run a giveaway: /giveaway 1d 2 Prize (role @VIP, level 5, host @sam). Also list, end, reroll', run: runGiveaway },
  },

  components: {
    vote: { run: vote },
    voters: { run: showVoters },
    pend: { run: (ctx) => endPollByHand(ctx, ctx.argv[0]) },
    enter: { run: enter },
    leave: { run: leave },
    stay: { run: (ctx) => ctx.update({ embeds: [dialog.ok('Still in', "You're still in the giveaway. Good luck!")], components: [] }) },
    newpoll: { run: async (ctx) => { await requireCreator(ctx, 'poll'); return pollForm(ctx); } },
    pollsubmit: { run: submitPollForm },
    newgive: { run: async (ctx) => { await requireCreator(ctx, 'giveaway'); return giveawayForm(ctx); } },
    givesubmit: { run: submitGiveawayForm },
    glist: { run: (ctx) => ctx.ephemeral(listView(ctx.engine, ctx.serverId, 'giveaway')) },
    tpoll: adminToggle('pollPerm', ['member', 'mod']),
    tgive: adminToggle('giveawayPerm', ['mod', 'member']),
  },

  events: {
    member_leave: onMemberLeave,
  },

  jobs: {
    pollend: async (job, engine) => {
      if (!engine.settings.isEnabled(job.serverId, ID)) return pausedJob(engine, job, 'poll');
      await endPoll(engine, job.serverId, job.data?.id, { late: job.late, lateByMs: job.lateByMs });
      return undefined;
    },
    giveawayend: async (job, engine) => {
      if (!engine.settings.isEnabled(job.serverId, ID)) return pausedJob(engine, job, 'giveaway');
      const out = await endGiveaway(engine, job.serverId, job.data?.id, { late: job.late, lateByMs: job.lateByMs });
      if (out.status === 'busy') return { reschedule: nowOf(engine) + MIN };
      if (out.editError) throw out.editError;
      return undefined;
    },
  },

  yap: [
    { words: ['poll', 'vote'], run: runPoll },
    { words: ['giveaway', 'giveaways', 'gaw'], run: runGiveaway },
  ],

  panel: async (ctx) => ctx.ephemeral(await panelView(ctx)),

  help: [
    'Polls: `/poll Best snack? | Chips | Pretzels | Fruit 2h`. Add `multi` to allow several picks and `anon` to hide who voted. Default 24h, up to 7 days.',
    '`/poll Pizza tonight?` makes a quick yes/no poll. Votes can be changed; the bars update on the card. `/poll end 4` ends one early (whoever started it, or mods).',
    'Giveaways: `/giveaway 1d 2 Prize` with `role @VIP`, `level 5` or `host @sam`. Press 🎉 Enter to join; press it again to check you are in or to leave.',
    '`/giveaway list` · `/giveaway end 3` · `/giveaway reroll 3`. Winners are drawn at random; people who left or no longer qualify are skipped.',
  ],

  dispose: (engine) => {
    const st = states.get(engine);
    if (st) for (const t of st.timers.values()) clearTimeout(t);
    states.delete(engine);
  },
});

