import { h, replace, nextId } from '../dom.js';
import { avatar, button, card, emptyState, linkButton, loadingRegion, pageHeader, setBusy, skeleton, toast } from '../ui.js';
import { ApiError } from '../api.js';
import { icon } from '../icons.js';
import { mountAsync } from './common.js';
import { state } from '../state.js';
import { formatDate, relativeTime } from '../format.js';
import { openProfilePanel, durationName, hiddenTag, readHiddenNames } from './party-person.js';
import { gameName } from './party-reports.js';

export const MODLOG_PATH = '/api/party/modlog';
export const ACTION_LABELS = Object.freeze({
  ban: ['\u{1F6AB}', 'Bans'],
  unban: ['✅', 'Unbans'],
  ban_expire: ['⏰', 'Bans that ran out'],
  warn: ['⚠️', 'Warnings'],
  dismiss: ['\u{1F44C}', 'Dismissed reports'],
  dismiss_all: ['\u{1F9F9}', 'Dismiss all'],
  report_delete: ['\u{1F5D1}️', 'Deleted reports'],
  note_add: ['\u{1F4DD}', 'Notes added'],
  note_delete: ['\u{1F5D1}️', 'Notes deleted'],
  word_add: ['\u{1F6E1}️', 'Blocked words added'],
  word_remove: ['\u{1F6E1}️', 'Blocked words removed'],
  pack_dismiss: ['\u{1F44C}', 'Dismissed pack reports'],
  pack_hide: ['\u{1F648}', 'Word packs hidden'],
  pack_restore: ['\u{1F4E6}', 'Word packs put back'],
  owner_admin_add: ['\u{1F451}', 'Owner: party admins added'],
  owner_admin_remove: ['\u{1F451}', 'Owner: party admins removed'],
  owner_cheat_dismiss: ['\u{1F6A9}', 'Owner: cheat alerts dismissed'],
  owner_cheat_hide: ['\u{1F6A9}', 'Owner: cheat alerts, taken off boards'],
  owner_cheat_reset: ['\u{1F6A9}', 'Owner: cheat alerts, stats reset'],
  owner_cheat_reopen: ['\u{1F6A9}', 'Owner: cheat alerts reopened'],
  owner_points_set: ['\u{1F451}', 'Owner: all-time points set'],
  owner_record_set: ['\u{1F451}', 'Owner: games and wins set'],
  owner_best_set: ['\u{1F451}', 'Owner: best game set'],
  owner_game_set: ['\u{1F451}', 'Owner: points for one game set'],
  owner_month_set: ['\u{1F451}', 'Owner: monthly points set'],
  owner_counters_set: ['\u{1F451}', 'Owner: badge counters set'],
  owner_stats_add: ['\u{1F451}', 'Owner: games and wins added'],
  owner_reset: ['\u{1F451}', 'Owner: Party stats reset'],
  owner_board_hide: ['\u{1F451}', 'Owner: taken off leaderboards'],
  owner_board_show: ['\u{1F451}', 'Owner: put back on leaderboards'],
  owner_global_hide: ['\u{1F451}', 'Owner: hidden from the global leaderboard'],
  owner_global_show: ['\u{1F451}', 'Owner: put back on the global leaderboard'],
  owner_badge_create: ['\u{1F3C5}', 'Owner: badges made'],
  owner_badge_edit: ['\u{1F3C5}', 'Owner: badges edited'],
  owner_badge_delete: ['\u{1F3C5}', 'Owner: badges deleted'],
  owner_banner_remove: ['\u{1F5BC}️', 'Owner: profile banners removed'],
  owner_profile_text_clear: ['\u{1F9FD}','Owner: profile text cleared'],
  profile_banner_remove: ['\u{1F5BC}️', 'Profile banners removed'],
  profile_avatar_remove: ['\u{1F5BC}️', 'Uploaded profile pictures removed'],
  profile_text_clear: ['\u{1F9FD}','Profile text cleared'],
  profile_name_style_reset: ['\u{1F3A8}', 'Name styles reset'],
  profile_pins_clear: ['\u{1F4CC}', 'Pinned badges cleared'],
  profile_theme_reset: ['\u{1F308}', 'Profile themes reset'],
  profile_effect_clear: ['\u{2728}', 'Profile effects turned off'],
  profile_reset: ['\u{1F504}', 'Whole profiles reset'],
  name_hide: ['\u{1F648}', 'Names hidden'],
  name_unhide: ['\u{1F440}', 'Names shown again'],
  owner_pattern_add: ['\u{1F6E1}️', 'Owner: blocked patterns added'],
  owner_pattern_edit: ['\u{1F6E1}️', 'Owner: blocked patterns changed'],
  owner_pattern_remove: ['\u{1F6E1}️', 'Owner: blocked patterns removed'],
  song_add: ['\u{1F3B5}', 'Beat Drop songs added'],
  song_edit: ['\u{1F3B5}', 'Beat Drop songs edited'],
  song_hide: ['\u{1F648}', 'Beat Drop songs hidden'],
  song_show: ['\u{1F3B5}', 'Beat Drop songs shown again'],
  song_mature: ['\u{1F51E}', 'Beat Drop songs marked 18+'],
  song_all_ages: ['\u{1F3B5}', 'Beat Drop songs marked fine for everyone'],
  song_delete: ['\u{1F5D1}️', 'Beat Drop songs deleted'],
});
export const CHEAT_LABELS = Object.freeze({
  daily_points: 'Daily points cap',
  daily_games: 'Daily games cap',
  game_cap: 'Score at the game cap',
  win_rate: 'Win rate',
  farm: 'Same opponent again and again',
  fast: 'Games too close together',
  same_name: 'Same name as the other player',
  reported: 'Reported for cheating',
});
const OWNER_ICON = '\u{1F451}';
const OTHER_ICON = '\u{1F527}';

