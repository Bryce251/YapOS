import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, FakeEvent, flush } from './dom-shim.js';
import { configureAdmins, resetAdmins, refreshAdmins, isBanned, banUntil, bannedIds } from '../web/activity/js/admin.js';
import { createWarnings, readWarnings, WARNINGS_ENDPOINT, WARNING_TITLE } from '../web/activity/js/ui/warning.js';
import { partyBanText, banLeftText, PARTY_BANNED_TEXT } from '../web/activity/js/ui/app.js';

const REX = '77777777-7777-4777-8777-000000000001';
const JUNO = '77777777-7777-4777-8777-000000000002';
const HOUR = 3600000;

test('timed Party bans come from the admin check and end on their own in the call', async () => {
  resetAdmins();
  let clock = 1000;
  const end = clock + HOUR;
  configureAdmins({
    now: () => clock,
    refreshMs: 0,
    fetch: async () => ({ ok: true, json: async () => ({ admins: [], owner: null, banned: [REX, JUNO], until: { [REX]: end, nope: 5 } }) }),
  });
  await refreshAdmins([REX, JUNO]);
  assert.equal(isBanned(REX), true);
  assert.equal(banUntil(REX), end);
  assert.equal(banUntil(JUNO), null, 'forever bans have no end');
  assert.deepEqual(bannedIds().sort(), [REX, JUNO].sort());
  clock = end - 1;
  assert.equal(isBanned(REX), true);
  clock = end;
  assert.equal(isBanned(REX), false, 'the ban stops at its end time even before the next check');
  assert.equal(banUntil(REX), null);
  assert.deepEqual(bannedIds(), [JUNO]);
  assert.equal(isBanned(JUNO), true);
  resetAdmins();
});

test('banned players see when they can play again', () => {
  const now = Date.UTC(2026, 10, 16, 12, 0, 0);
  assert.match(partyBanText(now + 3 * HOUR, now), /^You can't join games until .+ \(in 3 hours\)\.$/);
  assert.match(partyBanText(now + 3 * 24 * HOUR, now), /\(in 3 days\)/);
  assert.equal(partyBanText(null, now), PARTY_BANNED_TEXT);
  assert.equal(partyBanText(now - 1, now), PARTY_BANNED_TEXT);
  assert.equal(banLeftText(30 * 60000), '30 minutes');
  assert.equal(banLeftText(30000), 'about a minute');
});

test('warnings from the server are read safely', () => {
  const list = readWarnings({ warnings: [{ id: 'w1', text: '  No spam  ', created: 5 }, { id: 'bad id', text: 'x' }, { id: 'w2', text: '' }, null, { id: 'w3', text: 'y'.repeat(500) }] });
  assert.deepEqual(list.map((w) => w.id), ['w1', 'w3']);
  assert.equal(list[0].text, 'No spam');
  assert.equal(list[1].text.length, 200);
  assert.deepEqual(readWarnings(null), []);
});

function setup({ status = 'in', me = REX, token = 'tok', list = [] } = {}) {
  const { window, document } = installDom({ url: 'https://yapos.dev/activity/' });
  const calls = [];
  const gateState = { status, me, token };
  const gate = { state: () => ({ ...gateState }) };
  let server = list.slice();
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (init.method === 'POST') {
      const id = decodeURIComponent(url.split('/')[4]);
      server = server.filter((w) => w.id !== id);
      return { ok: true, json: async () => ({ ok: true, seen: true }) };
    }
    return { ok: true, json: async () => ({ warnings: server }) };
  };
  let clock = 0;
  const intervals = [];
  window.setInterval = (fn, ms) => {
    intervals.push({ fn, ms });
    return intervals.length;
  };
  window.clearInterval = () => {};
  const w = createWarnings({ win: window, gate, fetchImpl, now: () => clock });
  document.body.appendChild(w.el);
  return { window, document, w, calls, gateState, intervals, tick: (ms) => { clock += ms; }, setServer: (x) => { server = x; } };
}

