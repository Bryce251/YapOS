import { h, replace } from '../dom.js';
import { icon } from '../icons.js';
import { avatar, badge, button, card, confirmDialog, emptyState, linkButton, loadingRegion, pageHeader, setBusy, skeleton, skeletonBlock, statCardSkeleton, toast } from '../ui.js';
import { loadServer, mountAsync } from './common.js';
import { serverChrome } from './overview.js';
import { openMemberDrawer } from './member.js';
import { serverPath } from '../router.js';
import { caseTone, formatNumber, relativeTime, truncate } from '../format.js';
import { normalizeCase } from '../cases.js';
import { isAbort } from '../api.js';
import { DURATION_PRESETS, MOD_ACTIONS, barChart, buildActionBody, confirmCopy, durationPicker, fillDays, heroStat, latestSearch, normalizeMember, SEARCH_MIN, readJob, readPage, sendAction, serverApi, statusLine, typeBreakdown, withQuery } from '../kit.js';

const QUICK = ['warn', 'timeout', 'kick', 'ban'];
const BAN_PRESETS = [
  { value: '1d', label: '1 day' },
  { value: '1w', label: '1 week' },
  { value: '30d', label: '30 days' },
];

export function modStats(overview) {
  const stats = overview?.stats && typeof overview.stats === 'object' ? overview.stats : null;
  if (!stats) return null;
  const byType = stats.casesByType && typeof stats.casesByType === 'object' ? stats.casesByType : {};
  const cases30 = Object.values(byType).reduce((sum, n) => sum + (Number(n) || 0), 0);
  return {
    cases30,
    activeWarns: Number(stats.activeWarns) || 0,
    activeTimeouts: stats.activeTimeouts === null || stats.activeTimeouts === undefined ? null : Number(stats.activeTimeouts) || 0,
    tempBans: Number(stats.tempBans) || 0,
    days: fillDays(stats.casesByDay, 14),
    types: typeBreakdown(byType),
  };
}

function modSkeleton() {
  return loadingRegion('Loading moderation',
    h('div', { class: 'stat-grid' }, ...Array.from({ length: 4 }, statCardSkeleton)),
    h('div', { class: 'mod-grid' },
      h('section', { class: 'card' }, h('div', { class: 'card-header' }, skeleton('skeleton-text skeleton-w-30')), h('div', { class: 'card-body' }, skeletonBlock(5))),
      h('section', { class: 'card' }, h('div', { class: 'card-header' }, skeleton('skeleton-text skeleton-w-40')), h('div', { class: 'card-body' }, skeletonBlock(4)))));
}

function chartCard(stats) {
  const total = stats.days.reduce((s, d) => s + d.count, 0);
  return card({ title: 'Cases, last 14 days', icon: 'activity', className: 'chart-card' },
    h('p', { class: 'chart-total' }, h('strong', { text: formatNumber(total) }), h('span', { class: 'muted', text: total === 1 ? ' case' : ' cases' })),
    barChart(stats.days));
}

function typesCard(stats) {
  if (!stats.types.length) {
    return card({ title: 'By type, last 30 days', icon: 'sliders' }, h('p', { class: 'muted', text: 'No cases in the last 30 days.' }));
  }
  return card({ title: 'By type, last 30 days', icon: 'sliders' },
    h('ul', { class: 'type-bars' }, ...stats.types.map((t) => h('li', { class: 'type-bar' },
      h('span', { class: 'type-bar-head' }, badge(t.label, t.tone), h('span', { class: 'type-bar-count', text: `${formatNumber(t.count)} · ${t.share}%` })),
      h('span', { class: 'type-bar-track' }, h('span', { class: ['type-bar-fill', `tone-${t.tone}`], style: { '--w': `${Math.max(2, t.share)}%` } }))))));
}

