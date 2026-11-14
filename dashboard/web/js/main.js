import { h } from './dom.js';
import { createApi, isAbort } from './api.js';
import { isInternalHref, loginUrl, matchRoute } from './router.js';
import { forgetAll, state } from './state.js';
import { initTheme, themeToggle } from './theme.js';
import { createShell, brand } from './shell.js';
import { confirmDialog, emptyState, errorState, linkButton, loadingRegion, skeleton, skeletonBlock } from './ui.js';
import { renderLanding } from './pages/landing.js';
import { renderServers } from './pages/servers.js';
import { renderOverview } from './pages/overview.js';
import { renderApps } from './pages/apps.js';
import { renderAppSettings } from './pages/app-settings.js';
import { renderCases } from './pages/cases.js';
import { renderMembers } from './pages/members.js';
import { renderMod } from './pages/mod.js';
import { renderTickets } from './pages/tickets.js';
import { renderPublicSettings } from './pages/public-settings.js';
import { renderPublic } from './pages/public.js';
import { renderParty } from './pages/party.js';
import { spotlight } from './spotlight.js';

const root = document.getElementById('app');
let shell = null;
let controller = null;
let leaveGuard = null;
let redirecting = false;
let currentUrl = `${window.location.pathname}${window.location.search}`;
let firstRender = true;

const TITLES = {
  landing: '',
  servers: 'Servers',
  party: 'Party admins',
  overview: 'Overview',
  apps: 'Apps',
  app: 'App settings',
  members: 'Members',
  mod: 'Moderation',
  tickets: 'Tickets',
  cases: 'Cases',
  'public-settings': 'Public page',
  public: 'Leaderboard',
  'not-found': 'Page not found',
};

const PAGES = {
  servers: renderServers,
  party: renderParty,
  overview: renderOverview,
  apps: renderApps,
  app: renderAppSettings,
  members: renderMembers,
  mod: renderMod,
  tickets: renderTickets,
  cases: renderCases,
  'public-settings': renderPublicSettings,
};

function onUnauthorized() {
  forgetAll();
  state.userChecked = true;
  const route = matchRoute(window.location.pathname);
  if (route.private && !redirecting) {
    redirecting = true;
    window.location.assign(loginUrl(`${window.location.pathname}${window.location.search}`));
  }
}

const api = createApi({ onUnauthorized });

function setTitle(text) {
  document.title = text ? `${text} · YapOS` : 'YapOS Dashboard';
}

async function ensureUser(signal) {
  if (state.userChecked) return state.user;
  try {
    const data = await api.get('/api/me', { signal, allow401: true });
    state.user = data?.user || null;
    state.partyOwner = Boolean(state.user) && data?.partyOwner === true;
  } catch (err) {
    if (err?.status === 401) {
      state.user = null;
      state.partyOwner = false;
    }
    else throw err;
  }
  state.userChecked = true;
  return state.user;
}

async function logout() {
  try {
    await api.post('/auth/logout', {}, { allow401: true });
  } catch {
    forgetAll();
  }
  forgetAll();
  state.userChecked = false;
  window.location.assign('/');
}

function shellSkeleton() {
  return loadingRegion('Loading', h('div', { class: 'page' },
    h('div', { class: 'page-header' }, h('div', { class: 'page-heading' }, skeleton('skeleton-title skeleton-w-30'), skeleton('skeleton-text skeleton-w-50'))),
    skeletonBlock(4)));
}

function bootSkeleton() {
  return h('div', { class: 'boot' }, h('div', { class: 'boot-inner' }, brand({ href: '/' }), h('span', { class: 'spinner', attrs: { 'aria-hidden': 'true' } }), h('span', { class: 'sr-only', attrs: { role: 'status' }, text: 'Loading' })));
}

function notFound() {
  root.replaceChildren(h('div', { class: 'site' },
    h('header', { class: 'site-header' }, h('div', { class: 'site-header-inner' }, brand({ href: '/' }), h('div', { class: 'site-header-actions' }, themeToggle()))),
    h('main', { class: 'site-main site-main-center', id: 'main', tabIndex: -1 },
      emptyState({ icon: 'eye-off', title: 'Page not found', body: "That address doesn't lead anywhere. Check the link or head back home.", action: linkButton({ label: 'Back to home', href: '/' }) }))));
  shell = null;
}

