import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, type, fire, flush } from './dom-shim.js';

const { document } = installDom({ url: 'https://dash.example.test/servers/33333333-3333-4333-8333-333333333333/cases' });
const { ApiError } = await import('../web/js/api.js');
const { state, setDetail } = await import('../web/js/state.js');
const { renderCases } = await import('../web/js/pages/cases.js');
const { renderPublicSettings } = await import('../web/js/pages/public-settings.js');
const { renderApps } = await import('../web/js/pages/apps.js');

const SID = '33333333-3333-4333-8333-333333333333';

function makeCtx(api) {
  const main = document.createElement('main');
  document.body.replaceChildren(main);
  const ctrl = new AbortController();
  const ctx = { api, params: { sid: SID }, signal: ctrl.signal, main, setChrome() {}, setLeaveGuard(g) { ctx.guard = g; }, guard: null, abort: () => ctrl.abort() };
  return ctx;
}

const never = () => new Promise(() => {});
const detail = (extra = {}) => ({ overview: { id: SID, name: 'Test Town' }, apps: [], settings: {}, updatedAt: 1, level: 'admin', ...extra });

test('typing in the case search before the cases load keeps the loading view', async () => {
  state.details.clear();
  const ctx = makeCtx({ get: never, job: never });
  renderCases(ctx);
  await flush();
  const search = ctx.main.querySelector('input[type=search]');
  assert.match(ctx.main.textContent, /Loading cases/);
  type(search, 'spam');
  assert.match(ctx.main.textContent, /Loading cases/);
  assert.doesNotMatch(ctx.main.textContent, /No cases yet/);
  fire(ctx.main.querySelectorAll('select')[1], 'change');
  assert.doesNotMatch(ctx.main.textContent, /No cases yet/);
  assert.match(window.location.search, /q=spam/);
  ctx.abort();
});

