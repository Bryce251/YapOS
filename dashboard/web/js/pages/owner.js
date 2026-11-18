import { h, nextId, replace } from '../dom.js';
import { icon } from '../icons.js';
import { avatar, badge, badgeArt, button, card, confirmDialog, emptyState, linkButton, loadingRegion, pageHeader, setBusy, skeleton, toast } from '../ui.js';
import { ApiError } from '../api.js';
import { formatNumber, relativeTime } from '../format.js';
import { ownerPath, profilePath } from '../router.js';
import { state } from '../state.js';
import { mountAsync } from './common.js';
import { PARTY_GAMES, PARTY_BADGE_COUNTERS, BADGES, badgeImage } from '../community-data.js';
import { cheatAlertsCard } from './owner-cheats.js';
import { badgeMakerCard } from './owner-badges.js';

export const OWNER_USERS_PATH = '/api/owner/users';
export const OWNER_ACTIONS_PATH = '/api/owner/actions';
export const POLL_MS = 3000;
export const SEARCH_DELAY_MS = 250;
export const QUICK_AMOUNTS = [100, 1000, 10000];
export const LOG_LIMIT = 30;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPEN = new Set(['queued', 'sent']);
const ACCOUNT_STATES = new Set(['real', 'fake', 'checking']);
export const NOT_REAL_TEXT = "That isn't a real Yapin' account. Check the id.";
export const CHECK_SLOW_MS = 30000;
const REMOVALS = new Set(['shards.remove', 'xp.remove', 'achievement.revoke', 'badge.revoke', 'giver.revoke', 'quests.reset']);
const GIFTS = new Set(['shards.add', 'xp.add', 'achievement.grant', 'badge.grant', 'giver.grant']);
export const PARTY_GAME_IDS = Object.freeze(Object.keys(PARTY_GAMES));
const isGame = (g) => typeof g === 'string' && Object.prototype.hasOwnProperty.call(PARTY_GAMES, g);

export const STATUS_TEXT = {
  queued: { label: 'Waiting for YapOS', tone: 'neutral', icon: 'clock' },
  sent: { label: 'YapOS is on it', tone: 'caution', icon: 'refresh' },
  done: { label: 'Done', tone: 'success', icon: 'check' },
  failed: { label: 'Failed', tone: 'danger', icon: 'alert' },
};

const str = (v) => (typeof v === 'string' && v ? v : '');
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function readUser(u) {
  if (!u || typeof u !== 'object' || typeof u.id !== 'string') return null;
  return {
    id: u.id,
    username: str(u.username),
    name: str(u.name),
    avatar: str(u.avatar),
    level: num(u.level),
    shards: num(u.shards),
    xp: num(u.xp),
    seen: num(u.seen),
    badges: Array.isArray(u.badges) ? u.badges.filter((b) => typeof b === 'string') : [],
    earnedBadges: Array.isArray(u.earnedBadges) ? u.earnedBadges.filter((b) => typeof b === 'string') : [],
    achievements: Array.isArray(u.achievements) ? u.achievements.filter((a) => typeof a === 'string') : [],
    clan: u.clan && typeof u.clan === 'object' && typeof u.clan.name === 'string' ? { name: u.clan.name, tag: str(u.clan.tag) } : null,
    party: { games: num(u.party?.games) || 0, wins: num(u.party?.wins) || 0 },
    partyBoard: readBoard(u.partyBoard),
    known: u.known !== false,
    globalHidden: u.globalHidden === true,
    account: ACCOUNT_STATES.has(u.account) ? u.account : 'real',
  };
}

export function readBoard(b) {
  const o = b && typeof b === 'object' ? b : {};
  const m = o.month && typeof o.month === 'object' ? o.month : {};
  const t = o.today && typeof o.today === 'object' ? o.today : {};
  const c = o.counters && typeof o.counters === 'object' ? o.counters : {};
  return {
    points: num(o.points) || 0,
    games: num(o.games) || 0,
    wins: num(o.wins) || 0,
    best: num(o.best) || 0,
    bestGame: isGame(o.bestGame) ? o.bestGame : '',
    rank: num(o.rank),
    month: { month: str(m.month), points: num(m.points) || 0, rank: num(m.rank) },
    today: { points: num(t.points) || 0, games: num(t.games) || 0 },
    byGame: Array.isArray(o.byGame)
      ? o.byGame.filter((g) => g && isGame(g.game)).map((g) => ({ game: g.game, points: num(g.points) || 0, games: num(g.games) || 0, wins: num(g.wins) || 0, best: num(g.best) || 0 }))
      : [],
    counters: Object.fromEntries(PARTY_BADGE_COUNTERS.map((x) => [x.key, num(c[x.key]) || 0])),
    hidden: o.hidden === true,
    banned: o.banned === true,
  };
}

export function gameLabel(id) {
  return isGame(id) ? `${PARTY_GAMES[id].emoji} ${PARTY_GAMES[id].name}` : 'an unknown game';
}

function plural(n, one, many) {
  return `${formatNumber(n)} ${n === 1 ? one : many}`;
}

export function readUsers(data) {
  return Array.isArray(data?.users) ? data.users.map(readUser).filter(Boolean) : [];
}

export function readAction(a) {
  if (!a || typeof a !== 'object' || typeof a.id !== 'string' || typeof a.kind !== 'string') return null;
  return {
    id: a.id,
    user: str(a.user),
    kind: a.kind,
    value: a.value ?? null,
    ref: str(a.ref),
    note: str(a.note),
    notify: a.notify === true,
    created: num(a.created) || 0,
    status: STATUS_TEXT[a.status] ? a.status : 'queued',
    result: str(a.result),
    who: a.who && typeof a.who === 'object' ? { username: str(a.who.username), name: str(a.who.name) } : null,
  };
}

export function readActions(list) {
  return Array.isArray(list) ? list.map(readAction).filter(Boolean) : [];
}

function readEntry(e) {
  if (!e || typeof e !== 'object' || typeof e.id !== 'string') return null;
  const out = { id: e.id, label: str(e.label) || e.id, emoji: str(e.emoji), reward: num(e.reward) || 0, source: str(e.source) };
  const image = badgeImage(e.image);
  if (image) out.image = image;
  if (str(e.note)) out.note = str(e.note);
  return out;
}

export function readCatalog(c) {
  return {
    achievements: Array.isArray(c?.achievements) ? c.achievements.map(readEntry).filter(Boolean) : [],
    badges: Array.isArray(c?.badges) ? c.badges.map(readEntry).filter(Boolean) : [],
  };
}

export function readDetail(data) {
  return {
    user: readUser(data?.user),
    actions: readActions(data?.actions),
    catalog: readCatalog(data?.catalog),
  };
}

export const hasOpen = (actions) => actions.some((a) => OPEN.has(a.status));

