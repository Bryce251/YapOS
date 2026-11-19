import { h, nextId, replace } from '../dom.js';
import { icon } from '../icons.js';
import { avatar, badge, button, confirmDialog, drawer, linkButton, setBusy, toast } from '../ui.js';
import { ApiError } from '../api.js';
import { formatNumber, formatShort } from '../format.js';
import { ownerPath, profilePath } from '../router.js';
import { OWNER_ACTIONS_PATH, OWNER_USERS_PATH, describeAction, parseWhole, readAction, readUser } from './owner.js';

export const BOARD_CURRENCY = 'Shards';
export const BOARD_EMOJI = '\u{1F48E}';
export const WATCH_MS = 3000;
export const WATCH_TRIES = 40;
export const PRIVATE_TITLE = 'Private profile';
export const PRIVATE_BODY = "Their profile page isn't public.";
export const BOARD_HIDDEN_TEXT = 'Hidden from leaderboards';
export const QUEUED_NOTE = 'YapOS applies it as soon as the bot picks it up, usually within a few seconds while it is online. The leaderboard catches up about a minute after that.';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPEN = new Set(['queued', 'sent']);

export function boardRowLabel(name, rank) {
  const who = typeof name === 'string' && name.trim() ? name.trim() : 'this player';
  return rank ? `Rank ${rank}: open ${who}'s profile` : `Open ${who}'s profile`;
}

export function privateCard() {
  return h('div', { class: 'bp-private', attrs: { role: 'note' } },
    h('span', { class: 'bp-private-icon', attrs: { 'aria-hidden': 'true' } }, icon('lock', { size: 16 })),
    h('span', { class: 'bp-private-text' },
      h('strong', { class: 'bp-private-title', text: PRIVATE_TITLE }),
      h('span', { class: 'muted bp-private-body', text: PRIVATE_BODY })));
}

export function canManage(person) {
  return Boolean(person && typeof person.id === 'string' && UUID_RE.test(person.id));
}

export function actionBody(id, kind, value) {
  const body = { user: String(id).toLowerCase(), kind };
  if (value !== undefined && value !== null) body.value = value;
  return body;
}

export function expectedAfter(kind, value, now) {
  const cur = typeof now === 'number' && Number.isFinite(now) ? now : null;
  if (kind === 'shards.set' || kind === 'level.set') return value;
  if (kind === 'shards.add') return cur === null ? null : cur + value;
  if (kind === 'shards.remove' || kind === 'xp.remove') return cur === null ? null : Math.max(0, cur - value);
  return null;
}

export function askFirst(kind, value, person) {
  const name = person.name || 'this person';
  const shards = person.shards;
  if (kind === 'shards.set' && value === 0) {
    return { title: `Set ${name}'s ${BOARD_CURRENCY} to 0?`, body: `${shards ? `They have ${formatNumber(shards)} ${BOARD_EMOJI} ${BOARD_CURRENCY} now and all of it goes.` : 'Their whole wallet goes.'} With 0 they drop off the ${BOARD_CURRENCY} board. You can give ${BOARD_CURRENCY} back later.` };
  }
  if (kind === 'shards.set' && shards !== null && shards !== undefined && value < shards) {
    return { title: `Lower ${name}'s ${BOARD_CURRENCY}?`, body: `They have ${formatNumber(shards)} ${BOARD_EMOJI} now. Setting it to ${formatNumber(value)} takes ${formatNumber(shards - value)} away.` };
  }
  if (kind === 'shards.remove') return { title: `Take ${formatNumber(value)} ${BOARD_CURRENCY} from ${name}?`, body: `This takes ${BOARD_CURRENCY} away. If they have less, they go to 0. You can give them back later.` };
  if (kind === 'xp.remove') return { title: `Take ${formatNumber(value)} XP from ${name}?`, body: 'Their level may go down. You can give XP back later from the owner panel.' };
  if (kind === 'level.set' && person.level !== null && person.level !== undefined && value < person.level) {
    return { title: `Lower ${name}'s level?`, body: `They are level ${formatNumber(person.level)} now. Setting level ${formatNumber(value)} lowers it.` };
  }
  if (kind === 'global.hide') return { title: `Hide ${name} from the leaderboard?`, body: 'They disappear from the Levels and Shards boards for everyone within about a minute. Their Shards, XP and profile page are kept. You can show them again any time.' };
  return null;
}

