import { h, button, clock } from './dom.js';
import { copyText } from './copy.js';
import { createAccountApi, tokenFor, saveToken, forgetToken } from '../account.js';

export const MIN_POLL_MS = 2000;
export const MAX_POLL_MS = 30000;
export const SUCCESS_MS = 1200;
export const RECHECK_MS = 20000;
export const LOW_MS = 60000;
export const OPEN_STATES = new Set(['out', 'mismatch']);
export const LOGIN_HREF = '/auth/login?next=%2Factivity%2F';

export function spellCode(code) {
  return String(code || '').replace(/[^0-9A-Za-z]/g, '').split('').join(' ');
}

export function pollDelay(interval, errors) {
  const base = Math.max(MIN_POLL_MS, Number(interval) || 2500);
  if (!errors) return base;
  return Math.min(MAX_POLL_MS, base * 2 ** Math.min(errors, 4));
}

function firstName(u, fallback = 'you') {
  if (!u) return fallback;
  return String(u.display_name || u.username || fallback).slice(0, 64);
}

export function createSignin({ win, engine = null, toast = () => {}, dev = false, alone = false, host = null, account = null, onChange = () => {} } = {}) {
  const api = account || createAccountApi({ win });
  const doc = (win && win.document) || (typeof document !== 'undefined' ? document : null);
  const later = (fn, ms) => (win && typeof win.setTimeout === 'function' ? win.setTimeout(fn, ms) : setTimeout(fn, ms));
  const cancel = (id) => (win && typeof win.clearTimeout === 'function' ? win.clearTimeout(id) : clearTimeout(id));
  const every = (fn, ms) => (win && typeof win.setInterval === 'function' ? win.setInterval(fn, ms) : null);
  const stopEvery = (id) => {
    if (id !== null && win && typeof win.clearInterval === 'function') win.clearInterval(id);
  };
  const now = () => (engine && typeof engine.now === 'function' ? engine.now() : Date.now());

  let status = 'idle';
  let me = null;
  let meName = '';
  let user = null;
  let via = null;
  let link = null;
  let pollTimer = null;
  let pollErrors = 0;
  let recheckTimer = null;
  let successTimer = null;
  let ticker = null;
  let isOpen = false;
  let dismissed = false;
  let autoOpened = false;
  let reason = '';
  let view = 'code';
  let returnFocus = null;
  let destroyed = false;
  let checkSeq = 0;

  const card = h('section', { class: 'signin-card', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'signin-title', 'aria-describedby': 'signin-text', tabindex: '-1' } });
  const el = h('div', { class: 'signin-layer', attrs: { hidden: true } }, h('div', { class: 'signin-backdrop', attrs: { 'aria-hidden': 'true' } }), card);
  el.hidden = true;
  el.addEventListener('keydown', onKey);

  function set(next) {
    if (status === next) return;
    status = next;
    try {
      onChange(status);
    } catch {
      status = next;
    }
  }

  function snapshot() {
    try {
      return engine && typeof engine.snapshot === 'function' ? engine.snapshot() : null;
    } catch {
      return null;
    }
  }

  function nameFromSnap(snap) {
    const players = snap && Array.isArray(snap.players) ? snap.players : [];
    const mine = players.find((p) => p && p.isMe);
    return mine && mine.name ? String(mine.name).slice(0, 64) : '';
  }

  async function check() {
    if (!me) return;
    const seq = ++checkSeq;
    set('checking');
    const token = tokenFor(win, me);
    let res = await api.me(token);
    if (destroyed || seq !== checkSeq) return;
    if (!res.ok && token && res.status === 401) {
      forgetToken(win, me);
      res = await api.me(null);
      if (destroyed || seq !== checkSeq) return;
    }
    if (res.ok) {
      user = res.user;
      via = res.via;
      if (user.id === me) {
        set('in');
        if (isOpen && view !== 'success') close();
      } else {
        set('mismatch');
        view = 'mismatch';
        autoOpen();
      }
      paint();
      return;
    }
    user = null;
    via = null;
    if (res.status === 401) {
      set('out');
      view = 'code';
      autoOpen();
    } else {
      set('offline');
      if (recheckTimer !== null) cancel(recheckTimer);
      recheckTimer = later(() => {
        recheckTimer = null;
        if (status === 'offline') check();
      }, RECHECK_MS);
    }
    paint();
  }

  function autoOpen() {
    if (autoOpened || dismissed || isOpen) return;
    const snap = snapshot();
    if (snap && snap.ready === false) return;
    autoOpened = true;
    open();
  }

  function update(snap) {
    if (destroyed || !snap || !snap.ready) return;
    const id = snap.me !== undefined && snap.me !== null && snap.me !== '' ? String(snap.me) : null;
    const name = nameFromSnap(snap);
    if (name && name !== meName) {
      meName = name;
      if (isOpen) paint();
    }
    if (id && id !== me) {
      me = id;
      check();
    }
  }

  async function startLink() {
    stopPoll();
    link = { state: 'loading' };
    view = 'code';
    paint();
    const res = await api.start(me);
    if (destroyed) return;
    if (!res.ok) {
      link = { state: 'error', message: res.status === 429 ? 'Too many new codes. Wait a minute, then tap "Get a new code".' : "Couldn't make a code right now. Check your connection and try again." };
      paint();
      return;
    }
    const at = now();
    link = { state: 'waiting', code: res.code, token: res.token, interval: res.interval, starts: at, ends: at + Math.max(1000, res.ttl || res.expires - Date.now()) };
    pollErrors = 0;
    paint();
    schedulePoll();
  }

  function stopPoll() {
    if (pollTimer !== null) cancel(pollTimer);
    pollTimer = null;
  }

  function schedulePoll() {
    stopPoll();
    if (!link || link.state !== 'waiting') return;
    pollTimer = later(pollOnce, pollDelay(link.interval, pollErrors));
  }

  function hidden() {
    return Boolean(doc && doc.hidden);
  }

  async function pollOnce() {
    pollTimer = null;
    if (destroyed || !link || link.state !== 'waiting') return;
    if (now() >= link.ends) {
      expire();
      return;
    }
    if (hidden()) {
      schedulePoll();
      return;
    }
    const current = link;
    const res = await api.poll(current.token);
    if (destroyed || link !== current) return;
    if (res.status === 'pending') {
      pollErrors = 0;
      schedulePoll();
      return;
    }
    if (res.status === 'error') {
      pollErrors += 1;
      schedulePoll();
      return;
    }
    if (res.status === 'expired') {
      expire();
      return;
    }
    approved(res.token, res.user);
  }

  function expire() {
    stopPoll();
    if (link && link.state === 'waiting') link = { ...link, state: 'expired' };
    paint();
  }

  function approved(token, who) {
    stopPoll();
    const old = tokenFor(win, me);
    saveToken(win, me, token);
    if (old && old !== token) api.logout(old);
    link = null;
    user = who;
    via = 'code';
    if (who && who.id === me) {
      set('in');
      view = 'success';
      if (isOpen) {
        paint();
        if (successTimer !== null) cancel(successTimer);
        successTimer = later(() => {
          successTimer = null;
          if (view === 'success') close();
        }, SUCCESS_MS);
      }
      toast(`Signed in as ${firstName(who)}`, 'success');
      return;
    }
    set('mismatch');
    view = 'mismatch';
    if (!isOpen) open();
    else paint();
  }

  function skip() {
    if (!dev) return;
    stopPoll();
    link = null;
    set('skipped');
    close();
    toast('Skipped sign-in for this test call.');
  }

  async function devApprove() {
    if (!dev || !link || link.state !== 'waiting') return;
    const ok = await api.devApprove(link.code, me);
    if (!ok) toast("The test sign-in didn't work. Is the local dashboard running?");
    else if (pollTimer !== null) {
      stopPoll();
      pollOnce();
    }
  }

  function open(why = '') {
    if (destroyed) return false;
    reason = why;
    if (status === 'mismatch' && view !== 'code') view = 'mismatch';
    else if (status !== 'in') view = 'code';
    if (!isOpen) {
      isOpen = true;
      returnFocus = doc && doc.activeElement && doc.activeElement !== doc.body ? doc.activeElement : null;
      el.hidden = false;
      el.classList.remove('is-closing');
      if (host && host.classList) host.classList.add('has-modal');
      if (ticker === null) ticker = every(tick, 250);
    }
    if (view === 'code' && (!link || link.state === 'expired' || link.state === 'error')) startLink();
    else paint();
    focusStart();
    return true;
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    if (view === 'success') view = 'code';
    stopEvery(ticker);
    ticker = null;
    el.classList.add('is-closing');
    const done = () => {
      if (isOpen) return;
      el.hidden = true;
      el.classList.remove('is-closing');
    };
    el.addEventListener('animationend', done, { once: true });
    later(done, 220);
    if (host && host.classList) host.classList.remove('has-modal');
    const back = returnFocus;
    returnFocus = null;
    if (back && typeof back.focus === 'function' && back.isConnected !== false) back.focus();
  }

  function dismiss() {
    dismissed = true;
    close();
  }

  function onKey(e) {
    if (!isOpen || !e) return;
    if (e.key === 'Escape') {
      if (typeof e.preventDefault === 'function') e.preventDefault();
      dismiss();
      return;
    }
    if (e.key !== 'Tab') return;
    const items = [...card.querySelectorAll('button:not([disabled]), a[href]')].filter((n) => !n.hidden);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = doc ? doc.activeElement : null;
    if (e.shiftKey && (active === first || !card.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  function focusStart() {
    const target = card.querySelector('.signin-copy') || card.querySelector('.signin-primary') || card.querySelector('button');
    if (target && typeof target.focus === 'function') target.focus();
    else if (typeof card.focus === 'function') card.focus();
  }

  async function copy() {
    if (!link || !link.code) return;
    const btn = card.querySelector('.signin-copy');
    const ok = await copyText({ win, doc, value: link.code, host: card });
    if (ok && btn) {
      btn.classList.add('is-copied');
      setLabel(btn, 'Copied');
      setStatus('Code copied. Paste it on yapos.dev/link.');
      later(() => {
        btn.classList.remove('is-copied');
        setLabel(btn, 'Copy');
      }, 2000);
      return;
    }
    selectCode();
    setStatus('Press Ctrl+C to copy the code.');
  }

  function selectCode() {
    const out = card.querySelector('.signin-code');
    try {
      const sel = win && typeof win.getSelection === 'function' ? win.getSelection() : null;
      if (!out || !sel || !doc || typeof doc.createRange !== 'function') return false;
      const range = doc.createRange();
      range.selectNodeContents(out);
      sel.removeAllRanges();
      sel.addRange(range);
      return true;
    } catch {
      return false;
    }
  }

  function setLabel(btn, text) {
    const label = btn.querySelector('.btn-label');
    if (label) label.textContent = text;
  }

  function setStatus(text) {
    const s = card.querySelector('.signin-status-text');
    if (s) s.textContent = text;
  }

  function tick() {
    if (!isOpen || !link || link.state !== 'waiting') return;
    const t = now();
    const left = link.ends - t;
    if (left <= 0) {
      expire();
      return;
    }
    const box = card.querySelector('.signin-expiry');
    if (!box) return;
    const span = Math.max(1, link.ends - link.starts);
    box.style.setProperty('--left', Math.min(1, Math.max(0, left / span)).toFixed(4));
    box.classList.toggle('is-low', left <= LOW_MS);
    const text = box.querySelector('.signin-expiry-text');
    const next = `Code expires in ${clock(left)}`;
    if (text && text.textContent !== next) text.textContent = next;
  }

  function crest() {
    return h('div', { class: 'signin-crest', attrs: { 'aria-hidden': 'true' } }, h('span', { class: 'signin-crest-ring' }), h('span', { class: 'signin-crest-mark' }, h('img', { class: 'mark-img', alt: '', attrs: { src: '/logo.png', draggable: 'false', decoding: 'async' } })));
  }

  function actionRow(...kids) {
    return h('div', { class: 'signin-actions' }, ...kids);
  }

  function devRow() {
    if (!dev) return null;
    return h('div', { class: 'signin-dev' },
      h('span', { class: 'signin-dev-label', text: 'Test call' }),
      link && link.state === 'waiting' ? button(`Approve as ${meName || 'me'}`, { variant: 'ghost', size: 'sm', key: 'signin-dev-approve', on: devApprove }) : null,
      button('Skip (test call)', { variant: 'ghost', size: 'sm', key: 'signin-skip', on: skip }));
  }

  function codeView() {
    const callName = meName || 'you';
    const head = [
      crest(),
      h('h2', { class: 'signin-title', attrs: { id: 'signin-title' }, text: reason === 'join' ? 'Sign in to join the game' : 'Sign in to play' }),
      h('p', { class: 'signin-text', attrs: { id: 'signin-text' }, text: `This links your Yapin' account, ${callName}, to YapOS Party so your wins, Party XP, Shards and leaderboard spot count for you. You can still watch without signing in.` }),
    ];
    const l = link || { state: 'loading' };
    const code = l.code || '····-····';
    const expired = l.state === 'expired';
    const copyBtn = l.state === 'waiting' ? button('Copy', { variant: 'secondary', size: 'sm', key: 'signin-copy', on: copy, attrs: { 'aria-label': 'Copy the code' }, kids: h('span', { class: 'signin-copy-icon', attrs: { 'aria-hidden': 'true' } }) }) : null;
    if (copyBtn) copyBtn.classList.add('signin-copy');
    const codeBox = h('div', { class: ['signin-code-row', expired ? 'is-expired' : null, l.state === 'loading' ? 'is-loading' : null] },
      h('output', { class: 'signin-code', text: l.state === 'loading' || l.state === 'error' ? '····-····' : code, attrs: { 'aria-label': l.code ? `Your code: ${spellCode(l.code)}` : 'Getting your code' } }),
      copyBtn);
    const steps = h('ol', { class: 'signin-steps' },
      alone ? null : h('li', { class: 'signin-step' }, h('span', { class: 'signin-step-num', text: '1' }), h('span', { class: 'signin-step-text' }, h('span', { text: 'On any device, open ' }), h('strong', { class: 'signin-url', text: 'yapos.dev/link' }))),
      h('li', { class: 'signin-step' }, h('span', { class: 'signin-step-num', text: alone ? '1' : '2' }), h('span', { class: 'signin-step-text', text: alone ? 'Or open yapos.dev/link on another device and enter this code' : 'Enter this code and confirm' })));
    const expiry = l.state === 'waiting'
      ? h('div', { class: 'signin-expiry', attrs: { 'aria-hidden': 'true' } }, h('span', { class: 'signin-expiry-track' }, h('span', { class: 'signin-expiry-fill' })), h('span', { class: 'signin-expiry-text', text: `Code expires in ${clock(l.ends - now())}` }))
      : null;
    let statusText = 'Getting your code…';
    let tone = 'wait';
    if (l.state === 'waiting') statusText = 'Waiting for you to confirm on yapos.dev…';
    else if (l.state === 'expired') {
      statusText = 'That code expired. Get a new one to keep going.';
      tone = 'warn';
    } else if (l.state === 'error') {
      statusText = l.message;
      tone = 'warn';
    }
    const statusRow = h('p', { class: ['signin-status', `is-${tone}`], attrs: { role: 'status', 'aria-live': 'polite' } },
      tone === 'wait' ? h('span', { class: 'spinner signin-spinner', attrs: { 'aria-hidden': 'true' } }) : h('span', { class: 'signin-status-icon', text: '!', attrs: { 'aria-hidden': 'true' } }),
      h('span', { class: 'signin-status-text', text: statusText }));
    const needNew = l.state === 'expired' || l.state === 'error';
    const fresh = button('Get a new code', { variant: needNew ? 'primary' : 'ghost', size: needNew ? null : 'sm', key: 'signin-new', on: () => startLink() });
    fresh.classList.add('signin-new');
    if (needNew) fresh.classList.add('signin-primary');
    if (!needNew && l.state !== 'waiting') fresh.hidden = true;
    const watch = button('Just watch for now', { variant: 'ghost', key: 'signin-later', on: dismiss });
    watch.classList.add('signin-later');
    const login = alone
      ? h('a', { class: 'btn btn-primary btn-lg spot signin-login signin-primary', attrs: { href: LOGIN_HREF } }, h('span', { class: 'btn-label', text: "Log in with Yapin'" }))
      : null;
    return [...head, login, login ? h('p', { class: 'signin-or', text: 'Or use a code' }) : null, steps, codeBox, expiry, statusRow, actionRow(watch, fresh), devRow()];
  }

  function mismatchView() {
    const callName = meName || 'this call';
    const signedAs = firstName(user, 'someone else');
    const go = button(`Sign in as ${callName}`, { variant: 'primary', key: 'signin-switch', on: () => { view = 'code'; startLink(); focusStart(); } });
    go.classList.add('signin-primary');
    const watch = button('Just watch for now', { variant: 'ghost', key: 'signin-later', on: dismiss });
    watch.classList.add('signin-later');
    return [
      crest(),
      h('h2', { class: 'signin-title', attrs: { id: 'signin-title' }, text: 'Different account' }),
      h('p', { class: 'signin-text', attrs: { id: 'signin-text' } },
        h('span', { text: "You're signed in as " }), h('strong', { text: signedAs }), h('span', { text: ", but in this call you're " }), h('strong', { text: callName }), h('span', { text: '. Sign in again so your wins count for the right account.' })),
      actionRow(watch, go),
      devRow(),
    ];
  }

  function successView() {
    const who = firstName(user);
    return [
      h('div', { class: 'signin-done', attrs: { 'aria-hidden': 'true' } }, h('span', { class: 'signin-done-mark', text: '✓' })),
      h('h2', { class: 'signin-title', attrs: { id: 'signin-title' }, text: "You're in!" }),
      h('p', { class: 'signin-status is-done', attrs: { id: 'signin-text', role: 'status', 'aria-live': 'polite' } }, h('span', { class: 'signin-status-text', text: `Linked! Welcome, ${who}.` })),
    ];
  }

  function paint() {
    if (!isOpen || destroyed) return;
    const active = doc ? doc.activeElement : null;
    const key = active && card.contains(active) && active.dataset ? active.dataset.key : null;
    card.dataset.view = view;
    const kids = view === 'success' ? successView() : view === 'mismatch' ? mismatchView() : codeView();
    card.replaceChildren(...kids.filter(Boolean));
    if (key) {
      const again = card.querySelector(`[data-key="${key}"]`);
      if (again && !again.hidden) again.focus();
      else focusStart();
    } else if (!active || !card.contains(active)) {
      focusStart();
    }
    tick();
  }

  function require(action = 'join') {
    if (status === 'in' || status === 'skipped' || status === 'offline' || status === 'idle') return true;
    if (status === 'checking') {
      toast('Checking your account. Try again in a second.');
      return false;
    }
    dismissed = false;
    open(action);
    return false;
  }

  function needsLink() {
    return OPEN_STATES.has(status);
  }

  async function signOut() {
    const token = tokenFor(win, me);
    forgetToken(win, me);
    if (token) await api.logout(token);
    user = null;
    via = null;
    set('out');
  }

  function destroy() {
    destroyed = true;
    stopPoll();
    stopEvery(ticker);
    ticker = null;
    if (recheckTimer !== null) cancel(recheckTimer);
    if (successTimer !== null) cancel(successTimer);
    el.removeEventListener('keydown', onKey);
  }

  return {
    el,
    update,
    open,
    close,
    require,
    needsLink,
    signOut,
    destroy,
    check,
    get isOpen() {
      return isOpen;
    },
    state() {
      return { status, me, user, via, token: status === 'in' ? tokenFor(win, me) : null, code: link && link.code ? link.code : null, view };
    },
  };
}
