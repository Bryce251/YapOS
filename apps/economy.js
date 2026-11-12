import { defineApp } from '../engine/apps.js';
import { card, dialog, button, row, rows, select, onOff, ICONS } from '../engine/ui.js';
import { customId } from '../engine/router.js';
import { tokenize, didYouMean, clip, formatDuration, fuzzyFind, fillTemplate, roleId as roleMention } from '../engine/parse.js';
import { permName, friendly } from '../engine/errors.js';
import { accept, reject, boolField } from '../engine/dashboard.js';

const ID = 'economy';
const cid = (action, ...args) => customId(ID, action, ...args);

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const STREAK_GRACE_MS = 48 * HOUR;
const WORK_COOLDOWN_MS = HOUR;
const BEG_COOLDOWN_MS = 5 * 60_000;
const BEG_MIN = 1;
const BEG_MAX = 25;
const BEG_MISS = 0.3;
const STREAK_STEP = 10;
const STREAK_MAX = 100;
const MAX_BALANCE = 1_000_000_000_000;
const MAX_AMOUNT = 1_000_000_000;
const MAX_SETTING = 1_000_000;
const MAX_USERS = 5000;
const MAX_HISTORY = 20;
const MAX_ITEMS = 20;
const MAX_INVENTORY = 50;
const MAX_STACK = 9999;
const MAX_STOCK = 100_000;
const MAX_SHOP_MESSAGES = 5;
const MAX_REASON = 60;
const MAX_ITEM_NAME = 40;
const PAY_CONFIRM_OVER = 1000;
const TOP_SIZE = 10;
const MEDALS = ['🥇', '🥈', '🥉'];
const DEFAULT_CURRENCY = { name: 'coins', emoji: '🪙' };

const BEG_YES = [
  'A kind stranger dropped {amount} in your cup.',
  'Someone felt sorry for you and handed over {amount}.',
  'A passing knight tossed you {amount} without slowing down.',
  'A grandma pinched your cheek and gave you {amount}.',
  'You found {amount} in a coat pocket a stranger gave you.',
  'A pigeon dropped {amount} at your feet. Lucky.',
  'A streamer read your sign on air and donated {amount}.',
  'A tourist mistook you for a street performer and paid {amount}.',
];

const BEG_NO = [
  'Everyone walked right past you. Nothing this time.',
  'A cat stared at you, judged you, and left. Nothing.',
  'Someone offered you advice instead of coins.',
  'You got a high five. Morale up, wallet the same.',
  'A seagull stole the one coin you were about to get.',
];

const JOBS = [
  'You walked a pack of very excited dogs and earned {amount}.',
  "You fixed the café's wobbly table and earned {amount}.",
  'You delivered pizzas in the rain and earned {amount}.',
  "You sorted the server's lost-and-found box and earned {amount}.",
  'You taught a parrot to say "gg" and earned {amount}.',
  'You tested comfy chairs all afternoon and earned {amount}.',
  'You washed cars at the town fundraiser and earned {amount}.',
  'You built a tiny website for the bakery and earned {amount}.',
  'You won the pub quiz on a technicality and earned {amount}.',
  'You babysat a very polite cat and earned {amount}.',
  'You busked in the town square and earned {amount}.',
  'You watered the neighbour\'s plants (and talked to them) and earned {amount}.',
  'You untangled a box of old cables and earned {amount}.',
  'You streamed for three loyal viewers and earned {amount}.',
  'You proofread a very long fan fiction and earned {amount}.',
];

const STAFF_PERMS = ['administrator', 'manage_server', 'manage_roles', 'manage_channels', 'manage_messages', 'manage_webhooks', 'manage_emojis', 'manage_events', 'manage_nicknames', 'kick_members', 'ban_members', 'timeout_members', 'move_members', 'mute_members', 'mention_everyone', 'view_audit_log'];
const staffPerms = (r) => STAFF_PERMS.filter((k) => r?.perms?.[k] || r?.[k] === true);
const staffList = (r) => staffPerms(r).map((k) => permName(k)).join(', ');
const isEveryone = (r, sid) => /^@?everyone$/i.test(r?.name || '') || r?.id === 'everyone' || r?.id === sid;
const isAuto = (r) => !!r?.auto && r.auto !== 'none';

const busy = new Set();
const warned = new Set();

const clock = (engine) => engine.scheduler?.now?.() ?? Date.now();
const fmt = (n) => Math.trunc(Number(n) || 0).toLocaleString('en-US');
const botId = (engine) => engine.bot.me?.id;
const cfgOf = (engine, sid) => engine.settings.appConfig(sid, ID);
const readableMentions = (text) => String(text ?? '').replace(/<@&[\w-]+>/g, '@role').replace(/<@!?[\w-]+>/g, '@someone').replace(/<#[\w-]+>/g, '#channel').replace(/<a?:([\w~-]{1,32}):[\w-]+>/g, ':$1:');
const plainName = (name) => readableMentions(name).replace(/[<>*_~`|\\]/g, '').replace(/@/g, '@​').trim() || 'someone';
const nameOfMember = (m) => plainName(m?.nickname || m?.display_name || m?.username || 'someone');
const plural = (n, word) => (Math.abs(n) === 1 && /s$/i.test(word) && word.length > 2 ? word.slice(0, -1) : word);

function currencyOf(engine, sid) {
  const cfg = cfgOf(engine, sid);
  return { name: cleanCurrencyName(cfg.currencyName) || DEFAULT_CURRENCY.name, emoji: cleanEmoji(cfg.currencyEmoji) || DEFAULT_CURRENCY.emoji };
}

function cleanCurrencyName(text) {
  const s = String(text ?? '').replace(/[\r\n]+/g, ' ').replace(/[<>@#*_~`|\\:]/g, '').replace(/\s+/g, ' ').trim();
  return s.length >= 1 && s.length <= 20 ? s : '';
}

const CUSTOM_EMOJI = /^<a?:[\w~-]{1,32}:[\w-]{1,64}>$/;
const SHORTCODE_EMOJI = /^:[\w~-]{1,32}:$/;

