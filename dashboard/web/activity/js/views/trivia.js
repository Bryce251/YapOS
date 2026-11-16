import trivia, { REVEAL_MS, BOLT_SHOW_MS } from '../games/trivia.js';
import { TEAM_MS } from '../games/teams.js';
import { h, memo, timer, avatar, plural } from '../ui/dom.js';
import { teamBar, teamFinal, packChip } from './teams.js';

const LETTERS = ['A', 'B', 'C', 'D'];

function num(n) {
  return Math.abs(Number(n) || 0).toLocaleString('en-US');
}

export function footerText(m) {
  if (m.phase === 'wager') {
    const count = `${m.answered} of ${plural(m.players, 'player', 'players')} placed a bet`;
    if (m.waiting || m.watching) return `You're watching this bet. ${count}`;
    if (m.iBet) return m.myBet ? `Bet locked in! ${count}` : `Playing it safe. ${count}`;
    return `Pick your bet. ${count}`;
  }
  if (m.phase === 'bolt') {
    const count = `${m.done} of ${plural(m.players, 'player', 'players')} finished`;
    if (m.waiting) return `You joined late, so you're watching the lightning round. ${count}`;
    if (m.watching) return `You're watching the lightning round. ${count}`;
    return m.iDone ? `All done! Waiting for the others. ${count}` : `Answer fast, there's no going back. ${count}`;
  }
  if (m.phase === 'boltshow') {
    if (m.skipped) return 'The host changed, so the lightning round does not count.';
    if (m.waiting || m.watching) return 'Here is how the lightning round went!';
    if (!m.myRight) return 'Lightning is hard. Shake it off!';
    return `${m.myRight} of ${m.count} right! +${num(m.myGain)}`;
  }
  if (m.phase === 'question') {
    const count = `${m.answered} of ${plural(m.players, 'player', 'players')} answered`;
    if (m.waiting) return `You joined near the end of this one, so you're in from the next question. ${count}`;
    if (m.watching) return `You're watching this one. ${count}`;
    return m.iAnswered ? `Locked in! ${count}` : `Pick an answer. ${count}`;
  }
  if (m.skipped) return 'The host changed, so this one does not count.';
  if (m.gotIt) return `Nice one! +${num(m.myGain)}`;
  if (m.myGain < 0) return `Not this time. -${num(m.myGain)}`;
  if (m.myPick !== null) return 'Not this time.';
  if (m.waiting) return "You're in from the next question.";
  if (m.watching) return "Time's up! Here's the answer.";
  return "Time's up!";
}

export function betLabel(b) {
  if (b.p === 0) return 'Play it safe';
  if (b.p === 100) return `All in · ${num(b.amount)}`;
  return `${b.p}% · ${num(b.amount)}`;
}

export function stealText(s) {
  if (!s) return '';
  const by = s.by.isMe ? 'You' : s.by.name;
  const from = s.from.isMe ? 'you' : s.from.name;
  return s.n > 0 ? `😈 ${by} stole ${num(s.n)} points from ${from}!` : `😈 ${by} swooped in for the steal after ${from} slipped up!`;
}

function faces(list) {
  if (!list || !list.length) return null;
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
        { class: ['got-item', p.isMe ? 'is-me' : null, p.team ? `team-${p.team}` : null], attrs: { title: p.username ? `${p.name} (@${p.username})` : p.name } },
        avatar(p, 'xs'),
        h('span', { class: 'got-name', text: p.isMe ? 'You' : p.name }),
        h('span', { class: 'got-tick', text: `+${num(p.pts)}` }),
      ),
    ),
    list.length > 8 ? h('li', { class: 'tag', text: `+${list.length - 8} more` }) : null,
  );
}

const QUIET = { play() {}, burst() {}, float() {} };

export function triviaMoment(was, m) {
  const now = { qid: m.qid || m.key, phase: m.phase };
  if (!was || (was.qid === now.qid && was.phase === m.phase)) return { now, cue: null };
  if (m.phase === 'boltshow') return { now, cue: m.skipped || m.watching || m.waiting ? null : m.myRight ? 'correct' : 'wrong' };
  if (m.phase === 'wager' || m.phase === 'bolt') return { now, cue: 'whoosh' };
  if (m.phase !== 'reveal') return { now, cue: null };
  if (m.skipped || m.myPick === null) return { now, cue: null };
  return { now, cue: m.gotIt ? 'correct' : 'wrong' };
}

