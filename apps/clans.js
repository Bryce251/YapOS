import { defineApp } from '../engine/apps.js';
import { card, dialog, button, row } from '../engine/ui.js';
import { customId } from '../engine/router.js';
import { tokenize, didYouMean, clip, normalizeName } from '../engine/parse.js';
import { GLOBAL_KEY, CURRENCY, globalConfig, patchGlobalConfig, globalDoc, mutateGlobal, canGiveCurrency } from '../engine/global.js';

const ID = 'clans';
const cid = (action, ...args) => customId(ID, action, ...args);

const NS = 'clans';
const DAY = 86_400_000;
const COLOR = 0x5b8def;
export const CAPS = Object.freeze([10, 15, 20, 25]);
export const CAP_PRICES = Object.freeze([1000, 2500, 5000]);
export const STYLE_PRICE = 1500;
export const BOOST_PRICE = 5000;
export const BOOST = 0.05;
export const CREATE_COST = 500;
const CREATE_COST_MAX = 1_000_000;
const INVITE_TTL_MS = 7 * DAY;
const MAX_INVITES = 5;
const MAX_CLANS = 5000;
const NAME_MIN = 3;
const NAME_MAX = 24;
const BANNER_MAX = 60;
const TOP_SIZE = 10;
const DEPOSIT_MAX = 1_000_000_000;
const MEDALS = ['🥇', '🥈', '🥉'];
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 '._-]*[A-Za-z0-9.]$/;
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
const blank = () => ({ seq: 0, clans: {}, members: {}, invites: {} });

function fix(d) {
  const doc = d && typeof d === 'object' ? d : blank();
  for (const k of ['clans', 'members', 'invites']) if (!doc[k] || typeof doc[k] !== 'object' || Array.isArray(doc[k])) doc[k] = {};
  doc.seq = Number.isInteger(doc.seq) ? doc.seq : 0;
  return doc;
}

const read = (engine) => fix(globalDoc(engine, NS, null));
const write = (engine, fn) => mutateGlobal(engine, NS, (d) => fn(fix(d)), blank());
const cfgOf = (engine) => globalConfig(engine, ID);

export function createCost(engine) {
  const n = Number(cfgOf(engine).createCost);
  return Number.isInteger(n) && n >= 0 && n <= CREATE_COST_MAX ? n : CREATE_COST;
}

export function capOf(clan) {
  const lvl = Math.max(0, Math.min(CAPS.length - 1, Math.floor(Number(clan?.cap) || 0)));
  return CAPS[lvl];
}

const STEMS = ['admin', 'moderator', 'staff', 'yapin', 'yapper', 'yapos', 'official', 'developer'];

function reservedWord(w) {
  if (RESERVED.includes(w)) return true;
  const bare = w.replace(/(?:es|s|z)$/, '');
  return bare !== w && RESERVED.includes(bare);
}

function blocked(text) {
  const t = String(text ?? '');
  if (!t) return false;
  const words = normalizeName(t).split('-').filter(Boolean);
  const compact = normalizeName(t).replace(/-/g, '');
  if ([...words, compact].some(reservedWord)) return true;
  if (STEMS.some((stem) => compact.startsWith(stem) || compact.endsWith(stem))) return true;
  if (!filter) return false;
  try {
    if (filter.findBlocked(t).length) return true;
    return words.some((w) => filter.isBlockedGameWord(w)) || filter.isBlockedGameWord(t.replace(/\s+/g, ''));
  } catch {
    return false;
  }
}

export function checkName(raw) {
  const name = cleanText(raw);
  if (name.length < NAME_MIN || name.length > NAME_MAX) return { error: `Clan names are ${NAME_MIN} to ${NAME_MAX} characters.` };
  if (!NAME_RE.test(name)) return { error: 'Use letters, numbers, spaces and simple marks like - _ . \' in clan names.' };
  if (blocked(name)) return { error: "That name isn't allowed. Pick something else." };
  return { value: name };
}

export function checkTag(raw) {
  const tag = String(raw ?? '').trim().replace(/^\[|\]$/g, '');
  if (!TAG_RE.test(tag)) return { error: 'Tags are 3 or 4 letters or numbers, like `OWL` or `GG42`.' };
  if (blocked(tag)) return { error: "That tag isn't allowed. Pick something else." };
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
  return c ? { id: c.id, name: c.name, tag: c.tag, colour: Number.isInteger(c.colour) ? hexOf(c.colour) : null, banner: c.banner || null, leader: c.leader === uid, members: c.members.length } : null;
}

const label = (c) => `**${c.name}** [${c.tag}]`;

