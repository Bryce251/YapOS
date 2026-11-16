import { h, replace } from '../dom.js';
import { avatar, badge, button, card, confirmDialog, emptyState, linkButton, loadingRegion, pageHeader, setBusy, skeleton, toast } from '../ui.js';
import { ApiError } from '../api.js';
import { mountAsync } from './common.js';
import { state } from '../state.js';
import { formatDate, relativeTime } from '../format.js';
import { decodeStroke, paintInk } from '../../activity/js/games/ink.js';
import { replayOf } from '../replay-model.js';
import { createReplayPlayer } from './party-replay.js';

export const REPORTS_PATH = '/api/party/reports';
export const BANS_PATH = '/api/party/bans';
export const PACK_REPORTS_PATH = '/api/party/pack-reports';
export const GAME_NAMES = Object.freeze({
  draw: 'Draw & Guess',
  odd: 'Odd One Out',
  telephone: 'Draw Telephone',
  hottakes: 'Hot Takes',
  truths: 'Two Truths and a Lie',
  chain: 'Word Chain',
  emoji: 'Emoji Decode',
  scramble: 'Scramble Race',
  trivia: 'Trivia',
  wyr: 'Would You Rather',
  hive: 'Letter Hive',
  bluff: 'Bluff',
  sketchduel: 'Sketch Duel',
  story: 'Story Builder',
  hangman: 'Hangman Royale',
  pixel: 'Pixel Art',
});
export const ART_SCALE = 2;
const FILTERS = [['open', 'Open'], ['dismissed', 'Dismissed'], ['all', 'All']];
const KINDS = [['all', 'All'], ['drawing', 'Drawings'], ['text', 'Text'], ['pack', 'Packs']];
const SNIPPET_MAX = 80;

const str = (v) => (typeof v === 'string' && v ? v : '');

function readProfile(p) {
  if (!p || typeof p !== 'object') return null;
  return { username: str(p.username), display_name: str(p.display_name), avatar: str(p.avatar) };
}

function readPackReport(r) {
  if (!r || typeof r !== 'object' || typeof r.id !== 'string') return null;
  const pk = r.pack && typeof r.pack === 'object' ? r.pack : null;
  const owner = pk && pk.owner && typeof pk.owner === 'object' ? pk.owner : {};
  const p = r.reporter && typeof r.reporter === 'object' ? r.reporter : {};
  return {
    id: r.id,
    kind: 'pack',
    game: '',
    word: '',
    text: str(r.reason),
    context: '',
    created: Number(r.created) || 0,
    status: r.status === 'dismissed' ? 'dismissed' : 'open',
    ink: [],
    pack: {
      code: str(pk?.code) || str(r.code),
      name: str(pk?.name),
      gone: !pk,
      words: Array.isArray(pk?.words) ? pk.words.filter((w) => typeof w === 'string').slice(0, 60) : [],
      public: pk?.public === true,
      blocked: pk?.blocked === true,
    },
    drawer: { id: str(owner.id), name: '', username: str(owner.username), profile: null, banned: false, role: '' },
    reporter: { id: str(p.id), name: str(p.name), profile: null },
  };
}

function readReport(r) {
  if (!r || typeof r !== 'object' || typeof r.id !== 'string') return null;
  const d = r.drawer && typeof r.drawer === 'object' ? r.drawer : {};
  const p = r.reporter && typeof r.reporter === 'object' ? r.reporter : {};
  const kind = r.kind === 'text' ? 'text' : 'drawing';
  return {
    id: r.id,
    kind,
    game: str(r.game),
    word: str(r.word),
    text: kind === 'text' ? str(r.text) : '',
    context: kind === 'text' ? str(r.context) : '',
    created: Number(r.created) || 0,
    status: r.status === 'dismissed' ? 'dismissed' : 'open',
    ink: kind === 'drawing' && Array.isArray(r.ink) ? r.ink.filter((s) => typeof s === 'string') : [],
    replay: kind === 'drawing' && r.replay && typeof r.replay === 'object' ? r.replay : null,
    drawer: {
      id: str(d.id),
      name: str(d.name),
      username: str(d.username),
      profile: readProfile(d.profile),
      banned: d.banned === true,
      role: d.role === 'owner' || d.role === 'admin' ? d.role : '',
    },
    reporter: { id: str(p.id), name: str(p.name), profile: readProfile(p.profile) },
  };
}

