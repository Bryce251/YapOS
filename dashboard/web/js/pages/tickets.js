import { h, replace } from '../dom.js';
import { icon } from '../icons.js';
import { avatar, badge, button, confirmDialog, copyText, drawer, emptyState, loadingRegion, pageHeader, pendingState, setBusy, skeleton, skeletonBlock, toast } from '../ui.js';
import { childSignal, errorView, loadServer, mountAsync } from './common.js';
import { serverChrome } from './overview.js';
import { openMemberDrawer } from './member.js';
import { formatDate, formatNumber, relativeTime } from '../format.js';
import { isAbort } from '../api.js';
import { confirmCopy, downloadText, latestSearch, normalizeTicket, pager, readJob, readPage, sectionTitle, sendAction, serverApi, stars, statusLine, tabBar, ticketStatus, transcriptFileName, withQuery } from '../kit.js';

const STATUSES = [
  { id: 'open', label: 'Open', icon: 'inbox' },
  { id: 'closed', label: 'Closed', icon: 'check' },
  { id: 'all', label: 'All', icon: 'ticket' },
];

export function readTicketsQuery(search) {
  const p = new URLSearchParams(search || '');
  const status = STATUSES.some((s) => s.id === p.get('status')) ? p.get('status') : 'open';
  const page = Math.min(100, Math.max(1, Number.parseInt(p.get('page') || '1', 10) || 1));
  return { status, q: (p.get('q') || '').slice(0, 100), page };
}

export function ticketsQueryString(s) {
  const p = new URLSearchParams();
  if (s.status && s.status !== 'open') p.set('status', s.status);
  if (s.q) p.set('q', s.q);
  if (s.page > 1) p.set('page', String(s.page));
  const qs = p.toString();
  return qs ? `?${qs}` : '';
}

function listSkeleton() {
  return loadingRegion('Loading tickets', h('ul', { class: 'ticket-list' }, ...Array.from({ length: 6 }, () => h('li', { class: 'ticket-row is-skeleton' },
    skeleton('skeleton-text skeleton-w-10'),
    h('span', { class: 'ticket-row-main' }, skeleton('skeleton-text skeleton-w-40'), skeleton('skeleton-text skeleton-w-60'))))));
}

function typeGlyph(t) {
  const emoji = t.type?.emoji && Array.from(t.type.emoji).length <= 4 ? t.type.emoji : '';
  return h('span', { class: 'ticket-glyph', attrs: { 'aria-hidden': 'true' } }, emoji ? h('span', { text: emoji }) : icon('ticket', { size: 16 }));
}

export function ticketRow(t, onOpen) {
  const st = ticketStatus(t.status);
  const age = t.status === 'closed' && t.closedAt ? `Closed ${relativeTime(t.closedAt)}` : t.createdAt ? `Opened ${relativeTime(t.createdAt)}` : '';
  const btn = h('button', { type: 'button', class: ['ticket-row', `is-${t.status}`], attrs: { 'aria-label': `Open ticket #${t.number}` } },
    h('span', { class: 'ticket-number mono', text: `#${t.number}` }),
    typeGlyph(t),
    h('span', { class: 'ticket-row-main' },
      h('span', { class: 'ticket-row-title' }, h('span', { class: 'ticket-row-name', text: t.name }), badge(st.label, st.tone), t.type?.name ? h('span', { class: 'ticket-type', text: t.type.name }) : null),
      h('span', { class: 'ticket-row-sub', text: t.topic || 'No topic' })),
    h('span', { class: 'ticket-row-people' },
      h('span', { class: 'ticket-person' }, avatar({ name: t.opener.name, id: t.opener.id, size: 'xs' }), h('span', { text: t.opener.name })),
      h('span', { class: ['ticket-claim', t.claimedBy ? '' : 'muted'] }, icon('user', { size: 12 }), h('span', { text: t.claimedBy ? `Claimed by ${t.claimedBy.name}` : 'Unclaimed' }))),
    h('span', { class: 'ticket-row-meta' },
      h('span', { class: 'ticket-age', text: age }),
      t.rating ? stars(t.rating, { size: 12 }) : null),
    icon('chevron-right', { size: 16, className: 'member-row-caret' }));
  btn.addEventListener('click', () => onOpen(t));
  return h('li', null, btn);
}

function ticketSkeleton() {
  return loadingRegion('Loading ticket', skeletonBlock(3), skeletonBlock(4), skeleton('skeleton-input'));
}

function kvRow(label, value) {
  if (value === null || value === undefined || value === '') return null;
  return h('div', { class: 'kv-row' }, h('dt', { class: 'kv-key', text: label }), h('dd', { class: 'kv-value' }, value instanceof Node ? value : h('span', { text: String(value) })));
}

