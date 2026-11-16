import { h, nextId, replace, trapFocus } from '../dom.js';
import { icon } from '../icons.js';
import { button, copyText, emptyState, errorState, loadingRegion, setBusy, skeleton, toast } from '../ui.js';
import { formatNumber, relativeTime } from '../format.js';
import { ApiError, isAbort } from '../api.js';
import { loginUrl } from '../router.js';
import { debounce } from '../kit.js';
import { publicFrame } from '../public-frame.js';
import { normalizeBrowse, PACK_SORTS } from '../community-data.js';
import { packSummary } from './packs.js';

export const BROWSE_API = '/api/packs/browse';
export const REPORT_MAX = 300;
const REASONS = [
  ['rude', 'Rude, hateful or adult words'],
  ['spam', 'Spam or junk'],
  ['personal', "Someone's personal info"],
  ['other', 'Something else'],
];

export function browseUrl({ sort = 'top', q = '', page = 1 } = {}) {
  const params = new URLSearchParams({ sort: sort === 'new' ? 'new' : 'top' });
  const query = String(q || '').trim().slice(0, 60);
  if (query) params.set('q', query);
  if (Number.isInteger(page) && page > 1) params.set('page', String(page));
  return `${BROWSE_API}?${params}`;
}

export function packApi(code, action) {
  return `/api/packs/${encodeURIComponent(code)}/${action}`;
}

export function reportReason(reason, note) {
  const label = (REASONS.find(([v]) => v === reason) || REASONS[REASONS.length - 1])[1];
  const extra = String(note || '').replace(/\s+/g, ' ').trim();
  return (extra ? `${label}: ${extra}` : label).slice(0, REPORT_MAX);
}

export function reportDialog(pack) {
  return new Promise((resolve) => {
    const titleId = nextId('dlg');
    const textId = nextId('report-text');
    const previous = document.activeElement;
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKey, true);
      root.remove();
      document.body.classList.remove('has-modal');
      if (previous && previous.focus && previous.isConnected) previous.focus();
      resolve(v);
    };
    let reason = REASONS[0][0];
    const choices = h('div', { class: 'report-reasons', attrs: { role: 'radiogroup', 'aria-label': 'What is wrong with it?' } },
      ...REASONS.map(([value, label], i) => {
        const input = h('input', { type: 'radio', name: titleId, value, checked: i === 0 });
        input.addEventListener('change', () => {
          if (input.checked) reason = value;
        });
        return h('label', { class: 'report-reason' }, input, h('span', { text: label }));
      }));
    const text = h('textarea', { id: textId, class: 'input textarea', rows: 3, maxLength: REPORT_MAX, placeholder: 'Anything that helps (optional)' });
    const cancel = button({ label: 'Cancel', onClick: () => finish(null) });
    const ok = button({ label: 'Send report', icon: 'flag', variant: 'danger', onClick: () => finish({ reason: reportReason(reason, text.value) }) });
    const panel = h('div', { class: 'dialog-panel', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId } },
      h('h2', { class: 'dialog-title', id: titleId, text: `Report ${pack.name}?` }),
      h('p', { class: 'dialog-body', text: 'The YapOS team looks at every report. The pack stays up until they decide.' }),
      choices,
      h('label', { class: 'field-label', htmlFor: textId, text: 'Details' }),
      text,
      h('div', { class: 'dialog-actions' }, cancel, ok));
    const root = h('div', { class: 'dialog-root' }, h('div', { class: 'dialog-overlay', on: { click: () => finish(null) } }), panel);
    function onKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        finish(null);
      } else trapFocus(panel, e);
    }
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(root);
    document.body.classList.add('has-modal');
    panel.querySelector('input')?.focus();
  });
}

function browseSkeleton() {
  return loadingRegion('Loading word packs', h('ul', { class: 'browse-list' }, ...Array.from({ length: 4 }, () => h('li', { class: 'browse-item is-skeleton' },
    h('span', { class: 'browse-main' }, skeleton('skeleton-text skeleton-w-40'), skeleton('skeleton-text skeleton-w-60'))))));
}

