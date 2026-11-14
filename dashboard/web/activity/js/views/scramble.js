import scramble, { REVEAL_MS, sameLetters, cleanGuess, blocked } from '../games/scramble.js';
import { ready as dictReady, isWord, load as loadDictionary } from '../dictionary.js';
import { h, memo, timer, avatar, button, plural } from '../ui/dom.js';

const QUIET = { play() {}, burst() {}, float() {} };
const MEDALS = ['🥇', '🥈', '🥉'];
export const RETRY_MS = 4000;

export function ordinal(n) {
  const tail = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th';
  return `${n}${tail}`;
}

export function localCheck(text, m) {
  const g = cleanGuess(text);
  if (!g) return 'empty';
  if (g.length !== m.size) return 'size';
  if (!sameLetters(g, m.letters.join(''))) return 'letters';
  if (m.check && g === m.check) return null;
  if (blocked(g) || (dictReady && !isWord(g))) return 'unknown';
  return null;
}

export const PROBLEMS = Object.freeze({
  empty: 'Type the word first.',
  size: 'Use every letter exactly once.',
  letters: 'Use only the letters shown, each one once.',
  unknown: "That's not a word I know. Keep shuffling!",
  host: 'Not quite. Try again!',
});

export function footText(m) {
  if (m.phase === 'reveal') {
    if (m.note === 'host') return 'The host changed, so this word ended early.';
    if (!m.got.length) return 'Nobody unscrambled this one.';
    if (m.gotMe) return `You got it in ${ordinal(m.place)} place for +${m.myPts}.`;
    if (m.note === 'all') return 'Everyone got it!';
    return `${plural(m.got.length, 'player', 'players')} got it.`;
  }
  if (!m.playing) return `You're watching. ${plural(m.got.length, 'player has', 'players have')} solved it so far.`;
  if (m.gotMe) return `Solved in ${ordinal(m.place)} place! +${m.myPts}. Waiting for the others…`;
  if (m.got.length) return `${plural(m.got.length, 'player has', 'players have')} solved it. Points drop with every solve, so hurry!`;
  return 'First to unscramble it scores 100 points.';
}

export function scrambleMoments(was, m) {
  const got = m.got.map((g) => g.slot);
  const now = { i: m.i, phase: m.phase, got, wrong: m.wrong, hint: Boolean(m.hint), gotMe: m.gotMe };
  if (!was) return { now, cues: [] };
  const cues = [];
  if (m.i !== was.i) {
    if (m.phase === 'play') cues.push('turn');
    return { now, cues };
  }
  if (m.phase === 'reveal' && was.phase !== 'reveal') cues.push('reveal');
  if (m.gotMe && !was.gotMe) cues.push('correct');
  else if (got.some((s) => !was.got.includes(s)) && m.phase === 'play') cues.push('pop');
  if (m.wrong > was.wrong) cues.push('error');
  if (m.hint && !was.hint && m.phase === 'play') cues.push('toggle');
  return { now, cues };
}

function useTiles(order, letters, typed) {
  const used = new Array(order.length).fill(false);
  const marks = [];
  for (const ch of typed) {
    let hit = -1;
    for (let j = 0; j < order.length; j += 1) {
      if (!used[j] && letters[order[j]] === ch) {
        hit = j;
        break;
      }
    }
    if (hit >= 0) used[hit] = true;
    marks.push(hit >= 0);
  }
  return { used, marks };
}

function faceRow(list) {
  if (!list.length) return null;
  return h(
    'ol',
    { class: 'scramble-solvers', attrs: { 'aria-label': 'Solved so far' } },
    list.map((g) =>
      h(
        'li',
        { class: ['scramble-solver', g.isMe ? 'is-me' : null], attrs: { title: g.isMe ? 'You' : g.name } },
        h('span', { class: 'scramble-medal', text: MEDALS[g.place - 1] || `${g.place}`, attrs: { 'aria-hidden': 'true' } }),
        avatar(g, 'xs'),
        h('span', { class: 'scramble-solver-name', text: g.isMe ? 'You' : g.name }),
        h('span', { class: 'scramble-solver-pts', text: `+${g.pts}` }),
      ),
    ),
  );
}

