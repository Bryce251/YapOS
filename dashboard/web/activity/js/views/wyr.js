import wyr, { REVEAL_MS } from '../games/wyr.js';
import { h, memo, timer, avatar, plural } from '../ui/dom.js';

export function verdict(m) {
  if (m.phase === 'vote') {
    const count = `${m.voted} of ${plural(m.players, 'player', 'players')} voted`;
    return m.myVote ? `Vote in! ${count}` : count;
  }
  if (!m.split.a && !m.split.b) return 'Nobody voted on this one.';
  if (m.side === 'tie') return `A perfect split! +${m.myGain} for everyone who voted.`;
  if (m.side === null) return 'Everyone agreed, so no rebels scored.';
  const label = m.mode === 'minority' ? 'The rebels' : 'The crowd';
  const tail = m.myGain ? ` +${m.myGain} for you.` : '';
  return `${label} picked ${m.side.toUpperCase()}.${tail}`;
}

function faces(list) {
  if (!list.length) return null;
  return h(
    'span',
    { class: 'faces' },
    list.slice(0, 7).map((p) => avatar(p, 'xs')),
    list.length > 7 ? h('span', { class: 'faces-more', text: `+${list.length - 7}` }) : null,
  );
}

export function createWyrView({ engine, fx }) {
  const el = h('section', { class: 'game game-wyr', attrs: { 'aria-label': 'Would You Rather' } });
  const local = { pid: null, side: null };
  let snap = null;
  let cheered = null;
  const paint = memo(render);

  function vote(m, side) {
    if (m.phase !== 'vote' || m.myVote) return;
    local.pid = m.pid;
    local.side = side;
    engine.act({ type: 'vote', side, p: m.pid });
    if (snap) update(snap);
  }

  function choice(m, side) {
    const reveal = m.phase === 'reveal';
    const pct = side === 'a' ? m.pctA : m.pctB;
    const winner = reveal && (m.side === side || m.side === 'tie');
    return h(
      'button',
      {
        class: ['choice', `choice-${side}`, 'spot', m.myVote === side ? 'is-mine' : null, winner ? 'is-win' : null, reveal && !winner ? 'is-dim' : null],
        type: 'button',
        disabled: reveal || Boolean(m.myVote),
        dataset: { key: `side-${side}` },
        attrs: { 'aria-pressed': m.myVote === side ? 'true' : 'false' },
        on: { click: () => vote(m, side) },
      },
      h('span', { class: 'choice-letter', text: side.toUpperCase(), attrs: { 'aria-hidden': 'true' } }),
      h('span', { class: 'choice-text', text: m[side] }),
      reveal ? h('span', { class: 'choice-pct', text: `${pct}%` }) : null,
      reveal ? faces(m.voters[side]) : null,
    );
  }

  function render(m) {
    if (!m) return h('p', { class: 'waiting', text: 'Getting the first round ready…' });
    const reveal = m.phase === 'reveal';
    return [
      h(
        'div',
        { class: 'game-head' },
        h('span', { class: 'chip chip-static', text: m.mode === 'minority' ? '🦄 Rebels score' : '👥 Crowd scores' }),
        h('span', { class: 'game-count', text: `Prompt ${m.number} of ${m.total}` }),
        timer(reveal ? m.ends - REVEAL_MS : m.starts, m.ends, reveal ? 'Next prompt in' : 'Time left to vote'),
      ),
      h('h2', { class: 'question wyr-title', text: 'Would you rather…' }),
      m.note === 'host' && !reveal ? h('p', { class: 'notice', text: 'The host changed, so this one starts again. Vote again!' }) : null,
      h('div', { class: 'choices' }, choice(m, 'a'), h('span', { class: 'or', text: 'or', attrs: { 'aria-hidden': 'true' } }), choice(m, 'b')),
      reveal
        ? h(
            'div',
            { class: 'split', attrs: { role: 'img', 'aria-label': `${m.pctA}% picked A, ${m.pctB}% picked B` } },
            h('span', { class: 'split-a', vars: { '--pct': m.pctA } }),
            h('span', { class: 'split-b', vars: { '--pct': m.pctB } }),
          )
        : null,
      h('div', { class: ['game-foot', reveal && m.myGain ? 'is-good' : null], attrs: { role: 'status', 'aria-live': 'polite' } }, h('span', { class: 'foot-text', text: verdict(m) })),
    ];
  }

  function update(next) {
    snap = next;
    const m = wyr.model(next, local);
    if (!m) {
      paint(el, null);
      return;
    }
    paint(el, m);
    if (m.phase === 'reveal' && m.myGain >= 100 && cheered !== m.pid) {
      cheered = m.pid;
      fx.confetti(40);
    }
  }

  return { el, update, destroy() {} };
}
