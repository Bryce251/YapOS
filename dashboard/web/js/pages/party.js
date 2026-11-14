import { h, nextId, replace } from '../dom.js';
import { icon } from '../icons.js';
import { avatar, badge, button, card, confirmDialog, emptyState, linkButton, loadingRegion, pageHeader, setBusy, skeleton, toast } from '../ui.js';
import { ApiError } from '../api.js';
import { mountAsync } from './common.js';
import { state } from '../state.js';

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const EXAMPLE_ID = '1a2b3c4d-1a2b-1a2b-1a2b-1a2b3c4d5e6f';
const NAME_RETRIES = 4;
const NAME_RETRY_MS = 4000;
export const PARTY_ADMINS_PATH = '/api/party/admins';

export function pickUserId(text) {
  const m = UUID_RE.exec(String(text || ''));
  return m ? m[0].toLowerCase() : '';
}

function readPerson(p) {
  if (!p || typeof p !== 'object' || typeof p.id !== 'string') return null;
  return {
    id: p.id,
    username: typeof p.username === 'string' && p.username ? p.username : '',
    display_name: typeof p.display_name === 'string' && p.display_name ? p.display_name : '',
    avatar: typeof p.avatar === 'string' ? p.avatar : '',
  };
}

export function readAdmins(data) {
  const admins = Array.isArray(data?.admins) ? data.admins.map(readPerson).filter(Boolean) : [];
  return {
    owner: readPerson(data?.owner),
    admins,
    max: Number.isInteger(data?.max) && data.max > 0 ? data.max : 50,
    pending: Array.isArray(data?.pending) ? data.pending.filter((id) => typeof id === 'string') : [],
  };
}

const nameOf = (p) => p.display_name || p.username || '';

function ownerOnlyView() {
  return emptyState({
    icon: 'lock',
    title: 'Only the owner can open this',
    body: 'Party admins are picked by the owner of YapOS Party. If you think you should have the ADMIN panel, ask them to add you.',
    action: linkButton({ label: 'Back to your servers', href: '/servers', icon: 'chevron-left' }),
  });
}

function listSkeleton() {
  return loadingRegion('Loading party admins', h('ul', { class: 'party-list' }, ...Array.from({ length: 3 }, () => h('li', { class: 'party-row is-skeleton' },
    skeleton('skeleton-avatar'),
    h('span', { class: 'party-row-main' }, skeleton('skeleton-text skeleton-w-40'), skeleton('skeleton-text skeleton-w-60'))))));
}

function personRow(p, { owner = false, waiting = false, onRemove } = {}) {
  const name = nameOf(p);
  const title = name || (waiting ? 'Looking up their name' : 'Name not known yet');
  const sub = p.username
    ? h('span', { class: 'party-row-sub', text: `@${p.username}` })
    : h('code', { class: 'party-row-id', text: p.id });
  const end = owner
    ? h('span', { class: 'party-row-end' }, badge('Owner', 'accent', 'crown'), h('span', { class: 'party-row-note', text: 'Always an admin' }))
    : h('span', { class: 'party-row-end' }, button({ label: 'Remove', icon: 'x', size: 'sm', ariaLabel: `Remove ${name || p.id} as a party admin`, onClick: (e) => onRemove(p, e.currentTarget) }));
  return h('li', { class: ['party-row', owner ? 'is-owner' : ''], dataset: { id: p.id } },
    avatar({ name: name || p.id, url: p.avatar, id: p.id, size: 'md' }),
    h('span', { class: 'party-row-main' },
      h('span', { class: ['party-row-title', name ? '' : 'muted'], text: title }),
      sub),
    end);
}

