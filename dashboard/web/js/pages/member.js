import { h, replace } from '../dom.js';
import { icon } from '../icons.js';
import { avatar, badge, button, confirmDialog, drawer, emptyState, loadingRegion, pendingState, setBusy, skeleton, skeletonBlock, toast } from '../ui.js';
import { errorView, childSignal, loadServer } from './common.js';
import { isAbort } from '../api.js';
import { normalizeCase } from '../cases.js';
import { caseTone, formatDate, formatNumber, relativeTime, toMillis, toNumber } from '../format.js';
import { getDetail } from '../state.js';
import { MOD_ACTIONS, DURATION_PRESETS, buildActionBody, confirmCopy, durationPicker, readJob, roleChip, roleList, rolesIndex, sectionTitle, sendAction, serverApi, sortRoles, statusLine, tabBar } from '../kit.js';

const LABELS = {
  level: 'Level', xp: 'XP', totalXp: 'Total XP', messages: 'Messages', rank: 'Rank', voiceSeconds: 'Voice time', voice: 'Voice time',
  balance: 'Balance', bank: 'Bank', wallet: 'Wallet', coins: 'Coins', streak: 'Daily streak', earned: 'Earned', spent: 'Spent',
};

const TABS = [
  { id: 'overview', label: 'Overview', icon: 'user' },
  { id: 'moderate', label: 'Moderate', icon: 'shield' },
  { id: 'roles', label: 'Roles', icon: 'tag' },
  { id: 'notes', label: 'Notes', icon: 'message' },
  { id: 'history', label: 'History', icon: 'clock' },
];

const BAN_PRESETS = [
  { value: '1d', label: '1 day' },
  { value: '1w', label: '1 week' },
  { value: '30d', label: '30 days' },
];

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
    sectionTitle(title),
    stats.length
      ? h('dl', { class: 'mini-stats' }, ...stats.map((s) => h('div', { class: 'mini-stat' }, h('dt', { text: s.label }), h('dd', { text: s.value }))))
      : h('p', { class: 'muted', text: obj === null || obj === undefined ? 'This app is off or has no data.' : 'Nothing recorded yet.' }));
}

function memberSkeleton() {
  return loadingRegion('Loading member',
    h('div', { class: 'member-head' }, skeleton('skeleton-avatar-lg'), h('div', { class: 'member-head-text' }, skeleton('skeleton-title skeleton-w-50'), skeleton('skeleton-text skeleton-w-30'))),
    skeletonBlock(4), skeletonBlock(3));
}

export function memberFlags(m) {
  const flags = [];
  const timeoutUntil = toMillis(m?.timeout?.until);
  if (timeoutUntil && timeoutUntil > Date.now()) flags.push({ key: 'timeout', label: `Timed out · ends ${relativeTime(timeoutUntil)}`, tone: 'warning', icon: 'clock' });
  if (m?.banned) {
    const until = toMillis(m?.tempBan?.until);
    flags.push({ key: 'banned', label: until ? `Banned · ends ${relativeTime(until)}` : 'Banned', tone: 'danger', icon: 'lock' });
  }
  if (m?.bot) flags.push({ key: 'bot', label: 'BOT', tone: 'accent', icon: 'cpu' });
  return flags;
}

function field(label, control, help = '') {
  return h('label', { class: 'mod-field' }, h('span', { class: 'mod-field-label', text: label }), control, help ? h('span', { class: 'mod-field-help', text: help }) : null);
}

