import { VERSION } from './config.js';
import { clip } from './parse.js';

export const COLORS = {
  brand: 0x7c5cff,
  ok: 0x57f287,
  warn: 0xfee75c,
  error: 0xed4245,
  info: 0x5865f2,
  muted: 0x95a5a6,
  system: 0x7c5cff, setup: 0x00b8d9, mod: 0xed4245, automod: 0xe67e22, welcome: 0x57f287, roles: 0x9b59b6,
  levels: 0xfee75c, economy: 0xf1c40f, engage: 0xeb459e, tickets: 0x3498db, tools: 0x1abc9c, voice: 0x2ecc71,
  music: 0xe91e63, games: 0x9b59b6, characters: 0xff8c69, pocket: 0x00bcd4, ai: 0x8e44ad, extras: 0x607d8b,
};

export const ICONS = {
  system: '🖥️', setup: '🚀', mod: '🛡️', automod: '🤖', welcome: '👋', roles: '🎭', levels: '📈', economy: '🪙',
  engage: '🎉', tickets: '🎫', tools: '🧰', voice: '🔊', music: '🎵', games: '🎮', characters: '🎭', pocket: '📱',
  ai: '✨', extras: '🧩', ok: '✅', error: '⛔', warn: '⚠️', info: 'ℹ️', lock: '🔒', unlock: '🔓', undo: '↩️',
};

export const color = (c) => (typeof c === 'number' ? c : COLORS[c] ?? COLORS.brand);

export function card({ title, body, fields = [], color: c = 'brand', footer, thumbnail, image, url } = {}) {
  const e = { color: color(c) };
  if (title) e.title = clip(title, 256);
  if (url) e.url = url;
  if (body) e.description = clip(body, 4000);
  const fs = fields.filter((f) => f && f.name && f.value !== undefined && f.value !== '').slice(0, 10)
    .map((f) => ({ name: clip(f.name, 256), value: clip(String(f.value), 1024), inline: !!f.inline }));
  if (fs.length) e.fields = fs;
  if (footer !== false) e.footer = { text: clip(footer ?? VERSION.full, 2048) };
  if (thumbnail) e.thumbnail = { url: thumbnail };
  if (image) e.image = { url: image };
  return e;
}

export const dialog = {
  ok: (title, body, extra) => card({ title: `${ICONS.ok} ${title}`, body, color: 'ok', ...extra }),
  info: (title, body, extra) => card({ title: `${ICONS.info} ${title}`, body, color: 'info', ...extra }),
  warn: (title, body, extra) => card({ title: `${ICONS.warn} ${title}`, body, color: 'warn', ...extra }),
  error: (title, body, extra) => card({ title: `${ICONS.error} ${title}`, body, color: 'error', ...extra }),
  denied: (need, opts) => denied(need, opts),
};

export const NEED_NAMES = { mod: 'Mod', admin: 'Admin', owner: 'Server owner', botowner: 'Bot owner' };
const NEED_SENTENCES = {
  mod: 'Only moderators can use this.',
  admin: 'Only admins can use this.',
  owner: 'Only the server owner can use this.',
  botowner: 'Only the person who runs YapOS can use this.',
};

export function denied(need, { body, hint, title } = {}) {
  const heading = title || `Needs ${NEED_NAMES[need] || 'more permissions'}`;
  const sentence = body || NEED_SENTENCES[need] || "You don't have permission to use this.";
  return card({ title: `${ICONS.lock} ${heading}`, body: hint ? `${sentence}
-# ${hint}` : sentence, color: 'warn', footer: false });
}

export function button(label, customId, style = 'secondary', emoji, { disabled = false } = {}) {
  const b = { type: 'button', style, label: clip(label, 80) };
  if (style === 'link') b.url = customId;
  else b.custom_id = clip(customId, 100);
  if (emoji) b.emoji = emoji;
  if (disabled) b.disabled = true;
  return b;
}
export const linkButton = (label, url, emoji) => button(label, url, 'link', emoji);