const str = (v) => (typeof v === 'string' && v ? v : '');
const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== undefined ? Number(v) : null);

export function modLogUrl(f = {}, before = null) {
  const q = new URLSearchParams();
  if (f.actor) q.set('actor', f.actor);
  if (f.action) q.set('action', f.action);
  if (f.target) q.set('target', f.target);
  if (before) q.set('before', before);
  const s = q.toString();
  return s ? `${MODLOG_PATH}?${s}` : MODLOG_PATH;
}

function readWho(w) {
  if (!w || typeof w !== 'object' || typeof w.id !== 'string') return null;
  return { id: w.id, name: str(w.name), username: str(w.username), avatar: str(w.avatar), system: w.system === true, ...(w.hiddenNames ? { hiddenNames: readHiddenNames(w.hiddenNames) } : {}) };
}

export function readModLog(data) {
  const entries = (Array.isArray(data?.entries) ? data.entries : []).filter((e) => e && typeof e.id === 'string' && typeof e.action === 'string').map((e) => ({
    id: e.id,
    action: e.action,
    actor: readWho(e.actor) || { id: '', name: '', username: '', avatar: '', system: false },
    target: readWho(e.target),
    detail: e.detail && typeof e.detail === 'object' && !Array.isArray(e.detail) ? e.detail : {},
    created: num(e.created) || 0,
  }));
  return {
    entries,
    next: typeof data?.next === 'string' && data.next ? data.next : null,
    actors: (Array.isArray(data?.actors) ? data.actors : []).map((a) => {
      const who = readWho(a);
      return who ? { ...who, count: Number(a.count) || 0 } : null;
    }).filter(Boolean),
    actions: (Array.isArray(data?.actions) ? data.actions : []).filter((a) => a && typeof a.action === 'string').map((a) => ({ action: a.action, count: Number(a.count) || 0 })),
    role: data?.role === 'owner' ? 'owner' : 'admin',
  };
}