function entryName(list, id) {
  const e = list.find((x) => x.id === id);
  return e ? `${e.emoji ? `${e.emoji} ` : ''}${e.label}` : id;
}

export function describeAction(a, catalog = { achievements: [], badges: [] }) {
  const n = typeof a.value === 'number' ? formatNumber(a.value) : '';
  switch (a.kind) {
    case 'shards.add': return `Give ${n} 💎 Shards`;
    case 'shards.remove': return `Take ${n} 💎 Shards`;
    case 'shards.set': return `Set Shards to ${n}`;
    case 'xp.add': return `Give ${n} XP`;
    case 'xp.remove': return `Take ${n} XP`;
    case 'level.set': return `Set level to ${n}`;
    case 'achievement.grant': return `Give achievement ${entryName(catalog.achievements, a.ref)}`;
    case 'achievement.revoke': return `Take achievement ${entryName(catalog.achievements, a.ref)}`;
    case 'badge.grant': return `Give badge ${entryName(catalog.badges, a.ref)}`;
    case 'badge.revoke': return `Take badge ${entryName(catalog.badges, a.ref)}`;
    case 'giver.grant': return 'Let them create Shards';
    case 'giver.revoke': return 'Stop them creating Shards';
    case 'quests.reset': return "Reset today's quests";
    case 'streak.set': return `Set daily streak to ${n}`;
    case 'party.stats.add': {
      const g = Number(a.value?.games) || 0;
      const w = Number(a.value?.wins) || 0;
      return `Add ${formatNumber(g)} Party ${g === 1 ? 'game' : 'games'} and ${formatNumber(w)} ${w === 1 ? 'win' : 'wins'}`;
    }
    case 'party.points.set': return `Set all-time Party points to ${n}`;
    case 'party.month.set': return `Set this month's Party points to ${n}`;
    case 'party.record.set': return `Set Party record to ${plural(Number(a.value?.games) || 0, 'game', 'games')} and ${plural(Number(a.value?.wins) || 0, 'win', 'wins')}`;
    case 'party.best.set': return Number(a.value?.score) ? `Set best Party game to ${formatNumber(Number(a.value.score))} in ${gameLabel(a.value.game)}` : 'Clear best Party game';
    case 'party.game.set': return `Set ${gameLabel(a.value?.game)} points to ${formatNumber(Number(a.value?.points) || 0)}`;
    case 'party.counters.set': {
      const parts = PARTY_BADGE_COUNTERS.filter((c) => a.value && typeof a.value === 'object' && c.key in a.value).map((c) => `${c.label} ${formatNumber(Number(a.value[c.key]) || 0)}`);
      return parts.length ? `Set Party badge counters: ${parts.join(', ')}` : 'Set Party badge counters';
    }
    case 'party.reset': return a.value?.badges ? 'Reset Party leaderboard and badge stats' : 'Reset Party leaderboard stats';
    case 'party.board.hide': return 'Remove from Party leaderboards';
    case 'party.board.show': return 'Show on Party leaderboards again';
    case 'global.hide': return 'Hide from the global leaderboard';
    case 'global.show': return 'Show on the global leaderboard again';
    default: return a.kind;
  }
}

export function confirmText(kind, value, user, label = describeAction({ kind, value, ref: '' })) {
  const name = user?.name || user?.username || 'this person';
  if (REMOVALS.has(kind)) return { title: `${label.trim()}?`, body: `This takes something away from ${name}. It can't be undone from here, but you can give it back later.` };
  if (kind === 'shards.set' && user?.shards !== null && user?.shards !== undefined && value < user.shards) {
    return { title: `Lower ${name}'s Shards?`, body: `They have ${formatNumber(user.shards)} 💎 Shards now. Setting it to ${formatNumber(value)} takes ${formatNumber(user.shards - value)} away.` };
  }
  if (kind === 'level.set' && user?.level !== null && user?.level !== undefined && value < user.level) {
    return { title: `Lower ${name}'s level?`, body: `They are level ${formatNumber(user.level)} now. Setting level ${formatNumber(value)} lowers it.` };
  }
  if (kind === 'giver.grant') return { title: `Let ${name} create Shards?`, body: 'They can make new Shards out of nothing, hand them to anyone, and change earn rates, achievement rewards and clan prices, just like you. Only do this for people you fully trust.' };
  if (kind === 'party.reset') {
    return {
      title: `Reset ${name}'s Party leaderboard stats?`,
      body: `Their all-time, per-game, monthly and today's Party points, games, wins and best game are wiped. ${value?.badges ? 'Their Party badge stats, counters and daily puzzle streak are wiped too, so Party badges they earned go away.' : 'Party badges and their profile games and wins stay.'} This can't be undone.`,
    };
  }
  if (kind === 'party.board.hide') {
    return { title: `Remove ${name} from the Party leaderboards?`, body: "They disappear from every Party board and can't win monthly prizes. They can still play and their stats are kept. You can show them again any time." };
  }
  if (kind === 'global.hide') {
    return { title: `Hide ${name} from the global leaderboard?`, body: 'They disappear from the Levels and Shards boards for everyone within about a minute. Their Shards, XP and profile page are kept. You can show them again any time.' };
  }
  if (kind === 'streak.set' && value === 0) return { title: `Clear ${name}'s daily streak?`, body: 'Their /daily streak goes back to zero.' };
  return null;
}

export function parseWhole(text) {
  const raw = String(text ?? '').trim().replace(/[,_ ]/g, '');
  if (!raw) return { error: 'Type a number first.' };
  if (/^[+-]?(inf|infinity|∞)$/i.test(raw)) return { error: 'Use a normal whole number. Infinity is not allowed.' };
  const short = /^(\d+(?:\.\d+)?)([km])$/i.exec(raw);
  const n = short ? Number(short[1]) * (short[2].toLowerCase() === 'k' ? 1000 : 1000000) : (/^\d+$/.test(raw) ? Number(raw) : NaN);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return { error: 'Type a whole number, like 500.' };
  return { value: n };
}

export function bumpAmount(text, add) {
  const now = parseWhole(text);
  return String((now.value || 0) + add);
}

function quickLabel(n) {
  return n >= 1000 ? `+${n / 1000}k` : `+${n}`;
}

function personName(u) {
  return u.name || u.username || 'Unknown person';
}

function statusBadge(status) {
  const s = STATUS_TEXT[status] || STATUS_TEXT.queued;
  return badge(s.label, s.tone, s.icon);
}

function ownerOnlyView() {
  return emptyState({
    icon: 'eye-off',
    title: 'Page not found',
    body: "That address doesn't lead anywhere. Check the link or head back home.",
    action: linkButton({ label: 'Back to home', href: '/' }),
  });
}

