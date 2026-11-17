import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, flush, FakeEvent } from './dom-shim.js';

const { document } = installDom({ url: 'https://dash.example.test/party/modlog' });
document.documentElement = document.createElement('html');
if (typeof globalThis.requestAnimationFrame !== 'function') globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
const { renderPartyModLog, readModLog, modLogSentence, modLogUrl, actionIcon, actionLabel, MODLOG_PATH } = await import('../web/js/pages/party-modlog.js');
const { readPerson, banStatusText, timeLeft, durationName, readWarnings, openProfilePanel, PERSON_BANS_PATH, warningsUrl, WARNING_TEMPLATES } = await import('../web/js/pages/party-person.js');
const { readBans } = await import('../web/js/pages/party-reports.js');
const { state } = await import('../web/js/state.js');

const uid = (i) => `77777777-7777-4777-8777-${String(i).padStart(12, '0')}`;
const REX = uid(1);
const JUNO = uid(2);
const HOUR = 3600000;

function click(el) {
  el.dispatchEvent(new FakeEvent('click', { bubbles: true }));
}

function buttons(root, re) {
  return [...root.querySelectorAll('button')].filter((b) => re.test(b.textContent) || re.test(b.getAttribute('aria-label') || ''));
}

function entry(id, action, over = {}) {
  return { id, action, actor: { id: JUNO, name: 'Juno', avatar: null }, target: { id: REX, name: 'Rex', username: 'rex', avatar: null }, detail: null, created: Date.now() - 60000, ...over };
}

function personData(over = {}) {
  return {
    person: { id: REX, name: 'Rex', username: 'rex', avatar: null, role: null, banned: null, card: null },
    notes: [],
    warnings: [{ id: 'w1', text: 'No spam', created: Date.now() - HOUR, seen: true, seen_at: Date.now() - 10, author: { id: JUNO, name: 'Juno' } }, { id: 'w2', text: 'Be kind to others', created: Date.now(), seen: false, author: { id: JUNO, name: 'Juno' } }],
    counts: { total: 1, open: 1, first: Date.now(), last: Date.now(), made: 0, warnings: 2, games: [] },
    bans: [{ action: 'unban', by: 'yapos', at: Date.now(), auto: true }, { action: 'ban', reason: 'Rude', by: JUNO, at: Date.now() - HOUR, duration: 'hour' }],
    reports: [],
    more: false,
    role: 'owner',
    ...over,
  };
}

test('mod log rows read safely and read as plain sentences', () => {
  const m = readModLog({ entries: [entry('a', 'ban', { detail: { duration: 'day', reason: 'rude drawings' } }), { id: 1 }, null], actors: [{ id: JUNO, name: 'Juno', count: 3 }, { nope: true }], actions: [{ action: 'ban', count: 1 }], role: 'admin', next: 'n' });
  assert.equal(m.entries.length, 1);
  assert.deepEqual(m.actors.map((a) => [a.id, a.count]), [[JUNO, 3]]);
  assert.equal(m.next, 'n');
  assert.equal(modLogSentence(m.entries[0]), 'Juno banned Rex for 1 day: rude drawings');
  const s = (action, detail = {}, over = {}) => modLogSentence(readModLog({ entries: [entry('x', action, { detail, ...over })] }).entries[0]);
  assert.equal(s('ban', { duration: 'forever' }), 'Juno banned Rex until unbanned');
  assert.equal(s('unban', { early: true }), 'Juno unbanned Rex early');
  assert.equal(s('ban_expire', { duration: 'week' }, { actor: { id: 'yapos', name: 'YapOS', system: true } }), "Rex's 1 week ban ran out");
  assert.equal(s('warn', { text: 'Keep drawings clean' }), 'Juno warned Rex: “Keep drawings clean”');
  assert.match(s('dismiss', { game: 'draw' }), /^Juno dismissed a report about Rex in \S/);
  assert.equal(s('dismiss'), 'Juno dismissed a report about Rex');
  assert.equal(s('dismiss_all', { count: 3 }), 'Juno dismissed 3 open reports about Rex');
  assert.equal(s('note_add'), 'Juno added a mod note about Rex');
  assert.equal(s('word_add', { word: 'meanie' }), 'Juno blocked the word “meanie”');
  assert.equal(s('owner_points_set', { summary: 'Set their points to 50.' }), "Juno: Set Rex's points to 50.");
  assert.equal(s('owner_points_set'), "Juno edited Rex's Party stats");
  assert.equal(s('owner_board_hide'), 'Juno took Rex off the Party leaderboards');
  assert.equal(s('owner_board_show'), 'Juno put Rex back on the Party leaderboards');
  assert.equal(s('owner_admin_add'), 'Juno made Rex a party admin');
  assert.equal(s('pack_hide', { pack: 'Space night' }), 'Juno hid the word pack “Space night” by Rex from the pack browser');
  assert.equal(s('pack_restore', {}, { target: null }), 'Juno put a word pack back in the pack browser');
  assert.equal(s('pack_dismiss', { pack: 'Space night' }), 'Juno dismissed a report about the word pack “Space night” by Rex');
  assert.equal(s('owner_admin_remove'), 'Juno removed Rex as a party admin');
  assert.equal(s('owner_cheat_dismiss', { kind: 'daily_points', summary: 'Hit the cap on 3 days' }), 'Juno dismissed the “Daily points cap” cheat alert about Rex (Hit the cap on 3 days)');
  assert.equal(s('owner_cheat_hide', { kind: 'game_cap' }), 'Juno took Rex off the Party leaderboards after the “Score at the game cap” cheat alert');
  assert.equal(s('owner_cheat_reset', { kind: 'nope' }), "Juno reset Rex's Party stats after the cheat alert");
  assert.equal(s('owner_cheat_reopen', { kind: 'win_rate' }), 'Juno reopened the “Win rate” cheat alert about Rex');
  assert.equal(s('cheat_clear'), 'Juno: cheat clear for Rex');
  assert.equal(actionIcon('owner_reset'), '\u{1F451}');
  assert.equal(actionLabel('owner_board_hide'), 'Owner: taken off leaderboards');
  assert.equal(actionLabel('owner_something_new'), 'Owner: something new');
  assert.equal(modLogUrl({ actor: JUNO, action: 'warn' }, 'c.1'), `${MODLOG_PATH}?actor=${JUNO}&action=warn&before=c.1`);
  assert.equal(modLogUrl({}), MODLOG_PATH);
});

