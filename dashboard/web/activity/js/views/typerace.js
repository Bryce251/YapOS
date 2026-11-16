import typerace, { correctPrefix, TEXT_MAX } from '../games/typerace.js';
import { h, memo, timer, countdown, profileButton, plural } from '../ui/dom.js';

const QUIET = { play() {}, burst() {}, float() {} };
const MEDALS = ['🥇', '🥈', '🥉'];
export const PROG_MS = 500;
const BLOCKED_INPUT = new Set(['insertFromPaste', 'insertFromDrop', 'insertFromYank', 'insertReplacementText']);

export function placeText(place) {
  if (!place) return '';
  return MEDALS[place - 1] || `#${place}`;
}

export function footText(m, now) {
  if (m.phase === 'show') {
    if (m.place) return `You finished ${placeText(m.place)} at ${m.wpm} WPM with ${m.acc}% accuracy. +${m.myGain}`;
    if (m.flagged) return "That was faster than any human types, so it didn't count.";
    if (m.myGain) return `Out of time! +${m.myGain} for how far you got.`;
    return 'Round over.';
  }
  const count = `${m.finished} of ${plural(m.racers.length, 'racer', 'racers')} finished`;
  if (m.waiting) return `You joined late, so you race from the next round. ${count}`;
  if (m.watching) return `You're watching this race. ${count}`;
  if (m.flagged) return "That was faster than any human types, so it didn't count.";
  if (m.place) return `Finished ${placeText(m.place)} at ${m.wpm} WPM! ${count}`;
  if (now < m.go) return 'Get ready. Typing opens when the countdown ends.';
  return `Type the sentence exactly. Fix mistakes before moving on. ${count}`;
}

export function typeraceMoment(was, m) {
  const now = { n: m.n, phase: m.phase, place: m.place, finished: m.finished };
  if (!was || was.n !== m.n) return { now, cues: m.phase === 'race' ? ['start'] : [] };
  const cues = [];
  if (m.phase === 'show' && was.phase !== 'show') cues.push('reveal');
  if (m.place && !was.place) cues.push(m.place === 1 ? 'win' : 'correct');
  else if (m.finished > was.finished && !m.place) cues.push('pop');
  return { now, cues };
}

export function splitText(text, typed) {
  const t = String(text || '');
  const v = String(typed || '');
  const good = correctPrefix(t, v);
  const bad = Math.min(t.length - good, Math.max(0, v.length - good));
  return { good: t.slice(0, good), bad: t.slice(good, good + bad), rest: t.slice(good + bad), c: good };
}

