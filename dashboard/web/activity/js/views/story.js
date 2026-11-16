import story, { LINE_MAX, fitLine } from '../games/story.js';
import { h, memo, timer, avatar, profileButton, button, plural } from '../ui/dom.js';
import { textFlag } from '../ui/report.js';
import { hidesWords } from '../text.js';
import { HIDDEN_NOTE } from '../filter.js';

const QUIET = { play() {}, burst() {}, float() {} };

function quietFace(p) {
  const face = avatar(p, 'xs');
  face.removeAttribute('data-profile-id');
  face.removeAttribute('data-profile-name');
  return face;
}

export function footText(m) {
  if (m.phase === 'write') {
    if (m.myTurn) return m.sent ? 'Sent! Passing the pen…' : 'Your turn! Add one sentence to keep the story going.';
    if (!m.writer) return 'Passing the pen…';
    const next = m.upcoming.find((p) => p.isMe);
    if (next) return `${m.writer.name} is writing. You're up soon!`;
    return `${m.writer.name} is writing…`;
  }
  if (m.phase === 'vote') {
    const count = `${m.voted} voted`;
    if (m.onlyMine) return `Every line is yours, so sit back. ${count}`;
    if (m.hasVoted) return `Vote in! ${count}`;
    return `Tap your favourite line. You can't pick your own. ${count}`;
  }
  if (!m.lines.length) return 'Nobody added a line this time.';
  return m.myGain ? `The story is done! +${m.myGain} for your lines.` : 'The story is done!';
}

export function storyMoment(was, m) {
  const now = { run: m.run, phase: m.phase, turn: m.turn, lines: m.lines.length, myTurn: m.myTurn };
  if (!was || was.run !== m.run) return { now, cues: [] };
  const cues = [];
  if (m.phase !== was.phase) cues.push(m.phase === 'reveal' ? 'reveal' : 'whoosh');
  else if (m.myTurn && !was.myTurn) cues.push('turn');
  else if (m.lines.length > was.lines) cues.push('pop');
  return { now, cues };
}

