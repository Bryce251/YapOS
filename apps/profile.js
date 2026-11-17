import { defineApp } from '../engine/apps.js';
import { card, button, linkButton, row, COLORS } from '../engine/ui.js';
import { customId } from '../engine/router.js';
import { clip, parseBool } from '../engine/parse.js';
import { avatarUrl } from '../engine/links.js';
import { looksLikeFeatureOff } from '../engine/errors.js';
import { CURRENCY, seasonName, BADGE_NOTES } from '../engine/global.js';
import { profileData, partyOf, privacyOf, setPrivacy } from '../engine/profile-data.js';
import { profileSync, dropProfileSync } from '../engine/profiles-sync.js';
import { seasonSync, dropSeasonSync } from '../engine/seasons-sync.js';
import { renderProfileCard, decodeAvatar } from '../engine/profile-card.js';
import { PARTY_GAMES, PARTY_BADGES } from './levels.js';

const ID = 'profile';
const ICON = '🪪';
const cid = (action, ...args) => customId(ID, action, ...args);

const SYNC_EVERY_MS = 10 * 60_000;
const FIRST_SYNC_MS = 60_000;
const CARDS_PER_MINUTE = 8;
const WINDOW_MS = 60_000;
const AVATAR_MS = 1500;
const AVATAR_MAX_BYTES = 3 * 1024 * 1024;
const SITE = 'https://yapos.dev/u/';
const PRIVACY_WORDS = ['privacy', 'private', 'visibility', 'settings'];

const states = new WeakMap();
function stateOf(engine) {
  let s = states.get(engine);
  if (!s) {
    s = { sent: [], timer: null, first: null };
    states.set(engine, s);
  }
  return s;
}

