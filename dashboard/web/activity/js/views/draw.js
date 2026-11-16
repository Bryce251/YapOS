import draw, { GUESS_CHARS, REVEAL_MS, PICK_MS } from '../games/draw.js';
import { GRID_W, GRID_H, COLORS, SIZES, SIZE_NAMES, ERASER, CUSTOM, MAX_CHUNKS, FILL, inkKey, fitInk, readInk, liveMessage, applyLive, pruneLive, quantise, decodeStroke, strokeOn as inkStroke, fillOn, createPainter } from '../games/ink.js';
import { h, memo, timer, avatar, button, plural } from '../ui/dom.js';
import { board as scoreBoard, standings } from '../ui/board.js';
import { person } from '../players.js';
import { hidesWords } from '../text.js';
import { HIDDEN_NOTE } from '../filter.js';
import { flagInfo } from '../engine.js';
import { sendReport } from '../admin.js';
import { createPalette, dropTool, pixelAt, canvasPixel } from './palette.js';

export const SCALE = 2;
export const LIVE_MS = 250;
export const WRITE_GAP_MS = 900;
export const LIVE_CHARS = 3000;

const TIER_LABEL = { easy: 'Easy', medium: 'Medium', hard: 'Hard' };

export const FLAG_ICON = '🚩';
export const FLAG_TITLE = 'Flag this drawing if it breaks the rules. When enough players flag it, it gets hidden.';
export const FLAG_THANKS = 'Thanks for flagging. The drawing was also sent to the YapOS team.';
export const FLAG_FAIL = "That didn't go through. Try again in a moment.";
export const HIDDEN_TEXT = 'This drawing was hidden.';

export function flagModel(snap, item, local = null) {
  if (!snap || !item || !snap.meJoined) return null;
  const me = snap.meSlot;
  if (!Number.isInteger(me) || me === item.drawer) return null;
  const info = flagInfo(snap, item.d, item.drawer, Array.isArray(item.viewers) ? item.viewers : null);
  const mine = info.mine || Boolean(local && local.has(item.d));
  return { d: item.d, count: Math.max(info.count, mine ? 1 : 0), need: info.need, mine };
}

export function flagLabel(f) {
  if (f.mine) return `Flagged (${Math.min(f.count, f.need)} of ${f.need})`;
  return f.count ? `Flag (${Math.min(f.count, f.need)} of ${f.need})` : 'Flag';
}

export function flagButton(f, onFlag, note = null) {
  if (!f) return null;
  return h(
    'div',
    { class: 'flag-row' },
    note ? h('span', { class: 'flag-note', text: note }) : null,
    button(flagLabel(f), {
      variant: 'ghost',
      size: 'sm',
      key: 'flag',
      disabled: f.mine,
      on: () => onFlag(f.d),
      attrs: { title: FLAG_TITLE, 'aria-label': f.mine ? flagLabel(f) : `${flagLabel(f)}: report this drawing`, 'aria-pressed': f.mine ? 'true' : 'false' },
      kids: h('span', { class: 'btn-icon flag-icon', text: FLAG_ICON, attrs: { 'aria-hidden': 'true' } }),
    }),
  );
}

export function reportOf(snap, game, item) {
  if (!snap || !item) return null;
  const players = Array.isArray(snap.players) ? snap.players : [];
  const drawer = players.find((p) => p.slot === item.drawer);
  const me = players.find((p) => p.isMe);
  if (!drawer || !drawer.id || !me) return null;
  const prof = person({ id: drawer.id, name: drawer.name }) || {};
  return {
    game,
    drawer: { id: drawer.id, name: drawer.name, username: drawer.username || prof.username || null },
    reporter: { id: me.id, name: me.name },
    ink: Array.isArray(item.ink) ? item.ink : [],
    word: typeof item.word === 'string' && item.word ? item.word : null,
    at: Date.now(),
  };
}

export function flagDrawing({ engine, snap, game, item, local, toast }) {
  const say = (t) => {
    if (typeof toast === 'function') toast(t);
  };
  if (!item || !engine || typeof engine.flag !== 'function' || !engine.flag(item.d)) {
    say(FLAG_FAIL);
    return false;
  }
  if (local) local.add(item.d);
  const body = reportOf(snap, game, item);
  if (body) sendReport(item.d, body).catch(() => false);
  say(FLAG_THANKS);
  return true;
}

