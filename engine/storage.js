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

export function createJsonStore({ dir, delay = 50, log = null } = {}) {
  if (!dir) throw new Error('createJsonStore needs a dir');
  fs.mkdirSync(dir, { recursive: true });
  const timers = new Map();
  const chains = new Map();
  const file = (ns) => path.join(dir, `${ns}.json`);
  const tmpFile = (ns) => `${file(ns)}.${process.pid}.tmp`;

  const leftovers = (ns) => {
    const prefix = `${ns}.json.`;
    try {
      return fs.readdirSync(dir)
        .filter((f) => f.startsWith(prefix) && f.endsWith('.tmp'))
        .map((f) => path.join(dir, f));
    } catch {
      return [];
    }
  };

  const load = (ns) => {
    const p = file(ns);
    const stale = leftovers(ns);
    if (!fs.existsSync(p)) {
      const recovered = recoverTmp(ns, stale);
      for (const f of stale) { try { fs.unlinkSync(f); } catch {} }
      return recovered;
    }
    for (const f of stale) { try { fs.unlinkSync(f); } catch {} }
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (e) {
      const bad = `${p}.broken-${Date.now()}`;
      try { fs.renameSync(p, bad); } catch {}
      log?.error(`data/${ns}.json was unreadable (${e.message}); moved it to ${path.basename(bad)} and started fresh`);
      return {};
    }
  };

  const recoverTmp = (ns, candidates) => {
    const newestFirst = candidates
      .map((f) => { try { return { f, at: fs.statSync(f).mtimeMs }; } catch { return null; } })
      .filter(Boolean)
      .sort((a, b) => b.at - a.at);
    for (const { f } of newestFirst) {
      try {
        const data = JSON.parse(fs.readFileSync(f, 'utf8'));
        if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
        fs.writeFileSync(file(ns), JSON.stringify(data, null, 1), 'utf8');
        log?.info(`recovered data/${ns}.json from an unfinished save`);
        return data;
      } catch {}
    }
    return {};
  };

  const serialize = (obj) => JSON.stringify(obj ?? {}, null, 1);

  const writeAsync = async (ns, text) => {
    const p = file(ns);
    const tmp = tmpFile(ns);
    await fs.promises.writeFile(tmp, text, 'utf8');
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

  const writeSync = (ns, text) => {
    const p = file(ns);
    const tmp = `${p}.${process.pid}.final.tmp`;
    fs.writeFileSync(tmp, text, 'utf8');
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(tmp, p);
        return;
      } catch (e) {
        if (attempt >= 4 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) {
          fs.writeFileSync(p, text, 'utf8');
          try { fs.unlinkSync(tmp); } catch {}
          return;
        }
        const until = Date.now() + 30 * (attempt + 1);
        while (Date.now() < until) {}
      }
    }
  };

  const queueWrite = (ns) => {
    const text = serialize(store._raw(ns));
    const prev = chains.get(ns) || Promise.resolve();
    const next = prev.catch(() => {}).then(() => writeAsync(ns, text)).catch((e) => {
      store._dirty.add(ns);
      log?.error(`Couldn't save data/${ns}.json: ${e.message}`);
      throw e;
    });
    chains.set(ns, next);
    next.finally(() => { if (chains.get(ns) === next) chains.delete(ns); }).catch(() => {});
    return next;
  };

  let store;
  const persist = {
    write: (ns) => queueWrite(ns),
    schedule(ns) {
      if (timers.has(ns)) return;
      const t = setTimeout(() => {
        timers.delete(ns);
        if (!store._dirty.has(ns)) return;
        store._dirty.delete(ns);
        queueWrite(ns).catch(() => {});
      }, delay);
      timers.set(ns, t);
    },
  };
  store = base(load, persist);
  store._raw = (ns) => Object.fromEntries(store.entries(ns));

  store.flush = async () => {
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    for (const ns of [...store._dirty]) { store._dirty.delete(ns); queueWrite(ns).catch(() => {}); }
    await Promise.allSettled([...chains.values()]);
  };

  store.flushSync = () => {
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    let saved = 0;
    for (const ns of [...store._dirty]) {
      try {
        writeSync(ns, serialize(store._raw(ns)));
        store._dirty.delete(ns);
        saved++;
      } catch (e) {
        log?.error(`Couldn't save data/${ns}.json on exit: ${e.message}`);
      }
    }
    return saved;
  };

  store.pending = () => store._dirty.size + timers.size + chains.size;
  store.kind = 'json';
  store.dir = dir;
  return store;
}

export function flushOnExit(store, log) {
  let done = false;
  const stopNow = (sig) => {
    if (done) return;
    done = true;
    try {
      const n = store.flushSync ? store.flushSync() : 0;
      log?.info(`saved data before stopping (${sig}${n ? `, ${n} file${n === 1 ? '' : 's'}` : ''})`);
    } catch (e) {
      log?.error('final save failed', e);
    }
    process.exit(0);
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    try { process.on(sig, () => stopNow(sig)); } catch {}
  }
  process.on('exit', () => {
    if (done) return;
    done = true;
    try { store.flushSync?.(); } catch {}
  });
}