export function renderPacksBrowse(root, ctx) {
  const { api, signal } = ctx;
  const frame = publicFrame(root, { current: '/packs/browse' });
  frame.setUser(null);
  ctx.setTitle('Browse word packs');
  let user = null;
  ctx.getUser?.().then((u) => {
    if (signal.aborted) return;
    user = u || null;
    frame.setUser(user);
  }).catch(() => {});

  const asked = new URLSearchParams(window.location.search);
  let sort = asked.get('sort') === 'new' ? 'new' : 'top';
  let query = (asked.get('q') || '').slice(0, 60);
  let view = normalizeBrowse(null);
  let token = 0;

  const search = h('input', { type: 'search', class: 'input', placeholder: 'Search packs', value: query, maxLength: 60, attrs: { 'aria-label': 'Search packs' } });
  const sortBar = h('div', { class: 'segmented', attrs: { role: 'group', 'aria-label': 'Sort packs' } });
  const list = h('div', { class: 'browse-wrap' });

  replace(frame.content,
    h('div', { class: 'public-hero' },
      h('span', { class: 'public-crest', attrs: { 'aria-hidden': 'true' } }, icon('folder', { size: 30 })),
      h('div', { class: 'public-hero-text' },
        h('p', { class: 'public-eyebrow', text: 'YapOS Party' }),
        h('h1', { class: 'public-title', text: 'Word packs' }),
        h('p', { class: 'public-lead', text: 'Packs other players made public. Copy a code and type it into the game settings in a YapOS Party call.' }))),
    h('div', { class: 'public-card browse-card' },
      h('div', { class: 'browse-tools' },
        h('div', { class: 'input-shell has-lead browse-search' }, icon('search', { size: 14, className: 'input-lead' }), search),
        sortBar),
      list));

  function syncUrl() {
    const url = new URL(window.location.href);
    if (sort === 'top') url.searchParams.delete('sort');
    else url.searchParams.set('sort', sort);
    if (query) url.searchParams.set('q', query);
    else url.searchParams.delete('q');
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}`);
  }

  function drawSort() {
    replace(sortBar, ...PACK_SORTS.map(([value, label]) => {
      const b = button({ label, size: 'sm', variant: sort === value ? 'segment-active' : 'segment', onClick: () => {
        if (sort === value) return;
        sort = value;
        drawSort();
        load();
      } });
      b.setAttribute('aria-pressed', sort === value ? 'true' : 'false');
      return b;
    }));
  }

  function needLogin(what) {
    toast(`Log in with Yapin' to ${what}.`, { tone: 'info', title: 'Log in first' });
    window.location.assign(loginUrl(`${window.location.pathname}${window.location.search}`));
  }

  function likeButton(p) {
    const count = h('span', { class: 'like-count', text: formatNumber(p.likes) });
    const btn = h('button', {
      type: 'button',
      class: ['btn', 'btn-secondary', 'btn-sm', 'like-btn', p.liked ? 'is-liked' : ''],
      attrs: { 'aria-pressed': p.liked ? 'true' : 'false', 'aria-label': `${p.liked ? 'Unlike' : 'Like'} ${p.name}, ${formatNumber(p.likes)} ${p.likes === 1 ? 'like' : 'likes'}` },
    }, icon('heart', { size: 14 }), count);
    const paint = () => {
      btn.classList.toggle('is-liked', p.liked);
      btn.setAttribute('aria-pressed', p.liked ? 'true' : 'false');
      btn.setAttribute('aria-label', `${p.liked ? 'Unlike' : 'Like'} ${p.name}, ${formatNumber(p.likes)} ${p.likes === 1 ? 'like' : 'likes'}`);
      count.textContent = formatNumber(p.likes);
    };
    btn.addEventListener('click', async () => {
      if (!user) return needLogin('like packs');
      const before = { liked: p.liked, likes: p.likes };
      p.liked = !p.liked;
      p.likes = Math.max(0, p.likes + (p.liked ? 1 : -1));
      paint();
      btn.disabled = true;
      try {
        const data = await api.post(packApi(p.code, 'like'), {}, { signal, allow401: true });
        if (signal.aborted) return;
        if (data && typeof data.liked === 'boolean') p.liked = data.liked;
        if (data && Number.isInteger(data.likes) && data.likes >= 0) p.likes = data.likes;
      } catch (err) {
        if (isAbort(err) || signal.aborted) return;
        p.liked = before.liked;
        p.likes = before.likes;
        if (err instanceof ApiError && err.status === 401) {
          user = null;
          paint();
          return needLogin('like packs');
        }
        toast(err instanceof ApiError ? err.message : 'That did not work. Try again.', { tone: 'danger', title: "Couldn't save your like" });
      }
      btn.disabled = false;
      paint();
    });
    return btn;
  }

  async function report(p, btn) {
    if (!user) return needLogin('report packs');
    const answer = await reportDialog(p);
    if (!answer || signal.aborted) return;
    setBusy(btn, true, 'Sending');
    try {
      const data = await api.post(packApi(p.code, 'report'), answer, { signal, allow401: true });
      if (signal.aborted) return;
      setBusy(btn, false);
      btn.disabled = true;
      toast(data?.already ? `You already reported ${p.name}. The team will look at it.` : `Thanks. ${p.name} is reported.`, { title: 'Report sent' });
    } catch (err) {
      if (isAbort(err) || signal.aborted) return;
      setBusy(btn, false);
      if (err instanceof ApiError && err.status === 401) return needLogin('report packs');
      toast(err instanceof ApiError ? err.message : 'That did not work. Try again.', { tone: 'danger', title: "Couldn't send the report" });
    }
  }

  function copyButtonFor(p) {
    const btn = button({ label: p.code, icon: 'copy', size: 'sm', className: 'browse-code', ariaLabel: `Copy the code ${p.code}` });
    btn.addEventListener('click', async () => {
      const ok = await copyText(p.code);
      if (ok) toast(`Copied ${p.code}. Type it into the game settings in YapOS Party.`);
      else toast(`Couldn't copy automatically. The code is ${p.code}.`, { tone: 'danger' });
    });
    return btn;
  }

  function item(p) {
    const meta = [packSummary(p), p.author ? `by ${p.author}` : '', p.created ? relativeTime(p.created) : ''].filter(Boolean).join(' · ');
    return h('li', { class: 'browse-item', dataset: { code: p.code } },
      h('span', { class: 'browse-main' },
        h('span', { class: 'browse-name', text: p.name }),
        h('span', { class: 'browse-meta', text: meta })),
      h('span', { class: 'browse-actions' },
        likeButton(p),
        copyButtonFor(p),
        button({ label: 'Report', icon: 'flag', size: 'sm', variant: 'ghost', ariaLabel: `Report ${p.name}`, onClick: (e) => report(p, e.currentTarget) })));
  }

  function draw() {
    if (!view.packs.length) {
      replace(list, emptyState({
        icon: 'folder',
        title: query ? 'No packs match that' : 'No public packs yet',
        body: query ? 'Try a different word, or clear the search.' : 'Make a pack on the Word packs page and switch on Public to share it here.',
        compact: true,
      }));
      return;
    }
    const more = view.next ? button({ label: 'Show more', icon: 'chevron-down', size: 'sm', onClick: (e) => loadMore(e.currentTarget) }) : null;
    replace(list, h('ul', { class: 'browse-list' }, ...view.packs.map(item)), more ? h('div', { class: 'browse-more' }, more) : null);
  }

  async function load() {
    token += 1;
    const mine = token;
    syncUrl();
    replace(list, browseSkeleton());
    try {
      const data = await api.get(browseUrl({ sort, q: query }), { signal, allow401: true });
      if (signal.aborted || mine !== token) return;
      view = normalizeBrowse(data);
      draw();
    } catch (err) {
      if (isAbort(err) || signal.aborted || mine !== token) return;
      replace(list, errorState({ title: "Couldn't load packs", body: err.message, onRetry: load, compact: true }));
    }
  }

  async function loadMore(btn) {
    const mine = token;
    setBusy(btn, true, 'Loading');
    try {
      const data = normalizeBrowse(await api.get(browseUrl({ sort, q: query, page: view.next }), { signal, allow401: true }));
      if (signal.aborted || mine !== token) return;
      const seen = new Set(view.packs.map((p) => p.code));
      view = { packs: view.packs.concat(data.packs.filter((p) => !seen.has(p.code))), page: data.page, next: data.next };
      draw();
    } catch (err) {
      if (isAbort(err) || signal.aborted) return;
      setBusy(btn, false);
      toast(err instanceof ApiError ? err.message : 'That did not work. Try again.', { tone: 'danger', title: "Couldn't load more packs" });
    }
  }

  const onSearch = debounce(() => {
    const next = search.value.trim().slice(0, 60);
    if (next === query) return;
    query = next;
    load();
  }, 350);
  search.addEventListener('input', onSearch);
  signal.addEventListener?.('abort', () => onSearch.cancel(), { once: true });

  drawSort();
  load();
}
