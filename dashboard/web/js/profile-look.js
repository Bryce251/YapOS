export const LOOK_VERSION = 1;
export const PIN_MAX = 5;
export const BIO_MAX = 190;
export const BIO_LINES = 4;
export const PRONOUNS_MAX = 24;
export const STATUS_MAX = 60;
export const STATUS_EMOJI_MAX = 8;
export const LOOK_BODY_MAX = 8 * 1024;
export const MIN_CONTRAST = 4.5;
export const LIGHT_SURFACE = '#ffffff';
export const DARK_SURFACE = '#121215';
export const ACH_PREFIX = 'ach:';

export const SECTIONS = Object.freeze([
  Object.freeze({ id: 'about', label: 'About me', icon: 'user' }),
  Object.freeze({ id: 'stats', label: 'Level and stats', icon: 'chart' }),
  Object.freeze({ id: 'badges', label: 'Badges', icon: 'star' }),
  Object.freeze({ id: 'achievements', label: 'Achievements', icon: 'trophy' }),
  Object.freeze({ id: 'favourites', label: 'Favourite games', icon: 'smile' }),
  Object.freeze({ id: 'placings', label: 'Season placings', icon: 'activity' }),
]);
export const SECTION_IDS = Object.freeze(SECTIONS.map((s) => s.id));

export const NAME_PALETTE = Object.freeze([
  Object.freeze({ id: 'ember', label: 'Ember', hex: '#f2613f' }),
  Object.freeze({ id: 'rose', label: 'Rose', hex: '#e5487f' }),
  Object.freeze({ id: 'grape', label: 'Grape', hex: '#7c5cff' }),
  Object.freeze({ id: 'sky', label: 'Sky', hex: '#2f8fe8' }),
  Object.freeze({ id: 'teal', label: 'Teal', hex: '#0fa3a3' }),
  Object.freeze({ id: 'leaf', label: 'Leaf', hex: '#2fa84f' }),
  Object.freeze({ id: 'sun', label: 'Sun', hex: '#e0a100' }),
  Object.freeze({ id: 'coral', label: 'Coral', hex: '#ff6f61' }),
  Object.freeze({ id: 'mint', label: 'Mint', hex: '#3cc9a0' }),
  Object.freeze({ id: 'lilac', label: 'Lilac', hex: '#b07cf0' }),
  Object.freeze({ id: 'slate', label: 'Slate', hex: '#64748b' }),
  Object.freeze({ id: 'cherry', label: 'Cherry', hex: '#d11a4b' }),
]);

export const NAME_GRADIENTS = Object.freeze([
  Object.freeze({ id: 'sunset', label: 'Sunset' }),
  Object.freeze({ id: 'ocean', label: 'Ocean' }),
  Object.freeze({ id: 'aurora', label: 'Aurora' }),
  Object.freeze({ id: 'candy', label: 'Candy' }),
  Object.freeze({ id: 'forest', label: 'Forest' }),
  Object.freeze({ id: 'gold', label: 'Gold' }),
]);

export const NAME_FONTS = Object.freeze([
  Object.freeze({ id: 'default', label: 'Default' }),
  Object.freeze({ id: 'rounded', label: 'Rounded' }),
  Object.freeze({ id: 'serif', label: 'Serif' }),
  Object.freeze({ id: 'mono', label: 'Mono' }),
  Object.freeze({ id: 'caps', label: 'Small caps' }),
]);

export const BANNERS = Object.freeze([
  Object.freeze({ id: 'none', label: 'None' }),
  Object.freeze({ id: 'accent', label: 'My accent' }),
  Object.freeze({ id: 'sunset', label: 'Sunset' }),
  Object.freeze({ id: 'ocean', label: 'Ocean' }),
  Object.freeze({ id: 'aurora', label: 'Aurora' }),
  Object.freeze({ id: 'forest', label: 'Forest' }),
  Object.freeze({ id: 'candy', label: 'Candy' }),
  Object.freeze({ id: 'midnight', label: 'Midnight' }),
  Object.freeze({ id: 'dots', label: 'Dots' }),
  Object.freeze({ id: 'grid', label: 'Grid' }),
  Object.freeze({ id: 'stripes', label: 'Stripes' }),
  Object.freeze({ id: 'image', label: 'My picture' }),
]);

export const RINGS = Object.freeze([
  Object.freeze({ id: 'none', label: 'None' }),
  Object.freeze({ id: 'accent', label: 'Accent' }),
  Object.freeze({ id: 'rainbow', label: 'Rainbow' }),
  Object.freeze({ id: 'gold', label: 'Gold' }),
  Object.freeze({ id: 'glow', label: 'Glow' }),
]);

export const DENSITIES = Object.freeze([
  Object.freeze({ id: 'cozy', label: 'Cozy' }),
  Object.freeze({ id: 'compact', label: 'Compact' }),
  Object.freeze({ id: 'roomy', label: 'Roomy' }),
]);

