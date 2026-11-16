import telephone, { KEY as TEL_KEY, REACTS, REACT_NAMES, NEXT_MIN_MS, TEXT_MAX, GONE_TEXT, fitText, entryInk, inkKey as telInkKey, seatInk, textRef, promptRef, isStarterText, createKeeper } from '../games/telephone.js';
import { GRID_W, GRID_H, SIZES, SIZE_NAMES, CUSTOM, FILL, SEAT_CHUNKS, G_MAX, encodeParts, decodeStroke, quantise, fitSeat, strokeOn as inkStroke, fillOn, paintInk, createPainter } from '../games/ink.js';
import { fillTool, markTool, flagModel, flagButton, flagDrawing, tintOfPen, pickTint } from './draw.js';
import { createPalette, dropTool, pixelAt, canvasPixel } from './palette.js';
import { h, memo, timer, profileButton, button, plural } from '../ui/dom.js';
import { textFlag } from '../ui/report.js';
import { hidesWords } from '../text.js';
import { HIDDEN_NOTE } from '../filter.js';

export const SCALE = 2;
export const WRITE_GAP_MS = 700;
export const AUTO_SEND_MS = 700;
export const FLUSH_LEFT_MS = 1000;
export const TICK_MS = 400;

const QUIET = { play() {}, burst() {}, float() {} };

export const STEP_LABEL = Object.freeze({ write: 'Write', draw: 'Draw', text: 'Describe', reveal: 'The reveal', awards: 'Awards', lost: 'Hung up', recover: 'Reconnecting' });

export function headline(m, sent) {
  if (m.phase === 'write') return sent ? 'Your phrase is on its way!' : 'Start a chain! Write something silly for someone to draw.';
  if (m.phase === 'draw') return sent ? 'Nice drawing! Hold tight.' : 'Draw this phrase. No letters or numbers!';
  if (m.phase === 'text') return sent ? 'Description sent!' : 'What is this drawing? Describe it in a few words.';
  if (m.phase === 'awards') return 'And the awards go to…';
  if (m.phase === 'recover') return 'Reconnecting the chains…';
  if (m.phase === 'lost') return m.note === 'few' ? 'Not enough players to keep the chains going.' : "The chains couldn't be put back together.";
  return '';
}

export function footText(m, sent) {
  if (m.phase === 'recover') return 'The host left the call. Hang tight while everyone sends their part back in.';
  if (m.phase === 'lost') return 'Heading to the results in a moment.';
  if (m.phase === 'awards') return 'Thanks for playing! Results are up next.';
  if (m.phase === 'reveal') {
    const r = m.reveal;
    if (!r) return '';
    if (r.canNext) return r.finale ? 'Tap Next to see the awards.' : r.last ? 'Tap Next for the next chain.' : 'Tap Next to see what happened next.';
    return `${r.owner.name} is stepping through their chain.`;
  }
  if (m.pass) return 'Everyone is done! Passing the papers…';
  if (m.waiting) return "You joined mid-round. You'll get a seat if one opens up, and you can react during the reveal.";
  if (!m.playing) return "You're watching this round. Join the next one to play.";
  const left = Math.max(0, m.needCount - m.doneCount);
  if (sent) return left ? `Waiting for ${plural(left, 'player', 'players')}…` : 'Everyone is done!';
  if (m.phase === 'write') return 'Type your own or tap a suggestion.';
  if (m.phase === 'draw') return m.to ? `Your drawing goes to ${m.to.name} next.` : 'This is the last drawing in the chain!';
  if (m.phase === 'text') return m.to ? `${m.to.name} will draw what you write.` : 'Yours is the last word in the chain!';
  return '';
}

export const BLANK_TEXT = 'Blank page! Make up what it might be.';
export const HIDDEN_SRC_TEXT = 'Hidden after a report. Make up what it might be.';

export function verbOf(e) {
  if (e.i === 0) return 'started with';
  if (e.k === 'd') return 'drew';
  return 'thought it was';
}

export function nextLabel(r) {
  if (r.finale) return 'See the awards';
  if (r.last) return 'Next chain';
  return 'Next';
}

function strokeOn(ctx, s, from = 0) {
  inkStroke(ctx, s, SCALE, from);
}

function contextOf(canvas) {
  try {
    return typeof canvas.getContext === 'function' ? canvas.getContext('2d', { willReadFrequently: true }) : null;
  } catch {
    return null;
  }
}

function paintStrokes(ctx, strokes, painter = null) {
  if (!ctx) return;
  if (painter) painter.paint(ctx, strokes);
  else paintInk(ctx, strokes, SCALE);
}

export function inkSig(parts) {
  let h = 2166136261;
  let n = 0;
  for (const s of Array.isArray(parts) ? parts : []) {
    if (typeof s !== 'string') continue;
    n += s.length;
    for (let i = 0; i < s.length; i += 1) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
    h = Math.imul(h ^ 124, 16777619) >>> 0;
  }
  return `${n}.${h.toString(36)}`;
}

export function decodeAll(parts) {
  return (Array.isArray(parts) ? parts : []).map(decodeStroke).filter(Boolean);
}

