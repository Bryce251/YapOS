import { h as defaultH } from './dom.js';
import { profileAvatar } from '../profiles.js';
import { gameById } from '../games/index.js';
import { copyText } from './copy.js';
import { backdropFor } from '../../../js/avatar-backdrop.js';
import { ensureBackdropSheet } from './cardlook.js';
import { cleanPalette, readMotion, readCrop, cropBox, themeOf, paintTheme, gradientOf, readCustomGradient, customGradientOf, motionOk, ensureSheet, ensureFontSheet, createCardFx, pick, EFFECT_IDS, FEATURED_IDS } from './cardlook.js';
import { createClanJoin, joinState, clanParts, clanTagOk } from '../clanjoin.js';

export const PROFILE_CARD_ENDPOINT = '/api/activity/profile/';
export const CARD_CACHE_MS = 3 * 60 * 1000;
export const CARD_CACHE_MAX = 100;
export const DRAG_PX = 8;
export const CLOSE_MS = 220;
export const BADGES_SHOWN = 5;
export const FAVS_SHOWN = 3;
export const STATS_SHOWN = 4;
export const COPIED_MS = 2400;
export const PROFILE_SITE = 'https://yapos.dev';
export const CARD_MAX_W = 360;
export const BANNER_RATIO = 3;
export const LAYOUT = Object.freeze({ banner: CARD_MAX_W / BANNER_RATIO, top: 26, name: 28, pill: 20, pillGap: 3, sub: 66, xp: 20, pad: 8, stat: 44, sectionHead: 24, fav: 44, badge: 44, gap: 8, foot: 56, sheet: 8 });

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const HEX_RE = /^#[0-9a-f]{6}$/;
const PIN_RE = /^(ach:)?[a-z0-9][a-z0-9_-]{0,39}$/;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
export const GRADIENT_COLOURS = Object.freeze({ sunset: '#ff8a6b', ocean: '#6bc4ff', aurora: '#8ab4ff', candy: '#ff8fd1', forest: '#6fdc8c', gold: '#ffd66b' });
export const BANNERS = Object.freeze(['accent', 'sunset', 'ocean', 'aurora', 'forest', 'candy', 'midnight', 'dots', 'grid', 'stripes']);
export const RINGS = Object.freeze(['accent', 'rainbow', 'gold', 'glow']);
export const FONTS = Object.freeze([
  'rounded', 'caps', 'poppins', 'nunito', 'quicksand', 'comfortaa', 'lexend',
  'serif', 'playfair', 'lora', 'cinzel', 'cormorant', 'dmserif', 'lobster',
  'bebas', 'anton', 'righteous', 'bungee', 'archivo', 'blackops', 'russo',
  'pacifico', 'caveat', 'dancing', 'satisfy', 'greatvibes', 'marker', 'shadows', 'kalam',
  'fredoka', 'baloo', 'luckiest', 'bangers', 'chewy', 'sniglet',
  'pressstart', 'vt323', 'silkscreen', 'orbitron', 'audiowide', 'monoton',
  'creepster', 'fraktur', 'nosifer', 'metalmania',
  'mono', 'jetbrains', 'spacemono',
]);
export const PIN_MAX = 5;
export const BADGE_IMAGE_RE = /^\/badge-img\/c-[a-z0-9]{8}-[0-9a-f]{16}\.(png|webp|jpg)$/;
export const BANNER_IMAGE_RE = /^\/banner-img\/b-[a-z0-9]{10}-[0-9a-f]{16}\.(png|webp|jpg|gif)$/;
export const RARE = Object.freeze({ custom: 'One of a kind', special: 'Special' });
const FOCUSABLE = 'button, a, input, select, textarea, [tabindex]';
const INTERACTIVE = 'button, a, input, select, textarea, label, summary, [role="button"], [role="option"], [role="radio"], [role="checkbox"], [role="tab"], [role="menuitem"], [role="link"], [contenteditable]';

function num(n) {
  const v = Math.max(0, Math.floor(Number(n) || 0));
  return v.toLocaleString('en-US');
}

export function short(n) {
  const v = Math.max(0, Math.floor(Number(n) || 0));
  if (v < 100000) return num(v);
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: v < 1000000 ? 0 : 1 }).format(v);
}

function text(value, max = 64) {
  if (typeof value !== 'string') return null;
  const t = value.replace(/\s+/g, ' ').trim();
  if (!t) return null;
  const chars = Array.from(t);
  return chars.length > max ? chars.slice(0, max).join('') : t;
}

function hex(value) {
  return typeof value === 'string' && HEX_RE.test(value) ? value : null;
}

export function cleanLook(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const pins = [];
  for (const p of Array.isArray(raw.pins) ? raw.pins : []) {
    if (typeof p === 'string' && PIN_RE.test(p) && !pins.includes(p)) pins.push(p);
    if (pins.length >= PIN_MAX) break;
  }
  const customGrad = readCustomGradient(raw.nameGradientCustom);
  const gradient = !customGrad && typeof raw.nameGradient === 'string' && Object.prototype.hasOwnProperty.call(GRADIENT_COLOURS, raw.nameGradient) ? GRADIENT_COLOURS[raw.nameGradient] : null;
  const named = raw.nameColour && typeof raw.nameColour === 'object' ? raw.nameColour : null;
  const ac = raw.accent && typeof raw.accent === 'object' ? raw.accent : null;
  const accent = ac && hex(ac.base) ? { base: ac.base, text: hex(ac.dark) || ac.base, light: hex(ac.light) || ac.base } : null;
  const bannerImage = typeof raw.bannerImage === 'string' && BANNER_IMAGE_RE.test(raw.bannerImage) ? raw.bannerImage : null;
  const banner = raw.banner === 'image' ? (bannerImage ? 'image' : null) : BANNERS.includes(raw.banner) ? raw.banner : null;
  const status = text(raw.status, 60);
  const gradientId = gradient ? raw.nameGradient : null;
  const motion = banner === 'image' ? readMotion(raw.bannerMotion) : null;
  const palette = cleanPalette(raw.palette);
  const effect = pick(EFFECT_IDS, raw.effect, 'none');
  const featured = pick(FEATURED_IDS, raw.featured, 'level');
  const look = {
    pins,
    colour: customGrad ? customGrad.dark[0] : gradient || (named && hex(named.dark)),
    colourLight: customGrad ? customGrad.light[0] : gradientId ? null : named && hex(named.light),
    gradient: gradientId,
    customGrad,
    accent,
    banner,
    bannerImage: banner === 'image' ? bannerImage : null,
    bannerMotion: motion,
    bannerCrop: motion ? readCrop(raw.bannerCrop) : null,
    palette,
    effect: effect === 'none' ? null : effect,
    featured: featured === 'level' ? null : featured,
    ring: RINGS.includes(raw.ring) ? raw.ring : null,
    font: FONTS.includes(raw.nameFont) ? raw.nameFont : null,
    pronouns: text(raw.pronouns, 24),
    status,
    statusEmoji: text(raw.statusEmoji, 8),
  };
  return Object.values(look).some((v) => (Array.isArray(v) ? v.length : v)) ? look : null;
}