test('typing in the case search keeps a no-access or offline error on screen', async () => {
  for (const [err, text] of [
    [new ApiError('You need to be an admin of this server.', { status: 403, code: 'forbidden' }), /No access to this server/],
    [new ApiError('offline', { code: 'timeout' }), /hasn't answered/],
  ]) {
    state.details.clear();
    const ctx = makeCtx({ get: async () => { throw err; }, job: never });
    renderCases(ctx);
    await flush();
    assert.match(ctx.main.textContent, text);
    type(ctx.main.querySelector('input[type=search]'), 'ban');
    assert.match(ctx.main.textContent, text);
    assert.doesNotMatch(ctx.main.textContent, /No cases yet/);
    ctx.abort();
  }
});

test('the case search still filters once the cases are loaded', async () => {
  state.details.clear();
  window.history.replaceState(null, '', `/servers/${SID}/cases`);
  const cases = [
    { n: 2, type: 'ban', user: { id: 'u1', name: 'Ava' }, mod: { id: 'm1', name: 'Mo' }, reason: 'raid', at: 2000 },
    { n: 1, type: 'warn', user: { id: 'u2', name: 'Ben' }, mod: { id: 'm1', name: 'Mo' }, reason: 'caps', at: 1000 },
  ];
  const ctx = makeCtx({
    get: async (path) => (path.includes('/cases') ? { cases, total: 2, page: 1, pages: 1 } : detail()),
    job: never,
  });
  renderCases(ctx);
  await flush();
  assert.equal(ctx.main.querySelectorAll('td.col-n').length, 2);
  type(ctx.main.querySelector('input[type=search]'), 'ava');
  assert.equal(ctx.main.querySelectorAll('td.col-n').length, 1);
  type(ctx.main.querySelector('input[type=search]'), '');
  ctx.abort();
});

test('the public page settings explain the one global leaderboard and link to it', async () => {
  state.details.clear();
  const ctx = makeCtx({ get: never, job: never, run: never });
  renderPublicSettings(ctx);
  await flush();
  const text = ctx.main.textContent;
  assert.match(text, /one leaderboard/i);
  assert.match(text, /Shards/);
  assert.doesNotMatch(text, /Wrapped/i);
  const link = ctx.main.querySelectorAll('a').find((a) => /^\/p\//.test(String(a.href || '')));
  assert.ok(link, 'the page links to the leaderboard');
  assert.equal(link.href, '/p/global');
  ctx.abort();
});

test('the public page settings have no toggle, no address field and no leave guard', async () => {
  state.details.clear();
  const ctx = makeCtx({ get: never, job: never, run: never });
  renderPublicSettings(ctx);
  await flush();
  assert.equal(ctx.main.querySelector('button.switch'), null);
  assert.equal(ctx.main.querySelector('input.input-mono'), null);
  assert.equal(ctx.main.querySelectorAll('button').filter((b) => /Save/.test(b.textContent)).length, 0);
  assert.equal(ctx.guard, null);
  ctx.abort();
});

test('searching while an app switch waits on YapOS keeps the switch busy at its new value', async () => {
  state.details.clear();
  const apps = [
    { id: 'games', name: 'Games', category: 'Fun', description: 'Play', enabled: true, canDisable: true, settingsCount: 0 },
    { id: 'levels', name: 'Levels', category: 'Community', description: 'XP', enabled: false, canDisable: true, settingsCount: 0 },
  ];
  setDetail(SID, detail({ apps }));
  let finish = null;
  let calls = 0;
  const ctx = makeCtx({
    get: async () => detail({ apps }),
    job: never,
    run: (method, path, body, opts) => {
      calls++;
      opts.onPending?.('job-1');
      return new Promise((resolve) => { finish = () => resolve({ data: { grant: true, applied: { enabled: body.enabled }, errors: {} } }); });
    },
  });
  renderApps(ctx);
  await flush();
  const gamesSwitch = () => ctx.main.querySelector('button[aria-label="Games installed"]');
  gamesSwitch().click();
  await flush();
  assert.equal(calls, 1);
  type(ctx.main.querySelector('input[type=search]'), 'gam');
  const sw = gamesSwitch();
  assert.equal(sw.getAttribute('aria-checked'), 'false');
  assert.equal(sw.disabled, true);
  assert.ok(sw.classList.contains('is-busy'));
  assert.match(ctx.main.textContent, /Waiting for YapOS/);
  sw.click();
  assert.equal(calls, 1, 'a second change is not sent while the first one waits');
  finish();
  await flush();
  const done = gamesSwitch();
  assert.equal(done.getAttribute('aria-checked'), 'false');
  assert.equal(done.disabled, false);
  assert.ok(!done.classList.contains('is-busy'));
  assert.doesNotMatch(ctx.main.textContent, /Waiting for YapOS/);
  assert.equal(apps[0].enabled, false);
  ctx.abort();
});

test('a failed app change puts the switch back after the tile was redrawn', async () => {
  state.details.clear();
  const apps = [{ id: 'games', name: 'Games', category: 'Fun', description: 'Play', enabled: true, canDisable: true, settingsCount: 0 }];
  setDetail(SID, detail({ apps }));
  let fail = null;
  const ctx = makeCtx({
    get: async () => detail({ apps }),
    job: never,
    run: () => new Promise((resolve, reject) => { fail = () => reject(new ApiError('YapOS said no.', { code: 'job_error' })); }),
  });
  renderApps(ctx);
  await flush();
  ctx.main.querySelector('button.switch').click();
  await flush();
  type(ctx.main.querySelector('input[type=search]'), 'g');
  assert.equal(ctx.main.querySelector('button.switch').getAttribute('aria-checked'), 'false');
  fail();
  await flush();
  const sw = ctx.main.querySelector('button.switch');
  assert.equal(sw.getAttribute('aria-checked'), 'true');
  assert.equal(sw.disabled, false);
  assert.equal(apps[0].enabled, true);
  ctx.abort();
});
