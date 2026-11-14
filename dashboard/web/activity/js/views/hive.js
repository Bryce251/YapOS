import hive, { checkWord, cleanWord, problemText, wordPoints, isPangram, knownWord, warm, veil, rankOf, MAX_LETTERS, REVEAL_MS } from '../games/hive.js';
import { h, memo, timer, avatar, button, plural } from '../ui/dom.js';

const QUIET = { play() {}, burst() {}, float() {} };
const SVG_NS = 'http://www.w3.org/2000/svg';

export const HIVE_GAP = 1.08;
export const ENTER_R = 0.3;
export const LEAVE_R = 0.52;
export const PRESS_R = 0.5;
export const HOLD_MS = 450;
export const HOLD_JITTER = 0.12;
export const TRACE_STEP = 0.08;
export const MSG_MS = 2200;
export const FADE_MS = 400;
export const OPT_MS = 8000;
export const COMB_W = 2.5 * HIVE_GAP;
export const COMB_H = 0.866 * 3 * HIVE_GAP;

export const SPOTS = Object.freeze({
  c: Object.freeze({ x: 0, y: 0 }),
  0: Object.freeze({ x: 0, y: -0.866 * HIVE_GAP }),
  1: Object.freeze({ x: 0.75 * HIVE_GAP, y: -0.433 * HIVE_GAP }),
  2: Object.freeze({ x: 0.75 * HIVE_GAP, y: 0.433 * HIVE_GAP }),
  3: Object.freeze({ x: 0, y: 0.866 * HIVE_GAP }),
  4: Object.freeze({ x: -0.75 * HIVE_GAP, y: 0.433 * HIVE_GAP }),
  5: Object.freeze({ x: -0.75 * HIVE_GAP, y: -0.433 * HIVE_GAP }),
});

const SPOT_IDS = Object.freeze(Object.keys(SPOTS));

export function nearestSpot(x, y) {
  let id = null;
  let d = Infinity;
  for (const k of SPOT_IDS) {
    const s = SPOTS[k];
    const e = Math.hypot(x - s.x, y - s.y);
    if (e < d) {
      d = e;
      id = k;
    }
  }
  return { id, d };
}