export function newSheet() {
  return { key: null, strokes: [], level: 0, g: 0, values: [], shown: [], dirty: false };
}

export function emptySheet(sheet, key = sheet.key) {
  Object.assign(sheet, newSheet(), { key, g: sheet.g });
}

export function refit(sheet, k, budget, fresh = false) {
  const fit = fitSeat(sheet.strokes, k, fresh ? 0 : sheet.level, budget);
  const moved = fresh || fit.level !== sheet.level || fit.thinned;
  sheet.g = moved ? (sheet.g + 1) % (G_MAX + 1) : sheet.g;
  sheet.strokes = fit.strokes;
  sheet.level = fit.level;
  sheet.values = fit.pieces.map((s) => ({ k, g: sheet.g, s }));
  sheet.shown = decodeAll(fit.pieces.flat());
  sheet.dirty = true;
  return moved;
}

export function restoreSheet(sheet, ink) {
  const values = ink && Array.isArray(ink.values) ? ink.values : [];
  sheet.strokes = decodeAll(values.flatMap((v) => v.s));
  sheet.level = -1;
  sheet.g = ink ? ink.g : 0;
  sheet.values = values.map((v) => ({ ...v, s: v.s.slice() }));
  sheet.shown = sheet.strokes.slice();
  sheet.dirty = false;
}

export function sheetStale(state, keyOf, sheet, k) {
  for (let i = 0; i < sheet.values.length; i += 1) {
    const have = state ? state[keyOf(i)] ?? null : null;
    if (!have || have.k !== k) return true;
  }
  return false;
}

export function writeSheet(engine, keyOf, sheet) {
  let ok = true;
  for (let i = SEAT_CHUNKS - 1; i >= sheet.values.length; i -= 1) if (engine.direct(keyOf(i), null) === false) ok = false;
  for (let i = 0; i < sheet.values.length; i += 1) if (engine.direct(keyOf(i), sheet.values[i]) === false) ok = false;
  return ok;
}

function byData(root, selector, name, value) {
  for (const x of root.querySelectorAll(selector)) if (x.dataset && x.dataset[name] === String(value)) return x;
  return null;
}

function faceRow(p, verb, size = 'sm') {
  return h(
    'span',
    { class: 'who' },
    profileButton(p, size),
    h('span', { class: 'who-text' }, h('span', { class: 'who-line' }, h('strong', { class: 'who-name', text: p.isMe ? 'You' : p.name }), verb ? h('span', { class: 'who-verb', text: ` ${verb}` }) : null)),
  );
}

export function telephoneMoments(was, m) {
  const stepKey = `${m.run}:${m.phase}:${m.step}`;
  const r = m.reveal;
  const rx = r ? r.entries.map((e) => e.rx.reduce((a, b) => a + b, 0)) : [];
  const now = { stepKey, phase: m.phase, c: r ? r.c : null, at: r ? r.at : -1, rx, done: m.doneCount };
  if (!was) return { now, cues: [] };
  const cues = [];
  if (stepKey !== was.stepKey) {
    if ((m.phase === 'write' || m.phase === 'draw' || m.phase === 'text') && m.playing) cues.push({ name: 'turn' });
    else if (m.phase === 'reveal') cues.push({ name: 'whoosh' });
    else if (m.phase === 'awards') cues.push({ name: 'reveal' });
    else if (m.phase === 'lost') cues.push({ name: 'leave' });
    return { now, cues };
  }
  if (r) {
    if (r.c !== was.c) cues.push({ name: 'whoosh' });
    else if (r.at > was.at) cues.push({ name: 'reveal' });
    else {
      const grew = rx.findIndex((n, i) => n > (was.rx[i] || 0));
      if (grew >= 0) cues.push({ name: 'pop', opts: { volume: 0.5 }, entry: grew });
    }
  } else if (m.doneCount > was.done && !m.pass) {
    cues.push({ name: 'tap', opts: { volume: 0.4 } });
  }
  return { now, cues };
}

