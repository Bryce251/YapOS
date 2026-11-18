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

export const THEMES = Object.freeze([
  Object.freeze({ id: 'midnight', label: 'Midnight', base: '#3b4bd8', alt: '#151a4a', accent: '#8ab4ff', mode: 'dark', pattern: 'stars' }),
  Object.freeze({ id: 'sakura', label: 'Sakura', base: '#f472b6', alt: '#fda4af', accent: '#db2777', mode: 'light', pattern: 'glow' }),
  Object.freeze({ id: 'ocean', label: 'Ocean', base: '#0ea5e9', alt: '#1e40af', accent: '#22d3ee', mode: 'auto', pattern: 'waves' }),
  Object.freeze({ id: 'forest', label: 'Forest', base: '#15803d', alt: '#4d7c0f', accent: '#4ade80', mode: 'auto', pattern: 'glow' }),
  Object.freeze({ id: 'sunset', label: 'Sunset', base: '#f97316', alt: '#be185d', accent: '#fb923c', mode: 'auto', pattern: 'glow' }),
  Object.freeze({ id: 'candy', label: 'Candy', base: '#f472b6', alt: '#818cf8', accent: '#d946ef', mode: 'light', pattern: 'dots' }),
  Object.freeze({ id: 'mono', label: 'Mono', base: '#71717a', alt: '#27272a', accent: '#a1a1aa', mode: 'auto', pattern: 'grid' }),
  Object.freeze({ id: 'neon', label: 'Neon', base: '#d946ef', alt: '#06b6d4', accent: '#39ff14', mode: 'dark', pattern: 'grid' }),
  Object.freeze({ id: 'aurora', label: 'Aurora', base: '#10b981', alt: '#6366f1', accent: '#a78bfa', mode: 'dark', pattern: 'glow' }),
  Object.freeze({ id: 'ember', label: 'Ember', base: '#dc2626', alt: '#ea580c', accent: '#fb923c', mode: 'dark', pattern: 'glow' }),
  Object.freeze({ id: 'frost', label: 'Frost', base: '#7dd3fc', alt: '#c7d2fe', accent: '#0284c7', mode: 'light', pattern: 'dots' }),
  Object.freeze({ id: 'royal', label: 'Royal', base: '#7c3aed', alt: '#b45309', accent: '#fbbf24', mode: 'dark', pattern: 'stars' }),
]);
export const THEME_IDS = Object.freeze(['none', ...THEMES.map((t) => t.id), 'custom']);

export const THEME_MODES = Object.freeze([
  Object.freeze({ id: 'auto', label: 'Match light or dark mode' }),
  Object.freeze({ id: 'dark', label: 'Always dark' }),
  Object.freeze({ id: 'light', label: 'Always light' }),
]);

export const THEME_PATTERNS = Object.freeze([
  Object.freeze({ id: 'glow', label: 'Glow' }),
  Object.freeze({ id: 'dots', label: 'Dots' }),
  Object.freeze({ id: 'grid', label: 'Grid' }),
  Object.freeze({ id: 'waves', label: 'Waves' }),
  Object.freeze({ id: 'stars', label: 'Stars' }),
  Object.freeze({ id: 'plain', label: 'Plain' }),
]);

export const EFFECTS = Object.freeze([
  Object.freeze({ id: 'none', label: 'None' }),
  Object.freeze({ id: 'snow', label: 'Snow' }),
  Object.freeze({ id: 'snowflakes', label: 'Snowflakes' }),
  Object.freeze({ id: 'sakura', label: 'Sakura petals' }),
  Object.freeze({ id: 'stars', label: 'Twinkling stars' }),
  Object.freeze({ id: 'fireflies', label: 'Fireflies' }),
  Object.freeze({ id: 'confetti', label: 'Confetti' }),
  Object.freeze({ id: 'hearts', label: 'Hearts' }),
  Object.freeze({ id: 'bubbles', label: 'Bubbles' }),
  Object.freeze({ id: 'rain', label: 'Rain' }),
  Object.freeze({ id: 'embers', label: 'Embers' }),
  Object.freeze({ id: 'sparkles', label: 'Sparkles' }),
]);
export const EFFECT_IDS = Object.freeze(EFFECTS.map((e) => e.id));

export const THEME_KEYS = Object.freeze(['bg', 'bg2', 'glow', 'surface', 'surface2', 'surface3', 'border', 'borderStrong', 'text', 'text2', 'text3', 'accent', 'accentHover', 'onAccent', 'accentText', 'accentSoft']);
export const BANNER_RATIO = 3;
export const CROP_ZOOM_MAX = 8;