function recentCard(ctx, recent) {
  const list = Array.isArray(recent) ? recent.slice(0, 10).map(normalizeCase) : [];
  const viewAll = h('a', { href: serverPath(ctx.params.sid, 'cases'), class: 'link-subtle', dataset: { link: '' } }, 'All cases', icon('arrow-right', { size: 14 }));
  if (!list.length) {
    return card({ title: 'Recent cases', icon: 'shield', actions: viewAll }, emptyState({ icon: 'shield', title: 'No cases yet', body: 'Warnings, timeouts, kicks and bans will show up here.', compact: true }));
  }
  return card({ title: 'Recent cases', icon: 'shield', actions: viewAll, bodyClass: 'card-body-flush' },
    h('ul', { class: 'activity-list' }, ...list.map((c) => {
      const who = c.user.id
        ? h('button', { type: 'button', class: 'person-btn', attrs: { 'aria-label': `Open ${c.user.name}'s record` }, on: { click: () => openMemberDrawer(ctx, c.user) } }, h('span', { class: 'activity-strong', text: c.user.name }))
        : h('span', { class: 'activity-strong', text: c.user.name });
      return h('li', { class: 'activity-item' },
        avatar({ name: c.user.name, id: c.user.id, size: 'sm' }),
        h('div', { class: 'activity-text' },
          h('div', { class: 'activity-line' }, who, badge(c.typeLabel, caseTone(c.type)), h('span', { class: 'activity-case', text: `#${c.n}` })),
          h('div', { class: 'activity-meta', text: [c.reason ? truncate(c.reason, 90) : 'No reason given', c.mod.name && c.mod.name !== 'Unknown' ? `by ${c.mod.name}` : ''].filter(Boolean).join(' · ') })),
        h('time', { class: 'activity-time', text: relativeTime(c.at), attrs: { datetime: c.at ? new Date(c.at).toISOString() : null } }));
    })));
}