function upgradesText(c) {
  const lvl = Math.floor(Number(c.cap) || 0);
  return [
    `👥 Members ${capOf(c)}${lvl < CAP_PRICES.length ? ` · next ${CAPS[lvl + 1]} for ${shards(CAP_PRICES[lvl])}` : ' · max'}`,
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
    { name: 'Members', value: `${c.members.length}/${capOf(c)}`, inline: true },
    { name: 'Total level', value: fmt(total), inline: true },
    { name: 'Clan rank', value: pos >= 0 ? `#${pos + 1} of ${fmt(board.length)}` : 'not ranked', inline: true },
    { name: 'Clan bank', value: `${shards(c.bank)}\n-# Only for upgrades. It can't be paid out.`, inline: true },
    { name: 'Upgrades', value: upgradesText(c), inline: false },
    { name: 'Roster', value: clip(memberLines.join('\n'), 1024) || 'Nobody', inline: false },
  ];
  const body = [c.banner ? `*${c.banner}*` : null, `Founded ${new Date(c.created || 0).toISOString().slice(0, 10)} · one clan across every server`].filter(Boolean).join('\n');
  const mine = viewer && c.members.includes(viewer);
  const lead = viewer && c.leader === viewer;
  const btns = [];
  if (mine) btns.push(button('Deposit', cid('depform', viewer), 'success', CURRENCY.emoji));
  if (lead) btns.push(button('Invite', cid('invform', viewer), 'primary', '✉️'), button('Upgrades', cid('upview', viewer), 'secondary', '⬆️'));
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
    `Team up with up to ${CAPS[0]} friends from any server. Clans have a tag, a shared bank and their own leaderboard.`,
    '',
    `• **Create one:** \`/clan create Night Owls OWL\` (costs ${shards(cost)})`,
    '• **Join one:** ask a clan leader for an invite, then `/clan accept`',
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
  const lvl = Math.floor(Number(c.cap) || 0);
  const lead = c.leader === uid;
  const btns = [];
  if (lead && lvl < CAP_PRICES.length) btns.push(button(`${CAPS[lvl + 1]} members · ${fmt(CAP_PRICES[lvl])}`, cid('buy', uid, 'members'), c.bank >= CAP_PRICES[lvl] ? 'success' : 'secondary', '👥'));
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
  const name = checkName(nameRaw);
  if (name.error) return ctx.warn("That name didn't work", `${name.error}\nTry \`/clan create Night Owls OWL\`.`);
  const tag = checkTag(tagRaw);
  if (tag.error) return ctx.warn("That tag didn't work", `${tag.error}\nTry \`/clan create Night Owls OWL\`.`);
  const res = await guarded(engine, uid, async () => {
    const doc = read(engine);
    if (clanOfUser(doc, uid)) return { problem: ['You already have a clan', 'Leave your clan first with `/clan leave`. You can only be in one clan at a time.'] };
    if (Object.keys(doc.clans).length >= MAX_CLANS) return { problem: ['No room for new clans', 'There are as many clans as YapOS can hold right now. Join one instead!'] };
    if (findClan(doc, tag.value) || Object.values(doc.clans).some((c) => c.tag === tag.value)) return { problem: ['That tag is taken', `Another clan already uses **[${tag.value}]**. Pick another tag.`] };
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
      if (clanOfUser(d, uid) || Object.values(d.clans).some((c) => c.tag === tag.value || normalizeName(c.name) === normalizeName(name.value))) return null;
      d.seq += 1;
      const id = `c${d.seq}`;
      d.clans[id] = { id, name: name.value, tag: tag.value, leader: uid, members: [uid], joined: { [uid]: t }, bank: 0, spent: 0, cap: 0, style: false, boost: false, colour: null, banner: null, created: t };
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
  return ctx.reply({ embeds: [card({ title: `🛡️ ${res.clan.name} [${res.clan.tag}] is founded!`, body: `<@${uid}> leads a brand new clan${res.cost ? ` (paid ${shards(res.cost)})` : ''}.\nInvite friends with \`/clan invite @name\` and grow the bank with \`/clan deposit 100\`.`, color: COLOR, footer: false })] });
}

async function inviteUser(ctx, query) {
  const { engine } = ctx;
  const uid = ctx.userId;
  const doc = read(engine);
  const c = clanOfUser(doc, uid);
  if (!c) return ctx.warn('No clan yet', 'Create one first with `/clan create Name TAG`.');
  if (c.leader !== uid) return ctx.warn('Only the leader can invite', `Ask <@${c.leader}> to send the invite.`);
  const q = String(query ?? '').trim();
  if (!q) return ctx.warn('Invite who?', 'Try `/clan invite @sam`.');
  if (!ctx.serverId) return ctx.warn('Invite from a server', 'Run `/clan invite @sam` in a server you share with them.');
  const found = await ctx.findUser(q);
  if (!found?.id) return ctx.warn("I couldn't find them", `Nobody here matches **${clip(cleanText(q), 40) || 'that'}**. Try a mention, like \`/clan invite @sam\`.`);
  if (found.id === uid) return ctx.info("That's you", 'You are already in your clan!');
  if (found.id === engine.bot.me?.id || found.bot) return ctx.warn("Bots can't join clans", 'Invite a person instead.');
  if (c.members.length >= capOf(c)) return ctx.warn('Your clan is full', `${label(c)} has ${c.members.length}/${capOf(c)} members. Buy more room with \`/clan upgrade members\`.`);
  const t = nowOf(engine);
  const res = write(engine, (d) => {
    const theirs = clanOfUser(d, found.id);
    if (theirs) return { inClan: theirs.id === c.id ? 'yours' : 'other' };
    const list = liveInvites(d, found.id, t).filter((x) => x.clan !== c.id);
    list.push({ clan: c.id, by: uid, at: t });
    d.invites[found.id] = list.slice(-MAX_INVITES);
    return { ok: true };
  });
  if (res.inClan === 'yours') return ctx.info('Already in', `<@${found.id}> is already in ${label(c)}.`);
  if (res.inClan) return ctx.warn('They have a clan', `<@${found.id}> is already in another clan. They need to leave it first.`);
  return ctx.reply({
    content: `<@${found.id}>`,
    embeds: [card({ title: `✉️ Clan invite`, body: `<@${uid}> invited you to join ${label(c)}.\nPress **Join** below, or type \`/clan accept ${c.tag}\` within 7 days.`, color: Number.isInteger(c.colour) ? c.colour : COLOR, footer: false })],
    components: [row(button(`Join [${c.tag}]`, cid('accept', found.id, c.id), 'success', '✅'), button('No thanks', cid('decline', found.id, c.id), 'secondary'))],
    open: true,
  });
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
  const say = (title, body) => (how === 'update' ? ctx.update({ embeds: [dialog.warn(title, body)], components: [] }) : ctx.warn(title, body));
  if (clanOfUser(doc, uid)) return say('You already have a clan', 'Leave it first with `/clan leave`, then accept.');
  if (!invites.length) return say('No invites', 'Nobody has invited you yet, or the invite is older than 7 days.');
  if (!pick) return say('Which clan?', `You have invites from ${invites.map((x) => label(doc.clans[x.clan])).join(', ')}. Try \`/clan accept ${doc.clans[invites[0].clan].tag}\`.`);
  const res = write(engine, (d) => {
    if (clanOfUser(d, uid)) return { problem: 'inClan' };
    const c = d.clans[pick.clan];
    if (!c) return { problem: 'gone' };
    if (c.members.length >= capOf(c)) return { problem: 'full', c };
    c.members.push(uid);
    c.joined = c.joined && typeof c.joined === 'object' ? c.joined : {};
    c.joined[uid] = t;
    d.members[uid] = c.id;
    delete d.invites[uid];
    return { c };
  });
  if (res.problem === 'inClan') return say('You already have a clan', 'Leave it first with `/clan leave`.');
  if (res.problem === 'gone') return say('That clan is gone', 'It was disbanded after the invite was sent.');
  if (res.problem === 'full') return say('That clan is full', `${label(res.c)} has no room right now. Ask the leader to upgrade.`);
  await emit(engine, 'clan:joined', { user: uid, clan: res.c.id, server_id: null });
  const embed = card({ title: `🛡️ Welcome to ${res.c.name} [${res.c.tag}]!`, body: `<@${uid}> joined the clan. ${res.c.members.length}/${capOf(res.c)} members now.`, color: Number.isInteger(res.c.colour) ? res.c.colour : COLOR, footer: false });
  return how === 'update' ? ctx.update({ content: '', embeds: [embed], components: [] }) : ctx.reply({ embeds: [embed] });
}

async function declineInvite(ctx, which, how = 'reply') {
  const { engine } = ctx;
  const uid = ctx.userId;
  const doc = read(engine);
  const c = which ? doc.clans[which] || findClan(doc, which) : null;
  write(engine, (d) => {
    const list = Array.isArray(d.invites[uid]) ? d.invites[uid] : [];
    const kept = c ? list.filter((x) => x?.clan !== c.id) : [];
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
    return { ...info, ...dropMember(d, c, uid) };
  });
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
    return true;
  });
  if (!ok) return ctx.warn('That changed', 'The clan changed a moment ago. Try again.');
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
    const tag = checkTag(raw);
    if (tag.error) return ctx.warn("That tag didn't work", tag.error);
    if (Object.values(read(engine).clans).some((x) => x.id !== c.id && x.tag === tag.value)) return ctx.warn('That tag is taken', `Another clan already uses **[${tag.value}]**.`);
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
        if (blocked(text)) return ctx.warn("That banner isn't allowed", 'Pick different words.');
        patch = { banner: text };
        done = `Your banner reads: *${text}*`;
      }
    }
  }
  const ok = write(engine, (d) => {
    const cur = d.clans[c.id];
    if (!cur || cur.leader !== uid) return false;
    if (patch.tag && Object.values(d.clans).some((x) => x.id !== c.id && x.tag === patch.tag)) return false;
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
  if (c.leader !== uid) return ctx.warn('Only the leader can buy upgrades', `<@${c.leader}> leads ${label(c)}. Help by depositing with \`/clan deposit 100\`.`);
  const res = write(engine, (d) => {
    const cur = clanOfUser(d, uid);
    if (!cur || cur.leader !== uid) return { problem: 'changed' };
    let cost;
    if (kind === 'members') {
      const lvl = Math.floor(Number(cur.cap) || 0);
      if (lvl >= CAP_PRICES.length) return { problem: 'max' };
      cost = CAP_PRICES[lvl];
    } else if (kind === 'style') {
      if (cur.style) return { problem: 'owned' };
      cost = STYLE_PRICE;
    } else {
      if (cur.boost) return { problem: 'owned' };
      cost = BOOST_PRICE;
    }
    if ((Number(cur.bank) || 0) < cost) return { problem: 'short', cost, bank: Number(cur.bank) || 0 };
    cur.bank -= cost;
    cur.spent = (Number(cur.spent) || 0) + cost;
    if (kind === 'members') cur.cap = Math.floor(Number(cur.cap) || 0) + 1;
    else cur[kind] = true;
    return { cost, clan: { ...cur } };
  });
  if (res.problem === 'changed') return ctx.warn('That changed', 'The clan changed a moment ago. Try again.');
  if (res.problem === 'max') return ctx.info('Already the biggest', `${label(c)} already holds ${CAPS[CAPS.length - 1]} members.`);
  if (res.problem === 'owned') return ctx.info('Already unlocked', 'Your clan already has that upgrade.');
  if (res.problem === 'short') return ctx.warn('Not enough in the bank', `That upgrade costs ${shards(res.cost)} and the clan bank has ${shards(res.bank)}. Members can add more with \`/clan deposit 100\`.`);
  const what = kind === 'members' ? `room for **${capOf(res.clan)} members**` : kind === 'style' ? 'a **custom colour and banner** (`/clan colour`, `/clan banner`)' : `**+${Math.round(BOOST * 100)}% XP** for every member`;
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
    for (const m of [...c.members]) if (d.members[m] === c.id) delete d.members[m];
    c.members = [];
    dropMember(d, c, uid);
    delete d.clans[clanId];
    return { name: c.name, tag: c.tag };
  });
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

