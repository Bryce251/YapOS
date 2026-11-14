import trivia, { REVEAL_MS } from '../games/trivia.js';
import { h, memo, timer, avatar, plural } from '../ui/dom.js';

const LETTERS = ['A', 'B', 'C', 'D'];

export function footerText(m) {
  if (m.phase === 'question') {
    const count = `${m.answered} of ${plural(m.players, 'player', 'players')} answered`;
    if (m.waiting) return `You joined near the end of this one, so you're in from the next question. ${count}`;
    if (m.watching) return `You're watching this one. ${count}`;
    return m.iAnswered ? `Locked in! ${count}` : `Pick an answer. ${count}`;
  }
  if (m.skipped) return 'The host changed, so this one does not count.';
  if (m.gotIt) return `Nice one! +${m.myGain.toLocaleString('en-US')}`;
  if (m.myPick !== null) return 'Not this time.';
  if (m.waiting) return "You're in from the next question.";
  if (m.watching) return "Time's up! Here's the answer.";
  return "Time's up!";
}

function faces(list) {
  if (!list.length) return null;
  return h(
    'span',
    { class: 'faces', attrs: { title: list.map((p) => (p.isMe ? 'You' : p.username ? `${p.name} (@${p.username})` : p.name)).join(', ') } },
    list.slice(0, 7).map((p) => avatar(p, 'xs')),
    list.length > 7 ? h('span', { class: 'faces-more', text: `+${list.length - 7}` }) : null,
  );
}

function gotList(list) {
  return h(
    'ul',
    { class: 'got-list' },
    list.slice(0, 8).map((p) =>
      h(
        'li',
        { class: ['got-item', p.isMe ? 'is-me' : null], attrs: { title: p.username ? `${p.name} (@${p.username})` : p.name } },
        avatar(p, 'xs'),
        h('span', { class: 'got-name', text: p.isMe ? 'You' : p.name }),
        h('span', { class: 'got-tick', text: `+${p.pts.toLocaleString('en-US')}` }),
      ),
    ),
    list.length > 8 ? h('li', { class: 'tag', text: `+${list.length - 8} more` }) : null,
  );
}

const QUIET = { play() {}, burst() {}, float() {} };

export function triviaMoment(was, m) {
  const now = { qid: m.qid, phase: m.phase };
  if (!was || m.phase !== 'reveal' || (was.qid === m.qid && was.phase === 'reveal')) return { now, cue: null };
  if (m.skipped || m.myPick === null) return { now, cue: null };
  return { now, cue: m.gotIt ? 'correct' : 'wrong' };
}

export function createTriviaView({ engine, fx, cues }) {
  const cue = cues && typeof cues.play === 'function' ? cues : QUIET;
  const el = h('section', { class: 'game game-trivia', attrs: { 'aria-label': 'Trivia' } });
  const local = { qid: null, pick: null };
  let snap = null;
  let cheered = null;
  let heard = null;
  const paint = memo(render);

  function choose(m, i) {
    if (!m.canAnswer || m.iAnswered) return;
    local.qid = m.qid;
    local.pick = i;
    cue.play('send');
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
        m.tier
          ? h('span', {
              class: ['chip', 'chip-static', 'tier-chip', `tier-${m.tier}`],
              text: `${m.tierEmoji} ${m.tierName}${m.tierBonus ? ` · ${m.tierBonus} points` : ''}`,
              attrs: { title: m.tierBonus ? `${m.tierName} questions are worth ${m.tierBonus} points` : `${m.tierName} question` },
            })
          : null,
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
              disabled: reveal || m.iAnswered || !m.canAnswer,
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
        !reveal ? faces(m.answeredBy) : null,
        reveal && m.right.length ? h('div', { class: 'got-it' }, h('span', { class: 'got-label', text: 'Got it:' }), gotList(m.right)) : null,
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
    const { now, cue: moment } = triviaMoment(heard, m);
    heard = now;
    if (moment) {
      cue.play(moment);
      const mineBtn = moment === 'correct' ? el.querySelector(`.option-${m.myPick}`) : null;
      if (mineBtn) {
        cue.burst(mineBtn, { count: 16, emoji: ['✨', '🎉'] });
        if (m.myGain) cue.float(mineBtn, `+${m.myGain.toLocaleString('en-US')}`);
      }
    }
    if (m.phase === 'reveal' && m.gotIt && cheered !== m.qid) {
      cheered = m.qid;
      fx.confetti(50);
    }
  }

  return { el, update, destroy() {} };
}
