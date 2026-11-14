import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, FakeEvent } from './dom-shim.js';
import { createSfx, SOUND_NAMES, SOUND_KEY, RATE_MS, BURST_MAX } from '../web/activity/js/ui/sfx.js';

const ME = '2c416a35-eac2-4e0e-a310-8648b5ecd7af';
const PAL = '11111111-1111-4111-8111-111111111111';
const NEW = '22222222-2222-4222-8222-222222222222';

const NAMES = ['tap', 'pop', 'whoosh', 'toggle', 'join', 'leave', 'start', 'tick', 'tickLast', 'turn', 'correct', 'wrong', 'coin', 'win', 'lose', 'reveal', 'send', 'error', 'fx', 'type'];

function fakeAudio() {
  const made = { contexts: [], nodes: [] };
  class Param {
    constructor(v) {
      this.value = v;
      this.events = [];
    }
    setValueAtTime(v, t) {
      this.events.push(['set', v, t]);
      this.value = v;
    }
    linearRampToValueAtTime(v, t) {
      this.events.push(['line', v, t]);
    }
    exponentialRampToValueAtTime(v, t) {
      if (!(v > 0)) throw new RangeError('exponential ramps need a positive value');
      this.events.push(['exp', v, t]);
    }
    setTargetAtTime(v, t) {
      this.events.push(['target', v, t]);
      this.value = v;
    }
    cancelScheduledValues() {}
  }
  class Node {
    constructor(ctx, kind) {
      this.ctx = ctx;
      this.kind = kind;
      this.outs = [];
      made.nodes.push(this);
    }
    connect(n) {
      if (!n || n.ctx !== this.ctx) throw new Error('bad connect');
      this.outs.push(n);
      return n;
    }
  }
  class Source extends Node {
    start(t) {
      this.started = t;
    }
    stop(t) {
      this.stopped = t;
    }
  }
  class Ctx {
    constructor() {
      this.currentTime = 1;
      this.sampleRate = 8000;
      this.state = 'suspended';
      this.resumes = 0;
      this.destination = new Node(this, 'destination');
      made.contexts.push(this);
    }
    resume() {
      this.resumes += 1;
      this.state = 'running';
      return Promise.resolve();
    }
    createGain() {
      const n = new Node(this, 'gain');
      n.gain = new Param(1);
      return n;
    }
    createDynamicsCompressor() {
      return new Node(this, 'compressor');
    }
    createOscillator() {
      const n = new Source(this, 'osc');
      n.frequency = new Param(440);
      n.type = 'sine';
      return n;
    }
    createBufferSource() {
      const n = new Source(this, 'noise');
      n.buffer = null;
      return n;
    }
    createBiquadFilter() {
      const n = new Node(this, 'filter');
      n.frequency = new Param(350);
      n.Q = new Param(1);
      n.type = 'lowpass';
      return n;
    }
    createBuffer(channels, length, rate) {
      const data = new Float32Array(length);
      return { length, sampleRate: rate, getChannelData: () => data };
    }
  }
  return { Ctx, made };
}

function reaches(node, target, seen = new Set()) {
  if (node === target) return true;
  if (seen.has(node)) return false;
  seen.add(node);
  return node.outs.some((n) => reaches(n, target, seen));
}

function memStore(init = {}) {
  const data = new Map(Object.entries(init));
  return {
    data,
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
  };
}

function rig(opts = {}) {
  const { Ctx, made } = fakeAudio();
  let t = 1000;
  const storage = opts.storage === undefined ? memStore() : opts.storage;
  const s = createSfx({ AudioContext: Ctx, storage, now: () => t });
  return { s, made, storage, advance: (ms) => (t += ms) };
}

test('every named sound builds, connects to the speakers and stops by itself', () => {
  assert.deepEqual([...SOUND_NAMES].sort(), [...NAMES].sort());
  for (const name of NAMES) {
    const { s, made, advance } = rig();
    advance(1000);
    assert.equal(s.play(name), true, name);
    const ctx = made.contexts[0];
    const sources = made.nodes.filter((n) => n.kind === 'osc' || n.kind === 'noise');
    assert.ok(sources.length > 0, name);
    for (const src of sources) {
      assert.ok(reaches(src, ctx.destination), `${name} reaches the speakers`);
      assert.ok(Number.isFinite(src.started) && src.stopped > src.started, name);
      const length = src.stopped - ctx.currentTime;
      assert.ok(length <= (name === 'win' ? 1.9 : 1.25), `${name} is short (${length})`);
      if (src.kind === 'osc') for (const [, v] of src.frequency.events) assert.ok(v > 20 && v < 8000, `${name} ${v} Hz`);
      if (src.kind === 'noise') assert.ok(src.buffer && src.buffer.length > 0);
    }
  }
});

