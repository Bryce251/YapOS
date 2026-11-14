import { HttpError, fail, isLocalHttp, publicOrigin } from './util.js';
import { withSecurityHeaders, isActivityPath } from './security.js';
import { login, callback, logout } from './auth.js';
import { handleApi } from './api.js';
import { handleBot } from './bot.js';
import { cleanup } from './cron.js';

const SPA_RE = /^\/(servers(\/.*)?|party|p\/.+)$/;

async function spa(request, env, url) {
  if (!env.ASSETS || typeof env.ASSETS.fetch !== 'function') {
    return fail(503, 'not_configured', 'The website files are missing.');
  }
  const res = await env.ASSETS.fetch(new Request(new URL('/', url).href, { method: 'GET', headers: { Accept: 'text/html' } }));
  if (!res.ok) return fail(503, 'not_configured', 'The website files are missing.');
  const out = new Response(request.method === 'HEAD' ? null : res.body, { status: 200, headers: res.headers });
  out.headers.set('Cache-Control', 'no-cache');
  return out;
}

const ACTIVITY_MISSING = () => new Response('Page not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });

async function activity(request, env, url) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
  }
  if (url.pathname === '/activity') {
    return new Response(null, { status: 308, headers: { Location: `/activity/${url.search}`, 'Cache-Control': 'no-store' } });
  }
  if (!env.ASSETS || typeof env.ASSETS.fetch !== 'function') {
    return fail(503, 'not_configured', 'The website files are missing.');
  }
  const res = await env.ASSETS.fetch(request);
  if (res.status === 404) return ACTIVITY_MISSING();
  return res;
}

async function route(request, env, deps) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (!env.DB && (path.startsWith('/api/') || path.startsWith('/auth/') || path.startsWith('/bot/'))) {
    return fail(503, 'not_configured', 'The dashboard database is not set up yet.');
  }
  if (isActivityPath(path)) return activity(request, env, url);
  if (path === '/api' || path.startsWith('/api/')) return handleApi(request, env, deps, url);
  if (path === '/bot' || path.startsWith('/bot/')) return handleBot(request, env, deps, url);
  if (path === '/auth/login') {
    if (request.method !== 'GET') return fail(405, 'method_not_allowed', 'That action is not allowed here.');
    return login(request, env, deps);
  }
  if (path === '/auth/callback') {
    if (request.method !== 'GET') return fail(405, 'method_not_allowed', 'That action is not allowed here.');
    return callback(request, env, deps);
  }
  if (path === '/auth/logout') {
    if (request.method !== 'POST') return fail(405, 'method_not_allowed', 'That action is not allowed here.');
    const origin = request.headers.get('Origin');
    if (!origin || origin !== publicOrigin(env)) {
      return fail(403, 'forbidden', 'This request was blocked for your safety. Reload the page and try again.');
    }
    return logout(request, env);
  }
  if (path.startsWith('/auth/')) return fail(404, 'not_found', "That page of the dashboard doesn't exist.");
  if ((request.method === 'GET' || request.method === 'HEAD') && SPA_RE.test(path)) return spa(request, env, url);
  return new Response('Page not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
}

function describe(err) {
  return err && err.name ? String(err.name) : 'Error';
}

export function createWorker(options = {}) {
  const deps = {
    fetch: options.fetch || ((...args) => fetch(...args)),
    now: options.now || (() => Date.now()),
    log: options.log || ((...args) => console.error(...args)),
  };
  return {
    async fetch(request, env, ctx) {
      const secure = !isLocalHttp(env);
      let response;
      let pathname = '';
      try {
        pathname = new URL(request.url).pathname;
        response = await route(request, env, deps);
      } catch (err) {
        if (err instanceof HttpError) {
          response = fail(err.status, err.code, err.message, err.extra);
        } else {
          deps.log(`yapos-dashboard: request failed (${describe(err)})`);
          response = fail(500, 'server_error', 'Something went wrong on our side. Try again in a moment.');
        }
      }
      return withSecurityHeaders(response, secure, pathname);
    },
    async scheduled(event, env, ctx) {
      const work = cleanup(env.DB, deps.now()).catch((err) => {
        deps.log(`yapos-dashboard: cleanup failed (${describe(err)})`);
      });
      if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(work);
      return work;
    },
  };
}
