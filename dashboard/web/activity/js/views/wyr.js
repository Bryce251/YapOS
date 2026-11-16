import wyr, { REVEAL_MS } from '../games/wyr.js';
import { h, memo, timer, plural, profileButton } from '../ui/dom.js';

export function twinText(t) {
  if (!t) return '';
  return `You and ${t.name} picked the same side ${t.same} of ${t.both} times.`;
}

export function pairText(p) {
  if (!p || p.people.length < 2) return '';
  return `💞 ${p.people[0].isMe ? 'You' : p.people[0].name} and ${p.people[1].isMe ? 'you' : p.people[1].name} agreed on ${p.same} of ${p.both}. Soulmates!`;
}

export function verdict(m) {
  if (m.phase === 'recap') return m.watching ? 'Here is how everyone voted.' : 'Here is who picked what. Results are next!';
  if (m.phase === 'vote') {
    const count = `${m.voted} of ${plural(m.players, 'player', 'players')} voted`;
    if (m.waiting) return `You joined near the end of this one, so you're in from the next prompt. ${count}`;
    if (m.watching) return `You're watching this one. ${count}`;
    return m.myVote ? `Vote in! ${count}` : count;
  }
  if (!m.split.a && !m.split.b) return 'Nobody voted on this one.';
  if (m.side === 'tie') return `A perfect split! +${m.myGain} for everyone who voted.`;
  if (m.side === null) return 'Everyone agreed, so no rebels scored.';
  const label = m.mode === 'minority' ? 'The rebels' : 'The crowd';
  const tail = m.myGain ? ` +${m.myGain} for you.` : '';
  return `${label} picked ${m.side.toUpperCase()}.${tail}`;
}

export function scoreHint(mode) {
  return mode === 'minority' ? 'Points go to the side fewer people pick.' : 'Points go to the side most people pick.';
}

function faces(list, size = 'xs', max = 7) {
  if (!list || !list.length) return null;
  return h(
    'span',
    { class: ['faces', `faces-${size}`], attrs: { title: list.map((p) => (p.isMe ? 'You' : p.username ? `${p.name} (@${p.username})` : p.name)).join(', ') } },
    list.slice(0, max).map((p) => profileButton(p, size)),
    list.length > max ? h('span', { class: 'faces-more', text: `+${list.length - max}` }) : null,
  );
}

const QUIET = { play() {}, burst() {}, float() {} };

export function wyrMoment(was, m) {
  const now = { pid: m.pid, phase: m.phase };
  if (m.phase === 'recap') return { now, cues: was && was.phase !== 'recap' ? ['whoosh'] : [] };
  if (!was || m.phase !== 'reveal' || (was.pid === m.pid && was.phase === 'reveal')) return { now, cues: [] };
  const sided = Boolean(m.myVote) && (m.side === m.myVote || m.side === 'tie');
  return { now, cues: sided ? ['reveal', 'correct'] : ['reveal'] };
}

