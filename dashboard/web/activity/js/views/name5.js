import name5, { SLOTS, ANSWER_MAX, REVEAL_MS, OK, BLANK, LETTER, HIDDEN, UNIQUE_POINTS, startsWith } from '../games/name5.js';
import { h, memo, timer, plural, button, profileButton } from '../ui/dom.js';

const QUIET = { play() {}, burst() {}, float() {} };
export const SAVE_GAP_MS = 900;
export const FINAL_SEND_MS = 2500;

export function footText(m) {
  if (m.phase === 'write') {
    const count = `${m.done} of ${plural(m.players, 'player', 'players')} done`;
    if (m.waiting) return `You joined near the end of this round, so you're in from the next one. ${count}`;
    if (m.watching) return `You're watching this round. ${count}`;
    if (m.iDone) return `Locked in! ${count}`;
    return `Five answers starting with ${m.letter}. ${count}`;
  }
  if (m.phase === 'review') {
    if (!m.playing) return `Players are checking answers. ${m.okCount} of ${plural(m.players, 'player', 'players')} happy`;
    return m.iOk ? `Waiting for the others. ${m.okCount} of ${plural(m.players, 'player', 'players')} happy` : 'Tap an answer that is plainly wrong to vote it out.';
  }
  if (m.myGain) return `You scored +${m.myGain.toLocaleString('en-US')} this round.`;
  return m.playing ? 'No points this round. Next letter, next chance!' : 'Round over.';
}

export function codeNote(code) {
  if (code === LETTER) return 'Wrong letter';
  if (code === HIDDEN) return 'Hidden';
  if (code === BLANK) return 'Blank';
  return '';
}

export function n5Moment(was, m) {
  const now = { n: m.n, phase: m.phase };
  if (!was || (was.n === m.n && was.phase === m.phase)) return { now, cue: null };
  if (m.phase === 'review') return { now, cue: 'reveal' };
  if (m.phase === 'reveal' && m.playing) return { now, cue: m.myGain ? 'correct' : 'wrong' };
  return { now, cue: null };
}

function chip(m, row, c, onVeto) {
  const voteText = row.votes ? `👎 ${row.votes}/${row.need}` : null;
  const status = row.code !== OK ? codeNote(row.code) : row.vetoed ? 'Voted out' : null;
  const kids = [
    row.who ? profileButton(row.who, 'xs') : null,
    h('span', { class: 'n5-chip-text', text: row.text || '—' }),
    row.shared && !row.vetoed ? h('span', { class: 'n5-tag', text: 'match' }) : null,
    status ? h('span', { class: 'n5-tag is-bad', text: status }) : null,
    m.phase === 'review' && voteText ? h('span', { class: 'n5-votes fx-num', text: voteText }) : null,
    m.phase === 'reveal' && row.pts !== null ? h('span', { class: 'n5-pts fx-num', text: row.pts ? `+${row.pts}` : '0' }) : null,
  ];
  const cls = ['n5-chip', row.mine ? 'is-mine' : null, row.code !== OK || row.vetoed ? 'is-out' : null, row.shared ? 'is-shared' : null, row.iVoted ? 'is-voted' : null, row.pts === UNIQUE_POINTS ? 'is-unique' : null];
  if (!row.canVote) return h('div', { class: cls }, kids);
  return h(
    'button',
    {
      class: cls.concat(['spot', 'fx-lift']),
      type: 'button',
      dataset: { key: `veto-${row.slot}-${c}` },
      attrs: { 'aria-pressed': row.iVoted ? 'true' : 'false', 'aria-label': `${row.iVoted ? 'Take back your vote on' : 'Vote out'} ${row.text}` },
      on: { click: () => onVeto(row.slot, c, !row.iVoted) },
    },
    kids,
  );
}

