const TIMEOUT_MS = 15_000;

function cleanBase(url) {
  if (!url || typeof url !== 'string') return null;
  let u;
  try { u = new URL(url.trim()); } catch { return null; }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return null;
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

export function workerClient(engine, { fetch: fetchImpl = null } = {}) {
  const read = () => {
    const base = cleanBase(engine?.config?.dashboardUrl);
    const key = typeof engine?.config?.dashboardSecret === 'string' ? engine.config.dashboardSecret.trim() : '';
    const fn = fetchImpl || globalThis.fetch;
    return { base, key, fn };
  };
  return {
    get enabled() {
      const { base, key, fn } = read();
      return !!(base && key && typeof fn === 'function');
    },
    async request(method, path, body) {
      const { base, key, fn } = read();
      if (!base || !key || typeof fn !== 'function') return { ok: false, status: 0, data: null, off: true };
      const headers = { authorization: `Bearer ${key}`, accept: 'application/json' };
      if (body !== undefined) headers['content-type'] = 'application/json';
      const res = await fn(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
      let data = null;
      try {
        const text = await res.text();
        data = text ? JSON.parse(text) : null;
      } catch { data = null; }
      return { ok: !!res.ok, status: res.status, data };
    },
    async post(path, body) {
      try {
        return await this.request('POST', path, body);
      } catch (e) {
        return { ok: false, status: 0, data: null, error: e };
      }
    },
  };
}