export function toCell(rect, clientX, clientY) {
  if (!rect || !(rect.width > 0) || !Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;
  const size = rect.width / COMB_W;
  return { x: (clientX - (rect.left + rect.width / 2)) / size, y: (clientY - (rect.top + rect.height / 2)) / size };
}

export function createTrace(opts = {}) {
  const holdMs = opts.holdMs ?? HOLD_MS;
  const max = Math.max(1, opts.max ?? MAX_LETTERS);
  let path = [];
  let away = false;
  let undone = null;
  let anchor = null;
  let held = false;
  let at = null;

  const head = () => (path.length ? path[path.length - 1] : null);

  function settle(p, t) {
    away = false;
    held = false;
    anchor = p ? { x: p.x, y: p.y, t } : null;
  }

  function stepTo(q, t) {
    const hid = head();
    const hs = SPOTS[hid];
    const dh = Math.hypot(q.x - hs.x, q.y - hs.y);
    if (dh > LEAVE_R) {
      away = true;
      anchor = null;
    }
    const near = nearestSpot(q.x, q.y);
    if (near.d > ENTER_R) {
      anchor = null;
      return null;
    }
    if (near.id === hid) {
      if (away) {
        if (path.length >= max) return null;
        path.push(hid);
        undone = null;
        settle(q, t);
        return 'add';
      }
      if (!anchor || Math.hypot(q.x - anchor.x, q.y - anchor.y) > HOLD_JITTER) {
        anchor = { x: q.x, y: q.y, t };
        held = false;
      }
      return null;
    }
    if (path.length >= 2 && path[path.length - 2] === near.id) {
      undone = path.pop();
      settle(q, t);
      return 'undo';
    }
    if (path.length >= max) return null;
    path.push(near.id);
    undone = null;
    settle(q, t);
    return 'add';
  }

  return {
    get path() {
      return path.slice();
    },
    get size() {
      return path.length;
    },
    get point() {
      return at ? { x: at.x, y: at.y } : null;
    },
    get anchorAt() {
      return anchor && !held ? anchor.t : null;
    },
    begin(id, p, t) {
      if (!SPOTS[id]) return null;
      path = [id];
      undone = null;
      at = p ? { x: p.x, y: p.y } : { x: SPOTS[id].x, y: SPOTS[id].y };
      settle(at, t);
      return 'add';
    },
    move(p, t) {
      if (!path.length || !p) return null;
      const from = at || p;
      const dist = Math.hypot(p.x - from.x, p.y - from.y);
      const n = Math.max(1, Math.ceil(dist / TRACE_STEP));
      let out = null;
      for (let i = 1; i <= n; i += 1) {
        const r = stepTo({ x: from.x + ((p.x - from.x) * i) / n, y: from.y + ((p.y - from.y) * i) / n }, t);
        if (r) out = r;
      }
      at = { x: p.x, y: p.y };
      return out;
    },
    holdLeft(t) {
      if (held || !anchor || !path.length) return null;
      return Math.max(0, holdMs - (t - anchor.t));
    },
    tick(t) {
      if (held || !anchor || !path.length || t - anchor.t < holdMs) return null;
      held = true;
      const hid = head();
      if (undone !== null) {
        if (path.length + 2 > max) return null;
        path.push(undone, hid);
        undone = null;
        return 'add';
      }
      if (path.length >= max) return null;
      path.push(hid);
      return 'add';
    },
  };
}

export function shuffled(list, random = Math.random) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function footText(m) {
  if (m.phase === 'load') return 'Gathering letters for the hive…';
  if (m.phase === 'fail') return "The word list didn't load, so Letter Hive can't run this time. Try again in a moment or pick another game.";
  if (m.phase === 'reveal') {
    if (m.reveal && m.reveal.lost) return 'The host changed, so the word lists were lost. Scores still count!';
    return 'Time’s up! Here’s what everyone found.';
  }
  if (!m.playing) return "You're watching. Join the next game to play along.";
  return `Make words with ${m.centre.toUpperCase()} in them. Drag across the letters and let go to send. Drag back to undo, hold a letter to use it again.`;
}

export function hiveMoments(was, m) {
  const now = { id: m.id, phase: m.phase, last: m.last ? m.last.n : 0 };
  if (!was) return { now, cues: [] };
  const cues = [];
  if (m.phase === 'reveal' && was.phase !== 'reveal') cues.push('reveal');
  if (m.phase === 'play' && was.phase === 'play' && was.id === m.id && now.last > was.last && m.last && !m.last.isMe) cues.push('pop');
  if (m.phase === 'play' && was.phase === 'load') cues.push('turn');
  return { now, cues };
}

export function withPending(m, extra) {
  if (!m || !extra || !extra.n || !m.playing) return m;
  const me = { pts: m.me.pts + extra.pts, count: m.me.count + extra.n, pangrams: m.me.pangrams + extra.pg };
  const board = m.board
    .map((p) => (p.isMe ? { ...p, pts: p.pts + extra.pts, count: p.count + extra.n, pangrams: p.pangrams + extra.pg } : p))
    .sort((x, y) => y.pts - x.pts || y.count - x.count || x.slot - y.slot);
  return { ...m, me, board, rank: rankOf(me.pts, m.max) };
}

function wordChip(x, extra) {
  return h(
    'li',
    { class: ['hive-word', x.pangram ? 'is-pangram' : null, x.only ? 'is-only' : null, extra || null], attrs: { title: x.pangram ? `Pangram! ${x.pts} points` : `${x.pts} ${x.pts === 1 ? 'point' : 'points'}` } },
    x.pangram ? h('span', { class: 'hive-star', text: '🌟', attrs: { 'aria-hidden': 'true' } }) : null,
    h('span', { class: 'hive-word-text', text: x.w }),
    h('span', { class: 'hive-word-pts', text: `+${x.pts}` }),
  );
}

function svgEl(tag, cls) {
  const el = document.createElementNS(SVG_NS, tag);
  if (cls) el.setAttribute('class', cls);
  return el;
}

function trailSvg() {
  const svg = svgEl('svg', 'hive-trail');
  svg.setAttribute('viewBox', `${(-COMB_W / 2).toFixed(3)} ${(-COMB_H / 2).toFixed(3)} ${COMB_W.toFixed(3)} ${COMB_H.toFixed(3)}`);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.append(svgEl('polyline', 'hive-trail-line'), svgEl('line', 'hive-trail-tail'));
  return svg;
}

function defaultClock() {
  const now = () => (typeof performance !== 'undefined' && performance && typeof performance.now === 'function' ? performance.now() : Date.now());
  return { now, setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id) };
}

