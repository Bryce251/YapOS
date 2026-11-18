import { h, replace } from '../dom.js';
import { icon } from '../icons.js';
import { avatar, badgeArt, button, copyButton, drawer, emptyState, errorState, linkButton, loadingRegion, skeleton } from '../ui.js';
import { formatNumber, formatShort, relativeTime } from '../format.js';
import { ApiError, isAbort } from '../api.js';
import { profilePath } from '../router.js';
import { publicFrame } from '../public-frame.js';
import { levelProgress, normalizeProfile, SEASON_KINDS } from '../community-data.js';
import { medalFor } from '../public-data.js';
import { ACH_PREFIX, EFFECTS, SPECIAL_KINDS, THEME_KEYS, badgeKindOf, cropBox, defaultLook, featuredValue, readLook, specialFirst, themeColours, themePalette } from '../profile-look.js';
import { effectsAllowed, prefersReducedMotion, setEffectsAllowed, startEffect } from '../profile-fx.js';
import { openProfileEditor } from './profile-editor.js';
import { openClanSheet } from './clan-sheet.js';
import { clanParts, clanTagOk } from '../../activity/js/clanjoin.js';

export const THEME_VARS = Object.freeze(THEME_KEYS.map((k) => k.replace(/[A-Z0-9]/g, (c) => `-${c.toLowerCase()}`)));
const THEME_CLASSES = Object.freeze(['has-ptheme', 'pt-mode-auto', 'pt-mode-dark', 'pt-mode-light', 'pt-pat-glow', 'pt-pat-dots', 'pt-pat-grid', 'pt-pat-waves', 'pt-pat-stars', 'pt-pat-plain']);

export function applyTheme(el, look) {
  if (!el) return null;
  for (const c of THEME_CLASSES) el.classList.remove(c);
  for (const v of THEME_VARS) {
    el.style.removeProperty(`--ptl-${v}`);
    el.style.removeProperty(`--ptd-${v}`);
  }
  const pal = look ? themePalette(look) : null;
  if (!pal) return null;
  const light = pal.mode === 'dark' ? pal.dark : pal.light;
  const dark = pal.mode === 'light' ? pal.light : pal.dark;
  THEME_KEYS.forEach((k, i) => {
    el.style.setProperty(`--ptl-${THEME_VARS[i]}`, light[k]);
    el.style.setProperty(`--ptd-${THEME_VARS[i]}`, dark[k]);
  });
  el.classList.add('has-ptheme', `pt-mode-${pal.mode}`, `pt-pat-${pal.pattern}`);
  return pal;
}

export function cropVars(el, motion, crop) {
  const box = cropBox(motion.width, motion.height, crop);
  el.style.setProperty('--crop-w', `${box.width}%`);
  el.style.setProperty('--crop-h', `${box.height}%`);
  el.style.setProperty('--crop-x', `${box.left}%`);
  el.style.setProperty('--crop-y', `${box.top}%`);
  return box;
}

export function effectLabel(id) {
  const e = EFFECTS.find((x) => x.id === id);
  return e ? e.label : 'None';
}

export function effectStage(host, { signal = null, win = globalThis.window, doc = globalThis.document } = {}) {
  let current = null;
  let id = 'none';
  let forced = false;
  const run = () => {
    if (current) current.stop();
    current = null;
    if (id === 'none' || !host || (!forced && !effectsAllowed())) return;
    current = startEffect(host, id, { win, doc });
  };
  signal?.addEventListener?.('abort', () => {
    if (current) current.stop();
    current = null;
  });
  return {
    set(next, { always = false } = {}) {
      const want = typeof next === 'string' ? next : 'none';
      if (want === id && always === forced && (current || want === 'none' || (!always && !effectsAllowed()))) return;
      id = want;
      forced = always;
      run();
    },
    toggle(on) {
      setEffectsAllowed(on);
      run();
    },
    get id() { return id; },
    get running() { return Boolean(current && current.running); },
    stop() {
      if (current) current.stop();
      current = null;
      id = 'none';
    },
  };
}

