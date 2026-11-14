import hottakes, { KEY, ANSWER_MAX, seal, promptParts } from '../games/hottakes.js';
import { cleanText } from '../text.js';
import { h, memo, timer, avatar, button, plural } from '../ui/dom.js';

const QUIET = { play() {}, burst() {}, float() {} };
export const VOTE_WAIT_MS = 6000;

function nameOf(p) {
  return p.isMe ? 'You' : p.username ? `${p.name} (@${p.username})` : p.name;
}

function faces(list, max = 8) {
  if (!list || !list.length) return null;
  return h(
    'span',
    { class: 'faces', attrs: { title: list.map(nameOf).join(', ') } },
    list.slice(0, max).map((p) => avatar(p, 'xs')),
    list.length > max ? h('span', { class: 'faces-more', text: `+${list.length - max}` }) : null,
  );
}

export function footText(m) {
  if (!m) return '';
  if (m.phase === 'write') {
    const count = `${m.done} of ${plural(m.players, 'player', 'players')} answered`;
    if (m.waiting) return `You joined near the end of this one, so you can vote next. ${count}`;
    if (m.watching) return `You're watching this round. ${count}`;
    if (m.wrote) return `Answer in! ${count}`;
    return count;
  }
  if (m.phase === 'vote') {
    const count = `${m.voted} voted`;
    if (m.watching) return `You're watching. ${count}`;
    if (m.onlyMine) return `Yours is the only answer, so sit back this time. ${count}`;
    if (m.hasVoted) return `Vote in! ${count}`;
    return `Tap your favourite. You can't vote for your own. ${count}`;
  }
  if (m.lost) return 'The host changed mid-vote, so nobody scored this round. On to the next one!';
  if (!m.cards.length) return 'Nobody wrote an answer for this one.';
  if (!m.topIds.length) return 'No votes this round, so no points.';
  if (m.iTopped) return `Yours was the hottest take! +${m.myGain}`;
  if (m.myGain) return `Nice! Your answer earned +${m.myGain}.`;
  return 'Votes are in!';
}

export function hottakesMoment(was, m) {
  const now = { n: m.n, phase: m.phase };
  if (!was || (was.n === m.n && was.phase === m.phase)) return { now, cues: [] };
  if (m.phase === 'write') return { now, cues: ['whoosh'] };
  if (m.phase === 'vote') return { now, cues: ['pop'] };
  return { now, cues: m.iTopped ? ['reveal', 'correct'] : ['reveal'] };
}

function promptLine(m, fill) {
  const { before, after } = promptParts(m.prompt);
  return h(
    'h2',
    { class: 'question hottakes-prompt' },
    before,
    fill ? h('span', { class: 'hottakes-blank is-filled', text: fill }) : h('span', { class: 'hottakes-blank', text: ' ', attrs: { 'aria-label': 'blank' } }),
    after,
  );
}

