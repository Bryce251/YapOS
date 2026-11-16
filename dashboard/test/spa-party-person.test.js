import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { installDom, flush, FakeEvent } from './dom-shim.js';
import { encodeStroke } from '../web/activity/js/games/ink.js';

const { document } = installDom({ url: 'https://dash.example.test/party/reports' });
document.documentElement = document.createElement('html');
if (typeof globalThis.requestAnimationFrame !== 'function') globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
const { renderPartyReports, REPORTS_PATH, BANS_PATH } = await import('../web/js/pages/party-reports.js');
const { readPerson, filterHistory, canBanPerson, reportCountText, profileUrl, personUrl, PERSON_PATH } = await import('../web/js/pages/party-person.js');
const { state } = await import('../web/js/state.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const uid = (i) => `77777777-7777-4777-8777-${String(i).padStart(12, '0')}`;
const S1 = encodeStroke({ c: 3, z: 1, pts: [[10, 10], [40, 40], [60, 80]] });
const REX = uid(1);

const REPLAY = { v: 1, kind: 'ink', authors: [{ id: REX, name: 'Rex', profile: null, banned: false, role: null }, { id: uid(3), name: 'Juno', profile: null, banned: false, role: null }], events: [[0, 0, S1], [1, 10, S1]] };

function report(id, over = {}) {
  return { id, kind: 'drawing', game: 'draw', word: 'cat', created: Date.now(), status: 'open', ink: [S1], drawer: { id: REX, name: 'Rex', username: 'rexplorer', profile: null, banned: false, role: null }, reporter: { id: uid(2), name: 'Mila', profile: null }, ...over };
}

function personData(over = {}) {
  return {
    person: { id: REX, name: 'Real Rex', username: 'realrex', avatar: null, role: null, banned: null, card: { hidden: false, name: 'Real Rex', username: 'realrex', level: 12, badges: [{ id: 'party-10', label: 'Party Starter', emoji: '🎉' }], badgeCount: 1, party: { games: 40, wins: 9 }, rank: { rank: 7, points: 300 }, page: true } },
    counts: { total: 3, open: 2, first: Date.now() - 86400000, last: Date.now(), made: 1, games: [{ game: 'draw', n: 2, drawings: 2 }, { game: 'hottakes', n: 1, drawings: 0 }] },
    bans: [{ action: 'unban', reason: null, by: uid(9), at: Date.now() - 1000 }, { action: 'ban', reason: 'Drew rude stuff', by: uid(9), at: Date.now() - 5000 }],
    reports: [report('r1', { replay: REPLAY }), report('r2', { status: 'dismissed' }), { ...report('r3', { game: 'hottakes', word: null }), kind: 'text', text: 'rude words', ink: [] }],
    more: false,
    role: 'owner',
    ...over,
  };
}

function buttons(root, re) {
  return [...root.querySelectorAll('button')].filter((b) => re.test(b.textContent) || re.test(b.getAttribute('aria-label') || ''));
}

function click(el) {
  el.dispatchEvent(new FakeEvent('click', { bubbles: true }));
}

test('person data is read safely and the quick filters work', () => {
  const m = readPerson(personData());
  assert.equal(m.person.name, 'Real Rex');
  assert.equal(m.person.card.level, 12);
  assert.equal(m.person.card.rank, 7);
  assert.equal(m.counts.games.length, 2);
  assert.deepEqual(m.bans.map((b) => b.action), ['unban', 'ban']);
  assert.equal(filterHistory(m.reports, { status: 'open' }).length, 2);
  assert.equal(filterHistory(m.reports, { kind: 'text' }).length, 1);
  assert.equal(filterHistory(m.reports, { game: 'draw', status: 'dismissed' }).length, 1);
  assert.equal(reportCountText(m.counts), '3 reports, 2 open');
  assert.equal(reportCountText({ total: 0, open: 0 }), 'No reports against them yet');
  assert.equal(profileUrl(m), '/u/realrex');
  assert.equal(profileUrl(readPerson({ person: { id: REX, card: { hidden: true } } })), '');
  assert.equal(personUrl('a b'), `${PERSON_PATH}a%20b`);
  const empty = readPerson(null);
  assert.deepEqual([empty.person.id, empty.reports.length, empty.counts.total], ['', 0, 0]);
  assert.equal(canBanPerson({ id: REX, banned: null, role: '' }, 'admin'), true);
  assert.equal(canBanPerson({ id: REX, banned: { at: 1 }, role: '' }, 'owner'), false);
  assert.equal(canBanPerson({ id: REX, banned: null, role: 'admin' }, 'admin'), false, 'only the owner bans party admins');
  assert.equal(canBanPerson({ id: REX, banned: null, role: 'admin' }, 'owner'), true);
  assert.equal(canBanPerson({ id: REX, banned: null, role: 'owner' }, 'owner'), false);
});

test('the reports tab opens a report history and a profile panel with mod actions', async () => {
  state.user = { id: uid(9), username: 'alice', display_name: 'Alice', avatar_url: '' };
  state.partyOwner = true;
  state.partyAdmin = true;
  const calls = [];
  const navigated = [];
  let banned = false;
  const api = {
    get: async (p) => {
      calls.push(['GET', p]);
      if (p.startsWith(PERSON_PATH)) return personData({ person: { ...personData().person, banned: banned ? { reason: 'Rude', by: uid(9), at: Date.now() } : null } });
      if (p.startsWith(REPORTS_PATH)) return { reports: [report('r1', { replay: REPLAY })], next: null, open: 1, role: 'owner' };
      return { bans: [], max: 1000 };
    },
    post: async (p, body) => {
      calls.push(['POST', p, body]);
      if (p === BANS_PATH) {
        banned = true;
        return { bans: [{ id: REX, name: 'Rex', reason: body.reason, banned_at: Date.now() }], banned: true };
      }
      return { ok: true, dismissed: 2 };
    },
    request: async (method, p) => {
      calls.push([method, p]);
      banned = false;
      return { bans: [], unbanned: true };
    },
  };
  const main = document.createElement('main');
  document.body.replaceChildren(main);
  const ctrl = new AbortController();
  renderPartyReports({ api, main, signal: ctrl.signal, params: {}, setChrome() {}, navigate: (u) => navigated.push(u) });
  await flush();
  const item = main.querySelector('.report-item');
  assert.ok(item);
  assert.equal(item.querySelectorAll('.report-who-open, .report-who-link').length, 4, 'avatar and name open the profile for the drawer and the reporter');
  assert.equal(buttons(item, /Open Mila's profile/).length, 1);
  assert.ok(buttons(item, /Profile/).some((b) => b.classList.contains('replay-artist-profile')), 'replay artists open profiles too');

  click(buttons(item, /Report history/)[0]);
  await flush();
  await flush();
  assert.deepEqual(calls.find((c) => c[0] === 'GET' && c[1].startsWith(PERSON_PATH)), ['GET', `${PERSON_PATH}${REX}`]);
  const hist = main.querySelector('.person-history');
  assert.ok(hist);
  assert.match(hist.textContent, /Real Rex/);
  assert.match(hist.textContent, /@realrex/);
  assert.match(hist.textContent, /3 reports, 2 open/);
  assert.match(hist.textContent, /Drew rude stuff/);
  assert.match(hist.textContent, /Hot Takes · 1/);
  assert.equal(hist.querySelectorAll('.report-item').length, 3);
  assert.equal(hist.querySelectorAll('.replay-player').length, 2, 'past replays play in the history');
  assert.equal(hist.querySelector('.report-item').querySelectorAll('.replay-artist').length, 2);
  click(buttons(hist, /^Open$/)[0]);
  await flush();
  assert.equal(main.querySelectorAll('.person-history .report-item').length, 2);
  click(buttons(main.querySelector('.person-history'), /Text/)[0]);
  await flush();
  assert.equal(main.querySelectorAll('.person-history .report-item').length, 1);
  click(buttons(main.querySelector('.person-history'), /^All$/)[0]);
  click(buttons(main.querySelector('.person-history'), /^Everything$/)[0]);
  await flush();
  assert.equal(main.querySelectorAll('.person-history .report-item').length, 3);

  click(buttons(main.querySelector('.person-history'), /Profile and actions/)[0]);
  await flush();
  await flush();
  const panel = document.querySelector('.drawer-panel');
  assert.ok(panel);
  assert.ok(panel.querySelector('.avatar-xl'), 'the profile shows a big avatar');
  assert.match(panel.textContent, /Yapin' id/);
  assert.match(panel.textContent, /Level/);
  assert.match(panel.textContent, /40 played, 9 won/);
  assert.match(panel.textContent, /Party Starter/);
  assert.ok(panel.querySelector('.person-reason'));
  click(buttons(panel, /View public profile/)[0]);
  assert.deepEqual(navigated, ['/u/realrex']);
  ctrl.abort();
  document.body.replaceChildren();
});

test('the profile panel bans with a reason, unbans and dismisses all open reports', async () => {
  state.partyOwner = true;
  state.partyAdmin = true;
  const { openProfilePanel } = await import('../web/js/pages/party-person.js');
  const calls = [];
  const events = [];
  let banned = false;
  const api = {
    get: async () => personData({ person: { ...personData().person, banned: banned ? { reason: 'Rude', by: uid(9), at: Date.now() } : null } }),
    post: async (p, body) => {
      calls.push([p, body]);
      if (p === BANS_PATH) banned = true;
      return p === BANS_PATH ? { bans: [], banned: true } : { ok: true, dismissed: 2 };
    },
    request: async (method, p) => {
      calls.push([method, p]);
      banned = false;
      return { bans: [], unbanned: true };
    },
  };
  const autoYes = () => {
    const ok = [...document.querySelectorAll('.dialog-root button')].pop();
    if (ok) click(ok);
  };
  openProfilePanel({ api, id: REX, role: 'owner', onChanged: (e) => events.push(e.type) });
  await flush();
  await flush();
  let panel = document.querySelector('.drawer-panel');
  panel.querySelector('.person-reason').value = 'Rude drawings';
  click(buttons(panel, /^Ban from Party$/)[0]);
  await flush();
  autoYes();
  await flush();
  await flush();
  assert.deepEqual(calls[0], [BANS_PATH, { id: REX, reason: 'Rude drawings', name: 'Real Rex', username: 'realrex' }]);
  panel = document.querySelector('.drawer-panel');
  assert.equal(buttons(panel, /^Ban from Party$/).length, 0);
  click(buttons(panel, /^Unban$/)[0]);
  await flush();
  autoYes();
  await flush();
  await flush();
  assert.deepEqual(calls[1], ['DELETE', `${BANS_PATH}/${REX}`]);
  panel = document.querySelector('.drawer-panel');
  click(buttons(panel, /Dismiss 2 open/)[0]);
  await flush();
  autoYes();
  await flush();
  await flush();
  assert.deepEqual(calls[2], [`${PERSON_PATH}${REX}/dismiss`, {}]);
  assert.deepEqual(events, ['ban', 'unban', 'dismissAll']);
  document.body.replaceChildren();
});

test('admins do not get a ban button for other party admins or the owner', async () => {
  const { openProfilePanel } = await import('../web/js/pages/party-person.js');
  const api = { get: async () => personData({ role: 'admin', person: { ...personData().person, role: 'admin' } }) };
  openProfilePanel({ api, id: REX, role: 'admin' });
  await flush();
  await flush();
  const panel = document.querySelector('.drawer-panel');
  assert.equal(buttons(panel, /^Ban from Party$/).length, 0);
  assert.match(panel.textContent, /Only the owner can ban a party admin/);
  document.body.replaceChildren();
});

test('the person files have no comments, inline styles or outside links', () => {
  for (const f of ['../web/js/pages/party-person.js', '../web/js/pages/party-reports.js', '../web/css/replay.css', '../worker/reports.js']) {
    const src = readFileSync(path.join(here, f), 'utf8');
    assert.equal(/\/\*[\s\S]*?\*\//.test(src), false, f);
    if (f.endsWith('.js')) {
      assert.equal(/^\s*\/\/(?!\/)/m.test(src), false, f);
      assert.equal(/style=|innerHTML|outerHTML|insertAdjacentHTML/.test(src), false, f);
    }
    assert.equal(/\b(claude|anthropic)\b/i.test(src), false, f);
  }
});
