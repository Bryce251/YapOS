import { h, nextId, replace } from '../dom.js';
import { icon } from '../icons.js';
import { badgeArt, button, card, confirmDialog, setBusy, toast } from '../ui.js';
import { ApiError } from '../api.js';
import { formatNumber } from '../format.js';
import { badgeImage } from '../community-data.js';

export const OWNER_BADGES_PATH = '/api/owner/badges';
export const IMAGE_SIZE = 128;
export const IMAGE_MAX_BYTES = 60 * 1024;
export const FILE_MAX_BYTES = 15 * 1024 * 1024;
export const NAME_MAX = 32;
export const NOTE_MAX = 100;
export const EMOJI_MAX = 8;
export const DEFAULT_EMOJI = '\u{1F3C5}';
export const WEBP_QUALITIES = [0.92, 0.85, 0.75, 0.6, 0.45];
export const PNG_SIZES = [128, 96, 64];
export const PREVIEW_SIZES = Object.freeze([
  Object.freeze({ px: 44, label: 'Party card' }),
  Object.freeze({ px: 32, label: 'Profile page' }),
  Object.freeze({ px: 18, label: 'Lists and pills' }),
]);
export const ACCEPT = 'image/png,image/jpeg,image/webp,image/gif';
export const NOT_A_PICTURE = "That file isn't a picture YapOS can use. Use a PNG, JPG, WebP or GIF.";
export const NO_SVG = "SVG files can't be used for badges. Save it as a PNG first.";

const str = (v) => (typeof v === 'string' ? v : '');
const whole = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.floor(Number(v))) : 0);

export function sniffFile(head, type = '', name = '') {
  const b = head instanceof Uint8Array ? head : new Uint8Array(0);
  const t = String(type || '').toLowerCase();
  const n = String(name || '').toLowerCase();
  if (t.includes('svg') || n.endsWith('.svg') || n.endsWith('.svgz')) return 'svg';
  const ascii = String.fromCharCode(...b.subarray(0, 16));
  if (b[0] === 0x89 && ascii.slice(1, 4) === 'PNG') return 'png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (ascii.slice(0, 4) === 'RIFF' && ascii.slice(8, 12) === 'WEBP') return 'webp';
  if (ascii.slice(0, 4) === 'GIF8') return 'gif';
  const text = new TextDecoder().decode(b.subarray(0, 64)).replace(/^﻿/, '').trimStart().toLowerCase();
  if (text.startsWith('<')) return text.includes('svg') ? 'svg' : 'markup';
  return null;
}

export function coverRect(width, height) {
  const w = Math.max(1, whole(width));
  const ht = Math.max(1, whole(height));
  const side = Math.min(w, ht);
  return { sx: Math.floor((w - side) / 2), sy: Math.floor((ht - side) / 2), sw: side, sh: side };
}

export function dataUrlBytes(url) {
  const at = str(url).indexOf(',');
  if (at < 0) return 0;
  const b64 = url.slice(at + 1);
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - pad);
}

