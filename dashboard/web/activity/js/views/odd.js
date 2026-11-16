import odd, { REVEAL_MS, INTRO_MS, TURN_MS, VOTE_MS, GUESS_MS, PEN_SIZE, STROKE_POINTS, CAP_MAX, fitStroke, compact } from '../games/odd.js';
import { GRID_W, GRID_H, COLORS, ERASER, FILL, readInk, liveMessage, applyLive, pruneLive, quantise, strokeOn as inkStroke, fillOn, createPainter } from '../games/ink.js';
import { SCALE, LIVE_MS, LIVE_CHARS, boardRows, BOARD_MAX, fillTool, markTool, flagModel, flagButton, flagDrawing, FLAG_ICON } from './draw.js';
import { h, memo, timer, avatar, profileButton, button, plural } from '../ui/dom.js';
import { board as scoreBoard } from '../ui/board.js';

const QUIET = { play() {}, burst() {}, float() {} };
const SPANS = { intro: INTRO_MS, draw: TURN_MS, vote: VOTE_MS, guess: GUESS_MS, reveal: REVEAL_MS };

export function nameOf(p, me = 'You') {
  if (!p) return 'Someone';
  return p.isMe ? me : p.name;
}

export function timerLabel(m) {
  if (m.phase === 'intro') return 'Drawing starts in';
  if (m.phase === 'draw') return 'Time left for this line';
  if (m.phase === 'vote') return 'Time left to vote';
  if (m.phase === 'guess') return 'Time left to guess';
  return m.r < m.rounds ? 'Next round in' : 'Results in';
}

export function roleText(m) {
  if (m.role === 'odd') return { title: "You're the Odd One Out!", line: `The topic is ${m.topic.name}.`, hint: "You don't know the word. Watch the others, blend in, and don't get caught." };
  if (m.role === 'crew') return { title: 'The word is', word: m.word, line: `Topic: ${m.topic.name}`, hint: 'Draw so your friends can tell you know it, but not so clearly that the faker figures it out.' };
  if (m.waiting) return { title: "You're in from the next round", line: `This round's topic is ${m.topic.name}.`, hint: 'Watch the drawing and see if you can spot the faker.' };
  return { title: "You're watching this round", line: `The topic is ${m.topic.name}.`, hint: 'Join the game to play next round.' };
}

export function bannerText(m) {
  if (m.phase === 'intro') return m.role === 'odd' ? 'Shh! Act natural. The drawing starts in a moment.' : 'Read your card. The drawing starts in a moment.';
  if (m.phase === 'draw') {
    if (m.hiddenMine) return "Your lines were hidden, so you sit out the rest of this drawing.";
    if (m.myTurn) return 'Your turn! Draw ONE line, then let go.';
    return `${nameOf(m.turn)} is adding a line…`;
  }
  if (m.phase === 'vote' && m.note === 'host' && m.canVote) return 'The host changed, so the vote started over. Please vote again!';
  if (m.phase === 'vote') return m.role === 'odd' ? 'Vote for someone else to throw them off!' : 'Who was faking it? Tap their name.';
  if (m.phase === 'guess') return m.canGuess ? 'You got caught! Pick the secret word to steal the win.' : `${nameOf(m.odd)} got caught! They get one guess at the word…`;
  return '';
}

export function headline(m) {
  const who = nameOf(m.odd);
  const was = m.odd && m.odd.isMe ? 'were' : 'was';
  if (m.note === 'left') return `${who} left, so this round ends here.`;
  if (m.note === 'few') return 'Too many people left, so this round ends here.';
  if (!m.caught) return m.odd && m.odd.isMe ? 'You got away with it!' : `${who} got away with it!`;
  if (m.stole) return m.odd && m.odd.isMe ? 'Caught, but you guessed the word! Sneaky!' : `Caught, but ${who} guessed the word! Sneaky!`;
  return `Caught! ${who} ${was} the Odd One Out.`;
}

export function guessLine(m) {
  if (m.note || !m.caught) return null;
  const who = m.odd && m.odd.isMe ? 'You' : m.odd ? m.odd.name : 'They';
  if (!m.guess) return `${who} ran out of time to guess.`;
  return m.stole ? `${who} picked "${m.guess}". Right!` : `${who} guessed "${m.guess}". Not quite!`;
}