export const FEATURED = Object.freeze([
  Object.freeze({ id: 'level', label: 'Level' }),
  Object.freeze({ id: 'wins', label: 'Party wins' }),
  Object.freeze({ id: 'games', label: 'Party games' }),
  Object.freeze({ id: 'winrate', label: 'Win rate' }),
  Object.freeze({ id: 'badges', label: 'Badges' }),
  Object.freeze({ id: 'shards', label: 'Shards' }),
]);

const ids = (list) => new Set(list.map((x) => x.id));
const GRADIENT_IDS = ids(NAME_GRADIENTS);
const FONT_IDS = ids(NAME_FONTS);
const BANNER_IDS = ids(BANNERS);
const RING_IDS = ids(RINGS);
const DENSITY_IDS = ids(DENSITIES);
const FEATURED_IDS = ids(FEATURED);
const SECTION_SET = new Set(SECTION_IDS);
const FIELDS = new Set(['v', 'pins', 'order', 'hidden', 'nameColour', 'nameGradient', 'nameFont', 'accent', 'banner', 'bio', 'pronouns', 'status', 'statusEmoji', 'ring', 'density', 'featured']);

export const HEX_RE = /^#[0-9a-f]{6}$/;
export const PIN_RE = /^(ach:)?[a-z0-9][a-z0-9_-]{0,39}$/;
const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f​-‏‪-‮⁦-⁩]/g;
const EMOJI_RE = /\p{Extended_Pictographic}|\p{Regional_Indicator}|[#*0-9]️?⃣/u;
const EMOJI_BAD_RE = /[\p{L}\s<>&"'`\\]/u;

export const DEFAULT_LOOK = Object.freeze({
  v: LOOK_VERSION,
  pins: Object.freeze([]),
  order: SECTION_IDS,
  hidden: Object.freeze([]),
  nameColour: null,
  nameGradient: null,
  nameFont: 'default',
  accent: null,
  banner: 'none',
  bio: '',
  pronouns: '',
  status: '',
  statusEmoji: '',
  ring: 'none',
  density: 'cozy',
  featured: 'level',
});

export class LookError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function defaultLook() {
  return { ...DEFAULT_LOOK, pins: [], order: [...SECTION_IDS], hidden: [] };
}

export function isDefaultLook(look) {
  return sameLook(look, DEFAULT_LOOK);
}

export function sameLook(a, b) {
  return JSON.stringify(lookKey(a)) === JSON.stringify(lookKey(b));
}

function lookKey(look) {
  const l = look || DEFAULT_LOOK;
  return Object.keys(DEFAULT_LOOK).map((k) => [k, l[k] === undefined ? DEFAULT_LOOK[k] : l[k]]);
}

function rgb(hex) {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex([r, g, b]) {
  return `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
}

export function normalHex(value) {
  if (typeof value !== 'string') return null;
  let v = value.trim().toLowerCase();
  if (/^#?[0-9a-f]{3}$/.test(v)) v = v.replace('#', '').split('').map((c) => c + c).join('');
  v = v.startsWith('#') ? v : `#${v}`;
  return HEX_RE.test(v) ? v : null;
}

export function luminance(hex) {
  const lin = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = rgb(hex).map(lin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a, b) {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

export function mixHex(a, b, t) {
  const x = rgb(a);
  const y = rgb(b);
  return toHex(x.map((v, i) => v + (y[i] - v) * t));
}

export function readableOn(hex, surface, min = MIN_CONTRAST) {
  const colour = normalHex(hex);
  if (!colour) return null;
  if (contrast(colour, surface) >= min) return colour;
  const toward = luminance(surface) > 0.5 ? '#000000' : '#ffffff';
  for (let i = 1; i <= 40; i++) {
    const next = mixHex(colour, toward, i / 40);
    if (contrast(next, surface) >= min) return next;
  }
  return toward;
}

export function themeColours(hex) {
  const colour = normalHex(hex);
  if (!colour) return null;
  const light = readableOn(colour, LIGHT_SURFACE);
  const dark = readableOn(colour, DARK_SURFACE);
  return { base: colour, light, dark, adjusted: light !== colour || dark !== colour };
}

export function cleanLine(value, max) {
  if (typeof value !== 'string') return '';
  const text = value.replace(CONTROL_RE, '').replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
  return Array.from(text).slice(0, max).join('');
}

export function cleanBio(value, max = BIO_MAX) {
  if (typeof value !== 'string') return '';
  const lines = value.replace(/\r\n?/g, '\n').replace(CONTROL_RE, '').split('\n').map((l) => l.replace(/\s+/g, ' ').trim());
  const out = [];
  let filled = 0;
  for (const l of lines) {
    if (!l) {
      if (out.length && out[out.length - 1]) out.push('');
      continue;
    }
    if (filled >= BIO_LINES) {
      while (!out[out.length - 1]) out.pop();
      out[out.length - 1] += ` ${l}`;
      continue;
    }
    out.push(l);
    filled += 1;
  }
  while (out.length && !out[out.length - 1]) out.pop();
  return Array.from(out.join('\n')).slice(0, max).join('').trim();
}

export function textLength(value) {
  return Array.from(String(value ?? '')).length;
}

export function cleanStatusEmoji(value) {
  if (typeof value !== 'string') return null;
  const e = value.trim();
  if (!e) return '';
  if (Array.from(e).length > STATUS_EMOJI_MAX || !EMOJI_RE.test(e) || EMOJI_BAD_RE.test(e) || /[\u0000-\u001f\u007f]/.test(e)) return null;
  return e;
}

function fail(strict, code, message) {
  if (strict) throw new LookError(code, message);
  return undefined;
}

function pick(set, value, fallback, strict, code, message) {
  if (value === undefined) return fallback;
  if (typeof value === 'string' && set.has(value)) return value;
  fail(strict, code, message);
  return fallback;
}

function readOrder(value, strict) {
  if (value === undefined) return [...SECTION_IDS];
  if (!Array.isArray(value) || value.length > SECTION_IDS.length * 2) {
    fail(strict, 'bad_order', 'The section order could not be read. Reload and try again.');
    return [...SECTION_IDS];
  }
  const out = [];
  for (const s of value) {
    if (typeof s !== 'string' || !SECTION_SET.has(s)) {
      fail(strict, 'bad_order', 'The section order has a section that does not exist.');
      continue;
    }
    if (out.includes(s)) {
      fail(strict, 'bad_order', 'Each section can only be in the list once.');
      continue;
    }
    out.push(s);
  }
  for (const s of SECTION_IDS) if (!out.includes(s)) out.push(s);
  return out;
}

function readHidden(value, strict) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > SECTION_IDS.length * 2) {
    fail(strict, 'bad_hidden', 'The hidden sections could not be read. Reload and try again.');
    return [];
  }
  const out = [];
  for (const s of value) {
    if (typeof s !== 'string' || !SECTION_SET.has(s)) {
      fail(strict, 'bad_hidden', 'A hidden section does not exist.');
      continue;
    }
    if (!out.includes(s)) out.push(s);
  }
  return SECTION_IDS.filter((s) => out.includes(s));
}

function readPins(value, owned, strict) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    fail(strict, 'bad_pins', 'Pinned badges could not be read. Reload and try again.');
    return [];
  }
  if (value.length > PIN_MAX) fail(strict, 'too_many_pins', `You can pin up to ${PIN_MAX} badges.`);
  const out = [];
  for (const p of value) {
    if (typeof p !== 'string' || !PIN_RE.test(p)) {
      fail(strict, 'bad_pins', "One of the pinned badges doesn't exist.");
      continue;
    }
    if (out.includes(p)) continue;
    if (owned && !owned.has(p)) {
      fail(strict, 'not_owned', "You can only pin badges you have. One of them isn't yours.");
      continue;
    }
    out.push(p);
    if (out.length >= PIN_MAX) break;
  }
  return out;
}

function readColour(value, strict, code, message) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'string' && HEX_RE.test(value)) return value;
  fail(strict, code, message);
  return null;
}

