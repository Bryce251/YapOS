import { formatDurationMs, looksLikeDuration, toHexColor, toNumber } from './format.js';

export const FIELD_TYPES = new Set([
  'boolean', 'number', 'string', 'text', 'channel', 'voice_channel', 'category', 'channels',
  'role', 'roles', 'emoji', 'select', 'duration', 'color', 'words', 'complex',
]);

const MULTI = new Set(['channels', 'roles', 'words']);

export const EDITORS = new Set(['toggles', 'choices', 'channelMap', 'roleMap', 'rewards', 'steps']);
const EDITOR_KEYS = { filters: 'toggles', actions: 'choices', filterExempt: 'channelMap', typeStaff: 'roleMap', rewards: 'rewards', escalation: 'steps' };
const FILTER_LABELS = { spam: '🌊 Spam & flood', mentions: '📣 Mass mentions', caps: '🔠 Caps lock', links: '🔗 Links', invites: '✉️ Invites', words: '🤬 Word filter', raid: '🛡️ Raid shield' };
const ACTION_FILTER_LABELS = Object.fromEntries(Object.entries(FILTER_LABELS).filter(([k]) => k !== 'raid'));
const FALLBACK_LABELS = { filters: FILTER_LABELS, actions: ACTION_FILTER_LABELS, filterExempt: ACTION_FILTER_LABELS };
export const STEP_ACTIONS = [
  { value: 'timeout', label: 'Timeout', emoji: '⏳' },
  { value: 'kick', label: 'Kick', emoji: '👢' },
  { value: 'ban', label: 'Ban', emoji: '🔨' },
];
export const MAX_LEVEL = 1000;
const MAX_STEPS = 20;

function cleanLabels(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const [k, v] of Object.entries(raw)) if (typeof v === 'string' && v) out[k] = v;
  return Object.keys(out).length ? out : null;
}

function editorOf(f, type, key) {
  if (type !== 'complex') return '';
  if (EDITORS.has(f.editor)) return f.editor;
  return EDITOR_KEYS[key] || '';
}

export function normalizeField(raw) {
  const f = raw && typeof raw === 'object' ? raw : {};
  const type = FIELD_TYPES.has(f.type) ? f.type : 'complex';
  const key = typeof f.key === 'string' ? f.key : '';
  const editor = editorOf(f, type, key);
  const readOnly = (type === 'complex' && !editor) || f.web !== true;
  return {
    key,
    label: typeof f.label === 'string' && f.label ? f.label : key,
    help: typeof f.help === 'string' ? f.help : '',
    note: typeof f.note === 'string' ? f.note : '',
    type,
    default: f.default,
    min: toNumber(f.min),
    max: toNumber(f.max),
    step: toNumber(f.step),
    maxLength: toNumber(f.maxLength),
    options: Array.isArray(f.options)
      ? f.options.filter((o) => o && o.value !== undefined).map((o) => ({ value: o.value, label: String(o.label ?? o.value) }))
      : [],
    readOnly,
    editor: readOnly ? '' : editor,
    labels: cleanLabels(f.labels) || FALLBACK_LABELS[key] || null,
    multi: MULTI.has(type),
  };
}

const EMOJI_LEAD = /^((?:\p{Extended_Pictographic}|\p{Regional_Indicator})[️‍\p{Extended_Pictographic}]*)\s+(.+)$/u;

export function splitEmoji(label) {
  const m = EMOJI_LEAD.exec(String(label ?? ''));
  return m ? { emoji: m[1], name: m[2] } : { emoji: '', name: String(label ?? '') };
}

function prettyKey(key) {
  const words = String(key).replace(/([a-z])([A-Z0-9])/g, '$1 $2').replace(/[_-]+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : String(key);
}

export function mapItems(field, value) {
  const labels = field.labels || {};
  const ids = [...Object.keys(labels)];
  if (value && typeof value === 'object' && !Array.isArray(value)) for (const k of Object.keys(value)) if (!ids.includes(k)) ids.push(k);
  return ids.map((id) => {
    const label = labels[id] || prettyKey(id);
    return { id, label, ...splitEmoji(label) };
  });
}

export function cloneEdit(v) {
  if (Array.isArray(v)) return v.map(cloneEdit);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cloneEdit(x)]));
  return v;
}