const num = (n) => Math.max(0, Math.round(Number(n) || 0)).toLocaleString('en-US');
const nowOf = (engine) => engine.scheduler?.now?.() ?? Date.now();
const displayName = (m) => m?.nickname || m?.display_name || m?.username || 'Someone';
const plainName = (s) => String(s ?? '').replace(/[*_`~|\\<>@#]/g, '').replace(/\s+/g, ' ').trim();
const stripEmoji = (s) => String(s || '').replace(/^[^\p{L}\p{N}]+/u, '').trim();
const hexColour = (n) => `#${Number(n).toString(16).padStart(6, '0')}`;

export function partyGameName(id) {
  return PARTY_GAMES[id] || null;
}

export function badgeNames(ids) {
  return (ids || []).map((b) => PARTY_BADGES[b]).filter(Boolean);
}

export function badgeNotes(ids) {
  return [...new Set(ids || [])].filter((b) => BADGE_NOTES[b] && PARTY_BADGES[b]).map((b) => `${PARTY_BADGES[b]}: ${BADGE_NOTES[b]}`);
}

export function bestSeason(list) {
  const sorted = [...(list || [])].sort((a, b) => a.rank - b.rank || b.month.localeCompare(a.month));
  return sorted[0] || null;
}

const seasonLabel = (b) => `#${b.rank} ${b.kind === 'xp' ? 'XP' : CURRENCY.name} · ${seasonName(b.month)}`;

export function cardView(data, { name, username, viewerIsOwner }) {
  const lv = data.level || { level: 0, xp: 0, into: 0, need: 0, frac: 0 };
  const canSeeShards = viewerIsOwner || data.privacy.showShards;
  const party = data.party;
  const tiles = [
    { label: CURRENCY.name, value: !canSeeShards ? 'Private' : Number.isFinite(data.shards) ? num(data.shards) : '-', hidden: !canSeeShards },
    { label: 'Party wins', value: party && party.games > 0 ? `${num(party.wins)} of ${num(party.games)}` : 'None yet' },
    { label: 'Quests today', value: data.quests ? `${data.quests.done} / ${data.quests.total}` : '-' },
    { label: 'Achievements', value: num(data.achievements.length) },
  ];
  const foot = [];
  const best = bestSeason(data.season);
  if (best) foot.push(`Best season: ${seasonLabel(best)}`);
  const badges = badgeNames(party?.badges).map(stripEmoji);
  if (badges.length) foot.push(`Badges: ${badges.slice(0, 3).join(', ')}${badges.length > 3 ? ` +${badges.length - 3}` : ''}`);
  const fav = party?.fav ? stripEmoji(partyGameName(party.fav)) : null;
  if (fav) foot.push(`Loves ${fav}`);
  return {
    name: plainName(name) || 'Someone',
    username: username ? plainName(username) : null,
    level: lv.level,
    xp: lv.xp,
    into: lv.into,
    need: lv.need,
    frac: lv.frac,
    maxed: !lv.need,
    accent: data.clan?.colour || hexColour(COLORS.brand),
    clan: data.clan,
    tiles,
    footer: foot.join('   ·   '),
  };
}

export function embedView(data, view) {
  const lines = [
    `**Level ${num(view.level)}** · ${num(view.xp)} XP total`,
    view.maxed ? 'Max level' : `${num(view.into)} / ${num(view.need)} XP to the next level`,
  ];
  if (data.clan) lines.push(`Clan: **${data.clan.tag ? `[${data.clan.tag}] ` : ''}${clip(plainName(data.clan.name), 40)}**`);
  const fields = view.tiles.map((t) => ({ name: t.label, value: String(t.value), inline: true }));
  if (data.season.length) fields.push({ name: '🗓️ Seasons', value: data.season.slice(0, 3).map(seasonLabel).join('\n'), inline: false });
  const badges = badgeNames(data.party?.badges);
  if (badges.length) fields.push({ name: '🎉 Party badges', value: badges.slice(0, 6).join(' · '), inline: false });
  const notes = badgeNotes(data.party?.badges);
  if (notes.length) fields.push({ name: '⭐ Special badges', value: notes.join('\n'), inline: false });
  return card({ title: `${ICON} ${clip(view.name, 80)}`, body: lines.join('\n'), fields, color: data.clan?.colour ? parseInt(data.clan.colour.slice(1), 16) : 'brand' });
}

function privacyView(engine, uid, username) {
  const p = privacyOf(engine, uid);
  const link = username && !p.hidden ? `${SITE}${encodeURIComponent(username)}` : null;
  const body = [
    `**Public profile on yapos.dev:** ${p.hidden ? '🔒 hidden' : '🌐 shown'}`,
    `**${CURRENCY.name} on it:** ${p.showShards ? 'shown' : 'hidden'}`,
    '',
    'Your public page shows your name, level, badges, favourite games and season placings. It never shows which servers you are in.',
    `-# ${CURRENCY.name} only show if you turn them on. Changes reach yapos.dev within a few minutes.`,
  ].join('\n');
  return {
    embeds: [card({ title: '🔐 Profile privacy', body, color: 'info' })],
    components: [row(
      p.hidden ? button('Show my profile', cid('vis', uid, 'show'), 'success', '🌐') : button('Hide my profile', cid('vis', uid, 'hide'), 'danger', '🔒'),
      p.showShards ? button(`Hide my ${CURRENCY.name}`, cid('shards', uid, 'off'), 'secondary', CURRENCY.emoji) : button(`Show my ${CURRENCY.name}`, cid('shards', uid, 'on'), 'secondary', CURRENCY.emoji),
      link ? linkButton('Open my page', link, '🔗') : null,
    )],
  };
}

function changed(engine, uid) {
  const sync = profileSync(engine);
  sync.markDirty(uid);
  sync.push().catch((e) => engine.log.debug('[profile] pushing the privacy change failed', e?.message));
}

async function fetchAvatar(engine, target) {
  let path = target?.avatar_path ?? target?.avatar_url ?? null;
  if (!path && typeof engine.bot.user === 'function') {
    const u = await engine.bot.user(target.id).catch(() => null);
    path = u?.avatar_path ?? u?.avatar_url ?? null;
  }
  const url = avatarUrl(path);
  if (!url || typeof globalThis.fetch !== 'function') return null;
  try {
    const res = await globalThis.fetch(url, { signal: AbortSignal.timeout(AVATAR_MS) });
    if (!res.ok) return null;
    if (Number(res.headers?.get?.('content-length')) > AVATAR_MAX_BYTES) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return await decodeAvatar(buf);
  } catch {
    return null;
  }
}

function withTimeout(promise, ms) {
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
    timer.unref?.();
  });
  return Promise.race([promise.catch(() => null), late]).finally(() => clearTimeout(timer));
}

