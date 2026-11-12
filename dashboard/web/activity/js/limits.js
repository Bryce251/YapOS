export const KEY_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
export const MAX_VALUE_BYTES = 4096;
export const MAX_KEYS = 256;
export const MAX_STATE_BYTES = 65536;
export const OPS_WINDOW_MS = 10000;
export const OPS_MAX = 100;

const encoder = typeof TextEncoder === 'function' ? new TextEncoder() : null;

export function textBytes(text) {
  if (encoder) return encoder.encode(text).length;
  return unescape(encodeURIComponent(text)).length;
}

export function jsonBytes(value) {
  const text = JSON.stringify(value === undefined ? null : value);
  return textBytes(text === undefined ? 'null' : text);
}

export function validKey(key) {
  return typeof key === 'string' && KEY_RE.test(key);
}

export function stateBytes(state) {
  let total = 0;
  for (const key of Object.keys(state || {})) total += textBytes(key) + jsonBytes(state[key]);
  return total;
}

export function checkSet(state, key, value) {
  if (!validKey(key)) return 'bad_key';
  if (value === null || value === undefined) return null;
  const size = jsonBytes(value);
  if (size > MAX_VALUE_BYTES) return 'too_big';
  const current = state || {};
  const has = Object.prototype.hasOwnProperty.call(current, key);
  if (!has && Object.keys(current).length >= MAX_KEYS) return 'too_many_keys';
  const before = has ? textBytes(key) + jsonBytes(current[key]) : 0;
  if (stateBytes(current) - before + textBytes(key) + size > MAX_STATE_BYTES) return 'state_full';
  return null;
}

export function checkSend(data) {
  if (jsonBytes(data) > MAX_VALUE_BYTES) return 'too_big';
  return null;
}

export class OpBudget {
  constructor(limit = OPS_MAX, windowMs = OPS_WINDOW_MS) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.times = [];
  }

  prune(now) {
    while (this.times.length && now - this.times[0] >= this.windowMs) this.times.shift();
  }

  used(now) {
    this.prune(now);
    return this.times.length;
  }

  available(now) {
    return Math.max(0, this.limit - this.used(now));
  }

  spend(now, n = 1) {
    this.prune(now);
    for (let i = 0; i < n; i += 1) this.times.push(now);
  }

  nextFree(now) {
    this.prune(now);
    if (this.times.length < this.limit) return now;
    return this.times[this.times.length - this.limit] + this.windowMs;
  }
}
