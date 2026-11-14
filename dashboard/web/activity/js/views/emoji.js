import emoji, { judge, puzzleOf, scramble, GUESS_CHARS, KEY } from '../games/emoji.js';
import { cleanText, plainKey } from '../text.js';
import { h, memo, timer, avatar, button, plural } from '../ui/dom.js';

export const TRIES_SHOWN = 4;
export const RESEND_MS = 2500;

const TRY_TEXT = {
  miss: 'Not it',
  close: 'So close!',
  part: 'Part of it!',
};

export function tiles(text) {
  const s = String(text ?? '');
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    return Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s), (x) => x.segment).filter((x) => x.trim());
  }
  return Array.from(s).filter((x) => x.trim());
}

export function footText(m, pending) {
  if (m.phase === 'guess') {
    const count = `${m.solved} of ${plural(m.players, 'player', 'players')} cracked it`;
    if (m.waiting) return `You joined near the end of this one, so you're in from the next puzzle. ${count}.`;
    if (m.watching) return `You're watching this one. ${count}.`;
    if (m.gotMe) return `You cracked it! +${m.myGain.toLocaleString('en-US')}. ${count}.`;
    if (pending) return `Checking your answer… ${count}.`;
    return `Type what the emoji stand for. ${count}.`;
  }
  if (m.gotMe) return `Nice decoding! +${m.myGain.toLocaleString('en-US')}`;
  if (!m.solved) return m.why === 'skip' ? 'Skipped! Nobody cracked this one.' : 'Nobody cracked this one. Tricky!';
  if (m.waiting || m.watching) return `${plural(m.solved, 'player', 'players')} cracked it.`;
  return 'Not this time. On to the next one!';
}

export function hintText(m) {
  if (m.phase !== 'guess' || m.gotMe) return '';
  if (m.level === 0) return 'A hint shows up in a few seconds.';
  if (m.level === 1) return 'Letter count coming soon.';
  return `${plural(m.letters, 'letter', 'letters')} in total.`;
}

const QUIET = { play() {}, burst() {}, float() {} };

export function emojiMoment(was, m) {
  const now = { rid: m.rid, phase: m.phase, level: m.level, solved: m.solved, gotMe: m.gotMe };
  if (!was) return { now, cues: [] };
  const cues = [];
  if (was.rid !== m.rid) {
    if (m.phase === 'guess') cues.push('whoosh');
    return { now, cues };
  }
  if (m.gotMe && !was.gotMe) cues.push('correct');
  if (m.phase === 'reveal' && was.phase !== 'reveal') cues.push('reveal');
  if (m.phase === 'guess' && m.level > was.level && !m.gotMe) cues.push('pop');
  if (m.phase === 'guess' && m.solved > was.solved && !(m.gotMe && !was.gotMe)) cues.push('tap');
  return { now, cues };
}

function gotList(list) {
  return h(
    'ul',
    { class: 'got-list emoji-got' },
    list.slice(0, 10).map((p) =>
      h(
        'li',
        { class: ['got-item', p.isMe ? 'is-me' : null, p.first ? 'emoji-first' : null], attrs: { title: p.username ? `${p.name} (@${p.username})` : p.name } },
        avatar(p, 'xs'),
        h('span', { class: 'got-name', text: p.isMe ? 'You' : p.name }),
        p.first ? h('span', { class: 'emoji-medal', text: '🥇', attrs: { 'aria-label': 'First' } }) : null,
        h('span', { class: 'got-tick', text: `+${p.pts.toLocaleString('en-US')}` }),
      ),
    ),
    list.length > 10 ? h('li', { class: 'tag', text: `+${list.length - 10} more` }) : null,
  );
}

function blanks(words) {
  const cells = [];
  words.forEach((w, wi) => {
    if (wi) cells.push(h('span', { class: 'blank is-gap', attrs: { 'aria-hidden': 'true' } }));
    for (const ch of w) cells.push(h('span', { class: ['blank', ch === '_' ? null : 'emoji-mark'], text: ch === '_' ? '' : ch }));
  });
  return h('span', { class: 'blanks emoji-blanks', attrs: { 'aria-hidden': 'true' } }, cells);
}