function readText(value, max, strict, code, what, clean = cleanLine) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') {
    fail(strict, code, `Your ${what} must be text.`);
    return '';
  }
  const loose = clean(value, max + 1);
  if (textLength(loose) > max) {
    fail(strict, code, `Keep your ${what} to ${max} characters or fewer.`);
    return clean(value, max);
  }
  return loose;
}

export function cleanLook(raw, { owned = null, strict = false } = {}) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : (fail(strict, 'bad_request', 'Send your profile look as an object.'), {});
  if (strict) {
    for (const k of Object.keys(src)) if (!FIELDS.has(k)) throw new LookError('bad_request', `Unknown field "${String(k).slice(0, 40)}".`);
    if (src.v !== undefined && src.v !== LOOK_VERSION) throw new LookError('bad_version', 'This page is out of date. Reload it and try again.');
  }
  const look = defaultLook();
  look.pins = readPins(src.pins, owned, strict);
  look.order = readOrder(src.order, strict);
  look.hidden = readHidden(src.hidden, strict);
  look.nameColour = readColour(src.nameColour, strict, 'bad_colour', 'Pick a name colour like #f2613f.');
  look.nameGradient = src.nameGradient === null || src.nameGradient === '' ? null : pick(GRADIENT_IDS, src.nameGradient, null, strict, 'bad_gradient', "That name gradient doesn't exist.");
  if (look.nameGradient) look.nameColour = null;
  look.nameFont = pick(FONT_IDS, src.nameFont, 'default', strict, 'bad_font', "That name style doesn't exist.");
  look.accent = readColour(src.accent, strict, 'bad_accent', 'Pick an accent colour like #7c5cff.');
  look.banner = pick(BANNER_IDS, src.banner, 'none', strict, 'bad_banner', "That banner doesn't exist.");
  look.bio = readText(src.bio, BIO_MAX, strict, 'bad_bio', 'about me', cleanBio);
  look.pronouns = readText(src.pronouns, PRONOUNS_MAX, strict, 'bad_pronouns', 'pronouns');
  look.status = readText(src.status, STATUS_MAX, strict, 'bad_status', 'status');
  const emoji = src.statusEmoji === undefined || src.statusEmoji === null ? '' : cleanStatusEmoji(src.statusEmoji);
  if (emoji === null) fail(strict, 'bad_emoji', 'Use one emoji for your status, like \u{1F3AE}.');
  look.statusEmoji = emoji || '';
  look.ring = pick(RING_IDS, src.ring, 'none', strict, 'bad_ring', "That avatar ring doesn't exist.");
  look.density = pick(DENSITY_IDS, src.density, 'cozy', strict, 'bad_density', "That card layout doesn't exist.");
  look.featured = pick(FEATURED_IDS, src.featured, 'level', strict, 'bad_featured', "That featured stat doesn't exist.");
  return look;
}

