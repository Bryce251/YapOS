import reflex, { MIN_MS, MAX_MS } from '../games/reflex.js';
import { EARLY, FOOLED, GUESS, SLOW, NONE, TIPS, FAKE_TIPS, rating, pickLine } from '../../data/reflex.js';
import { h, memo, timer, avatar, plural } from '../ui/dom.js';

const QUIET = { play() {}, burst() {}, float() {} };
const MEDALS = ['🥇', '🥈', '🥉'];

function defaultPerf() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
}

export function lightAt(m, now) {
  if (!m || m.phase !== 'wait') return null;
  if (now >= m.greenAt) return 'go';
  if (m.amberAt !== null && now >= m.amberAt) return 'amber';
  return 'red';
}

export function ordinal(n) {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;
}

function seedOf(m, slot) {
  return (m.r || 0) * 7 + (Number.isInteger(slot) ? slot : 0);
}

function rated(ms) {
  const r = rating(ms);
  return r ? `${r.emoji} ${r.label}` : '';
}

export function kindText(x) {
  if (x.kind === 'ok') return `${x.ms} ms`;
  if (x.kind === 'slow') return `${x.ms} ms, too slow`;
  if (x.kind === 'early') return 'Too soon';
  if (x.kind === 'fooled') return 'Fooled by amber';
  return 'No tap';
}

export function padState(m, mine, light, slot = null) {
  if (!m) return { tone: 'idle', big: 'Get ready…', small: 'The first round is on its way.' };
  const seed = seedOf(m, slot);
  if (m.phase === 'show') {
    const r = m.mine;
    if (!r) return { tone: 'show', big: m.wasFake ? 'Fake-out round!' : 'Round over', small: m.waiting || m.watching ? "You're in from the next round." : 'Here is how everyone did.' };
    if (r.kind === 'ok') return { tone: r.fastest ? 'best' : 'show', big: `${r.ms} ms`, small: `${ordinal(r.place)} place, +${r.pts}. ${rated(r.ms)}` };
    if (r.kind === 'slow') return { tone: 'show', big: `${r.ms} ms`, small: pickLine(SLOW, seed) };
    if (r.kind === 'early') return { tone: 'early', big: 'Too soon!', small: pickLine(EARLY, seed) };
    if (r.kind === 'fooled') return { tone: 'early', big: 'Not yet meant not yet!', small: pickLine(FOOLED, seed) };
    return { tone: 'show', big: 'No tap', small: pickLine(NONE, seed) };
  }
  if (m.waiting) return { tone: 'idle', big: 'Next round!', small: "You joined near the end of this one, so you're in from the next round." };
  if (m.watching) {
    const tone = light || 'red';
    const big = tone === 'go' ? 'Green!' : tone === 'amber' ? 'Not yet…' : 'Wait for it…';
    return { tone, big, small: "You're watching this one.", watch: true };
  }
  if (mine) {
    if (mine.k === 'early') return { tone: 'early', big: 'Too soon!', small: pickLine(EARLY, seed) };
    if (mine.k === 'fooled') return { tone: 'early', big: 'Not yet meant not yet!', small: pickLine(FOOLED, seed) };
    if (mine.k === 'guess') return { tone: 'early', big: 'Too quick!', small: pickLine(GUESS, seed) };
    if (mine.k === 'slow') return { tone: 'done', big: `${mine.ms} ms`, small: `${pickLine(SLOW, seed)} Waiting for the others…` };
    return { tone: 'done', big: `${mine.ms} ms`, small: `${rated(mine.ms)}! Waiting for the others…` };
  }
  if (m.iDone) return { tone: 'done', big: 'Locked in', small: 'Waiting for the others…' };
  if (light === 'go') return { tone: 'go', big: 'TAP!', small: 'Now!' };
  if (light === 'amber') return { tone: 'amber', big: 'Not yet…', small: 'Steady… only green counts.' };
  return { tone: 'red', big: 'Wait for it…', small: pickLine(m.fakeouts && seed % 2 ? FAKE_TIPS : TIPS, seed) };
}

