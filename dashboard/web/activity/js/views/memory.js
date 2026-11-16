import memory, { PADS } from '../games/memory.js';
import { h, memo, timer, countdown, profileButton, plural } from '../ui/dom.js';

const QUIET = { play() {}, burst() {}, float() {} };
export const PAD_NAMES = Object.freeze(['Red', 'Blue', 'Yellow', 'Green']);
export const PAD_PITCH = Object.freeze([-17, -13, -10, -5]);
export const PAD_KEYS = Object.freeze({ 1: 0, 2: 1, 3: 2, 4: 3, q: 0, w: 1, a: 2, s: 3 });
const LIT_SHARE = 0.65;
const TAP_LIT_MS = 180;

export function footText(m) {
  if (m.phase === 'result') {
    if (m.myOut) return 'Out of lives! Stick around and cheer on the rest.';
    if (m.myLost) return `That cost you a life. ${plural(m.lives, 'life', 'lives')} left.`;
    if (m.myGain) return `Nailed it! +${m.myGain}`;
    return `${plural(m.alive, 'player', 'players')} still standing.`;
  }
  if (m.waiting) return 'You joined mid-round, so you play from the next chain.';
  if (m.watching) return "You're watching this one.";
  if (m.out) return 'Out of lives! Watch how long the chain gets.';
  if (m.phase === 'show') return `Watch closely. ${m.len} pads this time.`;
  if (m.sent) return m.right ? 'Locked in. Waiting for the others.' : 'Sent. Waiting for the others.';
  return `Your turn! Repeat all ${m.len} pads.`;
}

export function memoryMoment(was, m) {
  const now = { r: m.r, phase: m.phase };
  if (!was || was.r !== m.r) return { now, cues: [] };
  const cues = [];
  if (m.phase === 'input' && was.phase === 'show') cues.push('turn');
  if (m.phase === 'result' && was.phase !== 'result') {
    if (m.myOut) cues.push('lose');
    else if (m.myLost) cues.push('wrong');
    else if (m.myGain) cues.push('correct');
    else cues.push('reveal');
  }
  return { now, cues };
}

export function litAt(m, t) {
  if (!m || m.phase !== 'show' || !Array.isArray(m.seq) || !(m.step > 0)) return null;
  const at = t - m.starts;
  if (at < 0) return null;
  const i = Math.floor(at / m.step);
  if (i >= m.seq.length) return null;
  return at - i * m.step < m.step * LIT_SHARE ? { i, pad: m.seq[i] } : null;
}

function hearts(lives, max) {
  const list = [];
  for (let i = 0; i < max; i += 1) list.push(h('span', { class: ['memory-heart', i < lives ? 'is-full' : 'is-lost'], text: i < lives ? '❤️' : '🤍', attrs: { 'aria-hidden': 'true' } }));
  return h('span', { class: 'memory-hearts', attrs: { role: 'img', 'aria-label': `${plural(lives, 'life', 'lives')} left` } }, list);
}