export function sizeText(bytes) {
  return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${formatNumber(bytes)} bytes`;
}

function drawTo(doc, src, size) {
  const canvas = doc.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const c = canvas.getContext('2d');
  if (!c) throw new Error("Your browser can't resize pictures here. Try another browser.");
  const r = coverRect(src.naturalWidth || src.width, src.naturalHeight || src.height);
  c.clearRect(0, 0, size, size);
  c.imageSmoothingEnabled = true;
  c.imageSmoothingQuality = 'high';
  c.drawImage(src, r.sx, r.sy, r.sw, r.sh, 0, 0, size, size);
  return canvas;
}

export function encodeBadge(src, { doc = document, max = IMAGE_MAX_BYTES } = {}) {
  const big = drawTo(doc, src, IMAGE_SIZE);
  for (const q of WEBP_QUALITIES) {
    const url = big.toDataURL('image/webp', q);
    if (!url.startsWith('data:image/webp')) break;
    const bytes = dataUrlBytes(url);
    if (bytes <= max) return { dataUrl: url, type: 'WebP', size: IMAGE_SIZE, bytes };
  }
  for (const size of PNG_SIZES) {
    const canvas = size === IMAGE_SIZE ? big : drawTo(doc, src, size);
    const url = canvas.toDataURL('image/png');
    const bytes = dataUrlBytes(url);
    if (url.startsWith('data:image/png') && bytes <= max) return { dataUrl: url, type: 'PNG', size, bytes };
  }
  throw new Error(`That picture is too detailed to fit in ${Math.round(max / 1024)} KB. Try a simpler one.`);
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error("That file couldn't be opened."));
    r.readAsDataURL(file);
  });
}

async function loadPicture(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file);
    } catch {}
  }
  const url = await readAsDataUrl(file);
  const img = new Image();
  img.decoding = 'async';
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = () => reject(new Error(NOT_A_PICTURE));
    img.src = url;
  });
  return img;
}

export async function processFile(file) {
  if (!file) throw new Error('Pick a picture first.');
  if (Number(file.size) > FILE_MAX_BYTES) throw new Error(`That file is bigger than ${Math.round(FILE_MAX_BYTES / 1024 / 1024)} MB. Pick a smaller picture.`);
  const head = new Uint8Array(await file.slice(0, 64).arrayBuffer());
  const kind = sniffFile(head, file.type, file.name);
  if (kind === 'svg') throw new Error(NO_SVG);
  if (!['png', 'jpeg', 'webp', 'gif'].includes(kind)) throw new Error(NOT_A_PICTURE);
  const src = await loadPicture(file);
  try {
    return encodeBadge(src);
  } finally {
    if (typeof src.close === 'function') src.close();
  }
}

export function readBadge(b) {
  if (!b || typeof b !== 'object' || typeof b.id !== 'string') return null;
  return {
    id: b.id,
    name: str(b.name) || b.id,
    note: str(b.note),
    emoji: str(b.emoji) || DEFAULT_EMOJI,
    image: badgeImage(b.image),
    bytes: whole(b.bytes),
    holders: whole(b.holders),
  };
}

export function readBadges(data) {
  const d = data && typeof data === 'object' ? data : {};
  return { badges: (Array.isArray(d.badges) ? d.badges : []).map(readBadge).filter(Boolean), max: whole(d.max) || 100 };
}

export function checkForm({ name, note, emoji, image, editing }) {
  const n = str(name).trim();
  if (!n) return 'Give the badge a name.';
  if (Array.from(n).length > NAME_MAX) return `Keep the name to ${NAME_MAX} characters or fewer.`;
  if (Array.from(str(note).trim()).length > NOTE_MAX) return `Keep the description to ${NOTE_MAX} characters or fewer.`;
  if (Array.from(str(emoji).trim()).length > EMOJI_MAX) return 'Use one emoji for the fallback.';
  if (!editing && !image) return 'Pick a picture for the badge.';
  return null;
}

export function badgeBody({ name, note, emoji, image }) {
  const body = { name: str(name).trim(), note: str(note).trim(), emoji: str(emoji).trim() };
  if (image) body.image = image;
  return body;
}

export function holdersText(n) {
  if (!n) return 'Nobody has it yet';
  return n === 1 ? '1 person has it' : `${formatNumber(n)} people have it`;
}

export function deleteText(b) {
  return {
    title: `Delete “${b.name}”?`,
    body: b.holders
      ? `${holdersText(b.holders)}. Deleting it takes it off ${b.holders === 1 ? 'their' : 'all of their'} profiles, Party cards and /profile straight away. This can't be undone.`
      : "Nobody has this badge yet. This can't be undone.",
  };
}

function field(label, input, help) {
  return h('div', { class: 'owner-field' }, h('label', { class: 'field-label', htmlFor: input.id, text: label }), input, help || null);
}