export function transcriptViewer(transcript, ticket) {
  if (!transcript || typeof transcript.text !== 'string' || !transcript.text) {
    return h('p', { class: 'muted', text: ticket.status === 'closed' ? 'No transcript was saved for this ticket. Tickets closed before this dashboard update have none.' : 'No messages yet.' });
  }
  const text = transcript.text;
  const copyBtn = button({ label: 'Copy', icon: 'copy', size: 'sm' });
  copyBtn.addEventListener('click', async () => {
    const ok = await copyText(text);
    toast(ok ? 'Transcript copied to your clipboard.' : "Couldn't copy automatically. Use Download instead.", { tone: ok ? 'success' : 'danger' });
  });
  const dl = button({ label: 'Download .txt', icon: 'download', size: 'sm' });
  dl.addEventListener('click', () => {
    try {
      downloadText(transcriptFileName(ticket), text);
    } catch {
      toast("Your browser blocked the download. Use Copy instead.", { tone: 'danger' });
    }
  });
  return h('div', { class: 'transcript' },
    h('div', { class: 'transcript-bar' },
      h('span', { class: 'transcript-meta' }, transcript.live ? h('span', { class: 'live-dot', attrs: { 'aria-hidden': 'true' } }) : null,
        h('span', { text: `${transcript.live ? 'Live · ' : ''}${formatNumber(transcript.count ?? 0)} message${Number(transcript.count) === 1 ? '' : 's'}` })),
      h('span', { class: 'transcript-actions' }, copyBtn, dl)),
    h('pre', { class: 'transcript-text', tabIndex: 0, attrs: { 'aria-label': 'Transcript' } }, h('code', { text })));
}