test('unknown names and missing Web Audio do nothing and never throw', () => {
  const { s, made } = rig();
  for (const bad of ['nope', '', undefined, null, 42, 'constructor', 'toString', '__proto__']) assert.equal(s.play(bad), false);
  assert.equal(made.contexts.length, 0);
  const none = createSfx({ AudioContext: null, storage: null });
  assert.equal(none.play('tap'), false);
  assert.equal(none.unlock(), false);
  class Boom {
    constructor() {
      throw new Error('no audio here');
    }
  }
  const broken = createSfx({ AudioContext: Boom, storage: null });
  assert.equal(broken.play('coin'), false);
  assert.equal(broken.play('coin'), false);
  assert.equal(broken.setEnabled(false), false);
});

test('muting silences the output and is remembered', () => {
  const { s, made, storage, advance } = rig();
  assert.equal(s.enabled, true);
  assert.equal(s.volume, 0.5);
  s.play('tap');
  const ctx = made.contexts[0];
  const master = made.nodes.find((n) => n.kind === 'gain');
  assert.equal(master.gain.value, 0.5);
  const seen = [];
  const off = s.on('change', (st) => seen.push(st));
  s.setEnabled(false);
  assert.equal(master.gain.value, 0);
  assert.equal(storage.data.get(SOUND_KEY), 'off');
  const before = made.nodes.length;
  advance(500);
  assert.equal(s.play('coin'), false);
  assert.equal(made.nodes.length, before);
  assert.deepEqual(seen, [{ enabled: false, volume: 0.5 }]);
  const again = createSfx({ AudioContext: function Nope() {}, storage });
  assert.equal(again.enabled, false);
  s.setVolume(2);
  assert.equal(s.volume, 1);
  s.setVolume('loud');
  assert.equal(s.volume, 1);
  s.setEnabled(true);
  assert.equal(master.gain.value, 1);
  assert.equal(storage.data.get(SOUND_KEY), 'on');
  off();
  s.setVolume(0.3);
  assert.equal(seen.length, 3);
  assert.equal(ctx.resumes > 0, true);
});

test('sound settings survive storage that throws', () => {
  const angry = {
    getItem() {
      throw new Error('blocked');
    },
    setItem() {
      throw new Error('blocked');
    },
  };
  const { s } = rig({ storage: angry });
  assert.equal(s.enabled, true);
  assert.equal(s.setEnabled(false), false);
  assert.equal(s.enabled, false);
  assert.equal(s.play('tap'), false);
  const none = createSfx({ AudioContext: null, storage: null });
  assert.equal(none.enabled, true);
});

test('the same sound within the rate limit plays once and options shape it', () => {
  const { s, made, advance } = rig();
  assert.equal(s.play('tap'), true);
  assert.equal(s.play('tap'), false);
  assert.equal(s.play('pop'), true);
  advance(RATE_MS + 5);
  assert.equal(s.play('tap'), true);
  advance(1000);
  let heard = 0;
  for (let i = 0; i < 30; i += 1) if (s.play(NAMES[i % NAMES.length])) heard += 1;
  assert.equal(heard, BURST_MAX, 'a burst of different sounds is capped');
  advance(1000);
  const base = made.nodes.length;
  assert.equal(s.play('send', { volume: 0.4, pitch: 12, at: 300 }), true);
  const fresh = made.nodes.slice(base);
  const bus = fresh.find((n) => n.kind === 'gain');
  assert.equal(bus.gain.value, 0.4);
  const osc = fresh.find((n) => n.kind === 'osc');
  assert.equal(osc.frequency.events[0][1], 880);
  assert.ok(osc.started >= made.contexts[0].currentTime + 0.3);
  advance(1000);
  assert.equal(s.play('send', { volume: 0 }), false);
});