export function createStoryView({ engine, fx, toast, win, cues }) {
  const cue = cues && typeof cues.play === 'function' ? cues : QUIET;
  const say = typeof toast === 'function' ? toast : () => {};
  const w = win || globalThis;
  const el = h('section', { class: 'game game-story', attrs: { 'aria-label': 'Story Builder' } });
  const head = h('div', { class: 'story-headwrap' });
  const book = h('div', { class: 'story-bookwrap' });
  const input = h('input', {
    class: 'word-input',
    dataset: { key: 'story-input' },
    attrs: { type: 'text', maxlength: LINE_MAX, autocomplete: 'off', spellcheck: 'true', enterkeyhint: 'send', 'aria-label': 'Your sentence', placeholder: 'And then…' },
  });
  const left = h('span', { class: 'story-left', text: String(LINE_MAX) });
  const sendBtn = button('Add line', { variant: 'primary', key: 'story-send', on: () => send() });
  const passBtn = button('Pass', { variant: 'ghost', size: 'sm', key: 'story-pass', on: () => pass() });
  const entry = h('div', { class: 'story-entry story-off' }, h('div', { class: 'entry-row' }, input, sendBtn), h('div', { class: 'story-entry-foot' }, passBtn, left));
  const turn = h('div', { class: 'story-turnwrap' });
  const foot = h('div', { class: 'game-foot', attrs: { role: 'status', 'aria-live': 'polite' } });
  el.append(head, book, turn, entry, foot);
  const local = { run: null, turn: null, vote: null };
  let model = null;
  let heard = null;
  let cheered = null;
  let lastTurn = null;

  function paintLeft() {
    const n = LINE_MAX - Array.from(input.value).length;
    left.textContent = String(Math.max(0, n));
    left.classList.toggle('is-low', n <= 15);
  }

  function send() {
    const m = model;
    if (!m || !m.canWrite) return;
    const text = fitLine(input.value);
    if (!text) {
      cue.play('error');
      say('Type a sentence first, or tap Pass.');
      input.classList.add('is-refused');
      if (typeof w.setTimeout === 'function') w.setTimeout(() => input.classList.remove('is-refused'), 420);
      return;
    }
    local.run = m.run;
    local.turn = m.turn;
    cue.play('send');
    engine.act({ type: 'line', t: m.turn, text });
    if (hidesWords(input.value)) say(HIDDEN_NOTE);
    input.value = '';
    paintLeft();
    refresh();
  }

  function pass() {
    const m = model;
    if (!m || !m.canWrite) return;
    local.run = m.run;
    local.turn = m.turn;
    cue.play('toggle');
    engine.act({ type: 'pass', t: m.turn });
    refresh();
  }

  function vote(i) {
    const m = model;
    if (!m || !m.canVote) return;
    local.run = m.run;
    local.vote = i;
    cue.play('send');
    engine.act({ type: 'vote', i });
    refresh();
  }

  input.addEventListener('input', paintLeft);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      send();
    }
  });

  const paintHead = memo((m) =>
    h(
      'div',
      { class: 'game-head' },
      h('span', { class: 'chip chip-static', text: m.phase === 'vote' ? 'Vote' : m.phase === 'reveal' ? 'The story' : `Lap ${m.lap} of ${m.laps}` }),
      m.phase === 'write' ? h('span', { class: 'game-count', text: `Turn ${Math.min(m.turn + 1, m.turns)} of ${m.turns}` }) : null,
      m.ends ? timer(m.starts, m.ends, m.phase === 'vote' ? 'Time left to vote' : m.phase === 'reveal' ? 'Results in' : 'Time left to write') : null,
    ),
  );

  function lineItem(m, l) {
    const voting = m.phase === 'vote';
    const reveal = m.phase === 'reveal';
    const picked = m.myVote === l.i;
    const textEl = h('span', { class: 'story-text', text: l.text });
    const body = voting
      ? h(
          'button',
          {
            class: ['story-line-btn', 'spot', l.mine ? 'is-own' : null, picked ? 'is-picked' : null, m.hasVoted && !picked ? 'is-dim' : null],
            type: 'button',
            dataset: { key: `story-vote-${l.i}` },
            disabled: l.mine || !m.canVote,
            attrs: { 'aria-pressed': picked ? 'true' : 'false', 'aria-label': l.mine ? `Your line: ${l.text}` : `Vote for: ${l.text}` },
            on: { click: () => vote(l.i) },
          },
          textEl,
        )
      : textEl;
    return h(
      'li',
      { class: ['story-line', l.mine ? 'is-mine' : null, reveal && l.top ? 'is-top' : null, l.ref ? 'has-flag' : null], dataset: { line: l.i } },
      h('span', { class: 'story-by', attrs: { title: l.by.isMe ? 'You' : l.by.name } }, profileButton(l.by, 'sm')),
      body,
      reveal && l.votes
        ? h('span', { class: 'story-votes' }, l.top ? h('span', { class: 'story-badge', text: '⭐ Best line' }) : null, h('span', { class: 'story-count', text: plural(l.votes, 'vote', 'votes') }), l.gain ? h('span', { class: 'story-gain', text: `+${l.gain}` }) : null)
        : null,
      l.ref ? textFlag(engine, l.ref, { toast, corner: true }) : null,
    );
  }

  const paintBook = memo((m) =>
    h(
      'div',
      { class: ['story-book', 'card', 'glass', `story-${m.phase}`] },
      m.note === 'host' ? h('p', { class: 'notice', text: 'The host changed, so voting starts again. Vote again!' }) : null,
      m.note === 'frozen' && m.iced ? h('p', { class: 'notice story-iced', text: `❄️ ${m.iced.isMe ? 'You were' : `${m.iced.name} was`} frozen, so that turn got skipped.` }) : null,
      h('p', { class: 'story-starter', text: m.starter }),
      m.lines.length
        ? h('ol', { class: 'story-lines' }, m.lines.map((l) => lineItem(m, l)))
        : h('p', { class: 'story-empty muted', text: m.phase === 'write' ? 'The first line is up for grabs…' : 'No lines yet.' }),
      m.phase === 'write' && m.writer ? h('p', { class: 'story-typing muted', attrs: { 'aria-hidden': 'true' } }, quietFace(m.writer), h('span', { class: 'story-dots', text: '…' })) : null,
    ),
  );

  const paintTurn = memo((m) => {
    if (m.phase !== 'write' || !m.writer) return null;
    return h(
      'div',
      { class: ['story-turn', m.myTurn ? 'is-mine' : null] },
      h('span', { class: 'story-turn-label muted', text: m.myTurn ? 'Your turn' : 'Writing now' }),
      h('span', { class: 'story-turn-who' }, profileButton(m.writer, 'md'), h('strong', { text: m.writer.isMe ? 'You' : m.writer.name })),
      m.upcoming.length ? h('span', { class: 'story-next muted' }, h('span', { text: 'Up next' }), h('span', { class: 'faces' }, m.upcoming.map((p) => profileButton(p, 'sm')))) : null,
    );
  });

  const paintFoot = memo((t) => h('span', { class: 'foot-text', text: t.text }));

  function refresh() {
    update(engine.snapshot());
  }

  function update(snap) {
    const m = story.model(snap, local);
    model = m;
    if (!m) {
      paintBook(book, { phase: 'write', note: null, starter: 'Opening the book…', lines: [], writer: null });
      return;
    }
    if (local.run !== m.run) {
      local.run = m.run;
      local.turn = null;
      local.vote = null;
    }
    const turnKey = `${m.run}:${m.turn}:${m.phase}`;
    if (turnKey !== lastTurn) {
      lastTurn = turnKey;
      if (m.canWrite) {
        input.value = '';
        paintLeft();
      }
    }
    paintHead(head, { phase: m.phase, lap: m.lap, laps: m.laps, turn: m.turn, turns: m.turns, starts: m.starts, ends: m.ends });
    paintBook(book, m);
    paintTurn(turn, m);
    entry.classList.toggle('story-off', !m.canWrite);
    input.disabled = !m.canWrite;
    sendBtn.disabled = !m.canWrite;
    passBtn.disabled = !m.canWrite;
    paintFoot(foot, { text: footText(m) });
    foot.classList.toggle('is-good', m.phase === 'reveal' && m.myGain > 0);
    el.dataset.phase = m.phase;
    const { now, cues: list } = storyMoment(heard, m);
    heard = now;
    list.forEach((name) => cue.play(name));
    if (list.includes('turn') && typeof input.focus === 'function') input.focus();
    if (m.phase === 'reveal' && cheered !== m.run) {
      cheered = m.run;
      const mineTop = m.lines.find((l) => l.top && l.mine);
      if (mineTop) {
        const row = book.querySelector(`.story-line[data-line="${mineTop.i}"]`);
        if (row) cue.burst(row, { count: 14, emoji: ['⭐', '📖'] });
        if (fx && typeof fx.confetti === 'function') fx.confetti(30);
      }
    }
  }

  return { el, update, destroy() {} };
}