function staffLinks() {
  return h('div', { class: 'owner-links' },
    linkButton({ label: 'Party reports and bans', href: '/party/reports', icon: 'flag', size: 'sm' }),
    linkButton({ label: 'Party admins', href: '/party', icon: 'crown', size: 'sm' }));
}

function userRow(u) {
  const facts = [];
  if (u.level !== null) facts.push(`Level ${formatNumber(u.level)}`);
  if (u.shards !== null) facts.push(`${formatNumber(u.shards)} 💎`);
  if (u.seen) facts.push(`seen ${relativeTime(u.seen)}`);
  return h('li', null, h('a', { href: ownerPath(u.id), class: 'owner-result', dataset: { link: '', id: u.id } },
    avatar({ name: personName(u), url: u.avatar, id: u.id, size: 'md' }),
    h('span', { class: 'owner-result-main' },
      h('span', { class: ['owner-result-name', u.account === 'fake' ? 'is-fake' : u.name || u.username ? '' : 'muted'], text: u.account === 'fake' ? "Not a real Yapin' account" : u.name || u.username ? personName(u) : 'Not seen yet' }),
      u.username ? h('span', { class: 'owner-result-sub', text: `@${u.username}` }) : h('code', { class: 'owner-result-sub', text: u.id })),
    h('span', { class: 'owner-result-facts', text: facts.join(' · ') }),
    icon('chevron-right', { size: 16 })));
}

function rowsSkeleton(n = 3) {
  return loadingRegion('Loading', h('ul', { class: 'owner-results' }, ...Array.from({ length: n }, () => h('li', { class: 'owner-result is-skeleton' },
    skeleton('skeleton-avatar'),
    h('span', { class: 'owner-result-main' }, skeleton('skeleton-text skeleton-w-40'), skeleton('skeleton-text skeleton-w-60'))))));
}

function logRow(a, { catalog, showWho = false } = {}) {
  const who = showWho ? (a.who?.name || a.who?.username || a.user) : '';
  return h('li', { class: ['owner-log-row', `is-${a.status}`], dataset: { id: a.id } },
    h('span', { class: 'owner-log-main' },
      h('span', { class: 'owner-log-what', text: describeAction(a, catalog) }),
      h('span', { class: 'owner-log-sub' },
        showWho ? h('a', { href: ownerPath(a.user), dataset: { link: '' }, text: who }) : null,
        showWho ? ' · ' : null,
        relativeTime(a.created),
        a.notify ? ' · told them' : '',
        a.note ? ` · “${a.note}”` : ''),
      a.result ? h('span', { class: ['owner-log-result', a.status === 'failed' ? 'is-danger' : ''], text: a.result }) : null),
    statusBadge(a.status));
}

function schedule(signal, fn, ms) {
  let timer = null;
  const stop = () => clearTimeout(timer);
  signal?.addEventListener?.('abort', stop, { once: true });
  return {
    later() {
      clearTimeout(timer);
      if (signal?.aborted) return;
      timer = setTimeout(fn, ms);
    },
    stop,
  };
}

export function renderOwner(ctx) {
  const { api, main } = ctx;
  ctx.setChrome({ variant: 'plain', section: 'owner', crumbs: [{ label: 'Servers', href: '/servers' }, { label: 'Owner panel' }] });
  if (!state.partyOwner) {
    main.replaceChildren(h('div', { class: 'page page-narrow' }, ownerOnlyView()));
    return;
  }
  const inputId = nextId('owner-q');
  const input = h('input', {
    type: 'search',
    id: inputId,
    class: 'input',
    placeholder: 'Name, @username or user id',
    maxLength: 64,
    autocomplete: 'off',
    spellcheck: false,
  });
  const results = h('div', { class: 'owner-results-wrap', attrs: { 'aria-live': 'polite' } });
  const log = h('div', { class: 'owner-log-wrap' });
  main.replaceChildren(h('div', { class: 'page page-narrow owner-page' },
    pageHeader({
      title: 'Owner panel',
      description: 'Give anyone Shards, XP, levels, achievements, badges and more. Only you can see this page.',
      actions: staffLinks(),
    }),
    cheatAlertsCard(ctx, { onChange: () => loadLog() }),
    card({ title: 'Find someone', icon: 'search' },
      h('label', { class: 'field-label', htmlFor: inputId, text: 'Search people' }),
      input,
      h('p', { class: 'field-help', text: 'Anyone who used YapOS, signed in here or has a profile shows up. Paste a user id to reach someone YapOS has never seen.' }),
      results),
    card({ title: 'Recent changes', icon: 'clock' }, log),
    badgeMakerCard(ctx)));

  let token = 0;
  let typing = null;
  async function search() {
    const mine = ++token;
    const q = input.value.trim();
    if (!results.firstChild) replace(results, rowsSkeleton());
    try {
      const data = await api.get(`${OWNER_USERS_PATH}?q=${encodeURIComponent(q)}`, { signal: ctx.signal });
      if (mine !== token || ctx.signal?.aborted) return;
      const users = readUsers(data);
      if (!users.length) {
        replace(results, h('p', { class: 'owner-empty muted', text: q ? `Nobody matches “${q}”. Try their user id.` : 'Nobody has used YapOS yet.' }));
        return;
      }
      replace(results, h('ul', { class: 'owner-results' }, ...users.map(userRow)));
    } catch (err) {
      if (mine !== token || ctx.signal?.aborted) return;
      replace(results, h('p', { class: 'field-error', attrs: { role: 'alert' }, text: err instanceof ApiError ? err.message : 'Search did not work. Try again.' }));
    }
  }
  input.addEventListener('input', () => {
    clearTimeout(typing);
    typing = setTimeout(search, SEARCH_DELAY_MS);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const q = input.value.trim();
    if (UUID_RE.test(q)) ctx.navigate(ownerPath(q.toLowerCase()));
  });
  ctx.signal?.addEventListener?.('abort', () => clearTimeout(typing), { once: true });
  search();

  const poller = schedule(ctx.signal, () => loadLog(), POLL_MS);
  async function loadLog() {
    try {
      const data = await api.get(`${OWNER_ACTIONS_PATH}?limit=${LOG_LIMIT}`, { signal: ctx.signal });
      if (ctx.signal?.aborted) return;
      const actions = readActions(data?.actions);
      replace(log, actions.length
        ? h('ul', { class: 'owner-log' }, ...actions.map((a) => logRow(a, { showWho: true })))
        : h('p', { class: 'owner-empty muted', text: 'Nothing yet. Pick someone above to give them something.' }));
      if (hasOpen(actions)) poller.later();
    } catch (err) {
      if (ctx.signal?.aborted) return;
      replace(log, h('p', { class: 'field-error', attrs: { role: 'alert' }, text: err instanceof ApiError ? err.message : 'Could not load recent changes.' }));
    }
  }
  replace(log, rowsSkeleton(2));
  loadLog();
}

