export const AUTH_KEY = 'yapos-party-auth';
export const MAX_SAVED = 4;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function storage(win) {
  try {
    return win && win.localStorage ? win.localStorage : null;
  } catch {
    return null;
  }
}

export function readTokens(win) {
  const store = storage(win);
  if (!store) return {};
  try {
    const raw = store.getItem(AUTH_KEY);
    const data = raw ? JSON.parse(raw) : null;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
    const out = {};
    for (const [id, token] of Object.entries(data)) {
      if (ID_RE.test(id) && typeof token === 'string' && TOKEN_RE.test(token)) out[id] = token;
    }
    return out;
  } catch {
    return {};
  }
}

function writeTokens(win, tokens) {
  const store = storage(win);
  if (!store) return false;
  try {
    const keep = Object.entries(tokens).slice(-MAX_SAVED);
    if (!keep.length) {
      store.removeItem(AUTH_KEY);
      return true;
    }
    store.setItem(AUTH_KEY, JSON.stringify(Object.fromEntries(keep)));
    return true;
  } catch {
    return false;
  }
}

export function tokenFor(win, id) {
  return id ? readTokens(win)[String(id)] || null : null;
}

export function saveToken(win, id, token) {
  if (!id || !ID_RE.test(String(id)) || !TOKEN_RE.test(String(token || ''))) return false;
  const tokens = readTokens(win);
  delete tokens[String(id)];
  tokens[String(id)] = token;
  return writeTokens(win, tokens);
}

export function forgetToken(win, id) {
  const tokens = readTokens(win);
  if (!(String(id) in tokens)) return false;
  delete tokens[String(id)];
  return writeTokens(win, tokens);
}

export function cleanUser(u) {
  if (!u || typeof u !== 'object' || typeof u.id !== 'string') return null;
  const username = typeof u.username === 'string' ? u.username.slice(0, 64) : '';
  const display = typeof u.display_name === 'string' && u.display_name ? u.display_name.slice(0, 64) : username;
  const avatar = typeof u.avatar_url === 'string' && /^https:\/\//.test(u.avatar_url) ? u.avatar_url : null;
  return { id: u.id, username, display_name: display || 'you', avatar_url: avatar };
}

export function createAccountApi({ win, fetchImpl } = {}) {
  const doFetch = fetchImpl || (win && typeof win.fetch === 'function' ? (...a) => win.fetch(...a) : null);

  async function call(path, { method = 'GET', token = null, body } = {}) {
    if (!doFetch) return { ok: false, status: 0, data: null };
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const init = { method, headers, credentials: 'same-origin', cache: 'no-store' };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await doFetch(path, init);
    } catch {
      return { ok: false, status: 0, data: null };
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    return { ok: Boolean(res.ok), status: Number(res.status) || 0, data };
  }

  return {
    async me(token) {
      const r = await call('/api/activity/me', { token });
      const user = r.ok && r.data ? cleanUser(r.data.user) : null;
      return { ok: Boolean(user), status: r.status, user, via: r.data && r.data.via === 'code' ? 'code' : 'dashboard' };
    },
    async start(expect) {
      const r = await call('/api/activity/link/start', { method: 'POST', body: expect ? { expect: String(expect) } : {} });
      const d = r.data;
      if (!r.ok || !d || typeof d.code !== 'string' || !TOKEN_RE.test(String(d.token || ''))) return { ok: false, status: r.status, message: d && typeof d.message === 'string' ? d.message : '' };
      return { ok: true, code: d.code.slice(0, 16), token: d.token, expires: Number(d.expires) || 0, ttl: Number(d.ttl) || 600000, interval: Number(d.interval) || 2500 };
    },
    async poll(token) {
      const r = await call('/api/activity/link/poll', { method: 'POST', body: { token } });
      const d = r.data || {};
      if (!r.ok) return { status: 'error', code: r.status };
      if (d.status === 'approved' && TOKEN_RE.test(String(d.token || ''))) return { status: 'approved', token: d.token, user: cleanUser(d.user) };
      if (d.status === 'pending') return { status: 'pending' };
      return { status: 'expired' };
    },
    async logout(token) {
      if (!token) return false;
      const r = await call('/api/activity/logout', { method: 'POST', token });
      return r.ok;
    },
    async devApprove(code, id) {
      const r = await call('/dev/link/approve', { method: 'POST', body: { code, id } });
      return r.ok;
    },
  };
}
