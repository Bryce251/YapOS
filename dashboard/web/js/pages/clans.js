import { h, nextId, replace } from '../dom.js';
import { icon } from '../icons.js';
import { badge, button, card, confirmDialog, emptyState, loadingRegion, pageHeader, skeleton, toast } from '../ui.js';
import { ApiError } from '../api.js';
import { formatNumber, relativeTime } from '../format.js';
import { profilePath } from '../router.js';
import { latestSearch } from '../kit.js';
import { checkClanName, checkClanTag, checkClanBanner, parseClanColour, colourHex, COLOURS, NAME_MAX, BANNER_MAX } from '../clan-rules.js';
import { mountAsync } from './common.js';
import { openClanSheet } from './clan-sheet.js';

export const CLAN_API = '/api/me/clan';
export const CLAN_ACTIONS_API = '/api/me/clan/actions';
export const CLAN_BROWSE_API = '/api/clans';
const WATCH_MS = 2500;
const WATCH_MAX = 60;

export const ACTION_LABELS = Object.freeze({
  create: 'Create the clan',
  invite: 'Send an invite',
  accept: 'Accept an invite',
  decline: 'Decline an invite',
  kick: 'Remove a member',
  leader: 'Hand over leadership',
  tag: 'Change the tag',
  colour: 'Change the colour',
  banner: 'Change the banner',
  privacy: 'Change who can join',
  upgrade: 'Buy an upgrade',
  disband: 'Close the clan',
  leave: 'Leave the clan',
});

const str = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const safeColour = (v) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : null);

function readPerson(p) {
  return {
    id: str(p?.id, 64),
    name: str(p?.name, 64) || 'Private profile',
    username: str(p?.username, 64) || null,
    level: Number.isFinite(p?.level) ? p.level : null,
    leader: p?.leader === true,
    you: p?.you === true,
    hidden: p?.hidden === true,
    at: num(p?.at),
  };
}

function readAction(a) {
  const status = a?.status === 'done' || a?.status === 'refused' ? a.status : 'pending';
  return { id: str(a?.id, 64), kind: str(a?.kind, 16), status, message: str(a?.message, 300), waiting: a?.waiting === true, created: num(a?.created), updated: num(a?.updated) };
}

export function readClanView(data) {
  const d = data && typeof data === 'object' ? data : {};
  const s = d.settings && typeof d.settings === 'object' ? d.settings : {};
  const c = d.clan && typeof d.clan === 'object' ? d.clan : null;
  return {
    owner: d.owner === true,
    settings: { createCost: num(s.createCost ?? 500), stylePrice: num(s.stylePrice ?? 1500), boostPrice: num(s.boostPrice ?? 5000), boost: num(s.boost ?? 0.05) },
    clan: c ? {
      id: str(c.id, 16),
      tag: str(c.tag, 4),
      name: str(c.name, 40),
      colour: safeColour(c.colour),
      banner: str(c.banner, 80) || null,
      join: c.join === 'invite' ? 'invite' : 'open',
      count: num(c.count),
      created: num(c.created) || null,
      leader: c.leader === true,
      leaderName: str(c.leaderName, 64) || null,
      bank: c.bank === null || c.bank === undefined ? null : num(c.bank),
      style: c.style === true,
      boost: c.boost === true,
      deposits: (Array.isArray(c.deposits) ? c.deposits : []).map((x) => ({ name: str(x?.name, 64) || 'Someone', amount: num(x?.amount) })),
      members: (Array.isArray(c.members) ? c.members : []).map(readPerson),
      more: num(c.more),
      invites: (Array.isArray(c.invites) ? c.invites : []).map(readPerson),
    } : null,
    invites: (Array.isArray(d.invites) ? d.invites : []).filter((x) => x && x.clan && typeof x.clan.id === 'string').map((x) => ({
      clan: { id: str(x.clan.id, 16), tag: str(x.clan.tag, 4), name: str(x.clan.name, 40), colour: safeColour(x.clan.colour), banner: str(x.clan.banner, 80) || null, members: num(x.clan.members), join: x.clan.join === 'invite' ? 'invite' : 'open' },
      by: str(x.by, 64) || null,
      at: num(x.at),
    })),
    actions: (Array.isArray(d.actions) ? d.actions : []).map(readAction),
    joining: d.joining && typeof d.joining === 'object' ? { tag: str(d.joining.tag, 4) } : null,
  };
}

