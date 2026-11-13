import { OpBudget, checkSet, checkSend, OPS_MAX, OPS_WINDOW_MS } from '../web/activity/js/limits.js';
import { createEngine } from '../web/activity/js/engine.js';
import { GAMES } from '../web/activity/js/games/index.js';

export class Clock {
  constructor(start = 1_700_000_000_000) {
    this.t = start;
    this.queue = [];
    this.seq = 0;
    this.now = () => this.t;
    this.setTimeout = (fn, ms) => {
      const id = ++this.seq;
      this.queue.push({ id, at: this.t + Math.max(0, ms || 0), fn });
      return id;
    };
    this.clearTimeout = (id) => {
      this.queue = this.queue.filter((x) => x.id !== id);
    };
  }

  async advance(ms) {
    const end = this.t + ms;
    for (;;) {
      await Promise.resolve();
      this.queue.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = this.queue[0];
      if (!next || next.at > end) break;
      this.queue.shift();
      this.t = Math.max(this.t, next.at);
      next.fn();
    }
    this.t = end;
    await Promise.resolve();
  }
}

export function seeded(seed = 7) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export class Hub {
  constructor(clock, { latency = 20 } = {}) {
    this.clock = clock;
    this.latency = latency;
    this.state = {};
    this.people = [];
    this.host = null;
    this.clients = new Map();
    this.budgets = new Map();
    this.violations = [];
    this.ops = [];
  }

  later(fn) {
    this.clock.setTimeout(fn, this.latency);
  }

  participants() {
    return this.people.map((p) => ({ ...p }));
  }

  join(person) {
    this.people.push(person);
    if (!this.host) this.host = person.id;
    const handlers = {};
    const hub = this;
    const client = {
      ready: false,
      me: { ...person },
      host: null,
      participants: [],
      state: {},
      on(ev, fn) {
        (handlers[ev] = handlers[ev] || []).push(fn);
        if (ev === 'ready' && client.ready) fn({});
        return client;
      },
      off(ev, fn) {
        handlers[ev] = (handlers[ev] || []).filter((f) => f !== fn);
        return client;
      },
      set(key, val) {
        return hub.set(person.id, key, val);
      },
      send(data) {
        return hub.send(person.id, data);
      },
      emit(ev, x) {
        for (const fn of (handlers[ev] || []).slice()) fn(x);
      },
    };
    this.clients.set(person.id, client);
    this.budgets.set(person.id, new OpBudget(OPS_MAX, OPS_WINDOW_MS));
    this.later(() => {
      client.host = this.host;
      client.participants = this.participants();
      client.state = JSON.parse(JSON.stringify(this.state));
      client.ready = true;
      client.emit('ready', {});
    });
    this.roster();
    return client;
  }

  leave(id) {
    this.people = this.people.filter((p) => p.id !== id);
    this.clients.delete(id);
    if (this.host === id) this.host = this.people.length ? this.people[0].id : null;
    this.roster();
  }

  roster() {
    const list = this.participants();
    const host = this.host;
    this.later(() => {
      for (const c of this.clients.values()) {
        if (!c.ready) continue;
        c.host = host;
        c.participants = list.map((p) => ({ ...p }));
        c.emit('participants', { participants: c.participants, host });
      }
    });
  }

  spend(id, what) {
    const b = this.budgets.get(id);
    if (!b) return false;
    const now = this.clock.now();
    if (b.available(now) < 1) {
      this.violations.push({ id, what, reason: 'rate' });
      return false;
    }
    b.spend(now);
    this.ops.push({ id, at: now, what });
    return true;
  }

  set(id, key, val) {
    if (!this.clients.has(id)) return false;
    const problem = checkSet(this.state, key, val);
    if (problem) {
      this.violations.push({ id, what: key, reason: problem });
      return false;
    }
    if (!this.spend(id, `set:${key}`)) return false;
    if (val === null) delete this.state[key];
    else this.state[key] = JSON.parse(JSON.stringify(val));
    const copy = val === null ? null : JSON.parse(JSON.stringify(val));
    this.later(() => {
      for (const c of this.clients.values()) {
        if (!c.ready) continue;
        if (copy === null) delete c.state[key];
        else c.state[key] = JSON.parse(JSON.stringify(copy));
        c.emit('state', { key, value: copy, by: id });
      }
    });
    return true;
  }

  send(id, data) {
    if (!this.clients.has(id)) return false;
    const problem = checkSend(data);
    if (problem) {
      this.violations.push({ id, what: 'send', reason: problem });
      return false;
    }
    if (!this.spend(id, 'send')) return false;
    const copy = JSON.parse(JSON.stringify(data));
    this.later(() => {
      for (const [cid, c] of this.clients) {
        if (cid === id || !c.ready) continue;
        c.emit('message', { data: JSON.parse(JSON.stringify(copy)), by: id });
      }
    });
    return true;
  }

  opsBy(id, from, to) {
    return this.ops.filter((o) => o.id === id && o.at >= from && o.at < to).length;
  }
}

export function person(n) {
  return { id: `0000000${n}-aaaa-4bbb-8ccc-${String(n).padStart(12, '0')}`, display_name: `Player ${n}` };
}

export function room(count = 3, opts = {}) {
  const clock = new Clock();
  const hub = new Hub(clock, opts);
  const random = seeded(opts.seed || 11);
  const engines = [];
  const add = (n) => {
    const t = hub.join(person(n));
    const e = createEngine({ transport: t, games: opts.games || GAMES, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, random });
    if (opts.join !== false) e.join();
    engines.push(e);
    return e;
  };
  for (let i = 1; i <= count; i += 1) add(i);
  return { clock, hub, engines, add, person };
}