function canSendCard(engine, sid) {
  if (engine.caps.state(sid, 'files') === false) return false;
  const st = stateOf(engine);
  const t = nowOf(engine);
  st.sent = st.sent.filter((at) => t - at < WINDOW_MS);
  return st.sent.length < CARDS_PER_MINUTE;
}

async function resolveTarget(ctx, query) {
  const { engine } = ctx;
  if (query && !/^me$/i.test(query)) {
    const found = await ctx.findUser(query);
    if (!found?.id) return null;
    return found;
  }
  const me = await engine.perms.member(ctx.serverId, ctx.userId).catch(() => null);
  return me || { id: ctx.userId, username: ctx.username };
}

async function showProfile(ctx, query = '', how = 'reply') {
  const { engine } = ctx;
  const target = await resolveTarget(ctx, query);
  if (!target) return ctx.warn("I couldn't find them", `Nobody here matches **${clip(plainName(query), 40) || 'that'}**. Try a mention, like \`/profile @sam\`.`);
  if (target.id === engine.bot.me?.id) return ctx.info("I don't have a profile", "Bots don't level up or play Party games. Try `/profile` on yourself!");
  const self = target.id === ctx.userId;
  const [party, avatar] = await Promise.all([
    withTimeout(partyOf(engine, target.id), AVATAR_MS),
    canSendCard(engine, ctx.serverId) ? withTimeout(fetchAvatar(engine, target), AVATAR_MS) : Promise.resolve(null),
  ]);
  const data = profileData(engine, target.id, { party });
  const view = cardView(data, { name: displayName(target), username: target.username, viewerIsOwner: self });
  const components = self ? [row(button('Privacy', cid('privacy', target.id), 'secondary', '🔐'))] : [];
  const embedOnly = { embeds: [embedView(data, view)], components };
  if (how === 'reply' && canSendCard(engine, ctx.serverId)) {
    let png = null;
    try {
      png = renderProfileCard(view, { avatar });
    } catch (e) {
      engine.log.debug('[profile] drawing the card failed', e?.message);
    }
    if (png) {
      stateOf(engine).sent.push(nowOf(engine));
      try {
        const special = badgeNotes(data.party?.badges).map((n) => `\n-# ${n}`).join('');
        const out = await ctx.reply({ content: `${ICON} **${clip(view.name, 80)}**${special}`, files: [{ name: 'profile.png', data: png }], components });
        if (engine.caps.state(ctx.serverId, 'files') !== true) engine.caps.mark(ctx.serverId, 'files', true);
        return out;
      } catch (e) {
        engine.log.debug('[profile] sending the card picture failed', e?.message);
        if (looksLikeFeatureOff(e)) engine.caps.mark(ctx.serverId, 'files', false, e?.message);
      }
    }
  }
  return ctx[how](embedOnly);
}

async function privacyCommand(ctx, rest) {
  const { engine } = ctx;
  const uid = ctx.userId;
  const words = rest.map((w) => w.toLowerCase());
  if (words[0] === 'shards' || words[0] === CURRENCY.name.toLowerCase()) {
    const on = parseBool(words[1] || '');
    if (on === null || on === undefined) {
      const cur = privacyOf(engine, uid).showShards;
      setPrivacy(engine, uid, { showShards: !cur });
    } else setPrivacy(engine, uid, { showShards: on });
    changed(engine, uid);
  } else if (['hide', 'hidden', 'off', 'private'].includes(words[0])) {
    setPrivacy(engine, uid, { hidden: true });
    changed(engine, uid);
  } else if (['show', 'shown', 'on', 'public'].includes(words[0])) {
    setPrivacy(engine, uid, { hidden: false });
    changed(engine, uid);
  }
  return ctx.ephemeral(privacyView(engine, uid, ctx.username));
}