function stat(label, value, { pending = false, key = '' } = {}) {
  return h('div', { class: ['person-stat', 'bp-stat', pending ? 'is-pending' : ''], dataset: { stat: key || null } },
    h('dt', { class: 'report-label', text: label }),
    h('dd', null, h('span', { class: 'bp-stat-value', text: value }), pending ? h('span', { class: 'chip bp-pending', text: 'Pending' }) : null));
}

function rankText(rank) {
  return rank ? `#${formatNumber(rank)}` : 'Not ranked';
}

function field(label, placeholder = '0') {
  const id = nextId('bp-amount');
  const input = h('input', { type: 'text', id, class: 'input bp-amount', inputMode: 'numeric', placeholder, maxLength: 20, autocomplete: 'off' });
  return { input, wrap: h('div', { class: 'bp-field' }, h('label', { class: 'field-label', htmlFor: id, text: label }), input) };
}

export function openBoardPerson({ person, api, signal = null, owner = Promise.resolve(false), onChanged = null, subtitle = 'Global leaderboard', facts = null, staff = Promise.resolve(false), onStaff = null }) {
  const ctrl = new AbortController();
  if (signal && typeof signal.addEventListener === 'function') signal.addEventListener('abort', () => ctrl.abort());
  const p = { ...person };
  const pending = {};
  let hidden = false;
  const factList = Array.isArray(facts) ? facts.filter((f) => f && typeof f.label === 'string') : null;
  const d = drawer({ title: p.name || 'Player', subtitle, onClose: () => ctrl.abort() });
  d.root.classList.add('board-person');
  const head = h('div', { class: 'person-head bp-head' });
  const stats = h('dl', { class: ['person-stats', 'bp-stats', factList ? 'bp-stats-facts' : ''] });
  const links = h('div', { class: 'bp-links' });
  const modSlot = h('div', { class: 'bp-mod-slot' });
  replace(d.body, head, stats, links, modSlot);

  const closeOnNav = (el) => {
    el.addEventListener('click', () => d.close());
    return el;
  };

  function drawHead() {
    replace(head,
      avatar({ name: p.name || p.id, url: p.avatar, still: p.avatarStill, id: p.id, size: 'xl' }),
      h('div', { class: 'person-names' },
        h('p', { class: 'person-name', text: p.name || 'Player' }),
        p.handle ? h('p', { class: 'person-handle', text: `@${p.handle}` }) : null,
        hidden ? h('div', { class: 'person-tags' }, badge('Hidden from the leaderboard', 'caution', 'eye-off')) : null));
  }

  function drawStats() {
    if (factList) {
      replace(stats, ...factList.map((f) => stat(f.label, String(f.value ?? ''), { key: f.key || '' })));
      return;
    }
    const shardText = (n) => (n === null || n === undefined ? 'Not on the board' : `${formatShort(n)} ${BOARD_EMOJI}`);
    replace(stats,
      stat('Level', pending.level !== undefined ? formatNumber(pending.level) : (p.level === null || p.level === undefined ? 'Not on the board' : formatNumber(p.level)), { pending: pending.level !== undefined, key: 'level' }),
      stat('XP', pending.xp !== undefined ? formatNumber(pending.xp) : (p.xp === null || p.xp === undefined ? 'Not on the board' : formatNumber(p.xp)), { pending: pending.xp !== undefined, key: 'xp' }),
      stat('Levels rank', rankText(p.levelRank), { key: 'level-rank' }),
      stat(BOARD_CURRENCY, pending.shards !== undefined ? shardText(pending.shards) : shardText(p.shards), { pending: pending.shards !== undefined, key: 'shards' }),
      stat(`${BOARD_CURRENCY} rank`, rankText(p.shardsRank), { key: 'shards-rank' }));
  }

  let staffBtn = null;

  function drawLinks() {
    replace(links, p.handle
      ? closeOnNav(linkButton({ label: 'View full profile', href: profilePath(p.handle), icon: 'user', size: 'sm' }))
      : privateCard(), staffBtn);
  }

  drawHead();
  drawStats();
  drawLinks();
  requestAnimationFrame(() => {
    if (!ctrl.signal.aborted && links.isConnected) {
      const first = links.querySelector('a');
      if (first) first.focus();
    }
  });

  Promise.resolve(owner).then((isOwner) => {
    if (isOwner === true && !ctrl.signal.aborted && canManage(p)) buildMod();
  }).catch(() => {});

  if (typeof onStaff === 'function') {
    Promise.resolve(staff).then((isStaff) => {
      if (isStaff !== true || ctrl.signal.aborted || !canManage(p)) return;
      staffBtn = button({ label: 'Party mod view', icon: 'shield', size: 'sm', className: 'bp-staff', onClick: () => {
        d.close();
        onStaff({ ...p });
      } });
      drawLinks();
    }).catch(() => {});
  }

  function buildMod() {
    const status = h('p', { class: 'bp-mod-status muted', attrs: { 'aria-live': 'polite' }, text: 'Checking their latest numbers.' });
    const shards = field(BOARD_CURRENCY);
    const zero = button({ label: 'Set to 0', icon: 'trash', variant: 'danger', size: 'sm' });
    const setS = button({ label: `Set ${BOARD_CURRENCY}`, icon: 'check', size: 'sm' });
    const takeS = button({ label: 'Take', icon: 'x', size: 'sm' });
    const giveS = button({ label: 'Give', icon: 'gift', size: 'sm' });
    const level = field('Level');
    const setL = button({ label: 'Set level', icon: 'check', size: 'sm' });
    const xp = field('XP');
    const takeX = button({ label: 'Take XP', icon: 'x', size: 'sm' });
    const hide = button({ label: 'Hide from leaderboards', icon: 'eye-off', size: 'sm' });
    const show = button({ label: 'Show on leaderboards', icon: 'eye', size: 'sm' });
    const ownerLink = closeOnNav(linkButton({ label: 'Open in owner panel', href: ownerPath(p.id), icon: 'crown', size: 'sm' }));
    const row = (...kids) => h('div', { class: 'bp-row' }, ...kids);
    const grid = (...kids) => h('div', { class: 'bp-row bp-row-grid' }, ...kids);

    const section = h('section', { class: 'bp-mod', attrs: { 'aria-label': 'Mod view' } },
      h('div', { class: 'bp-mod-head' },
        h('h3', { class: 'person-section-title', text: 'Mod view' }),
        badge('Only you see this', 'neutral', 'crown')),
      status,
      h('div', { class: 'bp-group' },
        shards.wrap,
        grid(zero, setS, takeS, giveS)),
      h('div', { class: 'bp-group' },
        h('div', { class: 'bp-pair' }, level.wrap, xp.wrap),
        grid(setL, takeX)),
      h('div', { class: 'bp-group' },
        h('p', { class: 'field-help', text: 'Hiding takes them off the Levels and Shards boards for everyone. Their Shards, XP and profile stay.' }),
        row(hide, show)),
      row(ownerLink));
    replace(modSlot, section);
    drawHidden();

    function drawHidden() {
      hide.hidden = hidden;
      show.hidden = !hidden;
      drawHead();
    }

    function amount(f) {
      const r = parseWhole(f.input.value);
      if (r.error) {
        toast(r.error, { tone: 'danger', title: 'Check the number' });
        f.input.focus();
        return null;
      }
      return r.value;
    }

    async function load() {
      try {
        const data = await api.get(`${OWNER_USERS_PATH}/${encodeURIComponent(p.id.toLowerCase())}`, { signal: ctrl.signal });
        if (ctrl.signal.aborted) return null;
        const u = readUser(data?.user);
        if (!u) return null;
        if (u.shards !== null) p.shards = u.shards;
        if (u.level !== null) p.level = u.level;
        if (u.xp !== null) p.xp = u.xp;
        if (!factList && !p.handle && u.username && data?.user?.hidden !== true) p.handle = u.username;
        hidden = data?.user?.globalHidden === true;
        status.textContent = 'Numbers from YapOS. Changes go to the bot, like in the owner panel.';
        drawStats();
        drawLinks();
        drawHidden();
        return data;
      } catch (err) {
        if (!ctrl.signal.aborted) status.textContent = "Couldn't load their latest numbers, so these come from the board.";
        return null;
      }
    }

    function watch(actionId, kind, tries = 0) {
      if (ctrl.signal.aborted || tries >= WATCH_TRIES) return;
      setTimeout(async () => {
        if (ctrl.signal.aborted) return;
        let data = null;
        try {
          data = await api.get(`${OWNER_USERS_PATH}/${encodeURIComponent(p.id.toLowerCase())}`, { signal: ctrl.signal });
        } catch {
          data = null;
        }
        if (ctrl.signal.aborted) return;
        const a = (Array.isArray(data?.actions) ? data.actions : []).map(readAction).find((x) => x && x.id === actionId);
        if (!a || OPEN.has(a.status)) return watch(actionId, kind, tries + 1);
        const key = kind.startsWith('shards.') ? 'shards' : kind === 'level.set' ? 'level' : 'xp';
        delete pending[key];
        if (a.status === 'done') {
          const u = readUser(data?.user);
          if (u) {
            if (u.shards !== null) p.shards = u.shards;
            if (u.level !== null) p.level = u.level;
            if (u.xp !== null) p.xp = u.xp;
          }
          if (p.shards === 0) p.shardsRank = null;
          toast(`${a.result || 'Done.'} The leaderboard updates within about a minute.`, { title: describeAction(a), timeout: 7000 });
        } else {
          toast(a.result || 'YapOS could not do that.', { tone: 'danger', title: describeAction(a) });
        }
        drawStats();
        if (typeof onChanged === 'function') onChanged({ type: kind, id: p.id, status: a.status, person: { ...p } });
      }, WATCH_MS);
    }

    async function send(kind, value, btn, after) {
      const ask = askFirst(kind, value, p);
      if (ask) {
        const ok = await confirmDialog({ title: ask.title, body: ask.body, confirmLabel: 'Yes, do it' });
        if (!ok || ctrl.signal.aborted) return false;
      }
      setBusy(btn, true, 'Sending');
      try {
        const data = await api.post(OWNER_ACTIONS_PATH, actionBody(p.id, kind, value), { signal: ctrl.signal });
        if (ctrl.signal.aborted) return false;
        const a = readAction(data?.action);
        if (a && a.status === 'done') {
          if (kind === 'global.hide' || kind === 'global.show') {
            hidden = kind === 'global.hide';
            drawHidden();
          }
          toast(a.result || `${describeAction(a)}: done.`, { title: describeAction(a), timeout: 7000 });
        } else {
          after?.();
          drawStats();
          toast(QUEUED_NOTE, { title: `${describeAction({ kind, value })}: sent to YapOS`, timeout: 9000 });
          if (a) watch(a.id, kind);
        }
        if (typeof onChanged === 'function') onChanged({ type: kind, id: p.id, status: a ? a.status : 'queued', person: { ...p } });
        return true;
      } catch (err) {
        if (ctrl.signal.aborted) return false;
        toast(err instanceof ApiError ? err.message : 'That did not work. Try again.', { tone: 'danger', title: "Couldn't do that" });
        return false;
      } finally {
        if (btn.isConnected) setBusy(btn, false);
      }
    }

    const shardAct = (kind, btn, fixed) => async () => {
      const value = fixed === undefined ? amount(shards) : fixed;
      if (value === null) return;
      if (kind !== 'shards.set' && value < 1) {
        toast('Use at least 1.', { tone: 'danger', title: 'Check the number' });
        return;
      }
      const ok = await send(kind, value, btn, () => {
        const next = expectedAfter(kind, value, p.shards);
        if (next !== null) pending.shards = next;
      });
      if (ok) shards.input.value = '';
    };
    zero.addEventListener('click', shardAct('shards.set', zero, 0));
    setS.addEventListener('click', shardAct('shards.set', setS));
    takeS.addEventListener('click', shardAct('shards.remove', takeS));
    giveS.addEventListener('click', shardAct('shards.add', giveS));
    setL.addEventListener('click', async () => {
      const value = amount(level);
      if (value === null) return;
      const ok = await send('level.set', value, setL, () => { pending.level = value; });
      if (ok) level.input.value = '';
    });
    takeX.addEventListener('click', async () => {
      const value = amount(xp);
      if (value === null) return;
      if (value < 1) {
        toast('Use at least 1.', { tone: 'danger', title: 'Check the number' });
        return;
      }
      const ok = await send('xp.remove', value, takeX, () => {
        const next = expectedAfter('xp.remove', value, p.xp);
        if (next !== null) pending.xp = next;
      });
      if (ok) xp.input.value = '';
    });
    hide.addEventListener('click', () => send('global.hide', undefined, hide));
    show.addEventListener('click', () => send('global.show', undefined, show));
    load();
  }

  return { close: d.close, root: d.root, signal: ctrl.signal };
}
