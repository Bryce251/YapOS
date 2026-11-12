import { h, replace } from '../dom.js';
import { icon } from '../icons.js';
import { appGlyph, badge, button, emptyState, loadingRegion, pageHeader, skeleton, switchControl, toast } from '../ui.js';
import { loadServer, mountAsync } from './common.js';
import { serverChrome } from './overview.js';
import { serverPath } from '../router.js';
import { mergeSnapshot } from '../state.js';
import { readChangeResult } from '../forms.js';
import { ApiError, OFFLINE_MESSAGE, SLOW_AFTER_MS, isAbort } from '../api.js';

function appsSkeleton() {
  return loadingRegion('Loading apps', h('ul', { class: 'app-grid' }, ...Array.from({ length: 9 }, () => h('li', { class: 'app-tile is-skeleton' },
    h('div', { class: 'app-tile-top' }, skeleton('skeleton-glyph'), skeleton('skeleton-switch')),
    skeleton('skeleton-text skeleton-w-40'),
    skeleton('skeleton-text skeleton-w-90'),
    skeleton('skeleton-text skeleton-w-60')))));
}

export async function changeApp(ctx, appId, body, { onPending, signal } = {}) {
  const { data } = await ctx.api.run('PATCH', `/api/servers/${encodeURIComponent(ctx.params.sid)}/apps/${encodeURIComponent(appId)}`, body, { signal, onPending });
  const res = readChangeResult(data);
  if (res.snapshot) mergeSnapshot(ctx.params.sid, res.snapshot);
  return res;
}

function appTile(ctx, app, view) {
  const status = h('p', { class: 'app-tile-status', attrs: { 'aria-live': 'polite' } });
  const name = app.name || app.id;
  const wait = view.pending.get(app.id);
  view.statusEls.set(app.id, status);
  const sw = switchControl({
    checked: wait ? wait.target : Boolean(app.enabled),
    label: `${name} installed`,
    disabled: wait ? true : app.canDisable === false && app.enabled,
    onChange: async (next, control) => {
      if (view.pending.has(app.id)) {
        control.set(!next);
        return;
      }
      const entry = { target: next, message: '' };
      view.pending.set(app.id, entry);
      control.setDisabled(true);
      control.setBusy(true);
      tile.classList.toggle('is-on', next);
      const say = (text) => {
        entry.message = text;
        const el = view.statusEls.get(app.id);
        if (el) el.textContent = text;
      };
      let slowTimer = null;
      try {
        const res = await changeApp(ctx, app.id, { enabled: next }, {
          signal: ctx.signal,
          onPending: () => {
            say('Waiting for YapOS…');
            slowTimer = setTimeout(() => say("YapOS hasn't answered yet. It may be offline or restarting."), SLOW_AFTER_MS);
          },
        });
        const err = res.errors.enabled || res.message || Object.values(res.errors)[0];
        if (err) throw new ApiError(String(err), { code: 'rejected' });
        app.enabled = next;
        toast(`${name} ${next ? 'installed' : 'uninstalled'}.`, { title: next ? 'App on' : 'App off' });
      } catch (e) {
        if (isAbort(e)) return;
        toast(e.message || OFFLINE_MESSAGE, { tone: 'danger', title: `Couldn't change ${name}`, timeout: 7000 });
      } finally {
        clearTimeout(slowTimer);
        view.pending.delete(app.id);
        if (!ctx.signal?.aborted) view.settled(app.id);
      }
    },
  });
  if (wait) {
    sw.setBusy(true);
    status.textContent = wait.message;
  }
  view.switchEls.set(app.id, sw.el);
  const settingsCount = Number(app.settingsCount) || 0;
  const footer = h('div', { class: 'app-tile-footer' },
    app.canDisable === false ? badge('Always on', 'neutral', 'lock') : h('span', { class: 'app-tile-category', text: app.category || 'App' }),
    settingsCount > 0
      ? h('a', { href: serverPath(ctx.params.sid, `apps/${app.id}`), class: 'link-subtle', dataset: { link: '' }, attrs: { 'aria-label': `${name} settings` } }, 'Settings', icon('chevron-right', { size: 14 }))
      : h('span', { class: 'app-tile-muted', text: 'No settings' }));
  const tile = h('li', { class: ['app-tile', (wait ? wait.target : app.enabled) ? 'is-on' : ''] },
    h('div', { class: 'app-tile-top' }, appGlyph(app), sw.el),
    h('h3', { class: 'app-tile-name', text: name }),
    h('p', { class: 'app-tile-desc', text: app.description || '' }),
    status,
    footer);
  return tile;
}

