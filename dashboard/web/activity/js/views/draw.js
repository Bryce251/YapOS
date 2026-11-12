import draw, { GUESS_CHARS, REVEAL_MS, PICK_MS } from '../games/draw.js';
import { GRID_W, GRID_H, COLORS, COLOR_NAMES, SIZES, SIZE_NAMES, ERASER, MAX_CHUNKS, inkKey, fitInk, readInk, liveMessage, applyLive, pruneLive, quantise } from '../games/ink.js';
import { h, memo, timer, avatar, button, plural } from '../ui/dom.js';

export const SCALE = 2;
export const LIVE_MS = 250;
export const WRITE_GAP_MS = 900;
export const LIVE_CHARS = 3000;

const TIER_LABEL = { easy: '🟢 Easy', medium: '🟡 Medium', hard: '🔴 Hard' };

export function footText(m) {
  if (m.phase === 'pick') return m.amDrawer ? 'Pick the word you want to draw.' : 'Get ready to guess! The drawing starts in a moment.';
  if (m.phase === 'reveal') {
    let lead = "Time's up!";
    if (m.note === 'all') lead = 'Everyone got it!';
    if (m.note === 'left') lead = `${m.drawer.name} left, so this turn ended early.`;
    if (m.amDrawer && m.drawerGain) return `${lead} +${m.drawerGain} for your drawing.`;
    if (m.gained) return `${lead} +${m.gained} for you.`;
    return lead;
  }
  if (m.amDrawer) return m.got.length ? `${m.got.length} guessed it so far. Keep drawing!` : 'Draw the word. No letters or numbers!';
  if (m.gotMe) return `You got it! +${m.myPts}. Wait for the others.`;
  return 'Type your guess below.';
}

export function countText(m) {
  const base = plural(m.letters, 'letter', 'letters');
  return m.words > 1 ? `${base} · ${plural(m.words, 'word', 'words')}` : base;
}

export function feedLine(f) {
  if (f.kind === 'ok') return 'guessed the word! 🎉';
  if (f.kind === 'close') return f.mine ? `${f.text} · so close!` : 'is so close!';
  return f.text;
}