export function readReports(data, kind = 'all') {
  const read = kind === 'pack' ? readPackReport : readReport;
  return {
    reports: Array.isArray(data?.reports) ? data.reports.map(read).filter(Boolean) : [],
    next: typeof data?.next === 'string' && data.next ? data.next : null,
    open: Number.isInteger(data?.open) && data.open >= 0 ? data.open : 0,
    role: data?.role === 'owner' ? 'owner' : 'admin',
  };
}

export function readBans(data) {
  const bans = Array.isArray(data?.bans) ? data.bans.filter((b) => b && typeof b.id === 'string').map((b) => ({
    id: b.id,
    name: str(b.name),
    username: str(b.username),
    display_name: str(b.display_name),
    avatar: str(b.avatar),
    reason: str(b.reason),
    banned_at: Number(b.banned_at) || 0,
  })) : [];
  return { bans, max: Number.isInteger(data?.max) && data.max > 0 ? data.max : 1000 };
}

export function decodeInk(list) {
  return (Array.isArray(list) ? list : []).map(decodeStroke).filter(Boolean);
}

export function gameName(id, kind = 'drawing') {
  if (kind === 'pack') return 'Word pack';
  return GAME_NAMES[id] || (kind === 'text' ? 'YapOS Party' : 'Drawing game');
}

export function snippet(text, max = SNIPPET_MAX) {
  const chars = Array.from(str(text));
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('');
}

export function banReason(r) {
  if (r.kind === 'pack') return `Reported word pack${r.pack?.name ? ` ${r.pack.name}` : ''}${r.pack?.code ? ` (${r.pack.code})` : ''}`;
  if (r.kind === 'text') return `Reported text in ${gameName(r.game, 'text')}${r.text ? `: "${snippet(r.text)}"` : ''}`;
  return `Reported drawing in ${gameName(r.game)}${r.word ? ` (word: ${r.word})` : ''}`;
}

export function paintReport(canvas, ink) {
  const ctx = canvas && typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
  if (!ctx) return false;
  paintInk(ctx, decodeInk(ink), ART_SCALE);
  return true;
}

function staffOnlyView() {
  return emptyState({
    icon: 'lock',
    title: 'Only party staff can open this',
    body: 'Reports from YapOS Party go to the owner and party admins. If you think you should see them, ask the owner to make you a party admin.',
    action: linkButton({ label: 'Back to your servers', href: '/servers', icon: 'chevron-left' }),
  });
}

function listSkeleton() {
  return loadingRegion('Loading reports', h('ul', { class: 'report-list' }, ...Array.from({ length: 2 }, () => h('li', { class: 'report-item is-skeleton' },
    skeleton('report-art skeleton-art'),
    h('div', { class: 'report-info' }, skeleton('skeleton-text skeleton-w-40'), skeleton('skeleton-text skeleton-w-60'), skeleton('skeleton-text skeleton-w-50'))))));
}

const drawerName = (d) => d.name || d.profile?.display_name || d.username || 'this player';

function person(label, p, extra = []) {
  const known = p.profile && (p.profile.username || p.profile.display_name) ? p.profile : null;
  const claimed = p.username ? `@${p.username}` : '';
  return h('div', { class: 'report-person' },
    h('dt', { class: 'report-label', text: label }),
    h('dd', { class: 'report-who' },
      avatar({ name: p.name || p.id, url: known?.avatar || '', id: p.id, size: 'sm' }),
      h('span', { class: 'report-who-main' },
        h('span', { class: 'report-who-name' }, h('span', { text: p.name || 'Unknown player' }), claimed ? h('span', { class: 'report-who-handle', text: claimed }) : null, ...extra),
        h('code', { class: 'report-who-id', text: p.id }),
        known ? h('span', { class: 'report-who-known', text: `Yapin' knows this id as ${[known.display_name, known.username ? `@${known.username}` : ''].filter(Boolean).join(' ')}` }) : null)));
}