function amountField({ label, id, placeholder = '0', chips = false }) {
  const input = h('input', { type: 'text', id, class: 'input owner-amount', inputMode: 'numeric', placeholder, maxLength: 20, autocomplete: 'off' });
  const wrap = h('div', { class: 'owner-field' },
    h('label', { class: 'field-label', htmlFor: id, text: label }),
    input,
    chips ? h('div', { class: 'owner-chips' }, ...QUICK_AMOUNTS.map((n) => h('button', {
      type: 'button',
      class: 'owner-chip',
      text: quickLabel(n),
      attrs: { 'aria-label': `Add ${formatNumber(n)} to ${label}` },
      on: { click: () => { input.value = bumpAmount(input.value, n); input.focus(); } },
    }))) : null);
  return { wrap, input };
}

export function prefill(input, value) {
  const text = String(value);
  if (input.ownerDocument?.activeElement === input) return;
  if (input.value !== '' && input.dataset.shown !== input.value) return;
  input.value = text;
  input.dataset.shown = text;
}

function gameSelect(id, blank = '') {
  const sel = h('select', { id, class: 'input select' },
    blank ? h('option', { value: '', text: blank }) : null,
    ...PARTY_GAME_IDS.map((g) => h('option', { value: g, text: gameLabel(g) })));
  return { sel, wrap: h('div', { class: 'select-shell' }, sel, icon('chevron-down', { size: 14, className: 'select-caret' })) };
}

function stat(label, value) {
  return h('div', { class: 'owner-stat' }, h('span', { class: 'owner-stat-label', text: label }), h('span', { class: 'owner-stat-value', text: value }));
}

function pills(ids, list, empty) {
  if (!ids.length) return h('p', { class: 'owner-empty muted', text: empty });
  return h('ul', { class: 'owner-pills' }, ...ids.map((id) => {
    const e = list.find((x) => x.id === id);
    return h('li', { class: 'owner-pill', title: e?.note ? `${e.label}: ${e.note}` : id }, e?.image ? badgeArt(e, '', 'owner-pill-img') : e?.emoji ? h('span', { attrs: { 'aria-hidden': 'true' }, text: e.emoji }) : null, h('span', { text: e ? e.label : id }));
  }));
}

export function renderOwnerUser(ctx) {
  const { api, main } = ctx;
  const id = String(ctx.params?.id || '').toLowerCase();
  const crumbs = (name) => [{ label: 'Servers', href: '/servers' }, { label: 'Owner panel', href: '/owner' }, { label: name }];
  ctx.setChrome({ variant: 'plain', section: 'owner', crumbs: crumbs('Person') });
  if (!state.partyOwner) {
    main.replaceChildren(h('div', { class: 'page page-narrow' }, ownerOnlyView()));
    return;
  }
  const body = h('div', { class: 'owner-user-wrap' });
  main.replaceChildren(h('div', { class: 'page owner-page owner-user-page' }, body));
  let detail = null;
  let pageParts = null;
  const poller = schedule(ctx.signal, () => refresh(), POLL_MS);

  async function refresh() {
    try {
      const data = await api.get(`${OWNER_USERS_PATH}/${encodeURIComponent(id)}`, { signal: ctx.signal });
      if (ctx.signal?.aborted) return;
      const before = detail ? new Map(detail.actions.map((a) => [a.id, a.status])) : new Map();
      detail = readDetail(data);
      for (const a of detail.actions) {
        const was = before.get(a.id);
        if (was && OPEN.has(was) && a.status === 'done') toast(`${describeAction(a, detail.catalog)}: done.`);
        if (was && OPEN.has(was) && a.status === 'failed') toast(a.result || 'YapOS could not do that.', { tone: 'danger', title: describeAction(a, detail.catalog) });
      }
      pageParts?.update(detail);
      if (hasOpen(detail.actions)) poller.later();
    } catch {
      if (!ctx.signal?.aborted) poller.later();
    }
  }

  mountAsync(body, {
    signal: ctx.signal,
    skeleton: () => rowsSkeleton(3),
    load: async ({ signal }) => api.get(`${OWNER_USERS_PATH}/${encodeURIComponent(id)}`, { signal }),
    render: (data) => {
      detail = readDetail(data);
      if (!detail.user) {
        replace(body, emptyState({ icon: 'user', title: 'Nobody here', body: "That person couldn't be loaded.", action: linkButton({ label: 'Back to the owner panel', href: '/owner', icon: 'chevron-left' }) }));
        return;
      }
      if (detail.user.account !== 'real') {
        gate();
        return;
      }
      showPage();
    },
  });

  function showPage() {
    const name = personName(detail.user);
    ctx.setTitle(`${name} · Owner panel`);
    ctx.setChrome({ variant: 'plain', section: 'owner', crumbs: crumbs(name) });
    pageParts = buildUserPage(ctx, body, detail, { send, getDetail: () => detail });
    if (hasOpen(detail.actions)) poller.later();
  }

  const checkStarted = Date.now();
  const checker = schedule(ctx.signal, () => recheck(), POLL_MS);
  async function recheck() {
    try {
      const data = await api.get(`${OWNER_USERS_PATH}/${encodeURIComponent(id)}`, { signal: ctx.signal });
      if (ctx.signal?.aborted) return;
      const next = readDetail(data);
      if (next.user) detail = next;
    } catch {
      if (ctx.signal?.aborted) return;
    }
    if (detail?.user?.account === 'real') showPage();
    else gate();
  }

  function gate() {
    const u = detail.user;
    const back = linkButton({ label: 'Back to the owner panel', href: '/owner', icon: 'chevron-left' });
    if (u.account === 'fake') {
      ctx.setTitle('Not a real account · Owner panel');
      ctx.setChrome({ variant: 'plain', section: 'owner', crumbs: crumbs('Not a real account') });
      const cleanup = u.known && !u.globalHidden ? button({ label: 'Hide it from the global leaderboard', icon: 'eye-off', variant: 'danger' }) : null;
      cleanup?.addEventListener('click', async () => {
        if (await send('global.hide', { btn: cleanup })) recheck();
      });
      replace(body, h('div', { class: 'owner-account-gate is-fake', attrs: { role: 'alert' } },
        emptyState({
          icon: 'alert',
          title: NOT_REAL_TEXT,
          body: `No Yapin' account has the id ${u.id}, so nothing can be given to it.${cleanup ? ' It still shows up from an earlier change, so you can hide it from the global leaderboard.' : ''}`,
          action: h('div', { class: 'owner-actions-row' }, cleanup, back),
        })));
      return;
    }
    const slow = Date.now() - checkStarted > CHECK_SLOW_MS;
    replace(body, h('div', { class: 'owner-account-gate', attrs: { 'aria-live': 'polite' } },
      emptyState({
        icon: 'clock',
        title: "Checking this account with Yapin'",
        body: slow
          ? "YapOS hasn't answered yet. It checks ids while the bot is online, so make sure it's running. If this never finishes, check the id."
          : `Making sure ${u.id} belongs to a real Yapin' account before you change anything. This takes a few seconds.`,
        action: back,
      })));
    checker.later();
  }

  async function send(kind, { value, ref, btn, notify, onDone } = {}) {
    const ask = confirmText(kind, value, detail?.user, describeAction({ kind, value, ref }, detail?.catalog));
    if (ask) {
      const ok = await confirmDialog({ title: ask.title, body: ask.body, confirmLabel: 'Yes, do it' });
      if (!ok || ctx.signal?.aborted) return false;
    }
    const payload = { user: id, kind };
    if (value !== undefined) payload.value = value;
    if (ref) payload.id = ref;
    if (GIFTS.has(kind) && notify) payload.notify = true;
    const note = pageParts?.note();
    if (note) payload.note = note;
    if (btn?.isConnected) setBusy(btn, true, 'Sending');
    try {
      const data = await api.post(OWNER_ACTIONS_PATH, payload, { signal: ctx.signal });
      if (ctx.signal?.aborted) return false;
      const action = readAction(data?.action);
      if (action) {
        detail.actions = [action, ...detail.actions.filter((a) => a.id !== action.id)];
        pageParts?.update(detail);
        toast(action.status === 'done' ? `${describeAction(action, detail.catalog)}: done.` : `${describeAction(action, detail.catalog)}: sent to YapOS.`);
      }
      onDone?.();
      if (action?.status === 'done') refresh();
      else poller.later();
      return true;
    } catch (err) {
      if (ctx.signal?.aborted) return false;
      toast(err instanceof ApiError ? err.message : 'That did not work. Try again.', { tone: 'danger', title: "Couldn't do that" });
      if (err instanceof ApiError && (err.code === 'not_a_user' || err.code === 'checking_user') && detail?.user && kind !== 'global.hide') {
        detail.user.account = err.code === 'not_a_user' ? 'fake' : 'checking';
        pageParts = null;
        gate();
      }
      return false;
    } finally {
      if (btn?.isConnected) setBusy(btn, false);
    }
  }
}

