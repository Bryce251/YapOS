import sketchduel, { VOTE_MS, RESULT_MS } from '../games/sketchduel.js';
import { INK_CHARS, INK_PARTS, validInk, inkChars } from '../games/telephone.js';
import { GRID_W, GRID_H, SIZES, SIZE_NAMES, CUSTOM, FILL, encodeParts, decodeStroke, quantise, strokeOn as inkStroke, fillOn, paintInk, createPainter } from '../games/ink.js';
import { fillTool, markTool, flagModel, flagButton, flagDrawing, tintOfPen, pickTint } from './draw.js';
import { createPalette, dropTool, pixelAt, canvasPixel } from './palette.js';
import { inkLeft, decodeAll, fitStroke, inkSig } from './telephone.js';
import { h, memo, timer, avatar, button, plural } from '../ui/dom.js';

export const SCALE = 2;
export const WRITE_GAP_MS = 700;
export const FLUSH_LEFT_MS = 1000;
export const TICK_MS = 400;

const QUIET = { play() {}, burst() {}, float() {} };

export function headline(m) {
  if (m.phase === 'draw') {
    if (m.drawing) return m.mineDone ? 'Nice! Waiting for the other artists.' : 'Draw this word. No letters or numbers!';
    return "You're a judge this round. The artists are drawing…";
  }
  if (m.phase === 'vote') return m.duel && m.duel.mySide ? 'The judges are looking at your drawing…' : 'Which drawing is better?';
  if (m.phase === 'result') return m.duel && m.duel.none ? 'Nobody was left to judge this one.' : 'The judges have spoken!';
  if (m.phase === 'lost') return 'Not enough players to keep duelling.';
  return '';
}

export function footText(m) {
  if (m.phase === 'lost') return 'Heading to the results in a moment.';
  if (m.phase === 'draw') {
    if (m.pass) return 'Everyone is done! Bringing out the drawings…';
    const left = Math.max(0, m.needCount - m.doneCount);
    if (m.drawing) return m.mineDone ? `Waiting for ${plural(left, 'artist', 'artists')}…` : m.rival ? `You're up against ${m.rival.name}.` : 'Draw away!';
    return `${plural(m.needCount, 'artist is', 'artists are')} drawing. Get ready to judge!`;
  }
  const d = m.duel;
  if (!d) return '';
  if (m.phase === 'vote') {
    if (d.mySide) return `${d.voted} of ${plural(d.judges, 'judge', 'judges')} voted. Fingers crossed!`;
    if (d.myVote) return `Vote in! ${d.voted} of ${plural(d.judges, 'judge', 'judges')} voted.`;
    return `Tap the drawing you like more. ${d.voted} of ${plural(d.judges, 'judge', 'judges')} voted.`;
  }
  if (d.none) return 'No points this time.';
  if (d.win === 'tie') return "It's a tie! Both artists get a bonus.";
  const winner = d.win === 'a' ? d.a.who : d.b.who;
  if (!d.win) return 'Nobody voted on this one.';
  return winner.isMe ? `You won the duel! +${(d.win === 'a' ? d.a : d.b).pts}` : `${winner.name} wins this duel!`;
}