test('signed-in players get a blocking warning and mark it seen with I understand', async () => {
  const s = setup({ list: [{ id: 'w1', text: 'Keep drawings clean', created: 1 }, { id: 'w2', text: 'No spam', created: 2 }] });
  assert.equal(s.w.el.hidden, true);
  s.w.update();
  await flush();
  await flush();
  assert.equal(s.calls[0].url, `${WARNINGS_ENDPOINT}?for=${REX}`);
  assert.equal(s.calls[0].init.headers.Authorization, 'Bearer tok');
  assert.equal(s.calls[0].init.method, 'GET');
  assert.equal(s.w.el.hidden, false);
  const card = s.w.el.querySelector('.warn-card');
  assert.equal(card.getAttribute('role'), 'alertdialog');
  assert.match(s.w.el.textContent, new RegExp(WARNING_TITLE.slice(3)));
  assert.equal(s.w.el.querySelector('.warn-text').textContent, 'Keep drawings clean');
  s.w.el.dispatchEvent(new FakeEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(s.w.el.hidden, false, 'Escape does not skip a warning');
  const ok = s.w.el.querySelector('.warn-actions button');
  assert.equal(ok.textContent, 'I understand');
  ok.dispatchEvent(new FakeEvent('click', { bubbles: true }));
  await flush();
  await flush();
  assert.equal(s.calls[1].url, `${WARNINGS_ENDPOINT}/w1/seen`);
  assert.equal(s.calls[1].init.method, 'POST');
  assert.equal(s.calls[1].init.headers.Authorization, 'Bearer tok');
  assert.equal(s.w.el.querySelector('.warn-text').textContent, 'No spam', 'the next one shows straight away');
  s.w.ack();
  await flush();
  assert.equal(s.w.el.hidden, true);
  s.tick(20000);
  await s.w.check();
  assert.equal(s.w.el.hidden, true, 'seen warnings never come back');
  s.w.destroy();
});

test('players who are not signed in, or signed in as someone else, are never asked', async () => {
  for (const status of ['out', 'mismatch', 'checking', 'skipped']) {
    const s = setup({ status, list: [{ id: 'w1', text: 'Hi', created: 1 }] });
    s.w.update();
    await s.w.check(true);
    assert.equal(s.calls.length, 0, status);
    assert.equal(s.w.el.hidden, true);
    s.w.destroy();
  }
});

test('the server saying the account does not match shows nothing', async () => {
  const { window } = installDom({ url: 'https://yapos.dev/activity/' });
  const calls = [];
  const w = createWarnings({
    win: window,
    gate: { state: () => ({ status: 'in', me: REX, token: null }) },
    fetchImpl: async (url, init) => {
      calls.push(init);
      return { ok: true, json: async () => ({ warnings: [{ id: 'w1', text: 'not yours' }], mismatch: true }) };
    },
  });
  w.update();
  await flush();
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers.Authorization, undefined, 'dashboard sign-ins use the cookie');
  assert.equal(w.el.hidden, true);
  w.destroy();
});

test('the poll is light: once on start, every minute, and when the call comes back into view', async () => {
  const s = setup({ list: [] });
  assert.equal(s.intervals.length, 1);
  assert.equal(s.intervals[0].ms, 60000);
  s.w.update();
  s.w.update();
  await flush();
  assert.equal(s.calls.length, 1, 'repeat updates do not refetch');
  s.document.visibilityState = 'visible';
  s.document.dispatchEvent(new FakeEvent('visibilitychange'));
  await flush();
  assert.equal(s.calls.length, 1, 'coming back right away does not refetch');
  s.tick(16000);
  s.document.dispatchEvent(new FakeEvent('visibilitychange'));
  await flush();
  assert.equal(s.calls.length, 2);
  s.setServer([{ id: 'w9', text: 'No cheating', created: 9 }]);
  s.intervals[0].fn();
  await flush();
  await flush();
  assert.equal(s.calls.length, 3);
  assert.equal(s.w.el.querySelector('.warn-text').textContent, 'No cheating');
  s.document.visibilityState = 'hidden';
  s.intervals[0].fn();
  await flush();
  assert.equal(s.calls.length, 3, 'no polling while the call is hidden');
  s.setServer([]);
  s.gateState.me = JUNO;
  s.w.update();
  await flush();
  assert.equal(s.w.el.hidden, true, 'switching accounts clears the dialog');
  assert.equal(s.calls[s.calls.length - 1].url, `${WARNINGS_ENDPOINT}?for=${JUNO}`);
  s.w.destroy();
});
