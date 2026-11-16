import { h, avatar } from './dom.js';
import { textFlag } from './report.js';

export const AWARDS_TITLE = 'Awards';
export const REEL_TITLE = 'Highlight reel';

function byslot(snap) {
  return new Map((snap && Array.isArray(snap.players) ? snap.players : []).filter((p) => Number.isInteger(p.slot)).map((p) => [p.slot, p]));
}

function face(p) {
  return { id: p.id, name: p.name, initials: p.initials, hue: p.hue, avatar: p.avatar || null, isMe: Boolean(p.isMe) };
}

export function awardsModel(snap) {
  const fun = snap && snap.room && snap.room.phase === 'results' ? snap.fun : null;
  if (!fun) return { awards: [], highlights: [], upset: null, sameTeams: false };
  const players = byslot(snap);
  const awards = (fun.awards || [])
    .map((a) => {
      const who = a.slots.map((s) => players.get(s)).filter(Boolean);
      if (!who.length) return null;
      return { emoji: a.emoji, title: a.title, why: a.why || '', who: who.map(face), mine: who.some((p) => p.isMe) };
    })
    .filter(Boolean);
  const highlights = (fun.highlights || []).map((x) => {
    const p = Number.isInteger(x.slot) ? players.get(x.slot) : null;
    return { r: x.r, text: x.text, name: p ? p.name : null, mine: Boolean(p && p.isMe), report: Boolean(p) };
  });
  return { awards, highlights, upset: fun.upset || null, sameTeams: Boolean(fun.sameTeams) };
}

export function awardsCard(list) {
  if (!Array.isArray(list) || !list.length) return null;
  return h(
    'div',
    { class: 'card glass awards-card' },
    h('div', { class: 'card-head' }, h('h3', { class: 'card-title', text: AWARDS_TITLE })),
    h(
      'ul',
      { class: 'award-list' },
      list.map((a, i) =>
        h(
          'li',
          { class: ['award', a.mine ? 'is-me' : null], vars: { '--i': String(i) } },
          h('span', { class: 'award-emoji', text: a.emoji, attrs: { 'aria-hidden': 'true' } }),
          h(
            'span',
            { class: 'award-text' },
            h('span', { class: 'award-title', text: a.title }),
            h('span', { class: 'award-who' }, a.who.map((p) => h('span', { class: 'award-person' }, avatar(p, 'xs'), h('span', { class: 'award-name', text: p.isMe ? `${p.name} (you)` : p.name })))),
            a.why ? h('span', { class: 'award-why', text: a.why }) : null,
          ),
        ),
      ),
    ),
  );
}

export function reelCard(list, { engine = null, toast = null } = {}) {
  if (!Array.isArray(list) || !list.length) return null;
  return h(
    'div',
    { class: 'card glass reel-card' },
    h('div', { class: 'card-head' }, h('h3', { class: 'card-title', text: REEL_TITLE })),
    h(
      'ol',
      { class: 'reel-list' },
      list.map((x) =>
        h(
          'li',
          { class: ['reel-item', x.mine ? 'is-me' : null] },
          h('span', { class: 'reel-quote', text: `“${x.text}”` }),
          x.name ? h('span', { class: 'reel-who', text: `— ${x.name}` }) : null,
          x.report && !x.mine && engine ? textFlag(engine, x.r, { toast }) : null,
        ),
      ),
    ),
  );
}

export function upsetLine(text) {
  return text ? h('p', { class: 'upset-line', text }) : null;
}
