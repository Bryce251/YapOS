import fs from 'node:fs';
import path from 'node:path';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const NS_RE = /^[a-z0-9_-]{1,40}$/;
const SKIP_FOLDERS = new Set(['backups', 'logs']);
const SKIP_FILES = new Set(['config.json', 'package.json', 'package-lock.json']);
const RETRY_CODES = ['EPERM', 'EBUSY', 'EACCES'];

const pad = (n) => String(n).padStart(2, '0');

export function dayStamp(date) {
  const d = date instanceof Date ? date : new Date(date);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function stampToDays(stamp) {
  const [y, m, d] = stamp.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
}

function listDates(folder) {
  try {
    return fs.readdirSync(folder, { withFileTypes: true })
      .filter((e) => e.isDirectory() && DATE_RE.test(e.name))
      .map((e) => e.name)
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

export function backupCopies(root, ns, fileName) {
  const out = [];
  for (const kind of ['daily', 'weekly']) {
    for (const date of listDates(path.join(root, kind))) {
      const file = path.join(root, kind, date, ns, fileName);
      if (fs.existsSync(file)) out.push({ file, date, kind });
    }
  }
  return out;
}

function renameDirSync(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      if (attempt >= 4 || !RETRY_CODES.includes(e.code)) throw e;
      const until = Date.now() + 40 * (attempt + 1);
      while (Date.now() < until) {}
    }
  }
}

function copyFileCounted(from, to, tally) {
  try {
    fs.copyFileSync(from, to);
    tally.files++;
    tally.bytes += fs.statSync(to).size;
    return true;
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
}

function copyData(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const tally = { files: 0, bytes: 0 };
  const namespaces = {};
  const legacy = [];
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.isDirectory() && NS_RE.test(entry.name) && !SKIP_FOLDERS.has(entry.name)) {
      const from = path.join(src, entry.name);
      const to = path.join(dest, entry.name);
      fs.mkdirSync(to, { recursive: true });
      let count = 0;
      for (const f of fs.readdirSync(from, { withFileTypes: true })) {
        if (!f.isFile() || !f.name.endsWith('.json')) continue;
        if (copyFileCounted(path.join(from, f.name), path.join(to, f.name), tally)) count++;
      }
      namespaces[entry.name] = count;
    } else if (entry.isFile() && /^[a-z0-9_-]{1,40}\.json$/.test(entry.name) && !SKIP_FILES.has(entry.name)) {
      if (copyFileCounted(path.join(src, entry.name), path.join(dest, entry.name), tally)) legacy.push(entry.name);
    }
  }
  return { namespaces, legacy, files: tally.files, bytes: tally.bytes };
}

function prune(folder, keep) {
  const removed = [];
  for (const date of listDates(folder).slice(keep)) {
    fs.rmSync(path.join(folder, date), { recursive: true, force: true });
    removed.push(date);
  }
  for (const name of safeList(folder)) {
    if (name.startsWith('.') && name.endsWith('.partial')) fs.rmSync(path.join(folder, name), { recursive: true, force: true });
  }
  return removed;
}

function safeList(folder) {
  try { return fs.readdirSync(folder); } catch { return []; }
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function createBackups({ dir, store = null, log = null, now = () => new Date(), keepDaily = 7, keepWeekly = 4, checkEveryMs = HOUR_MS, root } = {}) {
  if (!dir) throw new Error('createBackups needs the data folder (dir)');
  const backupRoot = root || path.join(dir, 'backups');
  const dailyDir = path.join(backupRoot, 'daily');
  const weeklyDir = path.join(backupRoot, 'weekly');
  let running = null;
  let timer = null;

  const hasToday = () => fs.existsSync(path.join(dailyDir, dayStamp(now()), 'manifest.json'));

  const needsWeekly = (at, date) => {
    if (at.getDay() === 0) return true;
    const newest = listDates(weeklyDir)[0];
    if (!newest) return true;
    return stampToDays(date) - stampToDays(newest) >= 7;
  };

  const place = (staging, final) => {
    fs.rmSync(final, { recursive: true, force: true });
    renameDirSync(staging, final);
  };

  async function run() {
    try {
      if (store?.flush) await store.flush();
      const at = now();
      const date = dayStamp(at);
      fs.mkdirSync(dailyDir, { recursive: true });
      const staging = path.join(dailyDir, `.${date}.partial`);
      fs.rmSync(staging, { recursive: true, force: true });
      const copied = copyData(dir, staging);
      const manifest = { date, createdAt: at.toISOString(), kind: 'daily', files: copied.files, bytes: copied.bytes, namespaces: copied.namespaces, legacyFiles: copied.legacy };
      fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 1), 'utf8');
      const final = path.join(dailyDir, date);
      place(staging, final);

      let weekly = false;
      if (needsWeekly(at, date)) {
        fs.mkdirSync(weeklyDir, { recursive: true });
        const wStaging = path.join(weeklyDir, `.${date}.partial`);
        fs.rmSync(wStaging, { recursive: true, force: true });
        fs.cpSync(final, wStaging, { recursive: true });
        fs.writeFileSync(path.join(wStaging, 'manifest.json'), JSON.stringify({ ...manifest, kind: 'weekly' }, null, 1), 'utf8');
        place(wStaging, path.join(weeklyDir, date));
        weekly = true;
      }

      const removed = { daily: prune(dailyDir, keepDaily), weekly: prune(weeklyDir, keepWeekly) };
      log?.info(`backed up ${plural(copied.files, 'file')} from ${plural(Object.keys(copied.namespaces).length + copied.legacy.length, 'app')} to data/backups/daily/${date}${weekly ? ' and made this week\'s copy' : ''}`);
      return { ok: true, date, files: copied.files, bytes: copied.bytes, weekly, removed, path: final };
    } catch (e) {
      try { log?.error(`The daily backup didn't finish (${e?.message || e}). Your data is safe; YapOS will try again later.`); } catch {}
      return { ok: false, error: String(e?.message || e) };
    }
  }

  function backupNow() {
    if (running) return running;
    running = run().finally(() => { running = null; });
    return running;
  }

  function check() {
    try {
      if (!hasToday()) return backupNow();
    } catch (e) {
      try { log?.error(`Couldn't check today's backup (${e?.message || e}).`); } catch {}
    }
    return Promise.resolve(null);
  }

  function start() {
    if (timer) return api;
    check();
    timer = setInterval(check, checkEveryMs);
    timer.unref?.();
    return api;
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  function list() {
    return { daily: listDates(dailyDir), weekly: listDates(weeklyDir) };
  }

  const api = { backupNow, start, stop, check, list, root: backupRoot };
  return api;
}