export function createEmojiView({ engine, fx, cues, win }) {
  const cue = cues && typeof cues.play === 'function' ? cues : QUIET;
  const w = win || (typeof window !== 'undefined' ? window : {});
  const el = h('section', { class: 'game game-emoji', attrs: { 'aria-label': 'Emoji Decode' } });
  const head = h('div', { class: 'emoji-headwrap' });
  const stage = h('div', { class: 'emoji-stage' });
  const hints = h('div', { class: 'emoji-hints' });
  const input = h('input', {
    class: 'word-input emoji-input',
    dataset: { key: 'emoji-input' },
    attrs: { type: 'text', maxlength: GUESS_CHARS, autocomplete: 'off', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'send', 'aria-label': 'Your guess', placeholder: 'What do these emoji mean?' },
  });
  const sendBtn = button('Guess', { variant: 'primary', key: 'emoji-send', on: () => submit() });
  const note = h('p', { class: 'entry-hint', attrs: { role: 'status', 'aria-live': 'polite' } });
  const triesBox = h('div', { class: 'emoji-triesbox' });
  const entry = h('div', { class: 'emoji-entry' }, h('div', { class: 'entry-row' }, input, sendBtn), note, triesBox);
  const solvers = h('div', { class: 'emoji-solvers' });
  const foot = h('div', { class: 'game-foot', attrs: { role: 'status', 'aria-live': 'polite' } });
  el.append(head, stage, hints, entry, solvers, foot);

  const local = { rid: null, tries: [], pending: null };
  let snap = null;
  let model = null;
  let heard = null;
  let cheered = null;

  function refuse() {
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
    input.classList.remove('is-refused');
  });

  function pendingNow() {
    if (!local.pending || !model || local.pending.rid !== model.rid) return false;
    const at = snap ? snap.now : 0;
    return at - local.pending.at < RESEND_MS;
  }

  function submit() {
    if (!model || !model.canGuess || !snap) return;
    const text = cleanText(input.value, GUESS_CHARS);
    if (!plainKey(text)) {
      note.textContent = 'Type a guess first.';
      refuse();
      return;
    }
    if (pendingNow()) return;
    const st = snap.state[KEY];
    const verdict = judge(text, puzzleOf(st));
    if (verdict === 'right') {
      local.pending = { rid: model.rid, at: snap.now };
      cue.play('send');
      engine.act({ type: 'guess', x: scramble(text, st.k), i: model.i });
      note.textContent = 'Checking…';
      input.value = '';
      paintFoot(foot, { m: model, pending: true });
      return;
    }
    local.tries = [{ text, v: verdict }].concat(local.tries.filter((t) => plainKey(t.text) !== plainKey(text))).slice(0, 12);
    cue.play(verdict === 'miss' ? 'wrong' : 'pop');
    note.textContent = verdict === 'close' ? 'So close! Check your spelling.' : verdict === 'part' ? "Part of it! There's more to the answer." : 'Not it. Try again!';
    input.value = '';
    refuse();
    paintTries(triesBox, { tries: local.tries.slice(0, TRIES_SHOWN), more: Math.max(0, local.tries.length - TRIES_SHOWN) });
  }

  const paintHead = memo((m) =>
    h(
      'div',
      { class: 'game-head' },
      h('span', { class: 'chip chip-static', text: '🧩 Emoji Decode' }),
      h('span', { class: 'game-count', text: `Puzzle ${m.number} of ${m.total}` }),
      timer(m.starts, m.ends, m.phase === 'reveal' ? 'Next puzzle in' : 'Time left to guess'),
    ),
  );

  const paintStage = memo((m) =>
    h(
      'div',
      { class: ['emoji-card', m.phase === 'reveal' ? 'is-reveal' : null, m.gotMe ? 'is-solved' : null] },
      h(
        'p',
        { class: 'emoji-row', attrs: { role: 'img', 'aria-label': `Emoji puzzle: ${m.emoji}` } },
        tiles(m.emoji).map((t, i) => h('span', { class: 'emoji-tile', text: t, vars: { '--i': i } })),
      ),
      m.answer
        ? h('div', { class: 'emoji-answer' }, h('span', { class: 'eyebrow', text: m.phase === 'reveal' ? 'The answer was' : 'You got it!' }), h('span', { class: 'word-reveal emoji-answer-text', text: m.answer }))
        : null,
    ),
  );

  const paintHints = memo((m) => {
    if (m.phase !== 'guess' || m.gotMe) return null;
    return h(
      'div',
      { class: 'emoji-hintrow' },
      m.category
        ? h('span', { class: ['chip chip-static emoji-cat', m.level === 1 ? 'is-fresh' : null], text: `${m.category.emoji} ${m.category.name}` })
        : h('span', { class: 'chip chip-static emoji-cat is-locked', text: '🔒 Category' }),
      m.pattern ? blanks(m.pattern) : null,
      h('span', { class: 'blank-count emoji-hinttext', text: hintText(m) }),
    );
  });

  const paintTries = memo((t) => {
    if (!t.tries.length) return null;
    return h(
      'ul',
      { class: 'emoji-tries', attrs: { 'aria-label': 'Your guesses so far, only you can see these' } },
      t.tries.map((x) =>
        h(
          'li',
          { class: ['emoji-try', `is-${x.v}`] },
          h('span', { class: 'emoji-try-text', text: x.text }),
          h('span', { class: 'emoji-try-tag', text: TRY_TEXT[x.v] || TRY_TEXT.miss }),
        ),
      ),
      t.more ? h('li', { class: 'tag', text: `+${t.more} more` }) : null,
    );
  });

  const paintSolvers = memo((m) => {
    if (!m.got.length) return m.phase === 'reveal' ? null : h('p', { class: 'muted emoji-none', text: 'Nobody has cracked it yet.' });
    return h('div', { class: 'got-it' }, h('span', { class: 'got-label', text: 'Cracked it:' }), gotList(m.got));
  });

  const paintFoot = memo(({ m, pending }) => h('span', { class: 'foot-text', text: footText(m, pending) }));

  function hear(m) {
    const { now, cues: list } = emojiMoment(heard, m);
    heard = now;
    list.forEach((name, i) => cue.play(name, i ? { at: 260 * i } : undefined));
    if (list.includes('correct')) {
      const card = stage.querySelector('.emoji-card');
      if (card) {
        cue.burst(card, { count: 16, emoji: ['✨', '🧩'] });
        if (m.myGain) cue.float(card, `+${m.myGain.toLocaleString('en-US')}`);
      }
    }
  }

  function update(next) {
    snap = next;
    const m = emoji.model(next);
    model = m;
    if (!m) {
      swapEmpty();
      return;
    }
    if (local.rid !== m.rid) {
      local.rid = m.rid;
      local.tries = [];
      local.pending = null;
      input.value = '';
      note.textContent = '';
    }
    if (m.gotMe && local.pending) {
      local.pending = null;
      note.textContent = '';
    }
    const pending = pendingNow();
    paintHead(head, { number: m.number, total: m.total, starts: m.starts, ends: m.ends, phase: m.phase });
    paintStage(stage, { emoji: m.emoji, answer: m.answer, phase: m.phase, gotMe: m.gotMe });
    paintHints(hints, { phase: m.phase, gotMe: m.gotMe, level: m.level, category: m.category, pattern: m.pattern, letters: m.letters });
    paintTries(triesBox, { tries: m.phase === 'guess' ? local.tries.slice(0, TRIES_SHOWN) : [], more: m.phase === 'guess' ? Math.max(0, local.tries.length - TRIES_SHOWN) : 0 });
    paintSolvers(solvers, { phase: m.phase, got: m.got.map((g) => ({ id: g.id, slot: g.slot, name: g.name, username: g.username, initials: g.initials, hue: g.hue, avatar: g.avatar, isMe: g.isMe, pts: g.pts, first: g.first })) });
    paintFoot(foot, { m, pending });
    el.dataset.phase = m.phase;
    const open = m.canGuess && !pending;
    input.disabled = !open;
    sendBtn.disabled = !open;
    entry.classList.toggle('is-hidden', !m.canGuess && !pending);
    const first = heard === null;
    hear(m);
    if (m.gotMe && first) cheered = m.rid;
    if (m.gotMe && cheered !== m.rid) {
      cheered = m.rid;
      if (fx && typeof fx.confetti === 'function') fx.confetti(m.got[0] && m.got[0].isMe ? 50 : 30);
    }
  }

  function swapEmpty() {
    stage.replaceChildren(h('p', { class: 'waiting', text: 'Getting the first puzzle ready…' }));
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