export function footText(m) {
  if (m.phase === 'pick') return m.amDrawer ? 'Pick the word you want to draw.' : 'Get ready to guess! The drawing starts in a moment.';
  if (m.phase === 'reveal') {
    let lead = "Time's up!";
    if (m.note === 'all') lead = 'Everyone got it!';
    if (m.note === 'left') lead = `${m.drawer.name} left, so this turn ended early.`;
    if (m.note === 'skip') lead = 'An admin skipped this turn.';
    if (m.note === 'hidden') lead = `${HIDDEN_TEXT} No points for the drawer.`;
    if (m.amDrawer && m.drawerGain) return `${lead} +${m.drawerGain} for your drawing.`;
    if (m.gained) return `${lead} +${m.gained} for you.`;
    return lead;
  }
  if (m.amDrawer) return m.got.length ? `${m.got.length} guessed it so far. Keep drawing!` : 'Draw the word. No letters or numbers!';
  if (m.gotMe) return `You got it! +${m.myPts}. Wait for the others.`;
  if (m.spectator) return "You're watching. Join the game to guess too.";
  return 'Type your guess below.';
}

export function countText(m) {
  const base = plural(m.letters, 'letter', 'letters');
  return m.words > 1 ? `${base} · ${plural(m.words, 'word', 'words')}` : base;
}

export function feedLine(f) {
  if (f.kind === 'ok') return 'guessed the word!';
  if (f.kind === 'close') return f.mine ? `${f.text} · so close!` : 'is so close!';
  return f.text;
}

export const PENCIL = '✏️';
export const BOARD_MAX = 12;

export function handleText(p) {
  return p && !p.isMe && typeof p.username === 'string' && p.username ? `@${p.username}` : null;
}

export function gainText(m) {
  if (!m.drawerGain) return 'No points for the drawing this time';
  return m.amDrawer ? `+${m.drawerGain} for your drawing` : `+${m.drawerGain} for the drawing`;
}

export function boardRows(snap, drawerSlot) {
  return standings(snap.players || [], 'game')
    .filter((p) => p.present || p.pts > 0)
    .slice(0, BOARD_MAX)
    .map((p) => {
      const prof = person({ id: p.id, name: p.name }) || {};
      const drawing = drawerSlot !== null && drawerSlot !== undefined && p.slot === drawerSlot;
      return {
        id: p.id,
        slot: p.slot,
        name: p.name,
        username: p.username || prof.username || null,
        initials: p.initials,
        hue: p.hue,
        avatar: p.avatar || prof.avatar || null,
        pts: p.pts,
        place: p.place,
        isMe: p.isMe,
        present: p.present,
        badge: drawing ? { icon: PENCIL, label: 'Drawing now' } : null,
      };
    });
}

function who(p, { verb = '', me = 'You', size = 'sm', cls = null } = {}) {
  const handle = handleText(p);
  return h(
    'span',
    { class: ['who', cls] },
    avatar(p, size),
    h(
      'span',
      { class: 'who-text' },
      h('span', { class: 'who-line' }, h('strong', { class: 'who-name', text: p.isMe ? me : p.name }), verb && !p.isMe ? h('span', { class: 'who-verb', text: ` ${verb}` }) : null),
      handle ? h('span', { class: 'who-handle', text: handle }) : null,
    ),
  );
}

function markDrawer(list, rows) {
  if (!list || list.localName !== 'ol') return list;
  const i = rows.findIndex((r) => r.badge);
  if (i < 0) return list;
  const marked = list.querySelector('[data-badge], .board-badge, .board-role');
  if (marked) return list;
  const li = Array.from(list.children)[i];
  if (li) {
    li.classList.add('is-drawing');
    li.append(h('span', { class: 'draw-pencil', text: PENCIL, attrs: { title: rows[i].badge.label, 'aria-label': rows[i].badge.label } }));
  }
  return list;
}

function strokeOn(ctx, s, from = 0) {
  inkStroke(ctx, s, SCALE, from);
}