async function render() {
  controller?.abort();
  controller = new AbortController();
  const signal = controller.signal;
  leaveGuard = null;
  const route = matchRoute(window.location.pathname);
  currentUrl = `${window.location.pathname}${window.location.search}`;
  setTitle(TITLES[route.name] ?? '');
  const wasFirst = firstRender;
  firstRender = false;

  if (route.name === 'landing') {
    shell = null;
    renderLanding(root, { user: state.user, search: window.location.search });
    if (!state.userChecked) {
      ensureUser(signal).then((user) => {
        if (user && !signal.aborted) renderLanding(root, { user, search: window.location.search });
      }).catch(() => {});
    }
    return;
  }
  if (route.name === 'public') {
    shell = null;
    renderPublic(root, { api, params: route.params, signal, setTitle });
    return;
  }
  if (route.name === 'not-found') {
    notFound();
    return;
  }

  if (!state.userChecked) {
    if (!shell) root.replaceChildren(bootSkeleton());
    else shell.main.replaceChildren(shellSkeleton());
    try {
      await ensureUser(signal);
    } catch (err) {
      if (isAbort(err) || signal.aborted) return;
      root.replaceChildren(h('div', { class: 'site site-main-center' }, errorState({ title: "Can't reach the dashboard", body: err.message, onRetry: render })));
      shell = null;
      return;
    }
    if (signal.aborted) return;
  }
  if (!state.user) {
    if (!redirecting) {
      redirecting = true;
      window.location.assign(loginUrl(currentUrl));
    }
    return;
  }

  if (!shell || !shell.root.isConnected) {
    shell = createShell({ onLogout: logout });
    root.replaceChildren(shell.root);
  }
  shell.close();
  const ctx = {
    api,
    params: route.params,
    route,
    signal,
    main: shell.main,
    navigate,
    setTitle,
    setChrome: (chrome) => shell.update({ ...chrome, user: state.user, partyOwner: state.partyOwner }),
    setLeaveGuard: (guard) => {
      leaveGuard = guard;
    },
  };
  try {
    PAGES[route.name](ctx);
  } catch (err) {
    shell.main.replaceChildren(errorState({ title: 'Something went wrong', body: 'This page failed to load. Please try again.', onRetry: render }));
    throw err;
  }
  if (!wasFirst) shell.main.focus({ preventScroll: true });
}

async function canLeave() {
  if (!leaveGuard || !leaveGuard.isDirty()) return true;
  return confirmDialog({ title: 'Discard unsaved changes?', body: 'You changed some settings but did not save them. If you leave now, those changes are lost.', confirmLabel: 'Discard changes' });
}

export async function navigate(href, { replace = false } = {}) {
  const url = new URL(href, window.location.origin);
  const next = `${url.pathname}${url.search}`;
  if (next === currentUrl && !url.hash) return;
  if (!(await canLeave())) return;
  if (replace) window.history.replaceState({}, '', next + url.hash);
  else window.history.pushState({}, '', next + url.hash);
  window.scrollTo(0, 0);
  render();
}

document.addEventListener('click', (e) => {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = e.target.closest?.('a');
  if (!a || a.target || a.hasAttribute('download')) return;
  const raw = a.getAttribute('href') || '';
  if (!raw || raw.startsWith('#')) return;
  if (!isInternalHref(a.href, window.location.origin)) return;
  e.preventDefault();
  navigate(a.href);
});

window.addEventListener('popstate', async () => {
  const target = `${window.location.pathname}${window.location.search}`;
  if (target === currentUrl) return;
  if (leaveGuard && leaveGuard.isDirty()) {
    const back = currentUrl;
    window.history.pushState({}, '', back);
    if (!(await canLeave())) return;
    window.history.replaceState({}, '', target);
  }
  render();
});

window.addEventListener('beforeunload', (e) => {
  if (leaveGuard && leaveGuard.isDirty()) {
    e.preventDefault();
    e.returnValue = '';
  }
});

initTheme();
spotlight(root);
render();
