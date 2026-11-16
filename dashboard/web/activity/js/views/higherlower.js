import higherlower, { REVEAL_MS } from '../games/higherlower.js';
import { koLine } from '../games/knockout.js';
import { h, memo, timer, avatar, plural, profileButton } from '../ui/dom.js';
import { koBar } from './knockout.js';

const QUIET = { play() {}, burst() {}, float() {} };

function nameOf(p) {
  return p.isMe ? 'You' : p.username ? `${p.name} (@${p.username})` : p.name;
}

function faces(list, max = 7, open = true) {
  if (!list || !list.length) return null;
  return h(
    'span',
    { class: 'faces', attrs: { title: list.map(nameOf).join(', ') } },
    list.slice(0, max).map((p) => (open ? profileButton(p, 'sm') : avatar(p, 'xs'))),
    list.length > max ? h('span', { class: 'faces-more', text: `+${list.length - max}` }) : null,
  );
}

export function footText(m) {
  if (!m) return '';
  if (m.phase === 'guess') {
    const count = `${m.done} of ${plural(m.players, 'player', 'players')} picked`;
    if (m.ko && m.ko.imOut) return `You're out, so cheer on the others! ${count}`;
    if (m.ko && m.watching) return `You're watching the knockout. You'll be in next game. ${count}`;
    if (m.waiting) return `You joined near the end of this one, so you're in from the next round. ${count}`;
    if (m.watching) return `You're watching this one. ${count}`;
    if (m.myPick) return `Locked in! ${count}`;
    return count;
  }
  if (m.ko && m.ko.champ && m.ko.champ.isMe) return `You won the knockout! +${m.myGain}`;
  if (m.ko && m.ko.out.some((p) => p.isMe)) return m.correct ? 'Right, but too slow this time. You are out!' : 'Knocked out! Thanks for playing, cheer on the rest.';
  if (m.watching || m.waiting) return 'Here are the numbers. Get ready for the next one!';
  if (!m.myPick) return "Time's up! No pick means your streak starts again.";
  if (m.correct) return m.streak >= 2 ? `Right! That's ${m.streak} in a row. +${m.myGain}` : `Right! +${m.myGain}`;
  return 'Not this time. Your streak starts again.';
}

export function higherlowerMoment(was, m) {
  const now = { r: m.r, phase: m.phase };
  if (!was || (was.r === m.r && was.phase === m.phase)) return { now, cues: [] };
  if (m.phase === 'guess') return { now, cues: was.phase === 'reveal' ? ['whoosh'] : [] };
  if (!m.myPick) return { now, cues: ['reveal'] };
  return { now, cues: m.correct ? ['reveal', 'correct'] : ['reveal', 'wrong'] };
}

export function createHigherlowerView({ engine, fx, cues }) {
  const cue = cues && typeof cues.play === 'function' ? cues : QUIET;
  const confetti = fx && typeof fx.confetti === 'function' ? fx.confetti : () => {};
  const el = h('section', { class: 'game game-higherlower', attrs: { 'aria-label': 'Higher or Lower' } });
  const local = { r: null, side: null };
  let snap = null;
  let heard = null;
  let cheered = null;
  const paint = memo(render);

  function pick(m, side) {
    if (!m.canPick) return;
    local.r = m.r;
    local.side = side;
    cue.play('send');
    engine.act({ type: 'pick', side, r: m.r });
    if (snap) update(snap);
  }

  function card(m, side) {
    const it = m[side];
    const reveal = m.phase === 'reveal';
    const win = reveal && m.right === side;
    return h(
      'button',
      {
        class: ['hl-card', `hl-card-${side}`, 'spot', m.myPick === side ? 'is-mine' : null, win ? 'is-win' : null, reveal && !win ? 'is-dim' : null],
        type: 'button',
        disabled: !m.canPick,
        dataset: { key: `hl-${side}` },
        attrs: { 'aria-pressed': m.myPick === side ? 'true' : 'false' },
        on: { click: () => pick(m, side) },
      },
      h('span', { class: 'hl-emoji', text: it.emoji, attrs: { 'aria-hidden': 'true' } }),
      h('span', { class: 'hl-name', text: it.name }),
      reveal ? h('span', { class: 'hl-value', text: it.value || '' }) : h('span', { class: 'hl-value is-hidden', text: '?' }),
      m.myPick === side ? h('span', { class: 'hl-tag', text: reveal ? (win ? 'Your pick ✓' : 'Your pick') : 'Your pick' }) : null,
      reveal ? faces(m.pickers[side], 7, false) : null,
    );
  }

  function render(m) {
    if (!m) return h('p', { class: 'waiting', text: 'Getting the first pair ready…' });
    const reveal = m.phase === 'reveal';
    return [
      h(
        'div',
        { class: 'game-head' },
        h('span', { class: ['chip', 'chip-static', m.streak >= 2 ? 'hl-streak' : null], text: m.streak >= 2 ? `🔥 ${m.streak} in a row` : 'Streak 0' }),
        m.ko ? h('span', { class: ['chip', 'chip-static', 'ko-chip', m.ko.duel ? 'is-duel' : null], text: koLine(m.ko) }) : null,
        h('span', { class: 'game-count', text: m.ko ? `Round ${m.number}` : `Round ${m.number} of ${m.total}` }),
        timer(reveal ? m.ends - REVEAL_MS : m.starts, m.ends, reveal ? (m.ko && m.ko.champ ? 'Results in' : 'Next round in') : 'Time left to pick'),
      ),
      koBar(m.ko),
      h('h2', { class: 'question hl-ask', text: m.ask }),
      m.note === 'host' && !reveal ? h('p', { class: 'notice', text: 'The host changed, so this round starts again. Pick again!' }) : null,
      h('div', { class: 'hl-cards' }, card(m, 'a'), h('span', { class: 'or hl-or', text: 'or', attrs: { 'aria-hidden': 'true' } }), card(m, 'b')),
      m.hot.length
        ? h(
            'div',
            { class: 'hl-hot', attrs: { 'aria-label': 'Hot streaks' } },
            m.hot.map((x) => h('span', { class: 'hl-hot-item' }, profileButton(x.who, 'xs'), h('span', { text: `${x.who.isMe ? 'You' : x.who.name} 🔥${x.n}` }))),
          )
        : null,
      h(
        'div',
        { class: ['game-foot', reveal && m.correct ? 'is-good' : null], attrs: { role: 'status', 'aria-live': 'polite' } },
        h('span', { class: 'foot-text', text: footText(m) }),
        !reveal ? faces(m.doneBy) : null,
      ),
    ];
  }

  function update(next) {
    snap = next;
    const m = higherlower.model(next, local);
    paint(el, m);
    if (!m) return;
    const { now, cues: list } = higherlowerMoment(heard, m);
    heard = now;
    list.forEach((name, i) => cue.play(name, i ? { at: 320 } : undefined));
    if (list.length && m.ko && m.ko.champ && m.ko.champ.isMe && cheered !== `ko${m.r}`) {
      cheered = `ko${m.r}`;
      confetti(80);
    }
    if (list.includes('correct')) {
      const mine = el.querySelector(`.hl-card-${m.myPick}`);
      if (mine) {
        cue.burst(mine, { count: 12, emoji: m.streak >= 3 ? ['🔥', '📈'] : ['📈', '✨'] });
        if (m.myGain) cue.float(mine, `+${m.myGain}`);
      }
      if (m.streak >= 5 && cheered !== m.r) {
        cheered = m.r;
        confetti(40);
      }
    }
  }

  return { el, update, destroy() {} };
}