export function actionIcon(action) {
  if (ACTION_LABELS[action]) return ACTION_LABELS[action][0];
  if (action.startsWith('owner_')) return OWNER_ICON;
  if (action.startsWith('cheat')) return '\u{1F6A9}';
  return OTHER_ICON;
}

export function actionLabel(action) {
  if (ACTION_LABELS[action]) return ACTION_LABELS[action][1];
  if (action.startsWith('owner_')) return `Owner: ${action.slice(6).replace(/_/g, ' ')}`;
  const words = action.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function clip(text, max = 120) {
  const s = str(text);
  return Array.from(s).length > max ? `${Array.from(s).slice(0, max - 1).join('')}…` : s;
}

export function modLogSentence(e) {
  const who = e.actor.system ? 'YapOS' : e.actor.name || 'A mod';
  const them = e.target ? e.target.name || (e.target.username ? `@${e.target.username}` : 'a player') : 'someone';
  const d = e.detail || {};
  const reason = str(d.reason);
  switch (e.action) {
    case 'ban': {
      const length = durationName(d.duration);
      return `${who} banned ${them}${length ? ` for ${length}` : ' until unbanned'}${reason ? `: ${clip(reason)}` : ''}`;
    }
    case 'unban':
      return d.early ? `${who} unbanned ${them} early` : `${who} unbanned ${them}`;
    case 'ban_expire': {
      const length = durationName(d.duration);
      return `${them}'s ${length ? `${length} ` : ''}ban ran out`;
    }
    case 'warn':
      return `${who} warned ${them}${d.text ? `: “${clip(d.text)}”` : ''}`;
    case 'dismiss':
      return `${who} dismissed a report about ${them}${d.game ? ` in ${gameName(d.game)}` : ''}`;
    case 'dismiss_all': {
      const n = Number(d.count) || 0;
      return `${who} dismissed ${n ? `${n} open ${n === 1 ? 'report' : 'reports'}` : 'the open reports'} about ${them}`;
    }
    case 'report_delete':
      return `${who} deleted a report about ${them}${d.game ? ` in ${gameName(d.game)}` : ''}`;
    case 'note_add':
      return `${who} added a mod note about ${them}`;
    case 'note_delete':
      return `${who} deleted a mod note about ${them}`;
    case 'word_add':
      return `${who} blocked ${d.word ? `the word “${clip(d.word, 40)}”` : 'a word'}`;
    case 'word_remove':
      return `${who} unblocked ${d.word ? `the word “${clip(d.word, 40)}”` : 'a word'}`;
    case 'owner_pattern_add':
      return `${who} blocked ${str(d.pattern) ? `the pattern “${clip(d.pattern, 120)}”` : 'a pattern'}`;
    case 'owner_pattern_edit':
      return `${who} changed ${str(d.before) ? `the pattern “${clip(d.before, 120)}”` : 'a pattern'}${str(d.pattern) ? ` to “${clip(d.pattern, 120)}”` : ''}`;
    case 'owner_pattern_remove':
      return `${who} unblocked ${str(d.pattern) ? `the pattern “${clip(d.pattern, 120)}”` : 'a pattern'}`;
    case 'pack_dismiss':
    case 'pack_hide':
    case 'pack_restore': {
      const pack = str(d.pack) ? `the word pack “${clip(d.pack, 60)}”` : 'a word pack';
      const by = e.target ? ` by ${them}` : '';
      if (e.action === 'pack_dismiss') return `${who} dismissed a report about ${pack}${by}`;
      if (e.action === 'pack_hide') return `${who} hid ${pack}${by} from the pack browser`;
      return `${who} put ${pack}${by} back in the pack browser`;
    }
    case 'owner_admin_add':
      return `${who} made ${them} a party admin`;
    case 'owner_admin_remove':
      return `${who} removed ${them} as a party admin`;
    case 'owner_cheat_dismiss':
    case 'owner_cheat_hide':
    case 'owner_cheat_reset':
    case 'owner_cheat_reopen': {
      const kind = CHEAT_LABELS[str(d.kind)] ? `“${CHEAT_LABELS[str(d.kind)]}” ` : '';
      const why = str(d.summary) ? ` (${clip(d.summary, 120)})` : '';
      if (e.action === 'owner_cheat_dismiss') return `${who} dismissed the ${kind}cheat alert about ${them}${why}`;
      if (e.action === 'owner_cheat_reopen') return `${who} reopened the ${kind}cheat alert about ${them}${why}`;
      if (e.action === 'owner_cheat_hide') return `${who} took ${them} off the Party leaderboards after the ${kind}cheat alert${why}`;
      return `${who} reset ${them}'s Party stats after the ${kind}cheat alert${why}`;
    }
    case 'owner_board_hide':
      return `${who} took ${them} off the Party leaderboards`;
    case 'owner_board_show':
      return `${who} put ${them} back on the Party leaderboards`;
    case 'owner_global_hide':
      return `${who} hid ${them} from the global leaderboard`;
    case 'owner_global_show':
      return `${who} put ${them} back on the global leaderboard`;
    case 'owner_reset':
      return `${who} reset ${them}'s Party leaderboard stats`;
    case 'owner_badge_create':
      return `${who} made a new badge${str(d.name) ? `, “${clip(d.name, 40)}”` : ''}`;
    case 'owner_badge_edit': {
      const before = str(d.before);
      const now = str(d.name);
      if (before && now && before !== now) return `${who} renamed the badge “${clip(before, 40)}” to “${clip(now, 40)}”`;
      const parts = (Array.isArray(d.changed) ? d.changed : []).filter((x) => typeof x === 'string').slice(0, 4);
      return `${who} changed the ${parts.length ? parts.join(', ') : 'details'} of the badge${now ? ` “${clip(now, 40)}”` : ''}`;
    }
    case 'owner_badge_delete': {
      const n = Number(d.holders) || 0;
      return `${who} deleted the badge${str(d.name) ? ` “${clip(d.name, 40)}”` : ''}${n ? ` and took it off ${n} ${n === 1 ? 'person' : 'people'}` : ''}`;
    }
    case 'owner_banner_remove':
    case 'profile_banner_remove':
      return `${who} removed ${them}'s profile banner picture`;
    case 'profile_avatar_remove':
      return `${who} removed ${them}'s uploaded profile picture`;
    case 'profile_text_clear': {
      const names = { bio: 'about me', status: 'status', pronouns: 'pronouns' };
      const list = (Array.isArray(d.fields) ? d.fields : []).filter((f) => names[f]).map((f) => names[f]);
      const what = list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}` : list[0] || 'profile text';
      return `${who} cleared ${them}'s ${what}`;
    }
    case 'profile_name_style_reset':
      return `${who} reset ${them}'s name color and style`;
    case 'profile_pins_clear':
      return `${who} cleared ${them}'s pinned badges`;
    case 'profile_theme_reset':
      return `${who} reset ${them}'s profile theme`;
    case 'profile_effect_clear':
      return `${who} turned off ${them}'s profile effect`;
    case 'profile_reset':
      return `${who} reset ${them}'s whole profile look`;
    case 'name_hide':
      return `${who} hid ${them}'s ${d.what === 'username' ? 'username' : 'display name'} on YapOS${reason ? `: ${clip(reason)}` : ''}`;
    case 'name_unhide':
      return `${who} showed ${them}'s ${d.what === 'username' ? 'username' : 'display name'} on YapOS again`;
    case 'owner_profile_text_clear':
      return `${who} cleared ${them}'s about me and status`;
    case 'owner_stats_add':
    case 'owner_points_set':
    case 'owner_record_set':
    case 'owner_best_set':
    case 'owner_game_set':
    case 'owner_month_set':
    case 'owner_counters_set': {
      const summary = str(d.summary).replace(/\btheir\b/, `${them}'s`);
      return summary ? `${who}: ${clip(summary, 200)}` : `${who} edited ${them}'s Party stats`;
    }
    default: {
      const summary = str(d.summary);
      if (summary) return `${who}${e.target ? ` (${them})` : ''}: ${clip(summary, 160)}`;
      return `${who}: ${actionLabel(e.action).toLowerCase()}${e.target ? ` for ${them}` : ''}`;
    }
  }
}