export function pendingActions(view) {
  return view.actions.filter((a) => a.status === 'pending');
}

export function createProblems({ name, tag }, { owner = false } = {}) {
  const out = {};
  const n = checkClanName(name, { owner });
  if (n.error) out.name = n.error.replace(/`/g, '');
  const t = checkClanTag(tag, { owner });
  if (t.error) out.tag = t.error.replace(/`/g, '');
  return out;
}

export function actionStatusText(a) {
  const what = ACTION_LABELS[a.kind] || 'Clan change';
  if (a.status === 'pending') return `${what}: ${a.waiting ? "YapOS is offline right now. This goes through when it's back." : 'waiting for YapOS…'}`;
  return `${what}: ${a.message || (a.status === 'done' ? 'Done.' : "YapOS couldn't do that.")}`;
}

function field({ label, help = '', input, error = null }) {
  const id = input.id || nextId('clan-f');
  input.id = id;
  return h('div', { class: 'field clan-field' },
    h('label', { class: 'field-label', htmlFor: id, text: label }),
    input,
    help ? h('p', { class: 'field-help', text: help }) : null,
    error);
}

function crest(c) {
  const el = h('span', { class: 'clan-crest', attrs: { 'aria-hidden': 'true' }, text: c.tag });
  return el;
}

function pageSkeleton() {
  return loadingRegion('Loading your clan', h('div', { class: 'clan-page-body' },
    h('div', { class: 'card' }, h('div', { class: 'card-body' }, skeleton('skeleton-title skeleton-w-30'), skeleton('skeleton-text skeleton-w-60'))),
    h('div', { class: 'card' }, h('div', { class: 'card-body' }, skeleton('skeleton-text skeleton-w-50'), skeleton('skeleton-text skeleton-w-70')))));
}