export const PROFILE_API = '/api/u';
export const NOTICES_API = '/api/me/profile-notices';
export const HIDDEN_HANDLE = 'hidden';
const RESET_TEXT = Object.freeze({
  profile_banner_remove: 'your banner picture was removed',
  profile_name_style_reset: 'your name colour and style were reset',
  profile_pins_clear: 'your pinned badges were cleared',
  profile_theme_reset: 'your profile theme was reset',
  profile_effect_clear: 'your profile effect was turned off',
  profile_reset: 'your whole profile look was reset to the default',
});
const FIELD_TEXT = Object.freeze({ bio: 'about me', status: 'status', pronouns: 'pronouns' });

function joinWords(list) {
  return list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}` : list[0] || '';
}

export function resetText(r) {
  if (!r || typeof r !== 'object') return '';
  if (RESET_TEXT[r.action]) return RESET_TEXT[r.action];
  if (r.action === 'profile_text_clear') {
    const fields = (Array.isArray(r.fields) ? r.fields : []).filter((f) => FIELD_TEXT[f]).map((f) => FIELD_TEXT[f]);
    return fields.length ? `your ${joinWords(fields)} ${fields.length === 1 && fields[0] !== 'pronouns' ? 'was' : 'were'} cleared` : 'some of your profile text was cleared';
  }
  return '';
}

export function noticeLines(data) {
  const out = [];
  const hidden = data && data.hidden && typeof data.hidden === 'object' ? data.hidden : {};
  const both = Boolean(hidden.name && hidden.username);
  if (both) out.push({ kind: 'hidden', text: 'Staff hid your display name and username on YapOS. Others see “Hidden name” and “@hidden” instead. Your Yapin’ name is not changed.' });
  else if (hidden.name) out.push({ kind: 'hidden', text: 'Staff hid your display name on YapOS. Others see “Hidden name” instead. Your Yapin’ name is not changed.' });
  else if (hidden.username) out.push({ kind: 'hidden', text: 'Staff hid your username on YapOS. Others see “@hidden” instead. Your Yapin’ username is not changed.' });
  const seen = new Set();
  const parts = [];
  for (const r of Array.isArray(data?.resets) ? data.resets : []) {
    const text = resetText(r);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    parts.push({ text, at: Number(r.at) || 0 });
  }
  if (parts.length) {
    const words = joinWords(parts.map((x) => x.text));
    out.push({ kind: 'reset', text: `Staff reset part of your profile: ${words}. You can change it again in Customize profile, as long as it follows the rules.`, at: Math.max(...parts.map((x) => x.at)) });
  }
  return out;
}

export function noticeBox(lines) {
  if (!Array.isArray(lines) || !lines.length) return null;
  return h('div', { class: 'notice profile-staff-notice', attrs: { role: 'status' } },
    icon('info', { size: 16 }),
    h('div', { class: 'profile-staff-notice-text' }, ...lines.map((l) => h('p', { text: l.text }))));
}
export const BADGE_TILES = 12;
const NS = 'http://www.w3.org/2000/svg';

export const BADGE_GROUPS = Object.freeze([
  Object.freeze({ id: 'custom', label: 'One-of-a-kind badges', blurb: 'Made by Jolli for special moments.' }),
  Object.freeze({ id: 'special', label: 'Special badges', blurb: 'Given by the YapOS team.' }),
  Object.freeze({ id: 'party', label: 'Party badges', blurb: 'Earned by playing YapOS Party.' }),
  Object.freeze({ id: 'season', label: 'Season badges', blurb: 'Top finishes in a monthly season.' }),
  Object.freeze({ id: 'achievement', label: 'Achievements', blurb: 'Earned with the YapOS bot in your servers.' }),
]);

function svg(tag, attrs = {}) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

export function levelRing(level, xp) {
  const prog = levelProgress(level, xp);
  const pct = Math.round(prog.frac * 100);
  const fill = svg('circle', { class: 'level-ring-fill', cx: 50, cy: 50, r: 44, pathLength: 100 });
  fill.style.setProperty('--p', String(pct));
  const ring = svg('svg', { class: 'level-ring-svg', viewBox: '0 0 100 100', 'aria-hidden': 'true', focusable: 'false' });
  ring.append(svg('circle', { class: 'level-ring-track', cx: 50, cy: 50, r: 44, pathLength: 100 }), fill);
  const label = prog.known
    ? `Level ${formatNumber(prog.level)}, ${formatNumber(prog.into)} of ${formatNumber(prog.need)} XP to the next level`
    : `Level ${formatNumber(prog.level)}`;
  return h('div', { class: 'level-ring', attrs: { role: 'img', 'aria-label': label } },
    ring,
    h('span', { class: 'level-ring-text' },
      h('span', { class: 'level-ring-num', text: formatNumber(prog.level) }),
      h('span', { class: 'level-ring-cap', text: 'Level' })));
}

function stat(label, n, iconName) {
  const exact = formatNumber(n);
  const value = formatShort(n);
  return h('div', { class: 'profile-stat', title: value === exact ? null : `${exact} ${label}` },
    h('span', { class: 'profile-stat-icon' }, icon(iconName, { size: 16 })),
    h('span', { class: 'profile-stat-value', text: value }),
    h('span', { class: 'profile-stat-label', text: label }));
}

function featureTile(f) {
  const text = `${formatShort(f.value)}${f.suffix || ''}`;
  const exact = `${formatNumber(f.value)}${f.suffix || ''}`;
  return h('div', { class: 'profile-feature', title: exact === text ? null : exact, dataset: { featured: f.id }, attrs: { role: 'img', 'aria-label': `${f.label}: ${exact}` } },
    h('span', { class: 'profile-feature-num', text }),
    h('span', { class: 'profile-feature-cap', text: f.label }));
}

export function clanTag(clan, onOpen = null) {
  if (!clan) return null;
  const parts = clanParts(clan);
  if (!parts) return null;
  const kids = [
    parts.code ? h('span', { class: 'clan-tag-code', text: parts.code }) : null,
    parts.name ? h('span', { class: 'clan-tag-name', text: parts.name }) : parts.code ? null : h('span', { class: 'clan-tag-name', text: clan.name }),
  ];
  const live = typeof onOpen === 'function' && clanTagOk(clan.tag);
  const el = live
    ? h('button', { type: 'button', class: 'clan-tag', title: `${parts.full}: see the clan and join`, dataset: { clan: clan.tag.toUpperCase() }, attrs: { 'aria-haspopup': 'dialog', 'aria-label': `Clan ${parts.full}. Open clan` }, on: { click: () => onOpen(clan.tag) } }, ...kids)
    : h('span', { class: 'clan-tag', title: clan.name }, ...kids);
  if (clan.colour) el.style.setProperty('--clan', clan.colour);
  return el;
}

function tileGrid(items, label, pinned = new Set()) {
  return h('ul', { class: 'badge-grid', attrs: { 'aria-label': label } },
    ...items.map((b, i) => h('li', { class: ['badge-tile', b.note ? 'has-note' : '', pinned.has(b.key) ? 'is-pinned' : '', isSpecial(b) ? 'is-special' : ''], title: b.note ? `${b.label}: ${b.note}` : b.label, style: { '--i': String(Math.min(i, 12)) } },
      b.image ? badgeArt(b, 'badge-tile-emoji', 'badge-tile-img') : h('span', { class: 'badge-tile-emoji', attrs: { 'aria-hidden': 'true' }, text: b.emoji }),
      h('span', { class: 'badge-tile-label', text: b.label }),
      b.note ? h('span', { class: 'badge-tile-note', text: b.note }) : null)));
}

function section(id, title, iconName, body, { wide = false, action = null } = {}) {
  return h('section', { class: ['profile-section', wide ? 'is-wide' : ''], dataset: { section: id } },
    h('div', { class: 'profile-section-head' },
      h('h2', { class: 'profile-section-title' }, icon(iconName, { size: 16 }), h('span', { text: title })),
      action),
    body);
}

export function placingText(s) {
  const kind = SEASON_KINDS[s.kind] || SEASON_KINDS.xp;
  return `#${s.rank} for ${kind.long} in ${s.label}`;
}

