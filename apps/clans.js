import { defineApp } from '../engine/apps.js';
import { card, dialog, button, row } from '../engine/ui.js';
import { customId } from '../engine/router.js';
import { tokenize, didYouMean, clip, normalizeName, userId as idOf, ID_RE } from '../engine/parse.js';
import { looksLikeFeatureOff } from '../engine/errors.js';
import { GLOBAL_KEY, CURRENCY, globalConfig, patchGlobalConfig, globalDoc, mutateGlobal, canGiveCurrency } from '../engine/global.js';
import { profileSync } from '../engine/profiles-sync.js';

const ID = 'clans';
const cid = (action, ...args) => customId(ID, action, ...args);

const NS = 'clans';
const DAY = 86_400_000;
const COLOR = 0x5b8def;
export const OLD_CAP_PRICES = Object.freeze([1000, 2500, 5000]);
export const JOIN_MODES = Object.freeze(['open', 'invite']);
const LOG_MAX = 10;
const RECENT_JOINS = 3;
const REFUND_NOTE_MS = 30 * DAY;
const WEB_USER_RE = /^[\w-]{1,64}$/;
export const STYLE_PRICE = 1500;
export const BOOST_PRICE = 5000;
export const BOOST = 0.05;
export const CREATE_COST = 500;
const CREATE_COST_MAX = 1_000_000;
const INVITE_TTL_MS = 7 * DAY;
const MAX_INVITES = 5;
export const INVITE_RATE = 10;
const INVITE_WINDOW_MS = 3_600_000;
const REINVITE_MS = DAY;
const DECLINE_MS = 7 * DAY;
const TARGET_DM_CAP = 3;
const LOOKUP_MS = 2500;
const DM_MS = 4000;
const SEND_MS = 8000;
const MAX_CLANS = 5000;
const NAME_MIN = 3;
const NAME_MAX = 24;
const BANNER_MAX = 60;
const TOP_SIZE = 10;
const DEPOSIT_MAX = 1_000_000_000;
const MEDALS = ['🥇', '🥈', '🥉'];
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 '._-]*[A-Za-z0-9.']$/;
const TAG_RE = /^[A-Za-z0-9]{3,4}$/;
const RESERVED = ['admin', 'admn', 'adm', 'mod', 'mods', 'moderator', 'staff', 'staf', 'stff', 'yapin', 'yapn', 'yap', 'yaps', 'yapper', 'yapos', 'yos', 'official', 'owner', 'ownr', 'dev', 'devs', 'system', 'sys', 'bot', 'bots', 'support', 'help'];
const COLOURS = Object.freeze({
  red: 0xed4245, orange: 0xe67e22, yellow: 0xfee75c, gold: 0xd4af37, green: 0x57f287, teal: 0x1abc9c, cyan: 0x00bcd4,
  blue: 0x3498db, navy: 0x2c3e80, purple: 0x9b59b6, violet: 0x7c5cff, pink: 0xeb459e, white: 0xf5f5f5, grey: 0x95a5a6, gray: 0x95a5a6, black: 0x23272a,
});

let filter = null;
try {
  filter = await import('../dashboard/web/activity/js/filter.js');
} catch {
  filter = null;
}