function strokeOn(ctx, s, from = 0) {
  if (!ctx || !s || !s.pts.length) return;
  ctx.strokeStyle = COLORS[s.c] || COLORS[1];
  ctx.fillStyle = COLORS[s.c] || COLORS[1];
  ctx.lineWidth = (SIZES[s.z] || SIZES[1]) * SCALE;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const pts = s.pts;
  if (pts.length === 1) {
    ctx.beginPath();
    ctx.arc(pts[0][0] * SCALE, pts[0][1] * SCALE, ctx.lineWidth / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  const start = Math.max(0, from - 1);
  ctx.beginPath();
  ctx.moveTo(pts[start][0] * SCALE, pts[start][1] * SCALE);
  for (let i = start + 1; i < pts.length; i += 1) ctx.lineTo(pts[i][0] * SCALE, pts[i][1] * SCALE);
  ctx.stroke();
}

export function createDrawView({ engine, fx, toast, win }) {
  const el = h('section', { class: 'game game-draw', attrs: { 'aria-label': 'Draw & Guess' } });
  const head = h('div', { class: 'draw-headwrap' });
  const wordBar = h('div', { class: 'draw-word', attrs: { 'aria-live': 'polite' } });
  const pickBox = h('div', { class: 'draw-pick' });
  const gotBox = h('div', { class: 'draw-got' });
  const canvas = h('canvas', { class: 'ink-canvas', attrs: { width: GRID_W * SCALE, height: GRID_H * SCALE, role: 'img', 'aria-label': 'The drawing' } });
  const paper = h('div', { class: 'paper' }, canvas);
  const ctx = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
  const pen = { c: 1, z: 1 };
  const swatches = COLORS.map((col, i) =>
    h('button', {
      class: ['swatch', i === ERASER ? 'is-eraser' : null, i === pen.c ? 'is-on' : null],
      type: 'button',
      dataset: { key: i === ERASER ? 'eraser' : `color-${i}` },
      vars: { '--sw': col },
      attrs: { 'aria-label': COLOR_NAMES[i], 'aria-pressed': i === pen.c ? 'true' : 'false', title: COLOR_NAMES[i] },
      on: { click: () => setPen({ c: i }) },
    }, i === ERASER ? h('span', { class: 'swatch-icon', text: '🧽', attrs: { 'aria-hidden': 'true' } }) : null),
  );
  const sizes = SIZES.map((z, i) =>
    h('button', {
      class: ['size', i === pen.z ? 'is-on' : null],
      type: 'button',
      dataset: { key: `size-${i}` },
      vars: { '--dot': `${Math.max(4, Math.min(26, z))}px` },
      attrs: { 'aria-label': `${SIZE_NAMES[i]} pen`, 'aria-pressed': i === pen.z ? 'true' : 'false', title: SIZE_NAMES[i] },
      on: { click: () => setPen({ z: i }) },
    }, h('span', { class: 'size-dot', attrs: { 'aria-hidden': 'true' } })),
  );
  const undoBtn = button('Undo', { variant: 'ghost', size: 'sm', key: 'undo', on: () => undo() });
  const clearBtn = button('Clear', { variant: 'ghost', size: 'sm', key: 'clear', on: () => clearAll() });
  const tools = h(
    'div',
    { class: 'draw-tools', attrs: { role: 'toolbar', 'aria-label': 'Drawing tools' } },
    h('div', { class: 'swatches' }, swatches),
    h('div', { class: 'tool-row' }, h('div', { class: 'sizes' }, sizes), h('div', { class: 'tool-actions' }, undoBtn, clearBtn)),
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
  el.append(head, wordBar, gotBox, pickBox, h('div', { class: 'draw-main' }, board, side), foot);

  const mine = { k: null, strokes: [], level: 0, count: 0, chunks: [] };
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

  function setPen(p) {
    Object.assign(pen, p);
    swatches.forEach((b, i) => {
      b.classList.toggle('is-on', i === pen.c);
      b.setAttribute('aria-pressed', i === pen.c ? 'true' : 'false');
    });
    sizes.forEach((b, i) => {
      b.classList.toggle('is-on', i === pen.z);
      b.setAttribute('aria-pressed', i === pen.z ? 'true' : 'false');
    });
  }

  function blank() {
    if (!ctx) return;
    ctx.fillStyle = COLORS[ERASER];
    ctx.fillRect(0, 0, GRID_W * SCALE, GRID_H * SCALE);
  }

  function paint() {
    blank();
    if (shownMode === 'mine') {
      for (const s of mine.strokes) strokeOn(ctx, s);
      if (cur) strokeOn(ctx, cur);
      return;
    }
    for (const s of seen.strokes) strokeOn(ctx, s);
    for (const si of [...live.keys()].sort((a, b) => a - b)) strokeOn(ctx, live.get(si));
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

  function onDown(e) {
    if (!canDraw() || cur) return;
    const p = pointOf(e);
    if (!p) return;
    e.preventDefault();
    if (typeof canvas.setPointerCapture === 'function' && e.pointerId !== undefined) {
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        sent = 0;
      }
    }
    cur = { c: pen.c, z: pen.z, pts: [p], si: mine.count };
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
    mine.strokes.push({ c: s.c, z: s.z, pts: s.pts });
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
    if (!model || model.amDrawer || !data || by !== model.drawer.id) return;
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
      h('span', { class: 'drawer-tag' }, avatar(m.drawer, 'xs'), h('span', { text: m.drawer.isMe ? "You're drawing" : `${m.drawer.name} is drawing` })),
      timer(m.timerStarts, m.ends, m.phase === 'pick' ? 'Time left to pick' : m.phase === 'reveal' ? 'Next turn in' : 'Time left to draw'),
    ),
  );

  const paintWord = memo((m) => {
    if (m.phase === 'reveal') return h('p', { class: 'word-line' }, h('span', { class: 'muted', text: 'The word was ' }), h('strong', { class: 'word-reveal', text: m.word || '???' }));
    if (m.phase === 'pick') return h('p', { class: 'word-line muted', text: m.amDrawer ? 'Your turn to draw! Pick a word.' : `${m.drawer.name} is picking a word…` });
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
    paintGot(gotBox, { phase: m.phase, got: m.got.map((g) => ({ id: g.id, slot: g.slot, name: g.name, initials: g.initials, hue: g.hue, avatar: g.avatar, isMe: g.isMe })) });
    paintPick(pickBox, { phase: m.phase, amDrawer: m.amDrawer, choices: m.choices, n: m.n });
    paintFeed(feedBox, { feed: m.feed, phase: m.phase });
    paintFoot(foot, m);
    el.dataset.phase = m.phase;
    board.classList.toggle('is-drawing', canDraw() || (m.amDrawer && m.phase === 'draw'));
    side.classList.toggle('is-guessing', m.canGuess);
    input.disabled = !m.canGuess;
    sendBtn.disabled = !m.canGuess;
    syncInk(m, next.state);
    undoBtn.disabled = !m.amDrawer || !mine.strokes.length;
    clearBtn.disabled = !m.amDrawer || !mine.strokes.length;
    if (feedTurn !== m.n) {
      feedTurn = m.n;
      lastFeed = 0;
    }
    for (const f of m.feed) {
      if (f.id <= lastFeed) continue;
      if (f.mine && f.kind === 'close' && m.phase === 'draw') toast('So close! Check your spelling.');
    }
    lastFeed = m.feed.length ? m.feed[m.feed.length - 1].id : lastFeed;
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