export function footText(m) {
  if (m.phase === 'intro') return m.r === 1 ? `Round ${m.r} of ${m.rounds}. Everyone takes turns adding one line.` : `Round ${m.r} of ${m.rounds}. New word, new faker!`;
  if (m.phase === 'draw') return `Line ${Math.min(m.turnNo, m.turns)} of ${m.turns}`;
  if (m.phase === 'vote') {
    const count = `${m.voted} of ${plural(m.voters, 'player', 'players')} voted`;
    if (m.role === 'watch') return `You're watching. ${count}`;
    return m.myVote !== null ? `Vote in! ${count}` : count;
  }
  if (m.phase === 'guess') return m.canGuess ? 'One guess. Make it count!' : 'Fingers crossed…';
  if (m.gained) return `+${m.gained} for you this round.`;
  if (m.role === 'watch' || m.note) return 'Nobody scores this round.';
  return 'No points for you this round.';
}

export function oddMoments(was, m) {
  const lines = m.seats.reduce((a, s) => a + (s.isMe ? 0 : s.lines), 0);
  const now = { r: m.r, phase: m.phase, n: m.n, lines };
  if (!was) return { now, cues: [] };
  const cues = [];
  const sameRound = was.r === m.r;
  const moved = !sameRound || was.phase !== m.phase;
  if (sameRound && lines > was.lines) cues.push({ name: 'pop', opts: { volume: 0.45 } });
  if (m.phase === 'draw' && m.myTurn && (moved || was.n !== m.n)) cues.push({ name: 'turn' });
  if (moved && m.phase === 'vote') cues.push({ name: 'whoosh' });
  if (moved && m.phase === 'guess') cues.push({ name: m.canGuess ? 'turn' : 'reveal' });
  if (moved && m.phase === 'reveal') {
    cues.push({ name: 'reveal' });
    if (m.role !== 'watch' && !m.note) cues.push({ name: m.gained > 0 ? 'correct' : 'wrong', opts: { at: 360 }, at: 'gain' });
  }
  return { now, cues };
}

export function wonRound(m) {
  if (m.phase !== 'reveal' || m.note) return false;
  if (m.role === 'odd') return !m.caught || m.stole;
  if (m.role === 'crew') return m.caught && !m.stole;
  return false;
}

function strokeOn(ctx, s, from = 0) {
  inkStroke(ctx, s, SCALE, from);
}

function dot(color, cls = null) {
  return h('span', { class: ['odd-dot', cls], vars: { '--ink': color }, attrs: { 'aria-hidden': 'true' } });
}

function faces(list) {
  if (!list.length) return null;
  return h(
    'span',
    { class: 'faces', attrs: { title: list.map((p) => (p.isMe ? 'You' : p.name)).join(', ') } },
    list.slice(0, 7).map((p) => profileButton(p, 'xs')),
    list.length > 7 ? h('span', { class: 'faces-more', text: `+${list.length - 7}` }) : null,
  );
}

