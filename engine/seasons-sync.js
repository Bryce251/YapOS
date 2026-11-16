import { workerClient } from './worker-post.js';
import { globalDoc, SEASON_NS, SEASON_KINDS, SEASON_TOP } from './global.js';
import { validId, cleanText, privacyOf } from './profile-data.js';

export const SEASON_EVENT = 'season:closed';
const SYNC_NS = 'socialsync';
const SYNC_KEY = 'seasons';
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const PER_RUN = 3;
const KEEP_PUSHED = 120;
const LOOKUP_MS = 3000;

const syncs = new WeakMap();

function cleanRow(raw, i) {
  if (Array.isArray(raw)) return cleanRow({ id: raw[0], value: raw[1] }, i);
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!validId(id)) return null;
  const value = Math.max(0, Math.floor(Number(raw.value ?? raw.score) || 0));
  const rank = Number.isInteger(raw.rank) && raw.rank > 0 ? raw.rank : i + 1;
  return { rank, id, name: cleanText(raw.name) || null, username: cleanText(raw.username, 32) || null, value };
}

export function cleanBoards(boards) {
  const out = {};
  for (const kind of SEASON_KINDS) {
    const list = Array.isArray(boards?.[kind]) ? boards[kind] : [];
    out[kind] = list.map(cleanRow).filter(Boolean).slice(0, SEASON_TOP);
  }
  return out;
}

function createSeasonSync(engine, { fetch = null } = {}) {
  const client = workerClient(engine, { fetch });
  const names = new Map();
  let listener = null;
  let running = null;

  const readDoc = () => {
    const raw = engine.store.get(SYNC_NS, SYNC_KEY, null);
    const pushed = Array.isArray(raw?.pushed) ? raw.pushed.filter((m) => MONTH_RE.test(m)) : [];
    const outbox = raw?.outbox && typeof raw.outbox === 'object' && !Array.isArray(raw.outbox) ? raw.outbox : {};
    return { pushed, outbox };
  };
  const writeDoc = (doc) => {
    if (doc.pushed.length > KEEP_PUSHED) doc.pushed.splice(0, doc.pushed.length - KEEP_PUSHED);
    engine.store.set(SYNC_NS, SYNC_KEY, doc);
  };

  function queue(month, boards) {
    if (!MONTH_RE.test(String(month || ''))) return false;
    const doc = readDoc();
    doc.outbox[month] = cleanBoards(boards);
    doc.pushed = doc.pushed.filter((m) => m !== month);
    writeDoc(doc);
    return true;
  }

  function fromHistory(doc) {
    const season = globalDoc(engine, SEASON_NS, null);
    const history = season?.history && typeof season.history === 'object' ? season.history : {};
    for (const month of Object.keys(history).sort()) {
      if (!MONTH_RE.test(month) || doc.pushed.includes(month) || doc.outbox[month]) continue;
      doc.outbox[month] = cleanBoards(history[month]);
    }
  }

  async function nameOf(uid) {
    if (names.has(uid)) return names.get(uid);
    let out = { name: null, username: null };
    if (typeof engine.bot.user === 'function') {
      let timer;
      const late = new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), LOOKUP_MS);
        timer.unref?.();
      });
      try {
        const u = await Promise.race([Promise.resolve().then(() => engine.bot.user(uid)).catch(() => null), late]);
        if (u && typeof u === 'object') out = { name: cleanText(u.display_name ?? u.displayName ?? null), username: cleanText(u.username, 32) };
      } finally {
        clearTimeout(timer);
      }
    }
    if (names.size > 2000) names.clear();
    names.set(uid, out);
    return out;
  }

  async function withNames(boards) {
    const out = {};
    for (const kind of SEASON_KINDS) {
      out[kind] = [];
      for (const row of boards[kind] || []) {
        if (privacyOf(engine, row.id).hidden) {
          out[kind].push({ rank: row.rank, id: row.id, name: 'Hidden player', username: null, value: row.value });
          continue;
        }
        let { name, username } = row;
        if (!name || !username) {
          const got = await nameOf(row.id);
          name = name || got.name || got.username;
          username = username || got.username;
        }
        out[kind].push({ rank: row.rank, id: row.id, name: name || 'Someone', username: username || null, value: row.value });
      }
    }
    return out;
  }

  async function runPush() {
    if (!client.enabled) return { sent: 0 };
    const doc = readDoc();
    fromHistory(doc);
    writeDoc(doc);
    let sent = 0;
    for (const month of Object.keys(doc.outbox).sort().slice(0, PER_RUN)) {
      const boards = await withNames(cleanBoards(doc.outbox[month]));
      const r = await client.post('/bot/seasons', { month, boards });
      if (!r.ok) {
        engine.log?.debug?.(`[seasons] upload answered ${r.status}`);
        break;
      }
      const now = readDoc();
      delete now.outbox[month];
      if (!now.pushed.includes(month)) now.pushed.push(month);
      writeDoc(now);
      sent++;
    }
    return { sent };
  }

  function push() {
    if (running) return running;
    running = runPush().finally(() => { running = null; });
    return running;
  }

  async function onClosed(ev) {
    if (!ev || typeof ev !== 'object') return;
    const boards = ev.boards ?? ev.tops;
    if (!queue(ev.month, boards)) return;
    try {
      await push();
    } catch (e) {
      engine.log?.debug?.(`[seasons] upload failed: ${e?.message}`);
    }
  }

  return {
    queue,
    push,
    onClosed,
    get waiting() { return Object.keys(readDoc().outbox).length; },
    install() {
      if (listener) return;
      listener = (ev) => onClosed(ev);
      engine.bot.on(SEASON_EVENT, listener);
    },
    uninstall() {
      if (!listener) return;
      const list = engine.bot.handlers?.[SEASON_EVENT];
      if (Array.isArray(list)) {
        const i = list.indexOf(listener);
        if (i >= 0) list.splice(i, 1);
      }
      listener = null;
    },
  };
}

export function seasonSync(engine, opts) {
  let s = syncs.get(engine);
  if (!s) {
    s = createSeasonSync(engine, opts);
    syncs.set(engine, s);
  }
  return s;
}

export function dropSeasonSync(engine) {
  const s = syncs.get(engine);
  if (!s) return;
  s.uninstall();
  syncs.delete(engine);
}
