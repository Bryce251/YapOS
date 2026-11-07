import fs from 'node:fs';
import path from 'node:path';

const NS_RE = /^[a-z0-9_-]{1,40}$/;
const clone = (v) => (v === undefined ? undefined : structuredClone(v));

function base(load, persist) {
  const data = new Map();
  const dirty = new Set();
  const nsData = (ns) => {
    if (!NS_RE.test(ns)) throw new Error(`Bad storage namespace "${ns}" (a-z, 0-9, _ and - only)`);
    if (!data.has(ns)) data.set(ns, load(ns) || {});
    return data.get(ns);
  };
  const touch = (ns) => { dirty.add(ns); persist.schedule?.(ns); };
  const api = {
    get(ns, key, fallback) {
      const d = nsData(ns);
      return Object.hasOwn(d, key) ? clone(d[key]) : clone(fallback);
    },
    has(ns, key) { return Object.hasOwn(nsData(ns), key); },
    set(ns, key, value) {
      nsData(ns)[key] = clone(value);
      touch(ns);
      return clone(value);
    },
    update(ns, key, fn, fallback) {
      const d = nsData(ns);
      const cur = Object.hasOwn(d, key) ? clone(d[key]) : clone(fallback);
      const ret = fn(cur);
      const next = ret === undefined ? cur : ret;
      d[key] = clone(next);
      touch(ns);
      return clone(next);
    },
    delete(ns, key) {
      const d = nsData(ns);
      if (!Object.hasOwn(d, key)) return false;
      delete d[key];
      touch(ns);
      return true;
    },
    keys(ns) { return Object.keys(nsData(ns)); },
    entries(ns) { return Object.entries(nsData(ns)).map(([k, v]) => [k, clone(v)]); },
    async flush() { for (const ns of [...dirty]) { dirty.delete(ns); await persist.write(ns, data.get(ns)); } },
    _dirty: dirty,
  };
  return api;
}

export function createMemoryStore(seed = {}) {
  const store = base((ns) => clone(seed[ns]) || {}, { write: async () => {} });
  store.kind = 'memory';
  return store;
}

export function createJsonStore({ dir, delay = 500, log = null } = {}) {
  if (!dir) throw new Error('createJsonStore needs a dir');
  fs.mkdirSync(dir, { recursive: true });
  const timers = new Map();
  const file = (ns) => path.join(dir, `${ns}.json`);
  const load = (ns) => {
    const p = file(ns);
    if (!fs.existsSync(p)) return {};
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (e) {
      const bad = `${p}.broken-${Date.now()}`;
      try { fs.renameSync(p, bad); } catch {}
      log?.error(`data/${ns}.json was unreadable (${e.message}); moved it to ${path.basename(bad)} and started fresh`);
      return {};
    }
  };
  const writeNow = async (ns, obj) => {
    const p = file(ns);
    const tmp = `${p}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(obj ?? {}, null, 1), 'utf8');
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.promises.rename(tmp, p);
        return;
      } catch (e) {
        if (attempt >= 4 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
        await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
      }
    }
  };
  let store;
  const persist = {
    write: writeNow,
    schedule(ns) {
      if (timers.has(ns)) return;
      timers.set(ns, setTimeout(() => {
        timers.delete(ns);
        if (!store._dirty.has(ns)) return;
        store._dirty.delete(ns);
        writeNow(ns, store._raw(ns)).catch((e) => { store._dirty.add(ns); log?.error(`Couldn't save data/${ns}.json: ${e.message}`); });
      }, delay).unref?.() ?? 0);
    },
  };
  store = base(load, persist);
  store._raw = (ns) => Object.fromEntries(store.entries(ns));
  const flush = store.flush;
  store.flush = async () => {
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    await flush();
  };
  store.kind = 'json';
  store.dir = dir;
  return store;
}

export function flushOnExit(store, log) {
  let done = false;
  const go = async (sig) => {
    if (done) return;
    done = true;
    try { await store.flush(); log?.info(`saved data (${sig})`); } catch (e) { log?.error('final save failed', e); }
    process.exit(0);
  };
  process.once('SIGINT', () => go('SIGINT'));
  process.once('SIGTERM', () => go('SIGTERM'));
}
