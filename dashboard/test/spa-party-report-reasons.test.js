import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, flush, FakeEvent } from './dom-shim.js';

const { document } = installDom({ url: 'https://dash.example.test/party/reports' });
document.documentElement = document.createElement('html');
if (typeof globalThis.requestAnimationFrame !== 'function') globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
const { renderPartyReports, readReports, reasonBadge, sortByReason, REPORTS_PATH, NO_REASON } = await import('../web/js/pages/party-reports.js');
const { readPerson, reasonCountText, personStats } = await import('../web/js/pages/party-person.js');
const { state } = await import('../web/js/state.js');

const uid = (i) => `79797979-7979-4797-8797-${String(i).padStart(12, '0')}`;

function item(id, over = {}) {
  return {
    id,
    kind: 'text',
    game: 'hottakes',
    text: 'words',
    created: Date.now() - 60000,
    status: 'open',
    ink: [],
    drawer: { id: uid(1), name: 'Rex', username: 'rex', profile: null, banned: false, role: null },
    reporter: { id: uid(2), name: 'Mila', profile: null },
    ...over,
  };
}

function makeCtx(api) {
  const main = document.createElement('main');
  document.body.replaceChildren(main);
  const ctrl = new AbortController();
  return { api, main, signal: ctrl.signal, params: {}, setChrome() {}, abort: () => ctrl.abort() };
}

function api(reports) {
  const calls = [];
  return {
    calls,
    get: async (path) => {
      calls.push(path);
      if (path.startsWith(REPORTS_PATH)) {
        const want = new URL(path, 'https://x.test').searchParams.get('reason');
        return { reports: want ? reports.filter((r) => r.reason === want) : reports, next: null, open: reports.length, role: 'owner' };
      }
      return { bans: [], max: 1000, words: [] };
    },
    post: async () => ({ ok: true }),
    request: async () => ({ ok: true }),
  };
}

test('report cards read the reason and old reports say No reason given', () => {
  const view = readReports({ reports: [item('a', { reason: 'cheating', reasonNote: 'too fast' }), item('b'), item('c', { reason: 'evil', reasonNote: 'x' })] });
  assert.deepEqual(view.reports.map((r) => [r.reason, r.reasonNote]), [['cheating', 'too fast'], ['', ''], ['', '']]);
  assert.match(reasonBadge(view.reports[0]).textContent, /Cheating/);
  assert.match(reasonBadge(view.reports[1]).textContent, /No reason given/);
  assert.equal(NO_REASON, 'No reason given');
  assert.equal(reasonBadge({ kind: 'pack' }), null);
  const sorted = sortByReason([{ id: 1, reason: '' }, { id: 2, reason: 'spam' }, { id: 3, reason: 'cheating' }, { id: 4, reason: 'rude' }, { id: 5, reason: 'other' }, { id: 6, reason: 'spam' }]);
  assert.deepEqual(sorted.map((r) => r.id), [3, 4, 2, 6, 5, 1]);
});

test('the person history shows how many reports had each reason', () => {
  const model = readPerson({ person: { id: uid(1), name: 'Rex' }, counts: { total: 5, open: 2, reasons: { rude: 3, cheating: 1, spam: 0, other: 'x' } }, reports: [] });
  assert.deepEqual(model.counts.reasons, { rude: 3, spam: 0, cheating: 1, other: 0 });
  assert.equal(reasonCountText(model.counts), '3 rude, 1 cheating, 1 with no reason');
  assert.equal(reasonCountText({ total: 2, reasons: { rude: 0 } }), '');
  assert.equal(reasonCountText({ total: 1, reasons: { spam: 1 } }), '1 spam');
  const stats = personStats(model);
  assert.match(stats.textContent, /Reasons/);
  assert.match(stats.textContent, /3 rude, 1 cheating/);
  assert.doesNotMatch(personStats(readPerson({ person: { id: uid(1) }, counts: { total: 1 } })).textContent, /Reasons/);
});

test('the reports page shows a reason badge, filters by reason and sorts by reason', async () => {
  state.user = { id: uid(9), username: 'alice', display_name: 'Alice', avatar_url: '' };
  state.partyOwner = true;
  state.partyAdmin = true;
  const reports = [item('r1', { reason: 'spam' }), item('r2'), item('r3', { reason: 'cheating', reasonNote: 'always wins in 2 seconds' }), item('r4', { reason: 'rude' })];
  const a = api(reports);
  const ctx = makeCtx(a);
  renderPartyReports(ctx);
  await flush();
  const ids = () => ctx.main.querySelectorAll('.report-item').map((li) => li.dataset.id);
  assert.deepEqual(ids(), ['r1', 'r2', 'r3', 'r4']);
  const cards = ctx.main.querySelectorAll('.report-item');
  assert.match(cards[0].textContent, /Spam/);
  assert.match(cards[1].textContent, /No reason given/);
  assert.match(cards[2].textContent, /Cheating/);
  assert.match(cards[2].textContent, /always wins in 2 seconds/);
  const sort = ctx.main.querySelectorAll('select').find((x) => x.dataset.role === 'reason-sort');
  assert.deepEqual(sort.querySelectorAll('option').map((o) => o.textContent), ['Newest first', 'Sort by reason']);
  sort.value = 'reason';
  sort.dispatchEvent(new FakeEvent('change', { bubbles: true }));
  await flush();
  assert.deepEqual(ids(), ['r3', 'r4', 'r1', 'r2']);
  const pick = ctx.main.querySelectorAll('select').find((x) => x.dataset.role === 'reason-filter');
  assert.deepEqual(pick.querySelectorAll('option').map((o) => o.textContent), ['All reasons', 'Rude', 'Spam', 'Cheating', 'Other']);
  pick.value = 'cheating';
  pick.dispatchEvent(new FakeEvent('change', { bubbles: true }));
  await flush();
  assert.ok(a.calls.some((p) => p.startsWith(REPORTS_PATH) && p.includes('reason=cheating')));
  assert.deepEqual(ids(), ['r3']);
  pick.value = 'other';
  pick.dispatchEvent(new FakeEvent('change', { bubbles: true }));
  await flush();
  assert.match(ctx.main.textContent, /No reports marked other here/);
  ctx.abort();
});