const SUBS = ['create', 'invite', 'accept', 'decline', 'leave', 'kick', 'leader', 'tag', 'colour', 'banner', 'deposit', 'upgrade', 'top', 'info', 'disband', 'cost'];

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
  if (sub === 'accept' || sub === 'join') return acceptInvite(ctx, rest[0] || '');
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
    clan: { description: 'Your clan: /clan, create Night Owls OWL, invite @sam, accept, deposit 100, upgrade, top, leave', serverOnly: false, run: runClan },
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
      { id: 'user', label: 'Who? (@name or username)', style: 'short', placeholder: '@sam', max: 100 },
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
    `Clans are small groups (${CAPS[0]} members, up to ${CAPS[CAPS.length - 1]} with upgrades) that follow you to every server. You can be in one clan at a time.`,
    `Start one with /clan create Night Owls OWL (costs ${CREATE_COST} ${CURRENCY.name} by default). The leader invites with /clan invite @sam, people join with /clan accept.`,
    `The clan bank only goes one way: members deposit with /clan deposit 100 and the leader spends it on upgrades (/clan upgrade). Nobody can take ${CURRENCY.name} out.`,
    `Upgrades: more members, a custom colour and banner, and +${Math.round(BOOST * 100)}% XP for every member from chatting and voice.`,
    'Leaders: /clan kick @sam · /clan leader @sam · /clan tag OWL · /clan colour #ff8800 · /clan banner Night owls never sleep · /clan disband',
    'See how clans compare with /clan top (total levels) or /clan top season.',
  ],

  init: (engine) => {
    engine.clans = { getClanOf: (uid) => publicClan(engine, uid), xpBoost: (uid) => (clanOfUser(read(engine), uid)?.boost ? BOOST : 0) };
  },

  dispose: (engine) => {
    states.delete(engine);
    if (engine?.clans) delete engine.clans;
  },
});
