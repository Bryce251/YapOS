import { h, replace } from '../dom.js';
import { icon } from '../icons.js';
import { button, card, emptyState, linkButton, loadingRegion, pageHeader, skeleton, toast } from '../ui.js';
import { ApiError } from '../api.js';
import { relativeTime } from '../format.js';
import { inboxCountChanged } from '../inbox-watch.js';
import { mountAsync } from './common.js';

export const INBOX_API = '/api/me/inbox';
const ANSWER_POLL_MS = 3000;
const ANSWER_POLLS = 40;

const KIND_ICONS = {
  clan_invite: 'message',
  clan_joined: 'users',
  clan_left: 'logout',
  clan_kicked: 'ban',
  clan_leader: 'crown',
  clan_closed: 'trash',
  clan_declined: 'x',
  clan_refused: 'alert',
  gift: 'gift',
  badge: 'star',
  achievement: 'trophy',
};

export function kindIcon(kind) {
  return KIND_ICONS[kind] || 'bell';
}

export function readInbox(data) {
  const d = data && typeof data === 'object' ? data : {};
  const items = Array.isArray(d.items) ? d.items.filter((x) => x && typeof x.id === 'string' && typeof x.title === 'string') : [];
  const warnings = Array.isArray(d.warnings) ? d.warnings.filter((w) => w && typeof w.text === 'string') : [];
  return {
    items: items.map((x) => ({
      id: x.id,
      kind: typeof x.kind === 'string' ? x.kind : 'note',
      title: x.title,
      body: typeof x.body === 'string' ? x.body : '',
      created: Number(x.created) || 0,
      read: x.read === true,
      link: typeof x.link === 'string' && x.link.startsWith('/') && !x.link.startsWith('//') ? x.link : null,
      canAnswer: x.canAnswer === true,
      answer: x.answer && typeof x.answer === 'object' ? { status: String(x.answer.status || ''), message: typeof x.answer.message === 'string' ? x.answer.message : '' } : null,
    })),
    unread: Math.max(0, Math.floor(Number(d.unread) || 0)),
    more: d.more === true,
    next: Number.isFinite(d.next) ? d.next : null,
    warnings: warnings.map((w) => ({ id: String(w.id || ''), by: typeof w.by === 'string' ? w.by : 'Staff', text: w.text, created: Number(w.created) || 0 })),
  };
}

export function answerText(answer) {
  if (!answer) return '';
  if (answer.status === 'pending') return 'Waiting for YapOS…';
  return answer.message || (answer.status === 'done' ? 'Done.' : "YapOS couldn't do that.");
}

function listSkeleton() {
  return loadingRegion('Loading your inbox', h('ul', { class: 'inbox-list' },
    ...Array.from({ length: 4 }, () => h('li', { class: 'inbox-item' }, skeleton('skeleton-text skeleton-w-50'), skeleton('skeleton-text skeleton-w-70')))));
}