export function reflexMoment(was, m) {
  const now = { key: m.key, phase: m.phase };
  if (!was || was.key !== m.key || was.phase !== 'wait' || m.phase !== 'show') return { now, cues: [], burst: false };
  const fast = m.results.some((x) => x.fastest);
  const mineFast = Boolean(m.mine && m.mine.fastest);
  return { now, cues: mineFast ? ['reveal', 'correct'] : ['reveal'], burst: fast };
}

export function footText(m) {
  if (m.phase === 'wait') {
    const count = `${m.done} of ${plural(m.players, 'player', 'players')} done`;
    if (m.waiting) return `You're in from the next round. ${count}`;
    if (m.watching) return `You're watching. ${count}`;
    return count;
  }
  if (!m.results.some((x) => x.kind === 'ok')) return 'Nobody scored this round.';
  const top = m.results[0];
  const who = top.isMe ? 'You were' : `${top.name} was`;
  return `${who} fastest with ${top.ms} ms!`;
}

function faces(list) {
  if (!list.length) return null;
  return h(
    'span',
    { class: 'faces', attrs: { title: list.map((p) => (p.isMe ? 'You' : p.name)).join(', ') } },
    list.slice(0, 7).map((p) => avatar(p, 'xs')),
    list.length > 7 ? h('span', { class: 'faces-more', text: `+${list.length - 7}` }) : null,
  );
}

function placeMark(x) {
  if (x.kind !== 'ok') return x.kind === 'none' ? '·' : '✋';
  return MEDALS[x.place - 1] || String(x.place);
}

function resultRow(x) {
  return h(
    'li',
    { class: ['reflex-row', `is-${x.kind}`, x.isMe ? 'is-me' : null, x.fastest ? 'is-fast' : null] },
    h('span', { class: 'reflex-place', text: placeMark(x), attrs: { 'aria-hidden': 'true' } }),
    avatar(x, 'xs'),
    h('span', { class: 'reflex-name', text: x.isMe ? 'You' : x.name }),
    h('span', { class: 'reflex-time', text: kindText(x) }),
    x.kind === 'ok' ? h('span', { class: 'reflex-rate', text: rating(x.ms).emoji, attrs: { title: rating(x.ms).label } }) : null,
    h('span', { class: ['reflex-pts', x.pts ? null : 'is-zero'], text: x.pts ? `+${x.pts}` : '0' }),
  );
}

function bestList(m) {
  if (!m.best.length) return null;
  const top = m.best.slice(0, 5);
  const me = m.best.find((x) => x.isMe);
  const rows = me && !top.includes(me) ? top.concat([me]) : top;
  return h(
    'div',
    { class: 'reflex-best' },
    h('h3', { class: 'reflex-best-title', text: 'Best times this game' }),
    h(
      'ol',
      { class: 'reflex-best-list' },
      rows.map((x) =>
        h(
          'li',
          { class: ['reflex-best-row', x.isMe ? 'is-me' : null] },
          h('span', { class: 'reflex-best-place', text: MEDALS[x.place - 1] || `${x.place}.` }),
          avatar(x, 'xs'),
          h('span', { class: 'reflex-name', text: x.isMe ? 'You' : x.name }),
          h('span', { class: 'reflex-time', text: `${x.ms} ms` }),
        ),
      ),
    ),
  );
}

function inDialog(node) {
  for (let n = node, i = 0; n && i < 40; n = n.parentNode, i += 1) {
    if (typeof n.getAttribute === 'function' && (n.getAttribute('role') === 'dialog' || n.getAttribute('aria-modal') === 'true')) return true;
  }
  return false;
}

function topModel(m) {
  if (!m) return null;
  return { phase: m.phase, number: m.number, total: m.total, fakeouts: m.fakeouts, starts: m.starts, ends: m.ends, note: m.note, last: m.last };
}

function bottomModel(m) {
  if (!m) return null;
  if (m.phase === 'wait') return { phase: 'wait', done: m.done, players: m.players, waiting: m.waiting, watching: m.watching, doneBy: m.doneBy };
  return { phase: 'show', results: m.results, best: m.best, wasFake: m.wasFake };
}