export function row(...buttons) {
  return { type: 'row', components: buttons.flat().filter(Boolean).slice(0, 5) };
}
export function rows(buttons) {
  const out = [];
  const list = buttons.filter(Boolean);
  for (let i = 0; i < list.length && out.length < 5; i += 5) out.push(row(list.slice(i, i + 5)));
  return out;
}

export function select(customId, options, { placeholder, min, max, disabled } = {}) {
  const s = { type: 'select', custom_id: clip(customId, 100), options: options.slice(0, 25).map((o) => {
    const opt = { label: clip(o.label, 100), value: clip(String(o.value), 100) };
    if (o.description) opt.description = clip(o.description, 100);
    if (o.emoji) opt.emoji = o.emoji;
    if (o.default) opt.default = true;
    return opt;
  }) };
  if (placeholder) s.placeholder = clip(placeholder, 150);
  if (min !== undefined) s.min_values = min;
  if (max !== undefined) s.max_values = Math.min(max, s.options.length || 1);
  if (disabled) s.disabled = true;
  return { type: 'row', components: [s] };
}

export function freeze(componentRows, chosenId) {
  return (componentRows || []).map((r) => ({
    ...r,
    components: (r.components || []).map((c) => (c.type === 'button' && c.style !== 'link'
      ? { ...c, disabled: true, style: c.custom_id === chosenId ? 'success' : 'secondary' }
      : c.type === 'select' ? { ...c, disabled: true } : c)),
  }));
}

export function bar(frac, width = 10) {
  const f = Math.max(0, Math.min(1, Number(frac) || 0));
  const full = Math.round(f * width);
  return '█'.repeat(full) + '░'.repeat(width - full);
}

export const onOff = (v) => (v ? '🟢 On' : '⚪ Off');

export const v2 = {
  container: (components, accent = 'brand') => ({ type: 17, accent_color: color(accent), components: components.filter(Boolean) }),
  text: (content) => ({ type: 10, content: clip(content, 4000) }),
  section: (texts, accessory) => ({ type: 9, components: [].concat(texts).slice(0, 3).map((t) => (typeof t === 'string' ? v2.text(t) : t)), accessory }),
  separator: (spacing = 1, divider = true) => ({ type: 14, divider, spacing }),
  button: (label, customId, style = 'secondary', emoji) => {
    const styles = { primary: 1, secondary: 2, success: 3, danger: 4, link: 5 };
    const b = { type: 2, style: styles[style] ?? 2, label: clip(label, 80) };
    if (style === 'link') b.url = customId; else b.custom_id = clip(customId, 100);
    if (emoji) b.emoji = typeof emoji === 'string' ? { name: emoji } : emoji;
    return b;
  },
  row: (...buttons) => ({ type: 1, components: buttons.flat().filter(Boolean).slice(0, 5) }),
};

export function v2ToEmbed(layout) {
  const lines = [];
  const btns = [];
  let accent;
  const walk = (c) => {
    if (!c) return;
    if (c.type === 17) { accent ??= c.accent_color; c.components.forEach(walk); }
    else if (c.type === 10) lines.push(c.content);
    else if (c.type === 9) { c.components.forEach(walk); if (c.accessory?.type === 2) btns.push(c.accessory); }
    else if (c.type === 14) lines.push('');
    else if (c.type === 1) btns.push(...c.components);
  };
  [].concat(layout).forEach(walk);
  const style = { 1: 'primary', 2: 'secondary', 3: 'success', 4: 'danger', 5: 'link' };
  const buttons = btns.map((b) => (b.type === 2
    ? button(b.label, b.url || b.custom_id, style[b.style] || 'secondary', typeof b.emoji === 'object' ? b.emoji?.name : b.emoji)
    : b));
  const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const [first, ...rest] = text.split('\n');
  const title = /^#{1,3}\s/.test(first) ? first.replace(/^#{1,3}\s/, '') : null;
  return { embeds: [card({ title: title || undefined, body: title ? rest.join('\n').trim() : text, color: accent ?? 'brand' })], components: rows(buttons) };
}