export function pinnedFirst(list, pins, prefix = '') {
  const keyed = list.map((b) => ({ ...b, pinned: pins.includes(`${prefix}${b.id}`) }));
  const order = (b) => pins.indexOf(`${prefix}${b.id}`);
  return [...keyed.filter((b) => b.pinned).sort((a, b) => order(a) - order(b)), ...keyed.filter((b) => !b.pinned)];
}

function initialsOf(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  const first = Array.from(parts[0])[0] || '';
  const second = parts.length > 1 ? Array.from(parts[parts.length - 1])[0] || '' : '';
  return (first + second).toUpperCase() || '?';
}

export function cleanCard(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.hidden === true) return { hidden: true, name: text(raw.name), avatar: profileAvatar(raw.avatar), avatarStill: profileAvatar(raw.avatarStill) };
  const list = (v) => (Array.isArray(v) ? v : []).filter((b) => b && typeof b.id === 'string').map((b) => {
    const out = { id: b.id.slice(0, 40), label: text(b.label, 48) || b.id.slice(0, 40), emoji: text(b.emoji, 16) };
    if (typeof b.image === 'string' && BADGE_IMAGE_RE.test(b.image)) out.image = b.image;
    const note = text(b.note, 100);
    if (note) out.note = note;
    if (b.rare === 'custom' || b.rare === 'special') out.rare = b.rare;
    return out;
  });
  const party = raw.party && typeof raw.party === 'object' ? raw.party : {};
  const prog = raw.progress && typeof raw.progress === 'object' ? { into: Math.max(0, Number(raw.progress.into) || 0), need: Math.max(1, Number(raw.progress.need) || 1) } : null;
  const rank = raw.rank && typeof raw.rank === 'object' && Number(raw.rank.rank) > 0 ? { rank: Math.floor(Number(raw.rank.rank)), points: Math.max(0, Number(raw.rank.points) || 0) } : null;
  const clan = raw.clan && typeof raw.clan === 'object' && text(raw.clan.name, 32) ? { name: text(raw.clan.name, 32), tag: text(raw.clan.tag, 6), colour: hex(typeof raw.clan.colour === 'string' ? raw.clan.colour.toLowerCase() : null) } : null;
  return {
    hidden: false,
    name: text(raw.name),
    username: text(raw.username),
    avatar: profileAvatar(raw.avatar),
    avatarStill: profileAvatar(raw.avatarStill),
    level: raw.level === null || raw.level === undefined ? null : Math.max(0, Math.floor(Number(raw.level) || 0)),
    progress: prog,
    shards: raw.shards === null || raw.shards === undefined ? null : Math.max(0, Number(raw.shards) || 0),
    badges: list(raw.badges),
    badgeCount: Math.max(0, Math.floor(Number(raw.badgeCount) || 0)),
    achievements: list(raw.achievements),
    clan,
    party: {
      games: Math.max(0, Math.floor(Number(party.games) || 0)),
      wins: Math.max(0, Math.floor(Number(party.wins) || 0)),
      bestStreak: Math.max(0, Math.floor(Number(party.bestStreak) || 0)),
      favourites: (Array.isArray(party.favourites) ? party.favourites : []).filter((f) => f && typeof f.game === 'string').slice(0, 3).map((f) => ({ game: f.game, played: Math.max(0, Math.floor(Number(f.played) || 0)) })),
    },
    rank,
    page: raw.page === true,
    likes: raw.likes === null || raw.likes === undefined || !Number.isFinite(Number(raw.likes)) ? null : Math.max(0, Math.floor(Number(raw.likes))),
    look: cleanLook(raw.look),
  };
}

function featuredStat(card, total, stats) {
  const id = card.look && card.look.featured;
  if (!id) return null;
  const key = id === 'winrate' ? 'rate' : id;
  const known = stats.find((s) => s.key === key);
  if (known) return known;
  if (id === 'badges') return { key, value: num(total), label: total === 1 ? 'Badge' : 'Badges' };
  if (id === 'shards' && card.shards !== null) return { key, value: short(card.shards), label: 'Shards' };
  return null;
}

export function cardModel(card) {
  const pins = card.look ? card.look.pins : [];
  const keyOf = (b) => (b.kind === 'achievement' ? `ach:${b.id}` : b.id);
  const merged = [...card.badges.map((b) => ({ ...b, kind: 'badge' })), ...card.achievements.map((b) => ({ ...b, kind: 'achievement' }))].map((b) => ({ ...b, pinned: pins.includes(keyOf(b)) }));
  const all = [...merged.filter((b) => b.pinned).sort((a, b) => pins.indexOf(keyOf(a)) - pins.indexOf(keyOf(b))), ...merged.filter((b) => !b.pinned)];
  const total = Math.max(card.badgeCount, card.badges.length) + card.achievements.length;
  const p = card.party;
  let stats = [
    { key: 'games', value: num(p.games), label: p.games === 1 ? 'Game' : 'Games' },
    { key: 'wins', value: num(p.wins), label: p.wins === 1 ? 'Win' : 'Wins' },
    { key: 'rate', value: p.games ? `${Math.round((p.wins / p.games) * 100)}%` : '–', label: 'Win rate' },
  ];
  if (p.bestStreak > 0) stats.push({ key: 'streak', value: num(p.bestStreak), label: 'Streak' });
  const feat = featuredStat(card, total, stats);
  if (feat) stats = [{ ...feat, featured: true }, ...stats.filter((s) => s.key !== feat.key)].slice(0, STATS_SHOWN);
  const facts = [];
  if (card.rank) {
    const pts = `${card.rank.points === 1 ? 'point' : 'points'}`;
    facts.push({ key: 'rank', icon: '🏆', text: `#${num(card.rank.rank)} · ${short(card.rank.points)} ${card.rank.points === 1 ? 'pt' : 'pts'}`, title: `#${num(card.rank.rank)} on the Party leaderboard with ${num(card.rank.points)} ${pts}`, top: card.rank.rank <= 3 ? card.rank.rank : 0 });
  }
  if (card.likes > 0) facts.push({ key: 'likes', icon: '❤️', text: `${short(card.likes)} ${card.likes === 1 ? 'like' : 'likes'}`, title: `${num(card.likes)} ${card.likes === 1 ? 'person likes' : 'people like'} this profile` });
  if (card.shards !== null && !(feat && feat.key === 'shards')) facts.push({ key: 'shards', icon: '💎', text: `${short(card.shards)} Shards`, title: `${num(card.shards)} Shards` });
  const favourites = p.favourites
    .map((f) => {
      const g = gameById(f.game);
      return g ? { id: g.id, name: g.name, emoji: g.emoji, played: f.played } : null;
    })
    .filter(Boolean)
    .slice(0, FAVS_SHOWN);
  const pinned = all.filter((b) => b.pinned).slice(0, PIN_MAX);
  return { stats, facts, favourites, pinned, row: all.slice(0, BADGES_SHOWN), all, total, unlisted: Math.max(0, total - all.length) };
}