export function createTelephoneView({ engine, fx, toast, win, cues }) {
  const cue = cues && typeof cues.play === 'function' ? cues : QUIET;
  const say = typeof toast === 'function' ? toast : () => {};
  const w = win || globalThis;
  const el = h('section', { class: 'game telephone-game', attrs: { 'aria-label': 'Draw Telephone' } });
  const head = h('div', { class: 'telephone-headwrap' });
  const track = h('div', { class: 'telephone-track-wrap' });
  const task = h('div', { class: 'telephone-task', attrs: { 'aria-live': 'polite' } });
  const canvas = h('canvas', { class: 'ink-canvas', attrs: { width: GRID_W * SCALE, height: GRID_H * SCALE, role: 'img', 'aria-label': 'Drawing' } });
  const blankNote = h('p', { class: 'telephone-blank telephone-off', text: BLANK_TEXT });
  const paper = h('div', { class: 'paper telephone-paper' }, canvas, blankNote);
  const ctx = contextOf(canvas);
  const painter = createPainter(SCALE);
  const pen = { c: 1, z: 1, fill: false, drop: false };
  const palette = createPalette({ pen, onPick: (t) => setPen(pickTint(t)) });
  const sizes = SIZES.map((z, i) =>
    h('button', {
      class: ['size', i === pen.z ? 'is-on' : null],
      type: 'button',
      dataset: { key: `size-${i}` },
      vars: { '--dot': `${Math.max(4, Math.min(26, z))}px` },
      attrs: { 'aria-label': `${SIZE_NAMES[i]} pen`, 'aria-pressed': i === pen.z ? 'true' : 'false', title: SIZE_NAMES[i] },
      on: { click: () => setPen({ z: i, fill: false, drop: false }) },
    }, h('span', { class: 'size-dot', attrs: { 'aria-hidden': 'true' } })),
  );
  const fillBtn = fillTool(pen.fill, () => setPen({ fill: !pen.fill, drop: false }));
  const dropBtn = dropTool(pen.drop, () => setPen({ drop: !pen.drop }));
  const undoBtn = button('Undo', { variant: 'ghost', size: 'sm', key: 'undo', on: () => undo() });
  const redoBtn = button('Redo', { variant: 'ghost', size: 'sm', key: 'redo', on: () => redo() });
  const clearBtn = button('Clear', { variant: 'ghost', size: 'sm', key: 'clear', on: () => clearAll() });
  const tools = h(
    'div',
    { class: 'draw-tools', attrs: { role: 'toolbar', 'aria-label': 'Drawing tools' } },
    palette.el,
    palette.pop,
    h('div', { class: 'tool-row' }, h('div', { class: 'sizes' }, sizes, fillBtn, dropBtn), h('div', { class: 'tool-actions' }, undoBtn, redoBtn, clearBtn)),
  );
  const doneBtn = button('Done!', { variant: 'primary', size: 'lg', key: 'draw-done', on: () => finishDrawing() });
  const editBtn = button('Keep drawing', { variant: 'ghost', key: 'draw-edit', on: () => keepDrawing() });
  const doneRow = h('div', { class: 'telephone-done-row' }, doneBtn, editBtn);
  const board = h('div', { class: 'draw-board telephone-board telephone-off' }, paper, tools, doneRow);
  const input = h('input', {
    class: 'word-input',
    dataset: { key: 'tel-input' },
    attrs: { type: 'text', maxlength: TEXT_MAX, autocomplete: 'off', spellcheck: 'true', enterkeyhint: 'send', 'aria-label': 'Your phrase', placeholder: 'Type something silly' },
  });
  const sendBtn = button('Send', { variant: 'primary', key: 'tel-send', on: () => submitText() });
  const sugBox = h('div', { class: 'telephone-sugs' });
  const entry = h('div', { class: 'telephone-entry telephone-off' }, h('div', { class: 'entry-row' }, input, sendBtn), sugBox);
  const waitBox = h('div', { class: 'telephone-wait' });
  const revealBox = h('div', { class: 'telephone-reveal' });
  const awardBox = h('div', { class: 'telephone-awards' });
  const foot = h('div', { class: 'game-foot', attrs: { role: 'status', 'aria-live': 'polite' } });
  const flagSrc = h('div', { class: 'flag-slot' });
  const flagShow = h('div', { class: 'flag-slot telephone-flag' });
  const flagged = new Set();
  board.insertBefore(flagSrc, tools);
  el.append(head, track, task, board, entry, waitBox, revealBox, flagShow, awardBox, foot);

  const mine = newSheet();
  const keeper = createKeeper();
  let redoStack = [];
  const local = { stepKey: null, sent: null, reacted: new Set() };
  let cur = null;
  let model = null;
  let snap = null;
  let writeTimer = null;
  let lastWrite = 0;
  let heard = null;
  let shownSrc = null;
  let shown = 'blank';
  let cheered = null;
  let ticker = null;
  let gone = false;
  let warned = null;

  function setPen(p) {
    Object.assign(pen, p);
    palette.mark(pen);
    sizes.forEach((b, i) => markTool(b, !pen.fill && !pen.drop && i === pen.z));
    markTool(fillBtn, pen.fill && !pen.drop);
    markTool(dropBtn, pen.drop);
    board.classList.toggle('is-filling', pen.fill && !pen.drop);
    board.classList.toggle('is-dropping', pen.drop);
  }

  function sample(e) {
    const at = canvasPixel(canvas, e);
    const hex = at ? pixelAt(ctx, at[0], at[1]) : null;
    if (!hex) return;
    palette.take(hex);
    setPen({ drop: false, fill: false });
  }

  function stepKeyOf(m) {
    return `${m.run}:${m.step}:${m.k}`;
  }

  function sentNow() {
    return Boolean(model && (model.mineDone || (local.sent === local.stepKey && model.phase !== 'draw')));
  }

  function canDraw() {
    return Boolean(model && model.phase === 'draw' && model.playing && !model.mineDone && !model.pass && mine.key === stepKeyOf(model));
  }

  function paintMine() {
    shown = 'mine';
    paintStrokes(ctx, cur ? mine.shown.concat([cur]) : mine.shown, painter);
  }

  function srcStrokes(m) {
    return m && m.src && Array.isArray(m.src.ink) ? m.src.ink : [];
  }

  function paintBoard() {
    const m = model;
    if (m && m.phase === 'draw' && m.playing && mine.key === stepKeyOf(m)) {
      paintMine();
      return;
    }
    if (m && m.phase === 'text' && m.playing && m.src) {
      const parts = srcStrokes(m);
      shownSrc = `${m.src.key}:${m.src.k}:${inkSig(parts)}`;
      shown = 'src';
      paintStrokes(ctx, decodeAll(parts), painter);
      return;
    }
    shownSrc = null;
    if (shown === 'blank') return;
    shown = 'blank';
    paintStrokes(ctx, [], painter);
  }

  function release(id) {
    if (id === undefined || id === null || typeof canvas.releasePointerCapture !== 'function') return;
    try {
      canvas.releasePointerCapture(id);
    } catch {
      return;
    }
  }

  function dropStroke() {
    if (!cur) return;
    const id = cur.id;
    cur = null;
    release(id);
    paintBoard();
  }

  function samePointer(e) {
    return !cur || cur.id === undefined || !e || e.pointerId === undefined || e.pointerId === cur.id;
  }

  function pointerGone() {
    if (!cur || cur.id === undefined || typeof canvas.setPointerCapture !== 'function') return false;
    if (!cur.held) return true;
    if (typeof canvas.hasPointerCapture !== 'function') return false;
    try {
      return !canvas.hasPointerCapture(cur.id);
    } catch {
      return false;
    }
  }

  function pointOf(e) {
    const r = canvas.getBoundingClientRect();
    if (!r || !r.width || !r.height) return null;
    return quantise(((e.clientX - r.left) / r.width) * GRID_W, ((e.clientY - r.top) / r.height) * GRID_H);
  }

  function fillAt(p) {
    const parts = encodeParts({ ...tintOfPen(pen), z: FILL, pts: [p] });
    const s = parts.length ? decodeStroke(parts[0]) : null;
    if (!s) return;
    paintMine();
    if (fillOn(ctx, s, SCALE) === 0) return;
    redoStack = [];
    mine.strokes.push(s);
    if (refit(mine, model.k, model.budget)) paintMine();
    queueWrite();
  }

  function onDown(e) {
    if (cur && !samePointer(e) && canDraw() && cur.key === mine.key && !pointerGone()) return;
    if (cur) commitStroke();
    if (!canDraw()) return;
    if (pen.drop) {
      e.preventDefault();
      sample(e);
      return;
    }
    const p = pointOf(e);
    if (!p) return;
    e.preventDefault();
    if (pen.fill) {
      fillAt(p);
      return;
    }
    let held = false;
    if (typeof canvas.setPointerCapture === 'function' && e.pointerId !== undefined) {
      try {
        canvas.setPointerCapture(e.pointerId);
        held = true;
      } catch {
        held = false;
      }
    }
    cur = { ...tintOfPen(pen), z: pen.z, pts: [p], id: e.pointerId, key: mine.key, held };
    strokeOn(ctx, cur);
  }

  function onMove(e) {
    if (!cur || !samePointer(e)) return;
    if (!canDraw() || cur.key !== mine.key) {
      dropStroke();
      return;
    }
    if (e.pointerType === 'mouse' && e.buttons === 0) {
      commitStroke();
      return;
    }
    e.preventDefault();
    const before = cur.pts.length;
    const list = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    for (const x of list.length ? list : [e]) {
      const p = pointOf(x);
      const last = cur.pts[cur.pts.length - 1];
      if (p && (!last || last[0] !== p[0] || last[1] !== p[1])) cur.pts.push(p);
    }
    if (cur.pts.length > before) strokeOn(ctx, cur, before);
  }

  function onUp(e) {
    if (!cur || !samePointer(e)) return;
    commitStroke();
  }

  function commitStroke(keep = false) {
    if (!cur) return false;
    const s = cur.c === CUSTOM ? { c: cur.c, rgb: cur.rgb, z: cur.z, pts: cur.pts } : { c: cur.c, z: cur.z, pts: cur.pts };
    const id = cur.id;
    const key = cur.key;
    const held = cur.held;
    cur = null;
    if (!keep) release(id);
    if (!canDraw() || key !== mine.key) {
      paintBoard();
      return false;
    }
    if (keep) cur = { ...s, pts: [s.pts[s.pts.length - 1]], id, key, held };
    redoStack = [];
    mine.strokes.push(s);
    refit(mine, model.k, model.budget);
    paintMine();
    queueWrite();
    return true;
  }

  function queueWrite() {
    if (writeTimer !== null) return;
    const wait = Math.max(0, lastWrite + WRITE_GAP_MS - Date.now());
    writeTimer = w.setTimeout(writeNow, wait);
  }

  function writeNow() {
    if (writeTimer !== null) {
      w.clearTimeout(writeTimer);
      writeTimer = null;
    }
    if (!model || model.phase !== 'draw' || !model.playing || !model.inkKey || mine.key !== stepKeyOf(model)) return;
    lastWrite = Date.now();
    mine.dirty = false;
    const seat = model.seat;
    if (writeSheet(engine, (i) => telInkKey(seat, i), mine)) return;
    mine.dirty = true;
    if (warned === mine.key) return;
    warned = mine.key;
    cue.play('error');
    say('Your drawing did not save. Keep going, it will try again.');
  }

  function undo() {
    if (!canDraw() || cur || !mine.strokes.length) return;
    redoStack.push(mine.strokes.pop());
    refit(mine, model.k, model.budget);
    paintMine();
    queueWrite();
  }

  function redo() {
    if (!canDraw() || cur || !redoStack.length) return;
    mine.strokes.push(redoStack.pop());
    refit(mine, model.k, model.budget);
    paintMine();
    queueWrite();
  }

  function clearAll() {
    if (!canDraw() || cur || !mine.strokes.length) return;
    redoStack = [];
    mine.strokes = [];
    refit(mine, model.k, model.budget, true);
    paintMine();
    queueWrite();
  }

  function finishDrawing() {
    if (!canDraw()) return;
    if (cur) commitStroke();
    writeNow();
    local.sent = local.stepKey;
    cue.play('send');
    engine.act({ type: 'done', step: model.step });
    refresh();
  }

  function keepDrawing() {
    if (!model || model.phase !== 'draw' || !model.mineDone || model.pass) return;
    local.sent = null;
    cue.play('toggle');
    engine.act({ type: 'edit', step: model.step });
  }

  function submitText(auto = false) {
    if (!model || (model.phase !== 'write' && model.phase !== 'text') || !model.playing || sentNow()) return false;
    const text = fitText(input.value);
    if (!text) {
      if (!auto) {
        cue.play('error');
        say(model.phase === 'write' ? 'Type a phrase or tap a suggestion first.' : 'Type what you think the drawing is.');
        input.classList.add('is-refused');
        w.setTimeout(() => input.classList.remove('is-refused'), 420);
      }
      return false;
    }
    local.sent = local.stepKey;
    cue.play('send');
    keeper.act(engine, snap, { type: 'text', step: model.step, text });
    if (hidesWords(input.value)) say(HIDDEN_NOTE);
    refresh();
    return true;
  }

  function pick(i) {
    if (!model || model.phase !== 'write' || !model.playing || sentNow()) return;
    local.sent = local.stepKey;
    cue.play('send');
    keeper.act(engine, snap, { type: 'pick', step: model.step, i });
    refresh();
  }

  function react(e, i) {
    const r = model && model.reveal;
    if (!r || !r.canReact) return;
    const mark = `${model.run}.${r.c}.${i}.${e}`;
    if (local.reacted.has(mark)) return;
    local.reacted.add(mark);
    cue.play('tap', { volume: 0.6 });
    const btn = byData(revealBox, '.telephone-react', 'key', `react-${i}-${e}`);
    if (btn) cue.float(btn, REACTS[e]);
    engine.act({ type: 'react', c: r.c, i, e });
    refresh();
  }

  function next() {
    const r = model && model.reveal;
    if (!r || !r.canNext) return;
    if (typeof engine.now === 'function' && engine.now() - model.starts < NEXT_MIN_MS) return;
    cue.play('tap');
    engine.act({ type: 'next', c: r.c, at: r.at });
  }


  function onKeys(e) {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const tag = e.target && e.target.tagName ? String(e.target.tagName).toLowerCase() : '';
    if (tag === 'input' || tag === 'textarea' || (e.target && e.target.isContentEditable)) return;
    const k = String(e.key || '').toLowerCase();
    if (k === 'z' && !e.shiftKey) {
      e.preventDefault();
      undo();
    } else if ((k === 'z' && e.shiftKey) || k === 'y') {
      e.preventDefault();
      redo();
    }
  }
  if (typeof w.addEventListener === 'function') w.addEventListener('keydown', onKeys);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitText();
    }
  });
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('lostpointercapture', onUp);
  const lifted = (e) => onUp(e);
  if (typeof w.addEventListener === 'function') {
    w.addEventListener('pointerup', lifted);
    w.addEventListener('pointercancel', lifted);
  }

  const paintHead = memo((m) =>
    h(
      'div',
      { class: 'game-head' },
      h('span', { class: 'chip chip-static', text: STEP_LABEL[m.phase] || 'Draw Telephone' }),
      m.count ? h('span', { class: 'game-count', text: m.count }) : null,
      m.pass ? h('span', { class: 'game-count', text: 'Passing…' }) : m.ends ? timer(m.starts, m.ends, m.label) : null,
    ),
  );

  const paintTrack = memo((m) => {
    if (!m.kinds.length || !m.stepping) return null;
    return h(
      'ol',
      { class: 'telephone-track', attrs: { 'aria-label': `Step ${m.step + 1} of ${m.kinds.length}` } },
      m.kinds.map((k, i) =>
        h('li', {
          class: ['telephone-dot', `telephone-kind-${k}`, i < m.step ? 'telephone-past' : null, i === m.step ? 'telephone-now' : null],
          text: k === 'write' ? '✍️' : k === 'draw' ? '🎨' : '🔎',
          attrs: { title: STEP_LABEL[k], 'aria-hidden': 'true' },
        }),
      ),
    );
  });

  const paintTask = memo((m) => {
    if (!m.text && !m.prompt) return null;
    return h(
      'div',
      { class: ['telephone-task-card', m.prompt ? 'telephone-has-prompt' : null] },
      h('p', { class: 'telephone-lead', text: m.text }),
      m.prompt ? h('p', { class: ['telephone-prompt', m.ref ? 'has-flag' : null, m.ref ? 'telephone-flagged' : null] }, h('span', { class: 'telephone-quote', text: m.prompt }), m.ref ? textFlag(engine, m.ref, { toast }) : null) : null,
      m.from ? h('p', { class: 'telephone-from muted' }, h('span', { text: m.prompt ? 'Written by ' : 'Drawn by ' }), h('strong', { text: m.from })) : null,
    );
  });

  const paintSugs = memo((m) => {
    if (!m.sugs.length) return null;
    return h(
      'div',
      { class: 'telephone-sug-list' },
      h('span', { class: 'telephone-sug-label muted', text: 'Or pick one:' }),
      m.sugs.map((s) => button(s.text, { variant: 'secondary', size: 'sm', key: `sug-${s.i}`, disabled: m.sent, on: () => pick(s.i) })),
    );
  });

  const paintWait = memo((m) => {
    if (!m.show) return null;
    return h(
      'div',
      { class: 'telephone-waiting' },
      h('span', { class: 'telephone-sent', text: m.sent ? 'Sent!' : '' }),
      m.working.length
        ? h(
            'div',
            { class: 'telephone-working' },
            h('span', { class: 'muted', text: 'Still working:' }),
            h('span', { class: 'faces' }, m.working.slice(0, 10).map((p) => profileButton(p, 'xs'))),
          )
        : null,
    );
  });

  const paintReveal = memo((r) => {
    if (!r) return null;
    return h(
      'div',
      { class: 'telephone-chain card glass' },
      h(
        'div',
        { class: 'telephone-chain-head' },
        h('span', { class: 'game-count', text: `Chain ${r.pos + 1} of ${r.total}` }),
        faceRow(r.owner, r.owner.isMe ? '' : 'started this one', 'sm'),
      ),
      h(
        'ol',
        { class: 'telephone-entries' },
        r.entries.map((e) =>
          h(
            'li',
            { class: ['telephone-entry-item', `telephone-kind-${e.k === 'd' ? 'draw' : 'text'}`, e.i === r.at ? 'telephone-new' : null], dataset: { entry: e.i } },
            h('div', { class: 'telephone-entry-who' }, faceRow(e.by, verbOf(e), 'xs'), e.gone ? null : e.miss ? h('span', { class: 'telephone-miss muted', text: e.k === 'd' ? '(ran out of time)' : '(no answer, so it carried over)' }) : null),
            e.k === 'd'
              ? h('div', { class: ['paper', 'telephone-mini', e.hidden ? 'is-hidden' : null] }, h('canvas', { class: 'ink-canvas', dataset: { draw: e.i }, attrs: { width: GRID_W * SCALE, height: GRID_H * SCALE, role: 'img', 'aria-label': e.hidden ? 'Hidden drawing' : `Drawing by ${e.by.isMe ? 'you' : e.by.name}` } }), e.hidden ? h('p', { class: 'telephone-blank telephone-hidden', text: 'Hidden after a report' }) : e.gone ? h('p', { class: 'telephone-blank', text: GONE_TEXT }) : e.strokes ? null : h('p', { class: 'telephone-blank', text: 'Blank page!' }))
              : e.ref
              ? h('div', { class: 'telephone-said has-flag' }, h('p', { class: 'telephone-bubble', text: e.t }), textFlag(engine, e.ref, { toast }))
              : h('p', { class: 'telephone-bubble', text: e.t }),
            h(
              'div',
              { class: 'telephone-reacts', attrs: { role: 'group', 'aria-label': 'Reactions' } },
              REACTS.map((emoji, x) => {
                const did = e.did[x];
                return h(
                  'button',
                  {
                    class: ['telephone-react', 'spot', did ? 'is-on' : null, e.rx[x] ? 'telephone-has-count' : null],
                    type: 'button',
                    dataset: { key: `react-${e.i}-${x}` },
                    disabled: !r.canReact || e.mine || did,
                    attrs: { 'aria-label': `${REACT_NAMES[x]}: ${e.rx[x]}`, 'aria-pressed': did ? 'true' : 'false', title: REACT_NAMES[x] },
                    on: { click: () => react(x, e.i) },
                  },
                  h('span', { class: 'telephone-react-emoji', text: emoji, attrs: { 'aria-hidden': 'true' } }),
                  h('span', { class: 'telephone-react-count', text: e.rx[x] ? String(e.rx[x]) : '' }),
                );
              }),
            ),
          ),
        ),
      ),
      r.canNext
        ? h('div', { class: 'telephone-next' }, button(nextLabel(r), { variant: 'primary', size: 'lg', key: 'tel-next', disabled: r.early, on: () => next() }))
        : null,
    );
  });

  const paintAwards = memo((m) => {
    if (m.phase !== 'awards' && m.phase !== 'lost') return null;
    if (m.phase === 'lost') return h('div', { class: 'card glass telephone-lost' }, h('span', { class: 'trophy', text: '📵', attrs: { 'aria-hidden': 'true' } }), h('p', { class: 'muted', text: m.note === 'few' ? 'Too many people left, so this game is over. Start a new one from the lobby!' : 'Everyone who had a piece of the chains left the call, so this game is over. Start a new one from the lobby!' }));
    if (!m.awards.length) return h('p', { class: 'muted telephone-no-awards', text: 'No awards this time. Everyone was a winner in spirit!' });
    return h(
      'ul',
      { class: 'telephone-award-grid' },
      m.awards.map((a, i) =>
        h(
          'li',
          { class: ['telephone-award', 'card', 'glass', a.who.isMe ? 'is-me' : null], dataset: { award: a.id }, vars: { '--i': i } },
          h('span', { class: 'telephone-award-emoji', text: a.e, attrs: { 'aria-hidden': 'true' } }),
          h('strong', { class: 'telephone-award-title fx-display is-lit', text: a.title }),
          faceRow(a.who, '', 'sm'),
          h('span', { class: 'telephone-award-why muted', text: a.why }),
        ),
      ),
    );
  });

  const paintFoot = memo((m) => h('span', { class: 'foot-text', text: m.text }));

  const paintFlagSrc = memo((f) => flagButton(f, () => flag()));
  const paintFlagShow = memo((f) => flagButton(f, () => flag()));

  function flag() {
    if (!snap) return;
    flagDrawing({ engine, snap, game: 'telephone', item: telephone.drawingOf(snap), local: flagged, toast });
    update(engine.snapshot());
  }

  function paintFlags(next, m) {
    const f = m.phase === 'text' || m.phase === 'reveal' ? flagModel(next, telephone.drawingOf(next), flagged) : null;
    paintFlagSrc(flagSrc, m.phase === 'text' ? f : null);
    paintFlagShow(flagShow, m.phase === 'reveal' ? f : null);
  }

  function syncBoard(m) {
    const drawing = m.phase === 'draw' && m.playing;
    const viewing = m.phase === 'text' && m.playing && m.src;
    if (cur && (!canDraw() || cur.key !== stepKeyOf(m))) {
      const id = cur.id;
      cur = null;
      release(id);
      shown = null;
    }
    board.classList.toggle('telephone-off', !drawing && !viewing);
    board.classList.toggle('is-drawing', canDraw());
    board.classList.toggle('telephone-viewing', Boolean(viewing));
    doneRow.classList.toggle('telephone-off', !drawing);
    if (!canDraw()) palette.close(false);
    if (drawing) {
      const key = stepKeyOf(m);
      if (mine.key !== key) {
        cur = null;
        warned = null;
        redoStack = [];
        emptySheet(mine, key);
        restoreSheet(mine, seatInk(snap.state, m.seat, m.k));
        shownSrc = null;
        paintMine();
      } else if (shown !== 'mine') {
        paintMine();
      }
      blankNote.classList.add('telephone-off');
      if (writeTimer === null && !m.pass && sheetStale(snap.state, (i) => telInkKey(m.seat, i), mine, m.k)) queueWrite();
      undoBtn.disabled = !canDraw() || !mine.strokes.length;
      redoBtn.disabled = !canDraw() || !redoStack.length;
      clearBtn.disabled = !canDraw() || !mine.strokes.length;
      doneBtn.disabled = !canDraw();
      doneBtn.classList.toggle('telephone-off', m.mineDone);
      editBtn.classList.toggle('telephone-off', !m.mineDone || m.pass);
      return;
    }
    mine.key = null;
    if (viewing) {
      const sig = `${m.src.key}:${m.src.k}:${inkSig(srcStrokes(m))}`;
      if (sig !== shownSrc || shown !== 'src') paintBoard();
      blankNote.classList.toggle('telephone-off', !m.src.blank);
      blankNote.textContent = m.src.hidden ? HIDDEN_SRC_TEXT : BLANK_TEXT;
      return;
    }
    blankNote.classList.add('telephone-off');
    paintBoard();
  }

  function drawEntries(state) {
    for (const c of revealBox.querySelectorAll('canvas')) {
      const i = Number(c.dataset.draw);
      paintStrokes(contextOf(c), decodeAll(entryInk(state, i)));
    }
  }

  function hear(m) {
    const first = heard === null;
    const { now, cues: list } = telephoneMoments(heard, m);
    heard = now;
    for (const c of list) {
      cue.play(c.name, c.opts);
      if (c.entry !== undefined) {
        const item = byData(revealBox, '.telephone-entry-item', 'entry', c.entry);
        const row = item ? item.querySelector('.telephone-reacts') : null;
        if (row) cue.burst(row, { count: 8, emoji: REACTS });
      }
    }
    if (m.phase === 'awards' && cheered !== m.run) {
      cheered = m.run;
      if (first) return;
      const me = awardBox.querySelector('.telephone-award.is-me');
      if (me) {
        cue.play('correct', { at: 360 });
        cue.burst(me, { count: 18, emoji: ['🏅', '☎️'] });
        if (fx && typeof fx.confetti === 'function') fx.confetti(30);
      }
    }
  }

  function autoSend(m) {
    const now = typeof engine.now === 'function' ? engine.now() : Date.now();
    if (!m.playing || m.pass || !m.ends) return;
    if ((m.phase === 'write' || m.phase === 'text') && !sentNow() && now >= m.ends - AUTO_SEND_MS && input.value.trim()) submitText(true);
    if (m.phase === 'draw' && now >= m.ends - FLUSH_LEFT_MS) {
      if (cur && cur.pts.length > 1 && canDraw()) commitStroke(true);
      if (mine.dirty) writeNow();
    }
  }

  function refresh() {
    if (snap) update(snap);
  }

  function update(next) {
    if (gone) return;
    snap = next;
    const m = telephone.model(next);
    model = m;
    if (!m) {
      paintTask(task, { text: 'Getting the chains ready…', prompt: null, from: null });
      return;
    }
    keeper.observe(next);
    if (m.phase === 'recover') {
      local.sent = null;
      keeper.resend(next, engine);
    }
    const key = `${m.run}:${m.phase}:${m.step}:${m.k}`;
    if (key !== local.stepKey) {
      local.stepKey = key;
      if (m.phase === 'write' || m.phase === 'text') {
        input.value = '';
        input.setAttribute('placeholder', m.phase === 'write' ? 'Type something silly' : 'Describe the drawing');
        input.setAttribute('aria-label', m.phase === 'write' ? 'Your phrase' : 'Your description');
      }
    }
    const stepping = m.phase === 'write' || m.phase === 'draw' || m.phase === 'text';
    const sent = stepping && sentNow();
    const count = stepping ? `Step ${m.step + 1} of ${m.steps}` : m.reveal ? `Chain ${m.reveal.pos + 1} of ${m.reveal.total}` : '';
    const label = m.phase === 'draw' ? 'Time left to draw' : m.phase === 'reveal' ? 'Next one in' : m.phase === 'awards' ? 'Results in' : m.phase === 'lost' ? 'Results in' : m.phase === 'recover' ? 'Back in' : 'Time left to write';
    paintHead(head, { phase: m.phase, count, pass: m.pass, starts: m.starts, ends: m.ends, label });
    paintTrack(track, { kinds: m.kinds, step: m.step, stepping });
    const fromName = m.from ? (m.from.isMe ? 'you' : m.from.name) : null;
    paintTask(task, {
      text: stepping && !m.playing ? (m.waiting ? 'Hang tight! You can jump in if a seat opens up.' : 'Everyone is busy writing and drawing.') : headline(m, sent),
      prompt: m.phase === 'draw' && m.playing ? m.prompt || '???' : null,
      from: stepping && m.playing && m.phase !== 'write' ? fromName : null,
      ref: m.phase === 'draw' && m.playing && m.prompt && !isStarterText(m.prompt) && m.from && !m.from.isMe ? promptRef(next.state[TEL_KEY], m.seat) : null,
    });
    const typing = (m.phase === 'write' || m.phase === 'text') && m.playing;
    entry.classList.toggle('telephone-off', !typing || sent);
    input.disabled = !typing || sent;
    sendBtn.disabled = !typing || sent;
    paintSugs(sugBox, { sugs: m.phase === 'write' && m.playing ? m.sugs : [], sent });
    syncBoard(m);
    paintWait(waitBox, { show: stepping && (sent || !m.playing || m.pass), sent, working: m.working.map((p) => ({ id: p.id, name: p.name, initials: p.initials, hue: p.hue, avatar: p.avatar })) });
    const r = m.reveal
      ? { ...m.reveal, entries: m.reveal.entries.map((e) => ({ ...e, did: REACTS.map((_, x) => local.reacted.has(`${m.run}.${m.reveal.c}.${e.i}.${x}`)), ref: e.k !== 'd' && !e.mine && !e.miss && !e.gone && e.t && !isStarterText(e.t) ? textRef(m.run, m.reveal.c, e.i) : null })) }
      : null;
    if (paintReveal(revealBox, r)) drawEntries(next.state);
    paintAwards(awardBox, { phase: m.phase, note: m.note, awards: m.awards });
    paintFlags(next, m);
    paintFoot(foot, { text: footText(m, sent) });
    el.dataset.phase = m.phase;
    hear(m);
    autoSend(m);
  }

  if (typeof w.setInterval === 'function') ticker = w.setInterval(() => snap && update(engine.snapshot()), TICK_MS);
  paintStrokes(ctx, [], painter);

  return {
    el,
    update,
    destroy() {
      gone = true;
      if (ticker !== null && typeof w.clearInterval === 'function') w.clearInterval(ticker);
      if (typeof w.removeEventListener === 'function') {
        w.removeEventListener('keydown', onKeys);
        w.removeEventListener('pointerup', lifted);
        w.removeEventListener('pointercancel', lifted);
      }
      if (writeTimer !== null) w.clearTimeout(writeTimer);
      writeTimer = null;
    },
  };
}