function plainObj(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

function complexEdit(field, value) {
  const items = mapItems(field, value);
  const src = plainObj(value);
  switch (field.editor) {
    case 'toggles':
      return Object.fromEntries(items.map((i) => [i.id, src[i.id] === true]));
    case 'choices': {
      const first = field.options[0] ? String(field.options[0].value) : '';
      return Object.fromEntries(items.map((i) => [i.id, src[i.id] === undefined || src[i.id] === null ? first : String(src[i.id])]));
    }
    case 'channelMap':
    case 'roleMap':
      return Object.fromEntries(items.map((i) => [i.id, toIdList(src[i.id])]));
    case 'rewards':
      return Object.entries(src)
        .filter(([lvl]) => Number.isFinite(Number(lvl)))
        .sort((a, b) => Number(a[0]) - Number(b[0]))
        .map(([lvl, role]) => ({ level: String(Number(lvl)), role: role === null || role === undefined ? '' : String(role) }));
    case 'steps':
      return (Array.isArray(value) ? value : [])
        .filter((s) => s && typeof s === 'object')
        .map((s) => ({ at: String(s.at ?? ''), action: String(s.action ?? 'timeout'), duration: s.action === 'timeout' ? (toNumber(s.durationMs) ? formatDurationMs(toNumber(s.durationMs)) : '1h') : '' }))
        .sort((a, b) => Number(a.at) - Number(b.at));
    default:
      return value;
  }
}

function complexOut(field, edit) {
  switch (field.editor) {
    case 'rewards':
      return Object.fromEntries(edit.map((r) => [String(Number(r.level)), r.role]));
    case 'steps':
      return edit
        .slice()
        .sort((a, b) => Number(a.at) - Number(b.at))
        .map((s) => `${Number(s.at)} ${s.action}${s.action === 'timeout' && s.duration.trim() ? ` ${s.duration.trim()}` : ''}`)
        .join(', ');
    default:
      return cloneEdit(edit);
  }
}

function wholeIn(text, min, max) {
  const t = String(text ?? '').trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= min && n <= max ? n : null;
}

function complexProblem(field, edit) {
  switch (field.editor) {
    case 'rewards': {
      const limit = field.max ?? 20;
      if (edit.length > limit) return `Use at most ${limit} rewards.`;
      const seen = new Set();
      for (const r of edit) {
        const lvl = wholeIn(r.level, 1, MAX_LEVEL);
        if (lvl === null) return `Levels go from 1 to ${MAX_LEVEL}.`;
        if (seen.has(lvl)) return `Level ${lvl} is used twice. Each level can give one role.`;
        seen.add(lvl);
        if (!r.role) return `Pick a role for level ${lvl}.`;
      }
      return '';
    }
    case 'steps': {
      if (edit.length > MAX_STEPS) return `Use at most ${MAX_STEPS} steps.`;
      const seen = new Set();
      for (const s of edit) {
        const at = wholeIn(s.at, 1, 100);
        if (at === null) return 'Each step needs a number of warnings from 1 to 100.';
        if (seen.has(at)) return `There are two steps at ${at} warnings. Keep one.`;
        seen.add(at);
        if (!STEP_ACTIONS.some((a) => a.value === s.action)) return `Pick what happens at ${at} warnings.`;
        if (s.action === 'timeout' && (!s.duration.trim() || !looksLikeDuration(s.duration))) return `Pick how long the timeout at ${at} warnings lasts.`;
      }
      return '';
    }
    case 'channelMap':
    case 'roleMap': {
      const limit = field.editor === 'channelMap' ? 25 : 10;
      for (const [k, list] of Object.entries(edit)) if (list.length > limit) return `${mapItems(field, edit).find((i) => i.id === k)?.name || k}: pick at most ${limit}.`;
      return '';
    }
    default:
      return '';
  }
}

export function normalizeSchema(schema) {
  if (!Array.isArray(schema)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of schema) {
    const f = normalizeField(raw);
    if (!f.key || seen.has(f.key)) continue;
    seen.add(f.key);
    out.push(f);
  }
  return out;
}

function toIdList(value) {
  if (Array.isArray(value)) return value.filter((v) => v !== null && v !== undefined && v !== '').map(String);
  if (value === null || value === undefined || value === '') return [];
  return [String(value)];
}

export function toEditValue(field, raw) {
  const value = raw === undefined ? field.default : raw;
  if (field.editor) return complexEdit(field, value);
  switch (field.type) {
    case 'boolean':
      return value === true;
    case 'number': {
      const n = toNumber(value);
      return n === null ? '' : String(n);
    }
    case 'string':
    case 'text':
    case 'emoji':
      return value === null || value === undefined ? '' : String(value);
    case 'duration': {
      if (value === null || value === undefined || value === '') return '';
      const n = toNumber(value);
      return n === null ? String(value) : formatDurationMs(n);
    }
    case 'color':
      return toHexColor(value);
    case 'select':
      return value === null || value === undefined ? '' : String(value);
    case 'channel':
    case 'voice_channel':
    case 'category':
    case 'role':
      return value === null || value === undefined || value === '' ? '' : String(value);
    case 'channels':
    case 'roles':
      return toIdList(value);
    case 'words':
      return Array.isArray(value) ? value.map(String) : (typeof value === 'string' && value ? value.split(/[,\n]/).map((w) => w.trim()).filter(Boolean) : []);
    default:
      return value;
  }
}

export function fromEditValue(field, edit) {
  if (field.editor) return complexOut(field, edit);
  switch (field.type) {
    case 'boolean':
      return edit === true;
    case 'number':
      return edit === '' ? null : Number(edit);
    case 'select': {
      const opt = field.options.find((o) => String(o.value) === edit);
      return opt ? opt.value : (edit === '' ? null : edit);
    }
    case 'channel':
    case 'voice_channel':
    case 'category':
    case 'role':
      return edit === '' ? null : edit;
    case 'color':
      return edit === '' ? null : edit;
    case 'duration':
      return edit.trim() === '' ? null : edit.trim();
    case 'channels':
    case 'roles':
    case 'words':
      return edit.slice();
    default:
      return edit;
  }
}

export function sameValue(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => sameValue(v, b[i]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && sameValue(a[k], b[k]));
  }
  return a === b;
}

