import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { backupCopies } from './backup.js';

const NS_RE = /^[a-z0-9_-]{1,40}$/;
const RESERVED_NS = new Set(['backups', 'logs']);
const RESERVED_WIN = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/;
const HASHED_RE = /^~[0-9a-f]{40}\.json$/;
const TMP_RE = /^(.+\.json)\.\d+(?:\.final)?\.tmp$/;
const RETRY_CODES = ['EPERM', 'EBUSY', 'EACCES'];
const MAX_NAME = 180;
const clone = (v) => (v === undefined ? undefined : structuredClone(v));

export function checkNamespace(ns) {
  if (typeof ns !== 'string' || !NS_RE.test(ns)) throw new Error(`Bad storage namespace "${ns}" (a-z, 0-9, _ and - only)`);
  if (RESERVED_NS.has(ns)) throw new Error(`The storage namespace "${ns}" is kept for YapOS's own folders; pick another name`);
}

const escapeChar = (ch) => [...Buffer.from(ch, 'utf8')].map((b) => `%${b.toString(16).padStart(2, '0')}`).join('');
const isWellFormed = (s) => (typeof s.isWellFormed === 'function' ? s.isWellFormed() : !/[\uD800-\uDFFF]/.test(s.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')));

export function keyToFileName(key) {
  const k = String(key);
  if (k === '') return '~.json';
  const hashed = () => `~${crypto.createHash('sha1').update(k, 'utf8').digest('hex')}.json`;
  if (!isWellFormed(k)) return hashed();
  const chars = [...k];
  let out = '';
  chars.forEach((ch, i) => {
    if (/^[a-z0-9_-]$/.test(ch)) out += ch;
    else if (/^[A-Z]$/.test(ch)) out += `^${ch.toLowerCase()}`;
    else if (ch === '.' && i > 0 && i < chars.length - 1) out += ch;
    else out += escapeChar(ch);
  });
  if (RESERVED_WIN.test(out.split('.')[0])) out = escapeChar(out[0]) + out.slice(1);
  if (out.length > MAX_NAME) return hashed();
  return `${out}.json`;
}

export function fileNameToKey(name) {
  if (!name.endsWith('.json')) return null;
  if (name === '~.json') return '';
  if (name.startsWith('~')) return null;
  const stem = name.slice(0, -5);
  if (!/^[a-z0-9_\-.%^]+$/.test(stem)) return null;
  try {
    return decodeURIComponent(stem.replace(/\^([a-z])/g, (_, c) => c.toUpperCase()));
  } catch {
    return null;
  }
}

const isHashedName = (name) => HASHED_RE.test(name);
const dirtyId = (ns, key) => `${ns}/${key}`;
const splitId = (id) => { const at = id.indexOf('/'); return [id.slice(0, at), id.slice(at + 1)]; };

function base(load, onChange) {
  const data = new Map();
  const dirty = new Set();
  const touch = (ns, key) => { dirty.add(dirtyId(ns, key)); onChange?.(ns, key); };
  const nsData = (ns) => {
    checkNamespace(ns);
    let d = data.get(ns);
    if (!d) {
      d = load(ns, (key) => touch(ns, key)) || new Map();
      data.set(ns, d);
    }
    return d;
  };
  const api = {
    get(ns, key, fallback) {
      const d = nsData(ns);
      const k = String(key);
      return d.has(k) ? clone(d.get(k)) : clone(fallback);
    },
    has(ns, key) { return nsData(ns).has(String(key)); },
    set(ns, key, value) {
      const k = String(key);
      nsData(ns).set(k, clone(value));
      touch(ns, k);
      return clone(value);
    },
    update(ns, key, fn, fallback) {
      const d = nsData(ns);
      const k = String(key);
      const cur = d.has(k) ? clone(d.get(k)) : clone(fallback);
      const ret = fn(cur);
      const next = ret === undefined ? cur : ret;
      d.set(k, clone(next));
      touch(ns, k);
      return clone(next);
    },
    delete(ns, key) {
      const d = nsData(ns);
      const k = String(key);
      if (!d.has(k)) return false;
      d.delete(k);
      touch(ns, k);
      return true;
    },
    keys(ns) { return [...nsData(ns).keys()]; },
    entries(ns) { return [...nsData(ns)].map(([k, v]) => [k, clone(v)]); },
    async flush() { dirty.clear(); },
    _dirty: dirty,
    _peek(ns, key) {
      const d = data.get(ns);
      if (!d || !d.has(key)) return { found: false };
      return { found: true, value: d.get(key) };
    },
  };
  return api;
}

export function createMemoryStore(seed = {}) {
  const store = base((ns) => new Map(Object.entries(clone(seed[ns]) || {})));
  store.pending = () => store._dirty.size;
  store.flushSync = () => { const n = store._dirty.size; store._dirty.clear(); return n; };
  store.kind = 'memory';
  return store;
}

function sleepSync(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {}
}

function renameSyncRetry(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      if (attempt >= 4 || !RETRY_CODES.includes(e.code)) throw e;
      sleepSync(30 * (attempt + 1));
    }
  }
}