test('unlock wakes the audio when sound is on', () => {
  const { s, made } = rig();
  assert.equal(s.unlock(), true);
  assert.equal(made.contexts[0].resumes, 1);
  const muted = rig({ storage: memStore({ [SOUND_KEY]: 'off' }) });
  assert.equal(muted.s.enabled, false);
  assert.equal(muted.s.unlock(), false);
  assert.equal(muted.made.contexts.length, 0);
});

test('sounds wait for a tap so nothing piles up while the browser keeps audio asleep', () => {
  const { Ctx, made } = fakeAudio();
  class Sleepy extends Ctx {
    resume() {
      this.resumes += 1;
      return Promise.resolve();
    }
  }
  const ua = { hasBeenActive: false, isActive: false };
  const before = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { value: { navigator: { userActivation: ua } }, configurable: true, writable: true });
  try {
    let t = 1000;
    const s = createSfx({ AudioContext: Sleepy, storage: memStore(), now: () => t });
    assert.equal(s.play('join'), false);
    assert.equal(made.contexts.length, 0);
    ua.hasBeenActive = true;
    ua.isActive = true;
    assert.equal(s.unlock(), true);
    t += 500;
    assert.equal(s.play('tap'), true);
    ua.isActive = false;
    const nodes = made.nodes.length;
    for (const name of ['join', 'leave', 'coin', 'pop']) {
      t += 500;
      assert.equal(s.play(name), false, name);
    }
    assert.equal(made.nodes.length, nodes);
    made.contexts[0].state = 'running';
    t += 500;
    assert.equal(s.play('coin'), true);
  } finally {
    if (before) Object.defineProperty(globalThis, 'window', before);
    else delete globalThis.window;
  }
});

test('final seconds of the main countdown tick once per second', async () => {
  installDom();
  const { finalSeconds, tickTimers, countdown, timer } = await import('../web/activity/js/ui/dom.js');
  const heard = [];
  const watch = finalSeconds((n) => heard.push(n));
  const root = document.createElement('div');
  const ends = 100_000;
  root.append(countdown(ends - 20_000, ends), countdown(ends - 20_000, ends + 3000), timer(0, ends));
  const hooks = { countdown: watch };
  for (let t = ends - 8000; t <= ends + 500; t += 200) tickTimers(root, t, hooks);
  assert.deepEqual(heard, [5, 4, 3, 2, 1]);
  heard.length = 0;
  const later = finalSeconds((n) => heard.push(n));
  tickTimers(root, ends - 3500, { countdown: later });
  tickTimers(root, ends - 3400, { countdown: later });
  assert.deepEqual(heard, [], 'joining mid-countdown stays quiet until the next second');
  tickTimers(root, ends - 2500, { countdown: later });
  assert.deepEqual(heard, [3]);
  const times = [];
  const t2 = finalSeconds((n) => times.push(n));
  for (let t = ends - 7000; t <= ends; t += 250) tickTimers(root, t, { timer: t2 });
  assert.deepEqual(times, [5, 4, 3, 2, 1]);
  assert.doesNotThrow(() => tickTimers(root, ends, null));
});

function person(id, slot, name, extra = {}) {
  return { id, slot, name, username: name.toLowerCase(), initials: name.slice(0, 2).toUpperCase(), hue: 120, avatar: null, present: true, joined: true, ready: false, isHost: false, isMe: false, game: 0, total: 0, wins: 0, isAdmin: false, isOwner: false, ...extra };
}

function makeClock() {
  let t = 1_700_000_000_000;
  let seq = 0;
  let queue = [];
  return {
    now: () => t,
    setTimeout(fn, ms) {
      const id = ++seq;
      queue.push({ id, at: t + Math.max(0, ms || 0), fn });
      return id;
    },
    clearTimeout(id) {
      queue = queue.filter((x) => x.id !== id);
    },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        queue.sort((a, b) => a.at - b.at || a.id - b.id);
        const next = queue[0];
        if (!next || next.at > end) break;
        queue.shift();
        t = Math.max(t, next.at);
        next.fn();
      }
      t = end;
    },
  };
}