test('ban times read as time left and end dates', () => {
  const now = Date.UTC(2026, 10, 16, 12, 0, 0);
  assert.equal(timeLeft(now + 3 * HOUR, now), '3 hours');
  assert.equal(timeLeft(now + 30 * 60000, now), '30 minutes');
  assert.equal(timeLeft(now + 3 * 24 * HOUR, now), '3 days');
  assert.equal(timeLeft(now - 1, now), '');
  assert.equal(durationName('day'), '1 day');
  assert.equal(durationName('forever'), '');
  assert.match(banStatusText({ at: now - HOUR, reason: 'Rude', duration: 'day', until: now + 23 * HOUR }, now), /for 1 day: Rude\. It ends in 23 hours/);
  assert.match(banStatusText({ at: now, reason: '', duration: 'forever', until: null }, now), /lasts until someone unbans them/);
  const m = readPerson({ person: { id: REX, banned: { at: now, until: now + HOUR, duration: 'hour' } }, warnings: [{ id: 'w', text: 'x', seen: 'yes' }, { bad: 1 }] });
  assert.equal(m.person.banned.until, now + HOUR);
  assert.equal(m.person.banned.duration, 'hour');
  assert.deepEqual(m.warnings.map((w) => [w.id, w.seen]), [['w', false]]);
  assert.equal(readWarnings(null).length, 0);
  assert.equal(readBans({ bans: [{ id: REX, until: now + HOUR }, { id: JUNO, until: null }] }).bans.map((b) => b.until).join(','), `${now + HOUR},`);
});

test('the profile panel bans for a chosen length, shows time left and sends warnings', async () => {
  state.partyOwner = true;
  state.partyAdmin = true;
  state.user = { id: JUNO };
  const calls = [];
  let banned = null;
  let warns = personData().warnings;
  const api = {
    get: async () => personData({ person: { ...personData().person, banned }, warnings: warns }),
    post: async (p, body) => {
      calls.push([p, body]);
      if (p === PERSON_BANS_PATH) banned = { reason: body.reason, by: JUNO, at: Date.now(), until: Date.now() + 24 * HOUR, duration: body.duration };
      if (p === warningsUrl(REX)) {
        warns = [{ id: 'w3', text: body.text, created: Date.now(), seen: false, author: { id: JUNO, name: 'Juno' } }, ...warns];
        return { warnings: warns };
      }
      return { bans: [], banned: true };
    },
    request: async () => ({}),
  };
  openProfilePanel({ api, id: REX, role: 'owner' });
  await flush();
  await flush();
  let panel = document.querySelector('.drawer-panel');
  assert.match(panel.textContent, /Ban ended/);
  assert.match(panel.textContent, /Banned for 1 hour/);
  assert.match(panel.textContent, /Not seen yet/);
  assert.match(panel.textContent, /Seen/);
  assert.match(panel.textContent, /2 sent/);
  click(buttons(panel, /^1 day$/)[0]);
  assert.equal(buttons(panel, /^1 day$/)[0].getAttribute('aria-pressed'), 'true');
  panel.querySelector('.person-reason').value = 'Rude drawings';
  click(buttons(panel, /^Ban from Party$/)[0]);
  await flush();
  const dialog = document.querySelector('.dialog-root');
  assert.match(dialog.textContent, /ends by itself after 1 day/);
  click([...dialog.querySelectorAll('button')].pop());
  await flush();
  await flush();
  assert.deepEqual(calls[0], [PERSON_BANS_PATH, { id: REX, reason: 'Rude drawings', name: 'Rex', username: 'rex', duration: 'day' }]);
  panel = document.querySelector('.drawer-panel');
  assert.match(panel.querySelector('.ban-status').textContent, /for 1 day: Rude drawings\. It ends in 24 hours/);

  const box = panel.querySelector('.mod-warning-box');
  const send = buttons(panel, /^Send warning$/)[0];
  assert.equal(send.disabled, true);
  click(buttons(panel, new RegExp(`^${WARNING_TEMPLATES[0]}$`))[0]);
  assert.equal(box.value, 'Keep drawings clean');
  assert.equal(send.disabled, false);
  click(send);
  await flush();
  await flush();
  assert.deepEqual(calls[1], [warningsUrl(REX), { text: 'Keep drawings clean' }]);
  panel = document.querySelector('.drawer-panel');
  assert.equal(panel.querySelectorAll('.mod-warning').length, 3);
  document.body.replaceChildren();
  state.user = null;
});