export function renderInbox(ctx) {
  const { api, main } = ctx;
  ctx.setChrome({ variant: 'plain', section: 'inbox', crumbs: [{ label: 'Servers', href: '/servers' }, { label: 'Inbox' }] });
  const body = h('div', { class: 'inbox-wrap' });
  const tools = h('div', { class: 'inbox-tools' });
  main.replaceChildren(h('div', { class: 'page page-narrow inbox-page' },
    pageHeader({ title: 'Inbox', description: 'Clan invites, clan news, gifts and badges. Notifications are kept for 90 days.', actions: tools }),
    body));

  let view = null;
  let polls = 0;
  let pollTimer = null;
  ctx.signal?.addEventListener?.('abort', () => clearTimeout(pollTimer));

  const setUnread = (n) => {
    if (view) view.unread = n;
    inboxCountChanged(n);
  };

  async function call(method, path, payload) {
    try {
      return await api.request(method, path, { body: payload, signal: ctx.signal });
    } catch (err) {
      if (ctx.signal?.aborted) return null;
      toast(err instanceof ApiError ? err.message : 'That did not work. Try again.', { tone: 'danger', title: "Couldn't do that" });
      return null;
    }
  }

  async function markRead(ids) {
    const data = await call('POST', `${INBOX_API}/read`, { ids });
    if (!data) return;
    for (const item of view.items) if (ids.includes(item.id)) item.read = true;
    setUnread(data.unread);
    paint();
  }

  async function markAll() {
    const data = await call('POST', `${INBOX_API}/read`, { all: true });
    if (!data) return;
    for (const item of view.items) item.read = true;
    setUnread(data.unread);
    paint();
  }

  async function clearRead() {
    const data = await call('POST', `${INBOX_API}/clear`, {});
    if (!data) return;
    view.items = view.items.filter((x) => !x.read);
    setUnread(data.unread);
    paint();
  }

  async function remove(item) {
    const data = await call('DELETE', `${INBOX_API}/${encodeURIComponent(item.id)}`);
    if (!data) return;
    view.items = view.items.filter((x) => x.id !== item.id);
    setUnread(data.unread);
    paint();
  }

  async function answer(item, choice) {
    item.busy = true;
    paint();
    const data = await call('POST', `${INBOX_API}/${encodeURIComponent(item.id)}/answer`, { answer: choice });
    item.busy = false;
    if (data && data.action) {
      item.answer = { status: data.action.status === 'pending' ? 'pending' : data.action.status, message: data.action.message || '' };
      item.canAnswer = false;
      if (!item.read) setUnread(Math.max(0, view.unread - 1));
      item.read = true;
      polls = 0;
      watchAnswers();
    }
    paint();
  }

  function watchAnswers() {
    clearTimeout(pollTimer);
    if (!view || !view.items.some((x) => x.answer && x.answer.status === 'pending') || polls >= ANSWER_POLLS) return;
    pollTimer = setTimeout(async () => {
      polls += 1;
      try {
        const fresh = readInbox(await api.get(INBOX_API, { signal: ctx.signal }));
        if (ctx.signal?.aborted) return;
        for (const item of view.items) {
          const next = fresh.items.find((x) => x.id === item.id);
          if (!next || !item.answer || item.answer.status !== 'pending' || !next.answer || next.answer.status === 'pending') continue;
          item.answer = next.answer;
          toast(answerText(next.answer), { tone: next.answer.status === 'done' ? 'success' : 'danger', title: next.answer.status === 'done' ? 'Done' : "Couldn't do that" });
        }
        paint();
      } catch {
        if (ctx.signal?.aborted) return;
      }
      watchAnswers();
    }, ANSWER_POLL_MS);
  }

  async function loadMore() {
    if (!view || !view.more || view.loading) return;
    view.loading = true;
    paint();
    try {
      const next = readInbox(await api.get(`${INBOX_API}?before=${encodeURIComponent(view.next)}`, { signal: ctx.signal }));
      view.items.push(...next.items.filter((x) => !view.items.some((y) => y.id === x.id)));
      view.more = next.more;
      view.next = next.next;
    } catch (err) {
      if (!ctx.signal?.aborted) toast(err instanceof ApiError ? err.message : 'That did not work. Try again.', { tone: 'danger', title: "Couldn't load more" });
    }
    view.loading = false;
    paint();
  }

  function itemRow(item) {
    const answerLine = item.answer ? h('p', { class: ['inbox-answer', `is-${item.answer.status}`], attrs: { role: 'status' }, text: answerText(item.answer) }) : null;
    const actions = h('div', { class: 'inbox-item-actions' },
      item.canAnswer ? button({ label: 'Accept', icon: 'check', variant: 'primary', size: 'sm', disabled: Boolean(item.busy), onClick: () => answer(item, 'accept') }) : null,
      item.canAnswer ? button({ label: 'Decline', size: 'sm', disabled: Boolean(item.busy), onClick: () => answer(item, 'decline') }) : null,
      item.link ? linkButton({ label: item.kind.startsWith('clan_') ? 'Open clans' : 'Open', href: item.link, size: 'sm', icon: 'external' }) : null,
      item.read ? null : button({ label: 'Mark read', size: 'sm', icon: 'check', onClick: () => markRead([item.id]) }),
      button({ icon: 'trash', size: 'sm', ariaLabel: `Delete "${item.title}"`, onClick: () => remove(item) }));
    return h('li', { class: ['inbox-item', item.read ? 'is-read' : 'is-unread'], dataset: { id: item.id, kind: item.kind } },
      h('span', { class: 'inbox-item-icon', attrs: { 'aria-hidden': 'true' } }, icon(kindIcon(item.kind), { size: 16 })),
      h('div', { class: 'inbox-item-main' },
        h('p', { class: 'inbox-item-title' },
          item.read ? null : h('span', { class: 'sr-only', text: 'Unread: ' }),
          h('span', { text: item.title })),
        item.body ? h('p', { class: 'inbox-item-body', text: item.body }) : null,
        answerLine,
        h('p', { class: 'inbox-item-time', text: relativeTime(item.created) })),
      actions);
  }

  function paint() {
    if (!view) return;
    replace(tools,
      button({ label: 'Mark all read', icon: 'check', size: 'sm', disabled: !view.items.some((x) => !x.read), onClick: markAll }),
      button({ label: 'Clear read', icon: 'trash', size: 'sm', disabled: !view.items.some((x) => x.read), onClick: clearRead }));
    const list = view.items.length
      ? h('ul', { class: 'inbox-list', attrs: { 'aria-label': 'Notifications' } }, ...view.items.map(itemRow))
      : emptyState({ icon: 'bell', title: 'Nothing here yet', body: 'Clan invites, clan news, gifts and new badges show up here.', compact: true });
    const more = view.more ? h('div', { class: 'inbox-more' }, button({ label: view.loading ? 'Loading…' : 'Load older', disabled: Boolean(view.loading), onClick: loadMore })) : null;
    const warnings = view.warnings.length
      ? card({ title: 'Staff warnings from YapOS Party', icon: 'alert', className: 'inbox-warnings' },
        h('ul', { class: 'inbox-list' }, ...view.warnings.map((w) => h('li', { class: 'inbox-item is-read' },
          h('span', { class: 'inbox-item-icon', attrs: { 'aria-hidden': 'true' } }, icon('alert', { size: 16 })),
          h('div', { class: 'inbox-item-main' },
            h('p', { class: 'inbox-item-title', text: w.text }),
            h('p', { class: 'inbox-item-time', text: `${w.by} · ${relativeTime(w.created)}` }))))))
      : null;
    replace(body, card({ title: view.unread ? `${view.unread} unread` : 'All caught up', icon: 'bell' }, list, more), warnings);
  }

  mountAsync(body, {
    signal: ctx.signal,
    skeleton: listSkeleton,
    load: ({ signal }) => api.get(INBOX_API, { signal }),
    render: (data) => {
      view = readInbox(data);
      setUnread(view.unread);
      paint();
      watchAnswers();
    },
  });
}