export function quickAction(ctx, { onDone } = {}) {
  const sid = ctx.params.sid;
  const view = { member: null, action: 'warn', busy: false, results: [], searching: false, token: 0 };
  const status = statusLine();
  const search = h('input', { type: 'search', class: 'input', placeholder: 'Search a member by name, username or ID', maxLength: 100, autocomplete: 'off', attrs: { 'aria-label': 'Find a member' } });
  const results = h('ul', { class: 'quick-results', attrs: { 'aria-label': 'Matching members' } });
  const picked = h('div', { class: 'quick-picked' });
  const actionRow = h('div', { class: 'segmented quick-actions', attrs: { role: 'group', 'aria-label': 'Action' } });
  const durationSlot = h('div');
  const reason = h('textarea', { class: 'input textarea', rows: 2, maxLength: 500, placeholder: 'Reason (optional, shown in the case and mod log)', attrs: { 'aria-label': 'Reason' } });
  const submit = button({ label: 'Warn', variant: 'primary', icon: 'alert' });
  let duration = null;

  function drawActions() {
    replace(actionRow, ...QUICK.map((id) => {
      const on = view.action === id;
      const b = h('button', { type: 'button', class: ['btn', 'btn-sm', on ? 'btn-segment-active' : 'btn-segment'], attrs: { 'aria-pressed': on ? 'true' : 'false' }, dataset: { action: id } }, h('span', { class: 'btn-label', text: MOD_ACTIONS[id].label }));
      b.addEventListener('click', () => {
        view.action = id;
        drawActions();
        drawDuration();
        drawSubmit();
      });
      return b;
    }));
  }

  function drawDuration() {
    duration = null;
    if (view.action === 'timeout') duration = durationPicker({ presets: DURATION_PRESETS, value: '1h', label: 'Timeout length' });
    if (view.action === 'ban') duration = durationPicker({ presets: BAN_PRESETS, value: '', allowNone: true, noneLabel: 'Permanent', label: 'Ban length' });
    replace(durationSlot, duration ? h('div', { class: 'mod-field' }, h('span', { class: 'mod-field-label', text: view.action === 'ban' ? 'How long' : 'Length' }), duration.el) : null);
  }

  function drawSubmit() {
    const meta = MOD_ACTIONS[view.action];
    const label = view.member ? `${meta.label} ${view.member.name}` : meta.label;
    const lbl = submit.querySelector('.btn-label');
    if (lbl && !view.busy) lbl.textContent = label;
    submit.classList.toggle('btn-danger', meta.tone === 'danger');
    submit.classList.toggle('btn-primary', meta.tone !== 'danger');
    submit.disabled = view.busy || !view.member;
  }

  function drawPicked() {
    if (!view.member) {
      replace(picked);
      search.hidden = false;
      return;
    }
    const m = view.member;
    search.hidden = true;
    replace(results);
    replace(picked, h('div', { class: 'quick-member' },
      avatar({ name: m.name, url: m.avatar_url, id: m.id, size: 'sm' }),
      h('span', { class: 'quick-member-text' }, h('strong', { text: m.name }), h('span', { class: 'muted', text: m.username ? `@${m.username}` : `ID ${m.id}` })),
      button({ label: 'Record', size: 'sm', variant: 'ghost', icon: 'user', onClick: () => openMemberDrawer(ctx, m) }),
      button({ label: 'Change', size: 'sm', onClick: () => {
        view.member = null;
        drawPicked();
        drawSubmit();
        search.focus();
      } })));
  }

  function drawResults() {
    const typed = search.value.trim();
    if (!typed) {
      replace(results);
      return;
    }
    if (typed.length < SEARCH_MIN) {
      replace(results, h('li', { class: 'quick-hint muted', text: 'Type at least 2 letters to search.' }));
      return;
    }
    if (view.searching) {
      replace(results, h('li', { class: 'quick-hint' }, h('span', { class: 'spinner spinner-sm', attrs: { 'aria-hidden': 'true' } }), h('span', { text: 'Searching…' })));
      return;
    }
    if (!view.results.length) {
      replace(results, h('li', { class: 'quick-hint muted', text: 'No members match.' }));
      return;
    }
    replace(results, ...view.results.slice(0, 6).map((m) => {
      const b = h('button', { type: 'button', class: 'quick-result' },
        avatar({ name: m.name, url: m.avatar_url, id: m.id, size: 'xs' }),
        h('span', { class: 'quick-result-name', text: m.name }),
        m.username ? h('span', { class: 'muted', text: `@${m.username}` }) : null,
        m.bot ? h('span', { class: 'bot-tag', text: 'BOT' }) : null);
      b.addEventListener('click', () => {
        view.member = m;
        drawPicked();
        drawSubmit();
      });
      return h('li', null, b);
    }));
  }

  const finder = latestSearch(async (q) => {
    view.token += 1;
    const mine = view.token;
    view.searching = true;
    drawResults();
    try {
      const data = await readJob(ctx, withQuery(serverApi(sid, 'members'), { q }), { signal: ctx.signal });
      if (mine !== view.token) return;
      view.results = readPage(data, 'members').list.map(normalizeMember);
    } catch (err) {
      if (mine !== view.token || isAbort(err)) return;
      view.results = [];
      toast(err.message || "Couldn't search members.", { tone: 'danger' });
    } finally {
      if (mine === view.token) {
        view.searching = false;
        drawResults();
      }
    }
  });
  search.addEventListener('input', () => {
    const q = search.value.trim().slice(0, 100);
    if (q.length < SEARCH_MIN) {
      finder.clear();
      view.token += 1;
      view.searching = false;
      view.results = [];
      drawResults();
      return;
    }
    finder.push(q);
  });
  ctx.signal?.addEventListener?.('abort', () => finder.cancel(), { once: true });

  submit.addEventListener('click', async () => {
    if (view.busy || !view.member) return;
    const action = view.action;
    const built = buildActionBody(action, { reason: reason.value, duration: duration?.value });
    if (built.error) {
      toast(built.error, { tone: 'danger' });
      return;
    }
    if (MOD_ACTIONS[action].confirm) {
      const copy = confirmCopy(action, view.member.name, built.body.duration || '');
      if (!(await confirmDialog({ ...copy, tone: 'danger' }))) return;
    }
    view.busy = true;
    setBusy(submit, true, 'Working…');
    try {
      const result = await sendAction(ctx, serverApi(sid, 'members', view.member.id, 'actions'), built.body, { signal: ctx.signal, onPending: () => status.waiting() });
      if (result.ok === false) {
        toast(result.error || "YapOS couldn't do that.", { tone: 'danger', title: "Couldn't finish" });
        return;
      }
      toast(result.message || `${MOD_ACTIONS[action].done}.`, { title: MOD_ACTIONS[action].done });
      reason.value = '';
      onDone?.(result);
    } catch (err) {
      if (isAbort(err)) return;
      toast(err.message || 'Something went wrong. Please try again.', { tone: 'danger', title: "Couldn't finish" });
    } finally {
      view.busy = false;
      status.clear();
      setBusy(submit, false);
      drawSubmit();
    }
  });

  drawActions();
  drawDuration();
  drawSubmit();
  return card({ title: 'Quick action', icon: 'sparkles', className: 'quick-card' },
    h('div', { class: 'quick-form' },
      h('div', { class: 'mod-field' }, h('span', { class: 'mod-field-label', text: 'Member' }),
        h('div', { class: 'input-shell has-lead' }, icon('search', { size: 14, className: 'input-lead' }), search),
        results,
        picked),
      h('div', { class: 'mod-field' }, h('span', { class: 'mod-field-label', text: 'Action' }), actionRow),
      durationSlot,
      h('div', { class: 'mod-field' }, h('span', { class: 'mod-field-label', text: 'Reason' }), reason),
      status.el,
      h('div', { class: 'action-form-actions' }, submit)));
}