const nowOf = (engine) => engine.scheduler?.now?.() ?? Date.now();
const fmt = (n) => Math.max(0, Math.trunc(Number(n) || 0)).toLocaleString('en-US');
const shards = (n) => `${fmt(n)} ${CURRENCY.emoji}`;
const cleanText = (text) => String(text ?? '').replace(/<@&[\w-]+>/g, '').replace(/<@!?[\w-]+>/g, '').replace(/<#[\w-]+>/g, '').replace(/[<>*_~`|\\@]/g, '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
const blank = () => ({ seq: 0, clans: {}, members: {}, invites: {}, outbox: {}, inbox: {}, declined: {}, feed: [], feedSeq: 0 });
const FEED_MAX = 300;
const FEED_MS = 7 * DAY;
const DEPOSITS_SHOWN = 10;
const WEB_KINDS = new Set(['create', 'invite', 'accept', 'decline', 'kick', 'leader', 'tag', 'colour', 'banner', 'privacy', 'upgrade', 'disband', 'leave']);

function fix(d) {
  const doc = d && typeof d === 'object' ? d : blank();
  for (const k of ['clans', 'members', 'invites', 'outbox', 'inbox', 'declined']) if (!doc[k] || typeof doc[k] !== 'object' || Array.isArray(doc[k])) doc[k] = {};
  doc.seq = Number.isInteger(doc.seq) ? doc.seq : 0;
  doc.rev = Number.isInteger(doc.rev) ? doc.rev : 0;
  if (!Array.isArray(doc.feed)) doc.feed = [];
  doc.feedSeq = Number.isInteger(doc.feedSeq) ? doc.feedSeq : 0;
  return doc;
}

function feedEvent(d, t, c, ev) {
  if (!c) return;
  if (typeof d.feedId !== 'string' || !d.feedId) d.feedId = `f${Math.random().toString(36).slice(2, 10)}${Math.floor(t).toString(36)}`;
  d.feedSeq += 1;
  const kept = d.feed.filter((e) => e && t - (Number(e.at) || 0) < FEED_MS);
  kept.push({ seq: d.feedSeq, at: t, clan: c.id, tag: c.tag, name: c.name, ...ev });
  d.feed = kept.slice(-FEED_MAX);
}

const read = (engine) => fix(globalDoc(engine, NS, null));
const write = (engine, fn) => mutateGlobal(engine, NS, (d) => {
  const doc = fix(d);
  doc.rev += 1;
  return fn(doc);
}, blank());
const cfgOf = (engine) => globalConfig(engine, ID);

export function createCost(engine) {
  const n = Number(cfgOf(engine).createCost);
  return Number.isInteger(n) && n >= 0 && n <= CREATE_COST_MAX ? n : CREATE_COST;
}

export function joinModeOf(clan) {
  return clan?.join === 'invite' ? 'invite' : 'open';
}

export function refundOf(clan) {
  const lvl = Math.max(0, Math.min(OLD_CAP_PRICES.length, Math.floor(Number(clan?.cap) || 0)));
  return OLD_CAP_PRICES.slice(0, lvl).reduce((a, b) => a + b, 0);
}

export function migrateUnlimited(engine) {
  if (read(engine).unlimited === true) return { refunded: 0, clans: 0 };
  const t = nowOf(engine);
  return write(engine, (d) => {
    if (d.unlimited === true) return { refunded: 0, clans: 0 };
    let refunded = 0;
    let clans = 0;
    for (const c of Object.values(d.clans)) {
      if (!c || typeof c !== 'object') continue;
      const back = refundOf(c);
      delete c.cap;
      if (back <= 0) continue;
      c.bank = Math.min(Number.MAX_SAFE_INTEGER, (Number(c.bank) || 0) + back);
      c.spent = Math.max(0, (Number(c.spent) || 0) - back);
      c.capRefund = back;
      c.capRefundAt = t;
      refunded += back;
      clans += 1;
    }
    d.unlimited = true;
    return { refunded, clans };
  });
}

function touched(engine, ids) {
  try {
    const sync = profileSync(engine);
    for (const id of ids) sync.markDirty(id);
  } catch (e) {
    engine.log.debug('[clans] marking profiles failed', e?.message);
  }
}

function addMember(d, c, uid, t, via) {
  c.members.push(uid);
  c.joined = c.joined && typeof c.joined === 'object' ? c.joined : {};
  c.joined[uid] = t;
  d.members[uid] = c.id;
  delete d.invites[uid];
  c.log = [...(Array.isArray(c.log) ? c.log : []), { at: t, user: uid, via }].slice(-LOG_MAX);
  feedEvent(d, t, c, { kind: 'joined', user: uid, leader: c.leader, via });
}

const STEMS = ['admin', 'moderator', 'staff', 'yapin', 'yapper', 'yapos', 'official', 'developer'];

function reservedWord(w) {
  if (RESERVED.includes(w)) return true;
  const bare = w.replace(/(?:es|s|z)$/, '');
  return bare !== w && RESERVED.includes(bare);
}

function blocked(text, { owner = false } = {}) {
  const t = String(text ?? '');
  if (!t) return false;
  const words = normalizeName(t).split('-').filter(Boolean);
  const compact = normalizeName(t).replace(/-/g, '');
  if (!owner && [...words, compact].some(reservedWord)) return true;
  if (!owner && STEMS.some((stem) => compact.startsWith(stem) || compact.endsWith(stem))) return true;
  if (!filter) return false;
  try {
    if (filter.findBlocked(t).length) return true;
    return words.some((w) => filter.isBlockedGameWord(w)) || filter.isBlockedGameWord(t.replace(/\s+/g, ''));
  } catch {
    return false;
  }
}

export function checkName(raw, { owner = false } = {}) {
  const name = cleanText(raw);
  if (name.length < NAME_MIN || name.length > NAME_MAX) return { error: `Clan names are ${NAME_MIN} to ${NAME_MAX} characters.` };
  if (!NAME_RE.test(name)) return { error: 'Use letters, numbers, spaces and simple marks like - _ . \' in clan names.' };
  if (blocked(name, { owner })) return { error: "That name isn't allowed. Pick something else." };
  return { value: name };
}

export function checkTag(raw, { owner = false } = {}) {
  const tag = String(raw ?? '').trim().replace(/^\[|\]$/g, '');
  if (!TAG_RE.test(tag)) return { error: 'Tags are 3 or 4 letters or numbers, like `OWL` or `GG42`.' };
  if (blocked(tag, { owner })) return { error: "That tag isn't allowed. Pick something else." };
  return { value: tag.toUpperCase() };
}

export function parseColour(raw) {
  const t = String(raw ?? '').trim().toLowerCase();
  if (COLOURS[t] !== undefined) return COLOURS[t];
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/.exec(t);
  if (!m) return null;
  const hex = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
  return parseInt(hex, 16);
}

const LOOKALIKE = Object.freeze({ '0': 'O', '1': 'I', L: 'I', '5': 'S', '8': 'B' });

export function tagSkeleton(tag) {
  return [...String(tag ?? '').toUpperCase()].map((ch) => LOOKALIKE[ch] || ch).join('');
}

export function tagTaken(doc, tag, exceptId = null) {
  const key = tagSkeleton(tag);
  return Object.values(doc.clans).some((c) => c && c.id !== exceptId && typeof c.tag === 'string' && tagSkeleton(c.tag) === key);
}

const hexOf = (n) => `#${Number(n).toString(16).padStart(6, '0')}`;

function clanOfUser(doc, uid) {
  const id = doc.members[uid];
  const clan = id ? doc.clans[id] : null;
  return clan && Array.isArray(clan.members) && clan.members.includes(uid) ? clan : null;
}

function findClan(doc, query) {
  const q = String(query ?? '').trim().replace(/^\[|\]$/g, '');
  if (!q) return null;
  const list = Object.values(doc.clans);
  return list.find((c) => c.tag.toLowerCase() === q.toLowerCase())
    || list.find((c) => normalizeName(c.name) === normalizeName(q))
    || null;
}

function liveInvites(doc, uid, t) {
  const list = Array.isArray(doc.invites[uid]) ? doc.invites[uid] : [];
  return list.filter((x) => x && doc.clans[x.clan] && t - (Number(x.at) || 0) < INVITE_TTL_MS);
}

function dropMember(doc, clan, uid) {
  clan.members = clan.members.filter((x) => x !== uid);
  if (clan.joined) delete clan.joined[uid];
  if (doc.members[uid] === clan.id) delete doc.members[uid];
  if (!clan.members.length) {
    delete doc.clans[clan.id];
    for (const [who, list] of Object.entries(doc.invites)) {
      const kept = (Array.isArray(list) ? list : []).filter((x) => x?.clan !== clan.id);
      if (kept.length) doc.invites[who] = kept;
      else delete doc.invites[who];
    }
    return { disbanded: true };
  }
  if (clan.leader === uid) {
    const next = [...clan.members].sort((a, b) => (clan.joined?.[a] || 0) - (clan.joined?.[b] || 0))[0];
    clan.leader = next;
    return { newLeader: next };
  }
  return {};
}

function levelsMap(engine) {
  const out = new Map();
  try {
    for (const u of engine.service('levels')?.ranked?.() || []) out.set(u.id, { level: Number(u.level) || 0, xp: Number(u.xp) || 0 });
  } catch (e) {
    engine.log.debug('[clans] reading levels failed', e?.message);
  }
  return out;
}

function seasonMap(engine) {
  const out = new Map();
  try {
    for (const x of engine.service('levels')?.seasonBoard?.()?.list || []) out.set(x.id, Number(x.score) || 0);
  } catch (e) {
    engine.log.debug('[clans] reading the season failed', e?.message);
  }
  return out;
}

export function clanBoard(engine, by = 'level') {
  const doc = read(engine);
  const levels = by === 'season' ? null : levelsMap(engine);
  const season = by === 'season' ? seasonMap(engine) : null;
  return Object.values(doc.clans)
    .map((c) => {
      const score = c.members.reduce((a, uid) => a + (season ? season.get(uid) || 0 : levels.get(uid)?.level || 0), 0);
      return { id: c.id, name: c.name, tag: c.tag, members: c.members.length, score };
    })
    .sort((a, b) => b.score - a.score || b.members - a.members || a.tag.localeCompare(b.tag));
}

function publicClan(engine, uid) {
  const c = clanOfUser(read(engine), uid);
  return c ? { id: c.id, name: c.name, tag: c.tag, colour: Number.isInteger(c.colour) ? hexOf(c.colour) : null, banner: c.banner || null, leader: c.leader === uid, members: c.members.length, join: joinModeOf(c) } : null;
}

export function clanDirectory(engine) {
  const doc = read(engine);
  const t = nowOf(engine);
  const invites = new Map();
  for (const [who, list] of Object.entries(doc.invites)) {
    for (const x of liveInvites(doc, who, t)) {
      if (!invites.has(x.clan)) invites.set(x.clan, []);
      invites.get(x.clan).push({ user: who, by: x.by || null, at: Number(x.at) || 0 });
    }
  }
  return Object.values(doc.clans)
    .filter((c) => c && typeof c.id === 'string' && Array.isArray(c.members) && c.members.length)
    .map((c) => ({
      id: c.id,
      tag: c.tag,
      name: c.name,
      colour: Number.isInteger(c.colour) ? hexOf(c.colour) : null,
      banner: c.banner || null,
      join: joinModeOf(c),
      leader: c.leader,
      created: Number(c.created) || 0,
      count: c.members.length,
      members: [...c.members],
      bank: Math.max(0, Math.floor(Number(c.bank) || 0)),
      style: c.style === true,
      boost: c.boost === true,
      deposits: Object.fromEntries(Object.entries(c.deposits && typeof c.deposits === 'object' ? c.deposits : {}).filter(([, n]) => Number(n) > 0).sort((a, b) => b[1] - a[1]).slice(0, DEPOSITS_SHOWN)),
      invites: (invites.get(c.id) || []).sort((a, b) => b.at - a.at).slice(0, 50),
    }));
}

export function clanFeed(engine) {
  const doc = read(engine);
  return { id: typeof doc.feedId === 'string' ? doc.feedId : null, seq: doc.feedSeq, events: doc.feed.filter((e) => e && Number.isInteger(e.seq)) };
}

export function clanSettings(engine) {
  const cost = createCost(engine);
  return { createCost: cost, stylePrice: STYLE_PRICE, boostPrice: BOOST_PRICE, boost: BOOST, default: cost === CREATE_COST };
}

const label = (c) => `**${c.name}** [${c.tag}]`;

function upgradesText(c) {
  return [
    '👥 Members · no limit',
    `🎨 Colour and banner ${c.style ? '· unlocked' : `· ${shards(STYLE_PRICE)}`}`,
    `⚡ +${Math.round(BOOST * 100)}% XP for every member ${c.boost ? '· unlocked' : `· ${shards(BOOST_PRICE)}`}`,
  ].join('\n');
}

function clanCard(engine, c, viewer) {
  const levels = levelsMap(engine);
  const total = c.members.reduce((a, uid) => a + (levels.get(uid)?.level || 0), 0);
  const board = clanBoard(engine, 'level');
  const pos = board.findIndex((x) => x.id === c.id);
  const memberLines = [...c.members]
    .sort((a, b) => (b === c.leader) - (a === c.leader) || (levels.get(b)?.level || 0) - (levels.get(a)?.level || 0))
    .slice(0, 25)
    .map((uid) => `${uid === c.leader ? '👑' : '•'} <@${uid}> · level ${fmt(levels.get(uid)?.level || 0)}`);
  const fields = [
    { name: 'Members', value: fmt(c.members.length), inline: true },
    { name: 'Joining', value: joinModeOf(c) === 'invite' ? '🔒 Invite only' : `🔓 Open · \`/clan join ${c.tag}\``, inline: true },
    { name: 'Total level', value: fmt(total), inline: true },
    { name: 'Clan rank', value: pos >= 0 ? `#${pos + 1} of ${fmt(board.length)}` : 'not ranked', inline: true },
    { name: 'Clan bank', value: `${shards(c.bank)}\n-# Only for upgrades. It can't be paid out.`, inline: true },
    { name: 'Upgrades', value: upgradesText(c), inline: false },
    { name: 'Roster', value: clip(memberLines.join('\n'), 1024) || 'Nobody', inline: false },
  ];
  const recent = (Array.isArray(c.log) ? c.log : []).filter((x) => x && c.members.includes(x.user)).slice(-RECENT_JOINS).reverse();
  if (recent.length) fields.push({ name: 'Newest members', value: recent.map((x) => `• <@${x.user}>${x.via === 'web' ? ' · joined on the website' : x.via === 'party' ? ' · joined in YapOS Party' : ''}`).join('\n'), inline: false });
  const t = nowOf(engine);
  const refund = Number(c.capRefund) > 0 && t - (Number(c.capRefundAt) || 0) < REFUND_NOTE_MS
    ? `-# Clans have no member limit now, so the ${shards(c.capRefund)} spent on member upgrades went back to the clan bank.`
    : null;
  const body = [c.banner ? `*${c.banner}*` : null, `Founded ${new Date(c.created || 0).toISOString().slice(0, 10)} · one clan across every server`, refund].filter(Boolean).join('\n');
  const mine = viewer && c.members.includes(viewer);
  const lead = viewer && c.leader === viewer;
  const btns = [];
  if (mine) btns.push(button('Deposit', cid('depform', viewer), 'success', CURRENCY.emoji));
  if (lead) btns.push(button('Invite', cid('invform', viewer), 'primary', '✉️'), button('Upgrades', cid('upview', viewer), 'secondary', '⬆️'));
  if (lead) btns.push(joinModeOf(c) === 'invite' ? button('Let anyone join', cid('privacy', viewer, 'open'), 'secondary', '🔓') : button('Make invite only', cid('privacy', viewer, 'invite'), 'secondary', '🔒'));
  if (viewer && !mine && joinModeOf(c) === 'open') btns.push(button(`Join [${c.tag}]`, cid('join', viewer, c.id), 'success', '✅'));
  btns.push(button('Clan top', cid('top', viewer || '-', 'level'), 'secondary', '🏆'));
  if (mine) btns.push(button('Leave', cid('leaveask', viewer), 'danger', '🚪'));
  return {
    embeds: [card({ title: `🛡️ ${c.name} [${c.tag}]`, body, fields, color: Number.isInteger(c.colour) ? c.colour : COLOR })],
    components: [row(btns)],
  };
}

function introCard(engine, uid) {
  const t = nowOf(engine);
  const doc = read(engine);
  const invites = liveInvites(doc, uid, t);
  const cost = createCost(engine);
  const lines = [
    'Team up with as many friends as you like from any server. Clans have a tag, a shared bank and their own leaderboard.',
    '',
    `• **Create one:** \`/clan create Night Owls OWL\` (costs ${shards(cost)})`,
    '• **Join one:** `/clan join OWL` for open clans, or tap a clan tag on a profile. Invite-only clans need an invite from the leader, then `/clan accept`.',
    '• **Clan bank:** members put Shards in, the leader spends them on upgrades. Nobody can take them out.',
  ];
  if (invites.length) {
    lines.push('', `✉️ **Invites waiting:** ${invites.map((x) => label(doc.clans[x.clan])).join(', ')}`);
  }
  const btns = [button('Create a clan', cid('createform', uid), 'primary', '🛡️')];
  for (const inv of invites.slice(0, 3)) btns.push(button(`Join [${doc.clans[inv.clan].tag}]`, cid('accept', uid, inv.clan), 'success', '✅'));
  btns.push(button('Clan top', cid('top', uid, 'level'), 'secondary', '🏆'));
  return { embeds: [card({ title: '🛡️ Clans', body: lines.join('\n'), color: COLOR })], components: [row(btns)] };
}

function hubView(engine, uid) {
  const c = clanOfUser(read(engine), uid);
  return c ? clanCard(engine, c, uid) : introCard(engine, uid);
}

function topView(engine, uid, by = 'level') {
  const sort = by === 'season' ? 'season' : 'level';
  const board = clanBoard(engine, sort);
  const mine = clanOfUser(read(engine), uid);
  const lines = board.slice(0, TOP_SIZE).map((c, i) => `${MEDALS[i] || `**${i + 1}.**`} **${c.name}** [${c.tag}] · ${fmt(c.score)} ${sort === 'season' ? 'XP this month' : 'total levels'} · ${c.members} member${c.members === 1 ? '' : 's'}`);
  const pos = mine ? board.findIndex((x) => x.id === mine.id) : -1;
  const tail = mine ? (pos >= 0 ? `Your clan: **#${pos + 1}** of ${fmt(board.length)}` : '') : 'Not in a clan yet. Start one with `/clan create`.';
  const body = lines.length ? [...lines, '', tail].join('\n') : 'No clans yet. Be the first with `/clan create Name TAG`!';
  const who = uid || '-';
  return {
    embeds: [card({ title: sort === 'season' ? '🏆 Clan top · this season' : '🏆 Clan top · total levels', body, color: COLOR, footer: 'One clan leaderboard for every server' })],
    components: [row(
      button('Total levels', cid('top', who, 'level'), sort === 'level' ? 'primary' : 'secondary', '📈'),
      button('This season', cid('top', who, 'season'), sort === 'season' ? 'primary' : 'secondary', '🗓️'),
    )],
  };
}

function upgradesView(engine, uid) {
  const c = clanOfUser(read(engine), uid);
  if (!c) return null;
  const lead = c.leader === uid;
  const btns = [];
  if (lead && !c.style) btns.push(button(`Colour and banner · ${fmt(STYLE_PRICE)}`, cid('buy', uid, 'style'), c.bank >= STYLE_PRICE ? 'success' : 'secondary', '🎨'));
  if (lead && !c.boost) btns.push(button(`+${Math.round(BOOST * 100)}% XP · ${fmt(BOOST_PRICE)}`, cid('buy', uid, 'boost'), c.bank >= BOOST_PRICE ? 'success' : 'secondary', '⚡'));
  const body = `Clan bank: **${shards(c.bank)}**\n\n${upgradesText(c)}\n\n-# ${lead ? 'Upgrades are paid from the clan bank and last forever.' : 'Only the clan leader can buy upgrades. Help by depositing with `/clan deposit 100`.'}${c.style && lead ? '\n-# Set the look with `/clan colour #ff8800` and `/clan banner Night owls never sleep`.' : ''}`;
  return { embeds: [card({ title: `⬆️ ${c.name} upgrades`, body, color: Number.isInteger(c.colour) ? c.colour : COLOR })], components: btns.length ? [row(btns)] : [] };
}

async function emit(engine, name, ev) {
  try {
    await engine.bot.emit?.(name, ev);
  } catch (e) {
    engine.log.debug(`[clans] ${name} listener failed`, e?.message);
  }
}

const states = new WeakMap();
function busyOf(engine) {
  let s = states.get(engine);
  if (!s) { s = new Set(); states.set(engine, s); }
  return s;
}

async function guarded(engine, uid, fn) {
  const busy = busyOf(engine);
  if (busy.has(uid)) return { busy: true };
  busy.add(uid);
  try { return await fn(); } finally { busy.delete(uid); }
}

function economy(engine) {
  const eco = engine.service('economy');
  return eco && typeof eco.take === 'function' && typeof eco.balance === 'function' ? eco : null;
}

async function createClan(ctx, nameRaw, tagRaw) {
  const { engine } = ctx;
  const uid = ctx.userId;
  const owner = typeof engine.isBotOwner === 'function' && engine.isBotOwner(uid);
  const name = checkName(nameRaw, { owner });
  if (name.error) return ctx.warn("That name didn't work", `${name.error}\nTry \`/clan create Night Owls OWL\`.`);
  const tag = checkTag(tagRaw, { owner });
  if (tag.error) return ctx.warn("That tag didn't work", `${tag.error}\nTry \`/clan create Night Owls OWL\`.`);
  const res = await guarded(engine, uid, async () => {
    const doc = read(engine);
    if (clanOfUser(doc, uid)) return { problem: ['You already have a clan', 'Leave your clan first with `/clan leave`. You can only be in one clan at a time.'] };
    if (Object.keys(doc.clans).length >= MAX_CLANS) return { problem: ['No room for new clans', 'There are as many clans as YapOS can hold right now. Join one instead!'] };
    if (findClan(doc, tag.value) || tagTaken(doc, tag.value)) return { problem: ['That tag is taken', `Another clan already uses **[${tag.value}]** or a tag that looks just like it. Pick another tag.`] };
    if (Object.values(doc.clans).some((c) => normalizeName(c.name) === normalizeName(name.value))) return { problem: ['That name is taken', `There is already a clan called **${name.value}**. Pick another name.`] };
    const cost = createCost(engine);
    const eco = economy(engine);
    if (cost > 0) {
      if (!eco) return { problem: ["I can't take Shards right now", `The Economy app isn't running, so a clan can't be paid for. Try again later.`] };
      const have = eco.balance(GLOBAL_KEY, uid);
      if (have < cost) return { problem: [`Not enough ${CURRENCY.name}`, `A clan costs ${shards(cost)} and you have ${shards(have)}. Earn more with /daily, quests and YapOS Party.`] };
      const left = eco.take(GLOBAL_KEY, uid, cost, `Founded clan [${tag.value}]`);
      if (left === null || left === undefined) return { problem: [`Not enough ${CURRENCY.name}`, `A clan costs ${shards(cost)}.`] };
    }
    const t = nowOf(engine);
    const made = write(engine, (d) => {
      if (clanOfUser(d, uid) || tagTaken(d, tag.value) || Object.values(d.clans).some((c) => normalizeName(c.name) === normalizeName(name.value))) return null;
      d.seq += 1;
      const id = `c${d.seq}`;
      d.clans[id] = { id, name: name.value, tag: tag.value, leader: uid, members: [uid], joined: { [uid]: t }, bank: 0, spent: 0, style: false, boost: false, colour: null, banner: null, created: t };
      d.members[uid] = id;
      delete d.invites[uid];
      return d.clans[id];
    });
    if (!made) {
      if (cost > 0) {
        try { await eco.add(GLOBAL_KEY, uid, cost, `Clan refund [${tag.value}]`); } catch (e) { engine.log.warn(`[clans] couldn't refund a clan that failed to start: ${e?.message}`); }
      }
      return { problem: ['That name or tag was just taken', 'Someone grabbed it a moment ago. Your Shards were given back.'] };
    }
    return { clan: made, cost };
  });
  if (res.busy) return ctx.info('One moment', 'Your last clan action is still going through.');
  if (res.problem) return ctx.warn(...res.problem);
  await emit(engine, 'clan:founded', { user: uid, clan: res.clan.id, server_id: null });
  return ctx.reply({ embeds: [card({ title: `🛡️ ${res.clan.name} [${res.clan.tag}] is founded!`, body: `<@${uid}> leads a brand new clan${res.cost ? ` (paid ${shards(res.cost)})` : ''}.\nInvite friends with \`/clan invite @name\` or their user id (it goes to their DMs) and grow the bank with \`/clan deposit 100\`.`, color: COLOR, footer: false })] });
}

function within(fn, ms, fallback) {
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
    timer.unref?.();
  });
  return Promise.race([Promise.resolve().then(fn), late]).finally(() => clearTimeout(timer));
}