export function createName5View({ engine, fx, cues, win }) {
  const cue = cues && typeof cues.play === 'function' ? cues : QUIET;
  const w = win || (typeof window !== 'undefined' ? window : {});
  const el = h('section', { class: 'game game-name5', attrs: { 'aria-label': 'Name 5' } });
  const head = h('div', { class: 'n5-headwrap' });
  const letterBox = h('div', { class: 'n5-letter-wrap' });
  const form = h('div', { class: 'n5-form' });
  const lockBtn = button('Lock in', { variant: 'primary', key: 'n5-lock', on: () => lock() });
  const formFoot = h('div', { class: 'n5-form-foot' }, lockBtn);
  const writer = h('div', { class: 'n5-writer' }, form, formFoot);
  const board = h('div', { class: 'n5-board' });
  const foot = h('div', { class: 'n5-footwrap' });
  el.append(head, letterBox, writer, board, foot);
  const local = { n: null, a: Array(SLOTS).fill(''), done: false, sentAt: 0, dirty: false, rq: 0 };
  let inputs = [];
  let marks = [];
  let snap = null;
  let model = null;
  let heard = null;
  let saveTimer = null;
  let cheered = null;

  function now() {
    return typeof engine.now === 'function' ? engine.now() : Date.now();
  }

  function later(fn, ms) {
    const set = typeof w.setTimeout === 'function' ? w.setTimeout.bind(w) : globalThis.setTimeout;
    return set(fn, ms);
  }

  function cancel(id) {
    const clear = typeof w.clearTimeout === 'function' ? w.clearTimeout.bind(w) : globalThis.clearTimeout;
    if (id !== null) clear(id);
  }

  function send(done = local.done) {
    const m = model;
    if (!m || m.phase !== 'write' || !m.playing || local.n !== m.n) return;
    cancel(saveTimer);
    saveTimer = null;
    local.sentAt = now();
    local.dirty = false;
    engine.act({ type: 'save', n: m.n, a: local.a.slice(), done: Boolean(done) });
  }

  function queueSave() {
    local.dirty = true;
    if (saveTimer !== null) return;
    const wait = Math.max(SAVE_GAP_MS, SAVE_GAP_MS - (now() - local.sentAt));
    saveTimer = later(() => {
      saveTimer = null;
      if (local.dirty) send();
    }, wait);
  }

  function lock() {
    const m = model;
    if (!m || !m.canWrite) return;
    local.done = true;
    cue.play('send');
    send(true);
    if (snap) update(snap);
  }

  function paintMark(i) {
    const m = model;
    const v = local.a[i];
    const ok = Boolean(m && v && startsWith(v, m.letter));
    const bad = Boolean(m && v && v.trim() && !ok);
    marks[i].textContent = ok ? '✓' : bad ? `Starts with ${m.letter}?` : '';
    marks[i].classList.toggle('is-ok', ok);
    marks[i].classList.toggle('is-bad', bad);
  }

  function buildForm(m) {
    inputs = [];
    marks = [];
    const rows = m.cats.map((c, i) => {
      const input = h('input', {
        class: 'word-input n5-input',
        dataset: { key: `n5-input-${i}` },
        attrs: { type: 'text', maxlength: ANSWER_MAX, autocomplete: 'off', autocapitalize: 'words', spellcheck: 'false', enterkeyhint: i < SLOTS - 1 ? 'next' : 'done', 'aria-label': c.name, placeholder: `${m.letter}…` },
      });
      const mark = h('span', { class: 'n5-mark', attrs: { 'aria-live': 'polite' } });
      input.value = local.a[i] || '';
      input.addEventListener('input', () => {
        local.a[i] = input.value.slice(0, ANSWER_MAX);
        paintMark(i);
        queueSave();
      });
      input.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        if (i < SLOTS - 1 && inputs[i + 1] && typeof inputs[i + 1].focus === 'function') inputs[i + 1].focus();
        else lock();
      });
      inputs.push(input);
      marks.push(mark);
      return h('label', { class: 'n5-row', vars: { '--i': i } }, h('span', { class: 'n5-cat' }, h('span', { class: 'n5-cat-emoji', text: c.emoji, attrs: { 'aria-hidden': 'true' } }), h('span', { class: 'n5-cat-name', text: c.name })), input, mark);
    });
    form.replaceChildren(...rows);
    for (let i = 0; i < SLOTS; i += 1) paintMark(i);
  }

  const paintHead = memo((m) =>
    h(
      'div',
      { class: 'game-head' },
      h('span', { class: 'chip chip-static', text: m.phase === 'review' ? '🔎 Check the answers' : m.phase === 'reveal' ? '🧮 Scores' : '🖐️ Name 5' }),
      h('span', { class: 'game-count', text: `Round ${m.number} of ${m.total}` }),
      timer(m.phase === 'reveal' ? m.ends - REVEAL_MS : m.starts, m.ends, m.phase === 'write' ? 'Time left to write' : m.phase === 'review' ? 'Time left to check' : 'Next round in'),
    ),
  );

  const paintLetter = memo((m) => [
    m.note === 'host' && m.phase === 'write' ? h('p', { class: 'notice', text: 'The host changed. Your answers are being sent again.' }) : null,
    h('div', { class: 'n5-letter fx-display', attrs: { 'aria-label': `Letter ${m.letter}` } }, h('span', { class: 'n5-letter-char', text: m.letter })),
    m.rush ? h('p', { class: 'n5-rush' }, profileButton(m.rush, 'xs'), h('span', { text: ` ${m.rush.isMe ? 'You' : m.rush.name} finished first. Hurry!` })) : null,
  ]);

  function veto(slot, c, on) {
    const m = model;
    if (!m || m.phase !== 'review') return;
    cue.play('tap');
    engine.act({ type: 'veto', n: m.n, s: slot, c, on });
  }

  const paintBoard = memo((m) => {
    if (m.phase === 'write') return null;
    if (m.empty) return h('p', { class: 'n5-empty muted', text: 'Nobody wrote anything this round. Bold strategy.' });
    return h(
      'div',
      { class: 'n5-grid' },
      m.grid.map((g) =>
        h(
          'section',
          { class: 'n5-cat-card card', vars: { '--i': g.c } },
          h('h3', { class: 'n5-cat-head' }, h('span', { class: 'n5-cat-emoji', text: g.emoji, attrs: { 'aria-hidden': 'true' } }), h('span', { text: g.name })),
          h('div', { class: 'n5-chips' }, g.rows.map((row) => chip(m, row, g.c, veto))),
        ),
      ),
    );
  });

  const paintFoot = memo((m) =>
    h(
      'div',
      { class: ['game-foot', m.phase === 'reveal' && m.myGain ? 'is-good' : null], attrs: { role: 'status', 'aria-live': 'polite' } },
      h('span', { class: 'foot-text', text: footText(m) }),
      m.phase === 'write' && m.doneBy.length ? h('span', { class: 'faces' }, m.doneBy.slice(0, 7).map((p) => profileButton(p, 'sm'))) : null,
      m.canOk ? button('Looks good', { variant: 'primary', size: 'sm', key: 'n5-ok', on: () => okay() }) : null,
    ),
  );

  function okay() {
    const m = model;
    if (!m || !m.canOk) return;
    cue.play('send');
    engine.act({ type: 'ok', n: m.n });
  }

  function update(next) {
    snap = next;
    const m = name5.model(next, local);
    model = m;
    if (!m) {
      paintBoard(board, null);
      return;
    }
    if (local.n !== m.n) {
      local.n = m.n;
      local.a = Array(SLOTS).fill('');
      local.done = false;
      local.dirty = false;
      local.sentAt = 0;
      local.rq = m.rq;
      cancel(saveTimer);
      saveTimer = null;
      buildForm(m);
      if (m.canWrite && inputs[0] && typeof inputs[0].focus === 'function') inputs[0].focus();
    } else if (m.rq !== local.rq) {
      local.rq = m.rq;
      if (m.phase === 'write' && m.playing && local.a.some((x) => x)) send();
    }
    if (m.phase === 'write' && m.playing && local.dirty && m.ends - now() <= FINAL_SEND_MS) send();
    paintHead(head, { number: m.number, total: m.total, phase: m.phase, starts: m.starts, ends: m.ends });
    paintLetter(letterBox, { letter: m.letter, note: m.note, phase: m.phase, rush: m.phase === 'write' ? m.rush : null });
    paintBoard(board, m.phase === 'write' ? { phase: 'write' } : m);
    paintFoot(foot, { phase: m.phase, done: m.done, players: m.players, waiting: m.waiting, watching: m.watching, iDone: m.iDone, letter: m.letter, playing: m.playing, okCount: m.okCount, iOk: m.iOk, canOk: m.canOk, myGain: m.myGain, doneBy: m.doneBy });
    const open = m.canWrite;
    for (const input of inputs) input.disabled = !open;
    lockBtn.disabled = !open;
    writer.classList.toggle('is-hidden', m.phase !== 'write' || !m.playing);
    writer.classList.toggle('is-locked', m.iDone);
    el.dataset.phase = m.phase;
    const { now: seen, cue: moment } = n5Moment(heard, m);
    heard = seen;
    if (moment) cue.play(moment);
    if (m.phase === 'reveal' && m.myTotal >= 50 && cheered !== m.n) {
      cheered = m.n;
      if (fx && typeof fx.confetti === 'function') fx.confetti(30);
    }
  }

  const ticker = typeof w.setInterval === 'function' ? w.setInterval(() => {
    if (!model || model.phase !== 'write' || !model.playing || !local.dirty) return;
    if (model.ends - now() <= FINAL_SEND_MS) send();
  }, 500) : null;

  return {
    el,
    update,
    destroy() {
      cancel(saveTimer);
      saveTimer = null;
      if (ticker !== null && typeof w.clearInterval === 'function') w.clearInterval(ticker);
    },
  };
}