function placingRow(s) {
  const medal = medalFor(s.rank);
  return h('li', { class: 'placing-row' },
    medal
      ? h('span', { class: ['medal', `medal-${medal}`], attrs: { 'aria-hidden': 'true' } }, h('span', { text: String(s.rank) }))
      : h('span', { class: 'rank-num', attrs: { 'aria-hidden': 'true' }, text: String(s.rank) }),
    h('span', { class: 'placing-text', text: placingText(s) }));
}

export function badgeKind(id, hints = {}) {
  return badgeKindOf(id, (k) => Object.prototype.hasOwnProperty.call(hints, k));
}

export function isSpecial(b) {
  return SPECIAL_KINDS.includes(b.kind);
}

export function orderedBadges(p, hints = {}) {
  return specialFirst(p.badges.map((b) => ({ ...b, key: b.id, kind: badgeKind(b.id, hints) })), (b) => b.kind);
}

export function allBadges(p, hints = {}) {
  const out = [
    ...orderedBadges(p, hints),
    ...p.achievements.map((a) => ({ ...a, key: `${ACH_PREFIX}${a.id}`, kind: 'achievement' })),
  ];
  return out.map((b) => ({ ...b, about: b.note || hints[b.id] || '' }));
}

export function pinnedItems(p, pins, hints = {}) {
  const all = allBadges(p, hints);
  return pins.map((k) => all.find((b) => b.key === k)).filter(Boolean);
}