async function resolveInvitee(ctx, q) {
  const { engine } = ctx;
  const me = engine.bot.me?.id;
  const raw = idOf(q.replace(/^@(?=[0-9a-f]{8}-)/i, ''));
  const id = raw && ID_RE.test(raw) ? raw.toLowerCase() : null;
  let member = null;
  if (ctx.serverId) {
    member = await ctx.findUser(q).catch(() => null);
    if (member?.id && member.username) return { id: member.id, bot: !!member.bot };
  }
  const want = id || (member?.id ? String(member.id).toLowerCase() : null);
  if (!want) return { problem: ctx.serverId ? 'nobody' : 'needId' };
  const self = String(ctx.userId).toLowerCase();
  const bot = String(me ?? '').toLowerCase();
  if (want === self || want === bot) return { id: want === self ? ctx.userId : me, bot: want === bot };
  if (typeof engine.bot.user !== 'function') return { id: want };
  const u = await within(() => engine.bot.user(want), LOOKUP_MS, 'late').catch((e) => (e?.status === 404 || e?.status === 400 ? null : 'late'));
  if (u === 'late') return { id: want };
  if (!u || typeof u !== 'object') return { problem: 'unknown' };
  return { id: u.id ? String(u.id).toLowerCase() : want, bot: !!(u.bot || u.is_bot) };
}

function inviteMessage(c, from, to, note = '') {
  const lines = [
    `<@${from}> invited you to join ${label(c)}.`,
    c.banner ? `*${c.banner}*` : null,
    `👥 ${fmt(c.members.length)} member${c.members.length === 1 ? '' : 's'} · one clan across every server`,
    '',
    `Press **Join** below, or type \`/clan accept ${c.tag}\` within 7 days.`,
    note ? `-# ${note}` : null,
  ].filter((x) => x !== null);
  return {
    embeds: [card({ title: '✉️ Clan invite', body: lines.join('\n'), color: Number.isInteger(c.colour) ? c.colour : COLOR, footer: false })],
    components: [row(button(`Join [${c.tag}]`, cid('accept', to, c.id), 'success', '✅'), button('No thanks', cid('decline', to, c.id), 'secondary'))],
  };
}

