import { h, button } from './dom.js';

export const WARNINGS_ENDPOINT = '/api/activity/warnings';
export const WARNING_POLL_MS = 60000;
export const WARNING_MIN_GAP_MS = 15000;
export const WARNING_HEADING = 'A mod warned you';
export const WARNING_TITLE = `⚠️ ${WARNING_HEADING}`;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TEXT_MAX = 200;

export function readWarnings(data) {
  const list = data && Array.isArray(data.warnings) ? data.warnings : [];
  return list
    .filter((w) => w && typeof w === 'object' && typeof w.id === 'string' && ID_RE.test(w.id) && typeof w.text === 'string' && w.text.trim())
    .map((w) => ({ id: w.id, text: Array.from(w.text.trim()).slice(0, TEXT_MAX).join(''), created: Number(w.created) || 0 }));
}

export function inboxNotice(before, n) {
  const count = Math.max(0, Math.floor(Number(n) || 0));
  if (!count) return null;
  if (before === null || before === undefined) return `📬 You have ${count} unread in your YapOS inbox. Open yapos.dev/inbox to see ${count === 1 ? 'it' : 'them'}.`;
  if (count > before) return `📬 Something new arrived in your YapOS inbox. Open yapos.dev/inbox to see it.`;
  return null;
}

export function createWarnings({ win, gate, fetchImpl = null, pollMs = WARNING_POLL_MS, minGapMs = WARNING_MIN_GAP_MS, now = () => Date.now(), onInbox = null } = {}) {
  const doc = (win && win.document) || (typeof document !== 'undefined' ? document : null);
  const doFetch = fetchImpl || (win && typeof win.fetch === 'function' ? (...a) => win.fetch(...a) : null);
  let queue = [];
  let shown = null;
  let who = null;
  let busy = false;
  let lastAsk = -Infinity;
  let destroyed = false;
  const done = new Set();

  const title = h('h2', { class: 'warn-title', text: WARNING_HEADING, attrs: { id: 'warn-title' } });
  const text = h('p', { class: 'warn-text', attrs: { id: 'warn-text' } });
  const hint = h('p', { class: 'warn-hint', text: 'Party staff sent you this message. Keep playing fair and kind so you can keep joining games.' });
  const ok = button('I understand', { variant: 'primary', key: 'warn-ok', on: () => ack() });
  const card = h('section', { class: ['signin-card', 'warn-card'], attrs: { role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'warn-title', 'aria-describedby': 'warn-text', tabindex: '-1' } },
    h('span', { class: 'warn-crest', text: '⚠️', attrs: { 'aria-hidden': 'true' } }),
    title,
    text,
    hint,
    h('div', { class: 'warn-actions' }, ok));
  const el = h('div', { class: ['signin-layer', 'warn-layer'], attrs: { hidden: true } }, h('div', { class: 'signin-backdrop', attrs: { 'aria-hidden': 'true' } }), card);
  el.hidden = true;
  el.addEventListener('keydown', onKey);

  function onKey(e) {
    if (e.key === 'Tab') {
      e.preventDefault();
      ok.focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
    }
  }

  function signedIn() {
    try {
      const s = gate && typeof gate.state === 'function' ? gate.state() : null;
      return s && s.status === 'in' && s.me ? s : null;
    } catch {
      return null;
    }
  }

  function headers(s) {
    const out = { Accept: 'application/json' };
    if (s && s.token) out.Authorization = `Bearer ${s.token}`;
    return out;
  }

  function show() {
    if (destroyed || shown || !queue.length) return;
    shown = queue.shift();
    text.textContent = shown.text;
    el.hidden = false;
    try {
      ok.focus();
    } catch {}
  }

  function hide() {
    shown = null;
    el.hidden = true;
  }

  async function check(force = false) {
    const s = signedIn();
    if (!s || busy || destroyed || typeof doFetch !== 'function') return false;
    const at = now();
    if (!force && at - lastAsk < minGapMs) return false;
    lastAsk = at;
    busy = true;
    try {
      const res = await doFetch(`${WARNINGS_ENDPOINT}?for=${encodeURIComponent(s.me)}`, { method: 'GET', credentials: 'same-origin', cache: 'no-store', headers: headers(s) });
      if (!res || !res.ok) return false;
      const data = await res.json();
      if (destroyed || !data || data.mismatch) return false;
      const current = signedIn();
      if (!current || current.me !== s.me) return false;
      if (typeof onInbox === 'function' && Number.isFinite(data.inbox)) {
        try {
          onInbox(Math.max(0, Math.floor(data.inbox)));
        } catch {}
      }
      const queued = new Set(queue.map((w) => w.id).concat(shown ? [shown.id] : []));
      const fresh = readWarnings(data).filter((w) => !done.has(w.id) && !queued.has(w.id));
      queue = queue.concat(fresh);
      show();
      return fresh.length > 0;
    } catch {
      return false;
    } finally {
      busy = false;
    }
  }

  async function ack() {
    if (!shown) return;
    const w = shown;
    done.add(w.id);
    hide();
    const s = signedIn();
    if (s && typeof doFetch === 'function') {
      try {
        await doFetch(`${WARNINGS_ENDPOINT}/${encodeURIComponent(w.id)}/seen`, { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { ...headers(s), 'Content-Type': 'application/json' }, body: '{}' });
      } catch {}
    }
    show();
  }

  function update() {
    if (destroyed) return;
    const s = signedIn();
    const key = s ? String(s.me) : null;
    if (key === who) return;
    who = key;
    queue = [];
    hide();
    if (key) check(true);
  }

  function onVisible() {
    if (doc && doc.visibilityState === 'visible') check(false);
  }

  if (doc && typeof doc.addEventListener === 'function') doc.addEventListener('visibilitychange', onVisible);
  const timer = win && typeof win.setInterval === 'function' && pollMs > 0
    ? win.setInterval(() => {
      if (doc && doc.visibilityState === 'hidden') return;
      check(true);
    }, pollMs)
    : null;

  function destroy() {
    destroyed = true;
    if (timer !== null && win && typeof win.clearInterval === 'function') win.clearInterval(timer);
    if (doc && typeof doc.removeEventListener === 'function') doc.removeEventListener('visibilitychange', onVisible);
    el.removeEventListener('keydown', onKey);
    hide();
  }

  return {
    el,
    update,
    check,
    ack,
    destroy,
    get current() {
      return shown;
    },
    get queued() {
      return queue.length;
    },
  };
}
