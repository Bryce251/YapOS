import closest, { REVEAL_MS, parseGuess } from '../games/closest.js';
import { h, memo, timer, plural, button, profileButton } from '../ui/dom.js';

const QUIET = { play() {}, burst() {}, float() {} };

export function footText(m) {
  if (m.phase === 'guess') {
    const count = `${m.answered} of ${plural(m.players, 'player', 'players')} guessed`;
    if (m.waiting) return `You joined near the end of this one, so you're in from the next question. ${count}`;
    if (m.watching) return `You're watching this one. ${count}`;
    return m.myGuess !== null ? `Locked in at ${m.myText}! ${count}` : `Type your best guess. ${count}`;
  }
  if (m.myExact) return `Spot on! +${m.myGain.toLocaleString('en-US')}`;
  if (m.myTop) return `Closest guess! +${m.myGain.toLocaleString('en-US')}`;
  if (m.myGuess !== null) return m.myGain ? `Not bad. +${m.myGain.toLocaleString('en-US')}` : 'Way off this time.';
  return "Time's up!";
}

export function previewText(raw, year) {
  const v = parseGuess(raw);
  if (v === null) return raw && raw.trim() ? 'Type a number, like 42, 1.5k or 2 million' : '';
  if (year) return '';
  const plain = String(raw).trim().replace(/[\s,]/g, '');
  const shown = v.toLocaleString('en-US', { maximumFractionDigits: 3 });
  return plain === String(v) ? '' : `= ${shown}`;
}

export function closestMoment(was, m) {
  const now = { n: m.n, phase: m.phase };
  if (!was || m.phase !== 'reveal' || (was.n === m.n && was.phase === 'reveal')) return { now, cue: null };
  if (m.myGuess === null) return { now, cue: null };
  return { now, cue: m.myTop || m.myExact ? 'correct' : m.myGain ? 'send' : 'wrong' };
}

function faces(list) {
  if (!list.length) return null;
  return h('span', { class: 'faces' }, list.slice(0, 7).map((p) => profileButton(p, 'sm')), list.length > 7 ? h('span', { class: 'faces-more', text: `+${list.length - 7}` }) : null);
}

function line(m) {
  if (!m.line) return null;
  return h(
    'div',
    { class: 'closest-line', attrs: { 'aria-hidden': 'true' } },
    h('span', { class: 'closest-track' }),
    h('span', { class: 'closest-pin', vars: { '--x': `${m.line.answer}%` } }, h('span', { class: 'closest-pin-label', text: m.answer })),
    m.line.marks.map((k, i) => h('span', { class: ['closest-mark', k.top ? 'is-top' : null, k.isMe ? 'is-me' : null], vars: { '--x': `${k.at}%`, '--i': i } })),
  );
}