function fakeEngine({ clock, admin = false, meJoined = false }) {
  const handlers = {};
  const calls = { fx: [] };
  let players = [person(ME, 0, 'Jolli', { isMe: true, isHost: true, joined: meJoined }), person(PAL, 1, 'Juno')];
  let snap;
  function build(patch = {}) {
    const base = snap || {
      ready: true,
      me: ME,
      joining: null,
      autoStart: null,
      host: ME,
      hostName: 'Jolli',
      isHost: true,
      room: { phase: 'lobby', game: null, pick: 'wyr', round: 1 },
      players,
      game: null,
      pick: { id: 'wyr' },
      settings: {},
      state: {},
      admin: { me: admin, owner: ME, locked: false, banned: [] },
      announce: null,
    };
    const next = { ...base, ...patch };
    next.meJoined = Boolean((next.players.find((p) => p.isMe) || {}).joined);
    next.now = clock.now();
    return next;
  }
  snap = build();
  function emit(ev, x) {
    for (const fn of (handlers[ev] || []).slice()) fn(x);
  }
  const engine = {
    games: [{ id: 'wyr', name: 'Would You Rather', emoji: '🤔', blurb: 'Pick a side.', settings: [] }],
    now: () => clock.now(),
    on(ev, fn) {
      (handlers[ev] = handlers[ev] || []).push(fn);
      return () => {
        handlers[ev] = handlers[ev].filter((f) => f !== fn);
      };
    },
    snapshot: () => snap,
    lobby: { start: () => ({ ok: true }), end() {}, pick() {}, reset() {}, setting: () => true, toLobby() {} },
    join() {},
    leave() {},
    admin: {
      run: () => admin,
      fx(name, opts = {}) {
        calls.fx.push(name);
        emit('fx', { fx: name, target: opts.target ?? null, ms: opts.ms, by: ME });
        return admin;
      },
    },
  };
  return {
    engine,
    calls,
    emit,
    set(patch) {
      snap = build(patch);
      emit('change', snap);
    },
    player(id, patch) {
      players = snap.players.map((p) => (p.id === id ? { ...p, ...patch } : p));
      snap = build({ players });
      emit('change', snap);
    },
    add(p) {
      players = [...snap.players, p];
      snap = build({ players });
      emit('change', snap);
    },
  };
}

function all(node, out = []) {
  for (const c of node.childNodes || []) {
    if (c.localName) out.push(c);
    all(c, out);
  }
  return out;
}

function byKey(root, key) {
  return all(root).find((el) => el.dataset && el.dataset.key === key) || null;
}

function text(node) {
  if (node.data !== undefined && !node.localName) return node.data;
  return (node.childNodes || []).map(text).join('');
}