export function createScrambleView({ engine, fx, win, cues }) {
  const cue = cues && typeof cues.play === 'function' ? cues : QUIET;
  const w = win || (typeof window !== 'undefined' ? window : {});
  const el = h('section', { class: 'game scramble-game', attrs: { 'aria-label': 'Scramble Race' } });
  const head = h('div', { class: 'scramble-headwrap' });
  const board = h('div', { class: 'scramble-board' });
  const input = h('input', {
    class: 'word-input scramble-input',
    dataset: { key: 'scramble-input' },
    attrs: { type: 'text', maxlength: 12, autocomplete: 'off', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'send', 'aria-label': 'Your answer', placeholder: 'Type the word' },
  });
  const sendBtn = button('Go', { variant: 'primary', key: 'scramble-send', on: () => submit() });
  const shuffleBtn = button('Shuffle', { variant: 'ghost', size: 'sm', key: 'scramble-shuffle', on: () => reshuffle(), kids: h('span', { text: '⇄', attrs: { 'aria-hidden': 'true' } }) });
  const backBtn = button('Back', { variant: 'ghost', size: 'sm', key: 'scramble-back', on: () => back(), kids: h('span', { text: '⌫', attrs: { 'aria-hidden': 'true' } }) });
  const clearBtn = button('Clear', { variant: 'ghost', size: 'sm', key: 'scramble-clear', on: () => clear() });
  const hint = h('p', { class: 'entry-hint', attrs: { role: 'status', 'aria-live': 'polite' } });
  const tools = h('div', { class: 'scramble-tools' }, shuffleBtn, backBtn, clearBtn);
  const entry = h('div', { class: 'scramble-entry' }, h('div', { class: 'entry-row' }, input, sendBtn), tools, hint);
  const result = h('div', { class: 'scramble-result', attrs: { 'aria-live': 'polite' } });
  const foot = h('div', { class: 'game-foot', attrs: { role: 'status', 'aria-live': 'polite' } });
  el.append(head, board, entry, result, foot);

  const local = { solved: null, i: null, order: [], tried: '', sentI: null, sentAt: 0, wrong: 0, fresh: null };
  loadDictionary();
  let snap = null;
  let model = null;
  let heard = null;
  let cheered = null;

  function refuse(text, quiet) {
    if (!quiet) cue.play('error');
    hint.textContent = text;
    input.classList.remove('is-refused');
    void input.offsetWidth;
    input.classList.add('is-refused');
  }

  function typed() {
    return cleanGuess(input.value).slice(0, model ? model.size : 12);
  }

  function submit(auto) {
    const m = model;
    if (!m || !m.canGuess || local.sentI === m.i) return;
    const text = typed();
    if (auto && text === local.tried) return;
    local.tried = text;
    const problem = localCheck(text, m);
    if (problem) {
      if (problem !== 'empty' || !auto) refuse(PROBLEMS[problem]);
      return;
    }
    local.sentI = m.i;
    local.sentAt = snap ? snap.now : 0;
    local.solved = { i: m.i, word: text };
    engine.act({ type: 'guess', text, i: m.i });
    hint.textContent = 'Checking…';
    drawBoard();
  }

  function reshuffle() {
    if (!model || model.phase !== 'play') return;
    const next = local.order.slice();
    for (let t = 0; t < 6; t += 1) {
      for (let i = next.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [next[i], next[j]] = [next[j], next[i]];
      }
      if (next.join() !== local.order.join()) break;
    }
    local.order = next;
    cue.play('whoosh');
    drawBoard();
  }

  function back() {
    if (!model || !model.canGuess) return;
    input.value = typed().slice(0, -1);
    hint.textContent = '';
    drawBoard();
  }

  function clear() {
    if (!model || !model.canGuess) return;
    input.value = '';
    hint.textContent = '';
    drawBoard();
  }

  function tap(j) {
    const m = model;
    if (!m || !m.canGuess || local.sentI === m.i) return;
    const letter = m.letters[local.order[j]];
    const now = typed();
    if (now.length >= m.size) return;
    input.value = now + letter;
    cue.play('tap');
    hint.textContent = '';
    drawBoard();
    if (typed().length === m.size) submit(true);
  }

  input.addEventListener('animationend', () => input.classList.remove('is-refused'));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
  });
  input.addEventListener('input', () => {
    const clean = typed();
    if (input.value !== clean) input.value = clean;
    input.classList.remove('is-refused');
    hint.textContent = '';
    drawBoard();
    if (model && clean.length === model.size) submit(true);
  });

  const paintHead = memo((m) =>
    h(
      'div',
      { class: 'game-head' },
      m.tier ? h('span', { class: 'chip chip-static', text: `${m.tier.name} word` }) : null,
      h('span', { class: 'game-count', text: `Word ${m.number} of ${m.total}` }),
      m.phase === 'reveal' ? timer(m.ends - REVEAL_MS, m.ends, 'Next word in') : timer(m.starts, m.ends, 'Time left for this word'),
    ),
  );

  const paintBoard = memo((v) => {
    if (v.phase === 'reveal') {
      return h(
        'div',
        { class: 'scramble-stage is-reveal' },
        h('span', { class: 'eyebrow', text: 'The word was' }),
        h(
          'div',
          { class: ['scramble-answer', v.fresh ? 'is-fresh' : null], attrs: { 'aria-label': v.answer || '' } },
          Array.from(v.answer || '').map((ch, i) => h('span', { class: 'scramble-tile is-answer', vars: { '--i': i }, text: ch.toUpperCase(), attrs: { 'aria-hidden': 'true' } })),
        ),
      );
    }
    const tiles = v.order.map((idx, j) =>
      h(
        'button',
        {
          class: ['scramble-tile', 'spot', v.used[j] ? 'is-used' : null],
          type: 'button',
          disabled: !v.open || v.used[j],
          vars: { '--i': j },
          dataset: { key: `tile-${j}` },
          attrs: { 'aria-label': `Letter ${v.letters[idx].toUpperCase()}` },
          on: { click: () => tap(j) },
        },
        v.letters[idx].toUpperCase(),
      ),
    );
    const slots = [];
    for (let i = 0; i < v.size; i += 1) {
      const ch = v.typed[i];
      const ghost = !ch && i === 0 && v.hint;
      slots.push(
        h('span', {
          class: ['scramble-slot', ch ? 'is-filled' : null, ch && !v.marks[i] ? 'is-off' : null, ghost ? 'is-hint' : null, v.solved ? 'is-solved' : null],
          text: ch ? ch.toUpperCase() : ghost ? v.hint.toUpperCase() : '',
        }),
      );
    }
    return h(
      'div',
      { class: 'scramble-stage' },
      h('span', { class: 'eyebrow', text: v.solved ? 'You unscrambled it!' : 'Unscramble this word' }),
      h('div', { class: ['scramble-tiles', v.fresh ? 'is-fresh' : null], attrs: { role: 'group', 'aria-label': 'Scrambled letters' } }, tiles),
      h('div', { class: 'scramble-slots', attrs: { 'aria-hidden': 'true' } }, slots),
      v.hint && !v.solved ? h('p', { class: 'scramble-hint', text: `Hint: it starts with ${v.hint.toUpperCase()}` }) : null,
    );
  });

  const paintResult = memo((m) => {
    if (m.phase === 'reveal') {
      return [
        m.found.length
          ? h(
              'p',
              { class: 'scramble-also' },
              h('span', { class: 'muted', text: 'Also accepted: ' }),
              m.found.map((f) => h('span', { class: ['scramble-alt', f.isMe ? 'is-me' : null], text: `${f.word.toUpperCase()} (${f.isMe ? 'you' : f.name})` })),
            )
          : null,
        m.got.length ? faceRow(m.got) : h('p', { class: 'muted scramble-none', text: 'No solves this time. The next one is yours!' }),
      ];
    }
    return faceRow(m.got);
  });

  const paintFoot = memo((m) => h('span', { class: 'foot-text', text: footText(m) }));

  function drawBoard() {
    const m = model;
    if (!m) return;
    if (local.i !== m.i || local.order.length !== m.size) {
      local.i = m.i;
      local.order = m.letters.map((_, j) => j);
      local.tried = '';
      input.value = '';
      hint.textContent = '';
    }
    const solved = m.gotMe;
    const text = solved && m.myWord ? m.myWord : local.sentI === m.i && local.solved ? local.solved.word : typed();
    const { used, marks } = useTiles(local.order, m.letters, text);
    paintBoard(board, {
      phase: m.phase,
      answer: m.answer,
      order: local.order,
      letters: m.letters,
      size: m.size,
      typed: Array.from(text),
      used,
      marks,
      hint: m.hint,
      solved,
      open: m.canGuess && local.sentI !== m.i,
      fresh: local.fresh !== `${m.i}:${m.phase}`,
    });
    local.fresh = `${m.i}:${m.phase}`;
  }

  function hear(m) {
    const { now, cues: list } = scrambleMoments(heard, m);
    heard = now;
    list.forEach((name, i) => cue.play(name, i ? { at: 260 * i } : undefined));
    if (list.includes('correct')) {
      const slots = board.querySelector('.scramble-slots');
      if (slots) {
        cue.burst(slots, { count: 14, emoji: ['🔀', '🎉'] });
        if (m.myPts) cue.float(slots, `+${m.myPts}`);
      }
      if (m.place === 1 && m.players > 1 && cheered !== m.i && fx && typeof fx.confetti === 'function') {
        cheered = m.i;
        fx.confetti(30);
      }
    }
  }

  function update(next) {
    snap = next;
    const m = scramble.model(next, local);
    model = m;
    if (!m) {
      board.replaceChildren(h('p', { class: 'waiting', text: 'Mixing up the first word…' }));
      return;
    }
    if (local.sentI === m.i && !m.gotMe && m.wrong > local.wrong) {
      local.sentI = null;
      local.solved = null;
      refuse(PROBLEMS.host, true);
    } else if (local.sentI === m.i && !m.gotMe && m.phase === 'play' && next.now - local.sentAt > RETRY_MS) {
      local.sentI = null;
      local.solved = null;
      local.tried = '';
      hint.textContent = "That one didn't go through. Try again!";
    }
    local.wrong = m.wrong;
    paintHead(head, { tier: m.tier, number: m.number, total: m.total, phase: m.phase, starts: m.starts, ends: m.ends });
    drawBoard();
    paintResult(result, { phase: m.phase, found: m.found, got: m.got });
    paintFoot(foot, m);
    const open = m.canGuess && local.sentI !== m.i;
    input.disabled = !open;
    sendBtn.disabled = !open;
    for (const b of [shuffleBtn, backBtn, clearBtn]) b.disabled = !open;
    if (m.phase === 'play' && m.playing) shuffleBtn.disabled = false;
    entry.classList.toggle('is-hidden', m.phase !== 'play' || !m.playing || m.gotMe);
    entry.classList.toggle('is-open', open);
    if (m.gotMe && hint.textContent) hint.textContent = '';
    const heardBefore = heard;
    hear(m);
    if (open && heardBefore && heardBefore.i !== m.i && typeof input.focus === 'function') input.focus();
  }

  const ticker = typeof w.setInterval === 'function' ? w.setInterval(() => snap && update(engine.snapshot()), 1000) : null;

  return {
    el,
    update,
    destroy() {
      if (ticker !== null && typeof w.clearInterval === 'function') w.clearInterval(ticker);
    },
  };
}
