import { h, markNames } from './dom.js';
import { reducedMotion } from './fx.js';
import { sfx as defaultSfx, DEFAULT_VOLUME as SOUND_BASE } from './sfx.js';

export const FX_MIN_MS = 1000;
export const FX_MAX_MS = 30000;
export const FX_DEFAULT_MS = 5000;
export const REVEAL_MS = 2500;
export const RAIN_DROPS = 18;
export const BURST_BITS = 14;
export const TACO_DROPS = 22;
export const SONG_SAFETY_MS = 11000;
export const SONG_VOLUME = 0.25;
export const TACO_SONG = new URL('../../media/raining-tacos.mp3', import.meta.url).href;
export const TACO_PICS = [1, 2, 3].map((n) => new URL(`../../media/taco-${n}.png`, import.meta.url).href);

export const TRANSFORMS = ['flip', 'mirror', 'shake', 'spin', 'tiny'];
export const STYLES = ['comic', 'blur'];
export const OVERLAYS = ['confetti', 'emoji-rain', 'hype', 'crash', 'fake-win', 'spotlight', 'tacos'];
export const MARKERS = { clown: 'is-clown', spotlight: 'is-spotlit' };
export const FUN_FX = ['confetti', 'emoji-rain', 'spotlight', 'hype', 'tacos'];
export const TROLL_FX = ['flip', 'mirror', 'shake', 'spin', 'tiny', 'comic', 'blur', 'crash', 'clown', 'fake-win'];
export const ALL_FX = [...FUN_FX, ...TROLL_FX];
export const SHOWN_TO_ALL = ['clown', 'spotlight'];
export const NEEDS_TARGET = ['spotlight', 'clown', 'fake-win'];

export function clampMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return FX_DEFAULT_MS;
  return Math.min(FX_MAX_MS, Math.max(FX_MIN_MS, Math.round(n)));
}

