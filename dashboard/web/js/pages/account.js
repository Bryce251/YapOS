import { h, nextId, replace } from '../dom.js';
import { avatar, card, linkButton, loadingRegion, pageHeader, skeleton, switchControl, toast } from '../ui.js';
import { ApiError } from '../api.js';
import { profilePath } from '../router.js';
import { state } from '../state.js';
import { mountAsync } from './common.js';
import { partySigninsCard } from './link.js';

export const VISIBILITY_API = '/api/me/profile-visibility';

export function readVisibility(data) {
  const v = data && typeof data === 'object' && data.settings && typeof data.settings === 'object' ? data.settings : data;
  return {
    hidden: v?.hidden === true,
    showShards: v?.showShards === true,
    pending: v?.pending === true || data?.pending === true,
  };
}

function settingRow({ title, body, control, id }) {
  return h('div', { class: 'setting-row' },
    h('div', { class: 'setting-text' },
      h('label', { class: 'setting-title', htmlFor: id, text: title }),
      h('p', { class: 'setting-body', text: body })),
    control);
}

function rowsSkeleton() {
  return loadingRegion('Loading your privacy settings', h('div', { class: 'setting-list' },
    ...Array.from({ length: 2 }, () => h('div', { class: 'setting-row' }, h('div', { class: 'setting-text' }, skeleton('skeleton-text skeleton-w-40'), skeleton('skeleton-text skeleton-w-60'))))));
}

export function renderAccount(ctx) {
  const { api, main } = ctx;
  ctx.setChrome({ variant: 'plain', section: 'account', crumbs: [{ label: 'Servers', href: '/servers' }, { label: 'Your account' }] });
  const user = state.user || {};
  const name = user.display_name || user.username || 'You';
  const viewLink = user.username ? linkButton({ label: 'View my profile', href: profilePath(user.username), icon: 'eye', size: 'sm' }) : null;
  const body = h('div', { class: 'setting-wrap' });
  const note = h('p', { class: 'field-help account-note', attrs: { 'aria-live': 'polite' } });

  main.replaceChildren(h('div', { class: 'page page-narrow account-page' },
    pageHeader({
      title: 'Your account',
      description: 'Choose what other people can see about you on yapos.dev.',
    }),
    card({ title: 'Signed in as', icon: 'user' },
      h('div', { class: 'account-who' },
        avatar({ name, url: user.avatar_url, still: user.avatar_still, id: user.id, size: 'lg' }),
        h('div', { class: 'account-who-text' },
          h('span', { class: 'account-name', text: name }),
          user.username ? h('span', { class: 'account-handle', text: `@${user.username}` }) : null),
        viewLink)),
    card({ title: 'Public profile', icon: 'globe' }, body, note),
    partySigninsCard(ctx)));

  function draw(data) {
    let current = readVisibility(data);
    const publicId = nextId('vis-public');
    const shardsId = nextId('vis-shards');
    const publicSwitch = switchControl({ id: publicId, checked: !current.hidden, label: 'Show my profile', onChange: (on) => save({ hidden: !on }, publicSwitch) });
    const shardsSwitch = switchControl({ id: shardsId, checked: current.showShards, disabled: current.hidden, label: 'Show my Shards balance', onChange: (on) => save({ showShards: on }, shardsSwitch) });
    const setNote = (v) => {
      note.textContent = v.pending ? 'Saved. YapOS updates your public page within a minute or two.' : (v.hidden ? 'Your profile is private. Its link shows "not available" to everyone.' : 'Your profile shows your name, level, badges, favourite games and season placings. Never your servers.');
    };
    setNote(current);

    async function save(change, sw) {
      const next = { hidden: current.hidden, showShards: current.showShards, ...change };
      sw.setBusy(true);
      publicSwitch.setDisabled(true);
      shardsSwitch.setDisabled(true);
      try {
        const data = await api.post(VISIBILITY_API, { hidden: next.hidden, showShards: next.showShards }, { signal: ctx.signal });
        if (ctx.signal?.aborted) return;
        const saved = readVisibility(data && typeof data === 'object' && ('hidden' in data || 'settings' in data) ? data : { ...next, pending: true });
        current = { hidden: saved.hidden, showShards: saved.showShards, pending: saved.pending };
        toast(current.hidden ? 'Your profile is now private.' : 'Your profile settings are saved.');
      } catch (err) {
        if (ctx.signal?.aborted) return;
        toast(err instanceof ApiError ? err.message : 'That did not work. Try again.', { tone: 'danger', title: "Couldn't save" });
      }
      sw.setBusy(false);
      publicSwitch.set(!current.hidden);
      shardsSwitch.set(current.showShards);
      publicSwitch.setDisabled(false);
      shardsSwitch.setDisabled(current.hidden);
      setNote(current);
    }

    replace(body, h('div', { class: 'setting-list' },
      settingRow({ id: publicId, title: 'Show my profile', body: user.username ? `Anyone with the link yapos.dev${profilePath(user.username)} can see it.` : 'Anyone with your profile link can see it.', control: publicSwitch.el }),
      settingRow({ id: shardsId, title: 'Show my 💎 Shards balance', body: 'Off by default. Turn it on to show your balance on your profile.', control: shardsSwitch.el })));
  }

  mountAsync(body, {
    signal: ctx.signal,
    skeleton: rowsSkeleton,
    load: ({ signal }) => api.get(VISIBILITY_API, { signal }),
    render: draw,
  });
}
