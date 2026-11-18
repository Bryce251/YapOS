export const HIDDEN_NAME = 'Hidden name';

let names = new Set();
let handles = new Set();
let known = new Map();
const KNOWN_MAX = 500;

const key = (id) => (id === null || id === undefined ? '' : String(id));
const bare = (v) => String(v).replace(/^@+/, '').trim().toLowerCase();

export function noteHandle(id, username) {
  const k = key(id);
  if (!k || typeof username !== 'string' || !bare(username)) return;
  known.delete(k);
  known.set(k, bare(username));
  if (known.size > KNOWN_MAX) known.delete(known.keys().next().value);
}

export function setHiddenName(id, nameOn, handleOn) {
  const k = key(id);
  if (!k) return false;
  const before = names.has(k) + 2 * handles.has(k);
  if (nameOn) names.add(k);
  else names.delete(k);
  if (handleOn) handles.add(k);
  else handles.delete(k);
  return before !== names.has(k) + 2 * handles.has(k);
}

export function forgetHidden(id) {
  names.delete(key(id));
  handles.delete(key(id));
  known.delete(key(id));
}

export function resetHidden() {
  names = new Set();
  handles = new Set();
  known = new Map();
}

export function nameHidden(id) {
  return names.has(key(id));
}

export function handleHidden(id) {
  return handles.has(key(id));
}

export function shownName(id, name) {
  const k = key(id);
  if (names.has(k)) return HIDDEN_NAME;
  if (handles.has(k) && typeof name === 'string' && known.has(k) && known.get(k) === bare(name)) return HIDDEN_NAME;
  return name;
}
