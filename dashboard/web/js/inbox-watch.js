import { toast } from './ui.js';

export const INBOX_POLL_MS = 60000;
export const INBOX_COUNT_API = '/api/me/inbox/count';
const TOASTS_AT_ONCE = 3;

export function createInboxWatch({ api, onCount = () => {}, onNew = () => {}, doc = globalThis.document, setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (t) => clearTimeout(t), every = INBOX_POLL_MS } = {}) {
  let timer = null;
  let stopped = true;
  let seen = null;
  let busy = false;
  const state = { onCount, onNew, unread: 0 };
  const hidden = () => Boolean(doc && doc.hidden === true);

  function schedule() {
    if (stopped) return;
    if (timer !== null) clearTimer(timer);
    timer = setTimer(run, every);
  }

  async function check() {
    if (busy) return;
    busy = true;
    try {
      const data = await api.get(INBOX_COUNT_API, { allow401: true });
      if (!data || typeof data !== 'object') return;
      const unread = Math.max(0, Math.floor(Number(data.unread) || 0));
      state.unread = unread;
      state.onCount(unread);
      const newest = Array.isArray(data.newest) ? data.newest.filter((x) => x && typeof x.id === 'string') : [];
      if (seen) {
        const fresh = newest.filter((x) => !seen.has(x.id));
        for (const item of fresh.slice(0, TOASTS_AT_ONCE).reverse()) state.onNew(item);
      } else seen = new Set();
      for (const x of newest) seen.add(x.id);
    } catch {
      return;
    } finally {
      busy = false;
    }
  }

  async function run() {
    timer = null;
    if (stopped) return;
    if (!hidden()) await check();
    schedule();
  }

  function onVisible() {
    if (stopped || hidden()) return;
    if (timer !== null) clearTimer(timer);
    timer = null;
    run();
  }

  return {
    start() {
      if (!stopped) return false;
      stopped = false;
      if (doc && doc.addEventListener) doc.addEventListener('visibilitychange', onVisible);
      run();
      return true;
    },
    stop() {
      stopped = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
      if (doc && doc.removeEventListener) doc.removeEventListener('visibilitychange', onVisible);
    },
    check,
    setCount(n) {
      state.unread = Math.max(0, Math.floor(Number(n) || 0));
      state.onCount(state.unread);
    },
    set onCount(fn) { state.onCount = fn; },
    set onNew(fn) { state.onNew = fn; },
    get unread() { return state.unread; },
    get running() { return !stopped; },
  };
}

let watcher = null;

export function startInboxWatch({ api, onCount }) {
  if (!watcher) {
    watcher = createInboxWatch({
      api,
      onCount,
      onNew: (item) => toast(item.body ? `${item.title}. ${item.body}` : item.title, { tone: 'info', title: 'New in your inbox', timeout: 6000 }),
    });
    watcher.start();
  } else {
    watcher.onCount = onCount;
    onCount(watcher.unread);
  }
  return watcher;
}

export function inboxCountChanged(n) {
  if (watcher) watcher.setCount(n);
}

export function stopInboxWatch() {
  if (watcher) watcher.stop();
  watcher = null;
}