function unmarkDm(engine, target, clanId) {
  write(engine, (d) => {
    const inv = (Array.isArray(d.invites[target]) ? d.invites[target] : []).find((x) => x?.clan === clanId);
    if (inv) delete inv.dmAt;
  });
}

function pruneTimes(map, t, ms) {
  for (const [k, v] of Object.entries(map)) {
    const kept = (Array.isArray(v) ? v : []).filter((x) => t - x < ms);
    if (kept.length) map[k] = kept;
    else delete map[k];
  }
}

async function dmInvite(ctx, target, clanId, payload) {
  const { engine } = ctx;
  const sid = ctx.serverId;
  if (engine.caps.state(sid, 'dms') === false || typeof engine.bot.dm !== 'function') return 'failed';
  try {
    const channel = await within(() => engine.bot.dm(target), DM_MS, null);
    if (!channel) return 'failed';
    const job = engine.budget.send({ serverId: null, channelId: channel, content: '', opts: { embeds: payload.embeds, components: payload.components }, priority: 'normal', key: `clans:invite:${target}:${clanId}` });
    const out = await within(() => job, SEND_MS, 'queued');
    if (out === 'queued') {
      job.catch((e) => {
        engine.log.info('[clans] a queued clan invite DM did not go through', e?.message);
        unmarkDm(engine, target, clanId);
      });
      return 'queued';
    }
    if (engine.caps.state(sid, 'dms') !== true) engine.caps.mark(sid, 'dms', true);
    return 'sent';
  } catch (e) {
    if (looksLikeFeatureOff(e)) engine.caps.mark(sid, 'dms', false, e?.message);
    engine.log.debug('[clans] could not DM an invite (DMs may be closed)', e?.message);
    return 'failed';
  }
}

async function inviteUser(ctx, query) {
  const { engine } = ctx;
  const uid = ctx.userId;
  const doc = read(engine);
  const c = clanOfUser(doc, uid);
  if (!c) return ctx.warn('No clan yet', 'Create one first with `/clan create Name TAG`.');
  if (c.leader !== uid) return ctx.warn('Only the leader can invite', `Ask <@${c.leader}> to send the invite.`);
  const q = String(query ?? '').trim();
  if (!q) return ctx.warn('Invite who?', "Try `/clan invite @sam`, or use their Yapin' user id. The invite goes to their DMs.");
  const who = await resolveInvitee(ctx, q);
  if (who.problem === 'needId') return ctx.warn('Use their user id here', "I can't search names in DMs. Use their Yapin' user id or a mention, like `/clan invite 1a2b3c4d-...`. Names work when you run it in a server.");
  if (who.problem === 'nobody') return ctx.warn("I couldn't find them", `Nobody here matches **${clip(cleanText(q), 40) || 'that'}**. Try a mention like \`/clan invite @sam\`, or their Yapin' user id.`);
  if (who.problem === 'unknown') return ctx.warn('No account found', "No Yapin' account has that id. Check it and try again.");
  if (who.id === uid) return ctx.info("That's you", 'You are already in your clan!');
  if (who.id === engine.bot.me?.id || who.bot) return ctx.warn("Bots can't join clans", 'Invite a person instead.');
  const t = nowOf(engine);
  const res = write(engine, (d) => {
    const theirs = clanOfUser(d, who.id);
    if (theirs) return { inClan: theirs.id === c.id ? 'yours' : 'other' };
    for (const [k, v] of Object.entries(d.declined)) {
      const kept = Object.fromEntries(Object.entries(v && typeof v === 'object' ? v : {}).filter(([, at]) => t - at < DECLINE_MS));
      if (Object.keys(kept).length) d.declined[k] = kept;
      else delete d.declined[k];
    }
    if (d.declined[who.id]?.[c.id]) return { declined: true };
    const live = liveInvites(d, who.id, t);
    const prev = live.find((x) => x.clan === c.id);
    const list = live.filter((x) => x.clan !== c.id);
    if (prev && t - (Number(prev.dmAt) || 0) < REINVITE_MS) {
      list.push({ ...prev, by: uid, at: t });
      d.invites[who.id] = list.slice(-MAX_INVITES);
      return { repeat: true };
    }
    pruneTimes(d.outbox, t, INVITE_WINDOW_MS);
    pruneTimes(d.inbox, t, REINVITE_MS);
    const sent = d.outbox[uid] || [];
    if (sent.length >= INVITE_RATE) return { limited: sent[0] + INVITE_WINDOW_MS - t };
    const got = d.inbox[who.id] || [];
    if (got.length >= TARGET_DM_CAP) {
      list.push({ ...(prev || {}), clan: c.id, by: uid, at: t });
      d.invites[who.id] = list.slice(-MAX_INVITES);
      if (prev) return { quiet: true };
      d.outbox[uid] = [...sent, t];
      feedEvent(d, t, d.clans[c.id], { kind: 'invite', user: who.id, by: uid });
      return { quiet: true };
    }
    d.outbox[uid] = [...sent, t];
    d.inbox[who.id] = [...got, t];
    list.push({ clan: c.id, by: uid, at: t, dmAt: t });
    d.invites[who.id] = list.slice(-MAX_INVITES);
    feedEvent(d, t, d.clans[c.id], { kind: 'invite', user: who.id, by: uid });
    return { ok: true };
  });
  if (res.inClan === 'yours') return ctx.info('Already in', `<@${who.id}> is already in ${label(c)}.`);
  if (res.inClan) return ctx.warn('They have a clan', `<@${who.id}> is already in another clan. They need to leave it first.`);
  if (res.limited !== undefined) {
    const mins = Math.max(1, Math.ceil(res.limited / 60_000));
    return ctx.warn('Slow down a little', `Leaders can send ${INVITE_RATE} clan invites an hour. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`);
  }
  if (res.declined) return ctx.info('They said no thanks', `<@${who.id}> turned down an invite to ${label(c)} this week, so I won't send another one yet.`);
  if (res.quiet) return ctx.info('Invite saved', `<@${who.id}> has had a lot of clan invites today, so I saved yours without a DM. It lasts 7 days, and they can join with \`/clan accept ${c.tag}\`.`);
  if (res.repeat) return ctx.info('Already invited', `<@${who.id}> got an invite to ${label(c)} in the last 24 hours, so I didn't DM them again. Their invite now lasts 7 more days, and they can join with \`/clan accept ${c.tag}\`.`);
  const how = await dmInvite(ctx, who.id, c.id, inviteMessage(c, uid, who.id));
  if (how === 'sent') return ctx.ok('Invite sent', `Sent your invite to <@${who.id}> in their DMs.`);
  if (how === 'queued') return ctx.ok('Invite on its way', `Your invite to <@${who.id}> is queued and will reach their DMs shortly.`);
  if (ctx.serverId) return ctx.reply({ content: `<@${who.id}>`, ...inviteMessage(c, uid, who.id, "I couldn't DM you, so here it is."), open: true });
  unmarkDm(engine, who.id, c.id);
  return ctx.warn('Their DMs are closed', `I couldn't DM <@${who.id}>. The invite is saved for 7 days, so they can join with \`/clan accept ${c.tag}\`. Or run \`/clan invite\` in a server you share and I'll post it there.`);
}

async function acceptInvite(ctx, which, how = 'reply') {
  const { engine } = ctx;
  const uid = ctx.userId;
  const t = nowOf(engine);
  const doc = read(engine);
  const invites = liveInvites(doc, uid, t);
  let pick = null;
  if (which && doc.clans[which]) pick = invites.find((x) => x.clan === which);
  else if (which) {
    const c = findClan(doc, which);
    pick = c ? invites.find((x) => x.clan === c.id) : null;
  } else if (invites.length === 1) pick = invites[0];
  const say = (title, body) => (how === 'update' ? ctx.update({ content: '', embeds: [dialog.warn(title, body)], components: [] }) : ctx.warn(title, body));
  if (clanOfUser(doc, uid)) return say('You already have a clan', 'Leave it first with `/clan leave`, then accept.');
  if (which && /^c\d+$/.test(which) && !doc.clans[which]) return say('That clan is gone', 'It was closed after the invite was sent.');
  if (which && doc.clans[which] && !pick) return say('That invite ran out', `Invites last 7 days. Ask <@${doc.clans[which].leader}> for a new one.`);
  if (!invites.length) return say('No invites', 'Nobody has invited you yet, or the invite is older than 7 days.');
  if (!pick) return say('Which clan?', `You have invites from ${invites.map((x) => label(doc.clans[x.clan])).join(', ')}. Try \`/clan accept ${doc.clans[invites[0].clan].tag}\`.`);
  const res = write(engine, (d) => {
    if (clanOfUser(d, uid)) return { problem: 'inClan' };
    const c = d.clans[pick.clan];
    if (!c) return { problem: 'gone' };
    if (!liveInvites(d, uid, t).some((x) => x.clan === c.id)) return { problem: 'expired', c };
    addMember(d, c, uid, t, 'invite');
    return { c };
  });
  if (res.problem === 'inClan') return say('You already have a clan', 'Leave it first with `/clan leave`.');
  if (res.problem === 'gone') return say('That clan is gone', 'It was disbanded after the invite was sent.');
  if (res.problem === 'expired') return say('That invite ran out', `Ask <@${res.c.leader}> for a new one.`);
  await emit(engine, 'clan:joined', { user: uid, clan: res.c.id, server_id: null });
  touched(engine, [uid]);
  const embed = welcomeEmbed(res.c, uid);
  return how === 'update' ? ctx.update({ content: '', embeds: [embed], components: [] }) : ctx.reply({ embeds: [embed] });
}

function welcomeEmbed(c, uid) {
  const n = c.members.length;
  return card({ title: `🛡️ Welcome to ${c.name} [${c.tag}]!`, body: `<@${uid}> joined the clan. ${fmt(n)} member${n === 1 ? '' : 's'} now.`, color: Number.isInteger(c.colour) ? c.colour : COLOR, footer: false });
}

function joinDirect(engine, uid, clanId, via) {
  const t = nowOf(engine);
  return write(engine, (d) => {
    const c = d.clans[clanId];
    if (!c || !Array.isArray(c.members) || !c.members.length) return { problem: 'gone' };
    const mine = clanOfUser(d, uid);
    if (mine) return mine.id === c.id ? { problem: 'already', c: { ...c } } : { problem: 'inClan', c: { ...c }, other: { name: mine.name, tag: mine.tag } };
    const invited = liveInvites(d, uid, t).some((x) => x.clan === c.id);
    if (joinModeOf(c) === 'invite' && !invited) return { problem: 'invite', c: { ...c } };
    addMember(d, c, uid, t, via);
    return { c: { ...c, members: [...c.members] } };
  });
}