function staffOnly() {
  return emptyState({
    icon: 'lock',
    title: 'Only party staff can open this',
    body: 'The mod log shows what the owner and party admins do in YapOS Party. Ask the owner if you think you should see it.',
    action: linkButton({ label: 'Back to your servers', href: '/servers', icon: 'chevron-left' }),
  });
}

function listSkeleton() {
  return loadingRegion('Loading the mod log', h('ul', { class: 'party-list modlog-list' },
    ...[0, 1, 2].map(() => h('li', { class: 'party-row is-skeleton' }, skeleton('skeleton-avatar'), h('span', { class: 'party-row-main' }, skeleton('skeleton-text skeleton-w-60'), skeleton('skeleton-text skeleton-w-40'))))));
}

function selectField(label, options, value, onChange) {
  const id = nextId('modlog-filter');
  const sel = h('select', { id, class: 'input select modlog-select' }, ...options.map(([v, text]) => {
    const o = h('option', { value: v, text });
    if (v === value) o.selected = true;
    return o;
  }));
  sel.addEventListener('change', () => onChange(sel.value));
  return h('div', { class: 'modlog-filter' }, h('label', { class: 'field-label', htmlFor: id, text: label }), h('div', { class: 'select-shell' }, sel, icon('chevron-down', { size: 14, className: 'select-caret' })));
}

