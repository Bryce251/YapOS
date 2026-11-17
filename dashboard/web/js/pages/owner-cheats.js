import { h, replace } from '../dom.js';
import { badge, button, card, confirmDialog, linkButton, setBusy, toast } from '../ui.js';
import { ApiError } from '../api.js';
import { relativeTime } from '../format.js';
import { ownerPath } from '../router.js';

export const OWNER_CHEATS_PATH = '/api/owner/cheats';
export const CHEAT_ACTS = Object.freeze({
  hide: { label: 'Hide from leaderboards', busy: 'Hiding', done: 'They are off the Party leaderboards.', confirm: 'Hide them from every Party leaderboard?', body: 'They can still play and their stats are kept. You can show them again from their page.' },
  reset: { label: 'Reset Party stats', busy: 'Resetting', done: 'Their Party leaderboard stats were reset.', confirm: 'Reset their Party leaderboard stats?', body: "This clears their all-time, per-game, monthly and today's Party points. Badges and counters are kept. It can't be undone." },
  dismiss: { label: 'Dismiss', busy: 'Dismissing', done: 'Alert dismissed.', confirm: '', body: '' },
  reopen: { label: 'Reopen', busy: 'Reopening', done: 'Alert reopened.', confirm: '', body: '' },
});
const STATUS_BADGES = Object.freeze({ open: ['Open', 'warning', 'alert'], dismissed: ['Dismissed', 'neutral', 'x'], actioned: ['Handled', 'success', 'check'] });
const SHOW = [['open', 'Open'], ['all', 'All']];

const str = (v) => (typeof v === 'string' ? v : '');

export function readAlert(a) {
  if (!a || typeof a !== 'object' || typeof a.id !== 'string' || typeof a.user !== 'string') return null;
  return {
    id: a.id,
    user: a.user,
    kind: str(a.kind),
    label: str(a.label) || str(a.kind),
    name: str(a.name),
    detail: str(a.detail),
    count: Math.max(1, Number(a.count) || 1),
    first: Number(a.first_at) || 0,
    last: Number(a.last_at) || 0,
    status: a.status === 'dismissed' || a.status === 'actioned' ? a.status : 'open',
  };
}

export function readAlerts(data) {
  const d = data && typeof data === 'object' ? data : {};
  const alerts = (Array.isArray(d.alerts) ? d.alerts : []).map(readAlert).filter(Boolean);
  return { alerts, open: Number(d.open) || 0 };
}

export function alertCountText(n) {
  return n === 1 ? '1 open' : `${n} open`;
}

export function cheatAlertsCard(ctx, { onChange } = {}) {
  const { api } = ctx;
  const countEl = h('span', { class: 'party-count' });
  const body = h('div', { class: 'owner-log-wrap' });
  const showBar = h('div', { class: 'segmented', attrs: { role: 'group', 'aria-label': 'Show cheat alerts' } });
  let showing = 'open';

  function drawShow() {
    replace(showBar, ...SHOW.map(([v, text]) => {
      const b = button({ label: text, size: 'sm', variant: showing === v ? 'segment-active' : 'segment', onClick: () => {
        if (showing === v) return;
        showing = v;
        drawShow();
        load();
      } });
      b.setAttribute('aria-pressed', showing === v ? 'true' : 'false');
      return b;
    }));
  }

  function row(a) {
    const sub = [a.name || 'Unknown player', `last ${relativeTime(a.last)}`];
    if (a.count > 1) sub.push(`${a.count} times`);
    const actions = h('span', { class: 'owner-links' },
      linkButton({ label: 'Open person', href: ownerPath(a.user), icon: 'chevron-right', size: 'sm' }),
      ...(a.status === 'open' ? ['hide', 'reset', 'dismiss'] : ['reopen']).map((act) => button({ label: CHEAT_ACTS[act].label, size: 'sm', variant: act === 'reset' ? 'danger' : 'secondary', onClick: (e) => act_(a, act, e.currentTarget) })));
    return h('li', { class: 'owner-log-row', dataset: { id: a.id } },
      h('span', { class: 'owner-log-main' },
        h('span', { class: 'owner-log-what', text: a.detail }),
        h('span', { class: 'owner-log-sub', text: `${a.label} · ${sub.join(' · ')}` }),
        actions),
      badge(...STATUS_BADGES[a.status]));
  }

  function show(data) {
    const view = readAlerts(data);
    countEl.textContent = alertCountText(view.open);
    replace(body, view.alerts.length
      ? h('ul', { class: 'owner-log' }, ...view.alerts.map(row))
      : showing === 'all'
      ? h('p', { class: 'owner-empty muted', text: 'No cheat alerts yet.' })
      : h('p', { class: 'owner-empty muted', text: 'No cheat alerts right now. Scores that keep hitting the daily or per-game caps, impossible win rates and farmed two-player games show up here.' }));
  }

  async function act_(a, act, btn) {
    const spec = CHEAT_ACTS[act];
    if (spec.confirm) {
      const ok = await confirmDialog({ title: spec.confirm, body: spec.body, confirmLabel: spec.label, tone: act === 'reset' ? 'danger' : 'primary' });
      if (!ok || ctx.signal?.aborted) return;
    }
    if (btn?.isConnected) setBusy(btn, true, spec.busy);
    try {
      const data = await api.post(`${OWNER_CHEATS_PATH}/${encodeURIComponent(a.id)}`, { do: act }, { signal: ctx.signal });
      if (ctx.signal?.aborted) return;
      toast(str(data?.result) || spec.done);
      await load();
      if (act !== 'dismiss' && typeof onChange === 'function') onChange();
    } catch (err) {
      if (ctx.signal?.aborted) return;
      if (btn?.isConnected) setBusy(btn, false);
      toast(err instanceof ApiError ? err.message : 'That did not work. Try again.', { tone: 'danger', title: "Couldn't do that" });
    }
  }

  async function load() {
    try {
      show(await api.get(showing === 'all' ? `${OWNER_CHEATS_PATH}?status=all` : OWNER_CHEATS_PATH, { signal: ctx.signal }));
    } catch (err) {
      if (ctx.signal?.aborted) return;
      replace(body, h('p', { class: 'field-error', attrs: { role: 'alert' }, text: err instanceof ApiError ? err.message : 'Could not load cheat alerts.' }));
    }
  }
  replace(body, h('p', { class: 'muted', text: 'Loading cheat alerts…' }));
  drawShow();
  load();

  return card({ title: 'Cheat alerts', icon: 'alert', actions: h('span', { class: 'cheat-tools' }, countEl, showBar) }, body);
}