export function createClosestView({ engine, fx, cues }) {
  const cue = cues && typeof cues.play === 'function' ? cues : QUIET;
  const el = h('section', { class: 'game game-closest', attrs: { 'aria-label': 'Closest Guess' } });
  const head = h('div', { class: 'closest-headwrap' });
  const ask = h('div', { class: 'closest-ask' });
  const input = h('input', {
    class: 'word-input closest-input',
    dataset: { key: 'closest-input' },
    attrs: { type: 'text', inputmode: 'decimal', maxlength: 24, autocomplete: 'off', spellcheck: 'false', enterkeyhint: 'send', 'aria-label': 'Your guess', placeholder: 'Your guess' },
  });
  const unit = h('span', { class: 'closest-unit muted' });
  const sendBtn = button('Lock in', { variant: 'primary', key: 'closest-send', on: () => submit() });
  const preview = h('p', { class: 'entry-hint closest-preview', attrs: { role: 'status', 'aria-live': 'polite' } });
  const entry = h('div', { class: 'closest-entry' }, h('div', { class: 'entry-row' }, input, unit, sendBtn), preview);
  const body = h('div', { class: 'closest-body' });
  el.append(head, ask, entry, body);
  const local = { n: null, v: null };
  let snap = null;
  let model = null;
  let heard = null;
  let seenN = null;
  let cheered = null;

  function submit() {
    const m = model;
    if (!m || !m.canGuess) return;
    const v = parseGuess(input.value);
    if (v === null) {
      cue.play('error');
      preview.textContent = 'Type a number, like 42, 1.5k or 2 million';
      return;
    }
    local.n = m.n;
    local.v = v;
    cue.play('send');
    engine.act({ type: 'guess', n: m.n, v });
    if (snap) update(snap);
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
  });
  input.addEventListener('input', () => {
    preview.textContent = previewText(input.value, Boolean(model && model.year));
  });

  const paintHead = memo((m) =>
    h(
      'div',
      { class: 'game-head' },
      h('span', { class: 'chip chip-static', text: `${m.emoji} ${m.cat || 'Closest Guess'}` }),
      h('span', { class: 'game-count', text: `Question ${m.number} of ${m.total}` }),
      timer(m.phase === 'reveal' ? m.ends - REVEAL_MS : m.starts, m.ends, m.phase === 'reveal' ? 'Next question in' : 'Time left to guess'),
    ),
  );

  const paintAsk = memo((m) => [
    m.note === 'host' && m.phase === 'guess' ? h('p', { class: 'notice', text: 'The host changed, so this question starts again.' }) : null,
    h('h2', { class: 'question closest-question fx-display', text: m.question }),
  ]);

  const paintBody = memo((m) => {
    const reveal = m.phase === 'reveal';
    return [
      reveal
        ? h(
            'div',
            { class: 'closest-answer card glass' },
            h('span', { class: 'closest-answer-kicker muted', text: 'The answer' }),
            h('strong', { class: 'closest-answer-num fx-display fx-num is-lit', text: m.answer || '?' }),
            m.fact ? h('p', { class: 'closest-fact', text: m.fact }) : null,
          )
        : null,
      reveal ? line(m) : null,
      reveal && m.rows.length
        ? h(
            'ol',
            { class: 'closest-rows' },
            m.rows.slice(0, 8).map((r, i) =>
              h(
                'li',
                { class: ['closest-row', r.isMe ? 'is-me' : null, r.top ? 'is-top' : null], vars: { '--i': i } },
                profileButton(r, 'xs'),
                h('span', { class: 'closest-row-name', text: r.isMe ? 'You' : r.name }),
                h('span', { class: 'closest-row-guess fx-num', text: r.text }),
                h('span', { class: 'closest-row-off muted', text: r.off }),
                r.exact ? h('span', { class: 'closest-badge', text: '🎯', attrs: { title: 'Exact' } }) : r.top ? h('span', { class: 'closest-badge', text: '👑', attrs: { title: 'Closest' } }) : null,
                h('span', { class: 'closest-row-pts fx-num', text: r.pts ? `+${r.pts.toLocaleString('en-US')}` : '0' }),
              ),
            ),
          )
        : null,
      h(
        'div',
        { class: ['game-foot', reveal && (m.myTop || m.myExact) ? 'is-good' : null], attrs: { role: 'status', 'aria-live': 'polite' } },
        h('span', { class: 'foot-text', text: footText(m) }),
        !reveal ? faces(m.answeredBy) : null,
      ),
    ];
  });

  function update(next) {
    snap = next;
    const m = closest.model(next, local);
    model = m;
    if (!m) {
      paintBody(body, null);
      return;
    }
    if (seenN !== m.n) {
      seenN = m.n;
      input.value = '';
      preview.textContent = '';
    }
    paintHead(head, { number: m.number, total: m.total, phase: m.phase, starts: m.starts, ends: m.ends, emoji: m.cat.emoji, cat: m.cat.name });
    paintAsk(ask, { question: m.question, note: m.note, phase: m.phase });
    paintBody(body, m);
    unit.textContent = m.unit || '';
    const open = m.canGuess;
    input.disabled = !open;
    sendBtn.disabled = !open;
    entry.classList.toggle('is-hidden', m.phase !== 'guess' || !m.playing);
    entry.classList.toggle('is-locked', m.phase === 'guess' && m.myGuess !== null);
    if (m.myGuess !== null && m.phase === 'guess' && (typeof document === 'undefined' || document.activeElement !== input)) input.value = m.myText;
    el.dataset.phase = m.phase;
    const { now, cue: moment } = closestMoment(heard, m);
    heard = now;
    if (moment) {
      cue.play(moment);
      const mineRow = body.querySelector('.closest-row.is-me');
      if (mineRow && (m.myTop || m.myExact)) {
        cue.burst(mineRow, { count: m.myExact ? 18 : 10, emoji: m.myExact ? ['🎯', '✨'] : ['👑', '✨'] });
        if (m.myGain) cue.float(mineRow, `+${m.myGain}`);
      }
    }
    if (m.phase === 'reveal' && m.myExact && cheered !== m.n) {
      cheered = m.n;
      if (fx && typeof fx.confetti === 'function') fx.confetti(30);
    }
  }

  return {
    el,
    update,
    destroy() {},
  };
}