export function createReflexView({ engine, fx, cues, win, perf } = {}) {
  const cue = cues && typeof cues.play === 'function' ? cues : QUIET;
  const clock = typeof perf === 'function' ? perf : defaultPerf;
  const w = win && typeof win.setTimeout === 'function' ? win : null;
  const el = h('section', { class: 'game game-reflex', attrs: { 'aria-label': 'Reflex' } });
  const top = h('div', { class: 'reflex-top' });
  const big = h('span', { class: 'reflex-big' });
  const small = h('span', { class: 'reflex-small' });
  const pad = h('button', { class: 'reflex-pad is-idle', type: 'button', dataset: { key: 'reflex-pad' } }, big, small);
  const live = h('p', { class: 'reflex-live', attrs: { role: 'status', 'aria-live': 'polite' } });
  const bottom = h('div', { class: 'reflex-bottom' });
  el.append(top, pad, live, bottom);
  const paintTop = memo(renderTop);
  const paintBottom = memo(renderBottom);
  let model = null;
  let mySlot = null;
  let local = { key: null, light: null, t0: null, mine: null };
  let heard = null;
  let lightTimer = null;
  let frame = null;
  let gone = false;

  function renderTop(t) {
    if (!t) return h('p', { class: 'waiting', text: 'Getting the first round ready…' });
    const show = t.phase === 'show';
    return [
      h(
        'div',
        { class: 'game-head' },
        h('span', { class: 'chip chip-static', text: t.fakeouts ? 'Fake-outs on' : 'No fake-outs' }),
        h('span', { class: 'game-count', text: `Round ${t.number} of ${t.total}` }),
        show ? timer(t.starts, t.ends, t.last ? 'Final results in' : 'Next round in') : h('span', { class: 'reflex-hint', text: 'Tap or press Space' }),
      ),
      t.note === 'host' && !show ? h('p', { class: 'notice', text: 'The host changed, so this round starts again.' }) : null,
    ];
  }

  function renderBottom(b) {
    if (!b) return null;
    if (b.phase === 'wait') {
      const m = { phase: 'wait', done: b.done, players: b.players, waiting: b.waiting, watching: b.watching };
      return h('div', { class: 'game-foot' }, h('span', { class: 'foot-text', text: footText(m) }), faces(b.doneBy));
    }
    const m = { phase: 'show', results: b.results };
    return [
      h('div', { class: ['game-foot', b.results.some((x) => x.isMe && x.pts) ? 'is-good' : null] }, h('span', { class: 'foot-text', text: footText(m) }), b.wasFake ? h('span', { class: 'chip chip-static reflex-fake', text: 'That was a fake-out round' }) : null),
      b.results.length ? h('ol', { class: 'reflex-results', attrs: { 'aria-label': 'This round' } }, b.results.map(resultRow)) : null,
      bestList(b),
    ];
  }

  function paintPad() {
    const st = padState(model, local.key === (model && model.key) ? local.mine : null, local.light, mySlot);
    pad.className = ['reflex-pad', `is-${st.tone}`, st.watch ? 'is-watch' : null].filter(Boolean).join(' ');
    if (big.textContent !== st.big) big.textContent = st.big;
    if (small.textContent !== st.small) small.textContent = st.small;
    const open = Boolean(model && model.phase === 'wait' && model.canPlay && !model.iDone && !local.mine);
    pad.disabled = !open;
    const say = st.tone === 'go' ? 'Green! Tap now.' : st.big;
    if (live.textContent !== say) live.textContent = say;
  }

  function stopTimers() {
    if (lightTimer !== null && w) w.clearTimeout(lightTimer);
    lightTimer = null;
    if (frame !== null && w && typeof w.cancelAnimationFrame === 'function') w.cancelAnimationFrame(frame);
    frame = null;
  }

  function startClock() {
    local.t0 = clock();
    if (w && typeof w.requestAnimationFrame === 'function') {
      const key = local.key;
      frame = w.requestAnimationFrame(() => {
        frame = null;
        if (local.key === key && !local.mine) local.t0 = clock();
      });
    }
  }

  function schedule() {
    if (lightTimer !== null && w) w.clearTimeout(lightTimer);
    lightTimer = null;
    if (!w || !model || model.phase !== 'wait') return;
    const at = local.light === 'red' ? (model.amberAt !== null ? model.amberAt : model.greenAt) : local.light === 'amber' ? model.greenAt : null;
    if (at === null) return;
    lightTimer = w.setTimeout(() => {
      lightTimer = null;
      syncLight(true);
    }, Math.max(0, Math.ceil(at - engine.now())));
  }

  function ensureRound(m) {
    if (local.key === m.key) return;
    stopTimers();
    const light = lightAt(m, engine.now());
    local = { key: m.key, light, t0: null, mine: null };
    if (light === 'go') startClock();
  }

  function syncLight(sound) {
    if (gone || !model || model.phase !== 'wait') return;
    const target = lightAt(model, engine.now());
    if (target !== local.light) {
      local.light = target;
      if (target === 'go') startClock();
      if (sound && model.canPlay && !model.iDone && !local.mine) cue.play(target === 'go' ? 'turn' : 'toggle');
      paintPad();
    }
    schedule();
  }

  function tap() {
    const m = model;
    if (!m || m.phase !== 'wait' || !m.canPlay || m.iDone) return;
    ensureRound(m);
    if (local.mine) return;
    if (local.light === 'go' && local.t0 !== null) {
      const ms = Math.round(clock() - local.t0);
      if (ms < MIN_MS) {
        local.mine = { k: 'guess' };
        engine.act({ type: 'early', r: m.r, on: 'guess' });
        cue.play('wrong');
      } else {
        local.mine = ms > MAX_MS ? { k: 'slow', ms } : { k: 'ok', ms };
        engine.act({ type: 'tap', r: m.r, ms });
        cue.play('tap');
        if (ms <= MAX_MS) cue.float(pad, `${ms} ms`);
      }
    } else {
      local.mine = { k: local.light === 'amber' ? 'fooled' : 'early' };
      engine.act({ type: 'early', r: m.r, on: local.light === 'amber' ? 'amber' : 'red' });
      cue.play('wrong');
    }
    stopTimers();
    paintPad();
  }

  function onKey(e) {
    if (!e || (e.key !== ' ' && e.code !== 'Space')) return;
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    const tag = t && typeof t.localName === 'string' ? t.localName : '';
    if (t && (t.isContentEditable || tag === 'input' || tag === 'textarea' || tag === 'select')) return;
    if (t && t !== pad && (tag === 'button' || tag === 'a' || tag === 'summary')) return;
    if (inDialog(t)) return;
    if (!model || model.phase !== 'wait' || !model.canPlay || model.iDone || local.mine) return;
    if (typeof e.preventDefault === 'function') e.preventDefault();
    tap();
  }

  pad.addEventListener('pointerdown', (e) => {
    if (e && typeof e.button === 'number' && e.button !== 0) return;
    tap();
  });
  pad.addEventListener('click', () => tap());
  const keyTarget = typeof document !== 'undefined' && document && typeof document.addEventListener === 'function' ? document : null;
  if (keyTarget) keyTarget.addEventListener('keydown', onKey);

  function update(snap) {
    if (gone) return;
    mySlot = snap ? snap.meSlot : null;
    const m = snap ? reflex.model(snap) : null;
    model = m;
    paintTop(top, topModel(m));
    if (!m) {
      stopTimers();
      paintPad();
      paintBottom(bottom, null);
      return;
    }
    if (m.phase === 'wait') {
      ensureRound(m);
      syncLight(true);
    } else {
      stopTimers();
    }
    paintPad();
    paintBottom(bottom, bottomModel(m));
    const { now, cues: list, burst } = reflexMoment(heard, m);
    heard = now;
    list.forEach((name, i) => cue.play(name, i ? { at: 300 } : undefined));
    if (burst) {
      const row = bottom.querySelector('.reflex-row.is-fast');
      if (row) cue.burst(row, { count: 14, emoji: ['⚡', '🎉'] });
      if (m.mine && m.mine.fastest && fx && typeof fx.confetti === 'function' && m.results.filter((x) => x.kind === 'ok').length > 1) fx.confetti(30);
    }
  }

  function destroy() {
    gone = true;
    stopTimers();
    if (keyTarget) keyTarget.removeEventListener('keydown', onKey);
  }

  return { el, update, destroy };
}
