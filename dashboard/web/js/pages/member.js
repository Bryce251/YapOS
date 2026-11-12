import { h, replace } from '../dom.js';
import { avatar, badge, drawer, emptyState, loadingRegion, pendingState, skeleton, skeletonBlock } from '../ui.js';
import { errorView, childSignal, forbiddenError } from './common.js';
import { isPending, isAbort } from '../api.js';
import { normalizeCase } from '../cases.js';
import { caseTone, formatDate, formatNumber, relativeTime, toNumber } from '../format.js';

const LABELS = {
  level: 'Level', xp: 'XP', totalXp: 'Total XP', messages: 'Messages', rank: 'Rank', voiceSeconds: 'Voice time', voice: 'Voice time',
  balance: 'Balance', bank: 'Bank', wallet: 'Wallet', coins: 'Coins', streak: 'Daily streak', earned: 'Earned', spent: 'Spent',
};

function humanKey(key) {
  if (LABELS[key]) return LABELS[key];
  const s = String(key).replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function statsOf(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return [];
  return Object.entries(obj)
    .filter(([, v]) => typeof v === 'number' || (typeof v === 'string' && v.length < 40) || typeof v === 'boolean')
    .slice(0, 8)
    .map(([k, v]) => ({ label: humanKey(k), value: typeof v === 'number' ? (toNumber(v) !== null ? formatNumber(v) : String(v)) : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : v }));
}

function statGroup(title, obj) {
  const stats = statsOf(obj);
  return h('section', { class: 'drawer-section' },
    h('h3', { class: 'drawer-section-title', text: title }),
    stats.length
      ? h('dl', { class: 'mini-stats' }, ...stats.map((s) => h('div', { class: 'mini-stat' }, h('dt', { text: s.label }), h('dd', { text: s.value }))))
      : h('p', { class: 'muted', text: obj === null || obj === undefined ? 'No data.' : 'Nothing recorded yet.' }));
}

function warningsSection(list) {
  const items = Array.isArray(list) ? list : [];
  return h('section', { class: 'drawer-section' },
    h('h3', { class: 'drawer-section-title' }, 'Warnings ', h('span', { class: 'count-pill', text: String(items.length) })),
    items.length
      ? h('ul', { class: 'timeline' }, ...items.map((w) => {
        const reason = typeof w === 'string' ? w : (w?.reason || 'No reason given');
        const at = typeof w === 'object' ? w?.at : null;
        const by = typeof w === 'object' ? (w?.mod?.name || w?.by || '') : '';
        return h('li', { class: 'timeline-item' },
          h('p', { class: 'timeline-text', text: reason }),
          h('p', { class: 'timeline-meta', text: [by ? `by ${by}` : '', at ? relativeTime(at) : ''].filter(Boolean).join(' · ') }));
      }))
      : h('p', { class: 'muted', text: 'No warnings.' }));
}

function casesSection(list) {
  const items = (Array.isArray(list) ? list : []).map(normalizeCase);
  return h('section', { class: 'drawer-section' },
    h('h3', { class: 'drawer-section-title' }, 'Cases ', h('span', { class: 'count-pill', text: String(items.length) })),
    items.length
      ? h('ul', { class: 'timeline' }, ...items.map((c) => h('li', { class: 'timeline-item' },
        h('div', { class: 'timeline-head' }, badge(c.typeLabel, caseTone(c.type)), h('span', { class: 'activity-case', text: `#${c.n}` }), c.active ? badge('Active', 'accent') : null),
        h('p', { class: 'timeline-text', text: c.reason || 'No reason given' }),
        h('p', { class: 'timeline-meta', text: [c.mod.name ? `by ${c.mod.name}` : '', c.at ? formatDate(c.at) : ''].filter(Boolean).join(' · ') }))))
      : h('p', { class: 'muted', text: 'No cases.' }));
}

function memberSkeleton() {
  return loadingRegion('Loading member',
    h('div', { class: 'member-head' }, skeleton('skeleton-avatar-lg'), h('div', { class: 'member-head-text' }, skeleton('skeleton-title skeleton-w-50'), skeleton('skeleton-text skeleton-w-30'))),
    skeletonBlock(4), skeletonBlock(3));
}

export function openMemberDrawer(ctx, user) {
  const ctrl = childSignal(ctx.signal);
  const d = drawer({ title: user.name || 'Member', subtitle: 'Member record', onClose: () => ctrl.abort() });
  let pending = null;
  let token = 0;
  let inner = null;
  const run = async () => {
    token += 1;
    const mine = token;
    inner?.abort();
    inner = childSignal(ctrl.signal);
    const signal = inner.signal;
    pending?.stop();
    pending = null;
    replace(d.body, memberSkeleton());
    try {
      const path = `/api/servers/${encodeURIComponent(ctx.params.sid)}/members/${encodeURIComponent(user.id)}`;
      let data = await ctx.api.get(path, { signal });
      if (isPending(data)) {
        pending = pendingState({ onRetry: run, compact: true });
        replace(d.body, pending.el);
        data = await ctx.api.job(data.job, { signal });
      }
      if (mine !== token || signal.aborted) return;
      pending?.stop();
      if (data && data.grant === false) throw forbiddenError();
      const m = data?.member;
      if (!m) {
        replace(d.body, emptyState({ icon: 'user', title: 'No record found', body: 'YapOS has nothing stored for this member.', compact: true }));
        return;
      }
      const name = m.name || user.name || 'Member';
      d.setTitle(name);
      replace(d.body,
        h('div', { class: 'member-head' },
          avatar({ name, url: m.avatar_url, id: m.id || user.id, size: 'lg' }),
          h('div', { class: 'member-head-text' },
            h('p', { class: 'member-name', text: name }),
            h('p', { class: 'member-id', text: `ID ${m.id || user.id}` }))),
        warningsSection(m.warnings),
        casesSection(m.cases),
        statGroup('Levels', m.levels),
        statGroup('Economy', m.economy));
    } catch (err) {
      if (mine !== token) return;
      pending?.stop();
      if (isAbort(err) || signal.aborted) return;
      replace(d.body, errorView(err, run, { compact: true }));
    }
  };
  run();
  return d;
}