export function groupBadges(list) {
  return BADGE_GROUPS.map((g) => ({ ...g, items: list.filter((b) => b.kind === g.id) })).filter((g) => g.items.length);
}

export function openAllBadges(p, { pins = [], hints = {}, name = '' } = {}) {
  const list = allBadges(p, hints);
  const pinned = new Set(pins);
  const d = drawer({ title: 'All badges', subtitle: `${name || p.name} has ${formatNumber(list.length)} ${list.length === 1 ? 'badge' : 'badges'}` });
  d.root.classList.add('allbadges');
  const groups = groupBadges(list);
  replace(d.body, groups.length
    ? h('div', { class: 'allbadges-groups' }, ...groups.map((g) => h('section', { class: ['allbadges-group', SPECIAL_KINDS.includes(g.id) ? 'is-special' : ''], dataset: { group: g.id } },
      h('h3', { class: 'allbadges-title' }, h('span', { text: g.label }), h('span', { class: 'allbadges-count', text: formatNumber(g.items.length) })),
      h('p', { class: 'allbadges-blurb muted', text: g.blurb }),
      h('ul', { class: 'allbadges-list' }, ...g.items.map((b) => h('li', { class: ['allbadges-row', pinned.has(b.key) ? 'is-pinned' : '', isSpecial(b) ? 'is-special' : ''] },
        h('span', { class: 'allbadges-art' }, badgeArt(b, 'allbadges-emoji', 'allbadges-img')),
        h('span', { class: 'allbadges-main' },
          h('span', { class: 'allbadges-name', text: b.label }),
          b.about ? h('span', { class: 'allbadges-about', text: b.about }) : null),
        pinned.has(b.key) ? h('span', { class: 'allbadges-pin' }, icon('star', { size: 12 }), h('span', { text: 'Pinned' })) : null))))))
    : emptyState({ icon: 'star', title: 'No badges yet', body: 'Badges come from playing YapOS Party and using the YapOS bot.', compact: true }));
  return d;
}

function nameHeading(name, look) {
  const el = h('h1', {
    class: ['profile-name', look.nameGradient ? `name-grad-${look.nameGradient}` : '', look.nameColour && !look.nameGradient ? 'has-name-colour' : '', look.nameFont !== 'default' ? `name-font-${look.nameFont}` : ''],
    text: name,
  });
  const c = !look.nameGradient && look.nameColour ? themeColours(look.nameColour) : null;
  if (c) {
    el.style.setProperty('--nc-light', c.light);
    el.style.setProperty('--nc-dark', c.dark);
  }
  return el;
}