test('admins cannot send warnings to other admins or to themselves from the panel', async () => {
  state.user = { id: JUNO };
  const api = { get: async () => personData({ role: 'admin', person: { ...personData().person, role: 'admin' } }) };
  openProfilePanel({ api, id: REX, role: 'admin' });
  await flush();
  await flush();
  let panel = document.querySelector('.drawer-panel');
  assert.equal(panel.querySelector('.mod-warning-box'), null);
  assert.equal(panel.querySelectorAll('.mod-warning').length, 2, 'the list still shows');
  document.body.replaceChildren();
  const self = { get: async () => personData({ role: 'admin', notes: null, person: { ...personData().person, id: JUNO } }) };
  openProfilePanel({ api: self, id: JUNO, role: 'admin' });
  await flush();
  await flush();
  panel = document.querySelector('.drawer-panel');
  assert.equal(panel.querySelector('.mod-warning-box'), null);
  document.body.replaceChildren();
  state.user = null;
});

test('the mod log page lists actions, filters by mod and action, pages and opens profiles', async () => {
  state.partyOwner = false;
  state.partyAdmin = true;
  const asked = [];
  const pages = {
    first: { entries: [entry('a', 'ban', { detail: { duration: 'day', reason: 'rude' } }), entry('b', 'warn', { detail: { text: 'No spam' } })], next: '100.b', actors: [{ id: JUNO, name: 'Juno', count: 2 }], actions: [{ action: 'ban', count: 1 }, { action: 'warn', count: 1 }], role: 'admin' },
    second: { entries: [entry('c', 'unban')], next: null, actors: [], actions: [], role: 'admin' },
  };
  const api = {
    get: async (p) => {
      asked.push(p);
      if (p.startsWith('/api/party/reports/person/')) return personData({ role: 'admin' });
      return p.includes('before=') ? pages.second : pages.first;
    },
  };
  const main = document.createElement('main');
  document.body.appendChild(main);
  const ctrl = new AbortController();
  renderPartyModLog({ api, main, signal: ctrl.signal, setChrome: () => {}, navigate: () => {} });
  await flush();
  await flush();
  assert.equal(asked[0], MODLOG_PATH);
  assert.match(main.textContent, /Juno banned Rex for 1 day: rude/);
  assert.match(main.textContent, /Juno warned Rex/);
  assert.equal(main.querySelectorAll('.modlog-row').length, 2);
  click(buttons(main, /^Show older$/)[0]);
  await flush();
  await flush();
  assert.equal(asked[1], `${MODLOG_PATH}?before=100.b`);
  assert.equal(main.querySelectorAll('.modlog-row').length, 3);
  const [mod, action] = main.querySelectorAll('select');
  mod.value = JUNO;
  mod.dispatchEvent(new FakeEvent('change', { bubbles: true }));
  await flush();
  await flush();
  assert.equal(asked[2], `${MODLOG_PATH}?actor=${JUNO}`);
  const action2 = main.querySelectorAll('select')[1];
  action2.value = 'warn';
  action2.dispatchEvent(new FakeEvent('change', { bubbles: true }));
  await flush();
  await flush();
  assert.equal(asked[3], `${MODLOG_PATH}?actor=${JUNO}&action=warn`);
  assert.ok(action);
  click(main.querySelector('.modlog-target'));
  await flush();
  await flush();
  assert.ok(asked.includes(`/api/party/reports/person/${REX}`));
  const panel = document.querySelector('.drawer-panel');
  click(buttons(panel, /Report history/)[0]);
  await flush();
  await flush();
  assert.equal(asked[asked.length - 1], `${MODLOG_PATH}?actor=${JUNO}&action=warn&target=${REX}`);
  ctrl.abort();
  document.body.replaceChildren();
});

test('players who are not staff see a locked page and no request is made', () => {
  state.partyOwner = false;
  state.partyAdmin = false;
  const asked = [];
  const main = document.createElement('main');
  renderPartyModLog({ api: { get: async (p) => asked.push(p) }, main, setChrome: () => {} });
  assert.match(main.textContent, /Only party staff can open this/);
  assert.equal(asked.length, 0);
});