function helpCard() {
  return card({
    title: `${ICON} Profile`,
    body: [
      'Your YapOS card: level, XP, Shards, Party wins and badges, season placings, quests and clan.',
      '',
      '`/profile` · yours',
      '`/profile @sam` · someone else',
      '`/profile privacy` · hide or show your public page on yapos.dev',
      `\`/profile shards on\` · show your ${CURRENCY.name} on it (off by default)`,
    ].join('\n'),
    color: 'brand',
  });
}

async function runProfile(ctx) {
  const toks = ctx.argv.map(String);
  const first = (toks[0] || '').toLowerCase();
  if (first === 'help' || first === '?') return ctx.ephemeral({ embeds: [helpCard()] });
  if (PRIVACY_WORDS.includes(first)) return privacyCommand(ctx, toks.slice(1));
  if (['hide', 'show', 'public', 'private'].includes(first) && toks.length === 1) return privacyCommand(ctx, toks);
  if (first === 'shards' || first === CURRENCY.name.toLowerCase()) return privacyCommand(ctx, toks);
  return showProfile(ctx, toks.join(' ').trim());
}

function startTimer(engine) {
  const st = stateOf(engine);
  if (st.timer) clearInterval(st.timer);
  st.timer = setInterval(() => { syncNow(engine).catch(() => {}); }, SYNC_EVERY_MS);
  st.timer.unref?.();
  if (st.first) clearTimeout(st.first);
  st.first = setTimeout(() => { syncNow(engine).catch(() => {}); }, FIRST_SYNC_MS);
  st.first.unref?.();
}

export async function syncNow(engine) {
  await profileSync(engine).push().catch((e) => engine.log.debug('[profile] profile upload failed', e?.message));
  await seasonSync(engine).push().catch((e) => engine.log.debug('[profile] season upload failed', e?.message));
}

export const { setup, teardown, check } = defineApp({
  id: ID,
  name: 'Profile',
  icon: ICON,
  description: 'Your profile card with level, Shards, Party badges, seasons and quests.',
  category: 'Community',
  phase: 2,
  panelPerm: 'member',

  commands: {
    profile: { description: 'Your profile card: level, Shards, Party and seasons. /profile @sam · /profile privacy', run: runProfile },
  },

  components: {
    privacy: { owner: true, run: (ctx) => ctx.ephemeral(privacyView(ctx.engine, ctx.userId, ctx.username)) },
    vis: {
      owner: true,
      run: async (ctx) => {
        setPrivacy(ctx.engine, ctx.userId, { hidden: ctx.argv[1] === 'hide' });
        changed(ctx.engine, ctx.userId);
        return ctx.update(privacyView(ctx.engine, ctx.userId, ctx.username));
      },
    },
    shards: {
      owner: true,
      run: async (ctx) => {
        setPrivacy(ctx.engine, ctx.userId, { showShards: ctx.argv[1] === 'on' });
        changed(ctx.engine, ctx.userId);
        return ctx.update(privacyView(ctx.engine, ctx.userId, ctx.username));
      },
    },
  },

  yap: [
    { words: ['profile'], run: runProfile },
    { words: ['privacy'], run: (ctx) => privacyCommand(ctx, []) },
  ],

  panel: (ctx) => showProfile(ctx, '', 'ephemeral'),

  help: [
    '`/profile` shows your card: level, XP, Shards, Party wins and badges, season placings, quests done today and your clan.',
    '`/profile @sam` shows someone else. Their Shards stay private unless they chose to show them.',
    '`/profile privacy` hides or shows your public page on yapos.dev. It never shows which servers you are in.',
  ],

  init(engine) {
    profileSync(engine).install();
    seasonSync(engine).install();
    startTimer(engine);
  },

  dispose(engine) {
    dropProfileSync(engine);
    dropSeasonSync(engine);
    const st = states.get(engine);
    if (st?.timer) clearInterval(st.timer);
    if (st?.first) clearTimeout(st.first);
    states.delete(engine);
  },
});