const ids = (list) => new Set(list.map((x) => x.id));
const GRADIENT_IDS = ids(NAME_GRADIENTS);
const FONT_IDS = ids(NAME_FONTS);
const BANNER_IDS = ids(BANNERS);
const RING_IDS = ids(RINGS);
const DENSITY_IDS = ids(DENSITIES);
const FEATURED_IDS = ids(FEATURED);
const SECTION_SET = new Set(SECTION_IDS);
const THEME_SET = new Set(THEME_IDS);
const MODE_IDS = ids(THEME_MODES);
const PATTERN_IDS = ids(THEME_PATTERNS);
const EFFECT_SET = new Set(EFFECT_IDS);
const FIELDS = new Set(['v', 'pins', 'order', 'hidden', 'nameColour', 'nameGradient', 'nameFont', 'accent', 'banner', 'bio', 'pronouns', 'status', 'statusEmoji', 'ring', 'density', 'featured', 'theme', 'themeCustom', 'themeMode', 'themePattern', 'effect', 'bannerCrop']);
const CUSTOM_KEYS = Object.freeze(['base', 'alt', 'accent']);
const CROP_KEYS = Object.freeze(['zoom', 'x', 'y']);

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
  theme: 'none',
  themeCustom: null,
  themeMode: 'auto',
  themePattern: 'glow',
  effect: 'none',
  bannerCrop: null,
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
  look.theme = pick(THEME_SET, src.theme, 'none', strict, 'bad_theme', "That profile theme doesn't exist.");
  look.themeCustom = readThemeCustom(src.themeCustom, strict);
  if (look.theme === 'custom' && !look.themeCustom) {
    fail(strict, 'bad_theme', 'Pick the colours for your custom theme.');
    look.theme = 'none';
  }
  if (look.theme !== 'custom') look.themeCustom = null;
  look.themeMode = pick(MODE_IDS, src.themeMode, 'auto', strict, 'bad_theme_mode', "That theme mode doesn't exist.");
  look.themePattern = pick(PATTERN_IDS, src.themePattern, 'glow', strict, 'bad_theme_pattern', "That background pattern doesn't exist.");
  if (look.theme === 'none') {
    look.themeMode = 'auto';
    look.themePattern = 'glow';
  }
  look.effect = pick(EFFECT_SET, src.effect, 'none', strict, 'bad_effect', "That profile effect doesn't exist.");
  look.bannerCrop = readCrop(src.bannerCrop, strict);
  return look;
}

function readThemeCustom(value, strict) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((k) => !CUSTOM_KEYS.includes(k))) {
    fail(strict, 'bad_theme', 'Pick three colours for your custom theme, like #7c5cff.');
    return null;
  }
  const out = {};
  for (const k of CUSTOM_KEYS) {
    if (typeof value[k] !== 'string' || !HEX_RE.test(value[k])) {
      fail(strict, 'bad_theme', 'Theme colours must look like #7c5cff.');
      return null;
    }
    out[k] = value[k];
  }
  return out;
}

const round4 = (v) => Math.round(v * 10000) / 10000;

export function readCrop(value, strict = false) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((k) => !CROP_KEYS.includes(k))) {
    fail(strict, 'bad_crop', 'The banner position could not be read. Position it again.');
    return null;
  }
  const { zoom, x, y } = value;
  const ok = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
  if (!ok(zoom, 1, CROP_ZOOM_MAX) || !ok(x, 0, 1) || !ok(y, 0, 1)) {
    fail(strict, 'bad_crop', 'The banner position is out of range. Position it again.');
    return null;
  }
  return { zoom: round4(zoom), x: round4(x), y: round4(y) };
}

export function themeById(id) {
  return THEMES.find((t) => t.id === id) || null;
}

function ensure(colour, surfaces, min) {
  const ok = (c) => surfaces.every((s) => contrast(c, s) >= min);
  if (ok(colour)) return colour;
  const light = surfaces.reduce((a, s) => a + luminance(s), 0) / surfaces.length > 0.18;
  const toward = light ? '#000000' : '#ffffff';
  for (let i = 1; i <= 40; i++) {
    const next = mixHex(colour, toward, i / 40);
    if (ok(next)) return next;
  }
  return toward;
}

function onColour(bg) {
  return contrast('#ffffff', bg) >= contrast('#0b0b0d', bg) ? '#ffffff' : '#0b0b0d';
}

export function themeShades({ base, alt, accent }, mode) {
  const dark = mode === 'dark';
  const ink = dark ? '#0d0d12' : '#ffffff';
  const page = dark ? '#06060a' : '#ffffff';
  const far = dark ? '#ffffff' : '#000000';
  const bg = mixHex(base, page, dark ? 0.74 : 0.8);
  const bg2 = mixHex(alt, page, dark ? 0.64 : 0.72);
  const surface = mixHex(base, ink, dark ? 0.86 : 0.94);
  const surface2 = mixHex(base, ink, dark ? 0.8 : 0.89);
  const surface3 = mixHex(base, ink, dark ? 0.74 : 0.85);
  const all = [surface, surface2, surface3, bg, bg2];
  const text = ensure(mixHex(base, far, dark ? 0.94 : 0.88), all, 7);
  const text2 = ensure(mixHex(base, far, dark ? 0.62 : 0.5), all, MIN_CONTRAST);
  const text3 = ensure(mixHex(base, far, dark ? 0.46 : 0.36), all, MIN_CONTRAST);
  let fill = accent;
  const on = onColour(fill);
  if (contrast(on, fill) < MIN_CONTRAST) fill = readableOn(fill, on);
  return {
    bg,
    bg2,
    glow: mixHex(accent, page, dark ? 0.55 : 0.6),
    surface,
    surface2,
    surface3,
    border: mixHex(base, ink, dark ? 0.66 : 0.76),
    borderStrong: mixHex(base, ink, dark ? 0.54 : 0.62),
    text,
    text2,
    text3,
    accent: fill,
    accentHover: mixHex(fill, on === '#ffffff' ? '#000000' : '#ffffff', 0.14),
    onAccent: on,
    accentText: ensure(accent, all, MIN_CONTRAST),
    accentSoft: mixHex(accent, surface, 0.84),
  };
}