export function renderParty(ctx) {
  const { api, main } = ctx;
  ctx.setChrome({ variant: 'plain', section: 'party', crumbs: [{ label: 'Servers', href: '/servers' }, { label: 'Party admins' }] });
  if (!state.partyOwner) {
    main.replaceChildren(h('div', { class: 'page page-narrow' }, ownerOnlyView()));
    return;
  }

  let current = readAdmins(null);
  let retries = 0;
  let retryTimer = null;
  ctx.signal?.addEventListener?.('abort', () => clearTimeout(retryTimer), { once: true });

  const inputId = nextId('party-id');
  const hintId = nextId('party-hint');
  const errorId = nextId('party-error');
  const input = h('input', {
    type: 'text',
    id: inputId,
    class: 'input input-mono',
    placeholder: EXAMPLE_ID,
    maxLength: 200,
    autocomplete: 'off',
    spellcheck: false,
    attrs: { 'aria-describedby': `${hintId} ${errorId}` },
  });
  const errorEl = h('p', { class: 'field-error', id: errorId, attrs: { role: 'alert' } });
  const addBtn = button({ label: 'Add', icon: 'plus', variant: 'primary', type: 'submit' });
  const form = h('form', { class: 'party-add', attrs: { novalidate: true } },
    h('label', { class: 'field-label', htmlFor: inputId, text: 'User id' }),
    h('div', { class: 'inline-form' }, input, addBtn),
    h('p', { class: 'field-help', id: hintId, text: "In Yapin', turn on Settings → Advanced → Developer Mode, then right-click the person and pick Copy User ID. Paste it here." }),
    errorEl);

  const setError = (text) => {
    errorEl.textContent = text || '';
    input.classList.toggle('is-invalid', Boolean(text));
    if (text) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  };
  input.addEventListener('input', () => setError(''));

  const countEl = h('span', { class: 'party-count' });
  const listBody = h('div', { class: 'party-list-wrap' });
  const page = h('div', { class: 'page page-narrow party-page' },
    pageHeader({
      title: 'Party admins',
      description: 'Party admins get the ADMIN panel in YapOS Party calls, where they can start, skip and end games, add time, give or take points, kick, ban or lock the room, post announcements and play harmless pranks on people.',
    }),
    card({ title: 'Add a party admin', icon: 'plus' }, form),
    card({ title: 'Admins', icon: 'crown', actions: countEl }, listBody));
  main.replaceChildren(page);

  function scheduleNames() {
    clearTimeout(retryTimer);
    if (!current.pending.length || retries >= NAME_RETRIES || ctx.signal?.aborted) return;
    retries += 1;
    retryTimer = setTimeout(async () => {
      try {
        const data = await api.get(PARTY_ADMINS_PATH, { signal: ctx.signal });
        if (ctx.signal?.aborted) return;
        show(data, { keepRetries: true });
      } catch {}
    }, NAME_RETRY_MS);
  }

  async function remove(p, btn) {
    const name = nameOf(p) || 'this person';
    const ok = await confirmDialog({
      title: `Remove ${name}?`,
      body: 'They lose the ADMIN panel in YapOS Party within about a minute. You can add them back any time.',
      confirmLabel: 'Remove',
    });
    if (!ok || ctx.signal?.aborted) return;
    if (btn?.isConnected) setBusy(btn, true, 'Removing');
    try {
      const data = await api.request('DELETE', `${PARTY_ADMINS_PATH}/${encodeURIComponent(p.id)}`, { signal: ctx.signal });
      if (ctx.signal?.aborted) return;
      show(data);
      toast(nameOf(p) ? `${nameOf(p)} is no longer a party admin.` : 'Removed. They are no longer a party admin.');
    } catch (err) {
      if (ctx.signal?.aborted) return;
      if (btn?.isConnected) setBusy(btn, false);
      toast(err instanceof ApiError ? err.message : 'That did not work. Try again.', { tone: 'danger', title: "Couldn't remove them" });
    }
  }

  function show(data, { keepRetries = false } = {}) {
    current = readAdmins(data);
    if (!keepRetries) retries = 0;
    const owner = current.owner || { id: state.user?.id || '', username: state.user?.username || '', display_name: state.user?.display_name || '', avatar: state.user?.avatar_url || '' };
    const waiting = new Set(current.pending);
    countEl.textContent = `${current.admins.length} of ${current.max}`;
    const rows = [personRow(owner, { owner: true })].concat(current.admins.map((p) => personRow(p, { waiting: waiting.has(p.id), onRemove: remove })));
    replace(listBody,
      h('ul', { class: 'party-list' }, ...rows),
      current.admins.length ? null : h('p', { class: 'party-empty muted', text: "No extra admins yet. Paste someone's user id above to give them the ADMIN panel." }));
    addBtn.disabled = current.admins.length >= current.max;
    scheduleNames();
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (addBtn.disabled) return;
    const id = pickUserId(input.value);
    if (!input.value.trim()) return setError('Paste a user id first.');
    if (!id) return setError(`That doesn't look like a Yapin' user id. It should look like ${EXAMPLE_ID}.`);
    if (current.owner && id === current.owner.id.toLowerCase()) return setError("That's you! You're the owner, so you're always an admin.");
    if (current.admins.some((p) => p.id.toLowerCase() === id)) return setError("They're already a party admin.");
    if (current.admins.length >= current.max) return setError(`You already have ${current.max} party admins. Remove someone first.`);
    setError('');
    setBusy(addBtn, true, 'Adding');
    try {
      const data = await api.post(PARTY_ADMINS_PATH, { id }, { signal: ctx.signal });
      if (ctx.signal?.aborted) return;
      setBusy(addBtn, false);
      input.value = '';
      show(data);
      const added = current.admins.find((p) => p.id === id);
      const name = added ? nameOf(added) : '';
      toast(name ? `${name} is now a party admin.` : 'Added. Their name shows up here once YapOS looks it up.');
    } catch (err) {
      if (ctx.signal?.aborted) return;
      setBusy(addBtn, false);
      addBtn.disabled = current.admins.length >= current.max;
      setError(err instanceof ApiError ? err.message : 'That did not work. Try again.');
    }
  });

  mountAsync(listBody, {
    signal: ctx.signal,
    skeleton: listSkeleton,
    load: async ({ signal }) => {
      try {
        return await api.get(PARTY_ADMINS_PATH, { signal });
      } catch (err) {
        if (err instanceof ApiError && err.status === 403) return { ownerOnly: true };
        throw err;
      }
    },
    render: (data) => {
      if (data?.ownerOnly) {
        state.partyOwner = false;
        replace(main, h('div', { class: 'page page-narrow' }, ownerOnlyView()));
        return;
      }
      show(data);
    },
  });
}
