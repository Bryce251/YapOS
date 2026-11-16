import { koOutText } from '../games/knockout.js';
import { h, avatar } from '../ui/dom.js';

export function koBar(ko) {
  if (!ko) return null;
  const out = koOutText(ko);
  return h(
    'div',
    { class: ['ko-bar', ko.duel ? 'is-duel' : null], attrs: { 'aria-label': 'Still standing' } },
    h(
      'span',
      { class: 'ko-alive' },
      ko.alive.slice(0, 10).map((p) => h('span', { class: ['ko-face', p.isMe ? 'is-me' : null], attrs: { title: p.isMe ? 'You' : p.name } }, avatar(p, 'xs'))),
      ko.alive.length > 10 ? h('span', { class: 'faces-more', text: `+${ko.alive.length - 10}` }) : null,
    ),
    out ? h('span', { class: 'ko-out', attrs: { role: 'status' }, text: out }) : null,
  );
}