function headChips(m) {
  return [
    h('span', { class: 'chip chip-static', text: `${m.emoji} ${m.category}` }),
    m.packMiss && m.number === 1 ? packChip(null, m.packMiss, 'questions') : null,
    m.tier
      ? h('span', {
          class: ['chip', 'chip-static', 'tier-chip', `tier-${m.tier}`],
          text: `${m.tierName}${m.tierBonus ? ` · ${m.tierBonus} points` : ''}`,
          attrs: { title: m.tierBonus ? `${m.tierName} questions are worth ${m.tierBonus} points` : `${m.tierName} question` },
        })
      : null,
  ];
}

export function createTriviaView({ engine, fx, cues }) {
  const cue = cues && typeof cues.play === 'function' ? cues : QUIET;
  const el = h('section', { class: 'game game-trivia', attrs: { 'aria-label': 'Trivia' } });
  const local = { qid: null, pick: null, wager: null, bet: null, bolt: null, picks: [] };
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

  function bet(m, p) {
    if (!m.canBet) return;
    local.wager = m.starts;
    local.bet = p;
    cue.play(p === 100 ? 'turn' : 'send');
    engine.act({ type: 'bet', p });
    if (snap) update(snap);
  }

  function bolt(m, i) {
    if (!m.canAnswer || !m.current) return;
    if (local.bolt !== m.bolt) {
      local.bolt = m.bolt;
      local.picks = [];
    }
    if (local.picks.length !== m.current.k) return;
    local.picks = local.picks.concat([i]);
    cue.play('tap');
    engine.act({ type: 'bolt', k: m.current.k, i });
    if (snap) update(snap);
  }

  function foot(m, good, extra) {
    return h('div', { class: ['game-foot', good ? 'is-good' : null], attrs: { role: 'status', 'aria-live': 'polite' } }, h('span', { class: 'foot-text', text: footerText(m) }), extra);
  }

  function renderWager(m) {
    return [
      h('div', { class: 'game-head' }, h('span', { class: 'chip chip-static qz-wager-chip', text: '💰 Wager round' }), ...headChips(m), h('span', { class: 'game-count', text: `Question ${m.number} of ${m.total}` }), timer(m.starts, m.ends, 'Bets close in')),
      teamBar(m.teams),
      h('h2', { class: 'question qz-wager-title', text: 'How much do you dare to bet?' }),
      h('p', { class: 'qz-wager-sub', text: `Next up: ${m.emoji} ${m.category}. Get it right and you win your bet. Get it wrong and you lose it.` }),
      h(
        'div',
        { class: 'qz-bets', attrs: { role: 'group', 'aria-label': 'Your bet' } },
        m.bets.map((b) =>
          h('button', {
            class: ['qz-bet', 'spot', b.p === 100 ? 'is-all' : null, b.mine ? 'is-mine' : null],
            type: 'button',
            disabled: !m.canBet,
            dataset: { key: `bet-${b.p}` },
            attrs: { 'aria-pressed': b.mine ? 'true' : 'false' },
            text: betLabel(b),
            on: { click: () => bet(m, b.p) },
          }),
        ),
      ),
      foot(m, false, faces(m.betBy)),
    ];
  }

  function renderBolt(m) {
    const show = m.phase === 'boltshow';
    return [
      h(
        'div',
        { class: 'game-head' },
        h('span', { class: 'chip chip-static qz-bolt-chip', text: '⚡ Lightning round' }),
        h('span', { class: 'game-count', text: show ? `${m.count} questions` : `Question ${Math.min(m.at + 1, m.count)} of ${m.count}` }),
        timer(show ? m.ends - BOLT_SHOW_MS : m.starts, m.ends, show ? 'Final scores in' : 'Time left'),
      ),
      teamBar(m.teams),
      show ? null : h('div', { class: 'qz-bolt-dots', attrs: { 'aria-hidden': 'true' } }, Array.from({ length: m.count }, (_, i) => h('span', { class: ['qz-dot', i < m.at ? 'is-done' : null, i === m.at ? 'is-now' : null] }))),
      m.current
        ? [
            h('h2', { class: 'question qz-bolt-q', text: m.current.text }),
            h(
              'div',
              { class: 'options qz-bolt-options' },
              m.current.options.map((o) =>
                h(
                  'button',
                  { class: ['option', `option-${o.i}`, 'spot'], type: 'button', disabled: !m.canAnswer, dataset: { key: `bolt-${m.current.k}-${o.i}` }, on: { click: () => bolt(m, o.i) } },
                  h('span', { class: 'option-letter', text: LETTERS[o.i], attrs: { 'aria-hidden': 'true' } }),
                  h('span', { class: 'option-text', text: o.text }),
                ),
              ),
            ),
          ]
        : null,
      !show && !m.current ? h('h2', { class: 'question qz-bolt-q', text: m.iDone ? 'All five done! ⚡' : '⚡ Five questions, thirty seconds. Go!' }) : null,
      show
        ? h(
            'ol',
            { class: 'qz-review', attrs: { 'aria-label': 'Lightning answers' } },
            m.review.map((r) =>
              h(
                'li',
                { class: ['qz-review-row', r.mine === null ? null : r.right ? 'is-right' : 'is-wrong'] },
                h('span', { class: 'qz-review-q', text: r.text }),
                h('span', { class: 'qz-review-a', text: `✓ ${r.answer}` }),
                r.mine !== null && !r.right ? h('span', { class: 'qz-review-mine', text: `You said ${r.mine}` }) : null,
              ),
            ),
          )
        : null,
      show && m.board.length
        ? h(
            'ul',
            { class: 'got-list qz-bolt-board' },
            m.board.slice(0, 8).map((p) => h('li', { class: ['got-item', p.isMe ? 'is-me' : null] }, avatar(p, 'xs'), h('span', { class: 'got-name', text: p.isMe ? 'You' : p.name }), h('span', { class: 'got-tick', text: `${p.right}/${m.count} · +${num(p.pts)}` }))),
          )
        : null,
      foot(m, show && m.myRight > 0, show ? null : faces(m.doneBy)),
    ];
  }

  function render(m) {
    if (!m) return h('p', { class: 'waiting', text: 'Getting the first round ready…' });
    if (m.phase === 'final') {
      return [
        h('div', { class: 'game-head' }, h('span', { class: 'chip chip-static', text: '🏁 Final scores' }), timer(m.ends - TEAM_MS, m.ends, 'Results in')),
        teamFinal(m.teams),
      ];
    }
    if (m.phase === 'wager') return renderWager(m);
    if (m.phase === 'bolt' || m.phase === 'boltshow') return renderBolt(m);
    const reveal = m.phase === 'reveal';
    const bigBets = m.wagers.filter((w) => !w.who.isMe).slice(0, 3);
    return [
      h(
        'div',
        { class: 'game-head' },
        m.wagerRound ? h('span', { class: 'chip chip-static qz-wager-chip', text: '💰 Wager round' }) : null,
        ...headChips(m),
        h('span', { class: 'game-count', text: `Question ${m.number} of ${m.total}` }),
        timer(reveal ? m.ends - REVEAL_MS : m.starts, m.ends, reveal ? (m.number >= m.total && m.lightning ? 'Lightning round in' : 'Next question in') : 'Time left to answer'),
      ),
      teamBar(m.teams),
      m.wagerRound && (m.myWager || bigBets.length)
        ? h(
            'p',
            { class: 'qz-wager-line' },
            m.myWager ? h('span', { class: 'qz-wager-mine', text: `💰 You bet ${num(m.myWager)}` }) : null,
            bigBets.map((w) => h('span', { class: 'qz-wager-other' }, avatar(w.who, 'xs'), h('span', { text: `${w.who.name} bet ${num(w.amt)}` }))),
          )
        : null,
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
      reveal && m.steal ? h('p', { class: 'qz-steal', attrs: { role: 'status' } }, avatar(m.steal.by, 'xs'), h('span', { text: stealText(m.steal) })) : null,
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
    if (!moment) return;
    cue.play(moment);
    if (m.phase === 'boltshow') {
      if (m.myRight >= m.count && m.count >= 3 && cheered !== m.key) {
        cheered = m.key;
        fx.confetti(60);
      }
      return;
    }
    if (m.phase !== 'reveal') return;
    const mineBtn = moment === 'correct' ? el.querySelector(`.option-${m.myPick}`) : null;
    if (mineBtn) {
      cue.burst(mineBtn, { count: 16, emoji: m.steal && m.steal.by.isMe ? ['😈', '💰'] : ['🎉'] });
      if (m.myGain) cue.float(mineBtn, `+${num(m.myGain)}`);
    }
    if (m.gotIt && cheered !== m.qid) {
      cheered = m.qid;
      fx.confetti(50);
    }
  }

  return { el, update, destroy() {} };
}