export function themeColoursOf(look) {
  if (!look || typeof look !== 'object') return null;
  if (look.theme === 'custom') {
    const c = look.themeCustom;
    return c && typeof c === 'object' && CUSTOM_KEYS.every((k) => typeof c[k] === 'string' && HEX_RE.test(c[k])) ? { base: c.base, alt: c.alt, accent: c.accent } : null;
  }
  const t = themeById(look.theme);
  return t ? { base: t.base, alt: t.alt, accent: t.accent } : null;
}

export function themePalette(look) {
  const colours = themeColoursOf(look);
  if (!colours) return null;
  return {
    id: look.theme,
    mode: MODE_IDS.has(look.themeMode) ? look.themeMode : 'auto',
    pattern: PATTERN_IDS.has(look.themePattern) ? look.themePattern : 'glow',
    light: themeShades(colours, 'light'),
    dark: themeShades(colours, 'dark'),
  };
}

export function cleanPalette(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const shades = (s) => {
    if (!s || typeof s !== 'object') return null;
    const out = {};
    for (const k of THEME_KEYS) {
      if (typeof s[k] !== 'string' || !HEX_RE.test(s[k])) return null;
      out[k] = s[k];
    }
    return out;
  };
  const light = shades(raw.light);
  const dark = shades(raw.dark);
  if (!light || !dark || !THEME_SET.has(raw.id) || raw.id === 'none') return null;
  return { id: raw.id, mode: MODE_IDS.has(raw.mode) ? raw.mode : 'auto', pattern: PATTERN_IDS.has(raw.pattern) ? raw.pattern : 'glow', light, dark };
}

function whole(v) {
  return Math.max(1, Math.floor(Number(v) || 1));
}

export function coverSize(width, height, ratio = BANNER_RATIO) {
  const w = whole(width);
  const ht = whole(height);
  return w / ht > ratio ? { sw: ht * ratio, sh: ht } : { sw: w, sh: w / ratio };
}

export function cropRectFor(width, height, crop) {
  const w = whole(width);
  const ht = whole(height);
  const c = crop && typeof crop === 'object' ? crop : {};
  const fin = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const zoom = Math.min(CROP_ZOOM_MAX, Math.max(1, fin(c.zoom, 1)));
  const sw = coverSize(w, ht).sw / zoom;
  const sh = sw / BANNER_RATIO;
  const cx = Math.min(w - sw / 2, Math.max(sw / 2, fin(c.x, 0.5) * w));
  const cy = Math.min(ht - sh / 2, Math.max(sh / 2, fin(c.y, 0.5) * ht));
  return { sx: cx - sw / 2, sy: cy - sh / 2, sw, sh };
}

export function cropBox(width, height, crop) {
  const w = whole(width);
  const ht = whole(height);
  const r = cropRectFor(w, ht, crop);
  return { width: round4((w / r.sw) * 100), height: round4((ht / r.sh) * 100), left: round4((-r.sx / r.sw) * 100) + 0, top: round4((-r.sy / r.sh) * 100) + 0 };
}

export function lookTexts(look) {
  return [['bio', 'about me', look.bio], ['pronouns', 'pronouns', look.pronouns], ['status', 'status', look.status]].filter(([, , v]) => v);
}

export function pinKey(item, kind) {
  return kind === 'achievement' ? `${ACH_PREFIX}${item.id}` : item.id;
}

export const BANNER_IMAGE_RE = /^\/banner-img\/b-[a-z0-9]{10}-[0-9a-f]{16}\.(png|webp|jpg|gif)$/;
export const BANNER_STILL_RE = /^\/banner-img\/b-[a-z0-9]{10}-[0-9a-f]{16}-still\.(png|webp|jpg)$/;

export function readMotion(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const still = typeof raw.still === 'string' && BANNER_STILL_RE.test(raw.still) ? raw.still : null;
  const w = Number(raw.width);
  const ht = Number(raw.height);
  if (!still || !Number.isInteger(w) || !Number.isInteger(ht) || w < 1 || ht < 1 || w > 10000 || ht > 10000) return null;
  return { still, width: w, height: ht };
}

export function readLook(raw) {
  const look = cleanLook(raw && typeof raw === 'object' ? raw : {});
  const image = raw && typeof raw.bannerImage === 'string' && BANNER_IMAGE_RE.test(raw.bannerImage) ? raw.bannerImage : null;
  if (look.banner === 'image' && !image) look.banner = 'none';
  const motion = image ? readMotion(raw.bannerMotion) : null;
  return { look, bannerImage: image, bannerMotion: motion };
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