export function badgeMakerCard(ctx, deps = {}) {
  const { api } = ctx;
  const encode = deps.encode || processFile;
  const nameId = nextId('bm-name');
  const noteId = nextId('bm-note');
  const emojiId = nextId('bm-emoji');
  const fileId = nextId('bm-file');
  const name = h('input', { type: 'text', id: nameId, class: 'input', maxLength: NAME_MAX, placeholder: 'Like Einstein', autocomplete: 'off' });
  const note = h('input', { type: 'text', id: noteId, class: 'input', maxLength: NOTE_MAX, placeholder: 'Like Can only be given by Jolli', autocomplete: 'off' });
  const emoji = h('input', { type: 'text', id: emojiId, class: 'input bm-emoji', maxLength: 16, placeholder: DEFAULT_EMOJI, autocomplete: 'off', spellcheck: false });
  const file = h('input', { type: 'file', id: fileId, class: 'bm-file', attrs: { accept: ACCEPT } });
  const dropTitle = h('span', { class: 'bm-drop-title', text: 'Drop a picture here or choose a file' });
  const drop = h('label', { class: 'bm-drop', htmlFor: fileId },
    h('span', { class: 'bm-drop-icon', attrs: { 'aria-hidden': 'true' } }, icon('upload', { size: 20 })),
    dropTitle,
    h('span', { class: 'bm-drop-help', text: 'PNG, JPG, WebP or GIF. It becomes a 128 × 128 square, cropped from the middle. See-through parts stay see-through.' }),
    file);
  const status = h('p', { class: 'bm-status muted', attrs: { 'aria-live': 'polite' } });
  const preview = h('div', { class: 'bm-preview', attrs: { 'aria-label': 'Preview' } });
  const save = button({ label: 'Make badge', icon: 'plus', variant: 'primary' });
  const cancel = button({ label: 'Cancel', icon: 'x' });
  const formTitle = h('h3', { class: ['owner-section-title', 'bm-form-title'], text: 'New badge' });
  const listWrap = h('div', { class: 'bm-list-wrap' });
  const countEl = h('span', { class: 'party-count' });
  let editing = null;
  let picked = null;
  let list = [];
  let max = 100;
  let busy = false;

  function current() {
    return {
      label: name.value.trim() || 'Your badge',
      note: note.value.trim(),
      emoji: emoji.value.trim() || DEFAULT_EMOJI,
      image: picked ? picked.dataUrl : editing ? editing.image : '',
    };
  }

  function drawPreview() {
    const b = current();
    const art = (px) => (b.image
      ? h('img', { class: ['bm-art', `bm-art-${px}`], src: b.image, alt: b.label, title: b.note || b.label })
      : h('span', { class: ['bm-art', 'bm-art-empty', `bm-art-${px}`], attrs: { 'aria-hidden': 'true' }, text: b.emoji }));
    replace(preview,
      h('div', { class: 'bm-preview-head' },
        h('span', { class: 'bm-preview-title', text: 'Preview' }),
        h('span', { class: 'bm-preview-hint muted', text: b.image ? 'Hover a badge to see its description' : 'Pick a picture to see it here' })),
      h('div', { class: 'bm-stage' }, art(IMAGE_SIZE)),
      h('ul', { class: 'bm-sizes' }, ...PREVIEW_SIZES.map((s) => h('li', { class: 'bm-size' }, h('span', { class: 'bm-size-slot' }, art(s.px)), h('span', { class: 'bm-size-label' }, h('span', { text: s.label }), h('span', { class: 'bm-size-px', text: `${s.px} px` }))))),
      h('div', { class: 'bm-sample' },
        h('span', { class: 'bm-sample-title', text: 'How it looks' }),
        h('span', { class: 'owner-pill' }, art(18), h('span', { text: b.label })),
        h('span', { class: 'bm-sample-text muted', text: `In bot messages: ${b.emoji} ${b.label}` })));
    dropTitle.textContent = picked ? 'Choose a different picture' : editing ? 'Drop a new picture here or choose a file' : 'Drop a picture here or choose a file';
  }

  function resetForm() {
    editing = null;
    picked = null;
    name.value = '';
    note.value = '';
    emoji.value = '';
    file.value = '';
    formTitle.textContent = 'New badge';
    formTitle.classList.remove('is-editing');
    setLabel(save, 'Make badge', 'plus');
    cancel.hidden = true;
    status.textContent = '';
    drawPreview();
  }

  function setLabel(btn, text, iconName) {
    const label = btn.querySelector('.btn-label');
    if (label) label.textContent = text;
    const old = iconName && typeof btn.querySelector === 'function' ? btn.querySelector('svg') : null;
    if (old && typeof old.replaceWith === 'function') old.replaceWith(icon(iconName, { size: 16 }));
  }

  async function take(f) {
    if (!f) return;
    status.textContent = 'Getting the picture ready…';
    status.classList.remove('is-danger');
    try {
      const out = await encode(f);
      if (!out || typeof out.dataUrl !== 'string') throw new Error(NOT_A_PICTURE);
      picked = out;
      status.textContent = `Ready: ${out.type || 'Picture'}, ${out.size || IMAGE_SIZE} × ${out.size || IMAGE_SIZE}, ${sizeText(out.bytes || dataUrlBytes(out.dataUrl))}.`;
    } catch (err) {
      picked = null;
      file.value = '';
      status.textContent = err && err.message ? err.message : NOT_A_PICTURE;
      status.classList.add('is-danger');
    }
    drawPreview();
  }

  file.addEventListener('change', () => take(file.files && file.files[0]));
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('is-drag');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('is-drag'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('is-drag');
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    take(f);
  });
  for (const el of [name, note, emoji]) el.addEventListener('input', drawPreview);
  cancel.addEventListener('click', resetForm);

  save.addEventListener('click', async () => {
    if (busy) return;
    const problem = checkForm({ name: name.value, note: note.value, emoji: emoji.value, image: picked && picked.dataUrl, editing: Boolean(editing) });
    if (problem) {
      toast(problem, { tone: 'danger', title: 'Check the badge' });
      return;
    }
    if (!editing && list.length >= max) {
      toast(`You already have ${formatNumber(max)} badges. Delete one first.`, { tone: 'danger', title: 'Too many badges' });
      return;
    }
    const body = badgeBody({ name: name.value, note: note.value, emoji: emoji.value, image: picked && picked.dataUrl });
    busy = true;
    const was = editing;
    setBusy(save, true, was ? 'Saving' : 'Making');
    let made = null;
    let failed = null;
    try {
      const data = was
        ? await api.patch(`${OWNER_BADGES_PATH}/${encodeURIComponent(was.id)}`, body, { signal: ctx.signal })
        : await api.post(OWNER_BADGES_PATH, body, { signal: ctx.signal });
      made = readBadge(data?.badge) || { name: body.name };
    } catch (err) {
      failed = err;
    } finally {
      busy = false;
      setBusy(save, false);
    }
    if (ctx.signal?.aborted) return;
    if (failed) {
      toast(failed instanceof ApiError ? failed.message : 'That did not work. Try again.', { tone: 'danger', title: "Couldn't save the badge" });
      return;
    }
    toast(was ? `Saved “${made.name}”.` : `Made “${made.name}”. Give it to people from their owner page.`);
    resetForm();
    await load();
  });

  function startEdit(b) {
    editing = b;
    picked = null;
    name.value = b.name;
    note.value = b.note;
    emoji.value = b.emoji === DEFAULT_EMOJI ? '' : b.emoji;
    file.value = '';
    formTitle.textContent = `Edit “${b.name}”`;
    formTitle.classList.add('is-editing');
    setLabel(save, 'Save changes', 'check');
    cancel.hidden = false;
    status.textContent = 'Pick a new picture only if you want to replace it.';
    status.classList.remove('is-danger');
    drawPreview();
    name.focus?.();
  }

  async function remove(b, btn) {
    const ask = deleteText(b);
    const ok = await confirmDialog({ title: ask.title, body: ask.body, confirmLabel: 'Delete badge', tone: 'danger' });
    if (!ok || ctx.signal?.aborted) return;
    setBusy(btn, true, 'Deleting');
    try {
      await api.request('DELETE', `${OWNER_BADGES_PATH}/${encodeURIComponent(b.id)}`, { signal: ctx.signal });
      if (ctx.signal?.aborted) return;
      toast(b.holders ? `Deleted “${b.name}” and took it off ${holdersText(b.holders).replace(/ ha(s|ve) it$/, '')}.` : `Deleted “${b.name}”.`);
      if (editing && editing.id === b.id) resetForm();
      await load();
    } catch (err) {
      if (ctx.signal?.aborted) return;
      if (btn.isConnected !== false) setBusy(btn, false);
      toast(err instanceof ApiError ? err.message : 'That did not work. Try again.', { tone: 'danger', title: "Couldn't delete the badge" });
    }
  }

  function row(b) {
    const edit = button({ label: 'Edit', icon: 'sliders', size: 'sm', ariaLabel: `Edit ${b.name}`, onClick: () => startEdit(b) });
    const del = button({ label: 'Delete', icon: 'trash', size: 'sm', variant: 'ghost', className: 'bm-del', ariaLabel: `Delete ${b.name}` });
    del.addEventListener('click', () => remove(b, del));
    return h('li', { class: 'bm-row', dataset: { id: b.id } },
      h('span', { class: 'bm-row-art' }, badgeArt({ image: b.image, label: b.name, note: b.note, emoji: b.emoji }, 'bm-row-emoji', 'bm-row-img')),
      h('span', { class: 'bm-row-main' },
        h('span', { class: 'bm-row-name', text: b.name }),
        b.note ? h('span', { class: 'bm-row-note', text: b.note }) : null,
        h('span', { class: 'bm-row-sub muted', text: `${b.emoji} in bot messages · ${holdersText(b.holders)}` })),
      h('span', { class: 'bm-row-actions' }, edit, del));
  }

  function show() {
    countEl.textContent = `${formatNumber(list.length)} of ${formatNumber(max)}`;
    replace(listWrap, list.length
      ? h('ul', { class: 'bm-list' }, ...list.map(row))
      : h('p', { class: 'owner-empty muted', text: 'No badges of your own yet. Make one above, then give it to people from their owner page.' }));
  }

  async function load() {
    try {
      const view = readBadges(await api.get(OWNER_BADGES_PATH, { signal: ctx.signal }));
      if (ctx.signal?.aborted) return;
      list = view.badges;
      max = view.max;
      show();
    } catch (err) {
      if (ctx.signal?.aborted) return;
      replace(listWrap, h('p', { class: 'field-error', attrs: { role: 'alert' }, text: err instanceof ApiError ? err.message : 'Could not load your badges.' }));
    }
  }

  cancel.hidden = true;
  drawPreview();
  replace(listWrap, h('p', { class: 'muted', text: 'Loading your badges…' }));
  load();

  return card({ title: 'Badge maker', icon: 'sparkles', className: 'bm-card', actions: countEl },
    h('p', { class: 'owner-text', text: 'Make your own badges with your own pictures. Only you can make or give them. Built-in badges stay as they are.' }),
    h('div', { class: 'bm-maker' },
      h('div', { class: 'bm-form' },
        formTitle,
        field('Name', name),
        field('Short description (optional)', note, h('p', { class: 'field-help', text: 'Shows when people hover or tap the badge.' })),
        field('Fallback emoji', emoji, h('p', { class: 'field-help', text: "Used where pictures can't show, like bot messages." })),
        drop,
        status,
        h('div', { class: 'owner-actions-row' }, save, cancel)),
      preview),
    h('h3', { class: 'owner-section-title', text: 'Your badges' }),
    listWrap);
}