export function lookTexts(look) {
  return [['bio', 'about me', look.bio], ['pronouns', 'pronouns', look.pronouns], ['status', 'status', look.status]].filter(([, , v]) => v);
}

export function pinKey(item, kind) {
  return kind === 'achievement' ? `${ACH_PREFIX}${item.id}` : item.id;
}

export const BANNER_IMAGE_RE = /^\/banner-img\/b-[a-z0-9]{10}-[0-9a-f]{16}\.(png|webp|jpg)$/;

export function readLook(raw) {
  const look = cleanLook(raw && typeof raw === 'object' ? raw : {});
  const image = raw && typeof raw.bannerImage === 'string' && BANNER_IMAGE_RE.test(raw.bannerImage) ? raw.bannerImage : null;
  if (look.banner === 'image' && !image) look.banner = 'none';
  return { look, bannerImage: image };
}

export function lookBody(look) {
  const out = {};
  for (const k of Object.keys(DEFAULT_LOOK)) out[k] = Array.isArray(look[k]) ? [...look[k]] : look[k];
  return out;
}

export function moveItem(list, index, delta) {
  const to = index + delta;
  if (index < 0 || index >= list.length || to < 0 || to >= list.length) return [...list];
  const out = [...list];
  const [item] = out.splice(index, 1);
  out.splice(to, 0, item);
  return out;
}

export function featuredValue(id, p) {
  const games = Number(p.games) || 0;
  const wins = Number(p.wins) || 0;
  if (id === 'wins') return { id, value: wins, label: 'Party wins' };
  if (id === 'games') return { id, value: games, label: 'Party games' };
  if (id === 'winrate') return { id, value: games ? Math.round((wins / games) * 100) : 0, label: 'Win rate', suffix: '%' };
  if (id === 'badges') return { id, value: (p.badges || []).length + (p.achievements || []).length, label: 'Badges' };
  if (id === 'shards' && p.shards !== null && p.shards !== undefined) return { id, value: p.shards, label: 'Shards' };
  return { id: 'level', value: Number(p.level) || 0, label: 'Level' };
}

export const CUSTOM_BADGE_RE = /^c-[a-z0-9]{8}$/;
export const SPECIAL_KINDS = Object.freeze(['custom', 'special']);

export function badgeKindOf(id, isParty = () => false) {
  const key = String(id ?? '');
  if (CUSTOM_BADGE_RE.test(key)) return 'custom';
  if (key.startsWith('season-')) return 'season';
  if (key.startsWith(ACH_PREFIX)) return 'achievement';
  if (isParty(key)) return 'party';
  return 'special';
}

export const FOUNDER_BADGE = 'founder';

const badgeKey = (x) => (x && typeof x === 'object' ? x.key ?? x.id : x);

export function specialFirst(list, kindOf) {
  const all = Array.isArray(list) ? list : [];
  const top = all.filter((x) => badgeKey(x) === FOUNDER_BADGE);
  const items = top.length ? all.filter((x) => badgeKey(x) !== FOUNDER_BADGE) : all;
  const kinds = items.map((x) => kindOf(x));
  return [
    ...top,
    ...items.filter((_, i) => kinds[i] === 'custom'),
    ...items.filter((_, i) => kinds[i] === 'special'),
    ...items.filter((_, i) => !SPECIAL_KINDS.includes(kinds[i])),
  ];
}