export function fillTool(on, toggle) {
  return h(
    'button',
    {
      class: ['size', 'tool-fill', on ? 'is-on' : null],
      type: 'button',
      dataset: { key: 'tool-fill' },
      attrs: { 'aria-label': 'Bucket fill', 'aria-pressed': on ? 'true' : 'false', title: 'Bucket fill: tap an area to fill it' },
      on: { click: () => toggle() },
    },
    h('span', { class: 'tool-fill-icon', text: '🪣', attrs: { 'aria-hidden': 'true' } }),
  );
}

export function tintOfPen(pen) {
  return pen.c === CUSTOM && typeof pen.rgb === 'string' ? { c: CUSTOM, rgb: pen.rgb } : { c: pen.c };
}

export function pickTint(t) {
  return t.c === CUSTOM ? { c: CUSTOM, rgb: t.rgb, drop: false } : { c: t.c, rgb: undefined, drop: false };
}

export function markTool(btn, on) {
  btn.classList.toggle('is-on', on);
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
}

export function chunkStrokes(chunks) {
  const out = [];
  for (const ch of chunks || []) {
    for (const s of ch.s || []) {
      const d = decodeStroke(s);
      if (d) out.push(d);
    }
  }
  return out;
}

const QUIET = { play() {}, burst() {}, float() {} };

export function feedIds(state) {
  const st = state && state.draw;
  return st && Array.isArray(st.feed) ? st.feed.map((f) => (Array.isArray(f) ? Number(f[0]) || 0 : 0)) : [];
}

export function drawMoments(was, m, fids = []) {
  const feedTop = fids.reduce((a, id) => Math.max(a, id), 0);
  const now = { n: m.n, phase: m.phase, got: m.got.map((g) => g.slot), feedTop };
  if (!was) return { now, cues: [] };
  const cues = [];
  const sameTurn = was.n === m.n;
  if (!sameTurn && m.amDrawer) cues.push({ name: 'turn' });
  if (sameTurn) {
    const fresh = m.got.filter((g) => !was.got.includes(g.slot));
    if (fresh.some((g) => g.isMe)) cues.push({ name: 'correct', opts: { volume: 1 }, at: 'guess' });
    else if (fresh.length) cues.push({ name: 'correct', opts: { volume: 0.45 } });
    const missed = m.feed.some((f, i) => (fids[i] || 0) > was.feedTop && f.mine && f.kind !== 'ok');
    if (missed && !fresh.some((g) => g.isMe)) cues.push({ name: 'type', opts: { volume: 0.3 } });
  }
  if (m.phase === 'reveal' && (!sameTurn || was.phase !== 'reveal')) {
    cues.push({ name: 'reveal' });
    if (m.amDrawer && m.drawerGain) cues.push({ name: 'coin', opts: { at: 380 }, at: 'gain' });
  }
  return { now, cues };
}

