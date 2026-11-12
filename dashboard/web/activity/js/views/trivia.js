import trivia, { REVEAL_MS } from '../games/trivia.js';
import { h, memo, timer, plural } from '../ui/dom.js';

const LETTERS = ['A', 'B', 'C', 'D'];

export function footerText(m) {
  if (m.phase === 'question') {
    const count = `${m.answered} of ${plural(m.players, 'player', 'players')} answered`;
    return m.iAnswered ? `Locked in! ${count}` : `Pick an answer. ${count}`;
  }
  if (m.skipped) return 'The host changed, so this one does not count.';
  if (m.gotIt) return `Nice one! +${m.myGain.toLocaleString('en-US')}`;
  if (m.myPick !== null) return 'Not this time.';
  return "Time's up!";
}

export function createTriviaView({ engine, fx }) {
  const el = h('section', { class: 'game game-trivia', attrs: { 'aria-label': 'Trivia' } });
  const local = { qid: null, pick: null };
  let snap = null;
  let cheered = null;
  const paint = memo(render);

  function choose(m, i) {
    if (m.phase !== 'question' || m.iAnswered) return;
    local.qid = m.qid;
    local.pick = i;
    engine.act({ type: 'answer', i, q: m.qid });
    if (snap) update(snap);
  }

  function render(m) {
    if (!m) return h('p', { class: 'waiting', text: 'Getting the first round ready…' });
    const reveal = m.phase === 'reveal';
    return [
      h(
        'div',
        { class: 'game-head' },
        h('span', { class: 'chip chip-static', text: `${m.emoji} ${m.category}` }),
        h('span', { class: 'game-count', text: `Question ${m.number} of ${m.total}` }),
        timer(reveal ? m.ends - REVEAL_MS : m.starts, m.ends, reveal ? 'Next question in' : 'Time left to answer'),
      ),
      h('h2', { class: 'question', text: m.text }),
      h(
        'div',
        { class: ['options', reveal ? 'is-reveal' : null] },
        m.options.map((o) =>
          h(
            'button',
            {
              class: ['option', `option-${o.i}`, 'spot', o.mine ? 'is-mine' : null, o.correct === true ? 'is-right' : null, reveal && o.correct === false ? (o.mine ? 'is-wrong' : 'is-dim') : null],
              type: 'button',
              disabled: reveal || m.iAnswered,
              dataset: { key: `opt-${o.i}` },
              attrs: { 'aria-pressed': o.mine ? 'true' : 'false' },
              on: { click: () => choose(m, o.i) },
            },
            h('span', { class: 'option-letter', text: LETTERS[o.i], attrs: { 'aria-hidden': 'true' } }),
            h('span', { class: 'option-text', text: o.text }),
            o.count !== null ? h('span', { class: 'option-count', text: String(o.count), attrs: { 'aria-label': plural(o.count, 'pick', 'picks') } }) : null,
          ),
        ),
      ),
      h(
        'div',
        { class: ['game-foot', reveal && m.gotIt ? 'is-good' : null], attrs: { role: 'status', 'aria-live': 'polite' } },
        h('span', { class: 'foot-text', text: footerText(m) }),
        reveal && m.right.length
          ? h(
              'span',
              { class: 'got-it' },
              h('span', { class: 'got-label', text: 'Got it:' }),
              m.right.slice(0, 8).map((p) => h('span', { class: 'tag', text: `${p.name} +${p.pts}` })),
              m.right.length > 8 ? h('span', { class: 'tag', text: `+${m.right.length - 8} more` }) : null,
            )
          : null,
      ),
    ];
  }

  function update(next) {
    snap = next;
    const m = trivia.model(next, local);
    if (!m) {
      paint(el, null);
      return;
    }
    paint(el, m);
    if (m.phase === 'reveal' && m.gotIt && cheered !== m.qid) {
      cheered = m.qid;
      fx.confetti(50);
    }
  }

  return { el, update, destroy() {} };
}