function pickClan(doc, q) {
  const text = String(q ?? '').trim();
  if (/^c\d+$/.test(text) && doc.clans[text]) return doc.clans[text];
  return findClan(doc, text);
}

async function joinOpen(ctx, query, how = 'reply') {
  const { engine } = ctx;
  const uid = ctx.userId;
  const q = String(query ?? '').trim();
  if (!q) return acceptInvite(ctx, '', how);
  const doc = read(engine);
  const c = pickClan(doc, q);
  const say = (kind, title, body) => (how === 'update' ? ctx.update({ content: '', embeds: [dialog[kind](title, body)], components: [] }) : ctx[kind](title, body));
  if (!c) {
    const guess = didYouMean(q.replace(/^\[|\]$/g, ''), Object.values(doc.clans).map((x) => x.tag));
    return say('warn', 'No clan by that name', `I couldn't find **${clip(cleanText(q), 30) || 'that'}**.${guess.length ? ` Did you mean ${guess.map((g) => `**[${g}]**`).join(', ')}?` : ''}`);
  }
  if (uid === engine.bot.me?.id) return say('warn', "Bots can't join clans", 'Clans are for people.');
  const res = joinDirect(engine, uid, c.id, 'command');
  if (res.problem === 'gone') return say('warn', 'That clan is gone', 'It was closed a moment ago.');
  if (res.problem === 'already') return say('info', 'Already in', `You're already in ${label(res.c)}.`);
  if (res.problem === 'inClan') return say('warn', 'You already have a clan', `You're in **${res.other.name}** [${res.other.tag}]. Leave it first with \`/clan leave\`. You can only be in one clan at a time.`);
  if (res.problem === 'invite') return say('warn', 'This clan is invite only', `${label(res.c)} only takes people the leader invites. Ask <@${res.c.leader}> for an invite.`);
  await emit(engine, 'clan:joined', { user: uid, clan: res.c.id, server_id: null });
  touched(engine, [uid]);
  const embed = welcomeEmbed(res.c, uid);
  return how === 'update' ? ctx.update({ content: '', embeds: [embed], components: [] }) : ctx.reply({ embeds: [embed] });
}

export async function webJoin(engine, user, clanId, tag, via = 'web') {
  const uid = typeof user === 'string' ? user.trim() : '';
  if (!WEB_USER_RE.test(uid)) return { ok: false, code: 'failed', message: "That doesn't look like a real account." };
  if (uid.toLowerCase() === String(engine.bot.me?.id ?? '').toLowerCase()) return { ok: false, code: 'bot', message: "Bots can't join clans." };
  const doc = read(engine);
  const lowered = uid.toLowerCase();
  const who = doc.members[uid] ? uid : doc.members[lowered] ? lowered : Object.keys(doc.members).find((k) => k.toLowerCase() === lowered) || uid;
  const byId = typeof clanId === 'string' && clanId ? doc.clans[clanId] || null : null;
  const c = typeof clanId === 'string' && clanId ? byId : findClan(doc, tag);
  if (!c) return { ok: false, code: 'gone', message: 'That clan is gone. It may have closed.' };
  const res = joinDirect(engine, who, c.id, via === 'party' ? 'party' : 'web');
  if (res.problem === 'gone') return { ok: false, code: 'gone', message: 'That clan is gone. It may have closed.' };
  if (res.problem === 'already') return { ok: true, code: 'already', message: `You're already in [${res.c.tag}] ${res.c.name}.`, clan: { tag: res.c.tag, name: res.c.name } };
  if (res.problem === 'inClan') return { ok: false, code: 'in_clan', message: `You're in [${res.other.tag}] ${res.other.name}. Leave it first with /clan leave.` };
  if (res.problem === 'invite') return { ok: false, code: 'invite_only', message: `[${res.c.tag}] ${res.c.name} is invite only now. Ask the leader for an invite.` };
  await emit(engine, 'clan:joined', { user: who, clan: res.c.id, server_id: null });
  touched(engine, [who]);
  return { ok: true, code: 'joined', message: `You joined [${res.c.tag}] ${res.c.name}!`, clan: { tag: res.c.tag, name: res.c.name } };
}

const PRIVACY_WORDS = Object.freeze({
  open: 'open', public: 'open', unlock: 'open', unlocked: 'open', anyone: 'open', everyone: 'open', on: 'open',
  invite: 'invite', 'invite-only': 'invite', inviteonly: 'invite', invites: 'invite', private: 'invite', lock: 'invite', locked: 'invite', closed: 'invite', off: 'invite',
});

async function setJoinMode(ctx, word, how = 'reply') {
  const { engine } = ctx;
  const uid = ctx.userId;
  const c = clanOfUser(read(engine), uid);
  const say = (kind, title, body) => (how === 'update' ? ctx.update({ embeds: [dialog[kind](title, body)], components: [] }) : ctx[kind](title, body));
  if (!c) return say('warn', 'No clan yet', 'You are not in a clan.');
  if (c.leader !== uid) return say('warn', 'Only the leader can do that', `<@${c.leader}> leads ${label(c)} and decides who can join.`);
  const w = String(word ?? '').trim().toLowerCase();
  if (!w) {
    const now = joinModeOf(c);
    return ctx.panel({
      embeds: [dialog.info('Who can join?', now === 'invite' ? `${label(c)} is **invite only**. People need an invite from you to join.` : `${label(c)} is **open**. Anyone can join with \`/clan join ${c.tag}\` or by tapping your tag on a profile.`)],
      components: [row(now === 'invite' ? button('Let anyone join', cid('privacy', uid, 'open'), 'primary', '🔓') : button('Make invite only', cid('privacy', uid, 'invite'), 'primary', '🔒'))],
    });
  }
  const mode = PRIVACY_WORDS[w];
  if (!mode) return say('warn', "I didn't get that", 'Use `/clan privacy open` to let anyone join, or `/clan privacy invite` for invite only.');
  const ok = write(engine, (d) => {
    const cur = d.clans[c.id];
    if (!cur || cur.leader !== uid) return false;
    if (mode === 'open') delete cur.join;
    else cur.join = 'invite';
    return true;
  });
  if (!ok) return say('warn', 'That changed', 'The clan changed a moment ago. Try again.');
  return mode === 'open'
    ? say('ok', 'Anyone can join now', `${label(c)} is open. People can join with \`/clan join ${c.tag}\` or by tapping your tag on a profile. Invites still work too.`)
    : say('ok', 'Invite only now', `${label(c)} only takes people you invite with \`/clan invite @name\`. Invites you already sent still work.`);
}

async function declineInvite(ctx, which, how = 'reply') {
  const { engine } = ctx;
  const uid = ctx.userId;
  const doc = read(engine);
  const c = which ? doc.clans[which] || findClan(doc, which) : null;
  write(engine, (d) => {
    const list = Array.isArray(d.invites[uid]) ? d.invites[uid] : [];
    const kept = c ? list.filter((x) => x?.clan !== c.id) : [];
    const said = d.declined[uid] && typeof d.declined[uid] === 'object' ? d.declined[uid] : {};
    const t = nowOf(engine);
    for (const x of c ? [{ clan: c.id }] : list) {
      if (!x?.clan) continue;
      said[x.clan] = t;
      const was = list.some((y) => y?.clan === x.clan);
      if (was && d.clans[x.clan]) feedEvent(d, t, d.clans[x.clan], { kind: 'declined', user: uid, leader: d.clans[x.clan].leader });
    }
    if (Object.keys(said).length) d.declined[uid] = said;
    if (kept.length) d.invites[uid] = kept;
    else delete d.invites[uid];
  });
  const embed = dialog.info('Invite declined', c ? `No problem. You won't join ${label(c)}.` : 'All your clan invites are cleared.');
  return how === 'update' ? ctx.update({ content: '', embeds: [embed], components: [] }) : ctx.ephemeral({ embeds: [embed] });
}

async function leaveClan(ctx, how = 'reply') {
  const { engine } = ctx;
  const uid = ctx.userId;
  const res = write(engine, (d) => {
    const c = clanOfUser(d, uid);
    if (!c) return null;
    const info = { name: c.name, tag: c.tag, bank: c.bank };
    const snap = { id: c.id, tag: c.tag, name: c.name };
    const wasLeader = c.leader === uid;
    const out = { ...info, ...dropMember(d, c, uid) };
    if (!out.disbanded) feedEvent(d, nowOf(engine), snap, { kind: 'left', user: uid, leader: wasLeader ? null : d.clans[snap.id]?.leader || null, next: out.newLeader || null });
    return out;
  });
  if (res) touched(engine, [uid]);
  const out = (embed) => (how === 'update' ? ctx.update({ embeds: [embed], components: [] }) : ctx.ephemeral({ embeds: [embed] }));
  if (!res) return out(dialog.info('Not in a clan', 'You are not in a clan right now.'));
  if (res.disbanded) return out(dialog.ok('Clan closed', `You were the last one in **${res.name}** [${res.tag}], so it is closed now.${res.bank ? ` Its bank of ${shards(res.bank)} closed with it.` : ''}`));
  return out(dialog.ok('You left the clan', `You are no longer in **${res.name}** [${res.tag}].${res.newLeader ? ` <@${res.newLeader}> leads it now.` : ''}`));
}