export function validateField(field, edit) {
  if (field.readOnly) return '';
  if (field.editor) return complexProblem(field, edit);
  switch (field.type) {
    case 'number': {
      if (edit === '') return '';
      const n = Number(edit);
      if (!Number.isFinite(n)) return 'Enter a number.';
      if (field.min !== null && n < field.min) return `Use ${field.min} or more.`;
      if (field.max !== null && n > field.max) return `Use ${field.max} or less.`;
      if (field.step !== null && field.step >= 1 && !Number.isInteger(n)) return 'Use a whole number.';
      return '';
    }
    case 'string':
    case 'text':
    case 'emoji': {
      const len = Array.from(edit).length;
      if (field.maxLength !== null && len > field.maxLength) return `Keep it under ${field.maxLength + 1} characters (now ${len}).`;
      return '';
    }
    case 'color':
      return edit === '' || /^#[0-9a-f]{6}$/i.test(edit) ? '' : 'Use a hex color like #f2613f.';
    case 'duration':
      return looksLikeDuration(edit) ? '' : 'Use a duration like 10m, 2h or 1d 12h.';
    case 'words': {
      const limit = wordLimit(field);
      if (limit !== null && edit.length > limit) return `Use at most ${limit} words (now ${edit.length}).`;
      return '';
    }
    case 'channels':
    case 'roles': {
      if (field.max !== null && edit.length > field.max) return `Pick at most ${field.max}.`;
      return '';
    }
    default:
      return '';
  }
}

export function initialEdits(fields, values) {
  const out = {};
  const src = values && typeof values === 'object' ? values : {};
  for (const f of fields) {
    if (f.readOnly) continue;
    out[f.key] = toEditValue(f, src[f.key]);
  }
  return out;
}

export function dirtyKeys(fields, base, current) {
  return fields.filter((f) => !f.readOnly && !sameValue(base[f.key], current[f.key])).map((f) => f.key);
}

export function buildPatch(fields, base, current) {
  const patch = {};
  for (const key of dirtyKeys(fields, base, current)) {
    const field = fields.find((f) => f.key === key);
    patch[key] = fromEditValue(field, current[key]);
  }
  return patch;
}

export function validateAll(fields, current) {
  const errors = {};
  for (const f of fields) {
    if (f.readOnly) continue;
    const msg = validateField(f, current[f.key]);
    if (msg) errors[f.key] = msg;
  }
  return errors;
}

export function channelMatches(fieldType, channel) {
  const kind = String(channel?.kind ?? 'text').toLowerCase();
  const isVoice = kind.includes('voice') || kind === 'stage';
  const isCategory = kind === 'category';
  if (fieldType === 'voice_channel') return isVoice;
  if (fieldType === 'category') return isCategory;
  return !isVoice && !isCategory;
}

export function addWord(list, word, { maxLength = null } = {}) {
  const parts = String(word ?? '').split(/[,\n]/).map((w) => w.trim()).filter(Boolean);
  const next = list.slice();
  for (const p of parts) {
    if (next.some((w) => w.toLowerCase() === p.toLowerCase())) continue;
    if (maxLength !== null && next.length >= maxLength) break;
    next.push(p);
  }
  return next;
}