export function movingBanner(image, motion, crop, { className = 'profile-banner-img', priority = true } = {}) {
  const img = h('img', { class: [className, 'is-crop'], src: image, alt: '', decoding: 'async', attrs: { draggable: 'false', fetchpriority: priority ? 'high' : null } });
  cropVars(img, motion, crop);
  return h('picture', { class: 'banner-pic' }, h('source', { attrs: { media: '(prefers-reduced-motion: reduce)', srcset: motion.still } }), img);
}

function bannerEl(look, image, motion) {
  if (look.banner === 'none') return null;
  if (look.banner === 'image') {
    if (!image) return null;
    if (motion) return h('div', { class: 'profile-banner banner-image is-moving', attrs: { 'aria-hidden': 'true' } }, movingBanner(image, motion, look.bannerCrop));
    return h('div', { class: 'profile-banner banner-image', attrs: { 'aria-hidden': 'true' } },
      h('img', { class: 'profile-banner-img', src: image, alt: '', decoding: 'async', attrs: { draggable: 'false', fetchpriority: 'high' } }));
  }
  return h('div', { class: ['profile-banner', `banner-${look.banner}`], attrs: { 'aria-hidden': 'true' } });
}

function pinRow(items, clan = null) {
  if (!items.length && !clan) return null;
  const label = clan && items.length ? 'Clan and pinned badges' : clan ? 'Clan' : 'Pinned badges';
  return h('ul', { class: ['profile-pins', clan ? 'has-clan' : ''], attrs: { 'aria-label': label } },
    clan ? h('li', { class: 'profile-pins-clan' }, clan) : null,
    ...items.map((b, i) => h('li', { class: ['profile-pin', isSpecial(b) ? 'is-special' : ''], title: b.about ? `${b.label}: ${b.about}` : b.label, style: { '--i': String(i) } },
      h('span', { class: 'profile-pin-art' }, badgeArt(b, 'profile-pin-emoji', 'profile-pin-img')),
      h('span', { class: 'profile-pin-label', text: b.label }))));
}

export function heroBand(status, chips) {
  if (!status && !chips) return null;
  return h('div', { class: ['profile-band', status ? 'has-status' : '', chips ? 'has-chips' : ''] }, status, chips);
}

export const TILT_MAX = 10;
export const TILT_SELECTOR = '.badge-tile, .profile-pin, .profile-stat, .profile-feature';

export function tiltFor(x, y, rect, max = TILT_MAX) {
  const w = Math.max(1, Number(rect && rect.width) || 1);
  const ht = Math.max(1, Number(rect && rect.height) || 1);
  const nx = Math.min(1, Math.max(0, (x - (Number(rect && rect.left) || 0)) / w)) - 0.5;
  const ny = Math.min(1, Math.max(0, (y - (Number(rect && rect.top) || 0)) / ht)) - 0.5;
  return { rx: Math.round(-ny * max * 2 * 100) / 100 + 0, ry: Math.round(nx * max * 2 * 100) / 100 + 0, gx: Math.round((nx + 0.5) * 100), gy: Math.round((ny + 0.5) * 100) };
}

export function addTilt(card, win = globalThis.window) {
  if (!card || prefersReducedMotion(win)) return;
  let active = null;
  const reset = (el) => {
    if (!el) return;
    el.classList.remove('is-tilting');
    for (const k of ['--rx', '--ry', '--gx', '--gy']) el.style.removeProperty(k);
  };
  card.addEventListener('pointermove', (e) => {
    if (e.pointerType && e.pointerType !== 'mouse') return;
    const el = e.target && typeof e.target.closest === 'function' ? e.target.closest(TILT_SELECTOR) : null;
    if (active && active !== el) reset(active);
    active = el;
    if (!el) return;
    const t = tiltFor(e.clientX, e.clientY, el.getBoundingClientRect());
    el.classList.add('is-tilting');
    el.style.setProperty('--rx', `${t.rx}deg`);
    el.style.setProperty('--ry', `${t.ry}deg`);
    el.style.setProperty('--gx', `${t.gx}%`);
    el.style.setProperty('--gy', `${t.gy}%`);
  });
  card.addEventListener('pointerleave', () => {
    reset(active);
    active = null;
  });
}

