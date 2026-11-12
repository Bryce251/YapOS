import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, OFFLINE_MESSAGE, createApi, isPending, pollDelay } from '../web/js/api.js';

function jsonResponse(status, body, headers = {}) {
  return new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

function harness(responses) {
  const calls = [];
  let unauthorized = 0;
  const queue = responses.slice();
  const api = createApi({
    fetchImpl: async (path, init) => {
      calls.push({ path, init });
      const next = queue.shift();
      if (typeof next === 'function') return next(path, init);
      return next;
    },
    onUnauthorized: () => {
      unauthorized += 1;
    },
    sleep: async () => {},
  });
  return { api, calls, get unauthorized() { return unauthorized; } };
}

test('GET sends cookies same-origin and no csrf header', async () => {
  const t = harness([jsonResponse(200, { user: { id: 'u' } })]);
  const data = await t.api.get('/api/me');
  assert.deepEqual(data, { user: { id: 'u' } });
  assert.equal(t.calls[0].init.method, 'GET');
  assert.equal(t.calls[0].init.credentials, 'same-origin');
  assert.equal(t.calls[0].init.headers['X-YapOS'], undefined);
  assert.equal(t.calls[0].init.body, undefined);
});

test('mutations send JSON with the X-YapOS header', async () => {
  const t = harness([jsonResponse(202, { pending: true, job: 'j1' })]);
  const data = await t.api.patch('/api/servers/s/apps/levels', { enabled: true });
  assert.equal(isPending(data), true);
  const { init } = t.calls[0];
  assert.equal(init.method, 'PATCH');
  assert.equal(init.credentials, 'same-origin');
  assert.equal(init.headers['X-YapOS'], '1');
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.equal(init.body, JSON.stringify({ enabled: true }));
});

test('401 triggers the global handler unless allowed', async () => {
  const t = harness([jsonResponse(401, { error: 'unauthorized', message: 'Log in first.' }), jsonResponse(401, {})]);
  await assert.rejects(t.api.get('/api/servers'), (e) => e instanceof ApiError && e.status === 401);
  assert.equal(t.unauthorized, 1);
  await assert.rejects(t.api.get('/api/me', { allow401: true }), (e) => e.status === 401);
  assert.equal(t.unauthorized, 1);
});

test('errors use the worker message', async () => {
  const t = harness([jsonResponse(403, { error: 'forbidden', message: 'This request was blocked for your safety.' }), new Response('oops', { status: 500 })]);
  await assert.rejects(t.api.post('/api/x', {}), (e) => e.message === 'This request was blocked for your safety.' && e.status === 403);
  await assert.rejects(t.api.get('/api/x'), (e) => /our side/.test(e.message) && e.code === 'http_500');
});

test('network failures become friendly errors', async () => {
  const t = harness([() => {
    throw new TypeError('Failed to fetch');
  }]);
  await assert.rejects(t.api.get('/api/me'), (e) => e.code === 'network');
});

test('run() polls a pending job until done', async () => {
  const t = harness([
    jsonResponse(202, { pending: true, job: 'abc' }),
    jsonResponse(200, { status: 'pending' }),
    jsonResponse(429, { error: 'rate_limited' }, { 'Retry-After': '1' }),
    jsonResponse(200, { status: 'pending' }),
    jsonResponse(200, { status: 'done', result: { grant: true, applied: { a: 1 }, errors: {} } }),
  ]);
  let pendingJob = null;
  const out = await t.api.run('PATCH', '/api/servers/s/apps/x', { settings: { a: 1 } }, { onPending: (id) => {
    pendingJob = id;
  } });
  assert.equal(pendingJob, 'abc');
  assert.equal(out.fromJob, true);
  assert.deepEqual(out.data.applied, { a: 1 });
  assert.ok(t.calls.slice(1).every((c) => c.path === '/api/jobs/abc' && c.init.method === 'GET'));
});

test('job timeout maps to the offline message', async () => {
  const t = harness([jsonResponse(200, { status: 'error', error: 'timeout', message: OFFLINE_MESSAGE })]);
  await assert.rejects(t.api.job('j'), (e) => e.code === 'timeout' && e.message === OFFLINE_MESSAGE);
});

test('job denial maps to forbidden', async () => {
  const t = harness([jsonResponse(200, { status: 'error', error: 'You need to be an admin of this server.', message: 'You need to be an admin of this server.', result: { grant: false } })]);
  await assert.rejects(t.api.job('j'), (e) => e.code === 'forbidden' && e.status === 403);
});

test('job polling stops when aborted', async () => {
  const ctrl = new AbortController();
  let polls = 0;
  const api = createApi({
    fetchImpl: async () => {
      polls += 1;
      if (polls === 2) ctrl.abort();
      return jsonResponse(200, { status: 'pending' });
    },
    sleep: async () => {},
  });
  await assert.rejects(api.job('j', { signal: ctrl.signal }), (e) => e.name === 'AbortError');
  assert.equal(polls, 2);
});

test('poll delays back off and cap', () => {
  assert.equal(pollDelay(0), 700);
  assert.ok(pollDelay(3) >= pollDelay(1));
  assert.equal(pollDelay(50), 4000);
});

test('an expired grant is re-checked through the access job and the request is retried once', async () => {
  const t = harness([
    jsonResponse(403, { error: 'grant_required', message: 'Checking your access', job: 'acc1' }),
    jsonResponse(200, { status: 'pending' }),
    jsonResponse(200, { status: 'done', result: { grant: true, level: 'admin' } }),
    jsonResponse(200, { cases: [], total: 0 }),
  ]);
  const data = await t.api.get('/api/servers/s/cases?page=1');
  assert.deepEqual(data, { cases: [], total: 0 });
  assert.deepEqual(t.calls.map((c) => c.path), ['/api/servers/s/cases?page=1', '/api/jobs/acc1', '/api/jobs/acc1', '/api/servers/s/cases?page=1']);
});

test('a re-check that says no access ends as a forbidden error, and a second grant_required is not retried', async () => {
  const denied = harness([
    jsonResponse(403, { error: 'grant_required', job: 'acc2' }),
    jsonResponse(200, { status: 'error', error: 'You need to be an admin of this server.', result: { grant: false, level: 'member' } }),
  ]);
  await assert.rejects(denied.api.get('/api/servers/s/cases'), (e) => e instanceof ApiError && e.status === 403 && e.code === 'forbidden' && /admin/.test(e.message));
  const loop = harness([
    jsonResponse(403, { error: 'grant_required', job: 'acc3' }),
    jsonResponse(200, { status: 'done', result: { grant: true } }),
    jsonResponse(403, { error: 'grant_required', job: 'acc4' }),
  ]);
  await assert.rejects(loop.api.patch('/api/servers/s/apps/levels', { enabled: true }), (e) => e instanceof ApiError && e.status === 403);
  assert.equal(loop.calls.length, 3);
});
