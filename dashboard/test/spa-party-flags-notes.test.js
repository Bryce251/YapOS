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
const { renderPartyReports, readReports, kindLabel, REPORTS_PATH } = await import('../web/js/pages/party-reports.js');
const { readPerson, readFlag, readNotes, flagText, noteCountText, noteTemplate, notesUrl, openProfilePanel, PERSON_PATH, NOTE_MAX } = await import('../web/js/pages/party-person.js');
const { state } = await import('../web/js/state.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const uid = (i) => `77777777-7777-4777-8777-${String(i).padStart(12, '0')}`;
const S1 = encodeStroke({ c: 3, z: 1, pts: [[10, 10], [40, 40], [60, 80]] });
const REX = uid(1);
const FLAG = { games: 4, reporters: 3, reports: 5 };

function report(id, over = {}, drawer = {}) {
  return { id, kind: 'drawing', game: 'draw', word: 'cat', created: Date.now(), status: 'open', ink: [S1], drawer: { id: REX, name: 'Rex', username: 'rexplorer', profile: null, banned: false, role: null, flag: FLAG, notes: 2, ...drawer }, reporter: { id: uid(2), name: 'Mila', profile: null }, ...over };
}

function note(id, over = {}) {
  return { id, text: `note ${id}`, created: Date.now() - 60000, author: { id: uid(9), name: 'Juno', avatar: null }, mine: false, canDelete: false, ...over };
}

function personData(over = {}) {
  return {
    person: { id: REX, name: 'Real Rex', username: 'realrex', avatar: null, role: null, banned: null, card: null, flag: FLAG },
    counts: { total: 5, open: 5, first: Date.now() - 86400000, last: Date.now(), made: 0, games: [] },
    bans: [],
    notes: [note('n2', { canDelete: true, mine: true, author: { id: uid(8), name: 'Alice', avatar: null } }), note('n1')],
    reports: [report('r1')],
    more: false,
    role: 'admin',
    ...over,
  };
}

function buttons(root, re) {
  return [...root.querySelectorAll('button')].filter((b) => re.test(b.textContent) || re.test(b.getAttribute('aria-label') || ''));
}

function click(el) {
  el.dispatchEvent(new FakeEvent('click', { bubbles: true }));
}

test('flags and notes are read safely and a banned person is never flagged', () => {
  assert.equal(readFlag(null), null);
  assert.equal(readFlag({ games: 0 }), null);
  assert.equal(readFlag({ games: 'x' }), null);
  assert.deepEqual(readFlag(FLAG), FLAG);
  assert.equal(flagText(FLAG), 'Reported in 4 games this week');
  assert.equal(noteCountText(1), '1 mod note');
  assert.equal(noteCountText(3), '3 mod notes');
  assert.deepEqual(readNotes([null, { id: 5 }, { id: 'a', text: 'hi' }]).map((n) => [n.id, n.author.name, n.canDelete]), [['a', 'Staff', false]]);
  assert.equal(notesUrl('a b', 'c/d'), `${PERSON_PATH}a%20b/notes/c%2Fd`);
  const view = readReports({ reports: [report('r1'), report('r2', {}, { banned: true })], flagged: { people: 1, reports: 5 } });
  assert.deepEqual(view.reports.map((r) => r.drawer.flag), [FLAG, null]);
  assert.deepEqual(view.flagged, { people: 1, reports: 5 });
  assert.equal(view.reports[0].drawer.notes, 2);
  assert.equal(kindLabel('flagged', 'Flagged', { people: 2 }), 'Flagged (2)');
  assert.equal(kindLabel('flagged', 'Flagged', { people: 0 }), 'Flagged');
  assert.equal(kindLabel('text', 'Text', { people: 2 }), 'Text');
  const banned = readPerson(personData({ person: { ...personData().person, banned: { reason: 'x', by: uid(9), at: 1 } } }));
  assert.equal(banned.person.flag, null);
  assert.equal(readPerson(personData({ notes: null })).notes, null);
  assert.match(noteTemplate('warned', Date.UTC(2026, 10, 16, 12)), /^Warned on Nov 16: $/);
  assert.match(noteTemplate('appeal', Date.UTC(2026, 10, 16, 12)), /^Ban appeal on Nov 16: $/);
  assert.equal(noteTemplate('watch'), 'Watch: ');
});

test('report cards show the repeat offender badge and note count, and the Flagged tab has a count', async () => {
  state.user = { id: uid(8), username: 'alice', display_name: 'Alice', avatar_url: '' };
  state.partyOwner = false;
  state.partyAdmin = true;
  const calls = [];
  const api = {
    get: async (p) => {
      calls.push(p);
      if (p.startsWith(REPORTS_PATH)) return { reports: [report('r1'), report('r2', {}, { id: uid(3), name: 'Juno', flag: null, notes: 0 }), report('r3', {}, { id: uid(4), name: 'Bo', banned: true, notes: 1 })], next: null, open: 3, role: 'admin', flagged: { people: 1, reports: 5 } };
      if (p.startsWith(PERSON_PATH)) return personData();
      return { bans: [], max: 1000 };
    },
  };
  const main = document.createElement('main');
  document.body.replaceChildren(main);
  const ctrl = new AbortController();
  renderPartyReports({ api, main, signal: ctrl.signal, params: {}, setChrome() {} });
  await flush();
  const [one, two, three] = main.querySelectorAll('.report-item');
  assert.ok(one.classList.contains('is-flagged'));
  assert.match(one.textContent, /Repeat offender/);
  assert.match(one.textContent, /Reported in 4 games this week/);
  assert.match(one.textContent, /2 mod notes/);
  assert.ok(!two.classList.contains('is-flagged'));
  assert.doesNotMatch(two.textContent, /Repeat offender|mod note/);
  assert.doesNotMatch(three.textContent, /Repeat offender/);
  assert.match(three.textContent, /Banned/);
  assert.match(three.textContent, /1 mod note/);
  const tab = buttons(main, /^Flagged/)[0];
  assert.equal(tab.textContent, 'Flagged (1)');
  click(tab);
  await flush();
  assert.equal(calls.filter((p) => p.startsWith(REPORTS_PATH)).pop(), `${REPORTS_PATH}?status=open&kind=flagged`);
  assert.equal(buttons(main, /^Flagged/)[0].getAttribute('aria-pressed'), 'true');
  click(buttons(main.querySelector('.report-item'), /Report history/)[0]);
  await flush();
  await flush();
  const hist = main.querySelector('.person-history');
  assert.match(hist.textContent, /Repeat offender/);
  assert.match(hist.textContent, /2 mod notes/);
  ctrl.abort();
  document.body.replaceChildren();
});

test('the profile panel lists notes, adds one from a template and deletes only where allowed', async () => {
  state.partyOwner = false;
  state.partyAdmin = true;
  const calls = [];
  const events = [];
  let list = personData().notes;
  const api = {
    get: async () => personData({ notes: list }),
    post: async (p, body) => {
      calls.push(['POST', p, body]);
      list = [note('n3', { text: body.text, canDelete: true, mine: true }), ...list];
      return { notes: list };
    },
    request: async (method, p) => {
      calls.push([method, p]);
      list = list.filter((n) => !p.endsWith(`/${n.id}`));
      return { notes: list, deleted: true };
    },
  };
  openProfilePanel({ api, id: REX, role: 'admin', onChanged: (e) => events.push([e.type, e.count]) });
  await flush();
  await flush();
  let panel = document.querySelector('.drawer-panel');
  assert.match(panel.textContent, /Repeat offender/);
  assert.match(panel.textContent, /Reported in 4 games this week/);
  assert.match(panel.textContent, /Mod notes/);
  assert.match(panel.textContent, /Private to the owner and party admins/);
  const items = panel.querySelectorAll('.mod-note');
  assert.equal(items.length, 2);
  assert.match(items[0].textContent, /Alice/);
  assert.match(items[0].textContent, /note n2/);
  assert.equal(buttons(items[0], /Delete the note/).length, 1);
  assert.equal(buttons(items[1], /Delete the note/).length, 0, 'no delete on someone else\'s note');
  const box = panel.querySelector('.mod-note-box');
  assert.equal(box.maxLength, NOTE_MAX);
  const add = buttons(panel, /^Add note$/)[0];
  assert.equal(add.disabled, true);
  click(buttons(panel, /^Warned$/)[0]);
  assert.match(box.value, /^Warned on [A-Z][a-z]{2} \d{1,2}: $/);
  box.value += 'spam drawings';
  box.dispatchEvent(new FakeEvent('input', { bubbles: true }));
  assert.equal(panel.querySelector('.mod-note-count').textContent, `${Array.from(box.value).length} / ${NOTE_MAX}`);
  assert.equal(add.disabled, false);
  click(add);
  await flush();
  await flush();
  assert.equal(calls[0][0], 'POST');
  assert.equal(calls[0][1], `${PERSON_PATH}${REX}/notes`);
  assert.match(calls[0][2].text, /^Warned on .*spam drawings$/);
  panel = document.querySelector('.drawer-panel');
  assert.equal(panel.querySelectorAll('.mod-note').length, 3);
  assert.deepEqual(events[0], ['notes', 3]);
  click(buttons(panel.querySelectorAll('.mod-note')[0], /Delete the note/)[0]);
  await flush();
  const ok = [...document.querySelectorAll('.dialog-root button')].pop();
  click(ok);
  await flush();
  await flush();
  assert.deepEqual(calls[1], ['DELETE', `${PERSON_PATH}${REX}/notes/n3`]);
  assert.equal(document.querySelector('.drawer-panel').querySelectorAll('.mod-note').length, 2);
  assert.deepEqual(events[1], ['notes', 2]);
  document.body.replaceChildren();
});

test('notes about yourself are hidden in the panel', async () => {
  const api = { get: async () => personData({ notes: null }) };
  openProfilePanel({ api, id: REX, role: 'admin' });
  await flush();
  await flush();
  const panel = document.querySelector('.drawer-panel');
  assert.match(panel.textContent, /Notes about you are kept private from you/);
  assert.equal(panel.querySelector('.mod-note-box'), null);
  document.body.replaceChildren();
});

test('the new files have no comments, inline styles or non-ASCII CSS', () => {
  for (const f of ['../web/js/pages/party-person.js', '../web/js/pages/party-reports.js', '../web/css/replay.css', '../worker/reports.js', '../dev.mjs']) {
    const src = readFileSync(path.join(here, f), 'utf8');
    assert.equal(/\/\*[\s\S]*?\*\//.test(src), false, f);
    if (f.endsWith('.js')) {
      assert.equal(/^\s*\/\/(?!\/)/m.test(src), false, f);
      assert.equal(/style=|innerHTML|outerHTML|insertAdjacentHTML/.test(src), false, f);
    }
    if (f.endsWith('.css')) assert.equal(/[^\x00-\x7f]/.test(src), false, f);
  }
});