export function profileCard(p, opts = {}) {
  const { own = false, look: given = null, bannerImage = null, bannerMotion = null, hints = {}, onCustomize = null, editing = false, fx = null, onClan = null } = opts;
  const look = given || defaultLook();
  const share = `${window.location.origin}${profilePath(p.username || p.sharePath || p.name)}`;
  const hidden = new Set(look.hidden);
  const pins = pinnedItems(p, look.pins, hints);
  const pinKeys = new Set(pins.map((b) => b.key));
  const total = p.badges.length + p.achievements.length;
  const openAll = () => openAllBadges(p, { pins: look.pins, hints });

  const featured = featuredValue(look.featured, p);
  const stats = [];
  if (featured.id !== 'level') stats.push(stat('Level', p.level, 'star'));
  if (featured.id !== 'games') stats.push(stat('Party games', p.games, 'sparkles'));
  if (featured.id !== 'wins') stats.push(stat('Party wins', p.wins, 'trophy'));
  if (p.shards !== null && featured.id !== 'shards') stats.push(stat('💎 Shards', p.shards, 'coins'));

  const badgeItems = [...pins.filter((b) => b.kind !== 'achievement'), ...orderedBadges(p, hints).filter((b) => !pinKeys.has(b.key))];
  const achItems = [...pins.filter((b) => b.kind === 'achievement'), ...p.achievements.map((a) => ({ ...a, key: `${ACH_PREFIX}${a.id}` })).filter((a) => !pinKeys.has(a.key))];
  const viewAll = total ? button({ label: `View all badges (${formatNumber(total)})`, icon: 'list', size: 'sm', variant: 'ghost', className: 'profile-all-badges', onClick: openAll }) : null;

  const builders = {
    about: () => (look.bio ? section('about', 'About me', 'user', h('p', { class: 'profile-bio', text: look.bio }), { wide: true }) : null),
    stats: () => h('div', { class: 'profile-stats', dataset: { section: 'stats' } }, featured.id === 'level' ? levelRing(p.level, p.xp) : featureTile(featured), ...stats),
    badges: () => section('badges', 'Badges', 'star', badgeItems.length
      ? tileGrid(badgeItems.slice(0, BADGE_TILES), 'Badges', pinKeys)
      : h('p', { class: 'muted', text: 'No badges yet. They come from playing YapOS Party.' }), { wide: true, action: viewAll }),
    achievements: () => (achItems.length ? section('achievements', 'Achievements', 'trophy', tileGrid(achItems, 'Achievements', pinKeys)) : null),
    favourites: () => section('favourites', 'Favourite games', 'smile', p.favourites.length
      ? h('ul', { class: 'fav-list' }, ...p.favourites.map((g) => h('li', { class: 'fav-row' },
        h('span', { class: 'fav-emoji', attrs: { 'aria-hidden': 'true' }, text: g.emoji }),
        h('span', { class: 'fav-name', text: g.name }),
        g.plays !== null ? h('span', { class: 'fav-plays', text: `${formatNumber(g.plays)} ${g.plays === 1 ? 'game' : 'games'}${g.won ? ` · ${formatNumber(g.won)} ${g.won === 1 ? 'win' : 'wins'}` : ''}` }) : null)))
      : h('p', { class: 'muted', text: 'No Party games played yet.' })),
    placings: () => section('placings', 'Season placings', 'activity', p.season.length
      ? h('ol', { class: 'placing-list' }, ...p.season.slice(0, 12).map(placingRow))
      : h('p', { class: 'muted', text: 'No top 10 finishes yet.' })),
  };
  const blocks = look.order.filter((id) => !hidden.has(id) && builders[id]).map((id) => builders[id]()).filter(Boolean);

  const banner = bannerEl(look, bannerImage, bannerMotion);
  const status = look.status || look.statusEmoji
    ? h('p', { class: 'profile-status' },
      look.statusEmoji ? h('span', { class: 'profile-status-emoji', attrs: { 'aria-hidden': 'true' }, text: look.statusEmoji }) : null,
      look.status ? h('span', { class: 'profile-status-text', text: look.status }) : null)
    : null;
  const themed = look.theme && look.theme !== 'none';
  const fxOn = !editing && fx && look.effect && look.effect !== 'none';
  const fxBtn = fxOn ? h('button', { type: 'button', class: ['btn', 'btn-ghost', 'btn-sm', 'profile-fx-toggle'], attrs: { 'aria-pressed': effectsAllowed() ? 'true' : 'false', title: `${effectLabel(look.effect)} effect` } }, icon('sparkles', { size: 14 }), h('span', { class: 'btn-label profile-fx-text', text: effectsAllowed() ? 'Effects on' : 'Effects off' })) : null;
  if (fxBtn) {
    fxBtn.addEventListener('click', () => {
      const on = !effectsAllowed();
      fx.toggle(on);
      fxBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
      fxBtn.querySelector('.profile-fx-text').textContent = on ? 'Effects on' : 'Effects off';
    });
  }
  const card = h('article', { class: ['profile-card', `look-${look.density}`, banner ? 'has-banner' : '', look.accent ? 'has-accent' : '', themed ? 'is-themed' : '', editing ? 'is-preview' : 'is-enter', look.ring !== 'none' ? 'has-ring' : ''] },
    banner,
    h('div', { class: 'profile-hero' },
      h('div', { class: 'profile-hero-top' },
        h('div', { class: ['profile-avatar-wrap', look.ring !== 'none' ? `ring-${look.ring}` : ''] }, avatar({ name: p.name, url: p.avatar, id: p.id || p.username, size: 'xl' })),
        h('div', { class: 'profile-who' },
          nameHeading(p.name, look),
          h('div', { class: 'profile-sub' },
            p.username ? h('span', { class: 'profile-handle', text: `@${p.username}` }) : p.usernameHidden ? h('span', { class: 'profile-handle', text: `@${HIDDEN_HANDLE}` }) : null,
            look.pronouns ? h('span', { class: 'profile-pronouns', text: look.pronouns }) : null)),
        editing ? null : h('div', { class: 'profile-actions' },
          copyButton({ getText: () => share, label: 'Copy link', size: 'sm' }),
          own && onCustomize ? button({ label: 'Customize profile', icon: 'palette', size: 'sm', variant: 'primary', className: 'profile-customize', onClick: onCustomize }) : null,
          own ? linkButton({ label: 'Privacy', href: '/account', icon: 'lock', size: 'sm' }) : null,
          fxBtn)),
      heroBand(status, pinRow(pins, clanTag(p.clan, editing ? null : onClan))),
      p.updatedAt ? h('p', { class: 'public-meta' }, icon('clock', { size: 14 }), h('span', { text: `Updated ${relativeTime(p.updatedAt)}` })) : null),
    h('div', { class: 'profile-sections' }, ...blocks));
  if (look.accent) {
    const c = themeColours(look.accent);
    card.style.setProperty('--ac-base', c.base);
    card.style.setProperty('--ac-light', c.light);
    card.style.setProperty('--ac-dark', c.dark);
  }
  card.querySelectorAll('.profile-section, .profile-stats').forEach((el, i) => el.style.setProperty('--i', String(i)));
  addTilt(card);
  return card;
}