export function renderPartyModLog(ctx) {
  const { api, main } = ctx;
  ctx.setChrome({ variant: 'plain', section: 'party-reports', crumbs: [{ label: 'Servers', href: '/servers' }, { label: 'Party reports', href: '/party/reports' }, { label: 'Mod log' }] });
  if (!state.partyAdmin && !state.partyOwner) {
    main.replaceChildren(h('div', { class: 'page page-narrow' }, staffOnly()));
    return;
  }

  const filter = { actor: '', action: '', target: '' };
  let view = readModLog(null);
  let targetName = '';
  const tools = h('div', { class: 'modlog-tools' });
  const body = h('div', { class: 'party-list-wrap modlog-wrap' });
  const page = h('div', { class: 'page page-narrow party-page modlog-page' },
    pageHeader({
      title: 'Party mod log',
      description: state.partyOwner
        ? 'Every ban, unban, warning, dismissed report, note, blocked word, hidden word pack, profile reset and hidden name by the owner and party admins, newest first. Your owner panel changes, cheat alerts and admin changes show here too, only for you.'
        : 'Every ban, unban, warning, dismissed report, note, blocked word, hidden word pack, profile reset and hidden name by the owner and party admins, newest first.',
      actions: linkButton({ label: 'Party reports', href: '/party/reports', icon: 'flag', size: 'sm' }),
    }),
    card({ title: 'What staff did', icon: 'list', actions: tools }, body));
  main.replaceChildren(page);

  function drawTools() {
    const actors = [['', 'Every mod'], ...view.actors.map((a) => [a.id, `${a.system ? 'YapOS (automatic)' : a.name || a.id} (${a.count})`])];
    if (filter.actor && !actors.some(([v]) => v === filter.actor)) actors.push([filter.actor, filter.actor]);
    const actions = [['', 'Every action'], ...view.actions.map((a) => [a.action, `${actionLabel(a.action)} (${a.count})`])];
    if (filter.action && !actions.some(([v]) => v === filter.action)) actions.push([filter.action, actionLabel(filter.action)]);
    replace(tools,
      selectField('Mod', actors, filter.actor, (v) => { filter.actor = v; reload(); }),
      selectField('Action', actions, filter.action, (v) => { filter.action = v; reload(); }),
      filter.target ? button({ label: `Only ${targetName || 'one player'}`, icon: 'x', size: 'sm', ariaLabel: 'Show every player again', onClick: () => { filter.target = ''; targetName = ''; reload(); } }) : null);
  }

  function openPerson(t) {
    openProfilePanel({
      api,
      signal: ctx.signal,
      id: t.id,
      seed: { name: t.name, avatar: t.avatar },
      role: view.role,
      gameName,
      navigate: typeof ctx.navigate === 'function' ? ctx.navigate : null,
      onHistory: () => {
        filter.target = t.id;
        targetName = t.name || t.username || '';
        reload();
      },
      onChanged: () => reload(),
    });
  }

  function row(e) {
    const sentence = modLogSentence(e);
    const face = e.actor.system
      ? h('span', { class: 'modlog-system', text: '⚙️', attrs: { 'aria-hidden': 'true' } })
      : avatar({ name: e.actor.name || e.actor.id, url: e.actor.avatar, id: e.actor.id, size: 'md' });
    const target = e.target
      ? h('button', { type: 'button', class: 'report-who-link modlog-target', attrs: { title: `Open ${e.target.name || 'their'} profile and history` }, on: { click: () => openPerson(e.target) } }, e.target.name || e.target.username || e.target.id)
      : null;
    return h('li', { class: ['party-row', 'modlog-row', `is-${e.action.replace(/[^a-z0-9_]/g, '')}`], dataset: { id: e.id, action: e.action } },
      face,
      h('span', { class: 'party-row-main' },
        h('span', { class: 'modlog-line' },
          h('span', { class: 'modlog-icon', text: actionIcon(e.action), attrs: { 'aria-hidden': 'true' } }),
          h('span', { class: 'modlog-text', text: sentence })),
        h('span', { class: 'party-row-sub modlog-meta' },
          h('time', { class: 'report-time', attrs: { datetime: new Date(e.created || 0).toISOString(), title: formatDate(e.created) }, text: relativeTime(e.created) }),
          target ? h('span', { class: 'modlog-sep', text: ' · ', attrs: { 'aria-hidden': 'true' } }) : null,
          target,
          e.target ? hiddenTag(e.target.hiddenNames) : null)));
  }

  function more(btn) {
    if (!view.next) return;
    setBusy(btn, true, 'Loading');
    api.get(modLogUrl(filter, view.next), { signal: ctx.signal }).then((data) => {
      const next = readModLog(data);
      view = { ...view, entries: view.entries.concat(next.entries), next: next.next };
      draw();
    }).catch((err) => {
      if (ctx.signal?.aborted) return;
      if (btn.isConnected) setBusy(btn, false);
      toast(err instanceof ApiError ? err.message : 'That did not work. Try again.', { tone: 'danger', title: "Couldn't load more" });
    });
  }

  function draw() {
    drawTools();
    if (!view.entries.length) {
      replace(body, emptyState({ icon: 'inbox', title: filter.actor || filter.action || filter.target ? 'Nothing matches' : 'Nothing yet', body: filter.actor || filter.action || filter.target ? 'Try another mod or action.' : 'Bans, warnings, dismissed reports and notes show up here.', compact: true }));
      return;
    }
    replace(body,
      h('ul', { class: 'party-list modlog-list' }, ...view.entries.map(row)),
      view.next ? h('div', { class: 'report-more' }, button({ label: 'Show older', icon: 'chevron-down', size: 'sm', onClick: (e) => more(e.currentTarget) })) : null);
  }

  function reload() {
    mountAsync(body, {
      signal: ctx.signal,
      skeleton: listSkeleton,
      load: async ({ signal }) => {
        try {
          return await api.get(modLogUrl(filter), { signal });
        } catch (err) {
          if (err instanceof ApiError && err.status === 403) return { staffOnly: true };
          throw err;
        }
      },
      render: (data) => {
        if (data?.staffOnly) {
          replace(tools);
          replace(body, staffOnly());
          return;
        }
        view = readModLog(data);
        draw();
      },
    });
  }

  drawTools();
  reload();
}