export function cleanEmoji(value) {
  const s = typeof value === 'string' ? value.replace(/[\s<>&"'`]/g, '') : '';
  const first = Array.from(s).slice(0, 4).join('');
  return first && first.length <= 12 ? first : '🎉';
}

export function seesFx(name, target, me) {
  if (SHOWN_TO_ALL.includes(name)) return true;
  if (target === null || target === undefined || target === '') return true;
  return target === me;
}

function keyFor(name, target) {
  return name === 'clown' ? `clown:${target || '*'}` : name;
}

export function songVolume(sound) {
  if (!sound || !sound.enabled) return 0;
  const v = Number(sound.volume);
  const level = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : SOUND_BASE;
  return Math.round(Math.min(1, SONG_VOLUME * (level / SOUND_BASE)) * 1000) / 1000;
}

export function createTrolls({ shell, layer, marks: markRoot, win, engine, fx = null, random = Math.random, sfx = defaultSfx }) {
  const active = new Map();
  let off = null;
  let offSound = null;

  function me() {
    try {
      const snap = engine.snapshot();
      return snap ? snap.me : null;
    } catch {
      return null;
    }
  }

  function nameOf(id) {
    try {
      const p = (engine.snapshot().players || []).find((x) => x.id === id);
      return p ? p.name : 'someone';
    } catch {
      return 'someone';
    }
  }

  function marks() {
    const out = { 'is-clown': new Set(), 'is-spotlit': new Set() };
    for (const e of active.values()) {
      const cls = MARKERS[e.name];
      if (cls) out[cls].add(e.target || '*');
    }
    return out;
  }

  function paint() {
    markNames(markRoot || shell, marks());
    return active.size;
  }

  function stillUsed(name) {
    for (const e of active.values()) if (e.name === name) return true;
    return false;
  }

  function stop(key) {
    const e = active.get(key);
    if (!e) return false;
    active.delete(key);
    for (const t of e.timers) win.clearTimeout(t);
    if (e.audio) {
      e.audio.onended = null;
      try {
        e.audio.pause();
      } catch {
        e.audio = null;
      }
    }
    if (e.el) e.el.remove();
    if (!stillUsed(e.name)) shell.classList.remove(`troll-${e.name}`);
    if (!active.size) shell.classList.remove('fx-quiet');
    paint();
    return true;
  }

  function crashBox() {
    return h(
      'div',
      { class: 'troll-overlay troll-crash-layer', attrs: { 'aria-hidden': 'true' } },
      h(
        'div',
        { class: 'crash-box' },
        h('span', { class: 'crash-icon', text: '💥' }),
        h('strong', { class: 'crash-title', text: 'YapOS Party stopped working' }),
        h('span', { class: 'crash-text', text: 'Something went wrong and the party has to close. Collecting error info…' }),
        h('span', { class: 'crash-bar' }, h('span', { class: 'crash-fill' })),
        h('span', { class: 'crash-fake-btn', text: 'Close app' }),
        h('strong', { class: 'troll-jk', text: 'jk 😜 nothing broke' }),
      ),
    );
  }

  function winBox() {
    return h(
      'div',
      { class: 'troll-overlay troll-win-layer', attrs: { 'aria-hidden': 'true' } },
      h(
        'div',
        { class: 'win-box' },
        h('span', { class: 'win-icon', text: '💰' }),
        h('span', { class: 'win-eyebrow', text: 'Lucky draw winner!' }),
        h('strong', { class: 'win-title', text: 'You won 1,000,000 Shards!' }),
        h('span', { class: 'win-text', text: 'Sending them to your wallet now…' }),
        h('strong', { class: 'troll-jk', text: 'jk 😜 no Shards, sorry' }),
      ),
    );
  }

  function rainBox(emoji, quiet) {
    const drops = [];
    for (let i = 0; i < RAIN_DROPS; i += 1) {
      drops.push(
        h('span', {
          class: 'rain-drop',
          text: emoji,
          vars: {
            '--x': `${Math.round(((i + random()) / RAIN_DROPS) * 96)}%`,
            '--y': `${Math.round(8 + random() * 80)}%`,
            '--delay': `${Math.round(random() * 1800)}ms`,
            '--fall': `${Math.round(2600 + random() * 2200)}ms`,
            '--size': `${Math.round(20 + random() * 18)}px`,
          },
        }),
      );
    }
    return h('div', { class: ['troll-overlay', 'troll-rain-layer', quiet ? 'is-still' : null], attrs: { 'aria-hidden': 'true' } }, drops);
  }

  function tacoBox(entry) {
    const drops = [];
    for (let i = 0; i < TACO_DROPS; i += 1) {
      const img = h('img', {
        class: 'taco-drop',
        attrs: { src: TACO_PICS[i % TACO_PICS.length], alt: '', draggable: 'false', decoding: 'async' },
        vars: {
          '--x': `${Math.round(((i + random()) / TACO_DROPS) * 94)}%`,
          '--y': `${Math.round(6 + random() * 78)}%`,
          '--delay': `${Math.round(random() * 2400)}ms`,
          '--fall': `${Math.round(2400 + random() * 2000)}ms`,
          '--size': `${Math.round(44 + random() * 40)}px`,
          '--turn': `${Math.round(random() * 540 - 270)}deg`,
        },
      });
      img.addEventListener('error', () => img.remove());
      drops.push(img);
    }
    const lights = [0, 1, 2, 3].map((i) => h('span', { class: ['disco-light', `tone-${i}`] }));
    const sound = h('button', { class: 'taco-sound', type: 'button', text: '🔊 Tap for taco music', attrs: { hidden: '' } });
    sound.addEventListener('click', () => {
      sound.hidden = true;
      if (!playSong(entry)) return;
      for (const t of entry.timers) win.clearTimeout(t);
      entry.timers = [win.setTimeout(() => stop('tacos'), SONG_SAFETY_MS)];
    });
    entry.sound = sound;
    return h(
      'div',
      { class: 'troll-overlay troll-taco-layer', attrs: { 'aria-hidden': 'true' } },
      h('div', { class: 'disco-lights' }, lights),
      h('span', { class: 'disco-ball', text: '🪩' }),
      drops,
      sound,
    );
  }

  function playSong(entry) {
    const Ctor = win && typeof win.Audio === 'function' ? win.Audio : null;
    if (!Ctor) return false;
    const vol = songVolume(sfx);
    if (vol <= 0) return false;
    try {
      const audio = entry.audio || new Ctor(TACO_SONG);
      entry.audio = audio;
      audio.volume = vol;
      audio.currentTime = 0;
      audio.onended = () => stop('tacos');
      const p = audio.play();
      if (p && typeof p.catch === 'function') {
        p.catch(() => {
          if (entry.sound && active.get('tacos') === entry) entry.sound.hidden = false;
        });
      }
      return true;
    } catch {
      return false;
    }
  }

  function burstBox() {
    const bits = [];
    for (let i = 0; i < BURST_BITS; i += 1) {
      const angle = (i / BURST_BITS) * Math.PI * 2;
      const reach = 70 + random() * 60;
      bits.push(h('span', { class: ['burst-bit', `tone-${i % 4}`], vars: { '--bx': `${Math.round(Math.cos(angle) * reach)}px`, '--by': `${Math.round(Math.sin(angle) * reach)}px` } }));
    }
    return h('div', { class: 'troll-overlay troll-burst-layer', attrs: { 'aria-hidden': 'true' } }, h('span', { class: 'burst-core', text: '🎉' }), bits);
  }

  function hypeBox() {
    return h(
      'div',
      { class: 'troll-overlay troll-hype-layer', attrs: { 'aria-hidden': 'true' } },
      h('div', { class: 'hype-box' }, h('span', { class: 'hype-icon', text: '🔥' }), h('strong', { class: 'hype-text', text: "LET'S GO" }), h('span', { class: 'hype-icon', text: '🔥' })),
    );
  }

  function spotBox(target) {
    return h(
      'div',
      { class: 'troll-overlay troll-spot-layer', attrs: { role: 'status' } },
      h('div', { class: 'spot-banner' }, h('span', { text: '✨', attrs: { 'aria-hidden': 'true' } }), h('span', { text: ` All eyes on ${nameOf(target)} ` }), h('span', { text: '✨', attrs: { 'aria-hidden': 'true' } })),
    );
  }

  function overlayFor(name, target, extra, quiet, entry) {
    if (name === 'tacos') return tacoBox(entry);
    if (name === 'crash') return crashBox();
    if (name === 'fake-win') return winBox();
    if (name === 'emoji-rain') return rainBox(cleanEmoji(extra && extra.emoji), quiet);
    if (name === 'hype') return hypeBox();
    if (name === 'spotlight') return spotBox(target);
    if (name === 'confetti') {
      const ran = !quiet && fx && typeof fx.confetti === 'function' ? fx.confetti(160) : false;
      return ran ? null : burstBox();
    }
    return null;
  }

  function apply(ev) {
    if (!ev || typeof ev !== 'object') return false;
    const name = ev.fx;
    if (!ALL_FX.includes(name)) return false;
    const target = ev.target === undefined || ev.target === '' ? null : ev.target;
    if (NEEDS_TARGET.includes(name) && !target) return false;
    if (!seesFx(name, target, me())) return false;
    const ms = clampMs(ev.ms);
    const quiet = reducedMotion(win);
    const key = keyFor(name, target);
    stop(key);
    if (TRANSFORMS.includes(name)) {
      for (const [k, e] of [...active]) if (TRANSFORMS.includes(e.name)) stop(k);
    }
    shell.classList.toggle('fx-quiet', quiet);
    if (TRANSFORMS.includes(name)) shell.style.setProperty('--fx-ms', `${ms}ms`);
    shell.classList.add(`troll-${name}`);
    const entry = { name, target, ms, timers: [], el: null, by: ev.by || null, audio: null, sound: null };
    const el = OVERLAYS.includes(name) ? overlayFor(name, target, ev.extra, quiet, entry) : null;
    if (el) {
      el.style.setProperty('--fx-ms', `${ms}ms`);
      if (quiet) el.classList.add('is-still');
      layer.append(el);
      entry.el = el;
    }
    if (el && (name === 'crash' || name === 'fake-win')) {
      const at = Math.max(Math.round(ms * 0.45), ms - REVEAL_MS);
      entry.timers.push(win.setTimeout(() => el.classList.add('is-reveal'), at));
    }
    entry.timers.push(win.setTimeout(() => stop(key), ms));
    active.set(key, entry);
    if (name === 'tacos') playSong(entry);
    paint();
    return true;
  }

  function clear() {
    for (const k of [...active.keys()]) stop(k);
  }

  function onSound() {
    const e = active.get('tacos');
    if (!e) return;
    const vol = songVolume(sfx);
    if (vol <= 0) {
      if (e.sound) e.sound.hidden = true;
      if (e.audio) {
        try {
          e.audio.pause();
        } catch {
          e.audio = null;
        }
      }
      return;
    }
    if (!e.audio) return;
    try {
      e.audio.volume = vol;
    } catch {
      e.audio = null;
    }
  }

  if (engine && typeof engine.on === 'function') off = engine.on('fx', apply);
  if (sfx && typeof sfx.on === 'function') offSound = sfx.on('change', onSound);

  return {
    apply,
    stop,
    clear,
    paint,
    get active() {
      return [...active.values()].map((e) => ({ name: e.name, target: e.target, ms: e.ms }));
    },
    destroy() {
      if (typeof off === 'function') off();
      off = null;
      if (typeof offSound === 'function') offSound();
      offSound = null;
      clear();
    },
  };
}