export function createWyrView({ engine, fx, cues }) {
  const cue = cues && typeof cues.play === 'function' ? cues : QUIET;
  const el = h('section', { class: 'game game-wyr', attrs: { 'aria-label': 'Would You Rather' } });
  const local = { pid: null, side: null };
  let snap = null;
  let cheered = null;
  let heard = null;
  const paint = memo(render);

  function vote(m, side) {
    if (!m.canVote || m.myVote) return;
    local.pid = m.pid;
    local.side = side;
    cue.play('send');
    engine.act({ type: 'vote', side, p: m.pid });
    if (snap) update(snap);
  }

  function choice(m, side) {
    const reveal = m.phase === 'reveal';
    const pct = side === 'a' ? m.pctA : m.pctB;
    const winner = reveal && (m.side === side || m.side === 'tie');
    const mine = m.myVote === side;
    const btn = h(
      'button',
      {
        class: ['choice', `choice-${side}`, 'spot', m.myVote === side ? 'is-mine' : null, winner ? 'is-win' : null, reveal && !winner ? 'is-dim' : null],
        type: 'button',
        disabled: reveal || Boolean(m.myVote) || !m.canVote,
        dataset: { key: `side-${side}` },
        attrs: { 'aria-pressed': m.myVote === side ? 'true' : 'false' },
        on: { click: () => vote(m, side) },
      },
      reveal ? h('span', { class: 'wyr-fill', vars: { '--pct': pct }, attrs: { 'aria-hidden': 'true' } }) : null,
      h('span', { class: 'wyr-choice-top' }, h('span', { class: 'choice-letter', text: side.toUpperCase(), attrs: { 'aria-hidden': 'true' } }), mine ? h('span', { class: 'wyr-pick-tag', text: 'Your pick' }) : null),
      h('span', { class: 'choice-text', text: m[side] }),
      reveal ? h('span', { class: 'choice-pct', text: `${pct}%` }) : null,
    );
    const list = m.voters[side];
    return h(
      'div',
      { class: ['wyr-side', `wyr-side-${side}`, winner ? 'is-win' : null] },
      btn,
      reveal ? h('div', { class: 'wyr-voters' }, faces(list) || h('span', { class: 'wyr-voters-none', text: 'No votes' }), list.length ? h('span', { class: 'wyr-voters-count', text: plural(list.length, 'vote', 'votes') }) : null) : null,
    );
  }

  function recapSide(r, side) {
    const list = side === 'a' ? r.votersA : r.votersB;
    return h(
      'div',
      { class: ['wyr-recap-side', `wyr-recap-${side}`, r.mine === side ? 'is-mine' : null, r.big === side ? 'is-big' : null] },
      h('span', { class: 'wyr-recap-text', text: r[side] }),
      faces(list) || h('span', { class: 'muted wyr-recap-none', text: 'Nobody' }),
    );
  }

  function recap(m) {
    const twin = twinText(m.twin);
    const pair = m.pair && !(m.twin && m.pair.people.some((p) => p.isMe)) ? pairText(m.pair) : '';
    return [
      h(
        'div',
        { class: 'game-head' },
        h('span', { class: 'chip chip-static', text: 'Recap' }),
        h('span', { class: 'game-count', text: plural(m.rounds.length, 'prompt', 'prompts') }),
        timer(m.starts, m.ends, 'Results in'),
      ),
      h('div', { class: 'wyr-hero' }, h('p', { class: 'wyr-eyebrow', text: 'The recap' }), h('h2', { class: 'question wyr-title', text: 'Who picked what' })),
      twin ? h('p', { class: 'wyr-twin' }, profileButton(m.twin, 'sm'), h('span', { class: 'wyr-twin-text', text: twin })) : null,
      pair ? h('p', { class: 'wyr-twin' }, h('span', { class: 'faces' }, m.pair.people.slice(0, 2).map((p) => profileButton(p, 'sm'))), h('span', { class: 'wyr-twin-text', text: pair })) : null,
      h(
        'ol',
        { class: 'wyr-recap', attrs: { 'aria-label': 'Every prompt and who picked each side' } },
        m.rounds.map((r, i) => h('li', { class: 'wyr-recap-row', vars: { '--wyr-order': i } }, recapSide(r, 'a'), h('span', { class: 'wyr-recap-or', text: 'or', attrs: { 'aria-hidden': 'true' } }), recapSide(r, 'b'))),
      ),
      h('div', { class: 'game-foot', attrs: { role: 'status', 'aria-live': 'polite' } }, h('span', { class: 'foot-text', text: verdict(m) })),
    ];
  }

  function render(m) {
    if (!m) return h('p', { class: 'waiting', text: 'Getting the first round ready…' });
    if (m.phase === 'recap') return recap(m);
    const reveal = m.phase === 'reveal';
    return [
      h(
        'div',
        { class: 'game-head' },
        h('span', { class: 'chip chip-static', text: m.mode === 'minority' ? 'Rebels score' : 'Crowd scores' }),
        h('span', { class: 'game-count', text: `Prompt ${m.number} of ${m.total}` }),
        timer(reveal ? m.ends - REVEAL_MS : m.starts, m.ends, reveal ? 'Next prompt in' : 'Time left to vote'),
      ),
      h('div', { class: 'wyr-hero' }, h('p', { class: 'wyr-eyebrow', text: m.mode === 'minority' ? 'Rebels round' : 'Crowd round' }), h('h2', { class: 'question wyr-title', text: 'Would you rather…' }), h('p', { class: 'wyr-hint', text: scoreHint(m.mode) })),
      m.note === 'host' && !reveal ? h('p', { class: 'notice', text: 'The host changed, so this one starts again. Vote again!' }) : null,
      h('div', { class: ['choices', 'wyr-choices', reveal ? 'is-reveal' : null, m.myVote && !reveal ? 'is-voted' : null] }, choice(m, 'a'), h('span', { class: 'or', text: 'or', attrs: { 'aria-hidden': 'true' } }), choice(m, 'b')),
      reveal
        ? h(
            'div',
            { class: 'split', attrs: { role: 'img', 'aria-label': `${m.pctA}% picked A, ${m.pctB}% picked B` } },
            h('span', { class: 'split-a', vars: { '--pct': m.pctA } }),
            h('span', { class: 'split-b', vars: { '--pct': m.pctB } }),
          )
        : null,
      h(
        'div',
        { class: ['game-foot', reveal && m.myGain ? 'is-good' : null], attrs: { role: 'status', 'aria-live': 'polite' } },
        !reveal && m.myVote ? h('span', { class: 'wyr-locked', text: '✓ Locked in' }) : null,
        h('span', { class: 'foot-text', text: verdict(m) }),
        !reveal ? faces(m.votedBy, 'sm', 8) : null,
      ),
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
    const { now, cues: list } = wyrMoment(heard, m);
    heard = now;
    list.forEach((name, i) => cue.play(name, i ? { at: 320 } : undefined));
    if (list.length > 1) {
      const mineBtn = el.querySelector(`.choice-${m.myVote}`);
      if (mineBtn) {
        cue.burst(mineBtn, { count: 14, emoji: ['👥', '🎉'] });
        if (m.myGain) cue.float(mineBtn, `+${m.myGain}`);
      }
    }
    if (m.phase === 'reveal' && m.myGain >= 100 && cheered !== m.pid) {
      cheered = m.pid;
      fx.confetti(40);
    }
  }

  return { el, update, destroy() {} };
}