async function leaderAction(ctx, query, kind) {
  const { engine } = ctx;
  const uid = ctx.userId;
  const doc = read(engine);
  const c = clanOfUser(doc, uid);
  if (!c) return ctx.warn('No clan yet', 'You are not in a clan.');
  if (c.leader !== uid) return ctx.warn('Only the leader can do that', `<@${c.leader}> leads ${label(c)}.`);
  const q = String(query ?? '').trim();
  if (!q) return ctx.warn(kind === 'kick' ? 'Kick who?' : 'Who should lead?', `Try \`/clan ${kind} @sam\`.`);
  let target = null;
  const found = ctx.serverId ? await ctx.findUser(q).catch(() => null) : null;
  if (found?.id && c.members.includes(found.id)) target = found.id;
  if (!target) {
    const raw = q.replace(/^<@!?|>$/g, '');
    if (c.members.includes(raw)) target = raw;
  }
  if (!target) return ctx.warn('Not in your clan', `I couldn't find **${clip(cleanText(q), 40) || 'them'}** in ${label(c)}.`);
  if (target === uid) return ctx.info("That's you", kind === 'kick' ? 'To go, use `/clan leave`.' : 'You already lead the clan.');
  const ok = write(engine, (d) => {
    const cur = d.clans[c.id];
    if (!cur || cur.leader !== uid || !cur.members.includes(target)) return false;
    if (kind === 'kick') dropMember(d, cur, target);
    else cur.leader = target;
    feedEvent(d, nowOf(engine), cur, { kind: kind === 'kick' ? 'kicked' : 'leader', user: target, by: uid });
    return true;
  });
  if (!ok) return ctx.warn('That changed', 'The clan changed a moment ago. Try again.');
  if (kind === 'kick') touched(engine, [target]);
  if (kind === 'kick') return ctx.ok('Removed', `<@${target}> is no longer in ${label(c)}.`);
  return ctx.ok('New leader', `<@${target}> leads ${label(c)} now. You stay in as a member.`);
}

async function setLook(ctx, field, raw) {
  const { engine } = ctx;
  const uid = ctx.userId;
  const c = clanOfUser(read(engine), uid);
  if (!c) return ctx.warn('No clan yet', 'You are not in a clan.');
  if (c.leader !== uid) return ctx.warn('Only the leader can do that', `<@${c.leader}> leads ${label(c)}.`);
  let patch;
  let done;
  if (field === 'tag') {
    const tag = checkTag(raw, { owner: typeof engine.isBotOwner === 'function' && engine.isBotOwner(uid) });
    if (tag.error) return ctx.warn("That tag didn't work", tag.error);
    if (tagTaken(read(engine), tag.value, c.id)) return ctx.warn('That tag is taken', `Another clan already uses **[${tag.value}]** or a tag that looks just like it.`);
    patch = { tag: tag.value };
    done = `Your clan tag is **[${tag.value}]** now.`;
  } else {
    if (!c.style) return ctx.warn('Unlock it first', `Clan colours and banners are an upgrade (${shards(STYLE_PRICE)} from the clan bank). Open \`/clan upgrade\`.`);
    if (field === 'colour') {
      const n = parseColour(raw);
      if (n === null) return ctx.warn("That colour didn't work", `Use a hex code like \`#ff8800\` or a name: ${Object.keys(COLOURS).filter((k) => k !== 'gray').join(', ')}.`);
      patch = { colour: n };
      done = `Your clan colour is **${hexOf(n)}** now.`;
    } else {
      const text = clip(cleanText(raw), BANNER_MAX);
      if (!text) {
        patch = { banner: null };
        done = 'The banner is cleared.';
      } else {
        if (blocked(text, { owner: typeof engine.isBotOwner === 'function' && engine.isBotOwner(uid) })) return ctx.warn("That banner isn't allowed", 'Pick different words.');
        patch = { banner: text };
        done = `Your banner reads: *${text}*`;
      }
    }
  }
  const ok = write(engine, (d) => {
    const cur = d.clans[c.id];
    if (!cur || cur.leader !== uid) return false;
    if (patch.tag && tagTaken(d, patch.tag, c.id)) return false;
    Object.assign(cur, patch);
    return true;
  });
  if (!ok) return ctx.warn('That changed', 'The clan changed a moment ago. Try again.');
  return ctx.ok('Saved', done);
}

function parseDeposit(text) {
  const t = String(text ?? '').trim().toLowerCase().replace(/,/g, '');
  const m = /^(\d+(?:\.\d+)?)([km]?)$/.exec(t);
  if (!m) return null;
  const n = Math.floor(Number(m[1]) * (m[2] === 'k' ? 1e3 : m[2] === 'm' ? 1e6 : 1));
  return Number.isInteger(n) && n > 0 && n <= DEPOSIT_MAX ? n : null;
}

async function deposit(ctx, amountText) {
  const { engine } = ctx;
  const uid = ctx.userId;
  const c = clanOfUser(read(engine), uid);
  if (!c) return ctx.warn('No clan yet', 'Join or create a clan first.');
  const n = parseDeposit(amountText);
  if (n === null) return ctx.warn("That amount didn't work", 'Use a whole number of Shards, like `/clan deposit 100` or `/clan deposit 2k`.');
  const eco = economy(engine);
  if (!eco) return ctx.warn("I can't take Shards right now", "The Economy app isn't running. Try again later.");
  const res = await guarded(engine, uid, async () => {
    const have = eco.balance(GLOBAL_KEY, uid);
    if (have < n) return { short: have };
    const left = eco.take(GLOBAL_KEY, uid, n, `Clan bank [${c.tag}]`);
    if (left === null || left === undefined) return { short: eco.balance(GLOBAL_KEY, uid) };
    const bank = write(engine, (d) => {
      const cur = clanOfUser(d, uid);
      if (!cur) return null;
      cur.bank = Math.min(Number.MAX_SAFE_INTEGER, (Number(cur.bank) || 0) + n);
      cur.deposits = cur.deposits && typeof cur.deposits === 'object' ? cur.deposits : {};
      cur.deposits[uid] = (Number(cur.deposits[uid]) || 0) + n;
      return cur.bank;
    });
    if (bank === null) {
      try { await eco.add(GLOBAL_KEY, uid, n, 'Clan bank refund'); } catch (e) { engine.log.warn(`[clans] couldn't refund a deposit: ${e?.message}`); }
      return { gone: true };
    }
    return { bank, left };
  });
  if (res.busy) return ctx.info('One moment', 'Your last clan action is still going through.');
  if (res.gone) return ctx.warn('Your clan changed', 'You left the clan a moment ago, so your Shards were given back.');
  if (res.short !== undefined) return ctx.warn(`Not enough ${CURRENCY.name}`, `You have ${shards(res.short)} and tried to put in ${shards(n)}.`);
  return ctx.reply({ embeds: [card({ title: `${CURRENCY.emoji} +${fmt(n)} to the ${c.name} bank`, body: `<@${uid}> chipped in. The bank holds **${shards(res.bank)}** for upgrades.\n-# Clan bank Shards can only buy upgrades. They can't be paid out to anyone.`, color: Number.isInteger(c.colour) ? c.colour : COLOR, footer: false })] });
}

const UPGRADE_WORDS = { members: 'members', member: 'members', cap: 'members', size: 'members', slots: 'members', style: 'style', colour: 'style', color: 'style', banner: 'style', look: 'style', boost: 'boost', xp: 'boost' };

async function buyUpgrade(ctx, word, how = 'reply') {
  const { engine } = ctx;
  const uid = ctx.userId;
  const kind = UPGRADE_WORDS[String(word || '').toLowerCase()];
  const c = clanOfUser(read(engine), uid);
  if (!c) return ctx.warn('No clan yet', 'You are not in a clan.');
  if (!kind) return ctx.panel(upgradesView(engine, uid));
  if (kind === 'members') return ctx.info('No member limit', `Clans can have as many members as they like now, so there's nothing to buy. ${label(c)} has room for everyone.`);
  if (c.leader !== uid) return ctx.warn('Only the leader can buy upgrades', `<@${c.leader}> leads ${label(c)}. Help by depositing with \`/clan deposit 100\`.`);
  const res = write(engine, (d) => {
    const cur = clanOfUser(d, uid);
    if (!cur || cur.leader !== uid) return { problem: 'changed' };
    let cost;
    if (kind === 'style') {
      if (cur.style) return { problem: 'owned' };
      cost = STYLE_PRICE;
    } else {
      if (cur.boost) return { problem: 'owned' };
      cost = BOOST_PRICE;
    }
    if ((Number(cur.bank) || 0) < cost) return { problem: 'short', cost, bank: Number(cur.bank) || 0 };
    cur.bank -= cost;
    cur.spent = (Number(cur.spent) || 0) + cost;
    cur[kind] = true;
    return { cost, clan: { ...cur } };
  });
  if (res.problem === 'changed') return ctx.warn('That changed', 'The clan changed a moment ago. Try again.');
  if (res.problem === 'owned') return ctx.info('Already unlocked', 'Your clan already has that upgrade.');
  if (res.problem === 'short') return ctx.warn('Not enough in the bank', `That upgrade costs ${shards(res.cost)} and the clan bank has ${shards(res.bank)}. Members can add more with \`/clan deposit 100\`.`);
  const what = kind === 'style' ? 'a **custom colour and banner** (`/clan colour`, `/clan banner`)' : `**+${Math.round(BOOST * 100)}% XP** for every member`;
  const embed = card({ title: '⬆️ Upgrade bought!', body: `${label(res.clan)} now has ${what}.\nPaid ${shards(res.cost)} from the clan bank · ${shards(res.clan.bank)} left.`, color: Number.isInteger(res.clan.colour) ? res.clan.colour : COLOR, footer: false });
  return how === 'update' ? ctx.update({ embeds: [embed], components: [] }) : ctx.reply({ embeds: [embed] });
}

