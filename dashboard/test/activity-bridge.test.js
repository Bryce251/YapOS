import test from 'node:test';
import assert from 'node:assert/strict';
import { connect, PARENT_ORIGINS, devMode, originAllowed, isDevOrigin } from '../web/activity/js/bridge.js';
import { OpBudget, OPS_MAX } from '../web/activity/js/limits.js';
import { person, people, safeAvatar, initials, cleanName, nameOf, idOf } from '../web/activity/js/players.js';

function fakeWindow(href = 'https://yapos.dev/activity/') {
  const posted = [];
  const listeners = [];
  const parent = {
    postMessage(m, origin) {
      posted.push({ m: JSON.parse(JSON.stringify(m)), origin });
    },
  };
  const loc = new URL(href);
  const win = {
    parent,
    location: loc,
    addEventListener(type, fn) {
      if (type === 'message') listeners.push(fn);
    },
  };
  const deliver = (data, origin = 'https://www.yapin.gg', source = parent) => {
    for (const fn of listeners) fn({ data, origin, source });
  };
  return { win, posted, deliver };
}

test('says hello to every allowed parent origin and nothing else', () => {
  const { win, posted } = fakeWindow();
  connect({ win });
  assert.deepEqual(posted.map((p) => p.origin), PARENT_ORIGINS);
  for (const p of posted) assert.deepEqual(p.m, { yapper: 1, type: 'ready' });
});

test('locks onto the first allowed origin and ignores everyone else', () => {
  const { win, posted, deliver } = fakeWindow();
  const api = connect({ win });
  const events = [];
  api.on('ready', (x) => events.push(['ready', x]));
  api.on('state', (x) => events.push(['state', x]));
  deliver({ yapper: 1, type: 'init', me: { id: 'u1' }, host: 'u1', participants: [], state: {} }, 'https://evil.example');
  deliver({ yapper: 1, type: 'init', me: { id: 'u1' } }, 'https://www.yapin.gg', {});
  assert.equal(api.ready, false);
  deliver({ yapper: 1, type: 'init', me: { id: 'u1' }, host: 'u1', participants: [{ id: 'u1' }], state: { a: 1 }, instance: 'i1' }, 'https://yapin.gg');
  assert.equal(api.ready, true);
  assert.deepEqual(api.state, { a: 1 });
  deliver({ yapper: 1, type: 'state', key: 'a', val: 2, by: 'u2' }, 'https://www.yapin.gg');
  assert.equal(api.state.a, 1);
  deliver({ yapper: 1, type: 'state', key: 'a', val: null, by: 'u2' }, 'https://yapin.gg');
  assert.equal('a' in api.state, false);
  assert.equal(events.length, 2);
  posted.length = 0;
  assert.equal(api.set('k', { x: 1 }), true);
  assert.equal(api.send({ t: 'join' }), true);
  assert.deepEqual(posted, [
    { m: { type: 'set', key: 'k', val: { x: 1 }, yapper: 1 }, origin: 'https://yapin.gg' },
    { m: { type: 'send', data: { t: 'join' }, yapper: 1 }, origin: 'https://yapin.gg' },
  ]);
});

test('nothing is posted before the parent answers', () => {
  const { win, posted } = fakeWindow();
  const api = connect({ win });
  posted.length = 0;
  assert.equal(api.set('k', 1), false);
  assert.equal(api.send({}), false);
  assert.equal(posted.length, 0);
});

test('enforces key, size and rate limits before posting', () => {
  const { win, posted, deliver } = fakeWindow();
  let t = 0;
  const api = connect({ win, now: () => t, budget: new OpBudget(OPS_MAX, 10000) });
  deliver({ yapper: 1, type: 'init', me: 'u1', host: 'u1', participants: [], state: {} });
  const limits = [];
  api.on('limit', (x) => limits.push(x.reason));
  posted.length = 0;
  assert.equal(api.set('bad key!', 1), false);
  assert.equal(api.set('k', 'x'.repeat(5000)), false);
  assert.equal(api.send({ big: 'x'.repeat(5000) }), false);
  for (let i = 0; i < OPS_MAX; i += 1) assert.equal(api.set('k', i), true);
  assert.equal(api.send({ t: 1 }), false);
  assert.equal(api.opsLeft(), 0);
  t = 10001;
  assert.equal(api.send({ t: 1 }), true);
  assert.deepEqual(limits, ['bad_key', 'too_big', 'too_big', 'rate']);
  assert.equal(posted.length, OPS_MAX + 1);
});

test('dev origins only count on localhost with dev=1', () => {
  assert.equal(devMode(new URL('http://localhost:8787/activity/?dev=1')), true);
  assert.equal(devMode(new URL('http://127.0.0.1:8787/activity/?dev=1')), true);
  assert.equal(devMode(new URL('http://localhost:8787/activity/')), false);
  assert.equal(devMode(new URL('https://yapos.dev/activity/?dev=1')), false);
  assert.equal(devMode(new URL('https://localhost.yapos.dev/activity/?dev=1')), false);
  assert.equal(isDevOrigin('http://localhost:8787'), true);
  assert.equal(isDevOrigin('http://localhost.evil.example'), false);
  assert.equal(isDevOrigin('null'), false);
  assert.equal(originAllowed('http://localhost:8787', false), false);
  assert.equal(originAllowed('http://localhost:8787', true), true);
  assert.equal(originAllowed('https://www.yapper.website', false), true);
  const prod = fakeWindow('https://yapos.dev/activity/?dev=1');
  const api = connect({ win: prod.win });
  prod.deliver({ yapper: 1, type: 'init', me: 'u1', host: 'u1', participants: [], state: {} }, 'http://localhost:8787');
  assert.equal(api.ready, false);
  const dev = fakeWindow('http://localhost:8787/activity/?dev=1');
  const api2 = connect({ win: dev.win });
  assert.ok(dev.posted.some((p) => p.origin === 'http://localhost:8787'));
  dev.deliver({ yapper: 1, type: 'init', me: 'u1', host: 'u1', participants: [], state: {} }, 'http://localhost:8787');
  assert.equal(api2.ready, true);
});

test('participants are read safely', () => {
  assert.equal(nameOf({ displayName: 'Ana' }), 'Ana');
  assert.equal(nameOf({ username: 'bo' }), 'bo');
  assert.equal(nameOf({}), 'Player');
  assert.equal(cleanName('  a‮b  c '), 'ab c');
  assert.equal(Array.from(cleanName('x'.repeat(40))).length, 24);
  assert.equal(initials('Ada Lovelace'), 'AL');
  assert.equal(initials('zed'), 'Z');
  assert.equal(idOf({ id: 5 }), '5');
  assert.equal(idOf('abc'), 'abc');
  assert.equal(safeAvatar('https://files.yapper.website/a.png'), 'https://files.yapper.website/a.png');
  assert.equal(safeAvatar('https://www.yapin.gg/x.png'), 'https://www.yapin.gg/x.png');
  assert.equal(safeAvatar('http://files.yapper.website/a.png'), null);
  assert.equal(safeAvatar('https://evil.example/a.png'), null);
  assert.equal(safeAvatar('javascript:alert(1)'), null);
  assert.equal(person({ id: 'u', avatar_url: 'https://evil.example/a.png' }).avatar, null);
  assert.deepEqual(people([{ id: 'a' }, { id: 'a' }, null, { name: 'no id' }]).map((p) => p.id), ['a']);
});