export function renderPartyReports(ctx) {
  const { api, main } = ctx;
  ctx.setChrome({ variant: 'plain', section: 'party-reports', crumbs: [{ label: 'Servers', href: '/servers' }, { label: 'Party reports' }] });
  if (!state.partyAdmin && !state.partyOwner) {
    main.replaceChildren(h('div', { class: 'page page-narrow' }, staffOnlyView()));
    return;
  }

  let filter = 'open';
  let kind = 'all';
  let view = readReports(null);
  let bans = readBans(null);
  const players = [];
  if (ctx.signal && typeof ctx.signal.addEventListener === 'function') ctx.signal.addEventListener('abort', () => stopPlayers());

  const openCount = h('span', { class: 'party-count' });
  const filterBar = h('div', { class: 'segmented', attrs: { role: 'group', 'aria-label': 'Show reports' } });
  const kindBar = h('div', { class: 'segmented', attrs: { role: 'group', 'aria-label': 'Show what was reported' } });
  const listBody = h('div', { class: 'report-wrap' });
  const banCount = h('span', { class: 'party-count' });
  const banBody = h('div', { class: 'party-list-wrap' });
  const page = h('div', { class: 'page page-narrow party-page report-page' },
    pageHeader({
      title: 'Party reports',
      description: 'When players flag a drawing, something another player wrote or a public word pack in YapOS Party, a copy lands here with the name of whoever made it. Ban someone to stop them joining games in every server. They can still watch.',
      actions: state.partyOwner ? linkButton({ label: 'Party admins', href: '/party', icon: 'crown', size: 'sm' }) : null,
    }),
    card({ title: 'Reports', icon: 'flag', actions: h('div', { class: 'report-tools' }, openCount, kindBar, filterBar) }, listBody),
    card({ title: 'Banned from Party', icon: 'ban', actions: banCount }, banBody));
  main.replaceChildren(page);

  function segments(bar, list, current, pick) {
    replace(bar, ...list.map(([v, label]) => {
      const b = button({ label, size: 'sm', variant: current === v ? 'segment-active' : 'segment', onClick: () => {
        if (current === v) return;
        pick(v);
        drawFilters();
        loadReports();
      } });
      b.setAttribute('aria-pressed', current === v ? 'true' : 'false');
      return b;
    }));
  }

  function drawFilters() {
    segments(filterBar, FILTERS, filter, (v) => { filter = v; });
    segments(kindBar, KINDS, kind, (v) => { kind = v; });
  }

  function failToast(err, title) {
    toast(err instanceof ApiError ? err.message : 'That did not work. Try again.', { tone: 'danger', title });
  }

  function denied() {
    state.partyAdmin = false;
    replace(main, h('div', { class: 'page page-narrow' }, staffOnlyView()));
  }

  function canBan(d) {
    if (d.banned || d.role === 'owner') return false;
    if (d.role === 'admin' && view.role !== 'owner') return false;
    return Boolean(d.id);
  }

  function reportItem(r) {
    const d = r.drawer;
    const isText = r.kind === 'text';
    const isPack = r.kind === 'pack';
    let art;
    if (isPack) {
      art = h('figure', { class: 'report-quote report-pack' },
        h('blockquote', { class: 'report-quote-text' },
          h('span', { class: 'report-pack-name', text: r.pack.gone ? 'This pack was deleted' : r.pack.name || 'Word pack' }),
          r.pack.code ? h('code', { class: 'pack-code-text', text: r.pack.code }) : null),
        r.pack.words.length ? h('p', { class: 'report-pack-words', text: r.pack.words.join(', ') }) : null,
        h('figcaption', { class: 'report-quote-context' }, h('span', { class: 'report-label', text: 'Why' }), h('span', { text: r.text || 'No reason given.' })));
    } else if (isText) {
      art = h('figure', { class: 'report-quote' },
        h('blockquote', { class: 'report-quote-text', text: r.text || 'No text was sent with this report.' }),
        r.context ? h('figcaption', { class: 'report-quote-context' }, h('span', { class: 'report-label', text: 'Context' }), h('span', { text: r.context })) : null);
    } else {
      const replay = replayOf(r);
      if (replay) {
        const player = createReplayPlayer({
          replay,
          drawerId: d.id,
          label: `${r.game === 'pixel' ? 'picture' : 'drawing'} by ${drawerName(d)}`,
          onBan: (a, btn) => banArtist(r, a, btn),
          canBan: (a) => canBan({ id: a.id, banned: a.banned, role: a.role }),
        });
        players.push(player);
        art = h('div', { class: 'report-replay' }, player.el);
      } else {
        art = h('div', { class: 'report-art is-empty' }, h('span', { class: 'muted', text: 'No drawing was sent with this report.' }));
      }
    }
    const tags = isPack
      ? [badge('Word pack', 'accent', 'folder'), r.pack.blocked ? badge('Hidden from browser', 'danger', 'eye-off') : r.pack.public ? badge('Public', 'neutral', 'globe') : badge('Not public', 'neutral')]
      : [badge(gameName(r.game, r.kind), 'accent'), badge(isText ? 'Text' : 'Drawing', 'neutral', isText ? 'message' : 'palette')];
    if (r.status === 'dismissed') tags.push(badge('Dismissed', 'neutral'));
    if (d.banned) tags.push(badge('Banned', 'danger', 'ban'));
    if (d.role === 'owner') tags.push(badge('Owner', 'neutral', 'crown'));
    else if (d.role === 'admin') tags.push(badge('Party admin', 'neutral', 'crown'));
    const actions = [];
    if (canBan(d)) actions.push(button({ label: 'Ban from Party', icon: 'ban', variant: 'danger', size: 'sm', ariaLabel: `Ban ${drawerName(d)} from YapOS Party`, onClick: (e) => ban(r, e.currentTarget) }));
    if (isPack && !r.pack.gone && !r.pack.blocked) actions.push(button({ label: 'Hide from browser', icon: 'eye-off', variant: 'danger', size: 'sm', onClick: (e) => packAction(r, 'hide', e.currentTarget) }));
    if (isPack && !r.pack.gone && r.pack.blocked) actions.push(button({ label: 'Put back', icon: 'refresh', size: 'sm', onClick: (e) => packAction(r, 'restore', e.currentTarget) }));
    if (r.status === 'open') actions.push(button({ label: 'Dismiss', icon: 'check', size: 'sm', onClick: (e) => dismiss(r, e.currentTarget) }));
    if (!isPack) actions.push(button({ label: 'Delete', icon: 'trash', size: 'sm', onClick: (e) => remove(r, e.currentTarget) }));
    const note = d.role === 'admin' && view.role !== 'owner'
      ? h('p', { class: 'report-note', text: 'Only the owner can ban a party admin.' })
      : null;
    return h('li', { class: ['report-item', isText || isPack ? 'is-text' : '', art.classList.contains('report-replay') ? 'has-replay' : '', r.status === 'dismissed' ? 'is-dismissed' : ''], dataset: { id: r.id, kind: r.kind } },
      art,
      h('div', { class: 'report-info' },
        h('div', { class: 'report-head' }, ...tags, h('time', { class: 'report-time', attrs: { datetime: new Date(r.created || 0).toISOString(), title: formatDate(r.created) }, text: relativeTime(r.created) })),
        h('dl', { class: 'report-facts' },
          person(isPack ? 'Made it' : isText ? 'Wrote it' : 'Drew it', d),
          person('Reported by', r.reporter),
          !isText && r.word ? h('div', { class: 'report-person' }, h('dt', { class: 'report-label', text: 'Word' }), h('dd', { class: 'report-word', text: r.word })) : null),
        h('p', { class: 'report-note', text: isPack
          ? 'A signed-in player reported this public pack. Hiding it takes it off the pack browser for everyone, and its code keeps working in games.'
          : isText
          ? "The game that saw these words sent this report, so treat names and ids as claims. The line under an id shows what Yapin' says, when we know it."
          : "Names and ids come from the reporter's game, so treat them as claims. The line under an id shows what Yapin' says, when we know it." }),
        note,
        h('div', { class: 'report-actions' }, ...actions)));
  }

  function stopPlayers() {
    for (const p of players.splice(0)) p.destroy();
  }

  function drawReports() {
    stopPlayers();
    openCount.textContent = `${view.open} open`;
    if (!view.reports.length) {
      replace(listBody, emptyState({
        icon: 'flag',
        title: filter === 'open' ? 'No open reports' : 'No reports here',
        body: filter === 'open' ? `Nothing needs a look right now. ${kind === 'pack' ? 'Reported public word packs' : kind === 'text' ? 'Flagged guesses, answers and other words' : kind === 'drawing' ? 'Flagged drawings' : 'Flagged drawings and words'} show up here.` : 'Reports you dismiss stay here for 30 days.',
        compact: true,
      }));
      return;
    }
    const more = view.next ? button({ label: 'Show older reports', icon: 'chevron-down', size: 'sm', onClick: (e) => loadMore(e.currentTarget) }) : null;
    replace(listBody, h('ul', { class: 'report-list' }, ...view.reports.map(reportItem)), more ? h('div', { class: 'report-more' }, more) : null);
  }

  function reportsUrl(before) {
    const q = new URLSearchParams({ status: filter });
    if (kind === 'pack') return `${PACK_REPORTS_PATH}?${q}`;
    if (kind !== 'all') q.set('kind', kind);
    if (before) q.set('before', before);
    return `${REPORTS_PATH}?${q}`;
  }

  async function loadMore(btn) {
    setBusy(btn, true, 'Loading');
    try {
      const data = readReports(await api.get(reportsUrl(view.next), { signal: ctx.signal }), kind);
      if (ctx.signal?.aborted) return;
      const seen = new Set(view.reports.map((r) => r.id));
      view = { ...data, reports: view.reports.concat(data.reports.filter((r) => !seen.has(r.id))) };
      drawReports();
    } catch (err) {
      if (ctx.signal?.aborted) return;
      if (btn?.isConnected) setBusy(btn, false);
      failToast(err, "Couldn't load more");
    }
  }

  function markBanned(id, banned) {
    const key = id.toLowerCase();
    for (const r of view.reports) {
      if (r.drawer.id.toLowerCase() === key) r.drawer.banned = banned;
      for (const a of Array.isArray(r.replay?.authors) ? r.replay.authors : []) if (a && typeof a.id === 'string' && a.id.toLowerCase() === key) a.banned = banned;
    }
  }

  async function banArtist(r, a, btn) {
    const name = a.name || 'this player';
    const ok = await confirmDialog({
      title: `Ban ${name} from YapOS Party?`,
      body: `${name} drew on this canvas too. They won't be able to join YapOS Party games in any server, but they can still watch.${a.role === 'admin' ? ' They also stop being a party admin.' : ''} You can unban them any time.`,
      confirmLabel: 'Ban',
    });
    if (!ok || ctx.signal?.aborted) return;
    if (btn?.isConnected) setBusy(btn, true, 'Banning');
    try {
      const data = await api.post(BANS_PATH, { id: a.id, reason: banReason(r), name: a.name || undefined }, { signal: ctx.signal });
      if (ctx.signal?.aborted) return;
      markBanned(a.id, true);
      drawReports();
      showBans(data);
      toast(`${name} is banned from YapOS Party.`);
    } catch (err) {
      if (ctx.signal?.aborted) return;
      if (btn?.isConnected) setBusy(btn, false);
      if (err instanceof ApiError && err.status === 403 && err.code === 'staff_only') return denied();
      failToast(err, "Couldn't ban them");
    }
  }

  async function ban(r, btn) {
    const d = r.drawer;
    const name = drawerName(d);
    const ok = await confirmDialog({
      title: `Ban ${name} from YapOS Party?`,
      body: `They won't be able to join YapOS Party games in any server, but they can still watch.${d.role === 'admin' ? ' They also stop being a party admin.' : ''} You can unban them any time.`,
      confirmLabel: 'Ban',
    });
    if (!ok || ctx.signal?.aborted) return;
    if (btn?.isConnected) setBusy(btn, true, 'Banning');
    const reason = banReason(r);
    try {
      const data = await api.post(BANS_PATH, { id: d.id, reason, name: d.name || undefined, username: d.username || undefined }, { signal: ctx.signal });
      if (ctx.signal?.aborted) return;
      markBanned(d.id, true);
      if (data?.removedAdmin) for (const x of view.reports) if (x.drawer.id.toLowerCase() === d.id.toLowerCase()) x.drawer.role = '';
      drawReports();
      showBans(data);
      toast(`${name} is banned from YapOS Party.`);
    } catch (err) {
      if (ctx.signal?.aborted) return;
      if (btn?.isConnected) setBusy(btn, false);
      if (err instanceof ApiError && err.status === 403 && err.code === 'staff_only') return denied();
      failToast(err, "Couldn't ban them");
    }
  }

  async function dismiss(r, btn) {
    const ok = await confirmDialog({
      title: 'Dismiss this report?',
      body: 'It moves to Dismissed and is cleared out after 30 days. Nobody is banned.',
      confirmLabel: 'Dismiss',
      tone: 'primary',
    });
    if (!ok || ctx.signal?.aborted) return;
    if (btn?.isConnected) setBusy(btn, true, 'Dismissing');
    try {
      const data = await api.post(`${r.kind === 'pack' ? PACK_REPORTS_PATH : REPORTS_PATH}/${encodeURIComponent(r.id)}/dismiss`, {}, { signal: ctx.signal });
      if (ctx.signal?.aborted) return;
      if (data?.dismissed) view.open = Math.max(0, view.open - 1);
      if (filter === 'open') view.reports = view.reports.filter((x) => x.id !== r.id);
      else r.status = 'dismissed';
      drawReports();
      toast('Report dismissed.');
    } catch (err) {
      if (ctx.signal?.aborted) return;
      if (btn?.isConnected) setBusy(btn, false);
      if (err instanceof ApiError && err.status === 404) {
        view.reports = view.reports.filter((x) => x.id !== r.id);
        drawReports();
      }
      failToast(err, "Couldn't dismiss it");
    }
  }

  async function packAction(r, action, btn) {
    const hide = action === 'hide';
    const name = r.pack.name || r.pack.code || 'this pack';
    const ok = await confirmDialog({
      title: hide ? `Hide ${name} from the pack browser?` : `Put ${name} back on the pack browser?`,
      body: hide ? 'Nobody can find or like it on the browse page. Its code still works in games. Every open report for this pack is dismissed.' : 'If its maker still has it set to public, it shows on the browse page again.',
      confirmLabel: hide ? 'Hide pack' : 'Put back',
      tone: hide ? 'danger' : 'primary',
    });
    if (!ok || ctx.signal?.aborted) return;
    if (btn?.isConnected) setBusy(btn, true, hide ? 'Hiding' : 'Saving');
    try {
      await api.post(`${PACK_REPORTS_PATH}/${encodeURIComponent(r.id)}/${hide ? 'hide' : 'restore'}`, {}, { signal: ctx.signal });
      if (ctx.signal?.aborted) return;
      for (const x of view.reports) {
        if (x.kind !== 'pack' || x.pack.code !== r.pack.code) continue;
        x.pack.blocked = hide;
        if (hide && x.status === 'open') {
          x.status = 'dismissed';
          view.open = Math.max(0, view.open - 1);
        }
      }
      if (hide && filter === 'open') view.reports = view.reports.filter((x) => x.kind !== 'pack' || x.pack.code !== r.pack.code);
      drawReports();
      toast(hide ? `${name} is hidden from the pack browser.` : `${name} can show on the pack browser again.`);
    } catch (err) {
      if (ctx.signal?.aborted) return;
      if (btn?.isConnected) setBusy(btn, false);
      if (err instanceof ApiError && err.status === 403) return denied();
      failToast(err, hide ? "Couldn't hide it" : "Couldn't put it back");
    }
  }

  async function remove(r, btn) {
    const ok = await confirmDialog({
      title: 'Delete this report?',
      body: `The report and the ${r.kind === 'text' ? 'reported words' : 'drawing'} are gone for good. This does not ban or unban anyone.`,
      confirmLabel: 'Delete',
    });
    if (!ok || ctx.signal?.aborted) return;
    if (btn?.isConnected) setBusy(btn, true, 'Deleting');
    try {
      await api.request('DELETE', `${REPORTS_PATH}/${encodeURIComponent(r.id)}`, { signal: ctx.signal });
      if (ctx.signal?.aborted) return;
      if (r.status === 'open') view.open = Math.max(0, view.open - 1);
      view.reports = view.reports.filter((x) => x.id !== r.id);
      drawReports();
      toast('Report deleted.');
    } catch (err) {
      if (ctx.signal?.aborted) return;
      if (btn?.isConnected) setBusy(btn, false);
      failToast(err, "Couldn't delete it");
    }
  }

  async function unban(b, btn) {
    const name = b.display_name || b.name || (b.username ? `@${b.username}` : 'this person');
    const ok = await confirmDialog({
      title: `Unban ${name}?`,
      body: 'They can join YapOS Party games again within about a minute.',
      confirmLabel: 'Unban',
      tone: 'primary',
    });
    if (!ok || ctx.signal?.aborted) return;
    if (btn?.isConnected) setBusy(btn, true, 'Unbanning');
    try {
      const data = await api.request('DELETE', `${BANS_PATH}/${encodeURIComponent(b.id)}`, { signal: ctx.signal });
      if (ctx.signal?.aborted) return;
      markBanned(b.id, false);
      drawReports();
      showBans(data);
      toast(`${name} can play YapOS Party again.`);
    } catch (err) {
      if (ctx.signal?.aborted) return;
      if (btn?.isConnected) setBusy(btn, false);
      failToast(err, "Couldn't unban them");
    }
  }

  function banRow(b) {
    const name = b.display_name || b.name || '';
    const sub = b.username ? h('span', { class: 'party-row-sub', text: `@${b.username}` }) : null;
    const why = [b.reason, b.banned_at ? `Banned ${relativeTime(b.banned_at)}` : ''].filter(Boolean).join(' · ');
    return h('li', { class: 'party-row', dataset: { id: b.id } },
      avatar({ name: name || b.id, url: b.avatar, id: b.id, size: 'md' }),
      h('span', { class: 'party-row-main' },
        h('span', { class: ['party-row-title', name ? '' : 'muted'], text: name || 'Name not known yet' }),
        sub,
        h('code', { class: 'party-row-id', text: b.id }),
        why ? h('span', { class: 'party-row-note', text: why }) : null),
      h('span', { class: 'party-row-end' }, button({ label: 'Unban', icon: 'check', size: 'sm', ariaLabel: `Unban ${name || b.id}`, onClick: (e) => unban(b, e.currentTarget) })));
  }

  function showBans(data) {
    bans = readBans(data);
    banCount.textContent = `${bans.bans.length} banned`;
    replace(banBody, bans.bans.length
      ? h('ul', { class: 'party-list' }, ...bans.bans.map(banRow))
      : h('p', { class: 'party-empty muted', text: 'Nobody is banned. Ban someone from a report above.' }));
  }

  const load = (path) => async ({ signal }) => {
    try {
      return await api.get(typeof path === 'function' ? path() : path, { signal });
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) return { staffOnly: true };
      throw err;
    }
  };

  let gen = 0;
  function loadReports() {
    gen += 1;
    const mine = gen;
    mountAsync(listBody, {
      signal: ctx.signal,
      skeleton: listSkeleton,
      load: load(() => reportsUrl(null)),
      render: (data) => {
        if (mine !== gen) return;
        if (data?.staffOnly) return denied();
        view = readReports(data, kind);
        drawReports();
      },
    });
  }

  drawFilters();
  loadReports();
  mountAsync(banBody, {
    signal: ctx.signal,
    skeleton: () => loadingRegion('Loading bans', h('ul', { class: 'party-list' }, h('li', { class: 'party-row is-skeleton' }, skeleton('skeleton-avatar'), h('span', { class: 'party-row-main' }, skeleton('skeleton-text skeleton-w-40'))))),
    load: load(BANS_PATH),
    render: (data) => {
      if (data?.staffOnly) return denied();
      showBans(data);
    },
  });
}