export function renderApps(ctx) {
  const { main } = ctx;
  serverChrome(ctx, 'apps', 'Apps');
  const search = h('input', { type: 'search', class: 'input', placeholder: 'Search apps', attrs: { 'aria-label': 'Search apps' } });
  const filter = h('div', { class: 'segmented', attrs: { role: 'group', 'aria-label': 'Show apps' } });
  const body = h('div', { class: 'page-body' });
  main.replaceChildren(h('div', { class: 'page' },
    pageHeader({ title: 'Apps', description: 'Install the apps you want. Each one can be turned on or off without losing its settings.' }),
    h('div', { class: 'toolbar toolbar-wrap' }, h('div', { class: 'input-shell has-lead toolbar-search' }, icon('search', { size: 14, className: 'input-lead' }), search), filter),
    body));
  let mode = 'all';
  let apps = [];
  const grid = h('div');
  const view = {
    pending: new Map(),
    statusEls: new Map(),
    switchEls: new Map(),
    settled(id) {
      const old = view.switchEls.get(id);
      const refocus = Boolean(old) && document.activeElement === old;
      if (apps.length && grid.isConnected) draw();
      if (refocus) view.switchEls.get(id)?.focus();
    },
  };
  function draw() {
    view.statusEls.clear();
    view.switchEls.clear();
    const q = search.value.trim().toLowerCase();
    const list = apps.filter((a) => (mode === 'on' ? a.enabled : mode === 'off' ? !a.enabled : true))
      .filter((a) => !q || `${a.name} ${a.id} ${a.description} ${a.category}`.toLowerCase().includes(q));
    if (!list.length) {
      replace(grid, emptyState({ icon: 'search', title: 'No apps match', body: 'Try a different search or filter.', compact: true }));
      return;
    }
    const groups = new Map();
    for (const a of list) {
      const cat = a.category || 'Other';
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat).push(a);
    }
    replace(grid, ...Array.from(groups, ([cat, items]) => h('section', { class: 'app-group' },
      h('h2', { class: 'section-title', text: cat }),
      h('ul', { class: 'app-grid' }, ...items.map((a) => appTile(ctx, a, view))))));
  }
  function drawFilter() {
    replace(filter, ...[['all', 'All'], ['on', 'Installed'], ['off', 'Not installed']].map(([v, label]) => {
      const b = button({ label, size: 'sm', variant: mode === v ? 'segment-active' : 'segment', onClick: () => {
        mode = v;
        drawFilter();
        draw();
      } });
      b.setAttribute('aria-pressed', mode === v ? 'true' : 'false');
      return b;
    }));
  }
  drawFilter();
  search.addEventListener('input', draw);
  mountAsync(body, {
    signal: ctx.signal,
    skeleton: appsSkeleton,
    load: ({ onPending, signal }) => loadServer(ctx, { onPending, signal }),
    render: (detail) => {
      serverChrome(ctx, 'apps', 'Apps');
      apps = detail.apps.filter((a) => a && a.id !== undefined && a.id !== null);
      if (!apps.length) {
        body.replaceChildren(emptyState({ icon: 'apps', title: 'No apps reported', body: 'YapOS has not shared its app list yet. Refresh in a moment.' }));
        return;
      }
      body.replaceChildren(grid);
      draw();
    },
  });
}
