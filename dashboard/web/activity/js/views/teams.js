import { h, avatar } from '../ui/dom.js';
import { finalText } from '../games/teams.js';
import { packNoteText } from '../games/packs.js';

export const TEAM_FACES = 6;

function faces(list) {
  if (!list.length) return h('span', { class: 'team-empty', text: 'No one yet' });
  return h(
    'span',
    { class: 'team-faces', attrs: { title: list.map((p) => (p.isMe ? 'You' : p.name)).join(', ') } },
    list.slice(0, TEAM_FACES).map((p) => avatar(p, 'xs')),
    list.length > TEAM_FACES ? h('span', { class: 'faces-more', text: `+${list.length - TEAM_FACES}` }) : null,
  );
}

export function boostText(t) {
  if (!t || !t.boost) return '';
  return `Smaller team, so points count ×${Math.round((t.boost.of / t.boost.size) * 100) / 100}`;
}

function boostNote(t) {
  const text = boostText(t);
  return text ? h('span', { class: 'team-boost', text }) : null;
}

export function teamLabel(t) {
  return `${t.emoji} ${t.name}`;
}

export function teamBar(board) {
  if (!board) return null;
  return h(
    'div',
    { class: 'team-bar', attrs: { role: 'group', 'aria-label': 'Team scores' } },
    board.map((t) =>
      h(
        'div',
        { class: ['team-card', `team-${t.id}`, t.mine ? 'is-mine' : null, t.lead ? 'is-lead' : null], attrs: { 'aria-label': `${t.name} team: ${t.pts.toLocaleString('en-US')} points${t.mine ? ', your team' : ''}` } },
        h('span', { class: 'team-name', text: teamLabel(t) }),
        t.mine ? h('span', { class: 'team-you', text: 'Your team' }) : null,
        h('strong', { class: 'team-pts', text: t.pts.toLocaleString('en-US') }),
        faces(t.members),
        boostNote(t),
      ),
    ),
  );
}

export function teamFinal(board) {
  if (!board) return null;
  return h(
    'div',
    { class: 'team-final', attrs: { role: 'status', 'aria-live': 'polite' } },
    h('h2', { class: 'team-final-title', text: finalText(board) }),
    h(
      'div',
      { class: 'team-final-grid' },
      board.map((t) =>
        h(
          'div',
          { class: ['team-card', 'is-final', `team-${t.id}`, t.mine ? 'is-mine' : null, t.lead ? 'is-lead' : null] },
          h('span', { class: 'team-name', text: teamLabel(t) }),
          h('strong', { class: 'team-pts', text: t.pts.toLocaleString('en-US') }),
          boostNote(t),
          t.members.length
            ? h(
                'ul',
                { class: 'team-list' },
                t.members
                  .slice()
                  .sort((a, b) => b.pts - a.pts)
                  .map((p) => h('li', { class: ['team-member', p.isMe ? 'is-me' : null] }, avatar(p, 'xs'), h('span', { class: 'team-member-name', text: p.isMe ? 'You' : p.name }), h('span', { class: 'team-member-pts', text: p.pts.toLocaleString('en-US') }))),
              )
            : h('span', { class: 'team-empty', text: 'No one yet' }),
        ),
      ),
    ),
  );
}

export function packChip(pack, miss, what) {
  const text = packNoteText(pack ? { c: pack.code, n: pack.name } : null, miss, what);
  if (!text) return null;
  return h('span', { class: ['chip', 'chip-static', 'pack-chip', miss && !pack ? 'is-miss' : null], text, attrs: pack ? { title: `Word pack ${pack.code}` } : {} });
}