export function openTicketDrawer(ctx, row, { onChange } = {}) {
  const ctrl = childSignal(ctx.signal);
  const d = drawer({ title: `Ticket #${row.number}`, subtitle: row.name || 'Ticket', onClose: () => ctrl.abort() });
  d.root.classList.add('drawer-wide');
  ctx.signal?.addEventListener?.('abort', () => d.close(), { once: true });
  const sid = ctx.params.sid;
  const view = { t: normalizeTicket(row), transcript: null, busy: false };
  const status = statusLine();
  let pending = null;
  let token = 0;
  let inner = null;

  async function act(action, reason, btn) {
    if (view.busy) return;
    if (action === 'close' && !(await confirmDialog({ ...confirmCopy('close'), tone: 'danger' }))) return;
    view.busy = true;
    setBusy(btn, true, 'Working…');
    for (const b of d.body.querySelectorAll('.needs-idle')) b.disabled = true;
    try {
      const body = { action };
      const r = String(reason ?? '').trim().slice(0, 500);
      if (r) body.reason = r;
      const result = await sendAction(ctx, serverApi(sid, 'tickets', view.t.number, 'actions'), body, { signal: ctrl.signal, onPending: () => status.waiting() });
      if (ctrl.signal.aborted) return;
      if (result.ok === false) {
        toast(result.error || result.message || "YapOS couldn't do that.", { tone: 'danger', title: "Couldn't finish" });
        return;
      }
      toast(result.message || 'Done.', { title: action === 'close' ? 'Ticket closed' : action === 'claim' ? 'Ticket claimed' : 'Ticket unclaimed' });
      if (result.ticket) view.t = normalizeTicket(result.ticket);
      onChange?.(view.t);
    } catch (err) {
      if (isAbort(err) || ctrl.signal.aborted) return;
      toast(err.message || 'Something went wrong. Please try again.', { tone: 'danger', title: "Couldn't finish" });
    } finally {
      view.busy = false;
      status.clear();
      if (!ctrl.signal.aborted) {
        if (action === 'close') run();
        else draw();
      }
    }
  }

  function actions(t) {
    if (t.status === 'closed') return h('p', { class: 'muted', text: 'This ticket is closed.' });
    if (t.status === 'closing') return h('p', { class: 'muted', text: 'This ticket is closing now.' });
    const reason = h('textarea', { class: 'input textarea', rows: 2, maxLength: 500, placeholder: 'Reason for closing (optional)', attrs: { 'aria-label': 'Reason for closing' } });
    const claim = t.claimedBy
      ? button({ label: 'Unclaim', icon: 'x', className: 'needs-idle', disabled: view.busy })
      : button({ label: 'Claim', icon: 'user', variant: 'primary', className: 'needs-idle', disabled: view.busy });
    claim.addEventListener('click', () => act(t.claimedBy ? 'unclaim' : 'claim', '', claim));
    const close = button({ label: 'Close ticket', icon: 'lock', variant: 'danger', className: 'needs-idle', disabled: view.busy });
    close.addEventListener('click', () => act('close', reason.value, close));
    return h('div', { class: 'ticket-actions' },
      h('div', { class: 'action-form-actions action-form-start' }, claim),
      reason,
      h('div', { class: 'action-form-actions' }, close));
  }

  function person(p) {
    if (!p || !p.id) return p?.name || null;
    const b = h('button', { type: 'button', class: 'person-btn', attrs: { 'aria-label': `Open ${p.name}'s record` } }, avatar({ name: p.name, id: p.id, size: 'xs' }), h('span', { class: 'cell-name', text: p.name }));
    b.addEventListener('click', () => openMemberDrawer(ctx, p));
    return b;
  }

  function draw() {
    const t = view.t;
    const st = ticketStatus(t.status);
    d.setTitle(`Ticket #${t.number}`);
    replace(d.body,
      h('div', { class: 'ticket-hero' },
        typeGlyph(t),
        h('div', { class: 'member-head-text' },
          h('p', { class: 'member-name', text: t.name }),
          h('p', { class: 'member-handle', text: t.topic || 'No topic' }),
          h('div', { class: 'member-flags' }, badge(st.label, st.tone), t.type?.name ? badge(t.type.name, 'neutral') : null, t.rating ? stars(t.rating) : null))),
      status.el,
      h('section', { class: 'drawer-section' }, sectionTitle('Actions'), actions(t)),
      h('section', { class: 'drawer-section' },
        sectionTitle('Details'),
        h('dl', { class: 'kv' },
          kvRow('Opened by', person(t.opener)),
          kvRow('Claimed by', t.claimedBy ? person(t.claimedBy) : 'Nobody yet'),
          kvRow('Opened', t.createdAt ? `${formatDate(t.createdAt)} (${relativeTime(t.createdAt)})` : ''),
          kvRow('Last activity', t.lastActivityAt ? relativeTime(t.lastActivityAt) : ''),
          kvRow('Closed', t.closedAt ? `${formatDate(t.closedAt)} (${relativeTime(t.closedAt)})` : ''),
          kvRow('Closed by', t.closedBy ? person(t.closedBy) : ''),
          kvRow('Close reason', t.reason),
          kvRow('People', t.members ? formatNumber(t.members) : ''))),
      t.answers.length ? h('section', { class: 'drawer-section' },
        sectionTitle('Form answers'),
        h('dl', { class: 'answers' }, ...t.answers.map((a) => h('div', { class: 'answer' }, h('dt', { text: a.q || 'Question' }), h('dd', { text: a.a || 'No answer' }))))) : null,
      t.people.length ? h('section', { class: 'drawer-section' },
        sectionTitle('People in the ticket ', h('span', { class: 'count-pill', text: String(t.people.length) })),
        h('div', { class: 'people-chips' }, ...t.people.map((p) => person(p)))) : null,
      h('section', { class: 'drawer-section' }, sectionTitle('Transcript'), transcriptViewer(view.transcript, t)));
  }

  const run = async () => {
    token += 1;
    const mine = token;
    inner?.abort();
    inner = childSignal(ctrl.signal);
    const signal = inner.signal;
    pending?.stop();
    pending = null;
    replace(d.body, ticketSkeleton());
    try {
      const data = await readJob(ctx, serverApi(sid, 'tickets', row.number), {
        signal,
        onPending: () => {
          if (pending || mine !== token) return;
          pending = pendingState({ onRetry: run, compact: true });
          replace(d.body, pending.el);
        },
      });
      if (mine !== token || signal.aborted) return;
      pending?.stop();
      pending = null;
      if (!data?.ticket) {
        replace(d.body, emptyState({ icon: 'ticket', title: 'Ticket not found', body: 'It may have been removed. Refresh the list and try again.', compact: true }));
        return;
      }
      view.t = normalizeTicket(data.ticket);
      view.transcript = data.transcript && typeof data.transcript === 'object' ? data.transcript : null;
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

export function renderTickets(ctx) {
  const { main, params } = ctx;
  serverChrome(ctx, 'tickets', 'Tickets');
  const s = readTicketsQuery(window.location.search);
  const search = h('input', { type: 'search', class: 'input', placeholder: 'Search by number, name, topic or member', value: s.q, maxLength: 100, attrs: { 'aria-label': 'Search tickets' } });
  const count = h('p', { class: 'toolbar-count', attrs: { 'aria-live': 'polite' } });
  const ratingSlot = h('div', { class: 'rating-summary', hidden: true });
  const refreshBtn = button({ label: 'Refresh', icon: 'refresh', size: 'sm' });
  const list = h('div', { class: 'tickets-body', attrs: { role: 'tabpanel', 'aria-labelledby': `tickets-tab-${s.status}` } });

  function writeQuery() {
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${ticketsQueryString(s)}`);
  }

  const tabs = tabBar({
    items: STATUSES,
    value: s.status,
    label: 'Ticket status',
    idPrefix: 'tickets-tab',
    onChange: (id) => {
      s.status = id;
      s.page = 1;
      list.setAttribute('aria-labelledby', `tickets-tab-${id}`);
      writeQuery();
      reload();
    },
  });

  main.replaceChildren(h('div', { class: 'page page-tickets' },
    pageHeader({ title: 'Tickets', description: 'Every support ticket in the server, with who opened it, who is on it and the full transcript.', actions: h('div', { class: 'page-actions-row' }, ratingSlot, refreshBtn) }),
    tabs.el,
    h('div', { class: 'toolbar toolbar-wrap toolbar-tight' },
      h('div', { class: 'input-shell has-lead toolbar-search' }, icon('search', { size: 14, className: 'input-lead' }), search),
      count),
    list));

  const openTicket = (t) => openTicketDrawer(ctx, t, { onChange: () => reload() });

  const reload = mountAsync(list, {
    signal: ctx.signal,
    skeleton: listSkeleton,
    load: async (opts) => {
      await loadServer(ctx, opts);
      const path = withQuery(serverApi(params.sid, 'tickets'), { status: s.status === 'open' ? '' : s.status, q: s.q, page: s.page > 1 ? s.page : '' });
      return readJob(ctx, path, opts);
    },
    render: (data) => {
      serverChrome(ctx, 'tickets', 'Tickets');
      const page = readPage(data, 'tickets');
      const counts = data?.counts && typeof data.counts === 'object' ? data.counts : {};
      const openCount = Number(counts.open) || 0;
      const closedCount = Number(counts.closed) || 0;
      tabs.setCount('open', openCount);
      tabs.setCount('closed', closedCount);
      tabs.setCount('all', openCount + closedCount);
      const rating = data?.rating && typeof data.rating === 'object' ? data.rating : {};
      if (Number(rating.count) > 0 && Number.isFinite(Number(rating.average))) {
        ratingSlot.hidden = false;
        replace(ratingSlot, stars(Number(rating.average)), h('span', { class: 'rating-text', text: `${Number(rating.average).toFixed(1)} from ${formatNumber(rating.count)} rating${Number(rating.count) === 1 ? '' : 's'}` }));
      } else {
        ratingSlot.hidden = true;
        replace(ratingSlot);
      }
      const tickets = page.list.map(normalizeTicket);
      count.textContent = page.pages > 1 ? `${formatNumber(page.total)} tickets · page ${formatNumber(page.page)} of ${formatNumber(page.pages)}` : `${formatNumber(page.total)} ticket${page.total === 1 ? '' : 's'}`;
      if (!tickets.length) {
        replace(list, emptyState({
          icon: s.q ? 'search' : 'ticket',
          title: s.q ? 'No tickets match' : s.status === 'open' ? 'No open tickets' : s.status === 'closed' ? 'No closed tickets' : 'No tickets yet',
          body: s.q ? 'Try a different search.' : s.status === 'open' ? 'All caught up. New tickets show up here as soon as someone opens one.' : 'Tickets from the Tickets app will be listed here.',
          action: s.q ? button({ label: 'Clear search', size: 'sm', onClick: () => {
            search.value = '';
            s.q = '';
            s.page = 1;
            writeQuery();
            reload();
          } }) : null,
        }));
        return;
      }
      replace(list,
        h('ul', { class: 'ticket-list', attrs: { 'aria-label': 'Tickets' } }, ...tickets.map((t) => ticketRow(t, openTicket))),
        pager({ page: page.page, pages: page.pages, label: 'Ticket pages', onChange: (p) => {
          s.page = p;
          writeQuery();
          reload();
          window.scrollTo(0, 0);
        } }));
    },
  });

  const searcher = latestSearch(async (q) => {
    if (q === s.q) return;
    s.q = q;
    s.page = 1;
    writeQuery();
    await reload();
  }, { min: 1 });
  search.addEventListener('input', () => searcher.push(search.value.trim().slice(0, 100)));
  refreshBtn.addEventListener('click', () => reload());
  ctx.signal?.addEventListener?.('abort', () => searcher.cancel(), { once: true });
}