function cleanEmoji(text) {
  const s = String(text ?? '').trim();
  if (!s || s.length > 80) return '';
  if (CUSTOM_EMOJI.test(s) || SHORTCODE_EMOJI.test(s)) return s;
  if (s.length > 16 || /[\x00-\x7f]/.test(s.replace(/[#*0-9]️?⃣/g, ''))) return '';
  return s;
}

const money = (cur, n) => `**${fmt(n)}** ${plural(n, cur.name)}`;
const price = (cur, n) => `${fmt(n)} ${cur.emoji}`;

function waitText(ms) {
  const mins = Math.max(1, Math.ceil(ms / 60_000));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (!h) return `${m}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
}

function agoText(ms) {
  if (ms < 60_000) return 'just now';
  return `${formatDuration(ms)} ago`;
}

export function parseAmount(token) {
  const t = String(token ?? '').trim().toLowerCase().replace(/,/g, '').replace(/^\+/, '');
  const m = /^(\d+(?:\.\d+)?)([km]?)$/.exec(t);
  if (!m) return null;
  const v = Number(m[1]) * (m[2] === 'k' ? 1e3 : m[2] === 'm' ? 1e6 : 1);
  if (!Number.isFinite(v) || Math.abs(v - Math.round(v)) > 1e-9) return NaN;
  return Math.round(v);
}

export function streakBonus(streak) {
  return Math.min(STREAK_MAX, Math.max(0, Math.floor(Number(streak) || 0) * STREAK_STEP));
}

const validAmount = (n) => Number.isInteger(n) && n > 0 && n <= MAX_AMOUNT;
const blankDoc = () => ({ users: {}, items: [], seq: 0, shopMsgs: [] });

function fixDoc(d) {
  const doc = d && typeof d === 'object' ? d : blankDoc();
  if (!doc.users || typeof doc.users !== 'object') doc.users = {};
  if (!Array.isArray(doc.items)) doc.items = [];
  if (!Array.isArray(doc.shopMsgs)) doc.shopMsgs = [];
  doc.seq = Number.isInteger(doc.seq) ? doc.seq : 0;
  return doc;
}

const readDoc = (engine, sid) => fixDoc(engine.store.get(ID, sid, null));

function mutate(engine, sid, fn) {
  let out;
  engine.store.update(ID, sid, (d) => {
    const doc = fixDoc(d);
    out = fn(doc);
    return doc;
  }, blankDoc());
  return out;
}

const blankUser = (start, t) => ({ bal: start, streak: 0, lastDaily: 0, lastWork: 0, inv: {}, hist: [], seen: t });

function evictOne(doc, keep) {
  let worst = null;
  for (const [uid, u] of Object.entries(doc.users)) {
    if (uid === keep) continue;
    if (!worst || (u.bal || 0) < (worst.u.bal || 0) || ((u.bal || 0) === (worst.u.bal || 0) && (u.seen || 0) < (worst.u.seen || 0))) worst = { uid, u };
  }
  if (worst) delete doc.users[worst.uid];
}

function ensureUser(doc, uid, cfg, t) {
  let u = doc.users[uid];
  if (u) return u;
  while (Object.keys(doc.users).length >= MAX_USERS) evictOne(doc, uid);
  const start = clampSetting(cfg.startBalance, 0);
  u = blankUser(start, t);
  if (start > 0) u.hist.push([t, start, 'Starting balance']);
  doc.users[uid] = u;
  return u;
}

function clampSetting(v, fallback) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= MAX_SETTING ? n : fallback;
}

function change(u, delta, reason, t) {
  const before = u.bal || 0;
  u.bal = Math.max(0, Math.min(MAX_BALANCE, before + delta));
  const real = u.bal - before;
  u.hist = Array.isArray(u.hist) ? u.hist : [];
  u.seen = t;
  if (!real) return real;
  u.hist.push([t, real, clip(readableMentions(reason || 'Change').replace(/[\r\n]+/g, ' '), MAX_REASON)]);
  if (u.hist.length > MAX_HISTORY) u.hist.splice(0, u.hist.length - MAX_HISTORY);
  return real;
}

function balanceOf(engine, sid, uid) {
  const u = readDoc(engine, sid).users[uid];
  if (u) return u.bal || 0;
  return clampSetting(cfgOf(engine, sid).startBalance, 0);
}

function needIds(sid, uid) {
  if (!sid || !uid) throw new TypeError('economy: serverId and userId are required');
}

function needAmount(amount) {
  if (!validAmount(amount)) throw friendly(`Amounts are whole numbers from 1 to ${fmt(MAX_AMOUNT)}.`, { title: "That amount didn't work" });
}

function serviceAdd(engine, sid, uid, amount, reason) {
  needIds(sid, uid);
  needAmount(amount);
  if (uid === botId(engine)) return 0;
  const t = clock(engine);
  const cfg = cfgOf(engine, sid);
  return mutate(engine, sid, (doc) => {
    const u = ensureUser(doc, uid, cfg, t);
    change(u, amount, reason || 'Added', t);
    return u.bal;
  });
}

function serviceTake(engine, sid, uid, amount, reason) {
  needIds(sid, uid);
  needAmount(amount);
  if (uid === botId(engine)) return null;
  if (balanceOf(engine, sid, uid) < amount) return null;
  const t = clock(engine);
  const cfg = cfgOf(engine, sid);
  return mutate(engine, sid, (doc) => {
    const u = ensureUser(doc, uid, cfg, t);
    if ((u.bal || 0) < amount) return null;
    change(u, -amount, reason || 'Spent', t);
    return u.bal;
  });
}

function serviceTransfer(engine, sid, fromId, toId, amount, reason) {
  needIds(sid, fromId);
  needIds(sid, toId);
  needAmount(amount);
  if (fromId === toId || fromId === botId(engine) || toId === botId(engine)) return false;
  if (balanceOf(engine, sid, fromId) < amount) return false;
  const t = clock(engine);
  const cfg = cfgOf(engine, sid);
  return mutate(engine, sid, (doc) => {
    const from = ensureUser(doc, fromId, cfg, t);
    if ((from.bal || 0) < amount) return false;
    const to = ensureUser(doc, toId, cfg, t);
    if (!doc.users[fromId]) doc.users[fromId] = from;
    change(from, -amount, reason || 'Transfer sent', t);
    change(to, amount, reason || 'Transfer received', t);
    return true;
  });
}

function ranked(engine, sid) {
  const me = botId(engine);
  return Object.entries(readDoc(engine, sid).users)
    .filter(([uid, u]) => uid !== me && (u.bal || 0) > 0)
    .map(([uid, u]) => ({ id: uid, bal: u.bal || 0 }))
    .sort((a, b) => b.bal - a.bal || a.id.localeCompare(b.id));
}

async function memberOf(engine, sid, uid) {
  return engine.perms.member(sid, uid).catch(() => null);
}

function isBotMember(engine, m, uid) {
  if (uid && uid === botId(engine)) return true;
  if (!m) return false;
  return m.bot === true || m.is_bot === true || m.author_bot === true || (Array.isArray(m.badges) && m.badges.includes('bot'));
}

async function displayName(engine, sid, uid) {
  return nameOfMember(await memberOf(engine, sid, uid));
}

function splitAmount(tokens) {
  const idx = tokens.findIndex((t) => parseAmount(t) !== null && !/^<@/.test(t));
  if (idx < 0) return { amount: null, before: tokens, after: [] };
  return { amount: parseAmount(tokens[idx]), before: tokens.slice(0, idx), after: tokens.slice(idx + 1) };
}

async function findMember(ctx, query, what = 'them') {
  const q = String(query ?? '').trim();
  if (!q) return { problem: ['Who?', `Mention ${what}, like @sam.`] };
  const found = await ctx.findUser(q);
  if (!found?.id) return { problem: ["I couldn't find them", `Nobody here matches **${plainName(clip(q, 40))}**. Try a mention, like @sam.`] };
  const m = await memberOf(ctx.engine, ctx.serverId, found.id);
  if (!m && found.id !== botId(ctx.engine)) return { problem: ["They aren't here", "That person isn't in this server, so they can't have coins here."] };
  return { member: m || found, id: found.id, name: nameOfMember(m || found) };
}

async function modLog(engine, sid, embed, key) {
  try {
    const mod = engine.service('mod');
    if (mod?.log) { await mod.log(sid, embed); return; }
    const ch = engine.settings.core(sid).logChannel;
    if (!ch) return;
    engine.budget.send({ serverId: sid, channelId: ch, opts: { embeds: [embed] }, priority: 'low', key }).catch((e) => engine.log.debug('[economy] log failed', e?.message));
  } catch (e) {
    engine.log.debug('[economy] log failed', e?.message);
  }
}

function guardReason(engine, sid, roleId) {
  const core = engine.settings.core(sid);
  if ((core.adminRoles || []).includes(roleId)) return 'makes people a YapOS admin here';
  if ((core.modRoles || []).includes(roleId)) return 'makes people a YapOS moderator here';
  const tickets = engine.settings.appConfig(sid, 'tickets') || {};
  if ((tickets.staffRoles || []).includes(roleId)) return 'lets people into every ticket as ticket staff';
  const open = engine.store.get('tickets', sid, null)?.tickets || {};
  if (Object.values(open).some((t) => t && t.roleId === roleId)) return "opens someone's private ticket";
  const automod = engine.settings.appConfig(sid, 'automod') || {};
  if ((automod.exempt?.roles || []).includes(roleId)) return 'is skipped by Automod';
  return null;
}

async function roleProblem(engine, sid, roleId) {
  const all = await engine.perms.roles(sid).catch(() => []);
  const role = all.find((r) => r.id === roleId);
  if (!role) return { reason: "That role doesn't exist anymore." };
  const name = plainName(role.name);
  if (isEveryone(role, sid)) return { role, reason: 'Everyone already has @everyone, so it can\'t be sold.' };
  if (isAuto(role)) return { role, reason: `**@${name}** is given out automatically, so I can't sell it.` };
  if (staffPerms(role).length) return { role, reason: `**@${name}** has staff permissions (${staffList(role)}), so I won't sell it. Use a role without those permissions.` };
  const guard = guardReason(engine, sid, roleId);
  if (guard) return { role, reason: `**@${name}** ${guard}, so I won't sell it.` };
  const can = await engine.perms.canManageRole(sid, roleId).catch(() => ({ ok: false, reason: "I couldn't check that role right now. Try again in a moment." }));
  if (!can.ok) return { role, reason: can.reason };
  return { role, reason: null };
}

async function actorTop(engine, sid, uid) {
  if (engine.isBotOwner(uid)) return Infinity;
  const s = await engine.perms.server(sid).catch(() => null);
  if (s?.owner_id === uid) return Infinity;
  return engine.perms.topPosition(sid, uid);
}

function findItem(items, query) {
  const q = String(query ?? '').trim();
  if (!q) return null;
  const n = /^#?(\d{1,2})$/.exec(q);
  if (n) return items[Number(n[1]) - 1] || null;
  const rid = roleMention(q);
  if (rid) return items.find((it) => it.roleId === rid) || null;
  const exact = items.find((it) => it.name.toLowerCase() === q.toLowerCase());
  if (exact) return exact;
  return fuzzyFind(q, items, { key: (it) => it.name, maxTypos: 2 })?.item || null;
}

function stockText(it) {
  if (it.stock === null || it.stock === undefined) return '';
  return it.stock > 0 ? ` · ${fmt(it.stock)} left` : ' · sold out';
}

async function shopView(engine, sid, mode = 'select') {
  const doc = readDoc(engine, sid);
  const cur = currencyOf(engine, sid);
  const roles = await engine.perms.roles(sid).catch(() => []);
  const roleName = (id) => { const r = roles.find((x) => x.id === id); return r ? `@${plainName(r.name)}` : 'a deleted role'; };
  const items = doc.items.slice(0, MAX_ITEMS);
  const server = await engine.perms.server(sid).catch(() => null);
  const title = `🛒 ${server?.name ? `${plainName(server.name)} shop` : 'Shop'}`;
  if (!items.length) {
    return {
      embeds: [card({ title, body: 'The shop is empty right now.\n-# Admins can stock it: `/shop add role @Supporter 500` or `/shop add item "Golden ticket" 200`.', color: 'economy' })],
      components: [],
    };
  }
  const lines = items.map((it) => `🛒 **${plainName(it.name)}** · ${price(cur, it.price)}${it.roleId ? ` · gives ${roleName(it.roleId)}` : ''}${stockText(it)}`);
  const body = `${lines.join('\n')}\n\n-# Pick something below to buy it. Earn ${cur.name} with /daily and /balance work.`;
  const embeds = [card({ title, body, color: 'economy' })];
  const wallet = row(button('My wallet', cid('wallet'), 'secondary', '👛'));
  const soldOut = (it) => it.stock !== null && it.stock !== undefined && it.stock <= 0;
  if (mode === 'select') {
    const options = items.map((it) => ({
      label: `${it.name} · ${fmt(it.price)}`,
      value: it.id,
      description: soldOut(it) ? 'Sold out' : it.roleId ? `Gives ${roleName(it.roleId)}` : 'Goes to your inventory',
      emoji: '🛒',
    }));
    return { embeds, components: [select(cid('pick'), options, { placeholder: 'Pick something to buy' }), wallet] };
  }
  const itemButtons = items.map((it) => button(`${it.name} · ${fmt(it.price)}`, cid('buy', it.id), soldOut(it) ? 'secondary' : 'primary', '🛒', { disabled: soldOut(it) }));
  return { embeds, components: [...rows(itemButtons).slice(0, 4), wallet] };
}

function trackShop(engine, sid, sent, channelId, mode) {
  const m = sent?.message ?? sent;
  if (!m?.id) return;
  mutate(engine, sid, (doc) => {
    doc.shopMsgs = doc.shopMsgs.filter((x) => x.m !== m.id);
    doc.shopMsgs.push({ c: m.channel_id || channelId, m: m.id, mode });
    if (doc.shopMsgs.length > MAX_SHOP_MESSAGES) doc.shopMsgs.splice(0, doc.shopMsgs.length - MAX_SHOP_MESSAGES);
  });
}

async function refreshShops(engine, sid) {
  const list = readDoc(engine, sid).shopMsgs;
  if (!list.length) return;
  const views = {};
  for (const entry of list) {
    try {
      views[entry.mode] ||= await shopView(engine, sid, entry.mode);
      const v = views[entry.mode];
      engine.budget.edit({ channelId: entry.c, messageId: entry.m, content: '', opts: { embeds: v.embeds, components: v.components } }).catch((e) => {
        if (e?.status === 404 || e?.status === 403) mutate(engine, sid, (doc) => { doc.shopMsgs = doc.shopMsgs.filter((x) => x.m !== entry.m); });
        else engine.log.debug('[economy] shop refresh failed', e?.message);
      });
    } catch (e) {
      engine.log.debug('[economy] shop refresh failed', e?.message);
    }
  }
}

async function postShop(ctx) {
  const { engine, serverId: sid } = ctx;
  if (!readDoc(engine, sid).items.length) return ctx.reply({ ...(await shopView(engine, sid, 'select')), open: true });
  return engine.caps.attempt(sid, 'selects',
    async () => {
      const sent = await ctx.reply({ ...(await shopView(engine, sid, 'select')), open: true });
      trackShop(engine, sid, sent, ctx.channelId, 'select');
      return sent;
    },
    async () => {
      const sent = await ctx.reply({ ...(await shopView(engine, sid, 'buttons')), open: true });
      trackShop(engine, sid, sent, ctx.channelId, 'buttons');
      return sent;
    });
}

async function walletView(ctx, targetId, { self = true } = {}) {
  const { engine, serverId: sid } = ctx;
  const cur = currencyOf(engine, sid);
  const cfg = ctx.config();
  const doc = readDoc(engine, sid);
  const u = doc.users[targetId] || blankUser(clampSetting(cfg.startBalance, 0), 0);
  const t = clock(engine);
  const list = ranked(engine, sid);
  const pos = list.findIndex((x) => x.id === targetId);
  const name = await displayName(engine, sid, targetId);
  const alive = u.lastDaily && t - u.lastDaily <= STREAK_GRACE_MS ? u.streak || 0 : 0;
  const dailyOn = clampSetting(cfg.dailyAmount, 100) > 0;
  const dailyLeft = u.lastDaily ? u.lastDaily + DAY - t : 0;
  const workLeft = u.lastWork ? u.lastWork + WORK_COOLDOWN_MS - t : 0;
  const inv = Object.values(u.inv || {}).filter((x) => x && x.n > 0);
  const fields = [
    { name: 'Wallet', value: `${fmt(u.bal || 0)} ${plural(u.bal || 0, cur.name)} ${cur.emoji}`, inline: true },
    { name: 'Rank', value: pos >= 0 ? `#${pos + 1} of ${fmt(list.length)}` : 'Not ranked yet', inline: true },
    { name: 'Daily streak', value: alive ? `${alive} day${alive === 1 ? '' : 's'}${alive > 1 ? ' 🔥' : ''}` : 'None yet', inline: true },
    { name: 'Daily', value: !dailyOn ? 'Off' : dailyLeft > 0 ? `in ${waitText(dailyLeft)}` : 'Ready!', inline: true },
    cfg.workEnabled !== false ? { name: 'Work', value: workLeft > 0 ? `in ${waitText(workLeft)}` : 'Ready!', inline: true } : null,
    { name: 'Inventory', value: clip(inv.map((x) => `${fmt(x.n)}× ${plainName(x.name)}`).join(', '), 1024) || 'Empty', inline: false },
  ];
  const body = self ? `Earn ${cur.name} with **/daily** and **/balance work**, spend them in **/shop**.` : null;
  const view = { embeds: [card({ title: `${cur.emoji} ${name}'s wallet`, body, fields, color: 'economy' })], components: [] };
  if (self) {
    const btns = dailyOn ? [button('Daily', cid('daily'), dailyLeft > 0 ? 'secondary' : 'success', '📅')] : [];
    if (cfg.workEnabled !== false) btns.push(button('Work', cid('work'), workLeft > 0 ? 'secondary' : 'success', '💼'));
    btns.push(button('Top 10', cid('top'), 'secondary', '🏆'), button('History', cid('history'), 'secondary', '📜'));
    view.components = [row(btns)];
  }
  return view;
}

async function showWallet(ctx, query, how = 'reply') {
  const q = String(query ?? '').trim();
  if (!q || /^me$/i.test(q)) return ctx[how](await walletView(ctx, ctx.userId, { self: true }));
  const found = await ctx.findUser(q);
  if (!found?.id) return ctx.warn("I couldn't find them", `Nobody here matches **${plainName(clip(q, 40))}**. Try a mention, like \`/balance @sam\`.`);
  if (found.id === ctx.userId) return ctx[how](await walletView(ctx, ctx.userId, { self: true }));
  const m = await memberOf(ctx.engine, ctx.serverId, found.id);
  if (isBotMember(ctx.engine, m, found.id)) return ctx.info('Bots have no wallet', "Bots don't collect coins. Their pockets are full of code.");
  return ctx[how](await walletView(ctx, found.id, { self: false }));
}

async function claimDaily(ctx) {
  const { engine, serverId: sid } = ctx;
  const cfg = ctx.config();
  const cur = currencyOf(engine, sid);
  const base = clampSetting(cfg.dailyAmount, 100);
  if (base <= 0) return ctx.info('Daily is off', 'An admin turned the daily reward off for this server.');
  const t = clock(engine);
  const res = mutate(engine, sid, (doc) => {
    const u = ensureUser(doc, ctx.userId, cfg, t);
    if (u.lastDaily && t - u.lastDaily < DAY) return { wait: u.lastDaily + DAY - t, streak: u.streak || 0 };
    const kept = u.lastDaily && t - u.lastDaily <= STREAK_GRACE_MS;
    const lost = !kept && (u.streak || 0) > 1 ? u.streak : 0;
    u.streak = kept ? (u.streak || 0) + 1 : 1;
    u.lastDaily = t;
    const bonus = streakBonus(u.streak);
    const amount = Math.round(base * (100 + bonus) / 100);
    const got = change(u, amount, `Daily (day ${u.streak})`, t);
    return { got, bonus, streak: u.streak, bal: u.bal, lost };
  });
  if (res.wait) {
    return ctx.warn('Already claimed today', `Your next daily is ready in **${waitText(res.wait)}**.${res.streak > 1 ? ` Keep your **${res.streak}-day streak** 🔥 going!` : ''}`);
  }
  const streakText = res.streak > 1 ? `day ${res.streak} streak 🔥` : 'day 1';
  const extra = [];
  if (res.bonus) extra.push(`Streak bonus +${res.bonus}%${res.bonus >= STREAK_MAX ? ' (max)' : ''}.`);
  if (res.lost) extra.push(`Your ${res.lost}-day streak ended, so this is a fresh start.`);
  const body = `Balance **${fmt(res.bal)}** · next daily in ${waitText(DAY)}${extra.length ? `\n-# ${extra.join(' ')}` : ''}`;
  return ctx.reply({ embeds: [card({ title: `${cur.emoji} +${fmt(res.got)} ${plural(res.got, cur.name)} (${streakText})`, body, color: 'economy', footer: false })] });
}

async function doBeg(ctx) {
  const { engine, serverId: sid } = ctx;
  const cfg = ctx.config();
  if (cfg.begEnabled === false) return ctx.info('Begging is off', 'An admin turned off **/beg** here. **/daily** still works.');
  const cur = currencyOf(engine, sid);
  const t = clock(engine);
  const miss = Math.random() < BEG_MISS;
  const pay = miss ? 0 : BEG_MIN + Math.floor(Math.random() * (BEG_MAX - BEG_MIN + 1));
  const res = mutate(engine, sid, (doc) => {
    const u = ensureUser(doc, ctx.userId, cfg, t);
    if (u.lastBeg && t - u.lastBeg < BEG_COOLDOWN_MS) return { wait: u.lastBeg + BEG_COOLDOWN_MS - t };
    u.lastBeg = t;
    const got = pay ? change(u, pay, 'Begging', t) : 0;
    return { got, bal: u.bal };
  });
  if (res.wait) return ctx.warn('Give it a rest', `People are tired of you asking. Try again in **${waitText(res.wait)}**.`);
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  const line = res.got ? fillTemplate(pick(BEG_YES), { amount: `${money(cur, res.got)} ${cur.emoji}` }) : pick(BEG_NO);
  return ctx.reply({ embeds: [card({ title: res.got ? '🥺 Someone helped' : '🥺 No luck', body: `${line}\nBalance **${fmt(res.bal)}** · beg again in ${waitText(BEG_COOLDOWN_MS)}`, color: 'economy', footer: false })] });
}

async function doWork(ctx) {
  const { engine, serverId: sid } = ctx;
  const cfg = ctx.config();
  if (cfg.workEnabled === false) return ctx.info('Work is off', 'An admin turned off **/balance work** here. **/daily** still works.');
  const cur = currencyOf(engine, sid);
  const lo = Math.max(1, clampSetting(cfg.workMin, 20));
  const hi = Math.max(lo, clampSetting(cfg.workMax, 80));
  const t = clock(engine);
  const pay = lo + Math.floor(Math.random() * (hi - lo + 1));
  const res = mutate(engine, sid, (doc) => {
    const u = ensureUser(doc, ctx.userId, cfg, t);
    if (u.lastWork && t - u.lastWork < WORK_COOLDOWN_MS) return { wait: u.lastWork + WORK_COOLDOWN_MS - t };
    u.lastWork = t;
    const got = change(u, pay, 'Work', t);
    return { got, bal: u.bal };
  });
  if (res.wait) return ctx.warn('Take a break', `You're worn out. You can work again in **${waitText(res.wait)}**.`);
  const line = fillTemplate(JOBS[Math.floor(Math.random() * JOBS.length)], { amount: `${money(cur, res.got)} ${cur.emoji}` });
  return ctx.reply({ embeds: [card({ title: '💼 Shift done', body: `${line}\nBalance **${fmt(res.bal)}** · work again in ${waitText(WORK_COOLDOWN_MS)}`, color: 'economy', footer: false })] });
}

async function topView(ctx) {
  const { engine, serverId: sid } = ctx;
  const cur = currencyOf(engine, sid);
  const list = ranked(engine, sid);
  const members = await ctx.members().catch(() => []);
  const nameOf = (id) => { const m = members.find((x) => x.id === id); return m ? nameOfMember(m) : 'someone who left'; };
  const lines = list.slice(0, TOP_SIZE).map((x, i) => `${MEDALS[i] || `**${i + 1}.**`} ${nameOf(x.id)} · ${price(cur, x.bal)}`);
  const pos = list.findIndex((x) => x.id === ctx.userId);
  const mine = pos >= 0 ? `You: **#${pos + 1}** · ${price(cur, list[pos].bal)}` : `You aren't ranked yet. Grab your **/daily**!`;
  const body = lines.length ? `${lines.join('\n')}\n\n${mine}` : `Nobody has any ${cur.name} yet. Be the first with **/daily**!`;
  const server = await engine.perms.server(sid).catch(() => null);
  return { embeds: [card({ title: `🏆 Richest in ${server?.name ? plainName(server.name) : 'this server'}`, body, color: 'economy' })] };
}

async function historyView(ctx, targetId) {
  const { engine, serverId: sid } = ctx;
  const cur = currencyOf(engine, sid);
  const u = readDoc(engine, sid).users[targetId];
  const t = clock(engine);
  const name = await displayName(engine, sid, targetId);
  const list = (u?.hist || []).slice().reverse();
  const lines = list.map(([at, delta, reason]) => `${delta >= 0 ? '➕' : '➖'} ${delta >= 0 ? '+' : '−'}${fmt(Math.abs(delta))} ${cur.emoji} · ${plainName(reason)} · ${agoText(t - at)}`);
  const body = lines.length ? lines.join('\n') : `No ${cur.name} have moved yet.`;
  const title = lines.length ? `📜 ${name}'s last ${lines.length} change${lines.length === 1 ? '' : 's'}` : `📜 ${name}'s history`;
  return { embeds: [card({ title, body: `${body}\n-# Balance now: ${fmt(u?.bal ?? balanceOf(engine, sid, targetId))} ${cur.emoji} · the last ${MAX_HISTORY} changes are kept.`, color: 'economy' })] };
}

async function showHistory(ctx, query) {
  const q = String(query ?? '').trim();
  if (!q || /^me$/i.test(q)) return ctx.ephemeral(await historyView(ctx, ctx.userId));
  const lvl = await ctx.level();
  const found = await ctx.findUser(q);
  if (!found?.id) return ctx.warn("I couldn't find them", `Nobody here matches **${plainName(clip(q, 40))}**.`);
  if (found.id !== ctx.userId && !ctx.engine.perms.atLeast(lvl, 'admin')) {
    return ctx.ephemeral({ embeds: [dialog.denied('admin', { body: "Only admins can see someone else's history. You can see your own with `/balance history`." })] });
  }
  return ctx.ephemeral(await historyView(ctx, found.id));
}

async function startPay(ctx, tokens) {
  const { engine, serverId: sid } = ctx;
  const cur = currencyOf(engine, sid);
  const { amount, before, after } = splitAmount(tokens);
  const who = [...before, ...after].join(' ').trim();
  if (amount === null || !who) return ctx.warn('Pay who, and how much?', 'Try `/balance pay @sam 50`.');
  if (!validAmount(amount)) return ctx.warn("That amount didn't work", `Pay a whole number from 1 to ${fmt(MAX_AMOUNT)}, like \`/balance pay @sam 50\`.`);
  const target = await findMember(ctx, who, 'who to pay');
  if (target.problem) return ctx.warn(...target.problem);
  if (target.id === ctx.userId) return ctx.warn("You can't pay yourself", 'Nice try! Your coins are already yours.');
  if (isBotMember(engine, target.member, target.id)) return ctx.warn("Bots can't take coins", 'Pay a person instead.');
  const have = balanceOf(engine, sid, ctx.userId);
  if (have < amount) return ctx.warn(`Not enough ${cur.name}`, `You have ${price(cur, have)} and tried to pay ${price(cur, amount)}.`);
  if (amount > PAY_CONFIRM_OVER) {
    const s = engine.router.session({ sid, from: ctx.userId, to: target.id, amount, name: target.name });
    return ctx.ephemeral({
      embeds: [dialog.warn('Big payment', `Send ${money(cur, amount)} ${cur.emoji} to **${target.name}**?\nYou'll have ${price(cur, have - amount)} left. Payments can't be taken back.`)],
      components: [row(button(`Send ${fmt(amount)}`, cid('payok', s, ctx.userId), 'success', '💸'), button('Cancel', cid('payno', s, ctx.userId), 'secondary'))],
    });
  }
  return finishPay(ctx, { from: ctx.userId, to: target.id, amount, name: target.name }, 'reply');
}

async function finishPay(ctx, p, how) {
  const { engine, serverId: sid } = ctx;
  const cur = currencyOf(engine, sid);
  const fromName = await displayName(engine, sid, p.from);
  const ok = mutatePay(engine, sid, p, fromName);
  if (!ok) {
    const have = balanceOf(engine, sid, p.from);
    const embed = dialog.warn(`Not enough ${cur.name}`, `You have ${price(cur, have)} now, so ${price(cur, p.amount)} didn't go through.`);
    return how === 'update' ? ctx.update({ embeds: [embed], components: [] }) : ctx.ephemeral({ embeds: [embed] });
  }
  const after = balanceOf(engine, sid, p.from);
  const embed = card({ title: `💸 ${fromName} paid ${p.name}`, body: `${money(cur, p.amount)} ${cur.emoji} sent. ${fromName} has ${price(cur, after)} left.`, color: 'economy', footer: false });
  return how === 'update' ? ctx.update({ embeds: [embed], components: [] }) : ctx.reply({ embeds: [embed] });
}

function mutatePay(engine, sid, p, fromName) {
  const t = clock(engine);
  const cfg = cfgOf(engine, sid);
  return mutate(engine, sid, (doc) => {
    const from = ensureUser(doc, p.from, cfg, t);
    if ((from.bal || 0) < p.amount) return false;
    const to = ensureUser(doc, p.to, cfg, t);
    if (!doc.users[p.from]) doc.users[p.from] = from;
    change(from, -p.amount, `Paid ${p.name}`, t);
    change(to, p.amount, `From ${fromName}`, t);
    return true;
  });
}

async function runBalance(ctx, tokensIn) {
  const tokens = tokensIn ?? (ctx.argv.length ? ctx.argv : tokenize(ctx.args));
  const sub = (tokens[0] || '').toLowerCase();
  const rest = tokens.slice(1);
  if (['pay', 'give', 'send', 'transfer'].includes(sub)) return startPay(ctx, rest);
  if (['work', 'job', 'shift'].includes(sub)) return doWork(ctx);
  if (['beg', 'plead'].includes(sub)) return doBeg(ctx);
  if (['top', 'leaderboard', 'lb', 'rich', 'richest'].includes(sub)) return ctx.reply(await topView(ctx));
  if (['history', 'log', 'hist'].includes(sub)) return showHistory(ctx, rest.join(' '));
  if (sub === 'daily') return claimDaily(ctx);
  return showWallet(ctx, tokens.join(' '));
}

async function openBuy(ctx, itemId) {
  const { engine, serverId: sid } = ctx;
  const doc = readDoc(engine, sid);
  const cur = currencyOf(engine, sid);
  const item = doc.items.find((it) => it.id === itemId);
  if (!item) return ctx.warn('That item is gone', 'It was taken out of the shop. Run **/shop** for the current list.');
  if (item.stock !== null && item.stock !== undefined && item.stock <= 0) return ctx.warn('Sold out', `**${plainName(item.name)}** is sold out. An admin can restock it with \`/shop stock\`.`);
  let roleLine = 'It goes into your inventory (see **/balance**).';
  if (item.roleId) {
    const me = await memberOf(engine, sid, ctx.userId);
    if (me?.roles?.includes(item.roleId)) return ctx.info('You already have it', `You already have the role from **${plainName(item.name)}**, so there's nothing to buy.`);
    const check = await roleProblem(engine, sid, item.roleId);
    if (check.reason) return pausedItem(ctx, item, check.reason, 'ephemeral');
    roleLine = `You get the **@${plainName(check.role.name)}** role.`;
  } else {
    const inv = doc.users[ctx.userId]?.inv || {};
    if (!inv[item.id] && Object.keys(inv).length >= MAX_INVENTORY) return ctx.warn('Inventory full', `You can hold ${MAX_INVENTORY} different items. Ask an admin to clear some out.`);
  }
  const have = balanceOf(engine, sid, ctx.userId);
  if (have < item.price) return ctx.warn(`Not enough ${cur.name}`, `**${plainName(item.name)}** costs ${price(cur, item.price)} and you have ${price(cur, have)}. You need ${price(cur, item.price - have)} more.\n-# Earn ${cur.name} with /daily and /balance work.`);
  const ticket = buyTicket(engine, sid, ctx.userId, item);
  return ctx.ephemeral({
    embeds: [card({ title: `🛒 Buy ${plainName(item.name)}?`, body: `Price **${price(cur, item.price)}** · you have ${price(cur, have)}, so ${price(cur, have - item.price)} after.\n${roleLine}`, color: 'economy', footer: false })],
    components: [row(button(`Buy for ${fmt(item.price)}`, cid('buyok', ticket, ctx.userId), 'success', '🛒'), button('Cancel', cid('buyno', ticket, ctx.userId), 'secondary'))],
  });
}

async function pausedItem(ctx, item, reason, how) {
  const { engine, serverId: sid } = ctx;
  const key = `${sid}:${item.id}:${reason}`;
  if (!warned.has(key)) {
    if (warned.size > 2000) warned.clear();
    warned.add(key);
    await modLog(engine, sid, card({ title: `${ICONS.economy} Shop item paused`, body: `Someone tried to buy **${plainName(item.name)}**, but I can't hand out its role: ${reason}\nFix the role, or take the item out with \`/shop remove\`.`, color: 'economy' }), `economy:paused:${item.id}`);
  }
  const embed = dialog.warn("Can't sell this right now", `**${plainName(item.name)}** is paused: ${reason}\nNo ${currencyOf(engine, sid).name} were taken. I've let the admins know.`);
  return how === 'update' ? ctx.update({ embeds: [embed], components: [] }) : ctx.ephemeral({ embeds: [embed] });
}

function buyTicket(engine, sid, uid, item) {
  return engine.router.session({ kind: 'buy', sid, uid, itemId: item.id, price: item.price });
}

async function completeBuy(ctx) {
  const { engine, serverId: sid } = ctx;
  const ticket = engine.router.getSession(ctx.argv[0]);
  if (!ticket || ticket.kind !== 'buy' || ticket.sid !== sid || ticket.uid !== ctx.userId) {
    return ctx.update({ embeds: [dialog.info('Already handled', 'This purchase was already made, cancelled or expired, so nothing more was taken.\n-# Pick the item again in **/shop** to buy another.')], components: [] });
  }
  engine.router.dropSession(ctx.argv[0]);
  const { itemId, price: priceArg } = ticket;
  const lock = `${sid}:${ctx.userId}`;
  if (busy.has(lock)) return ctx.info('One moment', "I'm still finishing your last purchase.");
  busy.add(lock);
  try {
    return await buyNow(ctx, itemId, Number(priceArg));
  } finally {
    busy.delete(lock);
  }
}

async function buyNow(ctx, itemId, agreed) {
  const { engine, serverId: sid } = ctx;
  const cur = currencyOf(engine, sid);
  const cfg = ctx.config();
  const done = (embed) => ctx.update({ embeds: [embed], components: [] });
  const item = readDoc(engine, sid).items.find((it) => it.id === itemId);
  if (!item) return done(dialog.warn('That item is gone', 'It was taken out of the shop, so nothing was bought.'));
  if (item.price !== agreed) return done(dialog.warn('The price changed', `**${plainName(item.name)}** now costs ${price(cur, item.price)}. Pick it again in **/shop** if you still want it.`));
  let roleName = null;
  if (item.roleId) {
    const me = await memberOf(engine, sid, ctx.userId);
    if (me?.roles?.includes(item.roleId)) return done(dialog.info('You already have it', 'Nothing was taken.'));
    const check = await roleProblem(engine, sid, item.roleId);
    if (check.reason) return pausedItem(ctx, item, check.reason, 'update');
    roleName = plainName(check.role.name);
  }
  const t = clock(engine);
  const res = mutate(engine, sid, (doc) => {
    const it = doc.items.find((x) => x.id === itemId);
    if (!it || it.price !== agreed) return { gone: true };
    if (it.stock !== null && it.stock !== undefined && it.stock <= 0) return { soldOut: true };
    const u = ensureUser(doc, ctx.userId, cfg, t);
    if ((u.bal || 0) < it.price) return { short: u.bal || 0 };
    u.inv ||= {};
    if (!it.roleId && !u.inv[it.id] && Object.keys(u.inv).length >= MAX_INVENTORY) return { full: true };
    change(u, -it.price, `Bought ${it.name}`, t);
    if (it.stock !== null && it.stock !== undefined) it.stock -= 1;
    it.sold = (it.sold || 0) + 1;
    if (!it.roleId) {
      const slot = u.inv[it.id] || { name: it.name, n: 0 };
      slot.name = it.name;
      slot.n = Math.min(MAX_STACK, slot.n + 1);
      u.inv[it.id] = slot;
    }
    return { ok: true, bal: u.bal, limited: it.stock !== null && it.stock !== undefined };
  });
  if (res.gone) return done(dialog.warn('That item changed', 'Nothing was bought. Run **/shop** for the current list.'));
  if (res.soldOut) return done(dialog.warn('Sold out', `Someone got the last **${plainName(item.name)}** first. Nothing was taken.`));
  if (res.full) return done(dialog.warn('Inventory full', `You can hold ${MAX_INVENTORY} different items. Nothing was taken.`));
  if (res.short !== undefined) return done(dialog.warn(`Not enough ${cur.name}`, `You have ${price(cur, res.short)} and it costs ${price(cur, item.price)}. Nothing was taken.`));
  if (item.roleId) {
    try {
      await engine.bot.addRole(sid, ctx.userId, item.roleId);
      engine.perms.invalidate(`m:${sid}:${ctx.userId}`);
    } catch (e) {
      refund(engine, sid, ctx.userId, itemId, item, res.limited);
      if (res.limited) refreshShops(engine, sid).catch(() => {});
      const why = e?.status === 403 ? `My role must be above **@${roleName}** and have Manage Roles.` : "Yapin' didn't let me give the role just now.";
      return done(dialog.error("Couldn't give the role", `${why} Your ${price(cur, item.price)} went back to your wallet.`));
    }
  }
  if (res.limited) refreshShops(engine, sid).catch(() => {});
  const got = item.roleId ? `You now have the **@${roleName}** role. Enjoy!` : `It's in your inventory. See it with **/balance**.`;
  return done(dialog.ok(`Bought ${plainName(item.name)}`, `${got}\nPaid ${price(cur, item.price)} · balance ${price(cur, res.bal)}`, { footer: false }));
}

function refund(engine, sid, uid, itemId, item, limited) {
  const t = clock(engine);
  const cfg = cfgOf(engine, sid);
  mutate(engine, sid, (doc) => {
    const u = ensureUser(doc, uid, cfg, t);
    change(u, item.price, `Refund: ${item.name}`, t);
    const it = doc.items.find((x) => x.id === itemId);
    if (it) {
      if (limited && it.stock !== null && it.stock !== undefined) it.stock += 1;
      it.sold = Math.max(0, (it.sold || 0) - 1);
    }
  });
}

const SHOP_SUBS = ['add', 'remove', 'stock', 'price', 'buy', 'list'];

async function runShop(ctx) {
  const tokens = ctx.argv.length ? ctx.argv : tokenize(ctx.args);
  const sub = (tokens[0] || '').toLowerCase();
  const rest = tokens.slice(1);
  if (!sub || sub === 'list' || sub === 'show') return postShop(ctx);
  if (sub === 'buy') {
    const item = findItem(readDoc(ctx.engine, ctx.serverId).items, rest.join(' '));
    if (!item) return ctx.warn("I couldn't find that item", 'Run **/shop** to see what is for sale.');
    return openBuy(ctx, item.id);
  }
  if (['add', 'new', 'create'].includes(sub)) { await ctx.require('admin'); return shopAdd(ctx, rest); }
  if (['remove', 'delete', 'del', 'rm'].includes(sub)) { await ctx.require('admin'); return shopRemove(ctx, rest); }
  if (['stock', 'restock', 'limit'].includes(sub)) { await ctx.require('admin'); return shopStock(ctx, rest); }
  if (['price', 'cost'].includes(sub)) { await ctx.require('admin'); return shopPrice(ctx, rest); }
  const item = findItem(readDoc(ctx.engine, ctx.serverId).items, tokens.join(' '));
  if (item) return openBuy(ctx, item.id);
  const guess = didYouMean(sub, SHOP_SUBS);
  return ctx.warn("I didn't get that", `I don't know **${plainName(clip(sub, 30))}**.${guess.length ? ` Did you mean ${guess.map((g) => `**${g}**`).join(', ')}?` : ''}\nTry \`/shop\` on its own to see the shop.`);
}

async function shopAdd(ctx, tokens) {
  const { engine, serverId: sid } = ctx;
  const cur = currencyOf(engine, sid);
  let kind = (tokens[0] || '').toLowerCase();
  let rest = tokens.slice(1);
  if (kind !== 'role' && kind !== 'item') {
    if (tokens[0] && roleMention(tokens[0])) { kind = 'role'; rest = tokens; } else {
      return ctx.warn('A role or an item?', 'Try `/shop add role @Supporter 500` (sells a role) or `/shop add item "Golden ticket" 200` (goes to the inventory).');
    }
  }
  const last = rest[rest.length - 1];
  const cost = parseAmount(last);
  const what = rest.slice(0, -1).join(' ').trim();
  if (cost === null || !what) return ctx.warn('Name and price, please', kind === 'role' ? 'Try `/shop add role @Supporter 500`.' : 'Try `/shop add item "Golden ticket" 200`.');
  if (!validAmount(cost)) return ctx.warn("That price didn't work", `Use a whole number from 1 to ${fmt(MAX_AMOUNT)}.`);
  const items = readDoc(engine, sid).items;
  if (kind === 'role') {
    const role = await ctx.findRole(what);
    if (!role) return ctx.warn("I couldn't find that role", `Nothing here matches **${plainName(clip(what, 40))}**. Try a mention, like @Supporter.`);
    const check = await roleProblem(engine, sid, role.id);
    if (check.reason) return ctx.warn("I can't sell that role", check.reason);
    const top = await actorTop(engine, sid, ctx.userId);
    if (typeof role.position === 'number' && role.position >= top) return ctx.warn("I can't sell that role", `**@${plainName(role.name)}** is at or above your highest role, so you can't sell it.`);
    const existing = items.find((it) => it.roleId === role.id);
    if (existing) {
      mutate(engine, sid, (doc) => { const it = doc.items.find((x) => x.id === existing.id); if (it) it.price = cost; });
      refreshShops(engine, sid).catch(() => {});
      return ctx.ok('Price updated', `**@${plainName(role.name)}** was already in the shop. It now costs ${price(cur, cost)}.`);
    }
    if (items.length >= MAX_ITEMS) return ctx.warn('The shop is full', `It holds ${MAX_ITEMS} items. Take one out with \`/shop remove\` first.`);
    const item = addItem(engine, sid, { name: clip(plainName(role.name), MAX_ITEM_NAME), roleId: role.id, price: cost });
    refreshShops(engine, sid).catch(() => {});
    return ctx.ok('Added to the shop', `🛒 **${plainName(item.name)}** · ${price(cur, cost)} · gives @${plainName(role.name)}\n-# Limit how many sell with \`/shop stock "${item.name}" 10\`.`);
  }
  const name = clip(readableMentions(what).replace(/[\r\n]+/g, ' ').replace(/[<>*_~`|\\@]/g, '').replace(/\s+/g, ' ').trim(), MAX_ITEM_NAME);
  if (!name) return ctx.warn("That name didn't work", 'Give the item a plain name, like "Golden ticket".');
  const existing = items.find((it) => !it.roleId && it.name.toLowerCase() === name.toLowerCase());
  if (existing) {
    mutate(engine, sid, (doc) => { const it = doc.items.find((x) => x.id === existing.id); if (it) it.price = cost; });
    refreshShops(engine, sid).catch(() => {});
    return ctx.ok('Price updated', `**${name}** was already in the shop. It now costs ${price(cur, cost)}.`);
  }
  if (items.length >= MAX_ITEMS) return ctx.warn('The shop is full', `It holds ${MAX_ITEMS} items. Take one out with \`/shop remove\` first.`);
  addItem(engine, sid, { name, roleId: null, price: cost });
  refreshShops(engine, sid).catch(() => {});
  return ctx.ok('Added to the shop', `🛒 **${name}** · ${price(cur, cost)} · goes to the buyer's inventory\n-# Limit how many sell with \`/shop stock "${name}" 10\`.`);
}

function addItem(engine, sid, { name, roleId, price: cost }) {
  return mutate(engine, sid, (doc) => {
    doc.seq += 1;
    const item = { id: `i${doc.seq.toString(36)}`, name, roleId, price: cost, stock: null, sold: 0 };
    doc.items.push(item);
    return item;
  });
}

function itemList(items) {
  return items.map((it, i) => `**${i + 1}.** ${plainName(it.name)}`).join('\n');
}

async function shopRemove(ctx, tokens) {
  const { engine, serverId: sid } = ctx;
  const items = readDoc(engine, sid).items;
  if (!items.length) return ctx.info('The shop is empty', 'There is nothing to take out.');
  const q = tokens.join(' ');
  const item = q ? findItem(items, q) : null;
  if (!item) return ctx.warn(q ? "I couldn't find that item" : 'Remove which item?', `Use its name or number, like \`/shop remove 2\`.\n${itemList(items)}`);
  let saved = null;
  mutate(engine, sid, (doc) => {
    const idx = doc.items.findIndex((x) => x.id === item.id);
    if (idx >= 0) saved = { idx, item: doc.items.splice(idx, 1)[0] };
  });
  refreshShops(engine, sid).catch(() => {});
  if (!saved) return ctx.info('Already gone', 'That item was already out of the shop.');
  const undo = adminUndo(ctx, `remove ${clip(item.name, 30)}`, async () => {
    mutate(engine, sid, (doc) => {
      if (doc.items.some((x) => x.id === saved.item.id) || doc.items.length >= MAX_ITEMS) return;
      doc.items.splice(Math.min(saved.idx, doc.items.length), 0, saved.item);
    });
    refreshShops(engine, sid).catch(() => {});
  });
  return ctx.ok('Taken out of the shop', `**${plainName(item.name)}** is gone from the shop. People who bought it keep it.`, { components: [row(undo.button)] });
}

async function shopStock(ctx, tokens) {
  const { engine, serverId: sid } = ctx;
  const items = readDoc(engine, sid).items;
  if (!items.length) return ctx.info('The shop is empty', 'Add something first with `/shop add`.');
  const last = (tokens[tokens.length - 1] || '').toLowerCase();
  const unlimited = ['off', 'none', 'unlimited', 'infinite', 'clear', '∞'].includes(last);
  const n = unlimited ? null : parseAmount(last);
  if (!unlimited && (n === null || Number.isNaN(n))) return ctx.warn('How many?', 'Try `/shop stock "Golden ticket" 10`, or `/shop stock "Golden ticket" off` for no limit.');
  if (!unlimited && (n < 0 || n > MAX_STOCK)) return ctx.warn("That stock didn't work", `Use a whole number from 0 to ${fmt(MAX_STOCK)}.`);
  const q = tokens.slice(0, -1).join(' ');
  const item = q ? findItem(items, q) : items.length === 1 ? items[0] : null;
  if (!item) return ctx.warn(q ? "I couldn't find that item" : 'Which item?', `Name it, like \`/shop stock 2 ${unlimited ? 'off' : n}\`.\n${itemList(items)}`);
  mutate(engine, sid, (doc) => { const it = doc.items.find((x) => x.id === item.id); if (it) it.stock = unlimited ? null : n; });
  refreshShops(engine, sid).catch(() => {});
  return ctx.ok('Stock saved', unlimited ? `**${plainName(item.name)}** has no limit now.` : `**${plainName(item.name)}**: ${fmt(n)} left${n === 0 ? ' (sold out)' : ''}.`);
}

async function shopPrice(ctx, tokens) {
  const { engine, serverId: sid } = ctx;
  const cur = currencyOf(engine, sid);
  const items = readDoc(engine, sid).items;
  const cost = parseAmount(tokens[tokens.length - 1]);
  const item = findItem(items, tokens.slice(0, -1).join(' ')) || (items.length === 1 && tokens.length === 1 ? items[0] : null);
  if (!item || cost === null) return ctx.warn('Which item, and what price?', `Try \`/shop price 2 750\`.${items.length ? `\n${itemList(items)}` : ''}`);
  if (!validAmount(cost)) return ctx.warn("That price didn't work", `Use a whole number from 1 to ${fmt(MAX_AMOUNT)}.`);
  mutate(engine, sid, (doc) => { const it = doc.items.find((x) => x.id === item.id); if (it) it.price = cost; });
  refreshShops(engine, sid).catch(() => {});
  return ctx.ok('Price saved', `**${plainName(item.name)}** now costs ${price(cur, cost)}.`);
}

function adminUndo(ctx, label, revert) {
  const { engine, serverId: sid } = ctx;
  return engine.router.addUndo({
    serverId: sid, actorId: ctx.userId, label, perm: 'admin',
    run: async (i) => {
      if (i?.server_id && i.server_id !== sid) throw friendly('That Undo button belongs to another server, so it does nothing here.', { title: 'Wrong server' });
      if (i?.user_id) await engine.perms.require(sid, i.user_id, 'admin');
      return revert();
    },
  });
}

async function settingsView(ctx) {
  const { engine, serverId: sid } = ctx;
  const cfg = ctx.config();
  const cur = currencyOf(engine, sid);
  const list = ranked(engine, sid);
  const total = list.reduce((a, x) => a + x.bal, 0);
  const items = readDoc(engine, sid).items;
  const work = cfg.workEnabled !== false;
  const fields = [
    { name: 'Currency', value: `${cur.emoji} ${cur.name}`, inline: true },
    { name: 'Daily', value: clampSetting(cfg.dailyAmount, 100) > 0 ? `${price(cur, clampSetting(cfg.dailyAmount, 100))} · streak bonus up to +${STREAK_MAX}%` : 'Off', inline: true },
    { name: 'Work', value: `${onOff(work)} · ${fmt(clampSetting(cfg.workMin, 20))} to ${fmt(clampSetting(cfg.workMax, 80))} ${cur.emoji}, once an hour`, inline: false },
    { name: 'Starting balance', value: price(cur, clampSetting(cfg.startBalance, 0)), inline: true },
    { name: 'Shop', value: `${items.length}/${MAX_ITEMS} items`, inline: true },
    { name: 'Members with coins', value: `${fmt(list.length)} · ${price(cur, total)} in total`, inline: true },
  ];
  const body = 'Members earn with /daily and /balance work, pay each other and spend in /shop.\nTyped settings: `/economy give @sam 100` · `/economy take @sam 50` · `/economy reset @sam` · `/economy daily 150` · `/economy work 20 80` · `/economy currency gems 💎` · `/economy start 50`';
  return {
    embeds: [card({ title: `${ICONS.economy} Economy settings`, body, fields, color: 'economy' })],
    components: [
      row(
        button('Currency', cid('curform'), 'secondary', '✏️'),
        button('Daily amount', cid('dailyform'), 'secondary', '📅'),
        button(work ? 'Work: on' : 'Work: off', cid('twork'), work ? 'success' : 'secondary', '💼'),
        button('Work pay', cid('workform'), 'secondary', '💰'),
        button('Starting balance', cid('startform'), 'secondary', '🎒'),
      ),
      row(
        button('Give coins', cid('giveform'), 'primary', '➕'),
        button('Take coins', cid('takeform'), 'secondary', '➖'),
        button('Reset someone', cid('resetform'), 'danger', '🧽'),
      ),
    ],
  };
}

const ownsPanel = (ctx) => {
  const messageId = ctx.source?.message_id;
  return !!messageId && ctx.engine.router.panelOwner(messageId) === ctx.userId;
};

async function showSettings(ctx) {
  await ctx.require('admin');
  return ctx.ephemeral(await settingsView(ctx));
}

async function adminMove(ctx, tokens, dir) {
  const { engine, serverId: sid } = ctx;
  await ctx.require('admin');
  const cur = currencyOf(engine, sid);
  const { amount, before, after } = splitAmount(tokens);
  const who = before.join(' ').trim();
  const reason = clip(readableMentions(after.join(' ')).replace(/\s+/g, ' ').trim(), MAX_REASON);
  const verb = dir > 0 ? 'give' : 'take';
  if (amount === null || !who) return ctx.warn(`${dir > 0 ? 'Give' : 'Take'} how much, to whom?`, `Try \`/economy ${verb} @sam 100 prize\`.`);
  if (!validAmount(amount)) return ctx.warn("That amount didn't work", `Use a whole number from 1 to ${fmt(MAX_AMOUNT)}.`);
  const target = await findMember(ctx, who);
  if (target.problem) return ctx.warn(...target.problem);
  if (isBotMember(engine, target.member, target.id)) return ctx.warn("Bots can't hold coins", 'Pick a person instead.');
  const actor = await displayName(engine, sid, ctx.userId);
  const t = clock(engine);
  const cfg = ctx.config();
  const moved = mutate(engine, sid, (doc) => {
    const u = ensureUser(doc, target.id, cfg, t);
    const real = change(u, dir * amount, `${dir > 0 ? 'Given' : 'Taken'} by ${actor}${reason ? `: ${reason}` : ''}`, t);
    return { real: Math.abs(real), bal: u.bal };
  });
  if (!moved.real) return ctx.info('Nothing changed', dir > 0 ? `**${target.name}** is at the wallet limit.` : `**${target.name}** has no ${cur.name} to take.`);
  await modLog(engine, sid, card({ title: `${ICONS.economy} ${dir > 0 ? 'Coins given' : 'Coins taken'}`, body: `**${actor}** ${dir > 0 ? 'gave' : 'took'} ${money(cur, moved.real)} ${cur.emoji} ${dir > 0 ? 'to' : 'from'} **${target.name}**.${reason ? `\nReason: ${plainName(reason)}` : ''}\nNew balance: ${price(cur, moved.bal)}`, color: 'economy' }));
  const undo = adminUndo(ctx, `${verb} ${fmt(moved.real)}`, async () => {
    const t2 = clock(engine);
    mutate(engine, sid, (doc) => {
      const u = ensureUser(doc, target.id, cfgOf(engine, sid), t2);
      change(u, -dir * moved.real, `Undo: ${dir > 0 ? 'gift' : 'take'} by ${actor}`, t2);
    });
  });
  const partial = dir < 0 && moved.real < amount ? ` (all they had)` : '';
  return ctx.ok(dir > 0 ? 'Coins given' : 'Coins taken', `${dir > 0 ? 'Gave' : 'Took'} ${money(cur, moved.real)} ${cur.emoji}${partial} ${dir > 0 ? 'to' : 'from'} **${target.name}**. They have ${price(cur, moved.bal)} now.`, { components: [row(undo.button)] });
}

async function resetUser(ctx, query) {
  const { engine, serverId: sid } = ctx;
  await ctx.require('admin');
  const q = String(query ?? '').trim();
  if (!q) return ctx.warn('Reset who?', 'Try `/economy reset @sam`.');
  const found = await ctx.findUser(q);
  if (!found?.id) return ctx.warn("I couldn't find them", `Nobody here matches **${plainName(clip(q, 40))}**.`);
  const name = await displayName(engine, sid, found.id);
  const saved = readDoc(engine, sid).users[found.id];
  if (!saved) return ctx.info('Nothing to reset', `**${name}** has no wallet yet.`);
  mutate(engine, sid, (doc) => { delete doc.users[found.id]; });
  const cur = currencyOf(engine, sid);
  const undo = adminUndo(ctx, `reset of ${clip(name, 30)}`, async () => {
    mutate(engine, sid, (doc) => { doc.users[found.id] = saved; });
  });
  return ctx.ok('Wallet reset', `**${name}** starts over: their ${price(cur, saved.bal || 0)}, streak, history and inventory are cleared. Roles they bought stay.`, { components: [row(undo.button)] });
}

async function setCurrency(ctx, tokens) {
  const parts = [...tokens];
  let emoji = '';
  if (parts.length > 1 && cleanEmoji(parts[parts.length - 1]) && !/^[a-z0-9]+$/i.test(parts[parts.length - 1])) emoji = cleanEmoji(parts.pop());
  return saveCurrency(ctx, parts.join(' '), emoji);
}

const NAME_HELP = 'Use 1 to 20 plain letters, like **gems** or **star dust**.';
const EMOJI_HELP = 'Use one emoji, like 💎.';
const DAILY_HELP = `Use a whole number from 0 to ${fmt(MAX_SETTING)} (0 turns daily off).`;
const WORK_HELP = `Use whole numbers from 1 to ${fmt(MAX_SETTING)}, like \`/economy work 20 80\`.`;
const START_HELP = `Use a whole number from 0 to ${fmt(MAX_SETTING)}.`;

function workPair(loText, hiText) {
  const lo = numberIn(loText, { min: 1 });
  const hi = numberIn(hiText ?? loText, { min: 1 });
  if (lo === null || hi === null) return null;
  return lo <= hi ? [lo, hi] : [hi, lo];
}

async function saveCurrency(ctx, nameText, emojiText) {
  const name = cleanCurrencyName(nameText);
  if (!name) return ctx.warn("That name didn't work", NAME_HELP);
  const patch = { currencyName: name };
  if (emojiText !== undefined && String(emojiText).trim()) {
    const emoji = cleanEmoji(emojiText);
    if (!emoji) return ctx.warn("That emoji didn't work", EMOJI_HELP);
    patch.currencyEmoji = emoji;
  }
  ctx.patchConfig(patch);
  const cur = currencyOf(ctx.engine, ctx.serverId);
  return ctx.ok('Currency saved', `Your server pays in **${cur.name}** ${cur.emoji} now. Balances stay the same.`);
}

function numberIn(text, { min = 0, max = MAX_SETTING } = {}) {
  const n = parseAmount(String(text ?? '').trim());
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

async function saveDaily(ctx, text) {
  const n = numberIn(text, { min: 0 });
  if (n === null) return ctx.warn("That amount didn't work", DAILY_HELP);
  ctx.patchConfig({ dailyAmount: n });
  const cur = currencyOf(ctx.engine, ctx.serverId);
  return ctx.ok('Daily saved', n ? `/daily gives ${price(cur, n)}, plus up to +${STREAK_MAX}% for streaks.` : '/daily is off now.');
}

async function saveWork(ctx, loText, hiText) {
  const pair = workPair(loText, hiText);
  if (!pair) return ctx.warn("That pay didn't work", WORK_HELP);
  const [a, b] = pair;
  ctx.patchConfig({ workMin: a, workMax: b });
  const cur = currencyOf(ctx.engine, ctx.serverId);
  return ctx.ok('Work pay saved', `A shift pays ${fmt(a)} to ${fmt(b)} ${cur.emoji}, once an hour.`);
}

async function saveStart(ctx, text) {
  const n = numberIn(text, { min: 0 });
  if (n === null) return ctx.warn("That amount didn't work", START_HELP);
  ctx.patchConfig({ startBalance: n });
  const cur = currencyOf(ctx.engine, ctx.serverId);
  return ctx.ok('Starting balance saved', `New wallets start with ${price(cur, n)}. Existing wallets don't change.`);
}

const ECON_SUBS = ['give', 'take', 'reset', 'currency', 'daily', 'work', 'start', 'settings'];

const amountField = (key, label, help, min, error) => ({
  key, label, help, type: 'number', web: true, min, max: MAX_SETTING, step: 1,
  validate: (ctx, v) => {
    const n = numberIn(v, { min });
    return n === null ? reject(error) : accept(n);
  },
});

const workField = (key, label, help) => ({
  ...amountField(key, label, help, 1, WORK_HELP),
  save: (ctx, value, all) => {
    const cfg = ctx.config();
    const other = key === 'workMin' ? 'workMax' : 'workMin';
    const otherValue = all && all[other] !== undefined && numberIn(all[other], { min: 1 }) !== null ? numberIn(all[other], { min: 1 }) : cfg[other];
    const pair = key === 'workMin' ? workPair(value, otherValue) : workPair(otherValue, value);
    if (!pair) return { error: WORK_HELP };
    ctx.patchConfig({ workMin: pair[0], workMax: pair[1] });
    return { applied: { workMin: pair[0], workMax: pair[1] } };
  },
});

const DASHBOARD = [
  {
    key: 'currencyName', label: 'Currency name', type: 'string', web: true, maxLength: 20,
    help: 'What your coins are called, like gems or star dust.',
    validate: (ctx, v) => {
      const name = cleanCurrencyName(v);
      return name ? accept(name) : reject(NAME_HELP);
    },
  },
  {
    key: 'currencyEmoji', label: 'Currency emoji', type: 'emoji', web: true, maxLength: 80,
    help: 'The emoji shown next to prices and balances.',
    validate: (ctx, v) => {
      const emoji = cleanEmoji(v);
      return emoji ? accept(emoji) : reject(EMOJI_HELP);
    },
  },
  amountField('dailyAmount', 'Daily reward', 'Coins from /daily, before the streak bonus. 0 turns /daily off.', 0, DAILY_HELP),
  workField('workMin', 'Work pay (lowest)', 'The least a shift of /balance work pays.'),
  workField('workMax', 'Work pay (highest)', 'The most a shift of /balance work pays.'),
  boolField({ key: 'workEnabled', label: '/balance work enabled', help: 'Lets members earn coins once an hour with /balance work.' }),
  boolField({ key: 'begEnabled', label: '/beg enabled', help: 'Lets members beg for a few coins.' }),
  amountField('startBalance', 'Starting balance', 'Coins every new wallet starts with. Existing wallets do not change.', 0, START_HELP),
];

async function runEconomy(ctx) {
  await ctx.require('admin');
  const tokens = ctx.argv.length ? ctx.argv : tokenize(ctx.args);
  const sub = (tokens[0] || '').toLowerCase();
  const rest = tokens.slice(1);
  if (!sub || sub === 'settings' || sub === 'panel') return showSettings(ctx);
  if (['give', 'add', 'grant'].includes(sub)) return adminMove(ctx, rest, 1);
  if (['take', 'remove', 'deduct'].includes(sub)) return adminMove(ctx, rest, -1);
  if (sub === 'reset') return resetUser(ctx, rest.join(' '));
  if (sub === 'currency' || sub === 'name') {
    if (!rest.length) return ctx.info('Currency', `Now: ${currencyOf(ctx.engine, ctx.serverId).emoji} ${currencyOf(ctx.engine, ctx.serverId).name}. Change it with \`/economy currency gems 💎\`.`);
    return setCurrency(ctx, rest);
  }
  if (sub === 'emoji') {
    const emoji = cleanEmoji(rest[0]);
    if (!emoji) return ctx.warn("That emoji didn't work", 'Try `/economy emoji 💎`.');
    ctx.patchConfig({ currencyEmoji: emoji });
    return ctx.ok('Emoji saved', `Prices show ${emoji} now.`);
  }
  if (sub === 'daily') return saveDaily(ctx, rest[0]);
  if (sub === 'work') {
    const v = (rest[0] || '').toLowerCase();
    if (['on', 'off', 'enable', 'disable', 'yes', 'no'].includes(v)) {
      const on = ['on', 'enable', 'yes'].includes(v);
      ctx.patchConfig({ workEnabled: on });
      return ctx.ok('Saved', on ? '**/balance work** is on.' : '**/balance work** is off. /daily still works.');
    }
    if (!rest.length) return ctx.warn('Work pay', 'Try `/economy work 20 80`, `/economy work on` or `/economy work off`.');
    return saveWork(ctx, rest[0], rest[1]);
  }
  if (sub === 'start' || sub === 'starting') return saveStart(ctx, rest[0]);
  const guess = didYouMean(sub, ECON_SUBS);
  return ctx.warn("I didn't get that", `I don't know **${plainName(clip(sub, 30))}**.${guess.length ? ` Did you mean ${guess.map((g) => `**${g}**`).join(', ')}?` : ''}\nTry \`/economy\` on its own for the settings panel.`);
}

const admin = (run) => ({ perm: 'admin', run: async (ctx) => { await ctx.require('admin'); return run(ctx); } });
const refresh = async (ctx) => (ownsPanel(ctx) ? ctx.update(await settingsView(ctx)) : ctx.ephemeral(await settingsView(ctx)));
const ownerOnly = (argIndex, run) => ({
  run: async (ctx) => {
    if (ctx.argv[argIndex] !== ctx.userId) return ctx.ephemeral({ embeds: [dialog.denied(null, { title: 'Not yours', body: 'This button is for the person who opened it. Run the command yourself to get your own.' })] });
    return run(ctx);
  },
});

export const { setup, teardown, check } = defineApp({
  id: ID,
  name: 'Economy',
  icon: ICONS.economy,
  description: 'Coins, daily rewards, work, payments and a shop.',
  category: 'Fun',
  panelPerm: 'member',

  defaults: {
    currencyName: DEFAULT_CURRENCY.name,
    currencyEmoji: DEFAULT_CURRENCY.emoji,
    dailyAmount: 100,
    workMin: 20,
    workMax: 80,
    workEnabled: true,
    begEnabled: true,
    startBalance: 0,
  },

  commands: {
    daily: { description: 'Claim your daily coins. Come back every day for a streak bonus: /daily', run: claimDaily },
    beg: { description: 'Beg for a few coins. Sometimes people help, sometimes not: /beg', run: doBeg },
    balance: { description: 'Your wallet: /balance, /balance @sam, /balance pay @sam 50, work, top, history', run: (ctx) => runBalance(ctx) },
    shop: { description: 'The server shop: /shop, /shop buy Name. Admins: /shop add role @Supporter 500', run: runShop },
    economy: { description: 'Economy settings (admins): /economy give @sam 100, take, reset @sam, daily 150', perm: 'admin', run: runEconomy },
  },

  components: {
    daily: { run: claimDaily },
    work: { run: doWork },
    beg: { run: doBeg },
    top: { run: async (ctx) => ctx.reply(await topView(ctx)) },
    history: { run: (ctx) => showHistory(ctx, '') },
    wallet: { run: async (ctx) => ctx.ephemeral(await walletView(ctx, ctx.userId, { self: true })) },
    pick: { run: (ctx) => openBuy(ctx, (ctx.values || [])[0]) },
    buy: { run: (ctx) => openBuy(ctx, ctx.argv[0]) },
    buyok: ownerOnly(1, completeBuy),
    buyno: ownerOnly(1, (ctx) => {
      const ticket = ctx.engine.router.getSession(ctx.argv[0]);
      if (ticket?.kind === 'buy' && ticket.uid === ctx.userId) ctx.engine.router.dropSession(ctx.argv[0]);
      return ctx.update({ embeds: [dialog.info('Cancelled', 'Nothing was bought.')], components: [] });
    }),
    payok: ownerOnly(1, async (ctx) => {
      const s = ctx.engine.router.getSession(ctx.argv[0]);
      if (!s || s.sid !== ctx.serverId || s.from !== ctx.userId) return ctx.update({ embeds: [dialog.info('Already handled', 'This payment was already sent, cancelled or expired. Nothing more happened.')], components: [] });
      ctx.engine.router.dropSession(ctx.argv[0]);
      return finishPay(ctx, s, 'update');
    }),
    payno: ownerOnly(1, (ctx) => {
      ctx.engine.router.dropSession(ctx.argv[0]);
      return ctx.update({ embeds: [dialog.info('Cancelled', 'No coins were sent.')], components: [] });
    }),
    twork: admin(async (ctx) => { ctx.patchConfig({ workEnabled: ctx.config().workEnabled === false }); return refresh(ctx); }),
    curform: admin((ctx) => {
      const cur = currencyOf(ctx.engine, ctx.serverId);
      return ctx.form({ title: 'Currency', action: 'cursave', fields: [
        { id: 'name', label: 'Name (like coins, gems, star dust)', style: 'short', value: cur.name, max: 20 },
        { id: 'emoji', label: 'Emoji', style: 'short', value: cur.emoji, max: 80 },
      ] });
    }),
    cursave: admin((ctx) => saveCurrency(ctx, ctx.values?.name, ctx.values?.emoji)),
    dailyform: admin((ctx) => ctx.form({ title: 'Daily amount', action: 'dailysave', fields: [
      { id: 'amount', label: 'Coins per /daily (0 turns it off)', style: 'short', value: String(clampSetting(ctx.config().dailyAmount, 100)), max: 9 },
    ] })),
    dailysave: admin((ctx) => saveDaily(ctx, ctx.values?.amount)),
    workform: admin((ctx) => ctx.form({ title: 'Work pay', action: 'worksave', fields: [
      { id: 'min', label: 'Lowest pay per shift', style: 'short', value: String(clampSetting(ctx.config().workMin, 20)), max: 9 },
      { id: 'max', label: 'Highest pay per shift', style: 'short', value: String(clampSetting(ctx.config().workMax, 80)), max: 9 },
    ] })),
    worksave: admin((ctx) => saveWork(ctx, ctx.values?.min, ctx.values?.max)),
    startform: admin((ctx) => ctx.form({ title: 'Starting balance', action: 'startsave', fields: [
      { id: 'amount', label: 'Coins a new wallet starts with', style: 'short', value: String(clampSetting(ctx.config().startBalance, 0)), max: 9 },
    ] })),
    startsave: admin((ctx) => saveStart(ctx, ctx.values?.amount)),
    giveform: admin((ctx) => ctx.form({ title: 'Give coins', action: 'givesave', fields: [
      { id: 'user', label: 'Who? (@name or username)', style: 'short', placeholder: '@sam', max: 100 },
      { id: 'amount', label: 'How many?', style: 'short', placeholder: '100', max: 13 },
      { id: 'reason', label: 'Reason (optional)', style: 'short', required: false, max: MAX_REASON },
    ] })),
    givesave: admin((ctx) => adminMove(ctx, [...tokenize(ctx.values?.user), String(ctx.values?.amount ?? '').trim() || 'x', ...tokenize(ctx.values?.reason)], 1)),
    takeform: admin((ctx) => ctx.form({ title: 'Take coins', action: 'takesave', fields: [
      { id: 'user', label: 'Who? (@name or username)', style: 'short', placeholder: '@sam', max: 100 },
      { id: 'amount', label: 'How many?', style: 'short', placeholder: '100', max: 13 },
      { id: 'reason', label: 'Reason (optional)', style: 'short', required: false, max: MAX_REASON },
    ] })),
    takesave: admin((ctx) => adminMove(ctx, [...tokenize(ctx.values?.user), String(ctx.values?.amount ?? '').trim() || 'x', ...tokenize(ctx.values?.reason)], -1)),
    resetform: admin((ctx) => ctx.form({ title: 'Reset a wallet', action: 'resetsave', fields: [
      { id: 'user', label: 'Who? (@name or username)', style: 'short', placeholder: '@sam', max: 100 },
    ] })),
    resetsave: admin((ctx) => resetUser(ctx, ctx.values?.user)),
  },

  yap: [
    { words: ['daily'], run: claimDaily },
    { words: ['beg', 'plead'], run: doBeg },
    { words: ['balance', 'bal', 'wallet', 'coins', 'money'], run: (ctx) => runBalance(ctx, ctx.argv) },
    { words: ['pay', 'work', 'richest'], run: (ctx) => runBalance(ctx, [ctx.word, ...ctx.argv]) },
    { words: ['shop', 'store', 'buy'], run: (ctx) => (ctx.word === 'buy' ? runShopTokens(ctx, ['buy', ...ctx.argv]) : runShopTokens(ctx, ctx.argv)) },
    {
      words: ['economy'],
      run: async (ctx) => {
        if (!ctx.engine.perms.atLeast(await ctx.level(), 'admin')) return showWallet(ctx, '', 'reply');
        return runEconomy(ctx);
      },
    },
  ],

  panel: async (ctx) => {
    if (ctx.engine.perms.atLeast(await ctx.level(), 'admin')) return showSettings(ctx);
    return ctx.ephemeral(await walletView(ctx, ctx.userId, { self: true }));
  },

  dashboard: DASHBOARD,

  services: (engine) => ({
    ranked: (sid) => ranked(engine, sid),
    currency: (sid) => currencyOf(engine, sid),
    balance: (sid, uid) => {
      needIds(sid, uid);
      if (uid === botId(engine)) return 0;
      return balanceOf(engine, sid, uid);
    },
    add: (sid, uid, amount, reason) => serviceAdd(engine, sid, uid, amount, reason),
    take: (sid, uid, amount, reason) => serviceTake(engine, sid, uid, amount, reason),
    transfer: (sid, fromId, toId, amount, reason) => serviceTransfer(engine, sid, fromId, toId, amount, reason),
    enabled: (sid) => engine.settings.isEnabled(sid, ID),
  }),

  presets: {
    gaming: { enabled: true, config: { dailyAmount: 100 } },
    friends: { enabled: true, config: {} },
    study: { enabled: false, config: {} },
    community: { enabled: true, config: { dailyAmount: 100 } },
    roleplay: { enabled: true, config: { currencyName: 'gold', currencyEmoji: '🪙' } },
  },

  help: [
    '/daily gives coins once a day. Claim again within 48 hours to keep your streak: +10% for each streak day, up to +100% from day 10.',
    '/balance work pays a little once an hour. Pay a friend with /balance pay @sam 50 (over 1,000 asks you to confirm). /balance top shows the richest 10, /balance history your last 20 changes.',
    'Admins: /shop add role @Supporter 500 · /shop add item "Golden ticket" 200 · /shop stock 1 10 · /shop price 1 750 · /shop remove 1 · /economy give @sam 100 · /economy reset @sam',
  ],

  dispose: () => { busy.clear(); warned.clear(); },
});

async function runShopTokens(ctx, tokens) {
  ctx.argv = tokens;
  return runShop(ctx);
}