export function renderMod(ctx) {
  const { main, params } = ctx;
  serverChrome(ctx, 'mod', 'Moderation');
  const refreshBtn = button({ label: 'Refresh', icon: 'refresh', size: 'sm' });
  const body = h('div', { class: 'page-body' });
  main.replaceChildren(h('div', { class: 'page page-mod' },
    pageHeader({
      title: 'Moderation',
      description: 'How things are going, and a fast way to act. Every action here uses the same cases and mod log as the /mod commands.',
      actions: h('div', { class: 'page-actions-row' }, linkButton({ label: 'All cases', href: serverPath(params.sid, 'cases'), icon: 'inbox', size: 'sm' }), refreshBtn),
    }),
    body));
  let force = false;
  const reload = mountAsync(body, {
    signal: ctx.signal,
    skeleton: modSkeleton,
    load: (opts) => {
      const f = force;
      force = false;
      return loadServer(ctx, { ...opts, force: f });
    },
    render: (detail) => {
      serverChrome(ctx, 'mod', 'Moderation');
      const ov = detail?.overview || {};
      const stats = modStats(ov);
      const refresh = () => {
        force = true;
        reload();
      };
      const quick = quickAction(ctx, { onDone: () => setTimeout(() => { if (!ctx.signal.aborted) refresh(); }, 1200) });
      replace(body,
        stats
          ? h('div', { class: 'stat-grid' },
            heroStat({ label: 'Cases', value: stats.cases30, icon: 'shield', hint: 'Last 30 days' }),
            heroStat({ label: 'Active warnings', value: stats.activeWarns, icon: 'alert', hint: 'Not yet expired' }),
            heroStat({ label: 'Timeouts', value: stats.activeTimeouts, icon: 'clock', hint: stats.activeTimeouts === null ? 'Not tracked yet' : 'Running now' }),
            heroStat({ label: 'Temp bans', value: stats.tempBans, icon: 'lock', hint: 'Waiting to be lifted' }))
          : h('div', { class: 'notice' }, icon('info', { size: 16 }), h('span', { text: 'Moderation stats arrive with the next snapshot from YapOS. Refresh in a little while.' })),
        h('div', { class: 'mod-grid' },
          h('div', { class: 'stack' }, stats ? chartCard(stats) : null, recentCard(ctx, ov.recent)),
          h('div', { class: 'stack' }, quick, stats ? typesCard(stats) : null)));
    },
  });
  refreshBtn.addEventListener('click', () => {
    force = true;
    reload();
  });
}