async function disbandAsk(ctx) {
  const uid = ctx.userId;
  const c = clanOfUser(read(ctx.engine), uid);
  if (!c) return ctx.warn('No clan yet', 'You are not in a clan.');
  if (c.leader !== uid) return ctx.warn('Only the leader can do that', `<@${c.leader}> leads ${label(c)}.`);
  return ctx.panel({
    embeds: [dialog.warn('Close the clan?', `This removes ${label(c)} for all ${c.members.length} member${c.members.length === 1 ? '' : 's'}.${c.bank ? ` The bank of ${shards(c.bank)} is lost: it can't be paid out.` : ''} This can't be undone.`)],
    components: [row(button('Close the clan', cid('disband', uid, c.id), 'danger', '🗑️'), button('Keep it', cid('cancel', uid), 'secondary'))],
  });
}

async function disband(ctx, clanId) {
  const uid = ctx.userId;
  const res = write(ctx.engine, (d) => {
    const c = d.clans[clanId];
    if (!c || c.leader !== uid) return null;
    const gone = [...c.members];
    feedEvent(d, nowOf(ctx.engine), c, { kind: 'disbanded', by: uid, members: gone.slice(0, 200) });
    for (const m of gone) if (d.members[m] === c.id) delete d.members[m];
    c.members = [];
    dropMember(d, c, uid);
    delete d.clans[clanId];
    return { name: c.name, tag: c.tag, gone };
  });
  if (res) touched(ctx.engine, res.gone);
  if (!res) return ctx.update({ embeds: [dialog.info('Nothing changed', 'That clan is already gone or has a new leader.')], components: [] });
  return ctx.update({ embeds: [dialog.ok('Clan closed', `**${res.name}** [${res.tag}] is closed.`)], components: [] });
}

async function infoOf(ctx, query) {
  const doc = read(ctx.engine);
  const c = findClan(doc, query);
  if (!c) {
    const guess = didYouMean(String(query || ''), Object.values(doc.clans).map((x) => x.tag));
    return ctx.warn('No clan by that name', `I couldn't find **${clip(cleanText(query), 30) || 'that'}**.${guess.length ? ` Did you mean ${guess.map((g) => `**[${g}]**`).join(', ')}?` : ''}`);
  }
  return ctx.panel(clanCard(ctx.engine, c, ctx.userId));
}

async function setCost(ctx, text) {
  if (!canGiveCurrency(ctx.engine, ctx.userId)) return ctx.warn('Owner only', `Only the bot owner can change what a clan costs.`);
  const n = Number(String(text ?? '').trim());
  if (!Number.isInteger(n) || n < 0 || n > CREATE_COST_MAX) return ctx.warn("That amount didn't work", `Use a whole number of ${CURRENCY.name} from 0 to ${fmt(CREATE_COST_MAX)}, like \`/clan cost 500\`.`);
  patchGlobalConfig(ctx.engine, ID, { createCost: n });
  return ctx.ok('Saved', n ? `Starting a clan costs ${shards(n)} now.` : 'Starting a clan is free now.');
}

function splitCreate(tokens) {
  const list = tokens.map((x) => String(x ?? '').trim()).filter(Boolean);
  if (list.length < 2) return { name: list.join(' '), tag: '' };
  const last = list[list.length - 1].replace(/^\[|\]$/g, '');
  return { name: list.slice(0, -1).join(' '), tag: last };
}

const SUBS = ['create', 'invite', 'join', 'accept', 'decline', 'leave', 'kick', 'leader', 'tag', 'colour', 'banner', 'privacy', 'open', 'invite-only', 'deposit', 'upgrade', 'top', 'info', 'disband', 'cost'];

async function runClan(ctx) {
  const tokens = ctx.argv.length ? ctx.argv : tokenize(ctx.args);
  const sub = (tokens[0] || '').toLowerCase();
  const rest = tokens.slice(1);
  const restText = rest.join(' ');
  if (!sub || ['me', 'home', 'panel', 'mine'].includes(sub)) return ctx.panel(hubView(ctx.engine, ctx.userId));
  if (['create', 'new', 'found', 'start'].includes(sub)) {
    const { name, tag } = splitCreate(rest);
    if (!name || !tag) return ctx.warn('Name and tag, please', `Try \`/clan create Night Owls OWL\`. It costs ${shards(createCost(ctx.engine))}.`);
    return createClan(ctx, name, tag);
  }
  if (sub === 'invite' || sub === 'add') return inviteUser(ctx, restText);
  if (sub === 'join') return joinOpen(ctx, restText);
  if (sub === 'accept') return acceptInvite(ctx, rest[0] || '');
  if (['privacy', 'joining', 'mode', 'access'].includes(sub)) return setJoinMode(ctx, rest.join('-'));
  if (['open', 'unlock', 'public'].includes(sub)) return setJoinMode(ctx, 'open');
  if (['invite-only', 'inviteonly', 'lock', 'private'].includes(sub)) return setJoinMode(ctx, 'invite');
  if (sub === 'decline' || sub === 'reject') return declineInvite(ctx, rest[0] || '');
  if (sub === 'leave' || sub === 'quit') return leaveClan(ctx);
  if (sub === 'kick' || sub === 'remove') return leaderAction(ctx, restText, 'kick');
  if (['leader', 'transfer', 'promote', 'owner'].includes(sub)) return leaderAction(ctx, restText, 'leader');
  if (sub === 'tag') return setLook(ctx, 'tag', rest[0]);
  if (sub === 'colour' || sub === 'color') return setLook(ctx, 'colour', rest[0]);
  if (sub === 'banner' || sub === 'motto') return setLook(ctx, 'banner', restText);
  if (sub === 'deposit' || sub === 'bank' || sub === 'donate') {
    if (!rest.length) return ctx.panel(hubView(ctx.engine, ctx.userId));
    return deposit(ctx, rest[0]);
  }
  if (['upgrade', 'upgrades', 'buy'].includes(sub)) return buyUpgrade(ctx, rest[0]);
  if (['top', 'leaderboard', 'lb', 'board'].includes(sub)) return ctx.panel(topView(ctx.engine, ctx.userId, /^season|month/i.test(rest[0] || '') ? 'season' : 'level'));
  if (['info', 'view', 'show', 'about'].includes(sub)) return restText ? infoOf(ctx, restText) : ctx.panel(hubView(ctx.engine, ctx.userId));
  if (sub === 'disband' || sub === 'close' || sub === 'delete') return disbandAsk(ctx);
  if (sub === 'cost' || sub === 'price') return setCost(ctx, rest[0]);
  if (findClan(read(ctx.engine), tokens.join(' '))) return infoOf(ctx, tokens.join(' '));
  const guess = didYouMean(sub, SUBS);
  return ctx.warn("I didn't get that", `I don't know **${clip(cleanText(sub), 30) || 'that'}**.${guess.length ? ` Did you mean ${guess.map((g) => `**${g}**`).join(', ')}?` : ''}\nTry \`/clan\` on its own to see your clan.`);
}

function tidy(text, uid, leader) {
  return String(text ?? '')
    .replace(/<@!?([\w-]+)>/g, (_, id) => (id === uid ? 'you' : id === leader ? 'the leader' : 'them'))
    .replace(/^-# /gm, '')
    .replace(/\*\*?|`/g, '')
    .replace(/\s*\n+\s*/g, ' ')
    .trim();
}

function webCtx(engine, uid) {
  const out = { last: null };
  const say = (tone) => async (title, body) => {
    out.last = { tone, title: String(title ?? ''), body: String(body ?? '') };
    return out.last;
  };
  const from = (tone) => async (p) => {
    const e = p && Array.isArray(p.embeds) ? p.embeds[0] : null;
    out.last = { tone, title: String(e?.title ?? '').replace(/^[^\p{L}\p{N}]+/u, ''), body: String(e?.description ?? p?.content ?? '') };
    return out.last;
  };
  const ctx = {
    engine, userId: uid, serverId: null, channelId: null, argv: [], args: '', values: {},
    warn: say('warn'), info: say('info'), ok: say('ok'), error: say('warn'),
    reply: from('reply'), ephemeral: from('reply'), update: from('reply'), panel: from('reply'),
    findUser: async () => null, form: async () => null,
  };
  return { ctx, out };
}

function localId(doc, user) {
  const lowered = user.toLowerCase();
  if (doc.members[user] || doc.invites[user]) return user;
  if (doc.members[lowered] || doc.invites[lowered]) return lowered;
  return Object.keys(doc.members).find((k) => k.toLowerCase() === lowered) || Object.keys(doc.invites).find((k) => k.toLowerCase() === lowered) || user;
}

function memberId(c, raw) {
  const want = String(raw ?? '').toLowerCase();
  return c ? c.members.find((m) => m.toLowerCase() === want) || null : null;
}

const LEADER_WEB_KINDS = new Set(['invite', 'kick', 'leader', 'tag', 'colour', 'banner', 'privacy', 'upgrade', 'disband']);

export async function webAction(engine, user, kind, clanId, payload = {}) {
  const raw = typeof user === 'string' ? user.trim() : '';
  if (!WEB_USER_RE.test(raw)) return { ok: false, code: 'failed', message: "That doesn't look like a real account." };
  if (raw.toLowerCase() === String(engine.bot.me?.id ?? '').toLowerCase()) return { ok: false, code: 'bot', message: "Bots can't use clans." };
  if (!WEB_KINDS.has(kind)) return { ok: false, code: 'failed', message: "YapOS doesn't know that clan action. Update the bot and try again." };
  const p = payload && typeof payload === 'object' ? payload : {};
  const before = read(engine);
  const uid = localId(before, raw);
  const mineBefore = clanOfUser(before, uid);
  const leaderKind = LEADER_WEB_KINDS.has(kind);
  if (leaderKind || kind === 'leave') {
    if (!mineBefore) return { ok: false, code: 'no_clan', message: "You're not in a clan any more." };
    if (clanId && mineBefore.id !== clanId) return { ok: false, code: 'changed', message: 'Your clan changed since you asked. Reload and try again.' };
    if (leaderKind && mineBefore.leader !== uid) return { ok: false, code: 'not_leader', message: 'Only the clan leader can do that.' };
  }
  const { ctx, out } = webCtx(engine, uid);
  const cid0 = mineBefore?.id;
  const after = () => read(engine);
  let ok = false;
  let done = '';
  if (kind === 'create') {
    await createClan(ctx, p.name, p.tag);
    const c = clanOfUser(after(), uid);
    ok = !mineBefore && Boolean(c) && c.tag === String(p.tag ?? '').toUpperCase();
    if (ok) done = `You founded [${c.tag}] ${c.name}!`;
  } else if (kind === 'invite') {
    const target = String(p.target ?? '');
    const t0 = nowOf(engine);
    await inviteUser(ctx, target);
    const d = after();
    ok = liveInvites(d, localId(d, target), nowOf(engine)).some((x) => x.clan === cid0 && Number(x.at) >= t0);
    if (ok) done = out.last?.title === 'Invite sent' || out.last?.title === 'Invite on its way' ? 'Invite sent to their DMs and their YapOS inbox.' : 'Invite saved. They can see it in their YapOS inbox and accept within 7 days.';
  } else if (kind === 'accept') {
    const target = String(p.clan ?? clanId ?? '');
    await acceptInvite(ctx, target);
    const c = clanOfUser(after(), uid);
    ok = !mineBefore && c?.id === target;
    if (ok) done = `You joined [${c.tag}] ${c.name}!`;
  } else if (kind === 'decline') {
    const target = String(p.clan ?? clanId ?? '');
    await declineInvite(ctx, target);
    ok = !liveInvites(after(), uid, nowOf(engine)).some((x) => x.clan === target);
    if (ok) done = 'Invite declined.';
  } else if (kind === 'kick' || kind === 'leader') {
    const target = memberId(mineBefore, p.target);
    if (!target) return { ok: false, code: 'not_member', message: "They're not in your clan any more." };
    await leaderAction(ctx, target, kind);
    const c = after().clans[cid0];
    ok = kind === 'kick' ? Boolean(c) && !c.members.includes(target) : c?.leader === target;
    if (ok) done = kind === 'kick' ? 'They were removed from the clan.' : 'They lead the clan now. You stay in as a member.';
  } else if (kind === 'tag' || kind === 'colour' || kind === 'banner') {
    const value = kind === 'tag' ? p.tag : kind === 'colour' ? p.colour : p.text;
    await setLook(ctx, kind, value ?? '');
    ok = out.last?.tone === 'ok';
    if (ok) done = tidy(out.last.body, uid, mineBefore.leader);
  } else if (kind === 'privacy') {
    const mode = p.mode === 'invite' ? 'invite' : 'open';
    await setJoinMode(ctx, mode);
    ok = out.last?.tone === 'ok' && joinModeOf(after().clans[cid0]) === mode;
    if (ok) done = mode === 'invite' ? 'Your clan is invite only now.' : 'Anyone can join your clan now.';
  } else if (kind === 'upgrade') {
    const which = p.upgrade === 'boost' ? 'boost' : 'style';
    await buyUpgrade(ctx, which);
    ok = !mineBefore[which] && after().clans[cid0]?.[which] === true;
    if (ok) done = which === 'style' ? 'Colour and banner unlocked!' : `+${Math.round(BOOST * 100)}% XP unlocked for every member!`;
  } else if (kind === 'disband') {
    await disband(ctx, cid0);
    ok = !after().clans[cid0];
    if (ok) done = `[${mineBefore.tag}] ${mineBefore.name} is closed.`;
  } else if (kind === 'leave') {
    await leaveClan(ctx);
    ok = !clanOfUser(after(), uid);
    if (ok) done = tidy(out.last?.body, uid, mineBefore.leader) || 'You left the clan.';
  }
  if (ok) return { ok: true, code: 'done', message: done || 'Done.' };
  const last = out.last;
  const message = last ? [last.title, tidy(last.body, uid, mineBefore?.leader)].filter(Boolean).join('. ').replace(/([.!?])\./g, '$1') : "YapOS couldn't do that.";
  return { ok: false, code: 'refused', message: message.slice(0, 300) };
}

const mine = (run) => ({ owner: true, ownerArg: 0, run });

export const { setup, teardown, check } = defineApp({
  id: ID,
  name: 'Clans',
  icon: '🛡️',
  description: `Small groups across every server with a tag, a shared ${CURRENCY.name} bank for upgrades and a clan leaderboard.`,
  category: 'Fun',
  panelPerm: 'member',

  defaults: { createCost: CREATE_COST },

  commands: {
    clan: { description: 'Your clan: /clan, create Night Owls OWL, join OWL, invite @sam or a user id (by DM), privacy', serverOnly: false, run: runClan },
  },

  components: {
    home: mine(async (ctx) => ctx.update(hubView(ctx.engine, ctx.userId))),
    top: {
      run: async (ctx) => {
        const view = topView(ctx.engine, ctx.userId, ctx.argv[1]);
        if (ctx.argv[0] === ctx.userId) return ctx.update(view);
        return ctx.panel(view);
      },
    },
    upview: mine(async (ctx) => {
      const view = upgradesView(ctx.engine, ctx.userId);
      return view ? ctx.panel(view) : ctx.warn('No clan yet', 'You are not in a clan.');
    }),
    buy: mine((ctx) => buyUpgrade(ctx, ctx.argv[1], 'update')),
    accept: mine((ctx) => acceptInvite(ctx, ctx.argv[1], 'update')),
    join: mine((ctx) => joinOpen(ctx, ctx.argv[1], 'update')),
    privacy: mine((ctx) => setJoinMode(ctx, ctx.argv[1], 'update')),
    decline: mine((ctx) => declineInvite(ctx, ctx.argv[1], 'update')),
    leaveask: mine((ctx) => {
      const c = clanOfUser(read(ctx.engine), ctx.userId);
      if (!c) return ctx.info('Not in a clan', 'You are not in a clan right now.');
      const last = c.members.length === 1;
      return ctx.panel({
        embeds: [dialog.warn('Leave the clan?', last ? `You are the last member, so **${c.name}** [${c.tag}] closes when you go.${c.bank ? ` Its bank of ${shards(c.bank)} closes with it.` : ''}` : `You'll leave **${c.name}** [${c.tag}].${c.leader === ctx.userId ? ' The member who joined first becomes the leader.' : ''} Shards you put in the bank stay with the clan.`)],
        components: [row(button('Leave', cid('leave', ctx.userId), 'danger', '🚪'), button('Stay', cid('cancel', ctx.userId), 'secondary'))],
      });
    }),
    leave: mine((ctx) => leaveClan(ctx, 'update')),
    disband: mine((ctx) => disband(ctx, ctx.argv[1])),
    cancel: mine((ctx) => ctx.update({ embeds: [dialog.info('Nothing changed', 'All good, nothing happened.')], components: [] })),
    createform: mine((ctx) => ctx.form({ title: 'Create a clan', action: 'createsave', args: [ctx.userId], fields: [
      { id: 'name', label: `Clan name (${NAME_MIN} to ${NAME_MAX} characters)`, style: 'short', placeholder: 'Night Owls', max: NAME_MAX },
      { id: 'tag', label: 'Tag (3 or 4 letters or numbers)', style: 'short', placeholder: 'OWL', max: 4 },
    ] })),
    createsave: mine((ctx) => createClan(ctx, ctx.values?.name, ctx.values?.tag)),
    depform: mine((ctx) => ctx.form({ title: 'Deposit to the clan bank', action: 'depsave', args: [ctx.userId], fields: [
      { id: 'amount', label: `How many ${CURRENCY.name}? (they can't come back out)`, style: 'short', placeholder: '100', max: 12 },
    ] })),
    depsave: mine((ctx) => deposit(ctx, ctx.values?.amount)),
    invform: mine((ctx) => ctx.form({ title: 'Invite to your clan', action: 'invsave', args: [ctx.userId], fields: [
      { id: 'user', label: 'Who? (@name, username or Yapin user id)', style: 'short', placeholder: '@sam', max: 100 },
    ] })),
    invsave: mine((ctx) => inviteUser(ctx, ctx.values?.user)),
  },

  yap: [
    { words: ['clan', 'clans', 'guild', 'guilds', 'team'], run: runClan },
  ],

  panel: async (ctx) => ctx.panel(hubView(ctx.engine, ctx.userId)),

  services: (engine) => ({
    of: (uid) => publicClan(engine, uid),
    getClanOf: (uid) => publicClan(engine, uid),
    xpBoost: (uid) => (clanOfUser(read(engine), uid)?.boost ? BOOST : 0),
    board: (by) => clanBoard(engine, by),
    directory: () => clanDirectory(engine),
    rev: () => read(engine).rev,
    webJoin: (user, clanId, tag, via) => webJoin(engine, user, clanId, tag, via),
    webAction: (user, kind, clanId, payload) => webAction(engine, user, kind, clanId, payload),
    feed: () => clanFeed(engine),
    settings: () => clanSettings(engine),
    get: (id) => {
      const c = read(engine).clans[id];
      return c ? { ...c, members: [...c.members] } : null;
    },
  }),

  presets: {
    gaming: { enabled: true, config: {} },
    friends: { enabled: true, config: {} },
    study: { enabled: true, config: {} },
    community: { enabled: true, config: {} },
    roleplay: { enabled: true, config: {} },
  },

  help: [
    'Clans are groups with no member limit that follow you to every server. You can be in one clan at a time.',
    'Clans are open by default: anyone can join with /clan join OWL or by tapping the clan tag on a profile on the website or in YapOS Party. Leaders can switch with /clan privacy invite (invite only) or /clan privacy open.',
    `Start one with /clan create Night Owls OWL (costs ${CREATE_COST} ${CURRENCY.name} by default). The leader invites with /clan invite @sam or /clan invite followed by a Yapin' user id (works in DMs with me too). The invite arrives in their DMs with a Join button, or they type /clan accept TAG.`,
    `Leaders can send ${INVITE_RATE} invites an hour. Inviting the same person again within a day refreshes their invite without another DM. Someone who says No thanks isn't asked by that clan again for a week, and nobody gets more than 3 invite DMs a day.`,
    `The clan bank only goes one way: members deposit with /clan deposit 100 and the leader spends it on upgrades (/clan upgrade). Nobody can take ${CURRENCY.name} out.`,
    `Upgrades: a custom colour and banner, and +${Math.round(BOOST * 100)}% XP for every member from chatting and voice.`,
    'Leaders: /clan kick @sam · /clan leader @sam · /clan tag OWL · /clan privacy open or invite · /clan colour #ff8800 · /clan banner Night owls never sleep · /clan disband',
    'See how clans compare with /clan top (total levels) or /clan top season.',
    'You can also run your clan on the website at yapos.dev/clans: create, invite, change the tag, colour, banner and who can join, kick, hand over or close it. Invites and clan news show up in your inbox at yapos.dev/inbox.',
  ],

  init: (engine) => {
    try {
      const out = migrateUnlimited(engine);
      if (out.clans) engine.log.info(`[clans] clans have no member limit now; gave back ${fmt(out.refunded)} Shards to ${out.clans} clan bank${out.clans === 1 ? '' : 's'}`);
    } catch (e) {
      engine.log.warn(`[clans] couldn't refund member upgrades: ${e?.message}`);
    }
    engine.clans = { getClanOf: (uid) => publicClan(engine, uid), xpBoost: (uid) => (clanOfUser(read(engine), uid)?.boost ? BOOST : 0) };
  },

  dispose: (engine) => {
    states.delete(engine);
    if (engine?.clans) delete engine.clans;
  },
});
