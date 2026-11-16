import musicquiz, { REVEAL_MS, schedule, clipLength } from '../games/musicquiz.js';
import { h, memo, timer, plural, button, profileButton } from '../ui/dom.js';
import { sfx as defaultSfx } from '../ui/sfx.js';

const LETTERS = ['A', 'B', 'C', 'D'];
const QUIET = { play() {}, burst() {}, float() {} };
export const TUNE_GAIN = 0.55;
export const BARS = 7;

export function footText(m) {
  if (m.phase === 'listen') {
    const count = `${m.answered} of ${plural(m.players, 'player', 'players')} answered`;
    if (m.waiting) return `You joined near the end of this one, so you're in from the next tune. ${count}`;
    if (m.watching) return `You're watching this one. ${count}`;
    return m.iAnswered ? `Locked in! ${count}` : `Name that tune! ${count}`;
  }
  if (m.gotIt) return `You got it! +${m.myGain.toLocaleString('en-US')}`;
  if (m.myPick !== null) return 'Not this time.';
  return "Time's up!";
}

export function soundNote(state) {
  if (state === 'off') return 'Sound is off. Turn it on with the speaker button to hear the tunes.';
  if (state === 'none') return "Sound can't play on this device, but you can still guess along.";
  if (state === 'blocked') return 'Tap Play to hear the tune.';
  return null;
}

function later(w, fn, ms) {
  const set = typeof w.setTimeout === 'function' ? w.setTimeout.bind(w) : globalThis.setTimeout;
  return set(fn, ms);
}

function cancel(w, id) {
  const clear = typeof w.clearTimeout === 'function' ? w.clearTimeout.bind(w) : globalThis.clearTimeout;
  clear(id);
}

function soundOf(over) {
  if (over && typeof over === 'object') return over;
  return defaultSfx;
}

export function createTunePlayer({ sfx, win } = {}) {
  const s = soundOf(sfx);
  const w = win || globalThis;
  let ctx = null;
  let bus = null;
  let voices = [];
  let stopTimer = null;
  let playing = false;
  const listeners = new Set();

  function enabled() {
    try {
      return s.enabled !== false && (typeof s.volume !== 'number' || s.volume > 0);
    } catch {
      return true;
    }
  }

  function level() {
    const v = typeof s.volume === 'number' ? s.volume : 0.5;
    return enabled() ? Math.max(0, Math.min(1, v)) * TUNE_GAIN : 0;
  }

  function context() {
    if (ctx) return ctx;
    try {
      if (typeof s.unlock === 'function') s.unlock();
    } catch {
      ctx = null;
    }
    ctx = s.context || null;
    if (!ctx) {
      const Ctor = w.AudioContext || w.webkitAudioContext || null;
      if (typeof Ctor !== 'function') return null;
      try {
        ctx = new Ctor();
      } catch {
        ctx = null;
      }
    }
    return ctx;
  }

  function emit() {
    for (const fn of [...listeners]) {
      try {
        fn(playing);
      } catch {
        continue;
      }
    }
  }

  function stop() {
    for (const v of voices) {
      try {
        v.stop();
      } catch {
        continue;
      }
    }
    voices = [];
    if (bus) {
      try {
        bus.disconnect();
      } catch {
        bus = null;
      }
    }
    bus = null;
    if (stopTimer !== null) cancel(w, stopTimer);
    stopTimer = null;
    if (playing) {
      playing = false;
      emit();
    }
  }

  function note(c, out, at, dur, hz) {
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(hz, at);
    const end = at + Math.max(0.06, dur * 0.92);
    g.gain.setValueAtTime(0.0001, at);
    g.gain.linearRampToValueAtTime(0.9, at + 0.012);
    g.gain.exponentialRampToValueAtTime(0.35, at + Math.min(0.2, dur * 0.6));
    g.gain.exponentialRampToValueAtTime(0.0001, end);
    osc.connect(g);
    g.connect(out);
    osc.start(at);
    osc.stop(end + 0.03);
    voices.push(osc);
  }

  function status() {
    if (!enabled()) return 'off';
    const c = context();
    if (!c) return 'none';
    if (c.state === 'suspended') return 'blocked';
    return 'ok';
  }

  function play(tune, fromSec = 0) {
    stop();
    if (!tune || !enabled()) return false;
    const c = context();
    if (!c) return false;
    try {
      if (c.state === 'suspended' && typeof c.resume === 'function') {
        const p = c.resume();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      }
      const list = schedule(tune);
      const skip = Math.max(0, fromSec);
      const lead = Math.max(0, -fromSec);
      bus = c.createGain();
      bus.gain.value = level();
      bus.connect(c.destination);
      const t0 = (c.currentTime || 0) + 0.04 + lead;
      let count = 0;
      for (const n of list) {
        if (n.at + n.dur <= skip) continue;
        const start = Math.max(n.at, skip);
        note(c, bus, t0 + (start - skip), n.dur - (start - skip), n.hz);
        count += 1;
      }
      if (!count) {
        stop();
        return false;
      }
      playing = true;
      emit();
      const ms = (lead + Math.max(0, clipLength(tune) - skip)) * 1000 + 200;
      stopTimer = later(w, () => {
        stopTimer = null;
        voices = [];
        playing = false;
        emit();
      }, ms);
      return true;
    } catch {
      stop();
      return false;
    }
  }

  const off = typeof s.on === 'function'
    ? s.on('change', () => {
        if (!enabled()) stop();
        else if (bus && ctx) {
          try {
            bus.gain.setTargetAtTime(level(), ctx.currentTime || 0, 0.02);
          } catch {
            bus.gain.value = level();
          }
        }
      })
    : null;

  return {
    play,
    stop,
    status,
    get playing() {
      return playing;
    },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    destroy() {
      stop();
      listeners.clear();
      if (typeof off === 'function') off();
    },
  };
}