function profileSkeleton() {
  return loadingRegion('Loading profile', h('div', { class: 'profile-card' },
    h('div', { class: 'profile-hero' }, skeleton('skeleton-avatar-xl'), h('div', { class: 'profile-who' }, skeleton('skeleton-title skeleton-w-50'), skeleton('skeleton-text skeleton-w-30')))));
}

export function hintsFrom(data) {
  const out = {};
  for (const b of Array.isArray(data?.partyBadges) ? data.partyBadges : []) {
    if (b && typeof b.id === 'string' && typeof b.hint === 'string') out[b.id] = b.hint.slice(0, 160);
  }
  return out;
}

export function renderProfile(root, ctx) {
  const { api, params, signal } = ctx;
  const frame = publicFrame(root);
  const { content } = frame;
  const fx = effectStage(frame.site, { signal });
  signal?.addEventListener?.('abort', () => applyTheme(frame.site, null));
  frame.setUser(null);
  let user = null;
  let shown = null;
  let editor = null;
  let notices = null;
  let asked = false;
  ctx.getUser?.().then((u) => {
    if (signal.aborted) return;
    user = u || null;
    frame.setUser(user);
    if (shown && !editor) draw(shown);
  }).catch(() => {});

  function isOwn(v) {
    const p = v.profile;
    const wanted = String(params.name || '').trim().replace(/^@+/, '').toLowerCase();
    return Boolean(user && ((p.id && user.id === p.id) || (p.username && String(user.username || '').toLowerCase() === p.username.toLowerCase()) || (p.usernameHidden && wanted && String(user.username || '').toLowerCase() === wanted)));
  }

  function draw(v) {
    shown = v;
    ctx.setTitle(v.profile.name);
    const own = isOwn(v);
    const card = profileCard(v.profile, { own, look: v.look, bannerImage: v.bannerImage, bannerMotion: v.bannerMotion, hints: v.hints, fx, onCustomize: own ? () => edit(v) : null, onClan: (tag) => openClanSheet(tag, { api, signal, clan: v.profile.clan }) });
    applyTheme(frame.site, v.look);
    fx.set(v.look.effect);
    replace(content, own ? noticeBox(notices) : null, card);
    if (own) askNotices();
  }

  function askNotices() {
    if (asked) return;
    asked = true;
    api.get(NOTICES_API, { signal, allow401: true }).then((data) => {
      if (signal.aborted) return;
      notices = noticeLines(data);
      if (notices.length && shown && !editor) draw(shown);
    }).catch(() => {});
  }

  function edit(v) {
    editor = openProfileEditor({
      mount: content,
      profile: v.profile,
      look: v.look,
      bannerImage: v.bannerImage,
      bannerMotion: v.bannerMotion,
      hints: v.hints,
      api,
      signal,
      renderCard: (look, bannerImage, bannerMotion) => profileCard(v.profile, { own: true, look, bannerImage, bannerMotion, hints: v.hints, editing: true }),
      onLook: (look) => {
        applyTheme(frame.site, look);
        fx.set(look.effect, { always: true });
      },
      onDone: (saved) => {
        editor = null;
        ctx.setLeaveGuard?.(null);
        if (saved) {
          v.look = saved.look;
          v.bannerImage = saved.bannerImage;
          v.bannerMotion = saved.bannerMotion || null;
        }
        draw(v);
      },
    });
    ctx.setLeaveGuard?.({ isDirty: () => Boolean(editor && editor.isDirty()) });
  }

  const load = async () => {
    replace(content, profileSkeleton());
    try {
      const data = await api.get(`${PROFILE_API}/${encodeURIComponent(params.name || '')}`, { signal, allow401: true });
      if (signal.aborted) return;
      const p = normalizeProfile(data);
      if (!p) throw new ApiError("We couldn't find that.", { status: 404, code: 'not_found' });
      const custom = readLook(data?.profile?.custom);
      p.nameHidden = data?.profile?.nameHidden === true;
      p.usernameHidden = data?.profile?.usernameHidden === true;
      if (p.usernameHidden) p.sharePath = String(params.name || '').trim().replace(/^@+/, '');
      draw({ profile: p, look: custom.look, bannerImage: custom.bannerImage, bannerMotion: custom.bannerMotion, hints: hintsFrom(data) });
    } catch (err) {
      if (isAbort(err) || signal.aborted) return;
      if (err instanceof ApiError && err.status === 404) {
        ctx.setTitle('Profile not found');
        replace(content, emptyState({
          icon: 'eye-off',
          title: "This profile isn't available",
          body: "Either nobody has this name on YapOS yet, or they've chosen to keep their profile private.",
          action: linkButton({ label: 'Open the leaderboard', href: '/p/global' }),
        }));
        return;
      }
      replace(content, errorState({ title: "Couldn't load this profile", body: err.message, onRetry: load }));
    }
  };
  load();
}