export function bannerHeight(width = CARD_MAX_W) {
  const w = Number(width);
  return Math.ceil((Number.isFinite(w) && w > 0 ? w : CARD_MAX_W) / BANNER_RATIO);
}

export function cardHeight(status = 'ready', width = CARD_MAX_W) {
  const L = LAYOUT;
  const head = bannerHeight(width) + L.top + L.name + L.sub;
  if (status === 'ready' || status === 'loading') return head + L.xp + L.pad + L.stat + 2 * L.sectionHead + L.fav + L.badge + 2 * L.gap + L.foot + L.sheet;
  return head + L.pad + 96 + L.sheet;
}

export function profileUrl(handle, loc = null) {
  const local = loc && LOCAL_HOSTS.has(loc.hostname) && /^https?:$/.test(loc.protocol) && loc.origin;
  return `${local ? loc.origin : PROFILE_SITE}/u/${encodeURIComponent(handle)}`;
}

function resolve(value) {
  try {
    return typeof value === 'function' ? value() : value;
  } catch {
    return null;
  }
}

export function pillRows(L = LAYOUT) {
  return Math.floor((L.sub + L.pillGap) / (L.pill + L.pillGap));
}

export function createProfileCard({ win, h = defaultH, engine = null, me = null, alone = false, signin = null, now = () => Date.now(), clanPollMs = undefined } = {}) {
  const cache = new Map();
  let state = null;
  let opener = null;
  let token = 0;
  let closeTimer = null;
  let boundRoot = null;
  let down = null;
  const unbinders = [];

  let copyTimer = null;
  let revealed = null;
  let fx = null;
  let clanCtl = null;

  function effects() {
    if (!fx) fx = createCardFx({ win, doc: docOf() });
    return fx;
  }

  const closeBtn = h('button', { class: 'pcard-close', type: 'button', attrs: { 'aria-label': 'Close', title: 'Close' }, on: { click: () => close() } }, h('span', { text: '✕', attrs: { 'aria-hidden': 'true' } }));
  const body = h('div', { class: 'pcard-body' });
  const scroller = h('div', { class: 'pcard-scroll' }, h('div', { class: 'pcard-bar' }, closeBtn), body);
  const panel = h('section', { class: 'pcard', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'pcard-name', tabindex: '-1' } }, scroller);
  const backdrop = h('div', { class: 'pcard-backdrop', attrs: { 'aria-hidden': 'true' }, on: { click: () => close() } });
  const el = h('div', { class: 'pcard-layer', attrs: { hidden: true } }, backdrop, panel);
  el.hidden = true;
  el.addEventListener('keydown', onKey);

  function snapshot() {
    try {
      return engine && typeof engine.snapshot === 'function' ? engine.snapshot() : null;
    } catch {
      return null;
    }
  }

  function myId() {
    const v = resolve(me);
    if (v !== null && v !== undefined && v !== '') return String(v);
    const snap = snapshot();
    return snap && snap.me ? String(snap.me) : null;
  }

  function known(id, hint) {
    const snap = snapshot();
    const players = snap && Array.isArray(snap.players) ? snap.players : [];
    const p = players.find((x) => x && String(x.id) === id) || null;
    const base = { ...(hint || {}), ...(p || {}) };
    const name = text(base.name) || 'Player';
    return {
      name,
      username: text(base.username),
      avatar: typeof base.avatar === 'string' ? base.avatar : null,
      initials: text(base.initials, 3) || initialsOf(name),
      hue: Number.isFinite(Number(base.hue)) ? Number(base.hue) : 20,
      isMe: Boolean(base.isMe) || id === myId(),
      isHost: Boolean(p ? p.isHost : base.isHost),
      watching: Boolean(p && p.present && !p.joined && snap.room && snap.room.phase === 'game'),
      away: Boolean(p && p.present === false),
    };
  }

  function cached(id) {
    const hit = cache.get(id);
    if (!hit) return undefined;
    if (now() - hit.at > CARD_CACHE_MS || hit.at > now()) {
      cache.delete(id);
      return undefined;
    }
    return hit.card;
  }

  function remember(id, card) {
    cache.delete(id);
    cache.set(id, { at: now(), card });
    while (cache.size > CARD_CACHE_MAX) cache.delete(cache.keys().next().value);
  }

  async function load(id) {
    const fetcher = win && typeof win.fetch === 'function' ? win.fetch.bind(win) : null;
    if (!fetcher || !ID_RE.test(id)) throw new Error('offline');
    const res = await fetcher(`${PROFILE_CARD_ENDPOINT}${encodeURIComponent(id)}`, { credentials: 'omit', headers: { Accept: 'application/json' } });
    if (res.status === 404) return { none: true };
    if (!res.ok) throw new Error(`status ${res.status}`);
    const data = await res.json();
    const card = cleanCard(data && data.profile);
    if (!card) throw new Error('bad data');
    return card;
  }

  function fetchFor(id) {
    const mine = ++token;
    load(id)
      .then((card) => {
        remember(id, card);
        if (mine !== token || !state || state.id !== id) return;
        state = { ...state, card, status: card.none ? 'none' : card.hidden ? 'hidden' : 'ready' };
        paint();
      })
      .catch(() => {
        if (mine !== token || !state || state.id !== id) return;
        state = { ...state, status: 'error' };
        paint();
      });
  }

  function docOf() {
    return win && win.document ? win.document : globalThis.document;
  }

  function later(fn, ms) {
    if (copyTimer !== null && win && typeof win.clearTimeout === 'function') win.clearTimeout(copyTimer);
    copyTimer = win && typeof win.setTimeout === 'function' ? win.setTimeout(fn, ms) : null;
  }

  function stopTimers() {
    if (copyTimer !== null && win && typeof win.clearTimeout === 'function') win.clearTimeout(copyTimer);
    copyTimer = null;
  }

  function bone(extra) {
    return h('span', { class: ['pcard-bone', extra] });
  }

  function bannerEl(look) {
    const id = look && look.banner ? look.banner : look && (look.accent || look.palette) ? 'accent' : 'none';
    const motion = id === 'image' ? look.bannerMotion : null;
    const box = h('div', { class: ['pcard-banner', `banner-${id === 'image' ? 'accent' : id}`, motion ? 'is-moving' : null], attrs: { 'aria-hidden': 'true' } });
    if (id !== 'image') return box;
    const still = Boolean(motion) && !motionOk(win);
    const img = h('img', { class: ['pcard-banner-img', motion ? 'is-crop' : null, still ? 'is-still' : null], alt: '', attrs: { decoding: 'async', draggable: 'false' } });
    if (motion) {
      const crop = cropBox(motion.width, motion.height, look.bannerCrop);
      img.style.setProperty('--crop-w', `${crop.width}%`);
      img.style.setProperty('--crop-h', `${crop.height}%`);
      img.style.setProperty('--crop-x', `${crop.left}%`);
      img.style.setProperty('--crop-y', `${crop.top}%`);
    }
    img.addEventListener('error', () => {
      if (motion && img.getAttribute('src') !== motion.still) {
        img.setAttribute('src', motion.still);
        img.src = motion.still;
        return;
      }
      img.remove();
    });
    img.setAttribute('src', still ? motion.still : look.bannerImage);
    img.src = still ? motion.still : look.bannerImage;
    if (motion && !still) box.append(h('picture', { class: 'pcard-banner-pic' }, h('source', { attrs: { media: '(prefers-reduced-motion: reduce)', srcset: motion.still } }), img));
    else box.append(img);
    return box;
  }

  function heroAvatar(who, card) {
    const quiet = card && card.avatar && card.avatarStill && !motionOk(win) ? card.avatarStill : null;
    const pic = quiet || (card && card.avatar) || profileAvatar(who.avatar) || null;
    const ring = card && card.look && card.look.ring;
    const box = h('div', { class: ['pcard-avatar', ring ? `ring-${ring}` : null, who.away ? 'is-away' : null, pic ? 'has-img' : null], vars: { '--hue': who.hue } });
    const face = h('span', { class: 'pcard-face' });
    const letters = () => face.replaceChildren(h('span', { class: 'pcard-initials', text: who.initials }));
    if (pic) {
      const img = h('img', { alt: '', attrs: { decoding: 'async', referrerpolicy: 'no-referrer', draggable: 'false' } });
      img.addEventListener('error', () => {
        box.classList.remove('has-img');
        letters();
      });
      img.src = pic;
      face.append(img);
      backdropFor(face, pic, () => ensureBackdropSheet());
    } else letters();
    box.append(face);
    if (who.isHost) box.append(h('span', { class: 'pcard-crown', text: '👑', attrs: { 'aria-hidden': 'true' } }));
    return box;
  }

  function tags(who, card, loading) {
    const out = [];
    if (card && card.level !== null && card.level !== undefined) out.push(h('span', { class: 'pcard-level', text: `Level ${num(card.level)}` }));
    else if (loading) out.push(bone('is-pill'));
    if (who.isHost) out.push(h('span', { class: ['pcard-tag', 'is-host'], text: 'Host' }));
    if (who.isMe) out.push(h('span', { class: ['pcard-tag', 'is-you'], text: 'You' }));
    if (who.watching) out.push(h('span', { class: 'pcard-tag', text: 'Watching' }));
    return h('div', { class: 'pcard-tags' }, out);
  }

  function pill(cls, kids, attrs = null) {
    return h('span', { class: ['pcard-pill', cls].flat(), attrs }, kids);
  }

  function clanPill(clan) {
    const parts = clanParts(clan);
    if (!parts) return null;
    const kids = [parts.code ? h('span', { class: 'pcard-clan-code', text: parts.code }) : null, parts.name ? h('span', { class: 'pcard-pill-text', text: parts.name }) : parts.code ? null : h('span', { class: 'pcard-pill-text', text: clan.name })];
    const vars = clan.colour ? { '--pc-clan': clan.colour } : null;
    if (!clanTagOk(clan.tag)) return h('span', { class: ['pcard-pill', 'pcard-clan'], vars, attrs: { title: parts.full } }, kids);
    return h('button', { class: ['pcard-pill', 'pcard-clan', 'is-live'], type: 'button', vars, dataset: { key: 'clan-pill' }, attrs: { title: `${parts.full}: see the clan and join`, 'aria-label': `Clan ${parts.full}. Open clan` }, on: { click: () => showClan(clan) } }, kids);
  }

  function pinPill(b) {
    const art = b.image ? h('img', { src: b.image, alt: '', attrs: { width: '14', height: '14', loading: 'lazy', decoding: 'async', draggable: 'false' } }) : h('span', { text: b.emoji || '🏅' });
    return pill(['pcard-pin', b.rare ? 'is-special' : null], [h('span', { class: 'pcard-pin-art', attrs: { 'aria-hidden': 'true' } }, art), h('span', { class: 'pcard-pill-text', text: b.label })], { title: b.note ? `${b.label}: ${b.note}` : b.label });
  }

  function factPill(f) {
    return pill(['pcard-fact', f.top ? `is-top-${f.top}` : null], [h('span', { text: f.icon, attrs: { 'aria-hidden': 'true' } }), h('span', { class: 'pcard-pill-text', text: f.text })], { title: f.title });
  }

  function pills(card, handle, look, model) {
    const out = [];
    if (handle) out.push(h('span', { class: 'pcard-handle', text: `@${handle}`, attrs: { title: `@${handle}` } }));
    if (card && card.clan) out.push(clanPill(card.clan));
    if (look && look.pronouns) out.push(pill('pcard-pronouns', look.pronouns, { title: look.pronouns }));
    if (look && look.status) {
      const said = `${look.statusEmoji ? `${look.statusEmoji} ` : ''}${look.status}`;
      out.push(pill('pcard-status', h('span', { class: 'pcard-pill-text', text: said }), { title: said }));
    }
    if (model) {
      const rank = model.facts.find((f) => f.key === 'rank');
      if (rank) out.push(factPill(rank));
      for (const b of model.pinned) out.push(pinPill(b));
      for (const f of model.facts) if (f.key !== 'rank') out.push(factPill(f));
    }
    return out.filter(Boolean);
  }

  function head(who, card, name, handle, loading, theme, model = null) {
    const look = card && card.look;
    const light = Boolean(theme && theme.light);
    const colour = look ? (light ? look.colourLight || look.colour : look.colour) : null;
    const grad = look && look.customGrad ? customGradientOf(look.customGrad, light) : look && look.gradient ? gradientOf(look.gradient, light) : null;
    if (look && look.font) ensureFontSheet(docOf(), look.font);
    const nameEl = h('h2', { class: ['pcard-name', look && look.font ? `font-${look.font}` : null, colour ? 'has-colour' : null, grad ? 'has-grad' : null], text: name, attrs: { id: 'pcard-name', title: name }, vars: colour || grad ? { '--pc-name': colour, '--pc-grad': grad } : null });
    const flow = pills(card, handle, look, model);
    return h(
      'div',
      { class: 'pcard-head' },
      h('div', { class: 'pcard-top' }, heroAvatar(who, card), tags(who, card, loading)),
      nameEl,
      h('div', { class: ['pcard-sub', flow.length ? 'has-pills' : null] }, flow.length ? flow : loading ? [bone('is-line'), bone('is-pill')] : null),
    );
  }

  function xpBar(card, loading) {
    if (loading) return h('div', { class: 'pcard-xp', attrs: { 'aria-hidden': 'true' } }, bone('is-bar'));
    if (!card || !card.progress) return h('div', { class: 'pcard-xp', attrs: { 'aria-hidden': 'true' } }, h('span', { class: 'pcard-xp-track' }), h('span', { class: 'pcard-xp-text', text: card ? 'No XP yet' : '' }));
    const pct = Math.max(0, Math.min(100, Math.round((card.progress.into / card.progress.need) * 100)));
    return h(
      'div',
      { class: 'pcard-xp' },
      h('div', { class: 'pcard-xp-track', vars: { '--p': `${pct}%` }, attrs: { role: 'progressbar', 'aria-label': 'XP to the next level', 'aria-valuemin': '0', 'aria-valuemax': String(card.progress.need), 'aria-valuenow': String(card.progress.into) } }, h('span', { class: 'pcard-xp-fill' })),
      h('span', { class: 'pcard-xp-text', text: `${num(card.progress.into)} / ${num(card.progress.need)} XP` }),
    );
  }

  function section(title, id, extra, ...kids) {
    return h('section', { class: 'pcard-sec', attrs: { 'aria-labelledby': id } }, h('div', { class: 'pcard-sec-head' }, h('h3', { class: 'pcard-sec-title', text: title, attrs: { id } }), extra), ...kids);
  }

  function badgeIcon(b, size) {
    if (b.image) return h('span', { class: 'pcard-icon', attrs: { 'aria-hidden': 'true' } }, h('img', { src: b.image, alt: '', attrs: { width: size, height: size, loading: 'lazy', decoding: 'async', draggable: 'false' } }));
    return h('span', { class: 'pcard-icon', text: b.emoji || '🏅', attrs: { 'aria-hidden': 'true' } });
  }

  function tip(btn, row) {
    const on = !btn.classList.contains('is-tip');
    for (const n of row.querySelectorAll('.is-tip')) n.classList.remove('is-tip');
    if (on) btn.classList.add('is-tip');
  }

  function badgeRow(model) {
    if (!model.row.length) return h('p', { class: ['pcard-none', 'is-tall'], text: 'No badges yet. Play a few games to earn some.' });
    const row = h('ul', { class: 'pcard-row' });
    model.row.forEach((b, i) => {
      const said = b.note ? `${b.label}: ${b.note}` : b.label;
      const btn = h('button', { class: ['pcard-badge', b.pinned ? 'is-pinned' : null, b.rare ? 'is-special' : null], type: 'button', dataset: { key: `badge-${i}` }, attrs: { 'aria-label': b.pinned ? `${said} (pinned)` : said } }, badgeIcon(b, '28'), h('span', { class: 'pcard-tip', attrs: { 'aria-hidden': 'true' } }, h('strong', { text: b.label }), b.note ? h('span', { text: b.note }) : null));
      btn.addEventListener('click', () => tip(btn, row));
      btn.addEventListener('blur', () => btn.classList.remove('is-tip'));
      row.append(h('li', null, btn));
    });
    return row;
  }

  function mainView(who, card, model) {
    const fav = model.favourites.length
      ? h('ul', { class: 'pcard-favs' }, model.favourites.map((f) => h('li', { class: 'pcard-fav', attrs: { title: `${f.name}: ${num(f.played)} played` } }, h('span', { text: f.emoji, attrs: { 'aria-hidden': 'true' } }), h('span', { class: 'pcard-fav-name', text: f.name }))))
      : h('p', { class: 'pcard-none', text: 'No favorites yet.' });
    const all = model.all.length ? h('button', { class: 'pcard-more', type: 'button', dataset: { key: 'all-badges' }, attrs: { 'aria-label': `View all ${model.total} badges` }, on: { click: showAll } }, h('span', { text: `View all (${num(model.total)})` })) : null;
    return h(
      'div',
      { class: 'pcard-main' },
      h('ul', { class: 'pcard-stats', attrs: { 'aria-label': 'Party stats' } }, model.stats.map((s) => h('li', { class: ['pcard-stat', s.featured ? 'is-featured' : null], attrs: s.featured ? { title: `Featured: ${s.label}` } : null },h('span', { class: 'pcard-stat-value', text: s.value }), h('span', { class: 'pcard-stat-label', text: s.label })))),
      section('Favorite games', 'pcard-favs-title', null, fav),
      section('Badges', 'pcard-badges-title', all, badgeRow(model)),
    );
  }

  function skeletonMain() {
    const tiles = (n, cls) => Array.from({ length: n }, () => h('li', null, bone(cls)));
    return h(
      'div',
      { class: 'pcard-main', attrs: { 'aria-hidden': 'true' } },
      h('ul', { class: 'pcard-stats' }, tiles(3, 'is-stat')),
      section('Favorite games', 'pcard-favs-title', null, h('ul', { class: 'pcard-favs' }, tiles(3, 'is-fav'))),
      section('Badges', 'pcard-badges-title', null, h('ul', { class: 'pcard-row' }, tiles(5, 'is-badge'))),
    );
  }

  function foot(card, who, loading) {
    if (loading) return h('div', { class: 'pcard-foot' }, bone('is-btn'), h('p', { class: 'pcard-status-line', attrs: { role: 'status' }, text: 'Loading profile…' }));
    const handle = (card && card.page && card.username) || null;
    if (!handle) return h('div', { class: 'pcard-foot' }, h('p', { class: 'pcard-status-line', text: card ? 'No public profile page yet.' : '' }));
    const url = profileUrl(handle, win && win.location);
    const shown = url.replace(/^https?:\/\//, '');
    const out = h('p', { class: 'pcard-status-line', text: shown, attrs: { role: 'status', title: shown } });
    const label = who.isMe ? 'View your profile' : 'View full profile';
    if (alone) return h('div', { class: 'pcard-foot' }, h('a', { class: 'btn btn-secondary btn-sm pcard-link', attrs: { href: `/u/${encodeURIComponent(handle)}` } }, h('span', { class: 'btn-label', text: label })), out);
    const btnLabel = h('span', { class: 'btn-label', text: label });
    const btn = h('button', { class: 'btn btn-secondary btn-sm pcard-link', type: 'button', dataset: { key: 'full-profile' } }, btnLabel);
    btn.addEventListener('click', () => openFull(url, shown, btn, btnLabel, out, label));
    return h('div', { class: 'pcard-foot' }, btn, out);
  }

  async function openFull(url, shown, btn, btnLabel, out, label) {
    let opened = null;
    try {
      opened = win && typeof win.open === 'function' ? win.open(url, '_blank') : null;
    } catch {
      opened = null;
    }
    if (opened) {
      try {
        opened.opener = null;
      } catch {}
      out.textContent = 'Opened in a new tab';
      return 'opened';
    }
    const ok = await copyText({ win, doc: docOf(), value: url, host: panel });
    if (!btn.isConnected) return ok ? 'copied' : 'shown';
    if (ok) {
      btn.classList.add('is-copied');
      btnLabel.textContent = 'Link copied';
      out.textContent = 'Paste it in your browser';
      later(() => {
        copyTimer = null;
        btn.classList.remove('is-copied');
        btnLabel.textContent = label;
        out.textContent = shown;
      }, COPIED_MS);
      return 'copied';
    }
    out.textContent = `Copy this link: ${shown}`;
    out.classList.add('is-select');
    return 'shown';
  }

  function allView(model) {
    const back = h('button', { class: 'pcard-back', type: 'button', dataset: { key: 'badges-back' }, attrs: { 'aria-label': 'Back to profile' }, on: { click: showMain } }, h('span', { text: '‹', attrs: { 'aria-hidden': 'true' } }), h('span', { text: 'Back' }));
    return h(
      'div',
      { class: ['pcard-view', 'is-all'] },
      h('div', { class: 'pcard-all-head' }, back, h('h2', { class: 'pcard-all-title', text: `All badges (${num(model.total)})`, attrs: { id: 'pcard-all-title' } })),
      h('ul', { class: 'pcard-all', attrs: { 'aria-labelledby': 'pcard-all-title' } }, model.all.map((b) => {
        const kind = [b.pinned ? 'Pinned' : null, b.rare ? RARE[b.rare] : null, b.kind === 'achievement' ? 'Achievement' : null].filter(Boolean).join(' · ');
        return h('li', { class: ['pcard-all-item', b.pinned ? 'is-pinned' : null, b.rare ? 'is-special' : null] }, badgeIcon(b, '32'), h('div', { class: 'pcard-all-text' }, h('span', { class: 'pcard-all-name', text: b.label }), b.note ? h('span', { class: 'pcard-all-note', text: b.note }) : null, kind ? h('span', { class: 'pcard-all-kind', text: kind }) : null));
      }), model.unlisted > 0 ? h('li', { class: 'pcard-none', text: `${num(model.unlisted)} more on their full profile.` }) : null),
    );
  }

  function clanRequest(method, path) {
    const fetcher = win && typeof win.fetch === 'function' ? win.fetch.bind(win) : null;
    if (!fetcher) return Promise.resolve({ status: 0, data: null });
    let bearer = null;
    try {
      const gate = resolve(signin);
      const s = gate && typeof gate.state === 'function' ? gate.state() : null;
      bearer = s && s.status === 'in' && typeof s.token === 'string' ? s.token : null;
    } catch {
      bearer = null;
    }
    const headers = { Accept: 'application/json' };
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    return fetcher(path, { method, headers, credentials: 'omit', cache: 'no-store' }).then(async (res) => {
      let data = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }
      return { status: Number(res.status) || 0, data };
    });
  }

  function stopClan() {
    if (clanCtl) clanCtl.stop();
    clanCtl = null;
  }

  function signInForClan() {
    const gate = resolve(signin);
    close();
    if (gate && typeof gate.open === 'function') gate.open('clan');
  }

  function clanButton(cls, key, label, onClick, attrs = null) {
    return h('button', { class: ['btn', cls, 'btn-sm', 'pcard-clan-join'], type: 'button', dataset: { key }, attrs, on: { click: onClick } }, h('span', { class: 'btn-label', text: label }));
  }

  function clanView(st) {
    const s = joinState(st);
    const c = st.clan;
    const parts = c ? clanParts(c) : null;
    const gate = resolve(signin);
    const back = h('button', { class: 'pcard-back', type: 'button', dataset: { key: 'clan-back' }, attrs: { 'aria-label': 'Back to profile' }, on: { click: showMain } }, h('span', { text: '‹', attrs: { 'aria-hidden': 'true' } }), h('span', { text: 'Back' }));
    const title = parts ? parts.full : `[${st.tag}]`;
    let action = null;
    if (s.action === 'join') action = clanButton('btn-primary', 'clan-join', s.label, () => clanCtl && clanCtl.join(), { 'aria-disabled': s.busy ? 'true' : null });
    else if (s.action === 'signin' && gate) action = clanButton('btn-primary', 'clan-signin', s.label, signInForClan, { 'aria-haspopup': 'dialog' });
    else if (s.action === 'retry') action = clanButton('btn-secondary', 'clan-retry', s.label, () => clanCtl && clanCtl.load());
    const said = s.action === 'signin' && !gate ? 'Sign in to YapOS Party to join this clan.' : s.text;
    const box = h('div', { class: 'pcard-clan-act' }, h('p', { class: ['pcard-clan-state', `is-${s.tone}`], text: said, attrs: { role: 'status', 'aria-live': 'polite' } }), action);
    const kids = [h('div', { class: 'pcard-all-head' }, back, h('h2', { class: 'pcard-all-title', text: title, attrs: { id: 'pcard-clan-title', title } }))];
    if (st.phase === 'ready' && c) {
      const lead = c.leader ? c.leader.name : 'Hidden';
      kids.push(h(
        'div',
        { class: 'pcard-clan-body' },
        h('div', { class: 'pcard-clan-hero' }, h('span', { class: 'pcard-crest', text: c.tag, attrs: { 'aria-hidden': 'true' } }), h('div', { class: 'pcard-clan-who' }, h('p', { class: 'pcard-clan-name', text: c.name }), c.banner ? h('p', { class: 'pcard-clan-motto', text: c.banner }) : null)),
        h('dl', { class: 'pcard-clan-facts' },
          h('div', null, h('dt', { text: 'Members' }), h('dd', { text: num(c.members) })),
          h('div', null, h('dt', { text: 'Leader' }), h('dd', { text: lead, attrs: { title: lead } })),
          h('div', { class: c.join === 'invite' ? 'is-invite' : 'is-open' }, h('dt', { text: 'Joining' }), h('dd', { text: c.join === 'invite' ? 'Invite only' : 'Open' }))),
        c.top.length ? h('ol', { class: 'pcard-clan-top', attrs: { 'aria-label': 'Top members' } }, c.top.map((m) => h('li', null, h('span', { class: 'pcard-pill-text', text: m.name }), m.leader ? h('span', { text: '👑', attrs: { role: 'img', 'aria-label': 'Leader', title: 'Leader' } }) : null, h('span', { class: 'pcard-clan-lv', text: `Lv ${num(m.level)}` })))) : null,
        box,
      ));
    } else kids.push(h('div', { class: 'pcard-clan-body' }, box));
    return h('div', { class: ['pcard-view', 'is-clan', st.phase === 'ready' ? null : `is-${st.phase}`], vars: c && c.colour ? { '--pc-clan': c.colour } : null }, kids);
  }

  function paintClan(st) {
    if (!state || state.view !== 'clan') return;
    const doc = docOf();
    const active = doc ? doc.activeElement : null;
    const key = active && body.contains(active) && active.dataset ? active.dataset.key : null;
    panel.setAttribute('aria-labelledby', 'pcard-clan-title');
    body.replaceChildren(clanView(st));
    if (!key) return;
    const again = body.querySelector(`[data-key="${key}"]`) || body.querySelector('.pcard-clan-join') || body.querySelector('.pcard-back');
    if (again) again.focus();
  }

  function showClan(clan) {
    if (!state || state.status !== 'ready' || !clan || !clanTagOk(clan.tag)) return;
    stopClan();
    state = { ...state, view: 'clan' };
    clanCtl = createClanJoin({
      tag: clan.tag,
      request: clanRequest,
      onChange: paintClan,
      setTimer: win && typeof win.setTimeout === 'function' ? (fn, ms) => win.setTimeout(fn, ms) : null,
      clearTimer: win && typeof win.clearTimeout === 'function' ? (t) => win.clearTimeout(t) : null,
      pollMs: clanPollMs,
    });
    paint();
    scroller.scrollTop = 0;
    const back = body.querySelector('.pcard-back');
    if (back) back.focus();
    clanCtl.load();
  }

  function showAll() {
    if (!state || state.status !== 'ready') return;
    state = { ...state, view: 'all' };
    paint();
    scroller.scrollTop = 0;
    const back = body.querySelector('.pcard-back');
    if (back) back.focus();
  }

  function showMain() {
    if (!state) return;
    const from = state.view;
    stopClan();
    state = { ...state, view: 'main' };
    paint();
    scroller.scrollTop = 0;
    const more = body.querySelector(from === 'clan' ? '.pcard-clan.is-live' : '.pcard-more');
    if (more) more.focus();
    else closeBtn.focus();
  }

  function message(kind) {
    if (kind === 'hidden') return h('p', { class: 'pcard-empty', text: 'This player keeps their profile private.' });
    if (kind === 'none') return h('p', { class: 'pcard-empty', text: "Stats aren't available for this player yet. They show up after a finished game." });
    return h(
      'div',
      { class: 'pcard-error' },
      h('p', { class: 'pcard-empty', attrs: { role: 'status' }, text: "We couldn't load this profile right now." }),
      h('button', { class: 'btn btn-secondary btn-sm pcard-retry', type: 'button', on: { click: retry } }, h('span', { class: 'btn-label', text: 'Try again' })),
    );
  }

  function paint() {
    if (!state) return;
    stopTimers();
    const who = known(state.id, state.hint);
    const card = state.status === 'ready' ? state.card : null;
    const hiddenCard = state.status === 'hidden' ? state.card : null;
    const loading = state.status === 'loading';
    panel.classList.toggle('is-loading', loading);
    panel.classList.toggle('is-error', state.status === 'error');
    const look = card && card.look;
    const theme = themeOf(look && look.palette);
    paintTheme(panel, theme);
    panel.classList.toggle('has-fx', Boolean(look && look.effect));
    if (look && look.effect) effects().start(panel, look.effect);
    else effects().stop();
    if (card && state.view === 'all') {
      panel.setAttribute('aria-labelledby', 'pcard-all-title');
      body.replaceChildren(allView(cardModel(card)));
      return;
    }
    if (card && state.view === 'clan' && clanCtl) {
      panel.setAttribute('aria-labelledby', 'pcard-clan-title');
      body.replaceChildren(clanView(clanCtl.state));
      return;
    }
    panel.setAttribute('aria-labelledby', 'pcard-name');
    const name = (card && card.name) || who.name;
    const handle = (card && card.username) || who.username;
    const ac = look && look.accent && !theme ? look.accent : null;
    const reveal = Boolean(card) && revealed !== state.id;
    if (card) revealed = state.id;
    const model = card ? cardModel(card) : null;
    const view = h(
      'div',
      { class: ['pcard-view', ac || theme ? 'has-accent' : null, reveal ? 'is-reveal' : null], vars: ac ? { '--pc-ac': ac.base, '--pc-ac-text': ac.text } : null },
      bannerEl(look),
      head(who, card || (hiddenCard && hiddenCard.avatar ? hiddenCard : null), name, handle, loading, theme, model),
    );
    if (loading) view.append(xpBar(null, true), skeletonMain(), foot(null, who, true));
    else if (card) view.append(xpBar(card, false), mainView(who, card, model), foot(card, who, false));
    else view.append(message(state.status));
    body.replaceChildren(view);
  }

  function retry() {
    if (!state) return;
    stopClan();
    state = { ...state, status: 'loading', view: 'main' };
    paint();
    fetchFor(state.id);
    closeBtn.focus();
  }

  function focusables() {
    return [...panel.querySelectorAll(FOCUSABLE)].filter((n) => !n.disabled && n.getAttribute('tabindex') !== '-1' && !n.hidden);
  }

  function onKey(e) {
    if (!state) return;
    if (e.key === 'Escape' || e.key === 'Esc') {
      e.preventDefault();
      if (typeof e.stopPropagation === 'function') e.stopPropagation();
      if (state.view === 'all' || state.view === 'clan') showMain();
      else close();
      return;
    }
    if (e.key !== 'Tab') return;
    const list = focusables();
    if (!list.length) {
      e.preventDefault();
      return;
    }
    const doc = win && win.document ? win.document : globalThis.document;
    const active = doc ? doc.activeElement : null;
    const i = list.indexOf(active);
    if (e.shiftKey && i <= 0) {
      e.preventDefault();
      list[list.length - 1].focus();
    } else if (!e.shiftKey && (i === -1 || i === list.length - 1)) {
      e.preventDefault();
      list[0].focus();
    }
  }

  function open(rawId, hint = null, from = null) {
    const id = rawId === null || rawId === undefined ? '' : String(rawId);
    if (!id) return false;
    if (closeTimer !== null && win) win.clearTimeout(closeTimer);
    closeTimer = null;
    el.classList.remove('is-closing');
    if (!state) {
      const doc = win && win.document ? win.document : globalThis.document;
      opener = from || (doc ? doc.activeElement : null);
    }
    ensureSheet(docOf());
    const hit = cached(id);
    stopClan();
    state = { id, hint, view: 'main', card: hit || null, status: hit === undefined ? 'loading' : hit.none ? 'none' : hit.hidden ? 'hidden' : 'ready' };
    paint();
    el.hidden = false;
    el.removeAttribute('hidden');
    el.classList.add('is-open');
    if (boundRoot) boundRoot.classList.add('has-modal');
    closeBtn.focus();
    if (hit === undefined) fetchFor(id);
    return true;
  }

  function finish() {
    closeTimer = null;
    if (state) return;
    el.hidden = true;
    el.setAttribute('hidden', '');
    el.classList.remove('is-closing');
  }

  function close() {
    if (!state) return false;
    const id = state.id;
    state = null;
    stopClan();
    token += 1;
    revealed = null;
    stopTimers();
    if (fx) fx.stop();
    el.classList.remove('is-open');
    el.classList.add('is-closing');
    if (boundRoot) boundRoot.classList.remove('has-modal');
    if (win && typeof win.setTimeout === 'function') closeTimer = win.setTimeout(finish, CLOSE_MS);
    else finish();
    let back = opener;
    opener = null;
    if ((!back || !back.isConnected) && boundRoot) back = boundRoot.querySelector(`[data-profile-id="${id.replace(/["\\]/g, '')}"][tabindex]`);
    if (back && typeof back.focus === 'function') back.focus();
    return true;
  }

  function nestedIn(node) {
    const up = node.parentNode;
    if (!up || typeof up.closest !== 'function') return false;
    const outer = up.closest(INTERACTIVE);
    return Boolean(outer && (!boundRoot || boundRoot.contains(outer)));
  }

  function scan(root = boundRoot) {
    if (!root || typeof root.querySelectorAll !== 'function') return 0;
    let n = 0;
    for (const node of root.querySelectorAll('[data-profile-id]')) {
      if (node.getAttribute('data-pc')) continue;
      if (el.contains(node) || nestedIn(node)) {
        node.setAttribute('data-pc', 'off');
        continue;
      }
      node.setAttribute('data-pc', 'on');
      if (node.hasAttribute('tabindex')) continue;
      const name = node.getAttribute('data-profile-name');
      node.setAttribute('role', 'button');
      node.setAttribute('tabindex', '0');
      node.setAttribute('aria-haspopup', 'dialog');
      node.setAttribute('aria-label', name ? `View ${name}'s profile` : 'View profile');
      node.removeAttribute('aria-hidden');
      node.classList.add('pcard-trigger');
      n += 1;
    }
    return n;
  }

  function triggerOf(e) {
    const t = e && e.target;
    if (!t || typeof t.closest !== 'function') return null;
    let node = t.closest('[data-profile-id]');
    if (!node || el.contains(node)) return null;
    if (boundRoot && !boundRoot.contains(node)) return null;
    if (nestedIn(node)) {
      const outer = node.parentNode.closest(INTERACTIVE);
      if (!outer || !outer.hasAttribute('data-profile-id') || outer.getAttribute('data-profile-id') !== node.getAttribute('data-profile-id') || nestedIn(outer)) return null;
      node = outer;
    }
    return node;
  }

  function hintFrom(node) {
    const face = node.hasAttribute('data-profile-name') || !node.querySelector ? node : node.querySelector('[data-profile-name]') || node;
    const img = face.querySelector ? face.querySelector('img') : null;
    const st = face.style || null;
    const hue = st && typeof st.getPropertyValue === 'function' ? st.getPropertyValue('--hue') : st && st.props ? st.props['--hue'] : null;
    return {
      name: face.getAttribute('data-profile-name') || null,
      avatar: img && img.src ? img.src : null,
      initials: img ? null : text(face.textContent, 3),
      hue: hue === null || hue === undefined || hue === '' ? null : Number(hue),
    };
  }

  function onDown(e) {
    down = { at: now(), x: Number(e.clientX), y: Number(e.clientY), canvas: Boolean(e.target && typeof e.target.closest === 'function' && e.target.closest('canvas')) };
  }

  function dragged(e) {
    if (!down) return false;
    const was = down;
    down = null;
    if (e.detail === 0 || now() - was.at > 5000) return false;
    if (was.canvas) return true;
    const x = Number(e.clientX);
    const y = Number(e.clientY);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(was.x) || !Number.isFinite(was.y)) return false;
    return Math.hypot(x - was.x, y - was.y) > DRAG_PX;
  }

  function onClick(e) {
    const moved = dragged(e);
    const node = triggerOf(e);
    if (!node || moved) return;
    if (e.button !== undefined && e.button !== 0) return;
    if (typeof e.preventDefault === 'function') e.preventDefault();
    open(node.getAttribute('data-profile-id'), hintFrom(node), node);
  }

  function onKeyOpen(e) {
    if (state && (e.key === 'Escape' || e.key === 'Esc')) {
      close();
      return;
    }
    if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
    if (e.defaultPrevented) return;
    const node = triggerOf(e);
    if (!node || e.target !== node) return;
    if (typeof e.preventDefault === 'function') e.preventDefault();
    open(node.getAttribute('data-profile-id'), hintFrom(node), node);
  }

  function bind(root) {
    if (!root || typeof root.addEventListener !== 'function') return () => {};
    boundRoot = root;
    if (el.parentNode !== root) root.append(el);
    root.addEventListener('pointerdown', onDown, true);
    root.addEventListener('click', onClick);
    root.addEventListener('keydown', onKeyOpen);
    scan(root);
    const off = () => {
      root.removeEventListener('pointerdown', onDown, true);
      root.removeEventListener('click', onClick);
      root.removeEventListener('keydown', onKeyOpen);
      if (boundRoot === root) boundRoot = null;
    };
    unbinders.push(off);
    return off;
  }

  function destroy() {
    if (state) close();
    if (closeTimer !== null && win) win.clearTimeout(closeTimer);
    closeTimer = null;
    for (const off of unbinders.splice(0)) off();
    el.removeEventListener('keydown', onKey);
    el.remove();
  }

  return {
    el,
    open,
    close,
    bind,
    scan,
    destroy,
    get isOpen() {
      return Boolean(state);
    },
    get openId() {
      return state ? state.id : null;
    },
  };
}