export function createOddView({ engine, fx, toast, win, cues }) {
  const cue = cues && typeof cues.play === 'function' ? cues : QUIET;
  const w = win || globalThis;
  const say = typeof toast === 'function' ? toast : () => {};
  const el = h('section', { class: 'game game-odd', attrs: { 'aria-label': 'Odd One Out' } });
  const head = h('div', { class: 'odd-head' });
  const roleBox = h('div', { class: 'odd-rolewrap' });
  const seatsBox = h('div', { class: 'odd-seatswrap' });
  const banner = h('div', { class: 'odd-bannerwrap', attrs: { 'aria-live': 'polite' } });
  const actBox = h('div', { class: 'odd-act' });
  const canvas = h('canvas', { class: 'ink-canvas', attrs: { width: GRID_W * SCALE, height: GRID_H * SCALE, role: 'img', 'aria-label': 'The shared drawing' } });
  const paper = h('div', { class: 'paper odd-paper' }, canvas);
  const penTag = h('div', { class: 'odd-pen' });
  const tool = { fill: false };
  const penBtn = h(
    'button',
    {
      class: ['size', 'tool-pen', 'is-on'],
      type: 'button',
      dataset: { key: 'tool-pen' },
      attrs: { 'aria-label': 'Pen: draw one line', 'aria-pressed': 'true', title: 'Pen' },
      on: { click: () => setTool(false) },
    },
    h('span', { class: 'tool-pen-icon', text: '✏️', attrs: { 'aria-hidden': 'true' } }),
  );
  const fillBtn = fillTool(false, () => setTool(!tool.fill));
  const tools = h('div', { class: 'draw-tools odd-tools', attrs: { role: 'toolbar', 'aria-label': 'Drawing tools' } }, h('div', { class: 'tool-row' }, h('div', { class: 'sizes' }, penBtn, fillBtn)));
  const board = h('div', { class: 'draw-board odd-board' }, paper, tools, penTag);
  const foot = h('div', { class: 'game-foot', attrs: { role: 'status', 'aria-live': 'polite' } });
  const scores = h('div', { class: 'draw-scores odd-scores' });
  const flagBox = h('div', { class: 'flag-slot' });
  board.insertBefore(flagBox, tools);
  const flagged = new Set();
  el.append(head, roleBox, seatsBox, banner, actBox, board, foot, scores);
  const ctx = typeof canvas.getContext === 'function' ? canvas.getContext('2d', { willReadFrequently: true }) : null;
  const painter = createPainter(SCALE);

  const local = { at: null, vote: null, hidden: false };
  const seen = { k: null, sig: null, strokes: [] };
  const live = new Map();
  let liveTurn = null;
  let pending = null;
  let cur = null;
  let sent = 0;
  let liveTimer = null;
  let frame = null;
  let model = null;
  let heard = null;
  let cheered = null;
  let snapLast = null;

  function blank() {
    if (!ctx) return;
    ctx.fillStyle = COLORS[ERASER];
    ctx.fillRect(0, 0, GRID_W * SCALE, GRID_H * SCALE);
  }

  function setTool(fill) {
    tool.fill = Boolean(fill);
    markTool(penBtn, !tool.fill);
    markTool(fillBtn, tool.fill);
    board.classList.toggle('is-filling', tool.fill);
    if (snapLast) update(snapLast);
  }

  function paint() {
    const list = seen.strokes.concat([...live.keys()].sort((a, b) => a - b).map((si) => live.get(si)));
    if (pending) list.push(pending.stroke);
    if (cur) list.push(cur);
    painter.paint(ctx, list);
  }

  function stopFrame() {
    if (frame === null) return;
    if (frame.raf !== null && typeof w.cancelAnimationFrame === 'function') w.cancelAnimationFrame(frame.raf);
    if (frame.t !== null && typeof w.clearTimeout === 'function') w.clearTimeout(frame.t);
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
    if (typeof w.setTimeout === 'function') frame.t = w.setTimeout(run, 120);
    if (typeof w.requestAnimationFrame === 'function') frame.raf = w.requestAnimationFrame(run);
  }

  function canDraw() {
    return Boolean(model && model.myTurn && model.k === seen.k && model.myColorIndex !== null && !(pending && pending.n === model.n));
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
    if (cur.pts.length >= STROKE_POINTS) {
      cur.pts = compact(cur.pts);
      sent = 0;
    }
  }

  function fillAt(p) {
    stopFrame();
    paint();
    const s = { c: model.myColorIndex, z: FILL, pts: [p] };
    if (fillOn(ctx, s, SCALE) === 0) return;
    const msg = liveMessage(seen.k, seen.strokes.length, 0, s.pts, s);
    engine.broadcast(msg);
    pending = { n: model.n, k: model.k, base: seen.strokes.length, stroke: s };
    cue.play('send');
    engine.act({ type: 'fill', n: model.n, x: p[0], y: p[1] });
    if (snapLast) update(snapLast);
  }

  function onDown(e) {
    if (!canDraw() || cur) return;
    const p = pointOf(e);
    if (!p) return;
    e.preventDefault();
    if (tool.fill) {
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
    cur = { c: model.myColorIndex, z: PEN_SIZE, pts: [p], si: seen.strokes.length, n: model.n };
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
    if (!model || !model.myTurn || model.n !== s.n) {
      repaint();
      return;
    }
    const parts = fitStroke(s.pts, s.c, s.z, CAP_MAX);
    if (!parts) {
      say("That line didn't take. Try again!");
      repaint();
      return;
    }
    pending = { n: s.n, k: model.k, base: seen.strokes.length, stroke: { c: s.c, z: s.z, pts: s.pts } };
    cue.play('send');
    engine.act({ type: 'stroke', n: s.n, s: parts });
    repaint();
    if (snapLast) update(snapLast);
  }

  function queueLive() {
    if (liveTimer !== null || typeof w.setTimeout !== 'function') return;
    liveTimer = w.setTimeout(() => {
      liveTimer = null;
      sendLive();
    }, LIVE_MS);
  }

  function sendLive() {
    if (!cur || cur.pts.length <= sent || seen.k === null) return;
    const msg = liveMessage(seen.k, cur.si, sent, cur.pts, cur);
    sent = cur.pts.length;
    if (msg.s.length <= LIVE_CHARS) engine.broadcast(msg);
  }

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('lostpointercapture', onUp);

  const offMessage = engine.on('message', ({ data, by }) => {
    if (!model || model.myTurn || !model.turn || !data || by !== model.turn.id) return;
    const list = data.t === 'many' && Array.isArray(data.m) ? data.m : [data];
    let hit = false;
    for (const msg of list) {
      if (!msg || msg.t !== 'ink' || msg.k !== seen.k) continue;
      if (Number.isInteger(msg.si) && msg.si < seen.strokes.length) continue;
      if (applyLive(live, msg)) hit = true;
    }
    if (hit) repaint();
  });

  function vote(m, target) {
    if (!m.canVote || local.at === m.voteAt) return;
    local.at = m.voteAt;
    local.vote = target;
    cue.play('send');
    engine.act({ type: 'vote', target, r: m.r });
    if (snapLast) update(snapLast);
  }

  function guess(m, i) {
    if (!m.canGuess) return;
    cue.play('send');
    engine.act({ type: 'guess', i, r: m.r });
  }

  function toggleCard() {
    local.hidden = !local.hidden;
    cue.play('toggle');
    if (snapLast) update(snapLast);
  }

  const paintHead = memo((m) =>
    h(
      'div',
      { class: 'game-head' },
      h('span', { class: 'chip chip-static', text: `Round ${m.r} of ${m.rounds}` }),
      h('span', { class: 'chip chip-static odd-topic', text: `${m.topic.emoji} ${m.topic.name}` }),
      m.phase === 'draw' || m.phase === 'intro' ? h('span', { class: 'game-count', text: `Lap ${Math.max(1, m.lap)} of ${m.laps}` }) : null,
      timer(m.ends - (m.phase === 'draw' && m.turnMs ? m.turnMs : SPANS[m.phase] || REVEAL_MS), m.ends, m.label),
    ),
  );

  const paintRole = memo((m) => {
    if (m.phase === 'reveal') return null;
    const t = roleText(m);
    const hideBtn = m.role === 'watch' ? null : button(m.hidden ? 'Show my card' : 'Hide', { variant: 'ghost', size: 'sm', key: 'odd-hide', on: toggleCard, attrs: { 'aria-pressed': m.hidden ? 'true' : 'false' } });
    if (m.hidden) {
      return h('div', { class: ['odd-role', 'is-hidden'] }, h('span', { class: 'odd-role-icon', text: '🙈', attrs: { 'aria-hidden': 'true' } }), h('p', { class: 'odd-role-line', text: 'Your card is hidden.' }), hideBtn);
    }
    return h(
      'div',
      { class: ['odd-role', `is-${m.role}`], attrs: { 'aria-label': 'Your role this round' } },
      h('span', { class: 'odd-role-icon', text: m.role === 'odd' ? '🕵️' : m.role === 'crew' ? '🔒' : '👀', attrs: { 'aria-hidden': 'true' } }),
      h(
        'div',
        { class: 'odd-role-body' },
        h('p', { class: 'odd-role-title', text: t.title }),
        t.word ? h('p', { class: 'odd-role-word', text: t.word }) : null,
        h('p', { class: 'odd-role-line', text: t.line }),
        h('p', { class: 'odd-role-hint muted', text: t.hint }),
      ),
      hideBtn,
    );
  });

  const paintSeats = memo((m) =>
    h(
      'ol',
      { class: 'odd-seats', attrs: { 'aria-label': 'Drawing order' } },
      m.seats.map((s) =>
        h(
          'li',
          { class: ['odd-seat', s.up ? 'is-up' : null, s.present ? null : 'is-away', s.isMe ? 'is-me' : null, s.isOdd ? 'is-odd' : null], attrs: { title: s.isMe ? 'You' : s.name } },
          dot(s.color),
          s.up ? h('span', { class: 'fx-acting odd-acting' }, profileButton(s, 'xs')) : profileButton(s, 'xs'),
          h('span', { class: 'odd-seat-name', text: s.isMe ? 'You' : s.name }),
          s.lines ? h('span', { class: 'odd-seat-lines', text: `✏️${s.lines}`, attrs: { 'aria-label': plural(s.lines, 'line', 'lines') } }) : null,
          s.voted ? h('span', { class: 'got-tick', text: '✓', attrs: { 'aria-label': 'Voted' } }) : null,
          s.isOdd ? h('span', { class: 'odd-seat-badge', text: '🕵️', attrs: { 'aria-label': 'The Odd One Out' } }) : null,
          s.hidden ? h('span', { class: 'odd-seat-flag', text: FLAG_ICON, attrs: { 'aria-label': 'Lines hidden', title: 'Lines hidden' } }) : null,
        ),
      ),
    ),
  );

  const paintBanner = memo((m) => {
    if (!m.text) return null;
    return h('p', { class: ['odd-banner', m.mine ? 'is-mine' : null] }, m.color ? dot(m.color) : null, h('span', { text: m.text }));
  });

  function votePanel(m) {
    return h(
      'div',
      { class: 'odd-votes', attrs: { role: 'group', 'aria-label': 'Vote for the faker' } },
      m.seats
        .filter((s) => !s.isMe)
        .map((s) =>
          h(
            'button',
            {
              class: ['odd-pick', 'spot', m.myVote === s.slot ? 'is-mine' : null, s.present ? null : 'is-away'],
              type: 'button',
              disabled: !m.canVote,
              dataset: { key: `vote-${s.slot}` },
              attrs: { 'aria-pressed': m.myVote === s.slot ? 'true' : 'false', 'aria-label': `Vote for ${s.name}` },
              on: { click: () => vote(m, s.slot) },
            },
            dot(s.color),
            avatar(s, 'sm'),
            h('span', { class: 'odd-pick-name', text: s.name }),
            m.myVote === s.slot ? h('span', { class: 'odd-pick-tag', text: 'Your vote' }) : null,
          ),
        ),
    );
  }

  function guessPanel(m) {
    return h(
      'div',
      { class: 'pick-grid odd-guess' },
      m.choices.map((c) =>
        button(c.word, {
          variant: m.canGuess ? 'secondary' : 'ghost',
          size: 'lg',
          key: `guess-${c.i}`,
          disabled: !m.canGuess,
          on: () => guess(m, c.i),
        }),
      ),
    );
  }

  function revealCard(m) {
    const line = guessLine(m);
    const won = wonRound(m);
    return h(
      'div',
      { class: ['reveal-card', 'odd-reveal', m.caught && !m.stole ? 'is-caught' : 'is-escaped'], attrs: { 'aria-label': 'How the round went' } },
      h('p', { class: 'odd-reveal-head fx-display', text: headline(m) }),
      m.odd ? h('div', { class: 'odd-reveal-who' }, profileButton(m.odd, 'md'), h('span', { class: 'odd-reveal-name', text: m.odd.isMe ? 'You were the Odd One Out' : `${m.odd.name} was the Odd One Out` })) : null,
      h('p', { class: 'word-line' }, h('span', { class: 'muted', text: 'The word was ' }), h('strong', { class: 'word-reveal', text: m.word || '???' })),
      line ? h('p', { class: 'odd-reveal-guess', text: line }) : null,
      m.tally.length
        ? h(
            'ul',
            { class: 'odd-tally', attrs: { 'aria-label': 'Votes' } },
            m.tally.map((t) =>
              h(
                'li',
                { class: ['odd-tally-row', t.isOdd ? 'is-odd' : null] },
                profileButton(t, 'xs'),
                h('span', { class: 'odd-tally-name', text: t.isMe ? 'You' : t.name }),
                h('span', { class: 'odd-tally-count', text: plural(t.count, 'vote', 'votes') }),
                faces(t.by),
              ),
            ),
          )
        : m.note
          ? null
          : h('p', { class: 'reveal-none muted', text: 'Nobody voted this round.' }),
      m.gains.length
        ? h(
            'ul',
            { class: 'reveal-got', attrs: { 'aria-label': 'Points this round' } },
            m.gains.map((g) => h('li', { class: ['reveal-guess', g.isMe ? 'is-me' : null] }, profileButton(g, 'xs'), h('span', { class: 'reveal-name', text: g.isMe ? 'You' : g.name }), h('span', { class: 'reveal-pts fx-num', text: `+${g.pts}` }))),
          )
        : null,
      won ? h('p', { class: 'odd-won', text: m.role === 'odd' ? 'Faker wins!' : 'Team win!' }) : null,
    );
  }

  const paintAct = memo((m) => {
    if (m.phase === 'vote') return votePanel(m);
    if (m.phase === 'guess') return guessPanel(m);
    if (m.phase === 'reveal') return revealCard(m);
    return null;
  });

  const paintPen = memo((m) => {
    if (!m.show) return null;
    return h('p', { class: 'odd-pen-tag' }, dot(m.color), h('span', { text: m.pending ? 'Sent! Nice.' : m.fill ? 'Tap an area to fill it with your color. One fill only!' : 'Your pen color. One line only!' }));
  });

  const paintFoot = memo((m) => h('span', { class: 'foot-text', text: m.text }));
  const paintScores = memo((m) => scoreBoard(m.rows, { empty: 'Points show up here after each round.', label: 'Points this game', max: BOARD_MAX }));

  function syncInk(m, state) {
    if (seen.k !== m.k) {
      live.clear();
      seen.k = m.k;
      seen.sig = null;
      pending = null;
      cur = null;
    }
    const turnKey = m.phase === 'draw' ? m.n : null;
    if (liveTurn !== turnKey) {
      liveTurn = turnKey;
      live.clear();
    }
    const ink = readInk(state, m.k);
    let dirty = false;
    if (ink.sig !== seen.sig) {
      seen.sig = ink.sig;
      seen.strokes = ink.strokes;
      pruneLive(live, ink.strokes.length);
      dirty = true;
    }
    if (pending && (pending.k !== m.k || seen.strokes.length > pending.base || m.n >= pending.n + 2 || (m.phase !== 'draw' && m.phase !== 'vote'))) {
      pending = null;
      dirty = true;
    }
    if (cur && !m.myTurn) {
      cur = null;
      dirty = true;
    }
    if (dirty) repaint();
  }

  const paintFlag = memo((f) => flagButton(f, () => flag(), f ? f.note : null));

  function flag() {
    if (!snapLast) return;
    flagDrawing({ engine, snap: snapLast, game: 'odd', item: odd.drawingOf(snapLast), local: flagged, toast: say });
    update(engine.snapshot());
  }

  function flagFor(next, m) {
    const item = odd.drawingOf(next);
    const f = flagModel(next, item, flagged);
    if (!f) return null;
    const by = m.seats.find((s) => s.slot === item.drawer);
    return { ...f, note: by ? `Latest line by ${by.isMe ? 'you' : by.name}` : null };
  }

  function update(next) {
    snapLast = next;
    const m = odd.model(next, local);
    model = m;
    if (!m) {
      roleBox.replaceChildren(h('p', { class: 'waiting', text: 'Getting the first round ready…' }));
      return;
    }
    syncInk(m, next.state);
    const people = new Map(m.seats.map((s) => [s.slot, s]));
    paintHead(head, { r: m.r, rounds: m.rounds, topic: m.topic, phase: m.phase, lap: m.lap, laps: m.laps, ends: m.ends, turnMs: m.turnMs, label: timerLabel(m) });
    paintRole(roleBox, { phase: m.phase, role: m.role, word: m.word, topic: m.topic, waiting: m.waiting, hidden: local.hidden && m.role !== 'watch' });
    paintSeats(seatsBox, { seats: m.seats.map((s) => ({ slot: s.slot, id: s.id, name: s.name, initials: s.initials, hue: s.hue, avatar: s.avatar, isMe: s.isMe, present: s.present, color: s.color, up: s.up, lines: s.lines, voted: s.voted, isOdd: s.isOdd, hidden: s.hidden })) });
    paintFlag(flagBox, flagFor(next, m));
    const turnSeat = m.turn ? people.get(m.turn.slot) : null;
    paintBanner(banner, { text: bannerText(m), mine: m.myTurn, color: m.phase === 'draw' && turnSeat ? turnSeat.color : null });
    const gains = Object.entries(m.gains)
      .map(([slot, pts]) => ({ ...(people.get(Number(slot)) || { slot: Number(slot), name: 'Player', initials: 'P', hue: 20, isMe: false }), pts }))
      .filter((g) => g.pts > 0)
      .sort((a, b) => b.pts - a.pts || a.slot - b.slot)
      .map((g) => ({ slot: g.slot, id: g.id, name: g.name, initials: g.initials, hue: g.hue, avatar: g.avatar, isMe: g.isMe, pts: g.pts }));
    paintAct(actBox, {
      phase: m.phase,
      r: m.r,
      voteAt: m.voteAt,
      seats: m.seats.map((s) => ({ slot: s.slot, id: s.id, name: s.name, initials: s.initials, hue: s.hue, avatar: s.avatar, isMe: s.isMe, present: s.present, color: s.color })),
      canVote: m.canVote,
      myVote: m.myVote,
      choices: m.choices,
      canGuess: m.canGuess,
      odd: m.odd ? { slot: m.odd.slot, id: m.odd.id, name: m.odd.name, initials: m.odd.initials, hue: m.odd.hue, avatar: m.odd.avatar, isMe: m.odd.isMe } : null,
      word: m.word,
      guess: m.guess,
      caught: m.caught,
      stole: m.stole,
      note: m.note,
      role: m.role,
      tally: m.tally.map((t) => ({ slot: t.slot, id: t.id, name: t.name, initials: t.initials, hue: t.hue, avatar: t.avatar, isMe: t.isMe, isOdd: t.isOdd, count: t.count, by: t.by.map((b) => ({ id: b.id, name: b.name, initials: b.initials, hue: b.hue, avatar: b.avatar, isMe: b.isMe })) })),
      gains,
    });
    paintPen(penTag, { show: m.myTurn && m.myColor !== null, color: m.myColor, pending: Boolean(pending && pending.n === m.n), fill: tool.fill });
    paintFoot(foot, { text: footText(m) });
    foot.classList.toggle('is-good', m.phase === 'reveal' && m.gained > 0);
    paintScores(scores, { rows: boardRows(next, m.phase === 'draw' && m.turn ? m.turn.slot : null) });
    el.dataset.phase = m.phase;
    board.classList.toggle('is-drawing', canDraw());
    const first = heard === null;
    const { now, cues: list } = oddMoments(heard, m);
    heard = now;
    for (const c of list) {
      cue.play(c.name, c.opts);
      if (c.at === 'gain' && m.gained) {
        const card = actBox.querySelector('.odd-reveal');
        if (card) cue.burst(card, { count: 16, emoji: m.role === 'odd' ? ['🕵️', '🎉'] : ['🎯', '🎉'] });
      }
    }
    if (wonRound(m) && cheered !== m.r) {
      cheered = m.r;
      if (!first && fx && typeof fx.confetti === 'function') fx.confetti(40);
    }
  }

  blank();

  return {
    el,
    update,
    destroy() {
      offMessage();
      if (liveTimer !== null && typeof w.clearTimeout === 'function') w.clearTimeout(liveTimer);
      stopFrame();
    },
  };
}