export function renderClans(ctx) {
  const { api, main } = ctx;
  ctx.setChrome({ variant: 'plain', section: 'clans', crumbs: [{ label: 'Servers', href: '/servers' }, { label: 'Your clan' }] });
  const body = h('div', { class: 'clan-page-body' });
  main.replaceChildren(h('div', { class: 'page clan-page' },
    pageHeader({ title: 'Your clan', description: 'Run your clan from here. Changes go to YapOS, which checks them the same way as /clan in chat.' }),
    body));

  let view = null;
  let watchTimer = null;
  let watchCount = 0;
  let reloadFn = null;
  const known = new Map();
  ctx.signal?.addEventListener?.('abort', () => clearTimeout(watchTimer));

  async function send(payload, { confirm = null } = {}) {
    if (confirm && !(await confirmDialog(confirm))) return null;
    try {
      const data = await api.post(CLAN_ACTIONS_API, payload, { signal: ctx.signal });
      if (ctx.signal?.aborted) return null;
      const a = readAction(data?.action);
      known.set(a.id, a.status);
      view.actions = [a, ...view.actions.filter((x) => x.id !== a.id)];
      toast('YapOS will check it and apply it in a moment.', { tone: 'info', title: 'Sent to YapOS' });
      paint();
      watchCount = 0;
      watch();
      return a;
    } catch (err) {
      if (ctx.signal?.aborted) return null;
      toast(err instanceof ApiError ? err.message : 'That did not work. Try again.', { tone: 'danger', title: "Couldn't do that" });
      return null;
    }
  }

  function watch() {
    clearTimeout(watchTimer);
    if (!view || !pendingActions(view).length || watchCount >= WATCH_MAX) return;
    watchTimer = setTimeout(async () => {
      watchCount += 1;
      try {
        const next = readClanView(await api.get(CLAN_API, { signal: ctx.signal }));
        if (ctx.signal?.aborted) return;
        for (const a of next.actions) {
          const was = known.get(a.id);
          if (was === 'pending' && a.status !== 'pending') toast(a.message || 'Done.', { tone: a.status === 'done' ? 'success' : 'danger', title: a.status === 'done' ? 'Done' : "YapOS said no" });
          known.set(a.id, a.status);
        }
        view = next;
        paint();
      } catch {
        if (ctx.signal?.aborted) return;
      }
      watch();
    }, WATCH_MS);
  }

  function statusCard() {
    const list = view.actions.slice(0, 5);
    if (!list.length) return null;
    return card({ title: 'Recent changes', icon: 'clock', className: 'clan-actions-card' },
      h('ul', { class: 'clan-actions', attrs: { 'aria-live': 'polite' } }, ...list.map((a) => h('li', { class: ['clan-action', `is-${a.status}`] },
        icon(a.status === 'pending' ? 'clock' : a.status === 'done' ? 'check' : 'alert', { size: 14 }),
        h('span', { class: 'clan-action-text', text: actionStatusText(a) }),
        h('span', { class: 'clan-action-time', text: relativeTime(a.updated || a.created) })))));
  }

  function heroCard(c) {
    const root = h('section', { class: ['card', 'clan-hero', c.join === 'invite' ? 'is-invite' : 'is-open'] },
      h('div', { class: 'card-body clan-hero-body' },
        crest(c),
        h('div', { class: 'clan-hero-text' },
          h('h2', { class: 'clan-hero-name' }, h('span', { class: 'clan-hero-tag', text: `[${c.tag}]` }), h('span', { text: c.name })),
          c.banner ? h('p', { class: 'clan-hero-banner', text: c.banner }) : null,
          h('div', { class: 'clan-hero-badges' },
            badge(c.join === 'invite' ? 'Invite only' : 'Open to everyone', c.join === 'invite' ? 'warning' : 'success', c.join === 'invite' ? 'lock' : 'users'),
            badge(`${formatNumber(c.count)} member${c.count === 1 ? '' : 's'}`, 'neutral', 'users'),
            badge(c.leader ? 'You lead this clan' : `Led by ${c.leaderName || 'someone'}`, c.leader ? 'accent' : 'neutral', 'crown')))));
    if (c.colour) root.style.setProperty('--clan', c.colour);
    return root;
  }

  function memberRow(c, m) {
    const actions = c.leader && !m.you ? h('div', { class: 'clan-member-actions' },
      button({ label: 'Make leader', icon: 'crown', size: 'sm', onClick: () => send({ kind: 'leader', target: m.id }, { confirm: { title: `Make ${m.name} the leader?`, body: `${m.name} will lead [${c.tag}] ${c.name}. You stay in as a member and lose the leader tools.`, confirmLabel: 'Make leader', tone: 'primary' } }) }),
      button({ label: 'Remove', icon: 'ban', size: 'sm', variant: 'danger', onClick: () => send({ kind: 'kick', target: m.id }, { confirm: { title: `Remove ${m.name}?`, body: `${m.name} leaves [${c.tag}] ${c.name}. They can join again if the clan is open.`, confirmLabel: 'Remove' } }) })) : null;
    const self = m.you && m.hidden && ctx.user ? (ctx.user.display_name || ctx.user.username || '') : '';
    return h('li', { class: ['clan-member', m.leader ? 'is-leader' : '', m.you ? 'is-you' : ''] },
      h('div', { class: 'clan-member-who' },
        m.username ? h('a', { href: profilePath(m.username), class: 'clan-member-name', dataset: { link: '' }, text: m.name }) : h('span', { class: 'clan-member-name', text: self ? `${self} (private profile)` : m.name }),
        m.username ? h('span', { class: 'clan-member-handle', text: `@${m.username}` }) : null,
        m.leader ? badge('Leader', 'accent', 'crown') : badge('Member', 'neutral'),
        m.you ? badge('You', 'neutral') : null,
        m.level !== null ? h('span', { class: 'clan-member-level', text: `Lv ${formatNumber(m.level)}` }) : null),
      actions);
  }

  function membersCard(c) {
    return card({ title: 'Members', icon: 'users' },
      h('ul', { class: 'clan-members' }, ...c.members.map((m) => memberRow(c, m))),
      c.more ? h('p', { class: 'field-help', text: `And ${formatNumber(c.more)} more.` }) : null,
      c.members.some((m) => m.hidden && !m.you) ? h('p', { class: 'field-help', text: 'Members with a private profile show as "Private profile".' }) : null);
  }

  function inviteCard(c) {
    const input = h('input', { type: 'text', class: 'input clan-draft', placeholder: '@username or Yapin\' user id', maxLength: 80, autocomplete: 'off', spellcheck: false, dataset: { draft: 'invite' } });
    const list = h('ul', { class: 'clan-suggest', attrs: { 'aria-label': 'Matching profiles' } });
    const search = latestSearch(async (q) => {
      if (!q || /^[0-9a-f]{8}-/i.test(q)) {
        replace(list);
        return;
      }
      const data = await api.get(`${CLAN_API}/people?q=${encodeURIComponent(q)}`, { signal: ctx.signal }).catch(() => null);
      if (ctx.signal?.aborted || input.value.trim() !== q) return;
      const people = Array.isArray(data?.people) ? data.people : [];
      replace(list, ...people.map((p) => h('li', null, h('button', {
        type: 'button',
        class: 'clan-suggest-item',
        on: { click: () => { input.value = `@${p.username}`; replace(list); input.focus(); } },
      }, h('span', { class: 'clan-suggest-name', text: str(p.name, 64) }), h('span', { class: 'clan-suggest-handle', text: `@${str(p.username, 64)}` }), p.clan ? h('span', { class: 'clan-suggest-clan', text: `[${str(p.clan, 4)}]` }) : null))));
    });
    input.addEventListener('input', () => search.push(input.value.trim()));
    ctx.signal?.addEventListener?.('abort', () => search.cancel());
    const submit = async (e) => {
      e.preventDefault();
      const who = input.value.trim();
      if (!who) {
        toast('Type their @username or paste their Yapin\' user id.', { tone: 'danger', title: 'Invite who?' });
        return;
      }
      const a = await send({ kind: 'invite', who });
      if (a) {
        input.value = '';
        clearDraft('invite');
        replace(list);
      }
    };
    const form = h('form', { class: 'clan-invite-form', on: { submit } },
      field({ label: 'Invite someone', help: 'Search YapOS profiles, type @username, or paste their Yapin\' user id. The invite goes to their DMs and their YapOS inbox.', input }),
      list,
      button({ label: 'Send invite', icon: 'message', variant: 'primary', type: 'submit' }));
    const pending = c.invites.length
      ? h('div', { class: 'clan-pending' },
        h('h3', { class: 'clan-subtitle', text: 'Waiting for an answer' }),
        h('ul', { class: 'clan-pending-list' }, ...c.invites.map((p) => h('li', null, h('span', { text: p.name }), p.username ? h('span', { class: 'clan-member-handle', text: `@${p.username}` }) : null, h('span', { class: 'clan-action-time', text: `invited ${relativeTime(p.at)}` })))))
      : h('p', { class: 'field-help', text: 'No invites waiting. Invites last 7 days.' });
    return card({ title: 'Invites', icon: 'message' }, form, pending);
  }

  function settingsCard(c) {
    const tagInput = h('input', { type: 'text', class: 'input clan-tag-input clan-draft', value: c.tag, maxLength: 4, autocomplete: 'off', spellcheck: false, dataset: { draft: 'tag' } });
    const tagErr = h('p', { class: 'field-error', attrs: { role: 'alert' } });
    const tagForm = h('form', { class: 'clan-inline-form', on: { submit: (e) => {
      e.preventDefault();
      const r = checkClanTag(tagInput.value, { owner: view.owner });
      tagErr.textContent = r.error ? r.error.replace(/`/g, '') : '';
      if (r.error) return;
      if (r.value === c.tag) {
        tagErr.textContent = "That's already your tag.";
        return;
      }
      send({ kind: 'tag', tag: r.value });
    } } }, field({ label: 'Tag', help: '3 or 4 letters or numbers. Tags that look like another clan\'s are taken.', input: tagInput, error: tagErr }), button({ label: 'Save tag', type: 'submit', icon: 'tag' }));

    const join = h('div', { class: 'clan-join-mode' },
      h('p', { class: 'clan-subtitle', text: 'Who can join' }),
      h('div', { class: 'clan-choice', attrs: { role: 'group', 'aria-label': 'Who can join' } },
        button({ label: 'Anyone', icon: 'users', size: 'sm', variant: c.join === 'open' ? 'primary' : 'secondary', disabled: c.join === 'open', onClick: () => send({ kind: 'privacy', mode: 'open' }) }),
        button({ label: 'Invite only', icon: 'lock', size: 'sm', variant: c.join === 'invite' ? 'primary' : 'secondary', disabled: c.join === 'invite', onClick: () => send({ kind: 'privacy', mode: 'invite' }) })));

    const locked = !c.style;
    const colourInput = h('input', { type: 'text', class: 'input clan-draft', value: c.colour || '', placeholder: '#ff8800 or teal', maxLength: 16, disabled: locked, autocomplete: 'off', spellcheck: false, dataset: { draft: 'colour' } });
    const colourErr = h('p', { class: 'field-error', attrs: { role: 'alert' } });
    const swatches = h('div', { class: 'clan-swatches', attrs: { role: 'group', 'aria-label': 'Colour names' } }, ...Object.keys(COLOURS).filter((k) => k !== 'gray').map((k) => {
      const b = h('button', { type: 'button', class: 'clan-swatch', disabled: locked, title: k, attrs: { 'aria-label': k }, on: { click: () => { colourInput.value = k; } } });
      b.style.setProperty('--swatch', colourHex(COLOURS[k]));
      return b;
    }));
    const colourForm = h('form', { class: 'clan-inline-form', on: { submit: (e) => {
      e.preventDefault();
      const n = parseClanColour(colourInput.value);
      colourErr.textContent = n === null ? 'Use a hex code like #ff8800 or a colour name like teal.' : '';
      if (n !== null) send({ kind: 'colour', colour: colourHex(n) });
    } } }, field({ label: 'Colour', input: colourInput, error: colourErr }), swatches, button({ label: 'Save colour', type: 'submit', icon: 'palette', disabled: locked }));
    const bannerInput = h('input', { type: 'text', class: 'input clan-draft', value: c.banner || '', placeholder: 'Night owls never sleep', maxLength: BANNER_MAX, disabled: locked, autocomplete: 'off', dataset: { draft: 'banner' } });
    const bannerErr = h('p', { class: 'field-error', attrs: { role: 'alert' } });
    const bannerForm = h('form', { class: 'clan-inline-form', on: { submit: (e) => {
      e.preventDefault();
      const r = checkClanBanner(bannerInput.value, { owner: view.owner });
      bannerErr.textContent = r.error || '';
      if (!r.error) send({ kind: 'banner', text: r.value || '' });
    } } }, field({ label: 'Banner', help: `Up to ${BANNER_MAX} characters. Leave it empty to clear it.`, input: bannerInput, error: bannerErr }), button({ label: 'Save banner', type: 'submit', icon: 'flag', disabled: locked }));
    return card({ title: 'Clan settings', icon: 'sliders' },
      tagForm,
      join,
      locked ? h('p', { class: 'clan-locked' }, icon('lock', { size: 14 }), h('span', { text: 'Colour and banner unlock with the "Colour and banner" upgrade below.' })) : null,
      colourForm,
      bannerForm);
  }

  function bankCard(c) {
    const s = view.settings;
    const ups = [
      { key: 'style', label: 'Colour and banner', price: s.stylePrice, owned: c.style, icon: 'palette' },
      { key: 'boost', label: `+${Math.round(s.boost * 100)}% XP for every member`, price: s.boostPrice, owned: c.boost, icon: 'sparkles' },
    ];
    return card({ title: 'Clan bank and upgrades', icon: 'coins' },
      h('p', { class: 'clan-bank' }, h('span', { class: 'clan-bank-amount', text: c.bank === null ? 'Not synced yet' : `${formatNumber(c.bank)} 💎` }), h('span', { class: 'field-help', text: 'Members add Shards with /clan deposit 100 in YapOS. Bank Shards only buy upgrades and never come back out.' })),
      c.deposits.length ? h('div', null, h('h3', { class: 'clan-subtitle', text: 'Top depositors' }), h('ol', { class: 'clan-deposits' }, ...c.deposits.map((d) => h('li', null, h('span', { text: d.name }), h('span', { class: 'clan-member-level', text: `${formatNumber(d.amount)} 💎` }))))) : null,
      h('ul', { class: 'clan-upgrades' }, ...ups.map((u) => h('li', { class: ['clan-upgrade', u.owned ? 'is-owned' : ''] },
        icon(u.icon, { size: 16 }),
        h('span', { class: 'clan-upgrade-name', text: u.label }),
        u.owned ? badge('Unlocked', 'success', 'check')
          : c.leader ? button({ label: `Buy · ${formatNumber(u.price)} 💎`, size: 'sm', variant: c.bank !== null && c.bank >= u.price ? 'primary' : 'secondary', onClick: () => send({ kind: 'upgrade', upgrade: u.key }, { confirm: { title: `Buy ${u.label}?`, body: `${formatNumber(u.price)} Shards come out of the clan bank. Upgrades last forever.`, confirmLabel: 'Buy it', tone: 'primary' } }) })
            : h('span', { class: 'clan-member-level', text: `${formatNumber(u.price)} 💎` })))));
  }

  function dangerCard(c) {
    const last = c.count <= 1;
    return card({ title: c.leader ? 'Leave or close' : 'Leave', icon: 'alert', className: 'clan-danger' },
      h('div', { class: 'clan-danger-row' },
        button({ label: 'Leave the clan', icon: 'logout', onClick: () => send({ kind: 'leave' }, { confirm: { title: 'Leave the clan?', body: last ? `You're the last member, so [${c.tag}] ${c.name} closes when you go. Its bank closes with it.` : `You'll leave [${c.tag}] ${c.name}.${c.leader ? ' The member who joined first becomes the leader.' : ''} Shards you put in the bank stay with the clan.`, confirmLabel: 'Leave' } }) }),
        c.leader ? button({ label: 'Close the clan', icon: 'trash', variant: 'danger', onClick: () => send({ kind: 'disband', confirm: true }, { confirm: { title: `Close [${c.tag}] ${c.name}?`, body: `This removes the clan for all ${formatNumber(c.count)} member${c.count === 1 ? '' : 's'}.${c.bank ? ` The bank of ${formatNumber(c.bank)} Shards is lost.` : ''} This can't be undone.`, confirmLabel: 'Close the clan' } }) }) : null));
  }

  function invitesCard() {
    if (!view.invites.length) return null;
    return card({ title: 'Your invites', icon: 'message' },
      h('ul', { class: 'clan-browse' }, ...view.invites.map((inv) => h('li', { class: 'clan-browse-item' },
        h('span', { class: 'clan-crest clan-crest-sm', attrs: { 'aria-hidden': 'true' }, text: inv.clan.tag }),
        h('div', { class: 'clan-browse-text' },
          h('p', { class: 'clan-browse-name' }, h('span', { class: 'clan-hero-tag', text: `[${inv.clan.tag}]` }), h('span', { text: inv.clan.name })),
          h('p', { class: 'field-help', text: `${inv.by ? `From ${inv.by} · ` : ''}${formatNumber(inv.clan.members)} member${inv.clan.members === 1 ? '' : 's'} · ${relativeTime(inv.at)}` })),
        h('div', { class: 'clan-member-actions' },
          button({ label: 'Join', icon: 'check', size: 'sm', variant: 'primary', onClick: () => send({ kind: 'accept', clan: inv.clan.id }) }),
          button({ label: 'No thanks', size: 'sm', onClick: () => send({ kind: 'decline', clan: inv.clan.id }) }))))));
  }

  function createCard() {
    const name = h('input', { type: 'text', class: 'input', placeholder: 'Night Owls', maxLength: NAME_MAX, autocomplete: 'off' });
    const tag = h('input', { type: 'text', class: 'input clan-tag-input', placeholder: 'OWL', maxLength: 4, autocomplete: 'off', spellcheck: false });
    const nameErr = h('p', { class: 'field-error', attrs: { role: 'alert' } });
    const tagErr = h('p', { class: 'field-error', attrs: { role: 'alert' } });
    const cost = view.settings.createCost;
    const submit = (e) => {
      e.preventDefault();
      const problems = createProblems({ name: name.value, tag: tag.value }, { owner: view.owner });
      nameErr.textContent = problems.name || '';
      tagErr.textContent = problems.tag || '';
      if (problems.name || problems.tag) return;
      send({ kind: 'create', name: checkClanName(name.value, { owner: view.owner }).value, tag: checkClanTag(tag.value, { owner: view.owner }).value }, {
        confirm: cost ? { title: 'Create this clan?', body: `It costs ${formatNumber(cost)} Shards from your wallet. You can only be in one clan at a time.`, confirmLabel: `Pay ${formatNumber(cost)} 💎`, tone: 'primary' } : null,
      });
    };
    return card({ title: 'Start a clan', icon: 'shield' },
      h('form', { class: 'clan-create', on: { submit } },
        field({ label: 'Clan name', help: `3 to ${NAME_MAX} characters.`, input: name, error: nameErr }),
        field({ label: 'Tag', help: '3 or 4 letters or numbers, like OWL or GG42.', input: tag, error: tagErr }),
        h('p', { class: 'field-help', text: `${cost ? `Costs ${formatNumber(cost)} 💎 Shards.` : 'Free right now.'} Colours and banners are an upgrade you buy later from the clan bank.` }),
        button({ label: 'Create clan', icon: 'plus', variant: 'primary', type: 'submit' })));
  }

  function browseCard() {
    const q = h('input', { type: 'search', class: 'input', placeholder: 'Search by tag or name', maxLength: 32, autocomplete: 'off' });
    const openOnly = h('input', { type: 'checkbox', id: nextId('clan-open') });
    const list = h('div', { class: 'clan-browse-wrap' });
    let page = 0;
    async function load() {
      const params = new URLSearchParams();
      if (q.value.trim()) params.set('q', q.value.trim());
      if (openOnly.checked) params.set('open', '1');
      if (page) params.set('page', String(page));
      replace(list, skeleton('skeleton-text skeleton-w-60'));
      try {
        const data = await api.get(`${CLAN_BROWSE_API}?${params}`, { signal: ctx.signal });
        if (ctx.signal?.aborted) return;
        const clans = Array.isArray(data?.clans) ? data.clans : [];
        if (!clans.length) {
          replace(list, emptyState({ icon: 'search', title: 'No clans found', body: 'Try another search, or start your own clan.', compact: true }));
          return;
        }
        replace(list,
          h('ul', { class: 'clan-browse' }, ...clans.map((c) => {
            const tag = str(c.tag, 4);
            const li = h('li', { class: 'clan-browse-item' },
              h('span', { class: 'clan-crest clan-crest-sm', attrs: { 'aria-hidden': 'true' }, text: tag }),
              h('div', { class: 'clan-browse-text' },
                h('p', { class: 'clan-browse-name' }, h('span', { class: 'clan-hero-tag', text: `[${tag}]` }), h('span', { text: str(c.name, 40) })),
                h('p', { class: 'field-help', text: `${formatNumber(num(c.members))} member${num(c.members) === 1 ? '' : 's'} · ${c.join === 'invite' ? 'Invite only' : 'Open'}${c.banner ? ` · ${str(c.banner, 60)}` : ''}` })),
              h('div', { class: 'clan-member-actions' },
                button({ label: c.join === 'invite' ? 'View' : 'View and join', size: 'sm', variant: c.join === 'invite' ? 'secondary' : 'primary', onClick: () => openClanSheet(tag, { api, signal: ctx.signal, clan: c }) })));
            const colour = safeColour(c.colour);
            if (colour) li.style.setProperty('--clan', colour);
            return li;
          })),
          h('div', { class: 'clan-browse-pages' },
            page > 0 ? button({ label: 'Previous', size: 'sm', onClick: () => { page -= 1; load(); } }) : null,
            data?.more ? button({ label: 'Next', size: 'sm', onClick: () => { page += 1; load(); } }) : null));
      } catch (err) {
        if (ctx.signal?.aborted) return;
        replace(list, emptyState({ icon: 'alert', title: "Couldn't load clans", body: err instanceof ApiError ? err.message : 'Try again in a moment.', compact: true }));
      }
    }
    const search = latestSearch(() => { page = 0; return load(); }, { min: 1 });
    q.addEventListener('input', () => search.push(q.value.trim()));
    openOnly.addEventListener('change', () => { page = 0; load(); });
    ctx.signal?.addEventListener?.('abort', () => search.cancel());
    load();
    return card({ title: 'Find a clan', icon: 'search' },
      h('div', { class: 'clan-browse-tools' }, q, h('label', { class: 'clan-check', htmlFor: openOnly.id }, openOnly, h('span', { text: 'Open clans only' }))),
      list);
  }

  function clearDraft(key) {
    for (const el of drafts()) if (el.dataset.draft === key) el.value = '';
  }

  function drafts() {
    return [...body.querySelectorAll('.clan-draft')].filter((el) => el.dataset && el.dataset.draft);
  }

  function keepDrafts(draw) {
    const saved = new Map();
    for (const el of drafts()) saved.set(el.dataset.draft, el.value);
    const active = body.ownerDocument ? body.ownerDocument.activeElement : null;
    const focusKey = active && body.contains(active) && active.dataset ? active.dataset.draft || null : null;
    let range = null;
    try {
      if (focusKey) range = [active.selectionStart, active.selectionEnd];
    } catch {
      range = null;
    }
    draw();
    for (const el of drafts()) {
      if (saved.has(el.dataset.draft) && !el.disabled && el.value !== saved.get(el.dataset.draft)) el.value = saved.get(el.dataset.draft);
    }
    if (!focusKey) return;
    const el = drafts().find((x) => x.dataset.draft === focusKey);
    if (!el || el.disabled) return;
    el.focus({ preventScroll: true });
    try {
      if (range && range[0] !== null) el.setSelectionRange(range[0], range[1]);
    } catch {
      return;
    }
  }

  let createEl = null;
  let browseEl = null;

  function paint() {
    if (!view) return;
    keepDrafts(draw);
  }

  function draw() {
    const c = view.clan;
    const pending = pendingActions(view).length;
    const note = pending ? h('p', { class: 'clan-pending-note', attrs: { role: 'status' } }, icon('clock', { size: 14 }), h('span', { text: `${pending} change${pending === 1 ? '' : 's'} waiting for YapOS. This page updates by itself.` })) : null;
    if (c) {
      createEl = null;
      browseEl = null;
      replace(body, note, heroCard(c), statusCard(), h('div', { class: 'clan-grid' },
        h('div', { class: 'clan-col' }, membersCard(c), c.leader ? inviteCard(c) : null, dangerCard(c)),
        h('div', { class: 'clan-col' }, bankCard(c), c.leader ? settingsCard(c) : null)));
      return;
    }
    replace(body, note,
      view.joining ? h('p', { class: 'clan-pending-note', attrs: { role: 'status' } }, icon('clock', { size: 14 }), h('span', { text: `You asked to join [${view.joining.tag}]. Waiting for YapOS.` })) : null,
      invitesCard(),
      statusCard(),
      h('div', { class: 'clan-grid' }, h('div', { class: 'clan-col' }, createEl || (createEl = createCard())), h('div', { class: 'clan-col' }, browseEl || (browseEl = browseCard()))));
  }

  reloadFn = mountAsync(body, {
    signal: ctx.signal,
    skeleton: pageSkeleton,
    load: ({ signal }) => api.get(CLAN_API, { signal }),
    render: (data) => {
      view = readClanView(data);
      for (const a of view.actions) known.set(a.id, a.status);
      paint();
      watch();
    },
  });
  return { reload: () => reloadFn && reloadFn() };
}
