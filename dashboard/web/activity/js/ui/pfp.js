import { h, profileButton } from './dom.js';

export function pfp(p, size = 'md', { crown = false, ring = null } = {}) {
  const el = profileButton(p || {}, size, { ring });
  if (crown) el.append(h('span', { class: 'avatar-crown', text: '👑', attrs: { 'aria-hidden': 'true' } }));
  return el;
}