async function mount({ admin = false, meJoined = false, storage = memStore() } = {}) {
  const { window } = installDom({ url: 'https://yapos.dev/activity/' });
  const clock = makeClock();
  const fake = fakeEngine({ clock, admin, meJoined });
  const { Ctx } = fakeAudio();
  const sound = createSfx({ AudioContext: Ctx, storage, now: () => clock.now() });
  const played = [];
  const real = sound.play;
  sound.play = (name, opts) => {
    played.push(name);
    return real(name, opts);
  };
  const juice = { attached: [], detached: 0, bursts: [], floats: [] };
  const juiceMod = {
    attachJuice(root, opts) {
      juice.attached.push({ root, opts });
      return () => {
        juice.detached += 1;
      };
    },
    burst: (x, y, opts) => juice.bursts.push({ x, y, opts }),
    floatText: (el, label) => juice.floats.push({ el, label }),
  };
  const root = document.createElement('div');
  document.body.append(root);
  const win = Object.assign(window, {
    document,
    parent: {},
    innerWidth: 360,
    innerHeight: 640,
    performance: { now: () => clock.now() },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  const { mountApp } = await import('../web/activity/js/ui/app.js');
  const app = mountApp({ root, engine: fake.engine, bridge: { close() {} }, win, sfx: sound, juice: juiceMod });
  return { ...fake, root, app, clock, win, sound, played, juice, storage };
}

test('the sound button flips sound on and off and says so', async () => {
  const s = await mount();
  let btn = byKey(s.root, 'sound');
  assert.ok(btn);
  assert.equal(btn.parentNode.className, 'top-actions');
  assert.equal(btn.getAttribute('aria-pressed'), 'true');
  assert.equal(btn.getAttribute('title'), 'Sound on');
  assert.match(text(btn), /🔊/);
  btn.click();
  assert.equal(s.sound.enabled, false);
  assert.equal(s.storage.data.get(SOUND_KEY), 'off');
  btn = byKey(s.root, 'sound');
  assert.equal(btn.getAttribute('aria-pressed'), 'false');
  assert.equal(btn.getAttribute('title'), 'Sound off');
  assert.match(text(btn), /🔇/);
  s.clock.advance(500);
  btn.click();
  assert.equal(s.sound.enabled, true);
  assert.equal(byKey(s.root, 'sound').getAttribute('aria-pressed'), 'true');
  assert.deepEqual(s.played, ['toggle']);
  s.sound.setEnabled(false);
  assert.equal(byKey(s.root, 'sound').getAttribute('title'), 'Sound off', 'outside changes repaint the button');
  s.app.destroy();
});

test('juice is attached once with the sound and detached on close', async () => {
  const s = await mount();
  assert.equal(s.juice.attached.length, 1);
  assert.equal(s.juice.attached[0].root, s.root);
  assert.equal(s.juice.attached[0].opts.sfx, s.sound);
  s.app.destroy();
  assert.equal(s.juice.detached, 1);
});

test('the sound director stays quiet on the first render and follows the party', async () => {
  const s = await mount({ meJoined: true });
  assert.deepEqual(s.played, [], 'joining mid-party plays nothing');
  s.clock.advance(300);
  s.add(person(NEW, 2, 'Pip'));
  assert.deepEqual(s.played, ['join']);
  s.clock.advance(300);
  s.player(NEW, { joined: false });
  assert.deepEqual(s.played.at(-1), 'leave');
  s.clock.advance(300);
  s.set({ room: { phase: 'game', game: 'nope', pick: 'wyr', round: 1 }, game: { id: 'nope', name: 'Mystery', emoji: '❓' } });
  assert.equal(s.played.at(-1), 'start');
  s.clock.advance(300);
  s.player(ME, { game: 120 });
  assert.equal(s.played.at(-1), 'coin');
  assert.equal(s.juice.floats.length, 1);
  assert.equal(s.juice.floats[0].label, '+120');
  assert.match(s.juice.floats[0].el.className, /is-me/);
  s.clock.advance(300);
  s.player(ME, { game: 100 });
  assert.equal(s.played.at(-1), 'coin', 'losing points plays nothing new');
  assert.equal(s.played.length, 4);
  s.clock.advance(300);
  s.set({ room: { phase: 'results', game: 'nope', pick: 'wyr', round: 1, last: { game: 'nope', winners: [0], at: s.clock.now() } } });
  assert.equal(s.played.at(-1), 'win');
  s.clock.advance(300);
  s.set({ room: { phase: 'game', game: 'nope', pick: 'wyr', round: 2 } });
  assert.equal(s.played.at(-1), 'start');
  s.clock.advance(300);
  s.set({ room: { phase: 'results', game: 'nope', pick: 'wyr', round: 2, last: { game: 'nope', winners: [1], at: s.clock.now() } } });
  assert.equal(s.played.at(-1), 'reveal');
  s.clock.advance(300);
  s.set({ announce: { text: 'Snacks in 5', until: s.clock.now() + 10000 } });
  assert.equal(s.played.at(-1), 'pop');
  s.app.destroy();
});

test('the director never plays two sounds within 120 ms', async () => {
  const s = await mount({ meJoined: true });
  s.add(person(NEW, 2, 'Pip'));
  s.player(ME, { game: 50 });
  assert.deepEqual(s.played, ['join']);
  s.clock.advance(121);
  s.player(ME, { game: 80 });
  assert.deepEqual(s.played, ['join', 'coin']);
  s.app.destroy();
});

test('tapping Join plays the join sound and bursts from the button', async () => {
  const s = await mount();
  s.clock.advance(300);
  byKey(s.root, 'join').click();
  s.player(ME, { joined: true });
  assert.deepEqual(s.played, ['join']);
  assert.equal(s.juice.bursts.length, 1);
  assert.ok(Number.isFinite(s.juice.bursts[0].x) && Number.isFinite(s.juice.bursts[0].y));
  s.app.destroy();
});

test('admin effects sparkle for the people who see them, but not the taco song', async () => {
  const s = await mount();
  s.emit('fx', { fx: 'confetti', target: null, ms: 4000, by: PAL });
  assert.deepEqual(s.played, ['fx']);
  s.clock.advance(300);
  s.emit('fx', { fx: 'tacos', target: null, ms: 9600, by: PAL });
  s.emit('fx', { fx: 'flip', target: NEW, ms: 4000, by: PAL });
  s.emit('fx', { fx: 'nonsense', target: null, ms: 4000, by: PAL });
  assert.deepEqual(s.played, ['fx']);
  s.app.destroy();
});

test('admins hear a sparkle for fun and a whoosh for pranks', async () => {
  const { fireSound } = await import('../web/activity/js/ui/admin-panel.js');
  assert.equal(fireSound('confetti', true), 'fx');
  assert.equal(fireSound('tacos', true), 'fx');
  assert.equal(fireSound('flip', true), 'whoosh');
  assert.equal(fireSound('clown', true), 'whoosh');
  assert.equal(fireSound('flip', false), 'error');
  const s = await mount({ admin: true });
  byKey(s.root, 'admin').click();
  byKey(s.app.panel.el, 'admin-tab-fun').click();
  s.clock.advance(300);
  byKey(s.app.panel.el, 'fx-confetti').click();
  assert.deepEqual(s.played.filter((n) => n !== 'toggle' && n !== 'tap'), ['fx']);
  byKey(s.app.panel.el, 'admin-tab-troll').click();
  s.clock.advance(300);
  byKey(s.app.panel.el, 'troll-flip').click();
  assert.equal(s.played.at(-1), 'whoosh');
  s.app.destroy();
});

function fakeSong() {
  const made = [];
  class Audio {
    constructor(src) {
      this.src = src;
      this.volume = 1;
      this.currentTime = 0;
      this.paused = true;
      made.push(this);
    }
    play() {
      this.paused = false;
      return Promise.resolve();
    }
    pause() {
      this.paused = true;
    }
  }
  return { Audio, made };
}

test('the taco song is quieter, follows the sound volume and stops on mute', async () => {
  const { songVolume, SONG_VOLUME } = await import('../web/activity/js/ui/trolls.js');
  assert.equal(SONG_VOLUME, 0.25);
  assert.equal(songVolume({ enabled: true, volume: 0.5 }), 0.25);
  assert.equal(songVolume({ enabled: true, volume: 1 }), 0.5);
  assert.equal(songVolume({ enabled: true, volume: 0.2 }), 0.1);
  assert.equal(songVolume({ enabled: false, volume: 1 }), 0);
  assert.equal(songVolume(null), 0);
  const s = await mount();
  const { Audio, made } = fakeSong();
  s.win.Audio = Audio;
  s.app.trolls.apply({ fx: 'tacos', target: null, ms: 9600, by: PAL });
  assert.equal(made.length, 1);
  assert.equal(made[0].volume, 0.25);
  s.sound.setVolume(0.8);
  assert.equal(made[0].volume, 0.4);
  s.sound.setEnabled(false);
  assert.equal(made[0].paused, true);
  s.app.trolls.clear();
  s.app.trolls.apply({ fx: 'tacos', target: null, ms: 9600, by: PAL });
  assert.equal(made.length, 1, 'muted means no taco song at all');
  s.app.destroy();
});

test('the unlock listener fires once on the first key or tap', async () => {
  const s = await mount();
  const added = [];
  const { window } = installDom();
  const target = { listeners: new Map(), addEventListener(type, fn) { added.push(type); this.listeners.set(type, fn); }, removeEventListener(type) { this.listeners.delete(type); } };
  const root = document.createElement('div');
  const unlocked = [];
  const sound = { enabled: true, volume: 0.5, play: () => true, setEnabled() {}, on: () => () => {}, unlock: () => unlocked.push(1) };
  const { mountApp } = await import('../web/activity/js/ui/app.js');
  const win = Object.assign(window, target, { document, parent: {}, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {} });
  const app = mountApp({ root, engine: s.engine, bridge: { close() {} }, win, sfx: sound, juice: false });
  assert.ok(added.includes('pointerdown') && added.includes('keydown'));
  target.listeners.get('pointerdown')(new FakeEvent('pointerdown'));
  assert.equal(unlocked.length, 1);
  assert.equal(target.listeners.has('pointerdown'), false);
  assert.equal(target.listeners.has('keydown'), false);
  app.destroy();
  s.app.destroy();
});
