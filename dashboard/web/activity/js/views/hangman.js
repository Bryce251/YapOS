import hangman, { REVEAL_MS, WORD_COST, cleanLetter, cleanGuess } from '../games/hangman.js';
import { h, memo, timer, profileButton, button, plural } from '../ui/dom.js';

const QUIET = { play() {}, burst() {}, float() {} };
const MEDALS = ['🥇', '🥈', '🥉'];

export function rankText(rank) {
  if (!rank) return '';
  return MEDALS[rank - 1] || `#${rank}`;
}

export function footText(m) {
  if (m.phase === 'reveal') {
    if (m.solved) return `You solved it${m.rank <= 3 ? ` ${rankText(m.rank)}` : ''}! +${m.myGain}`;
    if (m.myGain) return `The word was ${m.word.toUpperCase()}. +${m.myGain} for the letters you found.`;
    return `The word was ${m.word.toUpperCase()}.`;
  }
  const count = `${m.solvedCount} of ${plural(m.players, 'player', 'players')} solved it`;
  if (m.waiting) return `You joined near the end of this word, so you're in from the next one. ${count}`;
  if (m.watching) return `You're watching this one. ${count}`;
  if (m.solved) return `Solved ${rankText(m.rank)}! Waiting for the others. ${count}`;
  if (m.out) return `Out of lives! Hang on for the next word. ${count}`;
  return `Tap letters or type them. ${count}`;
}

export function hangmanMoment(was, m) {
  const now = { n: m.n, phase: m.phase, guessed: m.guessed, solved: m.solved, out: m.out };
  if (!was || was.n !== m.n) return { now, cues: [] };
  const cues = [];
  if (m.phase === 'reveal' && was.phase !== 'reveal') cues.push('reveal');
  else if (m.guessed.length > was.guessed.length) {
    const l = m.guessed[m.guessed.length - 1];
    cues.push(m.pattern.some((p) => p.shown && p.c === l) ? 'correct' : 'wrong');
  }
  if (m.solved && !was.solved) cues.push('win');
  else if (m.out && !was.out) cues.push('lose');
  return { now, cues };
}

function hearts(lives, max, size = '') {
  const list = [];
  for (let i = 0; i < max; i += 1) list.push(h('span', { class: ['hangman-heart', i < lives ? 'is-full' : 'is-lost'], text: i < lives ? '❤️' : '🤍', attrs: { 'aria-hidden': 'true' } }));
  return h('span', { class: ['hangman-hearts', size ? `hangman-hearts-${size}` : null], attrs: { role: 'img', 'aria-label': `${plural(lives, 'life', 'lives')} left` } }, list);
}