export function createHiveView({ engine, fx, cues, timers }) {
  const cue = cues && typeof cues.play === 'function' ? cues : QUIET;
  const clock = timers && typeof timers.setTimeout === 'function' && typeof timers.clearTimeout === 'function' && typeof timers.now === 'function' ? timers : defaultClock();
  const el = h('section', { class: 'game game-hive', attrs: { 'aria-label': 'Letter Hive' } });
  const head = h('div', { class: 'hive-headwrap' });
  const rank = h('div', { class: 'hive-rankwrap' });
  const comb = h('div', { class: 'hive-combwrap' });
  const input = h('input', {
    class: 'word-input hive-input',
    dataset: { key: 'hive-input' },
    attrs: { type: 'text', maxlength: MAX_LETTERS, autocomplete: 'off', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'send', 'aria-label': 'Your word', placeholder: 'Drag, tap or type a word' },
  });
  const delBtn = button('Delete', { variant: 'ghost', key: 'hive-delete', on: () => backspace() });
  const mixBtn = button('Shuffle', { variant: 'ghost', key: 'hive-shuffle', on: () => mix() });
  const sendBtn = button('Enter', { variant: 'primary', key: 'hive-enter', on: () => submit() });
  const hint = h('p', { class: 'entry-hint hive-hint', attrs: { role: 'status', 'aria-live': 'polite' } });
  const entry = h('div', { class: 'hive-entry' }, input, h('div', { class: 'hive-controls' }, delBtn, mixBtn, sendBtn), hint);
  const found = h('div', { class: 'hive-foundwrap' });
  const board = h('div', { class: 'hive-boardwrap' });
  const results = h('div', { class: 'hive-revealwrap' });
  const foot = h('div', { class: 'game-foot', attrs: { role: 'status', 'aria-live': 'polite' } });
  el.append(head, rank, comb, entry, found, board, results, foot);

  const local = { id: null, order: [], found: [], pending: new Map(), seen: new Set(), opt: new Map(), maxQ: -1, q: Math.floor(Math.random() * 1e6) };
  const drag = { on: false, pointer: null, base: '', trace: null, claimed: false, timer: null, box: null, holdKey: null };
  const msg = { show: null, fade: null };
  warm();
  let model = null;
  let heard = null;

  function stopMsg() {
    if (msg.show !== null) clock.clearTimeout(msg.show);
    if (msg.fade !== null) clock.clearTimeout(msg.fade);
    msg.show = null;
    msg.fade = null;
  }

  function say(text, tone) {
    stopMsg();
    hint.classList.remove('is-good', 'is-bad', 'is-fading');
    hint.textContent = text || '';
    if (!text) return;
    if (tone === 'good') hint.classList.add('is-good');
    if (tone === 'bad') hint.classList.add('is-bad');
    msg.show = clock.setTimeout(() => {
      msg.show = null;
      hint.classList.add('is-fading');
      msg.fade = clock.setTimeout(() => {
        msg.fade = null;
        hint.textContent = '';
        hint.classList.remove('is-good', 'is-bad', 'is-fading');
      }, FADE_MS);
    }, MSG_MS);
  }

  function refuse(text) {
    say(text, 'bad');
    cue.play('error');
    input.classList.remove('is-refused');
    void input.offsetWidth;
    input.classList.add('is-refused');
  }

  const keep = (e) => e.preventDefault();
  for (const b of [delBtn, mixBtn, sendBtn]) b.addEventListener('mousedown', keep);
  el.addEventListener('keydown', (e) => {
    if (e.target === input || e.ctrlKey || e.metaKey || e.altKey || !model || !model.canPlay) return;
    const key = String(e.key || '');
    if (key === 'Enter') {
      e.preventDefault();
      submit();
    } else if (key === 'Backspace' || key === 'Delete') {
      e.preventDefault();
      backspace();
    } else if (/^[a-zA-Z]$/.test(key)) {
      e.preventDefault();
      type(key.toLowerCase());
    }
  });
  input.addEventListener('animationend', () => input.classList.remove('is-refused'));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
  });
  input.addEventListener('input', () => {
    const clean = String(input.value || '').toLowerCase().replace(/[^a-z]/g, '').slice(0, MAX_LETTERS);
    if (clean !== input.value) input.value = clean;
    input.classList.remove('is-refused');
    say(null);
  });

  function type(letter) {
    if (!model || !model.canPlay || drag.on) return;
    if (String(input.value || '').length >= MAX_LETTERS) return;
    input.value = `${input.value || ''}${letter}`;
    say(null);
    cue.play('type');
  }

  function backspace() {
    if (!model || !model.canPlay || !input.value || drag.on) return;
    input.value = input.value.slice(0, -1);
    say(null);
    cue.play('tap');
  }

  function mix() {
    if (!model || !model.outer.length || drag.on) return;
    let next = shuffled(local.order);
    for (let i = 0; i < 4 && next.join('') === local.order.join(''); i += 1) next = shuffled(local.order);
    local.order = next;
    cue.play('whoosh');
    paintComb(comb, combModel(model));
  }

  function letterAt(id) {
    if (!model) return '';
    if (id === 'c') return model.centre;
    return local.order[Number(id)] || '';
  }

  function pointOf(e) {
    const box = comb.querySelector('.hive-comb');
    if (!box || typeof box.getBoundingClientRect !== 'function') return null;
    return toCell(box.getBoundingClientRect(), e.clientX, e.clientY);
  }

  function traced() {
    return drag.trace ? drag.trace.path.map(letterAt).join('') : '';
  }

  function drawTrace() {
    const box = comb.querySelector('.hive-comb');
    if (!box) return;
    const path = drag.on && drag.trace ? drag.trace.path : [];
    const uses = new Map();
    for (const id of path) uses.set(id, (uses.get(id) || 0) + 1);
    const last = path.length ? path[path.length - 1] : null;
    const holdAt = drag.on && drag.trace ? drag.trace.anchorAt : null;
    for (const cellEl of box.querySelectorAll('.hive-cell')) {
      const id = cellEl.dataset.spot;
      const n = uses.get(id) || 0;
      cellEl.classList.toggle('is-lit', n > 0);
      cellEl.classList.toggle('is-head', id === last);
      if (n > 1) cellEl.dataset.uses = String(n);
      else delete cellEl.dataset.uses;
      const holding = id === last && holdAt !== null;
      if (holding && drag.holdKey !== holdAt) {
        cellEl.classList.remove('is-holding');
        void cellEl.offsetWidth;
      }
      cellEl.classList.toggle('is-holding', holding);
    }
    drag.holdKey = holdAt;
    box.classList.toggle('is-tracing', path.length > 0);
    const line = box.querySelector('.hive-trail-line');
    const tail = box.querySelector('.hive-trail-tail');
    if (line) line.setAttribute('points', path.map((id) => `${SPOTS[id].x.toFixed(3)},${SPOTS[id].y.toFixed(3)}`).join(' '));
    if (tail) {
      const p = drag.on && drag.trace ? drag.trace.point : null;
      const s = last !== null ? SPOTS[last] : null;
      const show = Boolean(p && s);
      tail.setAttribute('x1', show ? s.x.toFixed(3) : '0');
      tail.setAttribute('y1', show ? s.y.toFixed(3) : '0');
      tail.setAttribute('x2', show ? p.x.toFixed(3) : '0');
      tail.setAttribute('y2', show ? p.y.toFixed(3) : '0');
    }
  }

  function armHold() {
    if (drag.timer !== null || !drag.on || !drag.trace) return;
    const left = drag.trace.holdLeft(clock.now());
    if (left === null) return;
    drag.timer = clock.setTimeout(() => {
      drag.timer = null;
      if (!drag.on || !drag.trace) return;
      const r = drag.trace.tick(clock.now());
      if (r) applyTrace(r);
      else {
        drawTrace();
        armHold();
      }
    }, Math.max(10, left));
  }

  function applyTrace(kind) {
    input.value = `${drag.base}${traced()}`.slice(0, MAX_LETTERS);
    input.classList.remove('is-refused');
    if (kind === 'add') cue.play('type');
    else if (kind === 'undo') cue.play('tap');
    if (hint.textContent) say(null);
    drawTrace();
    armHold();
  }

  function endDrag() {
    if (drag.timer !== null) clock.clearTimeout(drag.timer);
    drag.timer = null;
    const pointer = drag.pointer;
    drag.on = false;
    drag.pointer = null;
    if (pointer !== null && typeof comb.releasePointerCapture === 'function') {
      try {
        if (typeof comb.hasPointerCapture !== 'function' || comb.hasPointerCapture(pointer)) comb.releasePointerCapture(pointer);
      } catch {
        drag.pointer = null;
      }
    }
    input.classList.remove('is-tracing');
    drawTrace();
    drag.trace = null;
  }

  function cancelDrag() {
    if (!drag.on) return;
    input.value = drag.base;
    endDrag();
  }

  function onDown(e) {
    if (drag.on) {
      const stale = (drag.pointer !== null && e.pointerId === drag.pointer) || e.pointerType === 'mouse';
      if (!stale) return;
      cancelDrag();
    }
    drag.claimed = false;
    if (!model || !model.canPlay) return;
    if (e.pointerType === 'mouse' && e.button !== undefined && e.button !== 0) return;
    const p = pointOf(e);
    if (!p) return;
    const near = nearestSpot(p.x, p.y);
    if (near.d > PRESS_R) return;
    const base = String(input.value || '');
    if (base.length >= MAX_LETTERS) return;
    if (typeof e.preventDefault === 'function') e.preventDefault();
    drag.claimed = true;
    drag.on = true;
    drag.pointer = e.pointerId ?? null;
    drag.base = base;
    drag.trace = createTrace({ max: MAX_LETTERS - base.length });
    drag.trace.begin(near.id, p, clock.now());
    if (drag.pointer !== null && typeof comb.setPointerCapture === 'function') {
      try {
        comb.setPointerCapture(drag.pointer);
      } catch {
        drag.claimed = true;
      }
    }
    input.classList.add('is-tracing');
    applyTrace('add');
  }

  function mine(e) {
    return drag.on && (drag.pointer === null || e.pointerId === undefined || e.pointerId === drag.pointer);
  }

  function samples(e) {
    if (typeof e.getCoalescedEvents !== 'function') return [e];
    let list = null;
    try {
      list = e.getCoalescedEvents();
    } catch {
      list = null;
    }
    return list && list.length ? list : [e];
  }

  function onMove(e) {
    if (!mine(e)) return;
    if (e.pointerType === 'mouse' && e.buttons === 0) {
      onUp(e);
      return;
    }
    if (typeof e.preventDefault === 'function') e.preventDefault();
    let r = null;
    for (const one of samples(e)) {
      const p = pointOf(one);
      if (!p || !drag.trace) continue;
      const step = drag.trace.move(p, clock.now());
      if (step) r = step;
    }
    if (!drag.trace) return;
    if (r) applyTrace(r);
    else {
      drawTrace();
      armHold();
    }
  }

  function onUp(e) {
    if (!mine(e)) return;
    if (typeof e.preventDefault === 'function') e.preventDefault();
    const size = drag.trace.size;
    endDrag();
    if (size >= 2) submit({ drag: true });
  }

  comb.addEventListener('pointerdown', onDown);
  comb.addEventListener('pointermove', onMove);
  comb.addEventListener('pointerup', onUp);
  comb.addEventListener('pointercancel', (e) => {
    if (mine(e)) cancelDrag();
  });
  comb.addEventListener('lostpointercapture', (e) => {
    if (e.target === comb && mine(e)) cancelDrag();
  });
  comb.addEventListener('dragstart', keep);

  function pendingExtra() {
    let pts = 0;
    let n = 0;
    let pg = 0;
    for (const o of local.opt.values()) {
      pts += o.pts;
      n += 1;
      if (o.pangram) pg += 1;
    }
    return { pts, n, pg };
  }

  function submit(opts = {}) {
    if (!model || !model.canPlay) return;
    const fromDrag = Boolean(opts.drag);
    if (drag.on && !fromDrag) return;
    const word = cleanWord(input.value);
    const puzzle = { letters: model.letters, centre: model.centre };
    const problem = checkWord(word, puzzle, local.found);
    if (problem) {
      refuse(problemText(problem, model.centre));
      if (fromDrag) input.value = '';
      return;
    }
    local.q += 1;
    local.pending.set(local.q, word);
    const sure = knownWord(word, model.letters, model.centre) === true;
    const pts = wordPoints(word, model.letters);
    const pangram = isPangram(word, model.letters);
    if (sure) {
      local.found.push(word);
      local.opt.set(local.q, { pts, pangram, at: clock.now() });
    }
    engine.act({ type: 'word', x: veil(word, model.id), q: local.q, id: model.id });
    input.value = '';
    cue.play('send');
    if (sure) celebrate(word, pts, pangram);
    else say('Checking…');
    render();
  }

  function celebrate(word, pts, pangram) {
    say(pangram ? `Pangram! +${pts}` : `${pts >= 7 ? 'Amazing!' : pts >= 5 ? 'Nice!' : 'Good!'} +${pts}`, 'good');
    const mid = comb.querySelector('.hive-cell.is-centre');
    if (mid) {
      cue.float(mid, `+${pts}`);
      if (pangram) cue.burst(mid, { count: 18, emoji: ['🐝', '🌟', '🍯'] });
    }
    if (pangram) {
      cue.play('correct', { at: 140 });
      if (fx && typeof fx.confetti === 'function') fx.confetti(30);
    }
  }

  function settle(m) {
    for (const r of m.results) {
      if (r.q > local.maxQ) local.maxQ = r.q;
      local.opt.delete(r.q);
      if (!local.pending.has(r.q) || local.seen.has(r.q)) continue;
      local.seen.add(r.q);
      const word = local.pending.get(r.q);
      local.pending.delete(r.q);
      const had = local.found.includes(word);
      if (r.code === 'ok') {
        if (!had) {
          local.found.push(word);
          celebrate(word, r.pts, isPangram(word, m.letters));
        }
      } else {
        if (had && r.code !== 'found') local.found = local.found.filter((w) => w !== word);
        if (r.code === 'found' && !had) local.found.push(word);
        refuse(problemText(r.code, m.centre));
      }
    }
    const at = clock.now();
    for (const [q, o] of [...local.opt]) if (q <= local.maxQ || at - o.at > OPT_MS || m.phase !== 'play') local.opt.delete(q);
  }

  function combModel(m) {
    return { letters: m.letters, centre: m.centre, order: local.order.slice(), can: m.canPlay };
  }

  function cell(letter, i, centre, can) {
    const spot = centre ? 'c' : String(i);
    return h(
      'button',
      {
        class: ['hive-cell', centre ? 'is-centre' : `hive-cell-${i}`],
        type: 'button',
        disabled: !can,
        dataset: { key: centre ? 'hive-centre' : `hive-cell-${i}`, letter, spot },
        attrs: { 'aria-label': centre ? `${letter.toUpperCase()}, the middle letter` : letter.toUpperCase(), draggable: 'false' },
        on: {
          click: (e) => {
            if (e && e.detail > 0 && drag.claimed) {
              drag.claimed = false;
              return;
            }
            type(letter);
          },
          mousedown: (e) => e.preventDefault(),
        },
      },
      h('span', { class: 'hive-cell-letter', text: letter.toUpperCase() }),
    );
  }

  const paintHead = memo((m) =>
    h(
      'div',
      { class: 'game-head' },
      h('span', { class: 'chip chip-static', text: `${plural(m.total, 'word', 'words')} to find` }),
      m.pg ? h('span', { class: 'chip chip-static hive-pg', text: plural(m.pg, 'pangram', 'pangrams') }) : null,
      m.phase === 'play' || m.phase === 'reveal' ? timer(m.phase === 'reveal' ? m.ends - REVEAL_MS : m.starts, m.ends, m.phase === 'reveal' ? 'Results in' : 'Time left') : null,
    ),
  );

  const paintRank = memo((m) => {
    if (m.phase !== 'play' || !m.playing) return null;
    return h(
      'div',
      { class: 'hive-rank' },
      h(
        'div',
        { class: 'hive-rank-top' },
        h('strong', { class: 'hive-rank-name', text: m.rank.name }),
        h('span', { class: 'hive-rank-score', text: `${plural(m.me.pts, 'point', 'points')} · ${plural(m.me.count, 'word', 'words')}` }),
      ),
      h('div', { class: 'hive-rank-track', attrs: { role: 'img', 'aria-label': `${m.rank.name}, ${m.rank.pct}% of the way to the top rank` } }, h('span', { class: 'hive-rank-fill', vars: { '--pct': m.rank.pct } })),
      m.rank.next ? h('span', { class: 'hive-rank-next muted', text: `${plural(m.rank.need, 'point', 'points')} to ${m.rank.next}` }) : h('span', { class: 'hive-rank-next', text: 'Top rank! 👑' }),
    );
  });

  const paintComb = memo((c) => {
    if (!c.letters) return null;
    return h(
      'div',
      { class: ['hive-comb', c.can ? 'is-live' : null], attrs: { role: 'group', 'aria-label': 'Letters. Drag across them to spell a word, or tap them one at a time.' } },
      c.order.map((l, i) => cell(l, i, false, c.can)),
      cell(c.centre, 0, true, c.can),
      trailSvg(),
    );
  });

  function foundModel() {
    if (!model || model.phase !== 'play' || !model.playing) return null;
    return { words: local.found.slice().sort(), letters: model.letters, latest: local.found[local.found.length - 1] || null };
  }

  const paintFound = memo((f) => {
    if (!f) return null;
    return h(
      'div',
      { class: 'hive-found' },
      h('span', { class: 'eyebrow', text: f.words.length ? `You found ${plural(f.words.length, 'word', 'words')}` : 'Your words show up here' }),
      f.words.length
        ? h(
            'ul',
            { class: 'hive-words', attrs: { 'aria-label': 'Words you found' } },
            f.words.map((w) => wordChip({ w, pts: wordPoints(w, f.letters), pangram: isPangram(w, f.letters) }, w === f.latest ? 'is-new' : null)),
          )
        : h('p', { class: 'muted hive-empty', text: 'Only you can see your words until time runs out.' }),
    );
  });

  const paintBoard = memo((m) => {
    if (m.phase !== 'play' || !m.board.length) return null;
    return h(
      'ol',
      { class: 'hive-board', attrs: { 'aria-label': 'Scores' } },
      m.board.map((p, i) =>
        h(
          'li',
          { class: ['hive-player', p.isMe ? 'is-me' : null, p.present ? null : 'is-away', i === 0 && p.pts > 0 ? 'is-top' : null] },
          avatar(p, 'sm'),
          h('span', { class: 'hive-player-name', text: p.isMe ? `${p.name} (you)` : p.name }),
          p.pangrams ? h('span', { class: 'hive-star', text: '🌟', attrs: { title: 'Found a pangram', 'aria-label': 'Found a pangram' } }) : null,
          h('span', { class: 'hive-player-stat', text: `${plural(p.count, 'word', 'words')} · ${p.pts}` }),
        ),
      ),
    );
  });

  const paintReveal = memo((m) => {
    if (m.phase !== 'reveal' || !m.reveal) return null;
    const r = m.reveal;
    const pangramLine = r.pangramBy.length
      ? `Pangram found by ${r.pangramBy.map((p) => (p.isMe ? 'you' : p.name)).join(', ')}!`
      : r.lost
      ? null
      : 'Nobody found a pangram this time.';
    return h(
      'div',
      { class: 'hive-reveal' },
      h(
        'div',
        { class: 'hive-letters', attrs: { 'aria-label': `The letters were ${m.letters.toUpperCase().split('').join(' ')}` } },
        m.letters.split('').map((l) => h('span', { class: ['hive-tile', l === m.centre ? 'is-centre' : null], text: l.toUpperCase() })),
      ),
      pangramLine ? h('p', { class: 'hive-pangram-line', text: pangramLine }) : null,
      r.players.length
        ? h(
            'ol',
            { class: 'hive-cards' },
            r.players.map((p) =>
              h(
                'li',
                { class: ['hive-card', p.isMe ? 'is-me' : null] },
                h(
                  'div',
                  { class: 'hive-card-head' },
                  avatar(p, 'sm'),
                  h('strong', { class: 'hive-card-name', text: p.isMe ? `${p.name} (you)` : p.name }),
                  h('span', { class: 'hive-card-score', text: `${plural(p.count, 'word', 'words')} · ${plural(p.pts, 'point', 'points')}` }),
                ),
                p.words.length ? h('ul', { class: 'hive-words' }, p.words.map((x) => wordChip(x))) : h('p', { class: 'muted hive-empty', text: 'No words this time.' }),
                p.more ? h('p', { class: 'muted hive-more', text: `and ${p.more} more` }) : null,
              ),
            ),
          )
        : null,
      r.missed.length
        ? h(
            'div',
            { class: 'hive-missed' },
            h('span', { class: 'eyebrow', text: r.lost ? 'Some great words in this hive' : 'Best words nobody found' }),
            h('ul', { class: 'hive-words' }, r.missed.map((x) => wordChip(x, 'is-missed'))),
            r.missedCount > r.missed.length ? h('p', { class: 'muted hive-more', text: `and ${r.missedCount - r.missed.length} more` }) : null,
          )
        : !r.lost
        ? h('p', { class: 'hive-pangram-line', text: 'Every word in the hive was found. Amazing teamwork!' })
        : null,
      r.players.some((p) => p.words.some((x) => x.only)) ? h('p', { class: 'muted hive-key', text: 'Highlighted words were found by just one player.' }) : null,
    );
  });

  const paintFoot = memo((m) => h('span', { class: 'foot-text', text: footText(m) }));

  function render() {
    const m = model;
    if (!m) return;
    const v = withPending(m, pendingExtra());
    if (drag.on && !m.canPlay) cancelDrag();
    paintHead(head, { total: m.total, pg: m.pg, phase: m.phase, starts: m.starts, ends: m.ends });
    paintRank(rank, { phase: v.phase, playing: v.playing, rank: v.rank, me: v.me });
    if (paintComb(comb, m.phase === 'play' ? combModel(m) : {})) drawTrace();
    paintFound(found, foundModel());
    paintBoard(board, { phase: v.phase, board: v.board });
    paintReveal(results, { phase: m.phase, letters: m.letters, centre: m.centre, reveal: m.reveal });
    paintFoot(foot, { phase: m.phase, playing: m.playing, centre: m.centre, reveal: m.reveal ? { lost: m.reveal.lost } : null });
  }

  function update(next) {
    const m = hive.model(next);
    model = m;
    if (!m) {
      if (drag.on) cancelDrag();
      paintHead(head, { total: 0, pg: 0, phase: 'wait' });
      return;
    }
    if (m.id !== local.id) {
      if (drag.on) cancelDrag();
      local.id = m.id;
      local.order = shuffled(m.outer);
      local.found = [];
      local.pending.clear();
      local.seen.clear();
      local.opt.clear();
      local.maxQ = -1;
      input.value = '';
      say(null);
    }
    if (local.order.length !== m.outer.length) local.order = shuffled(m.outer);
    settle(m);
    render();
    const open = m.canPlay;
    input.disabled = !open;
    delBtn.disabled = !open;
    mixBtn.disabled = !open;
    sendBtn.disabled = !open;
    entry.classList.toggle('is-hidden', m.phase !== 'play' || !m.playing);
    el.classList.toggle('is-reveal', m.phase === 'reveal');
    const { now, cues: list } = hiveMoments(heard, m);
    const fresh = heard === null;
    heard = now;
    list.forEach((name, i) => cue.play(name, i ? { at: 260 } : undefined));
    if (list.includes('pop') && m.last) say(`${m.last.name} found a pangram!`);
    if (open && (fresh || list.includes('turn')) && typeof input.focus === 'function') input.focus();
  }

  return {
    el,
    update,
    destroy() {
      if (drag.on) cancelDrag();
      stopMsg();
    },
  };
}
