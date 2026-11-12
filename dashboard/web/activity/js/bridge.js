import { OpBudget, checkSet, checkSend, OPS_MAX, OPS_WINDOW_MS } from './limits.js';

export const HELLO_MS = 1000;
export const HELLO_TRIES = 15;

export const PARENT_ORIGINS = Object.freeze(['https://www.yapper.website', 'https://yapper.website', 'https://yapin.gg', 'https://www.yapin.gg']);

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function devMode(loc) {
  if (!loc || !LOCAL_HOSTS.has(loc.hostname)) return false;
  try {
    return new URLSearchParams(loc.search || '').get('dev') === '1';
  } catch {
    return false;
  }
}

export function isDevOrigin(origin) {
  try {
    const u = new URL(origin);
    return (u.protocol === 'http:' || u.protocol === 'https:') && LOCAL_HOSTS.has(u.hostname) && u.origin === origin;
  } catch {
    return false;
  }
}

export function originAllowed(origin, dev) {
  if (PARENT_ORIGINS.includes(origin)) return true;
  return Boolean(dev) && isDevOrigin(origin);
}

export function connect(opts = {}) {
  const root = opts.win || (typeof window !== 'undefined' ? window : null);
  const loc = root && root.location;
  const dev = opts.dev === undefined ? devMode(loc) : Boolean(opts.dev);
  const now = opts.now || Date.now;
  const budget = opts.budget || new OpBudget(OPS_MAX, OPS_WINDOW_MS);
  const handlers = {};
  let parentOrigin = null;

  const api = {
    ready: false,
    me: null,
    host: null,
    participants: [],
    state: {},
    instance: null,
    dev,
    budget,
    on(ev, fn) {
      (handlers[ev] = handlers[ev] || []).push(fn);
      if (ev === 'ready' && api.ready) fn(snapshot());
      return api;
    },
    off(ev, fn) {
      handlers[ev] = (handlers[ev] || []).filter((f) => f !== fn);
      return api;
    },
    set(key, value) {
      const val = value === undefined ? null : value;
      const problem = checkSet(api.state, key, val);
      if (problem) return refuse(problem, key);
      if (!linked()) return false;
      if (!spend()) return refuse('rate', key);
      return post({ type: 'set', key, val });
    },
    send(data) {
      const val = data === undefined ? null : data;
      const problem = checkSend(val);
      if (problem) return refuse(problem);
      if (!linked()) return false;
      if (!spend()) return refuse('rate');
      return post({ type: 'send', data: val });
    },
    close() {
      return post({ type: 'close' });
    },
    opsLeft() {
      return budget.available(now());
    },
  };

  function snapshot() {
    return { me: api.me, host: api.host, participants: api.participants, state: api.state, instance: api.instance };
  }

  function emit(ev, x) {
    for (const fn of (handlers[ev] || []).slice()) {
      try {
        fn(x);
      } catch (e) {
        setTimeout(() => {
          throw e;
        });
      }
    }
  }

  function refuse(reason, key) {
    emit('limit', { reason, key: key || null });
    return false;
  }

  function linked() {
    return Boolean(parentOrigin && root && root.parent);
  }

  function spend() {
    const t = now();
    if (budget.available(t) < 1) return false;
    budget.spend(t);
    return true;
  }

  function post(m) {
    if (!parentOrigin || !root || !root.parent) return false;
    m.yapper = 1;
    root.parent.postMessage(m, parentOrigin);
    return true;
  }

  function onMessage(e) {
    if (!root || e.source !== root.parent || !originAllowed(e.origin, dev)) return;
    const m = e.data;
    if (!m || typeof m !== 'object' || m.yapper !== 1 || typeof m.type !== 'string') return;
    if (!parentOrigin) parentOrigin = e.origin;
    if (e.origin !== parentOrigin) return;
    if (m.type === 'init') {
      api.me = m.me;
      api.host = m.host;
      api.participants = Array.isArray(m.participants) ? m.participants : [];
      api.state = m.state && typeof m.state === 'object' ? { ...m.state } : {};
      api.instance = m.instance === undefined ? null : m.instance;
      if (!api.ready) {
        api.ready = true;
        emit('ready', snapshot());
      } else {
        emit('init', snapshot());
      }
    } else if (m.type === 'participants') {
      api.host = m.host;
      api.participants = Array.isArray(m.participants) ? m.participants : [];
      emit('participants', { participants: api.participants, host: api.host });
    } else if (m.type === 'state') {
      if (typeof m.key !== 'string') return;
      if (m.val === null || m.val === undefined) delete api.state[m.key];
      else api.state[m.key] = m.val;
      emit('state', { key: m.key, value: m.val === undefined ? null : m.val, by: m.by });
    } else if (m.type === 'message') {
      emit('message', { data: m.data, by: m.by });
    }
  }

  function hello() {
    const targets = PARENT_ORIGINS.slice();
    if (dev && loc && loc.origin && !targets.includes(loc.origin)) targets.push(loc.origin);
    for (const o of targets) {
      try {
        root.parent.postMessage({ yapper: 1, type: 'ready' }, o);
      } catch {
        continue;
      }
    }
  }

  if (root && typeof root.addEventListener === 'function') root.addEventListener('message', onMessage);
  const later = opts.setTimeout || (root && typeof root.setTimeout === 'function' ? (fn, ms) => root.setTimeout(fn, ms) : null);
  let tries = 0;

  function retry() {
    if (api.ready || !later || tries >= HELLO_TRIES) return;
    tries += 1;
    later(() => {
      if (api.ready) return;
      hello();
      retry();
    }, HELLO_MS);
  }

  if (root && root.parent && root.parent !== root) {
    hello();
    retry();
  }
  api.hello = hello;
  return api;
}