export function createDrawView({ engine, fx, toast, win, cues }) {
  const cue = cues && typeof cues.play === 'function' ? cues : QUIET;
  const el = h('section', { class: 'game game-draw', attrs: { 'aria-label': 'Draw & Guess' } });
  const head = h('div', { class: 'draw-headwrap' });
  const wordBar = h('div', { class: 'draw-word', attrs: { 'aria-live': 'polite' } });
  const pickBox = h('div', { class: 'draw-pick' });
  const gotBox = h('div', { class: 'draw-got' });
  const canvas = h('canvas', { class: 'ink-canvas', attrs: { width: GRID_W * SCALE, height: GRID_H * SCALE, role: 'img', 'aria-label': 'The drawing' } });
  const paper = h('div', { class: 'paper' }, canvas);
  const ctx = typeof canvas.getContext === 'function' ? canvas.getContext('2d', { willReadFrequently: true }) : null;
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
  const clearBtn = button('Clear', { variant: 'ghost', size: 'sm', key: 'clear', on: () => clearAll() });
  const tools = h(
    'div',
    { class: 'draw-tools', attrs: { role: 'toolbar', 'aria-label': 'Drawing tools' } },
    palette.el,
    palette.pop,
    h('div', { class: 'tool-row' }, h('div', { class: 'sizes' }, sizes, fillBtn, dropBtn), h('div', { class: 'tool-actions' }, undoBtn, clearBtn)),
  );
  const board = h('div', { class: 'draw-board' }, paper, tools);
  const feedBox = h('div', { class: 'feed-wrap' });
  const input = h('input', {
    class: 'word-input',
    dataset: { key: 'guess-input' },
    attrs: { type: 'text', maxlength: GUESS_CHARS, autocomplete: 'off', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'send', 'aria-label': 'Your guess', placeholder: 'Type your guess' },
  });
  const sendBtn = button('Guess', { variant: 'primary', key: 'guess-send', on: () => submit() });
  const guessRow = h('div', { class: 'entry-row guess-row' }, input, sendBtn);
  const side = h('div', { class: 'draw-side' }, feedBox, guessRow);
  const foot = h('div', { class: 'game-foot', attrs: { role: 'status', 'aria-live': 'polite' } });
  const revealBox = h('div', { class: 'draw-reveal' });
  const boardBox = h('div', { class: 'draw-scores' });
  const flagBox = h('div', { class: 'flag-slot' });
  const hiddenTag = h('p', { class: 'paper-hidden', text: HIDDEN_TEXT, attrs: { 'aria-hidden': 'true' } });
  paper.append(hiddenTag);
  board.insertBefore(flagBox, tools);
  el.append(head, wordBar, revealBox, gotBox, pickBox, h('div', { class: 'draw-main' }, board, side), foot, boardBox);
  const flagged = new Set();

  const mine = { k: null, strokes: [], shown: [], level: 0, count: 0, chunks: [] };
  const live = new Map();
  const seen = { k: null, sig: null, strokes: [] };
  let cur = null;
  let sent = 0;
  let liveTimer = null;
  let writeTimer = null;
  let lastWrite = 0;
  let lastFeed = 0;
  let feedTurn = null;
  let snap = null;
  let model = null;
  let wasGot = false;
  let frame = null;
  let shownMode = null;
  let heard = null;

  function hear(m, fids) {
    const { now, cues: list } = drawMoments(heard, m, fids);
    heard = now;
    for (const c of list) {
      cue.play(c.name, c.opts);
      if (c.at === 'guess') cue.burst(wordBar, { count: 18, emoji: ['🎉', '✏️'] });
      if (c.at === 'gain') {
        const gain = revealBox.querySelector('.reveal-gain');
        if (gain) cue.float(gain, `+${m.drawerGain}`);
      }
    }
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

  function sample(e) {
    if (frame !== null) {
      stopFrame();
      paint();
    }
    const at = canvasPixel(canvas, e);
    const hex = at ? pixelAt(ctx, at[0], at[1]) : null;
    if (!hex) return;
    palette.take(hex);
    setPen({ drop: false, fill: false });
  }

  function blank() {
    if (!ctx) return;
    ctx.fillStyle = COLORS[ERASER];
    ctx.fillRect(0, 0, GRID_W * SCALE, GRID_H * SCALE);
  }

  function paint() {
    blank();
    if (model && model.hidden) return;
    if (shownMode === 'mine') {
      painter.paint(ctx, cur ? mine.shown.concat([cur]) : mine.shown);
      return;
    }
    painter.paint(ctx, seen.strokes.concat([...live.keys()].sort((a, b) => a - b).map((si) => live.get(si))));
  }

  function stopFrame() {
    if (frame === null) return;
    if (frame.raf !== null && typeof win.cancelAnimationFrame === 'function') win.cancelAnimationFrame(frame.raf);
    if (frame.t !== null) win.clearTimeout(frame.t);
    frame = null;
  }

  function repaint() {
    if (frame !== null) return;
    const run = () => {
      if (frame === null) return;
      stopFrame();
      paint();
    };
    frame = { raf: null, t: null };
    frame.t = win.setTimeout(run, 120);
    if (typeof win.requestAnimationFrame === 'function') frame.raf = win.requestAnimationFrame(run);
  }

  function canDraw() {
    return Boolean(model && model.amDrawer && model.phase === 'draw' && mine.k === model.k);
  }

  function pointOf(e) {
    const r = canvas.getBoundingClientRect();
    if (!r || !r.width || !r.height) return null;
    return quantise(((e.clientX - r.left) / r.width) * GRID_W, ((e.clientY - r.top) / r.height) * GRID_H);
  }

  function addPoint(p) {
    if (!cur || !p) return;
    const last = cur.pts[cur.pts.length - 1];
    if (last && last[0] === p[0] && last[1] === p[1]) return;
    cur.pts.push(p);
  }

  function fillAt(p) {
    stopFrame();
    paint();
    const s = { ...tintOfPen(pen), z: FILL, pts: [p] };
    if (fillOn(ctx, s, SCALE) === 0) return;
    const msg = liveMessage(mine.k, mine.count, 0, s.pts, s);
    engine.broadcast(msg);
    mine.strokes.push(s);
    commit(true);
  }

  function onDown(e) {
    if (!canDraw() || cur) return;
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
    if (typeof canvas.setPointerCapture === 'function' && e.pointerId !== undefined) {
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        sent = 0;
      }
    }
    cur = { ...tintOfPen(pen), z: pen.z, pts: [p], si: mine.count };
    sent = 0;
    strokeOn(ctx, cur);
    queueLive();
  }

  function onMove(e) {
    if (!cur) return;
    e.preventDefault();
    const before = cur.pts.length;
    const list = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    for (const x of list.length ? list : [e]) addPoint(pointOf(x));
    if (cur.pts.length > before) {
      strokeOn(ctx, cur, before);
      queueLive();
    }
  }

  function onUp() {
    if (!cur) return;
    const s = cur;
    sendLive();
    cur = null;
    if (!canDraw()) return;
    mine.strokes.push(s.c === CUSTOM ? { c: s.c, rgb: s.rgb, z: s.z, pts: s.pts } : { c: s.c, z: s.z, pts: s.pts });
    commit(true);
  }

  function queueLive() {
    if (liveTimer !== null) return;
    liveTimer = win.setTimeout(() => {
      liveTimer = null;
      sendLive();
    }, LIVE_MS);
  }

  function sendLive() {
    if (!cur || cur.pts.length <= sent || mine.k === null) return;
    const msg = liveMessage(mine.k, cur.si, sent, cur.pts, cur);
    sent = cur.pts.length;
    if (msg.s.length <= LIVE_CHARS) engine.broadcast(msg);
  }

  function commit(added) {
    const fit = fitInk(mine.strokes, mine.k, mine.level);
    if (!fit) {
      if (added) mine.strokes.pop();
      toast('The canvas is full. Undo or clear to keep drawing.');
      engine.broadcast({ t: 'ink', k: mine.k, cut: mine.count });
      repaint();
      return;
    }
    mine.level = fit.level;
    mine.chunks = fit.chunks;
    mine.count = fit.count;
    mine.shown = chunkStrokes(fit.chunks);
    queueWrite();
  }

  function queueWrite() {
    if (writeTimer !== null) return;
    const wait = Math.max(0, lastWrite + WRITE_GAP_MS - Date.now());
    writeTimer = win.setTimeout(writeNow, wait);
  }

  function writeNow() {
    writeTimer = null;
    if (!model || !model.amDrawer || mine.k !== model.k || model.phase !== 'draw') return;
    lastWrite = Date.now();
    for (let i = 0; i < MAX_CHUNKS; i += 1) engine.direct(inkKey(i), mine.chunks[i] || null);
  }

  function undo() {
    if (!canDraw() || cur || !mine.strokes.length) return;
    mine.strokes.pop();
    commit(false);
    engine.broadcast({ t: 'ink', k: mine.k, cut: mine.count });
    repaint();
  }

  function clearAll() {
    if (!canDraw() || cur || !mine.strokes.length) return;
    mine.strokes = [];
    mine.level = 0;
    commit(false);
    engine.broadcast({ t: 'ink', k: mine.k, cut: 0 });
    repaint();
  }

  function needsRepair(state) {
    for (let i = 0; i < MAX_CHUNKS; i += 1) {
      const want = mine.chunks[i] || null;
      const have = state[inkKey(i)] || null;
      if (!want && (!have || have.k !== mine.k)) continue;
      if (JSON.stringify(want) !== JSON.stringify(have)) return true;
    }
    return false;
  }

  function submit() {
    if (!model || !model.canGuess) return;
    const text = input.value.replace(/\s+/g, ' ').trim().slice(0, GUESS_CHARS);
    if (!text) return;
    engine.act({ type: 'guess', text });
    input.value = '';
    if (hidesWords(text) && typeof toast === 'function') toast(HIDDEN_NOTE);
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
  });
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('lostpointercapture', onUp);

  const offMessage = engine.on('message', ({ data, by }) => {
    if (!model || model.amDrawer || model.hidden || !data || by !== model.drawer.id) return;
    const list = data.t === 'many' && Array.isArray(data.m) ? data.m : [data];
    let hit = false;
    for (const msg of list) {
      if (!msg || msg.t !== 'ink' || msg.k !== model.k) continue;
      if (Number.isInteger(msg.si) && msg.si < seen.strokes.length) continue;
      if (applyLive(live, msg)) hit = true;
    }
    if (hit) repaint();
  });

  const paintHead = memo((m) =>
    h(
      'div',
      { class: 'game-head' },
      h('span', { class: 'chip chip-static', text: `Round ${m.round} of ${m.rounds}` }),
      who(m.drawer, { verb: m.phase === 'pick' ? 'is up next' : 'is drawing', me: m.phase === 'pick' ? "You're up next" : "You're drawing", size: 'sm', cls: 'drawer-tag' }),
      timer(m.timerStarts, m.ends, m.phase === 'pick' ? 'Time left to pick' : m.phase === 'reveal' ? 'Next turn in' : 'Time left to draw'),
    ),
  );

  const paintWord = memo((m) => {
    if (m.phase === 'reveal') return h('p', { class: 'word-line' }, h('span', { class: 'muted', text: 'The word was ' }), h('strong', { class: 'word-reveal', text: m.word || '???' }));
    if (m.phase === 'pick') {
      if (m.amDrawer) return h('p', { class: 'word-line muted', text: 'Your turn to draw! Pick a word.' });
      return h('div', { class: 'word-line pick-wait' }, who(m.drawer, { verb: 'is picking a word…', size: 'md', cls: 'who-big' }));
    }
    if (m.amDrawer) return h('p', { class: 'word-line' }, h('span', { class: 'muted', text: 'Draw this: ' }), h('strong', { class: 'word-secret', text: m.word }));
    if (!m.hint) return null;
    return h(
      'p',
      { class: 'word-line', attrs: { 'aria-label': m.gotMe ? `The word is ${m.hint.join('')}` : `${plural(m.letters, 'letter', 'letters')}` } },
      h('span', { class: ['blanks', m.gotMe ? 'is-solved' : null], attrs: { 'aria-hidden': 'true' } }, m.hint.map((ch) => h('span', { class: ['blank', ch === ' ' ? 'is-gap' : null, ch !== '_' && ch !== ' ' ? 'is-open' : null], text: ch === '_' ? '' : ch }))),
      h('span', { class: 'blank-count', text: countText(m) }),
    );
  });

  const paintGot = memo((m) => {
    if (m.phase !== 'draw' || !m.got.length) return null;
    return h(
      'div',
      { class: 'got-row', attrs: { 'aria-label': 'Already guessed it' } },
      h('span', { class: 'got-label muted', text: 'Got it:' }),
      h('ul', { class: 'got-list' }, m.got.map((g) => h('li', { class: ['got-item', g.isMe ? 'is-me' : null], attrs: { title: g.isMe ? 'You' : g.name } }, avatar(g, 'xs'), h('span', { class: 'got-name', text: g.isMe ? 'You' : g.name }), h('span', { class: 'got-tick', text: '✓', attrs: { 'aria-hidden': 'true' } })))),
    );
  });

  const paintReveal = memo((m) => {
    if (m.phase !== 'reveal') return null;
    return h(
      'div',
      { class: 'reveal-card', attrs: { 'aria-label': 'How the turn went' } },
      h(
        'div',
        { class: 'reveal-drawer' },
        who(m.drawer, { verb: 'drew this', me: 'You drew this', size: 'md', cls: 'who-big' }),
        h('span', { class: ['reveal-gain', m.drawerGain ? null : 'is-zero'], text: gainText(m) }),
      ),
      m.got.length
        ? h(
            'ul',
            { class: 'reveal-got', attrs: { 'aria-label': 'Who guessed it' } },
            m.got.map((g) => h('li', { class: ['reveal-guess', g.isMe ? 'is-me' : null] }, avatar(g, 'xs'), h('span', { class: 'reveal-name', text: g.isMe ? 'You' : g.name }), h('span', { class: 'reveal-pts', text: `+${g.pts}` }))),
          )
        : h('p', { class: 'reveal-none muted', text: 'Nobody guessed it this time.' }),
    );
  });

  const paintScores = memo((m) => markDrawer(scoreBoard(m.rows, { empty: 'Points show up here as you score.', label: 'Points this game', max: BOARD_MAX, badge: m.badge }), m.rows));

  const paintPick = memo((m) => {
    if (m.phase !== 'pick' || !m.amDrawer) return null;
    return h(
      'div',
      { class: 'pick-grid' },
      m.choices.map((c) =>
        button(c.word, {
          variant: 'secondary',
          size: 'lg',
          key: `word-${c.i}`,
          on: () => engine.act({ type: 'pick', i: c.i, n: m.n }),
          kids: h('span', { class: 'pick-tier', text: TIER_LABEL[c.tier] || '' }),
        }),
      ),
    );
  });

  const paintFeed = memo((m) =>
    h(
      'ol',
      { class: 'feed', attrs: { 'aria-label': 'Guesses', 'aria-live': 'polite' } },
      m.feed.length
        ? m.feed.map((f) =>
            h(
              'li',
              { class: ['feed-item', `is-${f.kind}`, f.mine ? 'is-me' : null] },
              avatar(f, 'xs'),
              h('span', { class: 'feed-name', text: f.isMe ? 'You' : f.name }),
              h('span', { class: 'feed-text', text: feedLine(f) }),
            ),
          )
        : h('li', { class: 'feed-empty muted', text: m.phase === 'draw' ? 'Guesses show up here.' : 'Get ready to guess!' }),
    ),
  );

  const paintFoot = memo((m) => h('span', { class: 'foot-text', text: footText(m) }));

  const paintFlag = memo((f) => flagButton(f, () => flag()));

  function flag() {
    if (!snap) return;
    flagDrawing({ engine, snap, game: 'draw', item: draw.drawingOf(snap), local: flagged, toast });
    update(engine.snapshot());
  }

  function showHidden(on) {
    paper.classList.toggle('is-hidden', on);
    hiddenTag.setAttribute('aria-hidden', on ? 'false' : 'true');
    if (on && live.size) live.clear();
  }

  function dropStale(m) {
    if (mine.k === null || (m.amDrawer && m.phase === 'draw' && mine.k === m.k)) return;
    if (writeTimer !== null) {
      win.clearTimeout(writeTimer);
      writeTimer = null;
    }
    if (typeof engine.drop === 'function') engine.drop('ink.', (v) => v !== null && (m.phase !== 'draw' || !v || v.k !== m.k));
  }

  function syncInk(m, state) {
    dropStale(m);
    if (m.amDrawer) {
      if (mine.k !== m.k) {
        if (cur) cur = null;
        const back = readInk(state, m.k);
        mine.k = m.k;
        mine.strokes = back.strokes;
        mine.level = 0;
        const fit = fitInk(mine.strokes, mine.k, 0);
        mine.chunks = fit ? fit.chunks : [];
        mine.count = fit ? fit.count : 0;
        mine.level = fit ? fit.level : 0;
        mine.shown = chunkStrokes(mine.chunks);
        shownMode = 'mine';
        repaint();
      } else if (shownMode !== 'mine') {
        shownMode = 'mine';
        repaint();
      }
      if (m.phase === 'draw' && writeTimer === null && needsRepair(state)) queueWrite();
      return;
    }
    const ink = readInk(state, m.k);
    if (seen.k !== m.k) {
      live.clear();
      seen.k = m.k;
      seen.sig = null;
    }
    if (ink.sig !== seen.sig || shownMode !== 'seen') {
      seen.sig = ink.sig;
      seen.strokes = ink.strokes;
      pruneLive(live, ink.strokes.length);
      shownMode = 'seen';
      repaint();
    }
  }

  function update(next) {
    snap = next;
    const m = draw.model(next);
    model = m;
    if (!m) {
      swapEmpty();
      return;
    }
    const timerStarts = m.phase === 'reveal' ? m.ends - REVEAL_MS : m.phase === 'pick' ? m.ends - PICK_MS : m.starts;
    paintHead(head, { round: m.round, rounds: m.rounds, drawer: m.drawer, phase: m.phase, timerStarts, ends: m.ends });
    paintWord(wordBar, { phase: m.phase, amDrawer: m.amDrawer, word: m.word, hint: m.hint, letters: m.letters, words: m.words, gotMe: m.gotMe, drawer: m.drawer });
    paintReveal(revealBox, { phase: m.phase, drawer: m.drawer, drawerGain: m.drawerGain, amDrawer: m.amDrawer, got: m.got.map((g) => ({ id: g.id, slot: g.slot, name: g.name, initials: g.initials, hue: g.hue, avatar: g.avatar, isMe: g.isMe, pts: g.pts })) });
    paintScores(boardBox, { rows: boardRows(next, m.drawer.slot), badge: { slot: m.drawer.slot, id: m.drawer.id, icon: PENCIL, label: 'Drawing now' } });
    paintGot(gotBox, { phase: m.phase, got: m.got.map((g) => ({ id: g.id, slot: g.slot, name: g.name, initials: g.initials, hue: g.hue, avatar: g.avatar, isMe: g.isMe })) });
    paintPick(pickBox, { phase: m.phase, amDrawer: m.amDrawer, choices: m.choices, n: m.n });
    paintFeed(feedBox, { feed: m.feed, phase: m.phase });
    paintFoot(foot, m);
    el.dataset.phase = m.phase;
    board.classList.toggle('is-drawing', canDraw() || (m.amDrawer && m.phase === 'draw'));
    if (!(m.amDrawer && m.phase === 'draw')) palette.close(false);
    side.classList.toggle('is-guessing', m.canGuess);
    input.disabled = !m.canGuess;
    sendBtn.disabled = !m.canGuess;
    const wasHidden = paper.classList.contains('is-hidden');
    showHidden(m.hidden);
    syncInk(m, next.state);
    if (m.hidden !== wasHidden) repaint();
    paintFlag(flagBox, flagModel(next, draw.drawingOf(next), flagged));
    undoBtn.disabled = !m.amDrawer || !mine.strokes.length;
    clearBtn.disabled = !m.amDrawer || !mine.strokes.length;
    if (feedTurn !== m.n) {
      feedTurn = m.n;
      lastFeed = 0;
    }
    const fids = feedIds(next.state);
    m.feed.forEach((f, i) => {
      if ((fids[i] || 0) <= lastFeed) return;
      if (f.mine && f.kind === 'close' && m.phase === 'draw') toast('So close! Check your spelling.');
    });
    lastFeed = fids.length ? fids[fids.length - 1] : lastFeed;
    hear(m, fids);
    if (m.gotMe && !wasGot) fx.confetti(30);
    wasGot = m.gotMe;
    if (m.phase !== 'draw' && cur) cur = null;
  }

  function swapEmpty() {
    wordBar.replaceChildren(h('p', { class: 'waiting', text: 'Getting the first turn ready…' }));
  }

  const ticker = typeof win.setInterval === 'function' ? win.setInterval(() => snap && update(engine.snapshot()), 1000) : null;
  blank();

  return {
    el,
    update,
    destroy() {
      offMessage();
      if (ticker !== null && typeof win.clearInterval === 'function') win.clearInterval(ticker);
      if (liveTimer !== null) win.clearTimeout(liveTimer);
      if (writeTimer !== null) win.clearTimeout(writeTimer);
      stopFrame();
    },
  };
}
