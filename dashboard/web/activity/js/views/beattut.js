import { h, button } from '../ui/dom.js';
import { createBeatDraw, laneStyle } from './beatdraw.js';

export const TUT_BPM = 100;
export const TUT_BEAT = 60 / TUT_BPM;
export const TUT_NOTES = 8;
export const TUT_LEAD_BEATS = 2;
export const TUT_SLOW = 0.7;
export const TUT_LOOK = 1.7;
export const TUT_H = 220;
export const TIMING_WIN = 200;
export const TIMING_IQR = 40;
export const TIMING_MIN = 6;
export const TIMING_MAX = 200;
export const TIMING_SMALL = 10;
export const TUT_WIN = Object.freeze({ p: 50, g: 100, o: TIMING_WIN });
export const CAPTIONS = Object.freeze([
  'Notes fall down their lane. Tap when one touches the ring.',
  'Each lane has its own key, shape and color.',
  'Hit them in a row to build a streak. Extra random taps break it. Hold long notes until they end.',
]);

export function clampOffset(ms) {
  const n = Math.round(Number(ms));
  if (!Number.isFinite(n)) return 0;
  return Math.max(-TIMING_MAX, Math.min(TIMING_MAX, n));
}

function median(sorted) {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function timingFrom(dts) {
  const ins = (Array.isArray(dts) ? dts : []).filter((d) => Number.isFinite(d) && Math.abs(d) <= TIMING_WIN).sort((a, b) => a - b);
  if (ins.length < TIMING_MIN) return { ok: false, n: ins.length, ms: 0, why: 'few' };
  const q1 = ins[Math.floor((ins.length - 1) * 0.25)];
  const q3 = ins[Math.ceil((ins.length - 1) * 0.75)];
  if (q3 - q1 > TIMING_IQR) return { ok: false, n: ins.length, ms: 0, why: 'spread' };
  return { ok: true, n: ins.length, ms: clampOffset(median(ins)) };
}

export function tapText(ms) {
  const a = Math.abs(Math.round(ms));
  return `you tap ${a} ms ${ms > 0 ? 'late' : 'early'}`;
}

export function firstBeat() {
  return Math.ceil((TUT_LEAD_BEATS * TUT_BEAT + TUT_LOOK) / TUT_BEAT - 1e-9);
}

export const TUT_LANES = 4;

export function tutorialNotes() {
  const order = [0, 1, 2, 3, 2, 1, 0, 3];
  const first = firstBeat();
  return order.slice(0, TUT_NOTES).map((l, i) => ({ t: Math.round((first + i) * TUT_BEAT * 1000), l }));
}

export function createTutorial({ perf, loop, synth = null, still = () => false, labels = () => null, touch = () => false, offset = () => 0, onOffset = () => {}, onDone = () => {}, mode = 'full', doc } = {}) {
  const lanes = TUT_LANES;
  const now = typeof perf === 'function' ? perf : () => Date.now();
  const canvas = h('canvas', { class: 'bd-tut-canvas', attrs: { role: 'application', 'aria-label': 'Practice lanes. Use the lane keys or tap a lane.' } });
  const title = h('h3', { class: 'bd-tut-title', text: mode === 'timing' ? 'Timing check' : 'How to play' });
  const cap = h('p', { class: 'bd-tut-cap', attrs: { role: 'status', 'aria-live': 'polite' } });
  const glyph = h('span', { class: 'bd-tut-glyph', attrs: { 'aria-hidden': 'true' } });
  const streakEl = h('span', { class: 'bd-tut-streak fx-num' });
  const end = h('div', { class: 'bd-tut-end' });
  const skip = button('Skip', { variant: 'ghost', size: 'sm', key: 'bd-tut-skip', on: () => finish({ skipped: true }) });
  const el = h('div', { class: 'bd-tut', dataset: { step: '1' } }, title, h('div', { class: 'bd-tut-lane' }, canvas, glyph), h('div', { class: 'bd-tut-row' }, cap, streakEl), end, h('div', { class: 'bd-tut-actions' }, skip));
  const draw = createBeatDraw(canvas, { doc });
  const pal = laneStyle(lanes);
  const st = { step: mode === 'timing' ? 3 : 1, start: now(), notes: [], mark: null, dts: [], streak: 0, best: 0, hitAt: -1e9, pressAt: new Float64Array(lanes).fill(-1e9), flash: new Array(lanes).fill(null), judge: new Array(lanes).fill(null), clicks: 0, gone: false, result: null, prev: offset(), size: '' };
  let stop = null;

  function setStep(n) {
    st.step = n;
    st.start = now();
    st.hitAt = -1e9;
    el.dataset.step = String(n);
    end.replaceChildren();
    if (n === 1 || n === 2) {
      const lane = n === 1 ? 0 : lanes - 1;
      st.notes = [{ t: Math.round(TUT_LOOK * 1000), l: lane }];
      st.mark = new Uint8Array(1);
      cap.textContent = CAPTIONS[n - 1];
      const lab = labels();
      glyph.textContent = touch() || !lab ? '👆' : lab[lane];
      glyph.style.setProperty('--bd-x', `${(((lane + 0.5) / lanes) * 100).toFixed(2)}%`);
      streakEl.textContent = '';
    } else if (n === 3) {
      st.notes = tutorialNotes();
      st.mark = new Uint8Array(st.notes.length);
      st.dts = [];
      st.streak = 0;
      st.clicks = 0;
      cap.textContent = CAPTIONS[2];
      glyph.textContent = '';
      streakEl.textContent = 'Streak 0';
    } else {
      st.notes = [];
      cap.textContent = mode === 'timing' ? 'Timing check done.' : "You're ready!";
      glyph.textContent = '';
      showResult();
    }
  }

  function showResult() {
    const r = timingFrom(st.dts);
    const before = offset();
    st.prev = before;
    let line;
    let undo = null;
    if (r.ok && Math.abs(r.ms) >= TIMING_SMALL) {
      const next = clampOffset(before + r.ms);
      onOffset(next);
      line = `Timing tuned: ${tapText(r.ms)} - fixed`;
      undo = button('Undo', { variant: 'ghost', size: 'sm', key: 'bd-tut-undo', on: () => {
        onOffset(before);
        end.replaceChildren(h('p', { class: 'bd-tut-res', text: 'Timing put back.' }), actions());
      } });
    } else if (r.ok) line = 'Your timing is spot on.';
    else line = r.why === 'spread' ? 'Your taps were a bit uneven, so timing was left as it was.' : 'Not enough taps landed to check your timing. You can re-check it later.';
    st.result = { ...r, offset: offset() };
    end.replaceChildren(h('p', { class: 'bd-tut-res', text: `${line}${st.best ? ` Best streak: ${st.best}.` : ''}` }), undo, actions());
  }

  function actions() {
    return h(
      'div',
      { class: 'bd-tut-actions' },
      button(mode === 'timing' ? 'Done' : "Let's go", { variant: 'primary', size: 'sm', key: 'bd-tut-done', on: () => finish({ skipped: false }) }),
      button('Try again', { variant: 'ghost', size: 'sm', key: 'bd-tut-again', on: () => setStep(3) }),
    );
  }

  function finish(r) {
    if (st.gone) return;
    destroy();
    onDone({ skipped: Boolean(r.skipped), result: st.result });
  }

  function clockT() {
    const real = (now() - st.start) / 1000;
    if (st.step === 1 || st.step === 2) return Math.min(real * TUT_SLOW, TUT_LOOK);
    return real - offset() / 1000;
  }

  function press(lane, ts) {
    if (st.gone || !(lane >= 0 && lane < lanes)) return false;
    const n0 = now();
    const at = Number.isFinite(ts) && ts <= n0 + 5 && ts >= n0 - 1000 ? ts : n0;
    st.pressAt[lane] = now();
    if (st.step === 1 || st.step === 2) {
      const want = st.notes[0];
      if (!want || lane !== want.l || st.mark[0]) return false;
      if (clockT() < TUT_LOOK * 0.35) return false;
      st.mark[0] = 1;
      st.hitAt = now();
      st.flash[lane] = { k: 'p', at: now() };
      st.judge[lane] = { k: 'p', at: now(), tag: '' };
      if (synth) synth.hit(pal[lane], 'p', 0);
      draw.burst(lane, now(), still() ? 0 : 6);
      return true;
    }
    if (st.step !== 3) return false;
    const t = (at - st.start) - offset();
    let best = -1;
    let bd = 0;
    st.notes.forEach((n, i) => {
      if (st.mark[i] || n.l !== lane) return;
      const dt = t - n.t;
      if (Math.abs(dt) <= TUT_WIN.o && (best < 0 || Math.abs(dt) < Math.abs(bd))) {
        best = i;
        bd = dt;
      }
    });
    if (best < 0) {
      if (synth) synth.stray();
      return false;
    }
    const a = Math.abs(bd);
    const k = a <= TUT_WIN.p ? 'p' : a <= TUT_WIN.g ? 'g' : 'o';
    st.mark[best] = k === 'p' ? 1 : k === 'g' ? 2 : 3;
    st.dts.push(bd);
    st.streak += 1;
    st.best = Math.max(st.best, st.streak);
    st.flash[lane] = { k, at: now() };
    st.judge[lane] = { k, at: now(), tag: k !== 'p' && a > 30 ? (bd < 0 ? 'early' : 'late') : '' };
    if (synth) synth.hit(pal[lane], k, 0);
    draw.burst(lane, now(), still() ? 0 : 6);
    streakEl.textContent = `Streak ${st.streak}`;
    return true;
  }

  function frame() {
    if (st.gone) return false;
    const w = canvas.clientWidth || 0;
    const ht = canvas.clientHeight || TUT_H;
    const sig = `${w}x${ht}`;
    if (w > 0 && sig !== st.size && draw.resize({ width: w, height: ht, dpr: Math.min(2, Number(globalThis.devicePixelRatio) || 1), lanes })) st.size = sig;
    const t = clockT();
    if ((st.step === 1 || st.step === 2) && st.mark && st.mark[0] && now() - st.hitAt > 700) setStep(st.step + 1);
    if (st.step === 3) {
      const real = (now() - st.start) / 1000;
      const beatNo = Math.floor((real + 0.15) / TUT_BEAT);
      while (st.clicks <= beatNo && st.clicks < firstBeat() + TUT_NOTES) {
        if (synth) synth.click(Math.max(0, st.clicks * TUT_BEAT - real), st.clicks < TUT_LEAD_BEATS);
        st.clicks += 1;
      }
      st.notes.forEach((n, i) => {
        if (!st.mark[i] && n.t < t * 1000 - TUT_WIN.o) {
          st.mark[i] = 4;
          st.streak = 0;
          st.judge[n.l] = { k: 'm', at: now(), tag: '' };
          streakEl.textContent = 'Streak 0';
        }
      });
      const lastT = st.notes.length ? st.notes[st.notes.length - 1].t / 1000 : 0;
      if (t > lastT + 0.6) setStep(4);
    }
    if (st.step <= 3) {
      draw.draw({ now: now(), t, look: TUT_LOOK, song: { notes: st.notes, beat: st.step === 3 ? TUT_BEAT : 0, dur: 0 }, mark: st.mark, pressAt: st.pressAt, flash: st.flash, judge: st.judge, labels: st.step === 3 ? labels() : null, still: still(), lite: false, tier: 0, flatPulse: true });
    }
    return true;
  }

  function destroy() {
    st.gone = true;
    if (typeof stop === 'function') stop();
    stop = null;
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (!e || (typeof e.button === 'number' && e.button !== 0)) return;
    const wd = canvas.clientWidth || 0;
    const x = Number.isFinite(e.offsetX) ? e.offsetX : NaN;
    if (!(wd > 0) || !Number.isFinite(x)) return;
    if (typeof e.preventDefault === 'function') e.preventDefault();
    const p = now();
    const ts = Number.isFinite(e.timeStamp) && e.timeStamp > 0 && e.timeStamp <= p + 5 && e.timeStamp >= p - 1000 ? e.timeStamp : p;
    press(Math.max(0, Math.min(lanes - 1, Math.floor((x / wd) * lanes))), ts);
  });

  setStep(st.step);
  if (loop && typeof loop.add === 'function') stop = loop.add(frame);

  return {
    el,
    press,
    frame,
    destroy,
    finish,
    setStep,
    get step() {
      return st.step;
    },
    get dts() {
      return st.dts.slice();
    },
    get streak() {
      return st.streak;
    },
    get gone() {
      return st.gone;
    },
  };
}
