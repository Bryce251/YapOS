export const LIMITS = Object.freeze({
  keyPattern: /^[A-Za-z0-9_.:-]{1,64}$/,
  valueBytes: 4096,
  keys: 256,
  stateBytes: 65536,
  perPerson: 100,
  perCall: 600,
  windowMs: 10_000,
});

const encoder = new TextEncoder();

export function jsonBytes(value) {
  try {
    const text = JSON.stringify(value === undefined ? null : value);
    return text === undefined ? Infinity : encoder.encode(text).length;
  } catch {
    return Infinity;
  }
}

export function formatBytes(n) {
  if (!Number.isFinite(n)) return 'not valid JSON';
  if (n < 1024) return `${n} B`;
  return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
}

export function createCall({ now = () => Date.now(), limits = LIMITS } = {}) {
  const entries = new Map();
  const personOps = new Map();
  const callOps = [];
  let total = 0;

  const prune = (list, t) => {
    while (list.length && list[0] <= t - limits.windowMs) list.shift();
  };

  const fail = (code, text, personal = true) => ({ ok: false, code, text, personal });

  function spend(by) {
    const t = now();
    const mine = personOps.get(by) || [];
    personOps.set(by, mine);
    prune(mine, t);
    prune(callOps, t);
    if (mine.length >= limits.perPerson) return fail('person_rate', `went over ${limits.perPerson} sets and sends in 10 seconds, so this one was dropped.`);
    if (callOps.length >= limits.perCall) return fail('call_rate', `The whole call went over ${limits.perCall} sets and sends in 10 seconds, so this one was dropped.`, false);
    mine.push(t);
    callOps.push(t);
    return { ok: true };
  }

  function set(by, key, val) {
    if (typeof key !== 'string' || !limits.keyPattern.test(key)) {
      return fail('bad_key', `used the key ${JSON.stringify(String(key)).slice(0, 80)}. Keys are letters, digits and _ . : - only, up to 64 long.`);
    }
    const spent = spend(by);
    if (!spent.ok) return spent;
    const value = val === undefined ? null : val;
    const old = entries.get(key);
    if (value === null) {
      if (old) {
        entries.delete(key);
        total -= old.bytes;
      }
      return { ok: true, key, val: null };
    }
    const size = jsonBytes(value);
    if (size > limits.valueBytes) return fail('value_size', `tried to save ${formatBytes(size)} in "${key}". A value can be at most 4 KB of JSON.`);
    if (!old && entries.size >= limits.keys) return fail('too_many_keys', `tried to add "${key}", but the call already has ${limits.keys} keys.`);
    const bytes = key.length + size;
    const next = total - (old ? old.bytes : 0) + bytes;
    if (next > limits.stateBytes) return fail('state_size', `tried to save "${key}", which would make the shared state ${formatBytes(next)}. The limit is 64 KB per call.`);
    const stored = JSON.parse(JSON.stringify(value));
    entries.set(key, { val: stored, bytes, by, at: now() });
    total = next;
    return { ok: true, key, val: stored };
  }

  function send(by, data) {
    const spent = spend(by);
    if (!spent.ok) return spent;
    const value = data === undefined ? null : data;
    const size = jsonBytes(value);
    if (size > limits.valueBytes) return fail('message_size', `tried to send ${formatBytes(size)}. A message can be at most 4 KB of JSON.`);
    return { ok: true, data: JSON.parse(JSON.stringify(value)) };
  }

  function opsFor(by) {
    const mine = personOps.get(by);
    if (!mine) return 0;
    prune(mine, now());
    return mine.length;
  }

  function callOpsCount() {
    prune(callOps, now());
    return callOps.length;
  }

  function snapshot() {
    const out = {};
    for (const [k, e] of entries) out[k] = JSON.parse(JSON.stringify(e.val));
    return out;
  }

  function list() {
    return [...entries].map(([key, e]) => ({ key, bytes: e.bytes, by: e.by, at: e.at, val: e.val })).sort((a, b) => a.key.localeCompare(b.key));
  }

  function forget(by) {
    personOps.delete(by);
  }

  function clear() {
    entries.clear();
    personOps.clear();
    callOps.length = 0;
    total = 0;
  }

  return {
    set,
    send,
    opsFor,
    callOpsCount,
    snapshot,
    list,
    forget,
    clear,
    get keys() {
      return entries.size;
    },
    get bytes() {
      return total;
    },
  };
}