export function duelMoments(was, m) {
  const key = `${m.run}:${m.round}:${m.phase}:${m.duel ? m.duel.i : -1}`;
  const now = { key, done: m.doneCount };
  if (!was) return { now, cues: [] };
  const cues = [];
  if (key !== was.key) {
    if (m.phase === 'draw' && m.drawing) cues.push('turn');
    else if (m.phase === 'vote') cues.push('whoosh');
    else if (m.phase === 'result') {
      const d = m.duel;
      const mine = d && d.mySide ? d[d.mySide] : null;
      cues.push(mine && mine.win ? 'win' : 'reveal');
    } else if (m.phase === 'lost') cues.push('leave');
  } else if (m.phase === 'draw' && m.doneCount > was.done && !m.pass) {
    cues.push('tap');
  }
  return { now, cues };
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

export function createSketchduelView({ engine, fx, toast, win, cues }) {
  const cue = cues && typeof cues.play === 'function' ? cues : QUIET;
  const say = typeof toast === 'function' ? toast : () => {};
  const w = win || globalThis;
  const el = h('section', { class: 'game game-sketchduel', attrs: { 'aria-label': 'Sketch Duel' } });
  const head = h('div', { class: 'sketchduel-headwrap' });
  const task = h('div', { class: 'sketchduel-task', attrs: { 'aria-live': 'polite' } });
  const canvas = h('canvas', { class: 'ink-canvas', attrs: { width: GRID_W * SCALE, height: GRID_H * SCALE, role: 'img', 'aria-label': 'Your drawing' } });
  const paper = h('div', { class: 'paper sketchduel-paper' }, canvas);
  const ctx = contextOf(canvas);
  const painter = createPainter(SCALE);
  const pen = { c: 1, z: 1, fill: false, drop: false };
  const palette = createPalette({ pen, onPick: (t) => setPen(pickTint(t)) });
  const sizes = SIZES.map((z, i) =>
    h(
      'button',
      {
        class: ['size', i === pen.z ? 'is-on' : null],
        type: 'button',
        dataset: { key: `size-${i}` },
        vars: { '--dot': `${Math.max(4, Math.min(26, z))}px` },
        attrs: { 'aria-label': `${SIZE_NAMES[i]} pen`, 'aria-pressed': i === pen.z ? 'true' : 'false', title: SIZE_NAMES[i] },
        on: { click: () => setPen({ z: i, fill: false, drop: false }) },
      },
      h('span', { class: 'size-dot', attrs: { 'aria-hidden': 'true' } }),
    ),
  );
  const fillBtn = fillTool(pen.fill, () => setPen({ fill: !pen.fill, drop: false }));
  const dropBtn = dropTool(pen.drop, () => setPen({ drop: !pen.drop }));
  const undoBtn = button('Undo', { variant: 'ghost', size: 'sm', key: 'undo', on: () => undo() });
  const redoBtn = button('Redo', { variant: 'ghost', size: 'sm', key: 'redo', on: () => redo() });
  const clearBtn = button('Clear', { variant: 'ghost', size: 'sm', key: 'clear', on: () => clearAll() });
  const meter = h('div', { class: 'sketchduel-meter' });
  const tools = h(
    'div',
    { class: 'draw-tools', attrs: { role: 'toolbar', 'aria-label': 'Drawing tools' } },
    palette.el,
    palette.pop,
    h('div', { class: 'tool-row' }, h('div', { class: 'sizes' }, sizes, fillBtn, dropBtn), h('div', { class: 'tool-actions' }, undoBtn, redoBtn, clearBtn)),
  );
  const doneBtn = button('Done!', { variant: 'primary', size: 'lg', key: 'duel-done', on: () => finishDrawing() });
  const editBtn = button('Keep drawing', { variant: 'ghost', key: 'duel-edit', on: () => keepDrawing() });
  const doneRow = h('div', { class: 'sketchduel-done-row' }, meter, doneBtn, editBtn);
  const board = h('div', { class: 'draw-board sketchduel-board sketchduel-off' }, paper, tools, doneRow);
  const arena = h('div', { class: 'sketchduel-arenawrap' });
  const foot = h('div', { class: 'game-foot', attrs: { role: 'status', 'aria-live': 'polite' } });
  el.append(head, task, board, arena, foot);

  const mine = { key: null, strokes: [], parts: [], used: 0, dirty: false };
  const local = { key: null, side: null };
  const flagged = new Set();
  let redoStack = [];
  let cur = null;
  let model = null;
  let snap = null;
  let writeTimer = null;
  let lastWrite = 0;
  let heard = null;
  let warned = null;
  let ticker = null;
  let shownArena = null;
  let cheered = null;

  function later(fn, ms) {
    return typeof w.setTimeout === 'function' ? w.setTimeout(fn, ms) : null;
  }

  function setPen(p) {
    Object.assign(pen, p);
    palette.mark(pen);
    sizes.forEach((b, i) => markTool(b, !pen.fill && !pen.drop && i === pen.z));
    markTool(fillBtn, pen.fill && !pen.drop);
    markTool(dropBtn, pen.drop);
    board.classList.toggle('is-filling', pen.fill && !pen.drop);
    board.classList.toggle('is-dropping', pen.drop);
  }

  function stepKey(m) {
    return `${m.run}:${m.round}:${m.k}`;
  }

  function canDraw() {
    return Boolean(model && model.phase === 'draw' && model.drawing && !model.mineDone && !model.pass && mine.key === stepKey(model));
  }

  function paintMine() {
    paintStrokes(ctx, cur ? mine.strokes.concat([cur]) : mine.strokes, painter);
  }

  function release(id) {
    if (id === undefined || id === null || typeof canvas.releasePointerCapture !== 'function') return;
    try {
      canvas.releasePointerCapture(id);
    } catch {
      return;
    }
  }

  function samePointer(e) {
    return !cur || cur.id === undefined || !e || e.pointerId === undefined || e.pointerId === cur.id;
  }

  function outOfInk(text) {
    cue.play('error');
    say(text);
  }

  function pointOf(e) {
    const r = canvas.getBoundingClientRect();
    if (!r || !r.width || !r.height) return null;
    return quantise(((e.clientX - r.left) / r.width) * GRID_W, ((e.clientY - r.top) / r.height) * GRID_H);
  }

  function count() {
    return mine.parts.flat().length;
  }

  function sample(e) {
    const at = canvasPixel(canvas, e);
    const hex = at ? pixelAt(ctx, at[0], at[1]) : null;
    if (!hex) return;
    palette.take(hex);
    setPen({ drop: false, fill: false });
  }

  function fillAt(p) {
    const parts = encodeParts({ ...tintOfPen(pen), z: FILL, pts: [p] });
    if (!parts.length || mine.used + inkChars(parts) > INK_CHARS || count() + parts.length > INK_PARTS) {
      outOfInk('Out of ink! Undo a line or tap Done.');
      return;
    }
    paintMine();
    const s = decodeStroke(parts[0]);
    if (!s || fillOn(ctx, s, SCALE) === 0) return;
    redoStack = [];
    mine.parts.push(parts);
    mine.strokes.push(s);
    mine.used += inkChars(parts);
    mine.dirty = true;
    paintMeter();
    queueWrite();
  }

  function onDown(e) {
    if (cur) commitStroke();
    if (!canDraw()) return;
    if (pen.drop) {
      e.preventDefault();
      sample(e);
      return;
    }
    if (mine.used >= INK_CHARS || count() >= INK_PARTS) {
      outOfInk('Out of ink! Undo a line or tap Done.');
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
    inkStroke(ctx, cur, SCALE);
  }

  function onMove(e) {
    if (!cur || !samePointer(e)) return;
    if (!canDraw() || cur.key !== mine.key) {
      const id = cur.id;
      cur = null;
      release(id);
      paintMine();
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
    if (cur.pts.length > before) inkStroke(ctx, cur, SCALE, before);
  }

  function onUp(e) {
    if (!cur || !samePointer(e)) return;
    commitStroke();
  }

  function commitStroke(keep = false) {
    if (!cur) return false;
    const s = cur.c === CUSTOM ? { c: cur.c, rgb: cur.rgb, z: cur.z, pts: cur.pts } : { c: cur.c, z: cur.z, pts: cur.pts };
    const { id, key, held } = cur;
    cur = null;
    if (!keep) release(id);
    if (!canDraw() || key !== mine.key) {
      paintMine();
      return false;
    }
    const fit = fitStroke(s, mine.used, count());
    if (!fit) {
      outOfInk('Out of ink! That line did not fit. Undo a line or tap Done.');
      paintMine();
      return false;
    }
    if (fit.cut) outOfInk('Out of ink! That line got cut short.');
    else if (keep) cur = { ...s, pts: [s.pts[s.pts.length - 1]], id, key, held };
    redoStack = [];
    mine.parts.push(fit.parts);
    mine.strokes.push(...decodeAll(fit.parts));
    mine.used += inkChars(fit.parts);
    mine.dirty = true;
    paintMine();
    paintMeter();
    queueWrite();
    return true;
  }

  function queueWrite() {
    if (writeTimer !== null) return;
    const wait = Math.max(0, lastWrite + WRITE_GAP_MS - Date.now());
    writeTimer = later(writeNow, wait);
    if (writeTimer === null) writeNow();
  }

  function writeNow() {
    if (writeTimer !== null && typeof w.clearTimeout === 'function') w.clearTimeout(writeTimer);
    writeTimer = null;
    if (!model || model.phase !== 'draw' || !model.drawing || !model.inkKey || mine.key !== stepKey(model)) return;
    lastWrite = Date.now();
    mine.dirty = false;
    if (engine.direct(model.inkKey, { k: model.k, s: mine.parts.flat() }) !== false) return;
    mine.dirty = true;
    if (warned === mine.key) return;
    warned = mine.key;
    cue.play('error');
    say('Your drawing did not save. Keep going, it will try again.');
  }

  function changed() {
    mine.strokes = decodeAll(mine.parts.flat());
    mine.dirty = true;
    paintMine();
    paintMeter();
    queueWrite();
  }

  function undo() {
    if (!canDraw() || cur || !mine.parts.length) return;
    const gone = mine.parts.pop();
    redoStack.push(gone);
    mine.used -= inkChars(gone);
    changed();
  }

  function redo() {
    if (!canDraw() || cur || !redoStack.length) return;
    const back = redoStack[redoStack.length - 1];
    if (mine.used + inkChars(back) > INK_CHARS || count() + back.length > INK_PARTS) {
      outOfInk('Out of ink! Undo a line or tap Done.');
      return;
    }
    redoStack.pop();
    mine.parts.push(back);
    mine.used += inkChars(back);
    changed();
  }

  function clearAll() {
    if (!canDraw() || cur || !mine.parts.length) return;
    redoStack = [];
    mine.parts = [];
    mine.used = 0;
    changed();
  }

  function finishDrawing() {
    if (!canDraw()) return;
    if (cur) commitStroke();
    writeNow();
    cue.play('send');
    engine.act({ type: 'done', r: model.round });
    refresh();
  }

  function keepDrawing() {
    if (!model || model.phase !== 'draw' || !model.mineDone || model.pass) return;
    cue.play('toggle');
    engine.act({ type: 'edit', r: model.round });
  }

  function vote(side) {
    const d = model && model.duel;
    if (!d || !d.canVote) return;
    local.key = d.key;
    local.side = side;
    cue.play('send');
    engine.act({ type: 'vote', r: model.round, d: d.i, side });
    refresh();
  }

  function flag(item) {
    if (!snap || !item) return;
    flagDrawing({ engine, snap, game: 'sketchduel', item, local: flagged, toast });
    update(engine.snapshot());
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
      h('span', { class: 'chip chip-static', text: m.phase === 'lost' ? 'Sketch Duel' : `Round ${m.round + 1} of ${m.rounds}` }),
      m.count ? h('span', { class: 'game-count', text: m.count }) : null,
      m.pass ? h('span', { class: 'game-count', text: 'Wrapping up…' }) : m.ends ? timer(m.from, m.ends, m.label) : null,
    ),
  );

  const paintTask = memo((m) =>
    h(
      'div',
      { class: ['sketchduel-task-card', m.word ? 'has-word' : null] },
      h('p', { class: 'sketchduel-lead', text: m.text }),
      m.word ? h('p', { class: 'sketchduel-word', text: m.word }) : null,
      m.rival ? h('p', { class: 'sketchduel-rival muted' }, h('span', { text: 'Versus ' }), avatar(m.rival, 'xs'), h('strong', { text: m.rival.name })) : null,
      m.lineup.length
        ? h(
            'ul',
            { class: 'sketchduel-lineup' },
            m.lineup.map((d) => h('li', { class: 'sketchduel-pair' }, avatar(d.a, 'xs'), h('span', { class: 'sketchduel-vs', text: 'vs' }), avatar(d.b, 'xs'), h('span', { class: 'sketchduel-pair-names', text: `${d.a.isMe ? 'You' : d.a.name} and ${d.b.isMe ? 'you' : d.b.name}` }))),
          )
        : null,
    ),
  );

  function sideCard(m, s) {
    const d = m.duel;
    const info = d[s];
    const reveal = m.phase === 'result';
    const picked = d.myVote === s;
    return h(
      'div',
      { class: ['sketchduel-side', `sketchduel-side-${s}`, picked ? 'is-picked' : null, reveal && info.win ? 'is-win' : null, reveal && !info.win && d.win ? 'is-lose' : null], dataset: { side: s } },
      h('div', { class: 'sketchduel-who' }, avatar(info.who, 'sm'), h('strong', { class: 'sketchduel-name', text: info.who.isMe ? 'You' : info.who.name }), reveal && info.win ? h('span', { class: 'sketchduel-crown', text: d.win === 'tie' ? '🤝' : '👑', attrs: { 'aria-hidden': 'true' } }) : null),
      h(
        'div',
        { class: ['paper', 'sketchduel-mini', info.hidden ? 'is-hidden' : null] },
        h('canvas', { class: 'ink-canvas', dataset: { duel: s }, attrs: { width: GRID_W * SCALE, height: GRID_H * SCALE, role: 'img', 'aria-label': info.hidden ? 'Hidden drawing' : `Drawing by ${info.who.isMe ? 'you' : info.who.name}` } }),
        info.hidden ? h('p', { class: 'sketchduel-blank', text: 'This drawing was hidden.' }) : info.blank ? h('p', { class: 'sketchduel-blank', text: 'Blank page!' }) : null,
      ),
      m.phase === 'vote'
        ? button(picked ? 'Your vote' : 'This one!', {
            variant: picked ? 'primary' : 'secondary',
            key: `duel-vote-${s}`,
            disabled: !d.canVote || info.hidden,
            attrs: { 'aria-pressed': picked ? 'true' : 'false', 'aria-label': `Vote for ${info.who.isMe ? 'your' : `${info.who.name}'s`} drawing` },
            on: () => vote(s),
          })
        : null,
      reveal && !d.none
        ? h(
            'div',
            { class: 'sketchduel-score' },
            h('span', { class: 'sketchduel-votes', text: plural(info.votes || 0, 'vote', 'votes') }),
            info.pts ? h('span', { class: 'sketchduel-gain', text: `+${info.pts}` }) : null,
            info.voters.length ? h('span', { class: 'faces' }, info.voters.slice(0, 6).map((p) => avatar(p, 'xs'))) : null,
          )
        : null,
      h('div', { class: 'flag-slot', dataset: { flag: s } }),
    );
  }

  const paintArena = memo((m) => {
    if (!m || !m.duel) return null;
    return h(
      'div',
      { class: 'sketchduel-arena card glass' },
      h('div', { class: 'sketchduel-arena-head' }, h('span', { class: 'game-count', text: `Duel ${m.duel.i + 1} of ${m.duel.total}` }), h('span', { class: 'chip chip-static sketchduel-chip', text: m.duel.word })),
      m.note === 'host' ? h('p', { class: 'notice', text: 'The host changed, so voting starts again. Vote again!' }) : null,
      h('div', { class: 'sketchduel-pair-view' }, sideCard(m, 'a'), h('span', { class: 'sketchduel-versus', text: 'VS', attrs: { 'aria-hidden': 'true' } }), sideCard(m, 'b')),
    );
  });

  const paintFoot = memo((t) => h('span', { class: 'foot-text', text: t.text }));

  function drawArena(state, m) {
    for (const c of arena.querySelectorAll('canvas')) {
      const s = c.dataset.duel;
      const info = m.duel && m.duel[s];
      const v = info ? state[info.key] : null;
      paintStrokes(contextOf(c), info && !info.hidden && validInk(v, m.k) ? decodeAll(v.s) : []);
    }
  }

  function paintFlags(next, m) {
    const items = m.duel ? sketchduel.drawingsOf(next) : [];
    for (const slot of arena.querySelectorAll('.flag-slot')) {
      const s = slot.dataset.flag;
      const info = m.duel && m.duel[s];
      const item = info ? items.find((x) => x.d === info.d) : null;
      const f = item ? flagModel(next, item, flagged) : null;
      const sig = JSON.stringify(f);
      if (slot.dataset.sig === sig) continue;
      slot.dataset.sig = sig;
      slot.replaceChildren(...[flagButton(f, () => flag(item))].filter(Boolean));
    }
  }

  function paintMeter() {
    const left = inkLeft(mine.used, count());
    meter.replaceChildren(
      h(
        'div',
        { class: ['sketchduel-ink', left < 0.2 ? 'is-low' : null], attrs: { role: 'meter', 'aria-label': 'Ink left', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(left * 100)) } },
        h('span', { class: 'sketchduel-ink-label', text: `Ink left ${Math.round(left * 100)}%` }),
        h('span', { class: 'sketchduel-ink-track' }, h('span', { class: 'sketchduel-ink-fill', vars: { '--ink': left.toFixed(3) } })),
      ),
    );
  }

  function syncBoard(m) {
    const drawing = m.phase === 'draw' && m.drawing;
    if (cur && (!canDraw() || cur.key !== stepKey(m))) {
      const id = cur.id;
      cur = null;
      release(id);
    }
    board.classList.toggle('sketchduel-off', !drawing);
    board.classList.toggle('is-drawing', canDraw());
    if (!canDraw()) palette.close(false);
    if (!drawing) {
      mine.key = null;
      return;
    }
    const key = stepKey(m);
    if (mine.key !== key) {
      cur = null;
      warned = null;
      mine.key = key;
      redoStack = [];
      mine.parts = [];
      mine.strokes = [];
      mine.used = 0;
      mine.dirty = false;
      const back = snap.state[m.inkKey];
      if (validInk(back, m.k)) {
        mine.parts = back.s.map((s) => [s]);
        mine.strokes = decodeAll(back.s);
        mine.used = inkChars(back.s);
      }
    }
    paintMine();
    paintMeter();
    undoBtn.disabled = !canDraw() || !mine.parts.length;
    redoBtn.disabled = !canDraw() || !redoStack.length;
    clearBtn.disabled = !canDraw() || !mine.parts.length;
    doneBtn.disabled = !canDraw();
    doneBtn.classList.toggle('sketchduel-off', m.mineDone);
    editBtn.classList.toggle('sketchduel-off', !m.mineDone || m.pass);
  }

  function autoFlush(m) {
    const now = typeof engine.now === 'function' ? engine.now() : Date.now();
    if (m.phase !== 'draw' || !m.drawing || m.pass || !m.ends) return;
    if (now >= m.ends - FLUSH_LEFT_MS) {
      if (cur && cur.pts.length > 1 && canDraw()) commitStroke(true);
      if (mine.dirty) writeNow();
    }
  }

  function refresh() {
    if (snap) update(snap);
  }

  function update(next) {
    snap = next;
    const m = sketchduel.model(next, local);
    model = m;
    if (!m) {
      paintTask(task, { text: 'Sharpening the pencils…', word: null, rival: null, lineup: [] });
      return;
    }
    const label = m.phase === 'draw' ? 'Time left to draw' : m.phase === 'vote' ? 'Time left to vote' : m.phase === 'result' ? 'Next up in' : 'Results in';
    const from = m.phase === 'vote' ? m.ends - VOTE_MS : m.phase === 'result' ? m.ends - RESULT_MS : m.starts;
    paintHead(head, { phase: m.phase, round: m.round, rounds: m.rounds, count: m.phase === 'draw' ? plural(m.duels.length, 'duel', 'duels') : '', pass: m.pass, from, ends: m.ends, label });
    paintTask(task, {
      text: headline(m),
      word: m.phase === 'draw' && m.drawing ? m.word : null,
      rival: m.phase === 'draw' && m.drawing ? m.rival : null,
      lineup: m.phase === 'draw' && !m.drawing ? m.duels.map((d) => ({ a: d.a, b: d.b })) : [],
    });
    syncBoard(m);
    const arenaModel = m.duel ? { phase: m.phase, note: m.note, duel: { ...m.duel, a: { ...m.duel.a }, b: { ...m.duel.b } } } : null;
    const repainted = paintArena(arena, arenaModel);
    const sig = m.duel ? `${m.duel.key}:${inkSig((next.state[m.duel.a.key] || {}).s)}:${inkSig((next.state[m.duel.b.key] || {}).s)}:${m.duel.a.hidden}:${m.duel.b.hidden}` : null;
    if (m.duel && (repainted || sig !== shownArena)) drawArena(next.state, m);
    shownArena = sig;
    paintFlags(next, m);
    paintFoot(foot, { text: footText(m) });
    foot.classList.toggle('is-good', m.phase === 'result' && Boolean(m.duel && m.duel.mySide && m.duel[m.duel.mySide].win));
    el.dataset.phase = m.phase;
    const { now, cues: list } = duelMoments(heard, m);
    heard = now;
    list.forEach((name) => cue.play(name));
    if (list.includes('win') && cheered !== now.key) {
      cheered = now.key;
      const me = arena.querySelector('.sketchduel-side.is-win');
      if (me) cue.burst(me, { count: 16, emoji: ['👑', '🎨'] });
      if (fx && typeof fx.confetti === 'function') fx.confetti(30);
    }
    autoFlush(m);
  }

  if (typeof w.setInterval === 'function') ticker = w.setInterval(() => snap && update(engine.snapshot()), TICK_MS);
  paintStrokes(ctx, [], painter);

  return {
    el,
    update,
    destroy() {
      if (ticker !== null && typeof w.clearInterval === 'function') w.clearInterval(ticker);
      if (typeof w.removeEventListener === 'function') {
        w.removeEventListener('keydown', onKeys);
        w.removeEventListener('pointerup', lifted);
        w.removeEventListener('pointercancel', lifted);
      }
      if (writeTimer !== null && typeof w.clearTimeout === 'function') w.clearTimeout(writeTimer);
      writeTimer = null;
    },
  };
}