export function createHottakesView({ engine, fx, cues, toast, win }) {
  const cue = cues && typeof cues.play === 'function' ? cues : QUIET;
  const confetti = fx && typeof fx.confetti === 'function' ? fx.confetti : () => {};
  const tell = typeof toast === 'function' ? toast : () => {};
  const el = h('section', { class: 'game game-hottakes', attrs: { 'aria-label': 'Hot Takes' } });
  const head = h('div', { class: 'hottakes-headwrap' });
  const top = h('div', { class: 'hottakes-top' });
  const input = h('input', {
    class: 'word-input hottakes-input',
    dataset: { key: 'hottakes-input' },
    attrs: { type: 'text', maxlength: ANSWER_MAX * 2, autocomplete: 'off', enterkeyhint: 'send', 'aria-label': 'Your answer', placeholder: 'Write something funny' },
  });
  const sendBtn = button('Send', { variant: 'primary', key: 'hottakes-send', on: () => submit() });
  const left = h('span', { class: 'hottakes-left', attrs: { 'aria-hidden': 'true' } });
  const hint = h('p', { class: 'entry-hint', attrs: { role: 'status', 'aria-live': 'polite' } });
  const entry = h('div', { class: 'hottakes-entry is-hidden' }, h('div', { class: 'entry-row' }, input, sendBtn), h('div', { class: 'hottakes-entry-foot' }, hint, left));
  const stage = h('div', { class: 'hottakes-stage' });
  const foot = h('div', { class: 'game-foot', attrs: { role: 'status', 'aria-live': 'polite' } });
  el.append(head, top, entry, stage, foot);

  const local = { n: null, sent: null, vote: null, lastSent: null };
  const w = win || globalThis;
  let voteTimer = null;
  let model = null;
  let snap = null;
  let heard = null;
  let cheered = null;
  let seenN = null;

  function counter() {
    const used = Array.from(input.value).length;
    const rest = ANSWER_MAX - used;
    left.textContent = String(rest);
    left.classList.toggle('is-low', rest < 10);
  }

  function refuse(text) {
    hint.textContent = text;
    cue.play('error');
    input.classList.remove('is-refused');
    void input.offsetWidth;
    input.classList.add('is-refused');
  }

  input.addEventListener('animationend', () => input.classList.remove('is-refused'));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
  });
  input.addEventListener('input', () => {
    hint.textContent = '';
    input.classList.remove('is-refused');
    counter();
  });

  function submit() {
    const m = model;
    if (!m || m.phase !== 'write' || !m.canWrite || local.n === m.n) return;
    const text = cleanText(input.value, ANSWER_MAX);
    if (!text) {
      refuse('Write something first!');
      return;
    }
    local.n = m.n;
    local.sent = text;
    local.lastSent = text;
    local.vote = null;
    cue.play('send');
    engine.act({ type: 'answer', n: m.n, code: seal(text, m.nonce) });
    input.value = '';
    counter();
    hint.textContent = 'Sent!';
    if (snap) update(snap);
  }

  function vote(m, card) {
    if (!m.canVote || card.isMine) return;
    local.n = m.n;
    local.vote = card.id;
    cue.play('send');
    engine.act({ type: 'vote', n: m.n, id: card.id });
    watchVote(m.n);
    if (snap) update(snap);
  }

  function stopVoteTimer() {
    if (voteTimer !== null && typeof w.clearTimeout === 'function') w.clearTimeout(voteTimer);
    voteTimer = null;
  }

  function watchVote(n) {
    stopVoteTimer();
    if (typeof w.setTimeout !== 'function') return;
    voteTimer = w.setTimeout(() => {
      voteTimer = null;
      const st = snap && snap.state ? snap.state[KEY] : null;
      const mine = snap ? snap.meSlot : null;
      if (!st || st.n !== n || st.phase !== 'vote' || local.n !== n || local.vote === null) return;
      if (Array.isArray(st.voted) && st.voted.includes(mine)) return;
      local.vote = null;
      tell('That vote didn’t go through. Pick another answer!');
      update(snap);
    }, VOTE_WAIT_MS);
  }

  const paintHead = memo((m) => {
    if (!m) return null;
    const label = m.phase === 'write' ? 'Time left to write' : m.phase === 'vote' ? 'Time left to vote' : 'Next round in';
    return h(
      'div',
      { class: 'game-head' },
      h('span', { class: 'chip chip-static', text: m.phase === 'write' ? 'Write' : m.phase === 'vote' ? 'Vote' : 'Results' }),
      h('span', { class: 'game-count', text: `Round ${m.number} of ${m.total}` }),
      timer(m.starts, m.ends, label),
    );
  });

  const paintTop = memo((m) => {
    if (!m) return h('p', { class: 'waiting', text: 'Warming up the first prompt…' });
    const best = m.phase === 'reveal' && m.topIds.length === 1 ? m.cards.find((c) => c.top) : null;
    const notice =
      m.note === 'host' && m.phase === 'write'
        ? h('p', { class: 'notice', text: 'The host changed, so this prompt starts again. Send your answer again!' })
        : m.lost
        ? h('p', { class: 'notice', text: 'The host changed mid-vote, so the authors got lost. Here is what everyone wrote.' })
        : null;
    return [promptLine(m, best ? best.text : null), notice];
  });

  function writeStage(m) {
    if (m.wrote) {
      return h(
        'div',
        { class: 'hottakes-sent' },
        h('span', { class: 'eyebrow', text: 'Your answer' }),
        h('p', { class: 'hottakes-sent-text', text: m.mySent ? `“${m.mySent}”` : 'Sent and hidden until the vote.' }),
        h('p', { class: 'muted', text: m.done >= m.players ? 'Everyone is in!' : `Waiting for ${plural(Math.max(0, m.players - m.done), 'more answer', 'more answers')}…` }),
      );
    }
    if (m.waiting) return h('p', { class: 'muted hottakes-wait', text: "This round is almost over. You'll get to vote in a moment." });
    if (m.watching) return h('p', { class: 'muted hottakes-wait', text: 'Answers are being written. They show up for voting soon.' });
    return null;
  }

  function voteStage(m) {
    return h(
      'ul',
      { class: 'hottakes-cards', attrs: { 'aria-label': 'Answers' } },
      m.cards.map((c, i) =>
        h(
          'li',
          { class: 'hottakes-item' },
          h(
            'button',
            {
              class: ['hottakes-card', 'hottakes-pick', 'spot', `hottakes-tone-${i % 4}`, c.isMine ? 'is-own' : null, m.myVote === c.id ? 'is-picked' : null, m.hasVoted && m.myVote !== c.id ? 'is-dim' : null],
              type: 'button',
              disabled: !m.canVote || c.isMine,
              dataset: { key: `pick-${c.id}` },
              attrs: { 'aria-pressed': m.myVote === c.id ? 'true' : 'false' },
              on: { click: () => vote(m, c) },
            },
            h('span', { class: 'hottakes-text', text: `“${c.text}”` }),
            c.isMine ? h('span', { class: 'hottakes-tag', text: 'Yours' }) : m.myVote === c.id ? h('span', { class: 'hottakes-tag is-vote', text: 'Your vote' }) : null,
          ),
        ),
      ),
    );
  }

  function revealStage(m) {
    if (!m.cards.length) return h('p', { class: 'muted hottakes-wait', text: 'No answers this time. Get ready for the next prompt!' });
    const most = Math.max(1, ...m.cards.map((c) => c.votes));
    return h(
      'ol',
      { class: 'hottakes-cards is-reveal', attrs: { 'aria-label': 'Results' } },
      m.cards.map((c, i) =>
        h(
          'li',
          { class: 'hottakes-item' },
          h(
            'div',
            { class: ['hottakes-card', 'hottakes-result', `hottakes-tone-${i % 4}`, c.top ? 'is-top' : null, c.isMine ? 'is-own' : null], dataset: { key: `res-${c.id}` }, vars: { '--hottakes-order': i } },
            c.top ? h('span', { class: 'hottakes-badge', text: '🔥 Hottest take' }) : null,
            h('span', { class: 'hottakes-text', text: `“${c.text}”` }),
            c.author
              ? h(
                  'div',
                  { class: 'hottakes-by' },
                  avatar(c.author, 'sm'),
                  h('span', { class: 'hottakes-name', text: c.author.isMe ? 'You' : c.author.name }),
                  c.gained ? h('span', { class: 'hottakes-gain', text: `+${c.gained}` }) : null,
                )
              : null,
            m.lost
              ? null
              : h(
                  'div',
                  { class: 'hottakes-votes' },
                  h('span', { class: 'hottakes-meter', attrs: { 'aria-hidden': 'true' } }, h('span', { class: 'hottakes-meter-fill', vars: { '--hottakes-share': c.votes / most } })),
                  h('span', { class: 'hottakes-count', text: plural(c.votes, 'vote', 'votes') }),
                  faces(c.voters, 6),
                ),
          ),
        ),
      ),
    );
  }

  const paintStage = memo((m) => {
    if (!m) return null;
    if (m.phase === 'write') return writeStage(m);
    if (m.phase === 'vote') return voteStage(m);
    return revealStage(m);
  });

  const paintFoot = memo((m) => {
    if (!m) return null;
    const list = m.phase === 'write' ? m.doneBy : m.phase === 'vote' ? m.votedBy : null;
    return [h('span', { class: 'foot-text', text: footText(m) }), faces(list)];
  });

  function cardFor(id) {
    for (const node of stage.querySelectorAll('.hottakes-result')) if (node.dataset && node.dataset.key === `res-${id}`) return node;
    return null;
  }

  function hear(m) {
    const { now, cues: list } = hottakesMoment(heard, m);
    heard = now;
    list.forEach((name, i) => cue.play(name, i ? { at: 320 } : undefined));
    if (m.phase !== 'reveal' || !list.length) return;
    for (const c of m.cards) {
      if (!c.top) continue;
      const card = cardFor(c.id);
      if (card) cue.burst(card, { count: 16, emoji: ['🌶️', '🔥'] });
    }
    if (m.myGain) {
      const mine = m.cards.find((c) => c.isMine);
      const card = mine ? cardFor(mine.id) : null;
      if (card) cue.float(card, `+${m.myGain}`);
    }
    if (m.iTopped && cheered !== m.n) {
      cheered = m.n;
      confetti(50);
    }
  }

  function syncEntry(m) {
    const pending = m && m.phase === 'write' && local.n === m.n && !m.wrote;
    const open = Boolean(m && m.phase === 'write' && m.canWrite && !pending);
    input.disabled = !open;
    sendBtn.disabled = !open;
    entry.classList.toggle('is-hidden', !m || m.phase !== 'write' || (!m.canWrite && !pending));
    entry.classList.toggle('is-open', open);
    if (pending) hint.textContent = 'Sending…';
    if (m && seenN !== m.n) {
      const first = seenN === null;
      seenN = m.n;
      if (m.phase === 'write') {
        if (m.note === 'host' && local.lastSent && m.canWrite) {
          input.value = local.lastSent;
          hint.textContent = 'The host changed, so send your answer again.';
        } else {
          input.value = '';
          hint.textContent = '';
        }
        counter();
        if (open && !first && typeof input.focus === 'function') input.focus();
      }
    }
    if (m && m.phase === 'write' && m.wrote && hint.textContent === 'Sending…') hint.textContent = 'Sent!';
  }

  function update(next) {
    snap = next;
    const m = hottakes.model(next, local);
    model = m;
    paintHead(head, m);
    paintTop(top, m);
    syncEntry(m);
    paintStage(stage, m);
    paintFoot(foot, m);
    if (!m) return;
    if (m.phase === 'vote' && local.n === m.n && local.sent && !m.cards.some((c) => c.isMine) && m.cards.length && heard && heard.phase === 'write') tell('Your answer didn’t make it in time. You can still vote!');
    hear(m);
  }

  counter();
  return {
    el,
    update,
    destroy() {
      stopVoteTimer();
    },
  };
}