function faces(list) {
  if (!list.length) return null;
  return h('span', { class: 'faces' }, list.slice(0, 7).map((p) => profileButton(p, 'sm')), list.length > 7 ? h('span', { class: 'faces-more', text: `+${list.length - 7}` }) : null);
}

export function musicMoment(was, m) {
  const now = { n: m.n, phase: m.phase };
  if (!was || m.phase !== 'reveal' || (was.n === m.n && was.phase === 'reveal')) return { now, cue: null };
  if (m.myPick === null) return { now, cue: null };
  return { now, cue: m.gotIt ? 'correct' : 'wrong' };
}

export function createMusicquizView({ engine, fx, cues, sfx, win }) {
  const cue = cues && typeof cues.play === 'function' ? cues : QUIET;
  const w = win || globalThis;
  const player = createTunePlayer({ sfx, win: w });
  const el = h('section', { class: 'game game-musicquiz', attrs: { 'aria-label': 'Music Quiz' } });
  const head = h('div', { class: 'musicquiz-headwrap' });
  const stage = h('div', { class: 'musicquiz-stage' });
  const bars = h('div', { class: 'musicquiz-bars', attrs: { 'aria-hidden': 'true' } }, Array.from({ length: BARS }, (_, i) => h('span', { class: 'musicquiz-bar fx-loop', vars: { '--i': i } })));
  const playBtn = button('Play again', { variant: 'ghost', size: 'sm', key: 'musicquiz-play', on: () => replay(), kids: h('span', { class: 'btn-icon', text: '🔊', attrs: { 'aria-hidden': 'true' } }) });
  const note = h('p', { class: 'musicquiz-note muted', attrs: { role: 'note' } });
  stage.append(bars, h('div', { class: 'musicquiz-controls' }, playBtn), note);
  const body = h('div', { class: 'musicquiz-body' });
  el.append(head, stage, body);
  const local = { n: null, pick: null };
  let snap = null;
  let heard = null;
  let cheered = null;
  let shown = null;
  let started = null;
  let startTimer = null;

  player.onChange((on) => {
    el.classList.toggle('is-playing', on);
    stage.classList.toggle('is-playing', on);
  });

  function tune() {
    return snap ? musicquiz.tuneOf(snap) : null;
  }

  function paintNote() {
    const text = soundNote(player.status());
    note.textContent = text || '';
    note.classList.toggle('musicquiz-off', !text);
  }

  function replay() {
    const t = tune();
    if (!t) return;
    if (!player.play(t, 0)) cue.play('error');
    paintNote();
  }

  function startFor(m) {
    if (started === m.n) return;
    started = m.n;
    if (startTimer !== null) cancel(w, startTimer);
    startTimer = null;
    const t = tune();
    if (!t) return;
    const now = typeof engine.now === 'function' ? engine.now() : Date.now();
    const wait = m.starts - now;
    if (wait > 400) {
      player.stop();
      startTimer = later(w, () => {
        startTimer = null;
        player.play(t, 0);
        paintNote();
      }, wait);
      return;
    }
    player.play(t, Math.max(0, -wait / 1000));
  }

  function choose(m, i) {
    if (!m.canAnswer) return;
    local.n = m.n;
    local.pick = i;
    cue.play('send');
    engine.act({ type: 'answer', n: m.n, i });
    if (snap) update(snap);
  }

  const paintHead = memo((m) =>
    h(
      'div',
      { class: 'game-head' },
      h('span', { class: 'chip chip-static', text: '🎵 Name that tune' }),
      h('span', { class: 'game-count', text: `Tune ${m.number} of ${m.total}` }),
      timer(m.phase === 'reveal' ? m.ends - REVEAL_MS : m.shown, m.ends, m.phase === 'reveal' ? 'Next tune in' : 'Time left to answer'),
    ),
  );

  const paintBody = memo((m) => {
    const reveal = m.phase === 'reveal';
    return [
      m.note === 'host' && !reveal ? h('p', { class: 'notice', text: 'The host changed, so this tune starts again.' }) : null,
      reveal && m.title
        ? h('div', { class: 'musicquiz-answer card glass' }, h('strong', { class: 'musicquiz-title fx-display is-lit', text: m.title }), m.by ? h('span', { class: 'musicquiz-by muted', text: m.by }) : null)
        : h('h2', { class: 'question musicquiz-question fx-display', text: 'Which tune is this?' }),
      h(
        'div',
        { class: ['options', reveal ? 'is-reveal' : null] },
        m.options.map((o) =>
          h(
            'button',
            {
              class: ['option', `option-${o.i}`, 'spot', 'fx-lift', o.mine ? 'is-mine' : null, o.correct === true ? 'is-right' : null, reveal && o.correct === false ? (o.mine ? 'is-wrong' : 'is-dim') : null],
              type: 'button',
              vars: { '--i': o.i },
              disabled: reveal || m.iAnswered || !m.canAnswer,
              dataset: { key: `opt-${o.i}` },
              attrs: { 'aria-pressed': o.mine ? 'true' : 'false' },
              on: { click: () => choose(m, o.i) },
            },
            h('span', { class: 'option-letter', text: LETTERS[o.i], attrs: { 'aria-hidden': 'true' } }),
            h('span', { class: 'option-text', text: o.text }),
            o.count !== null ? h('span', { class: 'option-count', text: String(o.count), attrs: { 'aria-label': plural(o.count, 'pick', 'picks') } }) : null,
          ),
        ),
      ),
      h(
        'div',
        { class: ['game-foot', reveal && m.gotIt ? 'is-good' : null], attrs: { role: 'status', 'aria-live': 'polite' } },
        h('span', { class: 'foot-text', text: footText(m) }),
        !reveal ? faces(m.answeredBy) : null,
        reveal && m.right.length
          ? h('ul', { class: 'got-list' }, m.right.slice(0, 8).map((p) => h('li', { class: ['got-item', p.isMe ? 'is-me' : null] }, profileButton(p, 'xs'), h('span', { class: 'got-name', text: p.isMe ? 'You' : p.name }), h('span', { class: 'got-tick fx-num', text: `+${p.pts.toLocaleString('en-US')}` }))))
          : null,
      ),
    ];
  });

  function update(next) {
    snap = next;
    const m = musicquiz.model(next, local);
    if (!m) {
      paintBody(body, null);
      return;
    }
    paintHead(head, { number: m.number, total: m.total, phase: m.phase, shown: m.shown, starts: m.starts, ends: m.ends });
    paintBody(body, m);
    if (m.phase === 'listen') startFor(m);
    paintNote();
    el.dataset.phase = m.phase;
    const { now, cue: moment } = musicMoment(heard, m);
    heard = now;
    const beat = `${m.phase}:${m.n}`;
    if (beat !== shown) {
      shown = beat;
      const opts = body.querySelector('.options');
      if (opts && m.phase !== 'reveal') opts.classList.add('is-dealt');
      const mark = (sel, cls) => {
        const node = body.querySelector(sel);
        if (node) node.classList.add(cls);
      };
      if (m.phase === 'reveal') {
        mark('.option.is-right', 'fx-right');
        mark('.option.is-wrong', 'fx-wrong');
      }
    }
    if (moment) {
      cue.play(moment);
      const mineBtn = moment === 'correct' ? body.querySelector(`.option-${m.myPick}`) : null;
      if (mineBtn) {
        cue.burst(mineBtn, { count: 14, emoji: ['🎵', '🎶'] });
        if (m.myGain) cue.float(mineBtn, `+${m.myGain}`);
      }
    }
    if (m.phase === 'reveal' && m.gotIt && m.myGain >= 900 && cheered !== m.n) {
      cheered = m.n;
      if (fx && typeof fx.confetti === 'function') fx.confetti(30);
    }
  }

  paintNote();

  return {
    el,
    update,
    player,
    destroy() {
      if (startTimer !== null) cancel(w, startTimer);
      startTimer = null;
      player.destroy();
    },
  };
}