export function openMemberDrawer(ctx, user, { onChange, tab = 'overview' } = {}) {
  const ctrl = childSignal(ctx.signal);
  const d = drawer({ title: user?.name || 'Member', subtitle: 'Member record', onClose: () => ctrl.abort() });
  d.root.classList.add('drawer-wide');
  ctx.signal?.addEventListener?.('abort', () => d.close(), { once: true });
  const sid = ctx.params.sid;
  const uid = String(user?.id ?? '');
  const memberPath = serverApi(sid, 'members', uid);
  const actionPath = serverApi(sid, 'members', uid, 'actions');
  const view = { m: null, tab, busy: false, selected: null, roles: new Map() };
  let pending = null;
  let token = 0;
  let inner = null;

  const status = statusLine();

  function lookupRoles() {
    const detail = getDetail(sid);
    view.roles = rolesIndex(detail?.settings?.lookups?.roles);
  }

  function nameOf(m = view.m) {
    return m?.name || m?.nickname || m?.username || user?.name || 'Member';
  }

  async function act(action, fields, { button: btn } = {}) {
    if (view.busy) return false;
    const built = buildActionBody(action, fields);
    if (built.error) {
      toast(built.error, { tone: 'danger' });
      return false;
    }
    if (MOD_ACTIONS[action]?.confirm) {
      const copy = confirmCopy(action, nameOf(), built.body.duration || '');
      if (!(await confirmDialog({ ...copy, tone: 'danger' }))) return false;
    }
    view.busy = true;
    d.body.classList.add('is-busy');
    if (btn) setBusy(btn, true, 'Working…');
    for (const b of d.body.querySelectorAll('.needs-idle')) b.disabled = true;
    try {
      const result = await sendAction(ctx, actionPath, built.body, { signal: ctrl.signal, onPending: () => status.waiting() });
      if (ctrl.signal.aborted) return false;
      if (result.ok === false) {
        toast(result.error || "YapOS couldn't do that.", { tone: 'danger', title: "Couldn't finish" });
        return false;
      }
      const meta = MOD_ACTIONS[action];
      const caseText = result.case && result.case.n ? ` Case #${result.case.n}.` : '';
      toast(`${result.message || `${meta?.done || 'Done'}.`}${result.message ? '' : caseText}`, { title: meta?.done || 'Done' });
      if (result.member && typeof result.member === 'object') view.m = { ...view.m, ...result.member };
      view.selected = null;
      onChange?.(view.m, { action, result });
      return true;
    } catch (err) {
      if (isAbort(err) || ctrl.signal.aborted) return false;
      toast(err.message || 'Something went wrong. Please try again.', { tone: 'danger', title: "Couldn't finish" });
      return false;
    } finally {
      view.busy = false;
      status.clear();
      if (!ctrl.signal.aborted) {
        d.body.classList.remove('is-busy');
        draw();
      }
    }
  }

  function head(m) {
    const name = nameOf(m);
    const roles = sortRoles(roleList(m.roles, view.roles));
    const flags = memberFlags(m);
    const joined = toMillis(m.joined_at);
    const sub = [m.username ? `@${m.username}` : '', m.nickname && m.nickname !== name ? `nickname ${m.nickname}` : ''].filter(Boolean).join(' · ');
    return h('div', { class: 'member-hero' },
      h('div', { class: 'member-head' },
        avatar({ name, url: m.avatar_url, id: m.id || uid, size: 'lg' }),
        h('div', { class: 'member-head-text' },
          h('p', { class: 'member-name', text: name }),
          sub ? h('p', { class: 'member-handle', text: sub }) : null,
          h('p', { class: 'member-id', text: `ID ${m.id || uid}` }))),
      flags.length ? h('div', { class: 'member-flags' }, ...flags.map((f) => badge(f.label, f.tone, f.icon))) : null,
      h('p', { class: 'member-joined' }, icon('clock', { size: 14 }),
        h('span', { text: joined ? `Joined ${formatDate(joined, { time: false })} (${relativeTime(joined)})` : (m.banned && !m.roles?.length ? 'Not in the server right now' : 'Join date unknown') })),
      roles.length ? h('div', { class: 'role-chips role-chips-wrap' }, ...roles.slice(0, 8).map((r) => roleChip(r)), roles.length > 8 ? h('span', { class: 'role-more', text: `+${roles.length - 8}` }) : null) : null);
  }

  function overviewPanel(m) {
    const warns = Array.isArray(m.warnings) ? m.warnings.length : 0;
    const cases = Array.isArray(m.cases) ? m.cases.length : 0;
    return [
      h('dl', { class: 'mini-stats' },
        h('div', { class: 'mini-stat' }, h('dt', { text: 'Active warnings' }), h('dd', { text: formatNumber(warns) })),
        h('div', { class: 'mini-stat' }, h('dt', { text: 'Cases' }), h('dd', { text: formatNumber(cases) })),
        h('div', { class: 'mini-stat' }, h('dt', { text: 'Notes' }), h('dd', { text: formatNumber(Array.isArray(m.notes) ? m.notes.length : 0) }))),
      statGroup('Levels', m.levels),
      statGroup('Economy', m.economy),
    ];
  }

  function moderatePanel(m) {
    const can = m.can && typeof m.can === 'object' ? m.can : {};
    const timedOut = memberFlags(m).some((f) => f.key === 'timeout');
    const items = [
      { id: 'warn', on: can.warn && !m.banned },
      { id: 'timeout', on: can.timeout && !m.banned },
      { id: 'untimeout', on: can.timeout && timedOut, hide: !timedOut },
      { id: 'kick', on: can.kick && !m.banned },
      { id: 'ban', on: can.ban && !m.banned, hide: m.banned },
      { id: 'unban', on: can.unban, hide: !m.banned },
    ].filter((i) => !i.hide);
    const anyOn = items.some((i) => i.on);
    const grid = h('div', { class: 'action-grid', attrs: { role: 'group', 'aria-label': 'Moderation actions' } },
      ...items.map((i) => {
        const meta = MOD_ACTIONS[i.id];
        const b = h('button', {
          type: 'button',
          class: ['action-tile', `action-${i.id}`, meta.tone === 'danger' ? 'is-danger' : '', view.selected === i.id ? 'is-active' : '', 'needs-idle'],
          disabled: !i.on || view.busy,
          dataset: { action: i.id },
          attrs: { 'aria-pressed': view.selected === i.id ? 'true' : 'false' },
        }, icon(meta.icon, { size: 18 }), h('span', { text: meta.label }));
        b.addEventListener('click', () => {
          view.selected = view.selected === i.id ? null : i.id;
          draw();
        });
        return b;
      }));
    const out = [grid];
    if (!anyOn) out.push(h('p', { class: 'muted', text: m.banned ? 'This member is banned and you can not unban them.' : "You can't take these actions on this member. They may rank above you or above YapOS, or YapOS is missing a permission." }));
    if (view.selected) out.push(actionForm(view.selected));
    return out;
  }

  function actionForm(action) {
    const meta = MOD_ACTIONS[action];
    const reason = h('textarea', { class: 'input textarea mod-reason', rows: 3, maxLength: 500, placeholder: 'Optional. Shown in the mod log and the case.', attrs: { 'aria-label': 'Reason' } });
    let duration = null;
    if (action === 'timeout') duration = durationPicker({ presets: DURATION_PRESETS, value: '1h', label: 'Timeout length' });
    if (action === 'ban') duration = durationPicker({ presets: BAN_PRESETS, value: '', allowNone: true, noneLabel: 'Permanent', label: 'Ban length' });
    const submit = button({ label: `${meta.label} ${nameOf()}`, variant: meta.tone === 'danger' ? 'danger' : 'primary', icon: meta.icon, className: 'needs-idle', disabled: view.busy });
    submit.addEventListener('click', () => act(action, { reason: reason.value, duration: duration?.value }, { button: submit }));
    const cancel = button({ label: 'Cancel', variant: 'ghost', onClick: () => { view.selected = null; draw(); } });
    return h('div', { class: 'action-form' },
      duration ? field(action === 'ban' ? 'How long' : 'Length', duration.el, action === 'ban' ? 'Leave on Permanent for a normal ban.' : 'From 1 minute up to 28 days.') : null,
      ['warn', 'timeout', 'untimeout', 'kick', 'ban', 'unban'].includes(action) ? field('Reason', reason) : null,
      h('div', { class: 'action-form-actions' }, cancel, submit));
  }

  function rolesPanel(m) {
    const can = m.can && typeof m.can === 'object' ? m.can : {};
    const current = sortRoles(roleList(m.roles, view.roles));
    const have = new Set(current.map((r) => r.id));
    const allowed = Array.isArray(m.assignable) ? new Set(m.assignable) : null;
    const addable = sortRoles(Array.from(view.roles.values()).filter((r) => r.manageable && (!allowed || allowed.has(r.id)) && !have.has(r.id) && r.name !== '@everyone'));
    const select = h('select', { class: 'input select', attrs: { 'aria-label': 'Role to add' }, disabled: !can.role || view.busy || !addable.length },
      h('option', { value: '', text: addable.length ? 'Pick a role…' : 'No roles you can give' }),
      ...addable.map((r) => h('option', { value: r.id, text: r.name })));
    const addBtn = button({ label: 'Add role', icon: 'plus', className: 'needs-idle', disabled: !can.role || view.busy || !addable.length });
    addBtn.addEventListener('click', () => act('role_add', { role_id: select.value }, { button: addBtn }));
    const nick = h('input', { type: 'text', class: 'input', maxLength: 32, value: m.nickname || '', placeholder: m.username || 'Nickname', disabled: !can.nick || view.busy, attrs: { 'aria-label': 'Nickname' } });
    const nickBtn = button({ label: 'Save', className: 'needs-idle', disabled: !can.nick || view.busy });
    nickBtn.addEventListener('click', () => act('nick', { nickname: nick.value }, { button: nickBtn }));
    nick.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        nickBtn.click();
      }
    });
    return [
      h('section', { class: 'drawer-section' },
        sectionTitle('Current roles ', h('span', { class: 'count-pill', text: String(current.length) })),
        current.length
          ? h('div', { class: 'role-chips role-chips-wrap' }, ...current.map((r) => roleChip(r, can.role && r.manageable && !view.busy ? {
            onRemove: () => act('role_remove', { role_id: r.id }),
            removeLabel: `Remove ${r.name} from ${nameOf()}`,
          } : {})))
          : h('p', { class: 'muted', text: 'No roles yet.' })),
      h('section', { class: 'drawer-section' },
        sectionTitle('Give a role'),
        h('div', { class: 'inline-form' }, h('div', { class: 'select-shell' }, select, icon('chevron-down', { size: 14, className: 'select-caret' })), addBtn),
        h('p', { class: 'mod-field-help', text: can.role ? 'Only roles you and YapOS can give are listed. They sit below your own top role.' : 'You need Manage Roles, and the member must rank below you.' })),
      h('section', { class: 'drawer-section' },
        sectionTitle('Nickname'),
        h('div', { class: 'inline-form' }, nick, nickBtn),
        h('p', { class: 'mod-field-help', text: can.nick ? 'Leave it empty and save to reset to their username.' : 'You need Manage Nicknames, and the member must rank below you.' })),
    ];
  }

  function notesPanel(m) {
    const can = m.can && typeof m.can === 'object' ? m.can : {};
    const notes = Array.isArray(m.notes) ? m.notes : [];
    const text = h('textarea', { class: 'input textarea', rows: 3, maxLength: 500, placeholder: 'Only moderators can see notes.', disabled: !can.note || view.busy, attrs: { 'aria-label': 'New note' } });
    const add = button({ label: 'Add note', icon: 'plus', variant: 'primary', className: 'needs-idle', disabled: !can.note || view.busy });
    add.addEventListener('click', () => act('note', { note: text.value }, { button: add }));
    return [
      h('section', { class: 'drawer-section' },
        sectionTitle('Add a note'),
        text,
        h('div', { class: 'action-form-actions' }, add)),
      h('section', { class: 'drawer-section' },
        sectionTitle('Notes ', h('span', { class: 'count-pill', text: String(notes.length) })),
        notes.length
          ? h('ul', { class: 'timeline' }, ...notes.map((n) => h('li', { class: 'timeline-item' },
            h('p', { class: 'timeline-text', text: String(n?.text ?? '') }),
            h('p', { class: 'timeline-meta', text: [n?.by?.name ? `by ${n.by.name}` : '', n?.at ? relativeTime(n.at) : ''].filter(Boolean).join(' · ') }))))
          : h('p', { class: 'muted', text: 'No notes yet.' })),
    ];
  }

  function historyPanel(m) {
    const can = m.can && typeof m.can === 'object' ? m.can : {};
    const warns = Array.isArray(m.warnings) ? m.warnings : [];
    const cases = (Array.isArray(m.cases) ? m.cases : []).map(normalizeCase);
    return [
      h('section', { class: 'drawer-section' },
        sectionTitle('Active warnings ', h('span', { class: 'count-pill', text: String(warns.length) })),
        warns.length
          ? h('ul', { class: 'timeline' }, ...warns.map((w) => {
            const reason = typeof w === 'string' ? w : (w?.reason || 'No reason given');
            const at = typeof w === 'object' ? w?.at : null;
            const n = typeof w === 'object' ? Number(w?.case) : NaN;
            const by = typeof w === 'object' ? (w?.mod?.name || w?.by?.name || (typeof w?.by === 'string' ? w.by : '')) : '';
            const undo = Number.isInteger(n) && n > 0 && can.unwarn ? button({ label: 'Unwarn', icon: 'x', size: 'sm', variant: 'ghost', className: 'needs-idle', disabled: view.busy }) : null;
            undo?.addEventListener('click', () => act('unwarn', { case: n }, { button: undo }));
            return h('li', { class: 'timeline-item' },
              h('div', { class: 'timeline-head' }, badge('Warning', 'caution'), Number.isInteger(n) && n > 0 ? h('span', { class: 'activity-case', text: `#${n}` }) : null, undo ? h('span', { class: 'timeline-action' }, undo) : null),
              h('p', { class: 'timeline-text', text: reason }),
              h('p', { class: 'timeline-meta', text: [by ? `by ${by}` : '', at ? relativeTime(at) : ''].filter(Boolean).join(' · ') }));
          }))
          : h('p', { class: 'muted', text: 'No active warnings.' })),
      h('section', { class: 'drawer-section' },
        sectionTitle('Cases ', h('span', { class: 'count-pill', text: String(cases.length) })),
        cases.length
          ? h('ul', { class: 'timeline timeline-rail' }, ...cases.map((c) => h('li', { class: ['timeline-item', `tone-${caseTone(c.type)}`] },
            h('div', { class: 'timeline-head' }, badge(c.typeLabel, caseTone(c.type)), h('span', { class: 'activity-case', text: `#${c.n}` }), c.active ? badge('Active', 'accent') : null),
            h('p', { class: 'timeline-text', text: c.reason || 'No reason given' }),
            h('p', { class: 'timeline-meta', text: [c.mod.name && c.mod.name !== 'Unknown' ? `by ${c.mod.name}` : '', c.at ? formatDate(c.at) : ''].filter(Boolean).join(' · ') }))))
          : h('p', { class: 'muted', text: 'No cases.' })),
    ];
  }

  const PANELS = { overview: overviewPanel, moderate: moderatePanel, roles: rolesPanel, notes: notesPanel, history: historyPanel };

  function draw() {
    const m = view.m;
    if (!m) return;
    d.setTitle(nameOf(m));
    const bar = tabBar({
      items: TABS.map((t) => ({ ...t, count: t.id === 'notes' ? (Array.isArray(m.notes) ? m.notes.length : 0) : t.id === 'history' ? (Array.isArray(m.cases) ? m.cases.length : 0) : undefined })),
      value: view.tab,
      label: 'Member sections',
      idPrefix: `member-tab-${uid}`,
      onChange: (id) => {
        view.tab = id;
        if (id !== 'moderate') view.selected = null;
        replace(panel, ...PANELS[id](view.m));
        panel.setAttribute('aria-labelledby', `member-tab-${uid}-${id}`);
      },
    });
    const panel = h('div', { class: 'ftab-panel', attrs: { role: 'tabpanel', 'aria-labelledby': `member-tab-${uid}-${view.tab}` } }, ...(PANELS[view.tab] || PANELS.overview)(m));
    replace(d.body, head(m), bar.el, status.el, panel);
  }

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
      const [data] = await Promise.all([
        readJob(ctx, memberPath, {
          signal,
          onPending: () => {
            if (pending || mine !== token) return;
            pending = pendingState({ onRetry: run, compact: true });
            replace(d.body, pending.el);
          },
        }),
        loadServer(ctx, { signal }).catch(() => null),
      ]);
      if (mine !== token || signal.aborted) return;
      pending?.stop();
      pending = null;
      const m = data?.member;
      if (!m) {
        replace(d.body, emptyState({ icon: 'user', title: 'No record found', body: "This member isn't in the server and YapOS has nothing stored for them.", compact: true }));
        return;
      }
      lookupRoles();
      view.m = m;
      draw();
    } catch (err) {
      if (mine !== token) return;
      pending?.stop();
      pending = null;
      if (isAbort(err) || signal.aborted) return;
      replace(d.body, errorView(err, run, { compact: true }));
    }
  };
  run();
  return { ...d, reload: run, view };
}