function buildUserPage(ctx, body, first, { send, getDetail }) {
  const u0 = first.user;
  const tellId = nextId('owner-tell');
  const tell = h('input', { type: 'checkbox', id: tellId, class: 'owner-check' });
  const noteId = nextId('owner-note');
  const note = h('input', { type: 'text', id: noteId, class: 'input', maxLength: 200, placeholder: 'Why? Only you see this', autocomplete: 'off' });
  const notifyOn = () => tell.checked;

  const head = h('div', { class: 'owner-card-head' });
  const stats = h('div', { class: 'owner-stats' });
  const badgesBox = h('div', { class: 'owner-section' });
  const achBox = h('div', { class: 'owner-section' });

  const shardsField = amountField({ label: 'Shards', id: nextId('owner-shards'), chips: true });
  const giveShards = button({ label: 'Give', icon: 'gift', variant: 'primary' });
  const takeShards = button({ label: 'Take', icon: 'x' });
  const setShards = button({ label: 'Set to this', icon: 'check' });
  const xpField = amountField({ label: 'XP', id: nextId('owner-xp'), chips: true });
  const giveXp = button({ label: 'Give XP', icon: 'gift', variant: 'primary' });
  const takeXp = button({ label: 'Take XP', icon: 'x' });
  const levelField = amountField({ label: 'Level', id: nextId('owner-level') });
  const setLevel = button({ label: 'Set level', icon: 'check' });
  const streakField = amountField({ label: 'Daily streak (days)', id: nextId('owner-streak') });
  const setStreak = button({ label: 'Set streak', icon: 'check' });
  const resetQuests = button({ label: "Reset today's quests", icon: 'refresh' });
  const allowGive = button({ label: 'Let them create Shards', icon: 'check' });
  const stopGive = button({ label: 'Stop them creating Shards', icon: 'ban' });
  const gamesField = amountField({ label: 'Games', id: nextId('owner-games') });
  const winsField = amountField({ label: 'Wins', id: nextId('owner-wins') });
  const addParty = button({ label: 'Add to Party stats', icon: 'plus' });
  const globalHide = button({ label: 'Hide from global leaderboard', icon: 'eye-off' });
  const globalShow = button({ label: 'Show on global leaderboard', icon: 'eye' });

  const achSearchId = nextId('owner-ach-q');
  const achSearch = h('input', { type: 'search', id: achSearchId, class: 'input', placeholder: 'Search achievements', autocomplete: 'off' });
  const achList = h('div', { class: 'owner-checklist-wrap' });
  const badgeSearchId = nextId('owner-badge-q');
  const badgeSearch = h('input', { type: 'search', id: badgeSearchId, class: 'input', placeholder: 'Search badges', autocomplete: 'off' });
  const badgeList = h('div', { class: 'owner-checklist-wrap' });
  const userLog = h('div', { class: 'owner-log-wrap' });

  const boardStatus = h('div', { class: 'owner-board-status' });
  const boardStats = h('div', { class: 'owner-stats' });
  const boardGames = h('div', { class: 'owner-board-games' });
  const hideBoard = button({ label: 'Remove from leaderboards', icon: 'eye-off', variant: 'danger' });
  const showBoard = button({ label: 'Show on leaderboards again', icon: 'eye' });
  const headHide = button({ label: 'Remove from leaderboards', icon: 'eye-off', size: 'sm' });
  const pointsField = amountField({ label: 'All-time points', id: nextId('owner-bpoints') });
  const savePoints = button({ label: 'Save points', icon: 'check' });
  const recGames = amountField({ label: 'Total games', id: nextId('owner-bgames') });
  const recWins = amountField({ label: 'Total wins', id: nextId('owner-bwins') });
  const saveRecord = button({ label: 'Save games and wins', icon: 'check' });
  const bestField = amountField({ label: 'Best score', id: nextId('owner-bbest') });
  const bestGameId = nextId('owner-bbest-game');
  const bestGame = gameSelect(bestGameId, 'Pick a game');
  const saveBest = button({ label: 'Save best game', icon: 'check' });
  const clearBest = button({ label: 'Clear', icon: 'x' });
  const monthField = amountField({ label: "This month's points", id: nextId('owner-bmonth') });
  const saveMonth = button({ label: 'Save month', icon: 'check' });
  const gamePickId = nextId('owner-bgame');
  const gamePick = gameSelect(gamePickId);
  gamePick.sel.value = PARTY_GAME_IDS[0];
  const gamePoints = amountField({ label: 'Points in this game', id: nextId('owner-bgame-pts') });
  const saveGame = button({ label: 'Save game points', icon: 'check' });
  const counterFields = PARTY_BADGE_COUNTERS.map((c) => ({ key: c.key, field: amountField({ label: c.label, id: nextId(`owner-c-${c.key}`) }) }));
  const saveCounters = button({ label: 'Save counters', icon: 'check' });
  const resetBadgesId = nextId('owner-reset-badges');
  const resetBadges = h('input', { type: 'checkbox', id: resetBadgesId, class: 'owner-check' });
  const resetBoard = button({ label: 'Reset Party stats', icon: 'trash', variant: 'danger' });
  const board = () => getDetail().user.partyBoard;

  function gamePointsFor(game) {
    const found = board().byGame.find((g) => g.game === game);
    return found ? found.points : 0;
  }

  function showGamePoints() {
    gamePoints.input.value = String(gamePointsFor(gamePick.sel.value));
    gamePoints.input.dataset.shown = gamePoints.input.value;
  }

  function clean(...fields) {
    for (const f of fields) {
      f.input.value = '';
      delete f.input.dataset.shown;
    }
  }

  function amountOrSay(field) {
    const r = parseWhole(field.input.value);
    if (r.error) {
      toast(r.error, { tone: 'danger', title: 'Check the number' });
      field.input.focus();
      return null;
    }
    return r.value;
  }

  const act = (kind, field, btn) => async () => {
    const value = amountOrSay(field);
    if (value === null) return;
    const ok = await send(kind, { value, btn, notify: notifyOn() });
    if (ok) field.input.value = '';
  };
  giveShards.addEventListener('click', act('shards.add', shardsField, giveShards));
  takeShards.addEventListener('click', act('shards.remove', shardsField, takeShards));
  setShards.addEventListener('click', act('shards.set', shardsField, setShards));
  giveXp.addEventListener('click', act('xp.add', xpField, giveXp));
  takeXp.addEventListener('click', act('xp.remove', xpField, takeXp));
  setLevel.addEventListener('click', act('level.set', levelField, setLevel));
  setStreak.addEventListener('click', act('streak.set', streakField, setStreak));
  resetQuests.addEventListener('click', () => send('quests.reset', { btn: resetQuests }));
  allowGive.addEventListener('click', () => send('giver.grant', { btn: allowGive, notify: notifyOn() }));
  stopGive.addEventListener('click', () => send('giver.revoke', { btn: stopGive }));
  globalHide.addEventListener('click', () => send('global.hide', { btn: globalHide }));
  globalShow.addEventListener('click', () => send('global.show', { btn: globalShow }));
  addParty.addEventListener('click', async () => {
    const g = gamesField.input.value.trim() ? amountOrSay(gamesField) : 0;
    if (g === null) return;
    const w = winsField.input.value.trim() ? amountOrSay(winsField) : 0;
    if (w === null) return;
    if (!g && !w) return toast('Add at least one game or win.', { tone: 'danger', title: 'Check the numbers' });
    const ok = await send('party.stats.add', { value: { games: g, wins: w }, btn: addParty });
    if (ok) {
      gamesField.input.value = '';
      winsField.input.value = '';
    }
  });

  const setOne = (kind, field, btn) => async () => {
    const value = amountOrSay(field);
    if (value === null) return;
    await send(kind, { value, btn, onDone: () => clean(field) });
  };
  savePoints.addEventListener('click', setOne('party.points.set', pointsField, savePoints));
  saveMonth.addEventListener('click', setOne('party.month.set', monthField, saveMonth));
  saveRecord.addEventListener('click', async () => {
    const g = amountOrSay(recGames);
    if (g === null) return;
    const w = amountOrSay(recWins);
    if (w === null) return;
    if (w > g) return toast("Wins can't be more than games played.", { tone: 'danger', title: 'Check the numbers' });
    await send('party.record.set', { value: { games: g, wins: w }, btn: saveRecord, onDone: () => clean(recGames, recWins) });
  });
  saveBest.addEventListener('click', async () => {
    const score = amountOrSay(bestField);
    if (score === null) return;
    const game = bestGame.sel.value;
    if (score > 0 && !isGame(game)) {
      toast('Pick which game the best score was in.', { tone: 'danger', title: 'Pick a game' });
      bestGame.sel.focus();
      return;
    }
    await send('party.best.set', { value: score > 0 ? { score, game } : { score: 0 }, btn: saveBest, onDone: () => clean(bestField) });
  });
  clearBest.addEventListener('click', async () => {
    await send('party.best.set', { value: { score: 0 }, btn: clearBest, onDone: () => clean(bestField) });
  });
  gamePick.sel.addEventListener('change', showGamePoints);
  saveGame.addEventListener('click', async () => {
    const points = amountOrSay(gamePoints);
    if (points === null) return;
    await send('party.game.set', { value: { game: gamePick.sel.value, points }, btn: saveGame, onDone: () => clean(gamePoints) });
  });
  saveCounters.addEventListener('click', async () => {
    const value = {};
    for (const { key, field } of counterFields) {
      if (!field.input.value.trim()) continue;
      const n = amountOrSay(field);
      if (n === null) return;
      if (n !== board().counters[key]) value[key] = n;
    }
    if (!Object.keys(value).length) return toast('Change at least one counter first.', { title: 'Nothing to save' });
    await send('party.counters.set', { value, btn: saveCounters, onDone: () => clean(...counterFields.map((c) => c.field)) });
  });
  resetBoard.addEventListener('click', async () => {
    await send('party.reset', {
      value: { badges: resetBadges.checked },
      btn: resetBoard,
      onDone: () => {
        resetBadges.checked = false;
        clean(pointsField, recGames, recWins, bestField, monthField, gamePoints, ...counterFields.map((c) => c.field));
      },
    });
  });
  const hideOrShow = (btn) => () => send(board().hidden ? 'party.board.show' : 'party.board.hide', { btn });
  hideBoard.addEventListener('click', hideOrShow(hideBoard));
  showBoard.addEventListener('click', hideOrShow(showBoard));
  headHide.addEventListener('click', hideOrShow(headHide));

  function updateBoard(b) {
    const where = b.banned ? badge('Banned from Party', 'danger', 'ban') : b.hidden ? badge('Hidden from leaderboards', 'caution', 'eye-off') : badge('On the leaderboards', 'success', 'check');
    const today = b.today.points || b.today.games ? `Today: ${plural(b.today.points, 'point', 'points')} from ${plural(b.today.games, 'game', 'games')}.` : 'Nothing counted today.';
    replace(boardStatus, where,
      h('span', { class: 'owner-board-note muted', text: b.hidden ? 'They can still play. Nothing they do shows on a Party board or wins a monthly prize.' : today }));
    hideBoard.hidden = b.hidden;
    showBoard.hidden = !b.hidden;
    headHide.hidden = b.hidden;
    replace(boardStats,
      stat('All-time points', formatNumber(b.points)),
      stat('Rank', b.rank ? `#${formatNumber(b.rank)}` : 'Not ranked'),
      stat('Games', formatNumber(b.games)),
      stat('Wins', formatNumber(b.wins)),
      stat('Best game', b.best ? `${formatNumber(b.best)} · ${gameLabel(b.bestGame)}` : 'None'),
      stat('This month', `${formatNumber(b.month.points)}${b.month.rank ? ` · #${formatNumber(b.month.rank)}` : ''}`));
    replace(boardGames, b.byGame.length
      ? h('div', { class: 'table-wrap' }, h('table', { class: 'table owner-board-table' },
        h('thead', null, h('tr', null, ...['Game', 'Points', 'Games', 'Wins', 'Best', ''].map((t) => h('th', { scope: 'col', class: t === 'Games' || t === 'Wins' ? 'owner-board-minor' : '', text: t })))),
        h('tbody', null, ...b.byGame.map((g) => {
          const edit = button({ label: 'Edit', size: 'sm', ariaLabel: `Edit ${PARTY_GAMES[g.game].name} points` });
          edit.addEventListener('click', () => {
            gamePick.sel.value = g.game;
            showGamePoints();
            gamePoints.input.focus();
          });
          return h('tr', null,
            h('td', { text: gameLabel(g.game) }),
            h('td', { text: formatNumber(g.points) }),
            h('td', { class: 'owner-board-minor', text: formatNumber(g.games) }),
            h('td', { class: 'owner-board-minor', text: formatNumber(g.wins) }),
            h('td', { text: formatNumber(g.best) }),
            h('td', null, edit));
        }))))
      : h('p', { class: 'owner-empty muted', text: 'No points in any game yet.' }));
    prefill(pointsField.input, b.points);
    prefill(recGames.input, b.games);
    prefill(recWins.input, b.wins);
    prefill(bestField.input, b.best);
    if (bestGame.sel.ownerDocument?.activeElement !== bestGame.sel) bestGame.sel.value = b.bestGame || '';
    prefill(monthField.input, b.month.points);
    prefill(gamePoints.input, gamePointsFor(gamePick.sel.value));
    for (const { key, field } of counterFields) prefill(field.input, b.counters[key]);
  }

  function checklist(wrap, list, owned, { grant, revoke, earned = new Set(), filter = '', what, pending }) {
    const q = filter.trim().toLowerCase();
    const shown = list.filter((e) => !q || e.label.toLowerCase().includes(q) || e.id.includes(q));
    if (!list.length) {
      replace(wrap, h('p', { class: 'owner-empty muted', text: what === 'achievement' ? "YapOS hasn't sent its list of achievements yet. Start the bot and reload this page in a minute." : 'No badges to give yet.' }));
      return;
    }
    if (!shown.length) {
      replace(wrap, h('p', { class: 'owner-empty muted', text: `Nothing matches “${filter.trim()}”.` }));
      return;
    }
    replace(wrap, h('ul', { class: 'owner-checklist' }, ...shown.map((e) => {
      const has = owned.has(e.id);
      const auto = earned.has(e.id);
      const busy = pending.has(e.id);
      const btn = has
        ? button({ label: 'Take', icon: 'x', size: 'sm', disabled: auto || busy, ariaLabel: `Take ${e.label}` })
        : button({ label: 'Give', icon: 'gift', size: 'sm', variant: 'primary', disabled: busy, ariaLabel: `Give ${e.label}` });
      btn.addEventListener('click', () => send(has ? revoke : grant, { ref: e.id, btn, notify: !has && notifyOn() }));
      return h('li', { class: ['owner-check-row', has ? 'is-owned' : ''] },
        h('span', { class: 'owner-check-mark', attrs: { 'aria-hidden': 'true' } }, has ? icon('check', { size: 14 }) : null),
        e.image ? h('span', { class: 'owner-check-emoji' }, badgeArt(e, '', 'owner-check-img')) : h('span', { class: 'owner-check-emoji', attrs: { 'aria-hidden': 'true' }, text: e.emoji || '•' }),
        h('span', { class: 'owner-check-main' },
          h('span', { class: 'owner-check-label', text: e.label }),
          h('span', { class: 'owner-check-sub', text: auto ? 'Earned from Party stats' : busy ? 'Waiting for YapOS' : has ? 'They have this' : (e.reward ? `Normally pays ${formatNumber(e.reward)} 💎, not paid when you give it` : (what === 'badge' && (e.note || (Object.prototype.hasOwnProperty.call(BADGES, e.id) && BADGES[e.id].note))) || (e.source === 'custom' ? 'Your own badge' : e.id)) })),
        btn);
    })));
  }

  function pendingRefs(actions, kinds) {
    return new Set(actions.filter((a) => OPEN.has(a.status) && kinds.includes(a.kind)).map((a) => a.ref));
  }

  function update(d) {
    const u = d.user;
    const name = personName(u);
    replace(head,
      avatar({ name, url: u.avatar, id: u.id, size: 'lg' }),
      h('div', { class: 'owner-card-who' },
        h('h1', { class: 'owner-card-name', text: u.name || u.username ? name : 'Someone YapOS has not seen yet' }),
        u.username ? h('span', { class: 'owner-card-handle', text: `@${u.username}` }) : null,
        h('code', { class: 'owner-card-id', text: u.id }),
        h('span', { class: 'owner-card-verified' }, badge("Real Yapin' account", 'success', 'check')),
        u.clan ? h('span', { class: 'owner-card-clan' }, icon('shield', { size: 14 }), h('span', { text: u.clan.tag ? `${u.clan.name} [${u.clan.tag}]` : u.clan.name })) : null),
      h('div', { class: 'owner-card-links' },
        u.username ? linkButton({ label: 'Public profile', href: profilePath(u.username), icon: 'user', size: 'sm' }) : null,
        headHide));
    updateBoard(u.partyBoard);
    globalHide.hidden = u.globalHidden;
    globalShow.hidden = !u.globalHidden;
    replace(stats,
      stat('Level', u.level === null ? 'Not known' : formatNumber(u.level)),
      stat('XP', u.xp === null ? 'Not known' : formatNumber(u.xp)),
      stat('Shards', u.shards === null ? 'Hidden or not known' : `${formatNumber(u.shards)} 💎`),
      stat('Party games', formatNumber(u.party.games)),
      stat('Party wins', formatNumber(u.party.wins)));
    replace(badgesBox, h('h3', { class: 'owner-section-title', text: 'Badges' }), pills(u.badges, d.catalog.badges, 'No badges yet.'));
    replace(achBox, h('h3', { class: 'owner-section-title', text: 'Achievements' }), pills(u.achievements, d.catalog.achievements, 'No achievements yet.'));
    checklist(achList, d.catalog.achievements, new Set(u.achievements), { grant: 'achievement.grant', revoke: 'achievement.revoke', filter: achSearch.value, what: 'achievement', pending: pendingRefs(d.actions, ['achievement.grant', 'achievement.revoke']) });
    checklist(badgeList, d.catalog.badges, new Set(u.badges), { grant: 'badge.grant', revoke: 'badge.revoke', earned: new Set(u.earnedBadges), filter: badgeSearch.value, what: 'badge', pending: pendingRefs(d.actions, ['badge.grant', 'badge.revoke']) });
    replace(userLog, d.actions.length
      ? h('ul', { class: 'owner-log' }, ...d.actions.map((a) => logRow(a, { catalog: d.catalog })))
      : h('p', { class: 'owner-empty muted', text: 'Nothing given or taken yet.' }));
  }

  achSearch.addEventListener('input', () => update(getDetail()));
  badgeSearch.addEventListener('input', () => update(getDetail()));

  const row = (...kids) => h('div', { class: 'owner-actions-row' }, ...kids);
  replace(body,
    h('section', { class: 'card owner-card' }, h('div', { class: 'card-body' }, head, stats, h('div', { class: 'owner-sections' }, badgesBox, achBox))),
    h('div', { class: 'owner-tell' },
      h('label', { class: 'owner-tell-check', htmlFor: tellId }, tell, h('span', { text: 'Tell them' })),
      h('span', { class: 'owner-tell-help muted', text: 'When you give something, YapOS sends them a short friendly DM. Never for take-aways.' }),
      h('div', { class: 'owner-field owner-note' }, h('label', { class: 'field-label', htmlFor: noteId, text: 'Note for the log (optional)' }), note)),
    h('div', { class: 'owner-grid' },
      card({ title: 'Shards', icon: 'coins' },
        shardsField.wrap,
        row(giveShards, takeShards, setShards),
        h('p', { class: 'field-help', text: 'Gifts count as given by you, not earned, so they never move the season board or quests.' }),
        row(globalHide, globalShow),
        h('p', { class: 'field-help', text: 'Hiding takes them off the global Levels and Shards boards straight away. Their Shards and XP stay.' })),
      card({ title: 'XP and level', icon: 'star' },
        xpField.wrap,
        row(giveXp, takeXp),
        levelField.wrap,
        row(setLevel),
        h('p', { class: 'field-help', text: 'Level-up rewards like roles still happen. Season XP does not change.' })),
      card({ title: 'Shard powers', icon: 'gift' },
        h('p', { class: 'owner-text', text: 'Lets them create Shards for anyone and change earn rates, like you can. Everyone can already send their own Shards to friends.' }),
        row(allowGive, stopGive)),
      card({ title: 'Quests and streak', icon: 'clock' },
        row(resetQuests),
        streakField.wrap,
        row(setStreak)),
      card({ title: 'Party stats', icon: 'trophy' },
        h('div', { class: 'owner-pair' }, gamesField.wrap, winsField.wrap),
        row(addParty),
        h('p', { class: 'field-help', text: 'Added straight away. Party badges follow these numbers.' }))),
    card({ title: 'Party leaderboard', icon: 'chart', className: 'owner-board-card' },
      boardStatus,
      boardStats,
      boardGames,
      h('div', { class: 'owner-board-edit' },
        h('div', { class: 'owner-board-block' },
          h('h3', { class: 'owner-section-title', text: 'All-time total' }),
          pointsField.wrap,
          row(savePoints),
          h('p', { class: 'field-help', text: 'Only the all-time total. Per-game and monthly points stay as they are.' })),
        h('div', { class: 'owner-board-block' },
          h('h3', { class: 'owner-section-title', text: 'Games and wins' }),
          h('div', { class: 'owner-pair' }, recGames.wrap, recWins.wrap),
          row(saveRecord),
          h('p', { class: 'field-help', text: 'Sets the exact numbers on the boards, their profile and Party badges.' })),
        h('div', { class: 'owner-board-block' },
          h('h3', { class: 'owner-section-title', text: 'Best game' }),
          bestField.wrap,
          h('div', { class: 'owner-field' }, h('label', { class: 'field-label', htmlFor: bestGameId, text: 'Game' }), bestGame.wrap),
          row(saveBest, clearBest)),
        h('div', { class: 'owner-board-block' },
          h('h3', { class: 'owner-section-title', text: 'Monthly race' }),
          monthField.wrap,
          row(saveMonth),
          h('p', { class: 'field-help', text: 'The monthly race. The top 3 get a badge when the month ends.' })),
        h('div', { class: 'owner-board-block' },
          h('h3', { class: 'owner-section-title', text: 'Points in one game' }),
          h('div', { class: 'owner-field' }, h('label', { class: 'field-label', htmlFor: gamePickId, text: 'Game' }), gamePick.wrap),
          gamePoints.wrap,
          row(saveGame),
          h('p', { class: 'field-help', text: 'All-time points move by the same amount, so the totals still add up.' })),
        h('div', { class: 'owner-board-block' },
          h('h3', { class: 'owner-section-title', text: 'Badge counters' }),
          h('div', { class: 'owner-counters' }, ...counterFields.map((c) => c.field.wrap)),
          row(saveCounters)),
        h('div', { class: 'owner-board-block owner-board-danger' },
          h('div', { class: 'owner-board-part' },
            h('h3', { class: 'owner-section-title', text: 'Leaderboard access' }),
            h('p', { class: 'owner-text', text: 'Hide someone who cheated. They keep playing but never show on a Party board or win a monthly prize.' }),
            row(hideBoard, showBoard)),
          h('div', { class: 'owner-board-part' },
            h('h3', { class: 'owner-section-title', text: 'Start over' }),
            h('label', { class: 'owner-tell-check', htmlFor: resetBadgesId }, resetBadges, h('span', { text: 'Also reset badge stats, counters and daily streak' })),
            row(resetBoard))))),
    h('div', { class: 'owner-grid owner-grid-wide' },
      card({ title: 'Achievements', icon: 'trophy' },
        h('label', { class: 'sr-only', htmlFor: achSearchId, text: 'Search achievements' }), achSearch, achList),
      card({ title: 'Badges', icon: 'sparkles' },
        h('label', { class: 'sr-only', htmlFor: badgeSearchId, text: 'Search badges' }), badgeSearch, badgeList)),
    card({ title: 'Changes for this person', icon: 'list', actions: linkButton({ label: 'All changes', href: '/owner', size: 'sm' }) }, userLog),
    staffLinks());
  update(first);
  return {
    update,
    note: () => note.value.trim(),
  };
}