export function createHangmanView({ engine, fx, toast, win, cues }) {
  const cue = cues && typeof cues.play === 'function' ? cues : QUIET;
  const say = typeof toast === 'function' ? toast : () => {};
  const w = win || globalThis;
  const el = h('section', { class: 'game game-hangman', attrs: { 'aria-label': 'Hangman Royale' } });
  const head = h('div', { class: 'hangman-headwrap' });
  const board = h('div', { class: 'hangman-board' });
  const keys = h('div', { class: 'hangman-keys-wrap' });
  const input = h('input', {
    class: 'word-input',
    dataset: { key: 'hangman-solve' },
    attrs: { type: 'text', maxlength: 20, autocomplete: 'off', spellcheck: 'false', enterkeyhint: 'go', 'aria-label': 'Guess the whole word', placeholder: 'Know it? Type the whole word' },
  });
  const solveBtn = button('Solve', { variant: 'secondary', key: 'hangman-solve-go', on: () => solve() });
  const solveRow = h('div', { class: 'hangman-solve' }, h('div', { class: 'entry-row' }, input, solveBtn), h('p', { class: 'hangman-solve-note muted', text: `A wrong guess costs ${plural(WORD_COST, 'life', 'lives')}.` }));
  const others = h('div', { class: 'hangman-others-wrap' });
  const foot = h('div', { class: 'game-foot', attrs: { role: 'status', 'aria-live': 'polite' } });
  el.append(head, board, keys, solveRow, others, foot);
  const local = { n: null, l: '' };
  let model = null;
  let heard = null;
  let cheered = null;

  function guess(l) {
    const m = model;
    const letter = cleanLetter(l);
    if (!m || !letter || !m.canGuess || m.guessed.includes(letter)) return;
    if (local.n !== m.n) {
      local.n = m.n;
      local.l = '';
    }
    if (local.l.includes(letter)) return;
    local.l += letter;
    cue.play('tap', { volume: 0.5 });
    engine.act({ type: 'letter', n: m.n, l: letter });
    refresh();
  }

  function solve() {
    const m = model;
    if (!m || !m.canGuess) return;
    const g = cleanGuess(input.value);
    if (!g || g.length !== m.len) {
      cue.play('error');
      say(`The word has ${plural(m.len, 'letter', 'letters')}.`);
      input.classList.add('is-refused');
      if (typeof w.setTimeout === 'function') w.setTimeout(() => input.classList.remove('is-refused'), 420);
      return;
    }
    input.value = '';
    cue.play('send');
    engine.act({ type: 'word', n: m.n, w: g });
  }

  function onKeys(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = e.target && e.target.tagName ? String(e.target.tagName).toLowerCase() : '';
    if (tag === 'input' || tag === 'textarea' || (e.target && e.target.isContentEditable)) return;
    const l = cleanLetter(String(e.key || ''));
    if (!l || !model || !model.canGuess) return;
    e.preventDefault();
    guess(l);
  }
  if (typeof w.addEventListener === 'function') w.addEventListener('keydown', onKeys);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      solve();
    }
  });

  const paintHead = memo((m) =>
    h(
      'div',
      { class: 'game-head' },
      h('span', { class: 'chip chip-static', text: `${m.cat.emoji} ${m.cat.name}` }),
      h('span', { class: 'game-count', text: `Word ${m.number} of ${m.total}` }),
      timer(m.phase === 'reveal' ? m.ends - REVEAL_MS : m.starts, m.ends, m.phase === 'reveal' ? 'Next word in' : 'Time left to guess'),
    ),
  );

  const paintBoard = memo((m) => [
    h(
      'div',
      { class: 'hangman-status' },
      hearts(m.lives, m.maxLives),
      m.solved ? h('span', { class: 'hangman-badge is-solved', text: `Solved ${rankText(m.rank)}` }) : m.out ? h('span', { class: 'hangman-badge is-out', text: 'Out of lives' }) : null,
    ),
    h(
      'ol',
      { class: ['hangman-word', m.phase === 'reveal' ? 'is-reveal' : null, m.solved ? 'is-solved' : null], attrs: { 'aria-label': m.phase === 'reveal' && m.word ? `The word was ${m.word}` : `${plural(m.len, 'letter', 'letters')}: ${m.pattern.map((p) => (p.shown ? p.c : 'blank')).join(', ')}` } },
      m.pattern.map((p) => h('li', { class: ['hangman-tile', p.shown ? 'is-shown' : null, !p.shown && p.c ? 'is-missed' : null], text: p.c ? p.c.toUpperCase() : '', vars: { '--i': p.i } })),
    ),
  ]);

  const paintKeys = memo((m) =>
    h(
      'div',
      { class: 'hangman-keys', attrs: { role: 'group', 'aria-label': 'Letters' } },
      m.keys.map((k) =>
        h('button', {
          class: ['hangman-key', 'spot', k.state ? `is-${k.state}` : null],
          type: 'button',
          text: k.l.toUpperCase(),
          dataset: { key: `letter-${k.l}` },
          disabled: !m.canGuess || Boolean(k.state),
          attrs: { 'aria-label': k.state === 'hit' ? `${k.l}, in the word` : k.state === 'miss' ? `${k.l}, not in the word` : k.l },
          on: { click: () => guess(k.l) },
        }),
      ),
    ),
  );

  const paintOthers = memo((list) => {
    if (!list.length) return null;
    return h(
      'ul',
      { class: 'hangman-others', attrs: { 'aria-label': 'Everyone' } },
      list.map((o) =>
        h(
          'li',
          { class: ['hangman-other', o.face.isMe ? 'is-me' : null, o.rank ? 'is-solved' : null, o.out ? 'is-out' : null], vars: { '--found': o.share } },
          profileButton(o.face, 'sm'),
          h('span', { class: 'hangman-other-name', text: o.face.isMe ? 'You' : o.face.name }),
          h('span', { class: 'hangman-other-bar', attrs: { 'aria-hidden': 'true' } }, h('span', { class: 'hangman-other-fill' })),
          o.rank ? h('span', { class: ['medal', o.rank <= 3 ? `medal-${o.rank}` : null, 'hangman-other-rank'], text: String(o.rank), attrs: { role: 'img', 'aria-label': `Solved in place ${o.rank}` } }) : hearts(o.lives, 6, 'xs'),
          o.gain ? h('span', { class: 'hangman-gain', text: `+${o.gain}` }) : null,
        ),
      ),
    );
  });

  const paintFoot = memo((m) => h('span', { class: 'foot-text', text: m.text }));

  function refresh() {
    update(engine.snapshot());
  }

  function update(snap) {
    const m = hangman.model(snap, local);
    model = m;
    if (!m) {
      paintBoard(board, { lives: 0, maxLives: 6, solved: false, out: false, rank: 0, phase: 'guess', len: 0, pattern: [], word: null });
      return;
    }
    if (local.n !== m.n) {
      local.n = m.n;
      local.l = '';
      input.value = '';
    }
    paintHead(head, { cat: m.cat, number: m.number, total: m.total, phase: m.phase, starts: m.starts, ends: m.ends });
    paintBoard(board, { lives: m.lives, maxLives: m.maxLives, solved: m.solved, out: m.out, rank: m.rank, phase: m.phase, len: m.len, pattern: m.pattern, word: m.word });
    paintKeys(keys, { keys: m.keys, canGuess: m.canGuess });
    solveRow.classList.toggle('hangman-off', !m.canGuess);
    input.disabled = !m.canGuess;
    solveBtn.disabled = !m.canGuess;
    paintOthers(others, m.others.map((o) => ({ ...o, share: m.len ? (o.found / m.len).toFixed(3) : '0' })));
    paintFoot(foot, { text: footText(m) });
    foot.classList.toggle('is-good', m.phase === 'reveal' && m.myGain > 0);
    el.dataset.phase = m.phase;
    const { now, cues: list } = hangmanMoment(heard, m);
    heard = now;
    list.forEach((name, i) => cue.play(name, i ? { at: 260 } : undefined));
    if (m.solved && cheered !== m.n) {
      cheered = m.n;
      const tiles = board.querySelector('.hangman-word');
      if (list.includes('win')) {
        cue.burst(tiles, { count: 16, emoji: ['🎉', '🪢'] });
        if (m.rank === 1 && fx && typeof fx.confetti === 'function') fx.confetti(40);
      }
    }
  }

  return {
    el,
    update,
    destroy() {
      if (typeof w.removeEventListener === 'function') w.removeEventListener('keydown', onKeys);
    },
  };
}
