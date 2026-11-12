const ID = '([A-Za-z0-9_-]{1,64})';
const SLUG = '([A-Za-z0-9-]{1,64})';
const APP = '([a-z0-9_-]{1,32})';

export const ROUTES = [
  { name: 'landing', pattern: new RegExp('^/$'), keys: [], private: false },
  { name: 'servers', pattern: new RegExp('^/servers$'), keys: [], private: true },
  { name: 'overview', pattern: new RegExp(`^/servers/${ID}$`), keys: ['sid'], private: true },
  { name: 'apps', pattern: new RegExp(`^/servers/${ID}/apps$`), keys: ['sid'], private: true },
  { name: 'app', pattern: new RegExp(`^/servers/${ID}/apps/${APP}$`), keys: ['sid', 'app'], private: true },
  { name: 'cases', pattern: new RegExp(`^/servers/${ID}/cases$`), keys: ['sid'], private: true },
  { name: 'public-settings', pattern: new RegExp(`^/servers/${ID}/public$`), keys: ['sid'], private: true },
  { name: 'public', pattern: new RegExp(`^/p/${SLUG}$`), keys: ['slug'], private: false },
];

export function normalizePath(pathname) {
  let p = String(pathname || '/');
  if (!p.startsWith('/')) p = `/${p}`;
  p = p.replace(/\/{2,}/g, '/');
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

function decode(part) {
  try {
    return decodeURIComponent(part);
  } catch {
    return null;
  }
}

export function matchRoute(pathname) {
  const path = normalizePath(pathname);
  for (const route of ROUTES) {
    const m = route.pattern.exec(path);
    if (!m) continue;
    const params = {};
    let ok = true;
    route.keys.forEach((key, i) => {
      const v = decode(m[i + 1]);
      if (v === null) ok = false;
      params[key] = v;
    });
    if (!ok) break;
    if (route.name === 'public') params.slug = params.slug.toLowerCase();
    return { name: route.name, params, private: route.private, path };
  }
  return { name: 'not-found', params: {}, private: false, path };
}

export function safeNext(next, fallback = '/servers') {
  if (typeof next !== 'string' || !next) return fallback;
  if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return fallback;
  if (/[\u0000-\u001f\u007f]/.test(next)) return fallback;
  if (next.length > 512) return fallback;
  return next;
}

export function loginUrl(next) {
  return `/auth/login?next=${encodeURIComponent(safeNext(next))}`;
}

export function serverPath(sid, sub = '') {
  const base = `/servers/${encodeURIComponent(sid)}`;
  return sub ? `${base}/${sub.split('/').map(encodeURIComponent).join('/')}` : base;
}

export function publicPath(slug) {
  return `/p/${encodeURIComponent(slug)}`;
}

export function isInternalHref(href, origin) {
  if (typeof href !== 'string' || !href) return false;
  try {
    const url = new URL(href, origin);
    if (url.origin !== origin) return false;
    if (url.pathname.startsWith('/auth/') || url.pathname.startsWith('/api/')) return false;
    return true;
  } catch {
    return false;
  }
}

export function sectionFor(routeName) {
  if (routeName === 'app') return 'apps';
  return routeName;
}