export function createTyperaceView({ engine, fx, toast, win, cues }) {
  const cue = cues && typeof cues.play === 'function' ? cues : QUIET;
  const say = typeof toast === 'function' ? toast : () => {};
  const w = win || globalThis;
  const el = h('section', { class: 'game game-typerace', attrs: { 'aria-label': 'Typing Race' } });
  const head = h('div', { class: 'typerace-headwrap' });
  const prompt = h('div', { class: 'typerace-prompt' });
  const input = h('textarea', {
    class: 'word-input typerace-input',
    dataset: { key: 'typerace-input' },
    attrs: { rows: 2, maxlength: TEXT_MAX + 8, autocomplete: 'off', autocorrect: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-label': 'Type the sentence here', placeholder: 'Start typing when it says go' },
  });
  const racers = h('div', { class: 'typerace-racers-wrap' });
  const foot = h('div', { class: 'game-foot', attrs: { role: 'status', 'aria-live': 'polite' } });
  el.append(head, prompt, input, racers, foot);
  const local = { n: null, typed: '', errors: 0, sent: -1, done: false };
  let model = null;
  let heard = null;
  let cheered = null;
  let goTimer = null;
  let goFor = null;

  function now() {
    return typeof engine.now === 'function' ? engine.now() : Date.now();
  }

  function reset(n) {
    local.n = n;
    local.typed = '';
    local.errors = 0;
    local.sent = -1;
    local.done = false;
    input.value = '';
  }

  function sendProgress() {
    const m = model;
    if (!m || !m.canType || local.done || local.n !== m.n || now() < m.go) return;
    const c = correctPrefix(m.text, local.typed);
    if (c === local.sent || c >= m.text.length) return;
    local.sent = c;
    engine.act({ type: 'prog', n: m.n, c });
  }

  const pump = typeof w.setInterval === 'function' ? w.setInterval(sendProgress, PROG_MS) : null;

  function block(e) {
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    cue.play('error', { volume: 0.4 });
    say('No pasting in a typing race. Type it out!');
  }

  input.addEventListener('paste', block);
  input.addEventListener('drop', block);
  input.addEventListener('beforeinput', (e) => {
    if (e && BLOCKED_INPUT.has(e.inputType)) block(e);
  });

  function onInput() {
    const m = model;
    if (!m || !m.canType || local.done || now() < m.go) {
      input.value = local.typed;
      return;
    }
    const value = String(input.value || '').replace(/\n/g, '');
    if (value.length > local.typed.length + 2) {
      input.value = local.typed;
      block(null);
      return;
    }
    if (value.length > local.typed.length) {
      const at = value.length - 1;
      if (value[at] !== m.text[at] || correctPrefix(m.text, value) < at) {
        local.errors += 1;
        cue.play('error', { volume: 0.25 });
      } else cue.play('type', { volume: 0.5 });
    }
    local.typed = value;
    if (input.value !== value) input.value = value;
    if (value === m.text) {
      local.done = true;
      input.disabled = true;
      engine.act({ type: 'done', n: m.n, t: value, ms: Math.max(0, Math.round(now() - m.go)), e: local.errors });
    }
    paintText();
  }

  input.addEventListener('input', onInput);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') e.preventDefault();
  });

  const paintHead = memo((m) =>
    h(
      'div',
      { class: 'game-head' },
      h('span', { class: 'chip chip-static', text: m.kind }),
      h('span', { class: 'game-count', text: `Round ${m.number} of ${m.total}` }),
      m.phase === 'show' ? timer(m.starts, m.ends, 'Next round in') : m.early ? countdown(m.starts, m.go, { lead: 'Go in', label: 'Time until typing opens' }) : timer(m.go, m.ends, 'Time left to type'),
    ),
  );

  const paintPrompt = memo((p) =>
    h(
      'p',
      { class: ['typerace-text', p.locked ? 'is-locked' : null, p.done ? 'is-done' : null], attrs: { 'aria-label': p.text } },
      h('span', { class: 'typerace-good', text: p.good }),
      h('span', { class: 'typerace-bad', text: p.bad }),
      p.caret ? h('span', { class: 'typerace-caret fx-loop', attrs: { 'aria-hidden': 'true' } }) : null,
      h('span', { class: 'typerace-rest', text: p.rest }),
    ),
  );

  const paintRacers = memo((list) => {
    if (!list.length) return null;
    return h(
      'ul',
      { class: 'typerace-racers', attrs: { 'aria-label': 'Racers' } },
      list.map((r) =>
        h(
          'li',
          { class: ['typerace-racer', r.face.isMe ? 'is-me' : null, r.place ? 'is-done' : null, r.flagged ? 'is-flagged' : null], vars: { '--share': r.share.toFixed(3) } },
          profileButton(r.face, 'sm'),
          h('span', { class: 'typerace-name', text: r.face.isMe ? 'You' : r.face.name }),
          h('span', { class: 'typerace-track', attrs: { role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(r.share * 100), 'aria-label': `${r.face.isMe ? 'Your' : `${r.face.name}'s`} progress` } }, h('span', { class: 'typerace-fill' }), h('span', { class: 'typerace-car', text: r.place === 1 ? '🏆' : '🏎️', attrs: { 'aria-hidden': 'true' } })),
          r.place ? h('span', { class: 'typerace-stat', text: `${placeText(r.place)} ${r.wpm} WPM · ${r.acc}%` }) : r.flagged ? h('span', { class: 'typerace-stat', text: '🚫' }) : null,
          r.gain ? h('span', { class: 'typerace-gain', text: `+${r.gain}` }) : null,
        ),
      ),
    );
  });

  const paintFoot = memo((m) => h('span', { class: 'foot-text', text: m.text }));

  function paintText() {
    const m = model;
    if (!m) return;
    const typing = m.canType && !local.done && now() >= m.go;
    const parts = m.phase === 'show' || m.place ? { good: m.place ? m.text : '', bad: '', rest: m.place ? '' : m.text } : splitText(m.text, local.n === m.n ? local.typed : '');
    paintPrompt(prompt, { text: m.text, good: parts.good, bad: parts.bad, rest: parts.rest, caret: typing, locked: now() < m.go && m.phase === 'race', done: Boolean(m.place) });
  }

  function armGo(m) {
    if (goFor === m.n || m.phase !== 'race') return;
    const wait = m.go - now();
    if (wait <= 0 || typeof w.setTimeout !== 'function') return;
    goFor = m.n;
    if (goTimer !== null && typeof w.clearTimeout === 'function') w.clearTimeout(goTimer);
    goTimer = w.setTimeout(() => {
      goTimer = null;
      refresh();
      if (model && model.canType && typeof input.focus === 'function') input.focus();
      cue.play('turn');
    }, wait + 20);
  }

  function refresh() {
    if (typeof engine.snapshot === 'function') {
      const snap = engine.snapshot();
      if (snap) update(snap);
    }
  }

  function update(snap) {
    const m = typerace.model(snap);
    model = m;
    if (!m) return;
    if (local.n !== m.n) reset(m.n);
    const t = now();
    const early = m.phase === 'race' && t < m.go;
    armGo(m);
    paintHead(head, { kind: m.kind === 'words' ? '🔤 Word list' : '⌨️ Sentence', number: m.number, total: m.total, phase: m.phase, starts: m.starts, go: m.go, ends: m.ends, early });
    paintText();
    const open = m.canType && !local.done && !early;
    input.disabled = !open;
    input.classList.toggle('typerace-off', !m.canType && !local.done);
    paintRacers(racers, m.racers);
    paintFoot(foot, { text: footText(m, t) });
    foot.classList.toggle('is-good', m.phase === 'show' && m.myGain > 0);
    el.dataset.phase = m.phase;
    const { now: seen, cues: list } = typeraceMoment(heard, m);
    heard = seen;
    list.forEach((name, i) => cue.play(name, i ? { at: 240 } : undefined));
    if (m.place === 1 && cheered !== m.n) {
      cheered = m.n;
      cue.burst(prompt, { count: 16, emoji: ['⌨️', '🏁', '✨'] });
      if (fx && typeof fx.confetti === 'function') fx.confetti(30);
    }
  }

  return {
    el,
    update,
    destroy() {
      if (pump !== null && typeof w.clearInterval === 'function') w.clearInterval(pump);
      if (goTimer !== null && typeof w.clearTimeout === 'function') w.clearTimeout(goTimer);
      goTimer = null;
    },
  };
}
