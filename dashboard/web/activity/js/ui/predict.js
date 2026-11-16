import { h, avatar, countdown } from './dom.js';
import { PARTY_SHARDS_PREDICTION } from '../admin.js';

export const PREDICT_TITLE = 'Who wins this round?';

function face(p) {
  return { id: p.id, slot: p.slot, name: p.name, username: p.username || null, initials: p.initials, hue: p.hue, avatar: p.avatar || null, isMe: p.isMe };
}

export function predictModel(snap) {
  const pr = snap && snap.ready ? snap.predict : null;
  if (!pr || snap.room.phase !== 'game' || !pr.open || !pr.canPick) return null;
  const players = snap.players.filter((p) => p.joined && Number.isInteger(p.slot)).map(face);
  if (players.length < 2) return null;
  return { from: pr.from, until: pr.until, mine: Number.isInteger(pr.mine) ? pr.mine : null, players };
}

export function predictBox(m, onPick) {
  if (!m) return null;
  return h(
    'div',
    { class: 'predict', attrs: { role: 'group', 'aria-label': PREDICT_TITLE } },
    h('div', { class: 'predict-head' }, h('strong', { class: 'predict-title', text: PREDICT_TITLE }), h('span', { class: 'predict-hint muted', text: `Free pick. Get it right for +${PARTY_SHARDS_PREDICTION} 💎.` })),
    countdown(m.from, m.until, { lead: 'Picks close in', label: 'Time left to pick' }),
    h(
      'div',
      { class: 'predict-picks' },
      m.players.map((p) =>
        h(
          'button',
          {
            class: ['predict-pick', 'spot', m.mine === p.slot ? 'is-on' : null],
            type: 'button',
            dataset: { key: `predict-${p.slot}` },
            attrs: { 'aria-pressed': m.mine === p.slot ? 'true' : 'false' },
            on: { click: () => onPick(p.slot) },
          },
          avatar(p, 'xs'),
          h('span', { class: 'predict-name', text: p.name }),
        ),
      ),
    ),
  );
}

export function predictWaitModel(snap) {
  const pr = snap && snap.ready ? snap.predict : null;
  if (!pr || snap.room.phase !== 'game' || pr.open || snap.meJoined || !Number.isInteger(pr.mine)) return null;
  const p = snap.players.find((x) => x.slot === pr.mine);
  return { name: p ? p.name : 'Player' };
}

export function predictWait(m) {
  if (!m) return null;
  return h('p', { class: 'predict-locked muted', attrs: { role: 'status' } }, h('span', { text: 'Your pick: ' }), h('strong', { text: m.name }));
}

export function predictResultsModel(snap) {
  const pr = snap && snap.ready ? snap.predict : null;
  const last = snap && snap.room ? snap.room.last : null;
  if (!pr || !pr.closed || !last || !pr.picks.length) return null;
  const wins = Array.isArray(pr.winners) ? pr.winners : Array.isArray(last.winners) ? last.winners : [];
  const bySlot = new Map(snap.players.filter((p) => Number.isInteger(p.slot)).map((p) => [p.slot, p]));
  const byId = new Map(snap.players.map((p) => [p.id, p]));
  const rows = pr.picks.map((x) => {
    const who = byId.get(x.id);
    const pick = bySlot.get(x.slot);
    return { id: x.id, name: who ? who.name : 'Watcher', isMe: Boolean(who && who.isMe), pick: pick ? pick.name : 'Player', right: wins.includes(x.slot) };
  });
  rows.sort((a, b) => Number(b.right) - Number(a.right) || a.name.localeCompare(b.name));
  return { rows, right: rows.filter((r) => r.right).length, counted: Array.isArray(last.ps) && last.ps.length >= 2 };
}

export function predictResults(m) {
  if (!m) return null;
  return h(
    'div',
    { class: 'card glass predict-card' },
    h('div', { class: 'card-head' }, h('h3', { class: 'card-title', text: 'Watcher picks' }), h('span', { class: 'count-pill', text: `${m.right} of ${m.rows.length} right` })),
    h(
      'ul',
      { class: 'predict-list' },
      m.rows.map((r) =>
        h(
          'li',
          { class: ['predict-row', r.right ? 'is-right' : 'is-wrong', r.isMe ? 'is-me' : null] },
          h('span', { class: 'predict-mark', text: r.right ? '✓' : '✗', attrs: { 'aria-hidden': 'true' } }),
          h('span', { class: 'predict-who', text: r.isMe ? `${r.name} (you)` : r.name }),
          h('span', { class: 'predict-arrow muted', text: 'picked' }),
          h('strong', { class: 'predict-on', text: r.pick }),
          r.right && m.counted ? h('span', { class: 'shard-chip is-small', text: `+${PARTY_SHARDS_PREDICTION} 💎` }) : null,
        ),
      ),
    ),
  );
}