function rmQuiet(file) {
  try { fs.rmSync(file, { force: true }); } catch {}
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function bodyFor(name, key, value) {
  return JSON.stringify(isHashedName(name) ? { '~key': key, value } : value, null, 1);
}

function readBody(text, name, key) {
  const parsed = JSON.parse(text);
  if (!isHashedName(name)) return { key, value: parsed };
  if (!parsed || typeof parsed !== 'object' || typeof parsed['~key'] !== 'string') throw new Error('the saved key is missing');
  return { key: parsed['~key'], value: parsed.value };
}

export function createJsonStore({ dir, delay = 250, log = null, backupDir } = {}) {
  if (!dir) throw new Error('createJsonStore needs a dir');
  fs.mkdirSync(dir, { recursive: true });
  const backupsRoot = backupDir || path.join(dir, 'backups');
  const chains = new Map();
  const inflight = new Map();
  const readyDirs = new Set();
  let timer = null;
  let syncGen = 0;
  let store;

  const nsDir = (ns) => path.join(dir, ns);
  const fileOf = (ns, key) => path.join(nsDir(ns), keyToFileName(key));
  const label = (ns, name) => `data/${ns}/${name}`;

  const writeFileSyncAtomic = (file, text) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (text === null) { rmQuiet(file); return; }
    const tmp = `${file}.${process.pid}.final.tmp`;
    fs.writeFileSync(tmp, text, 'utf8');
    try {
      renameSyncRetry(tmp, file);
    } catch {
      fs.writeFileSync(file, text, 'utf8');
      rmQuiet(tmp);
    }
  };

  const fromBackups = (ns, name, key) => {
    for (const copy of backupCopies(backupsRoot, ns, name)) {
      try {
        return { ...readBody(fs.readFileSync(copy.file, 'utf8'), name, key), date: copy.date };
      } catch {}
    }
    return null;
  };

  const readEntry = (ns, folder, name) => {
    const hashed = isHashedName(name);
    const key = hashed ? null : fileNameToKey(name);
    if (!hashed && key === null) {
      log?.warn?.(`skipped ${label(ns, name)}: YapOS didn't make that file`);
      return null;
    }
    const file = path.join(folder, name);
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      log?.error?.(`couldn't open ${label(ns, name)} (${e.message}); left it where it is`);
      return null;
    }
    try {
      return readBody(text, name, key);
    } catch (e) {
      const bad = `${file}.broken-${Date.now()}`;
      try { fs.renameSync(file, bad); } catch {}
      const found = fromBackups(ns, name, key);
      if (found) {
        try { writeFileSyncAtomic(file, bodyFor(name, found.key, found.value)); } catch {}
        log?.warn?.(`restored ${label(ns, name)} from the backup of ${found.date} (the damaged copy is kept as ${path.basename(bad)})`);
        return { key: found.key, value: found.value };
      }
      log?.error?.(`${label(ns, name)} was unreadable (${e.message}); moved it to ${path.basename(bad)} and started fresh`);
      return null;
    }
  };

  const newestReadable = (files, accept) => {
    const ordered = files
      .map((f) => { try { return { f, at: fs.statSync(f).mtimeMs }; } catch { return null; } })
      .filter(Boolean)
      .sort((a, b) => b.at - a.at);
    for (const { f } of ordered) {
      try {
        const parsed = JSON.parse(fs.readFileSync(f, 'utf8'));
        if (accept(parsed)) return { file: f, parsed };
      } catch {}
    }
    return null;
  };

  const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

  const migrate = (ns, mark) => {
    const oldFile = path.join(dir, `${ns}.json`);
    let oldTmps = [];
    try {
      oldTmps = fs.readdirSync(dir).filter((f) => f.startsWith(`${ns}.json.`) && TMP_RE.test(f)).map((f) => path.join(dir, f));
    } catch {}
    const hasOld = fs.existsSync(oldFile);
    if (!hasOld && !oldTmps.length) return null;

    let source = null;
    let sourceFile = null;
    if (hasOld) {
      try {
        const parsed = JSON.parse(fs.readFileSync(oldFile, 'utf8'));
        if (!isPlainObject(parsed)) throw new Error('it was not a list of servers');
        source = parsed;
        sourceFile = oldFile;
      } catch (e) {
        const bad = `${oldFile}.broken-${Date.now()}`;
        try { fs.renameSync(oldFile, bad); } catch {}
        log?.error?.(`data/${ns}.json was unreadable (${e.message}); moved it to ${path.basename(bad)}`);
      }
    }
    if (!source) {
      const hit = newestReadable(oldTmps, isPlainObject);
      if (hit) {
        source = hit.parsed;
        sourceFile = hit.file;
        log?.info?.(`recovered data/${ns}.json from an unfinished save`);
      }
    }
    if (!source) {
      for (const f of oldTmps) rmQuiet(f);
      return null;
    }

    const folder = nsDir(ns);
    const staging = path.join(dir, `${ns}.migrating`);
    try {
      fs.rmSync(staging, { recursive: true, force: true });
      fs.mkdirSync(staging, { recursive: true });
      for (const [k, v] of Object.entries(source)) {
        if (v === undefined) continue;
        const name = keyToFileName(k);
        fs.writeFileSync(path.join(staging, name), bodyFor(name, k, v), 'utf8');
      }
      renameSyncRetry(staging, folder);
    } catch (e) {
      try { fs.rmSync(staging, { recursive: true, force: true }); } catch {}
      log?.error?.(`couldn't split data/${ns}.json into one file per server yet (${e.message}); using it as it is and trying again on the next save`);
      const map = new Map(Object.entries(source));
      for (const k of map.keys()) mark(k);
      return map;
    }

    let keptAs = `${ns}.json.migrated`;
    if (fs.existsSync(path.join(dir, keptAs))) keptAs = `${ns}.json.migrated-${Date.now()}`;
    try { renameSyncRetry(sourceFile, path.join(dir, keptAs)); } catch {}
    for (const f of oldTmps) if (f !== sourceFile) rmQuiet(f);
    log?.info?.(`moved data/${ns}.json to one file per server in data/${ns}/ (the old file is kept as ${keptAs})`);
    return null;
  };

  const load = (ns, mark) => {
    const folder = nsDir(ns);
    if (!isDir(folder)) {
      const fallback = migrate(ns, mark);
      if (fallback) return fallback;
    }
    const out = new Map();
    if (!isDir(folder)) return out;
    let names;
    try {
      names = fs.readdirSync(folder);
    } catch (e) {
      log?.error?.(`couldn't read the data/${ns} folder (${e.message})`);
      return out;
    }
    const jsonNames = new Set(names.filter((n) => n.endsWith('.json')));
    const tmpGroups = new Map();
    for (const n of names) {
      const m = TMP_RE.exec(n);
      if (!m) continue;
      if (!tmpGroups.has(m[1])) tmpGroups.set(m[1], []);
      tmpGroups.get(m[1]).push(path.join(folder, n));
    }
    for (const [target, tmps] of tmpGroups) {
      if (!jsonNames.has(target)) {
        const hit = newestReadable(tmps, () => true);
        if (hit) {
          try {
            renameSyncRetry(hit.file, path.join(folder, target));
            jsonNames.add(target);
            log?.info?.(`recovered ${label(ns, target)} from an unfinished save`);
          } catch {}
        }
      }
      for (const t of tmps) rmQuiet(t);
    }
    for (const name of [...jsonNames].sort()) {
      const entry = readEntry(ns, folder, name);
      if (entry) out.set(entry.key, entry.value);
    }
    readyDirs.add(ns);
    return out;
  };

  const textFor = (ns, key) => {
    const cur = store._peek(ns, key);
    if (!cur.found || cur.value === undefined) return null;
    return bodyFor(keyToFileName(key), key, cur.value);
  };

  const ensureDir = async (ns) => {
    if (readyDirs.has(ns)) return;
    await fs.promises.mkdir(nsDir(ns), { recursive: true });
    readyDirs.add(ns);
  };

  const writeAsync = async (ns, file, text, gen) => {
    if (text === null) {
      await fs.promises.rm(file, { force: true });
      return;
    }
    await ensureDir(ns);
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      await fs.promises.writeFile(tmp, text, 'utf8');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      readyDirs.delete(ns);
      await ensureDir(ns);
      await fs.promises.writeFile(tmp, text, 'utf8');
    }
    for (let attempt = 0; ; attempt++) {
      if (gen !== syncGen) {
        await fs.promises.rm(tmp, { force: true });
        return;
      }
      try {
        await fs.promises.rename(tmp, file);
        return;
      } catch (e) {
        if (attempt >= 4 || !RETRY_CODES.includes(e.code)) throw e;
        await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
      }
    }
  };

  const queueWrite = (id) => {
    const [ns, key] = splitId(id);
    const file = fileOf(ns, key);
    const text = textFor(ns, key);
    const gen = syncGen;
    inflight.set(id, (inflight.get(id) || 0) + 1);
    const prev = chains.get(id) || Promise.resolve();
    const next = prev.catch(() => {})
      .then(() => writeAsync(ns, file, text, gen))
      .catch((e) => {
        store._dirty.add(id);
        log?.error?.(`Couldn't save ${label(ns, path.basename(file))}: ${e.message}`);
        throw e;
      })
      .finally(() => {
        const n = (inflight.get(id) || 1) - 1;
        if (n > 0) inflight.set(id, n);
        else inflight.delete(id);
      });
    chains.set(id, next);
    next.finally(() => { if (chains.get(id) === next) chains.delete(id); }).catch(() => {});
    return next;
  };

  const writeDirty = () => {
    for (const id of [...store._dirty]) {
      store._dirty.delete(id);
      queueWrite(id).catch(() => {});
    }
  };

  const schedule = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      writeDirty();
    }, delay);
  };

  store = base(load, schedule);

  store.flush = async () => {
    if (timer) clearTimeout(timer);
    timer = null;
    writeDirty();
    await Promise.allSettled([...chains.values()]);
  };

  store.flushSync = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    syncGen++;
    const ids = new Set([...store._dirty, ...inflight.keys()]);
    let saved = 0;
    for (const id of ids) {
      const [ns, key] = splitId(id);
      try {
        writeFileSyncAtomic(fileOf(ns, key), textFor(ns, key));
        store._dirty.delete(id);
        saved++;
      } catch (e) {
        log?.error?.(`Couldn't save ${label(ns, keyToFileName(key))} on exit: ${e.message}`);
      }
    }
    return saved;
  };

  store.pending = () => store._dirty.size + (timer ? 1 : 0) + chains.size;
  store.kind = 'json';
  store.dir = dir;
  store.backupDir = backupsRoot;
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