export function describeComplex(value) {
  if (value === null || value === undefined) return 'Not set';
  if (Array.isArray(value)) return value.length === 1 ? '1 item' : `${value.length} items`;
  if (typeof value === 'object') {
    const n = Object.keys(value).length;
    return n === 0 ? 'Not set' : n === 1 ? '1 entry' : `${n} entries`;
  }
  if (typeof value === 'boolean') return value ? 'On' : 'Off';
  return String(value);
}

const READ_ONLY_MAX = 240;
const CHANNEL_TYPES = new Set(['channel', 'voice_channel', 'category', 'channels']);
const ROLE_TYPES = new Set(['role', 'roles']);

function findById(list, id) {
  if (!Array.isArray(list)) return null;
  return list.find((x) => x && x.id !== undefined && String(x.id) === String(id)) || null;
}

function channelLabel(lookups, id) {
  const c = findById(lookups?.channels, id);
  if (!c) return null;
  const name = String(c.name ?? c.id);
  return String(c.kind ?? '').toLowerCase() === 'category' ? name : `#${name}`;
}

function roleLabel(lookups, id) {
  const r = findById(lookups?.roles, id);
  return r ? `@${String(r.name ?? r.id)}` : null;
}

function plainText(lookups, v) {
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  if (typeof v === 'number') return String(v);
  if (typeof v !== 'string') return null;
  return roleLabel(lookups, v) || channelLabel(lookups, v) || v;
}

function clipText(text) {
  const chars = Array.from(text);
  return chars.length > READ_ONLY_MAX ? `${chars.slice(0, READ_ONLY_MAX - 1).join('')}…` : text;
}

function countText(n, one, many) {
  return n === 1 ? `1 ${one}` : `${n} ${many}`;
}

export function describeReadOnly(field, value, lookups) {
  const type = field && typeof field === 'object' ? field.type : '';
  if (value === null || value === undefined || value === '') return 'Not set';
  if (typeof value === 'boolean') return value ? 'On' : 'Off';
  if (CHANNEL_TYPES.has(type) || ROLE_TYPES.has(type)) {
    const ids = Array.isArray(value) ? value : [value];
    if (!ids.length) return 'None';
    const isRole = ROLE_TYPES.has(type);
    const unknown = isRole ? 'Unknown role' : type === 'category' ? 'Unknown category' : 'Unknown channel';
    return clipText(ids.map((id) => (isRole ? roleLabel(lookups, id) : channelLabel(lookups, id)) || unknown).join(', '));
  }
  if (Array.isArray(value)) {
    if (!value.length) return 'None';
    const simple = value.map((v) => plainText(lookups, v));
    if (simple.every((s) => s !== null)) return clipText(simple.join(', '));
    const steps = value.every((v) => v && typeof v === 'object' && v.at !== undefined && typeof v.action === 'string');
    if (steps) return clipText(value.map((v) => `${v.at}: ${v.action}`).join(', '));
    return countText(value.length, 'item', 'items');
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value);
    if (!entries.length) return 'Not set';
    if (typeof value.enabled === 'boolean' && !value.enabled) return 'Off';
    if (entries.every(([, v]) => typeof v === 'boolean')) {
      const on = entries.filter(([, v]) => v).map(([k]) => k);
      return on.length ? clipText(`On: ${on.join(', ')}`) : 'All off';
    }
    const pairs = entries.map(([k, v]) => [k, plainText(lookups, v)]);
    if (pairs.every(([, v]) => v !== null)) return clipText(pairs.map(([k, v]) => `${k}: ${v}`).join(', '));
    if (typeof value.enabled === 'boolean') return 'On';
    return countText(entries.length, 'entry', 'entries');
  }
  if (typeof value === 'string' || typeof value === 'number') return clipText(String(plainText(lookups, value) ?? value));
  return describeComplex(value);
}

export function wordLimit(field) {
  if (!field) return null;
  if (typeof field.max === 'number' && Number.isFinite(field.max)) return field.max;
  if (typeof field.maxLength === 'number' && Number.isFinite(field.maxLength)) return field.maxLength;
  return null;
}

export function readChangeResult(result) {
  const r = result && typeof result === 'object' ? result : {};
  const errors = r.errors && typeof r.errors === 'object' ? { ...r.errors } : {};
  const applied = r.applied && typeof r.applied === 'object' ? { ...r.applied } : {};
  let message = '';
  if (r.grant === false) message = typeof r.error === 'string' && r.error ? r.error : 'You need to be an admin of this server.';
  else if (r.ok === false && !Object.keys(errors).length) message = typeof r.error === 'string' && r.error ? r.error : 'YapOS could not apply that change.';
  return { ok: !message && !Object.keys(errors).length, denied: r.grant === false, applied, errors, message, snapshot: r.snapshot && typeof r.snapshot === 'object' ? r.snapshot : null };
}