export function createMemoryView({ engine, fx, win, cues }) {
  const cue = cues && typeof cues.play === 'function' ? cues : QUIET;
  const w = win || globalThis;
  const el = h('section', { class: 'game game-memory', attrs: { 'aria-label': 'Memory Chain' } });
  const head = h('div', { class: 'memory-headwrap' });
  const pads = [];
  for (let p = 0; p < PADS; p += 1) {
    pads.push(
      h('button', {
        class: ['memory-pad', 'spot', `memory-pad-${p}`],
        type: 'button',
        dataset: { key: `pad-${p}` },
        disabled: true,
        attrs: { 'aria-label': `${PAD_NAMES[p]} pad` },
        on: { click: () => tap(p) },
      }),
    );
  }
  const board = h('div', { class: 'memory-board', attrs: { role: 'group', 'aria-label': 'Pads' } }, pads);
  const dots = h('div', { class: 'memory-dots-wrap' });
  const people = h('div', { class: 'memory-people-wrap' });
  const foot = h('div', { class: 'game-foot', attrs: { role: 'status', 'aria-live': 'polite' } });
  el.append(head, board, dots, people, foot);
  const local = { r: null, taps: [], sent: false };
  let model = null;
  let heard = null;
  let shownFor = null;
  let cheered = null;
  let timers = [];

  function now() {
    return typeof engine.now === 'function' ? engine.now() : Date.now();
  }

  function later(fn, ms) {
    if (typeof w.setTimeout !== 'function') return;
    const id = w.setTimeout(() => {
      timers = timers.filter((x) => x !== id);
      fn();
    }, Math.max(0, ms));
    timers.push(id);
  }

  function clearAll() {
    if (typeof w.clearTimeout === 'function') for (const id of timers) w.clearTimeout(id);
    timers = [];
    for (const pad of pads) pad.classList.remove('is-lit');
  }

  function flash(p, ms) {
    const pad = pads[p];
    if (!pad) return;
    pad.classList.add('is-lit');
    cue.play('tick', { pitch: PAD_PITCH[p], volume: 0.9 });
    later(() => pad.classList.remove('is-lit'), ms);
  }

  function playShow(m) {
    if (shownFor === m.r) return;
    shownFor = m.r;
    clearAll();
    const t = now();
    m.seq.forEach((p, i) => {
      const at = m.starts + i * m.step - t;
      if (at + m.step * LIT_SHARE < 0) return;
      later(() => flash(p, Math.round(m.step * LIT_SHARE)), at);
    });
  }

  function send() {
    const m = model;
    if (!m || local.sent || local.r !== m.r) return;
    local.sent = true;
    engine.act({ type: 'try', r: m.r, s: local.taps.join('') });
    paintDots(dots, { len: m.len, taps: local.taps.length, phase: m.phase, sent: true });
  }

  function tap(p) {
    const m = model;
    if (!m || !m.canPlay || local.sent || local.r !== m.r) return;
    if (!Number.isInteger(p) || p < 0 || p >= PADS) return;
    flash(p, TAP_LIT_MS);
    local.taps.push(p);
    const i = local.taps.length - 1;
    const wrong = Array.isArray(m.seq) && m.seq[i] !== p;
    if (wrong) {
      pads[p].classList.add('fx-wrong');
      later(() => pads[p].classList.remove('fx-wrong'), 420);
    }
    paintDots(dots, { len: m.len, taps: local.taps.length, phase: m.phase, sent: false });
    if (wrong || local.taps.length >= m.len) send();
  }

  function onKeys(e) {
    if (!e || e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = e.target && e.target.tagName ? String(e.target.tagName).toLowerCase() : '';
    if (tag === 'input' || tag === 'textarea' || (e.target && e.target.isContentEditable)) return;
    const k = String(e.key || '').toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(PAD_KEYS, k) || !model || !model.canPlay) return;
    if (typeof e.preventDefault === 'function') e.preventDefault();
    tap(PAD_KEYS[k]);
  }
  if (typeof w.addEventListener === 'function') w.addEventListener('keydown', onKeys);

  const paintHead = memo((m) =>
    h(
      'div',
      { class: 'game-head' },
      h('span', { class: 'chip chip-static', text: `🔗 Chain of ${m.len}` }),
      m.playing ? hearts(m.lives, m.max) : h('span', { class: 'game-count', text: `${plural(m.alive, 'player', 'players')} left` }),
      m.phase === 'input' ? timer(m.starts, m.ends, 'Time left to repeat the chain') : m.phase === 'show' ? countdown(m.starts, m.ends, { lead: 'Watching', label: 'Time until your turn' }) : timer(m.starts, m.ends, 'Next chain in'),
    ),
  );

  const paintDots = memo((d) => {
    const list = [];
    for (let i = 0; i < d.len; i += 1) list.push(h('span', { class: ['memory-dot', i < d.taps ? 'is-on' : null] }));
    return h('div', { class: ['memory-dots', d.sent ? 'is-sent' : null], attrs: { role: 'img', 'aria-label': `${d.taps} of ${d.len} pads entered` } }, list);
  });

  const paintPeople = memo((list) => {
    if (!list.length) return null;
    return h(
      'ul',
      { class: 'memory-people', attrs: { 'aria-label': 'Players' } },
      list.map((p) =>
        h(
          'li',
          { class: ['memory-person', p.face.isMe ? 'is-me' : null, p.out ? 'is-out' : null, `is-${p.state}`, p.lost ? 'is-hurt' : null] },
          profileButton(p.face, 'sm'),
          h('span', { class: 'memory-name', text: p.face.isMe ? 'You' : p.face.name }),
          h('span', { class: 'memory-lives', text: p.out ? '💀' : '❤️'.repeat(Math.min(p.lives, 5)), attrs: { 'aria-label': p.out ? 'Out' : plural(p.lives, 'life', 'lives') } }),
          h('span', { class: 'memory-mark', text: p.state === 'ok' ? '✅' : p.state === 'miss' ? '❌' : p.state === 'in' ? '📨' : '', attrs: { 'aria-hidden': 'true' } }),
          p.gain ? h('span', { class: 'memory-gain', text: `+${p.gain}` }) : null,
        ),
      ),
    );
  });

  const paintFoot = memo((m) => h('span', { class: 'foot-text', text: m.text }));

  function update(snap) {
    const m = memory.model(snap);
    model = m;
    if (!m) return;
    if (local.r !== m.r) {
      local.r = m.r;
      local.taps = [];
      local.sent = false;
    }
    if (m.phase === 'show') playShow(m);
    paintHead(head, { len: m.len, playing: !m.watching && !m.waiting, lives: m.lives, max: m.maxLives, alive: m.alive, phase: m.phase, starts: m.starts, ends: m.ends });
    for (const pad of pads) pad.disabled = !m.canPlay || local.sent;
    board.classList.toggle('is-turn', m.canPlay && !local.sent);
    board.classList.toggle('is-show', m.phase === 'show');
    board.classList.toggle('is-gone', m.out);
    paintDots(dots, { len: m.len, taps: m.phase === 'input' ? local.taps.length : 0, phase: m.phase, sent: m.sent || local.sent });
    paintPeople(people, m.players);
    paintFoot(foot, { text: footText(m) });
    foot.classList.toggle('is-good', m.phase === 'result' && m.myGain > 0);
    el.dataset.phase = m.phase;
    const { now: seen, cues: list } = memoryMoment(heard, m);
    heard = seen;
    list.forEach((name, i) => cue.play(name, i ? { at: 240 } : undefined));
    if (m.phase === 'result' && m.myGain && cheered !== m.r) {
      cheered = m.r;
      cue.float(board, `+${m.myGain}`);
      if (m.alive === 1 && m.players.length > 1 && fx && typeof fx.confetti === 'function') fx.confetti(30);
    }
  }

  return {
    el,
    update,
    destroy() {
      clearAll();
      if (typeof w.removeEventListener === 'function') w.removeEventListener('keydown', onKeys);
    },
  };
}
