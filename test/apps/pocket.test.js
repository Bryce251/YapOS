import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, IDS } from '../harness.js';
import { createMemoryStore } from '../../engine/storage.js';
import { parseWhen, resolveZone } from '../../apps/pocket.js';

const S = IDS.server;
const G = IDS.channels.general;
const KIND = 'pocket.remind';
const dmOf = (uid) => `d${uid.slice(1)}`;
const make = (opts = {}) => createHarness({ apps: ['pocket'], fakeClock: true, ...opts });
const lastText = (h, ans) => h.textOf(ans[ans.length - 1]);
const reminders = (h, uid = IDS.member) => h.engine.scheduler.list({ kind: KIND, userId: uid });
const dmTexts = (h, uid = IDS.member) => h.sent(dmOf(uid)).map((m) => h.textOf(m));
const HOUR = 3600_000;

function walkComponents(list, fn) {
  const walk = (c) => { if (!c) return; fn(c); (c.components || []).forEach(walk); };
  (list || []).forEach(walk);
}

function checkLimits(payload) {
  const rowsOf = payload.components || [];
  assert.ok(rowsOf.length <= 5, 'at most 5 rows');
  for (const r of rowsOf) assert.ok((r.components || []).length <= 5, 'at most 5 per row');
  walkComponents(rowsOf, (c) => {
    if (c.custom_id) assert.ok(Buffer.byteLength(c.custom_id, 'utf8') <= 100, `custom_id short enough: ${c.custom_id}`);
    assert.notEqual(c.type, 'select', 'no select menus in Pocket panels');
  });
}

test('pocket commands fit the limits and the service is shared', async () => {
  const h = await make();
  for (const name of ['remind', 'afk', 'pocket']) {
    const c = h.bot.commands.get(name);
    assert.ok(c, `/${name} exists`);
    assert.ok(c.description.length > 0 && c.description.length <= 100);
  }
  const svc = h.engine.service('pocket');
  assert.equal(typeof svc.dmHelp, 'function');
  assert.equal(h.engine.apps.get('pocket').def.panelPerm, 'member');
});

test('parseWhen understands the common ways people say a time', () => {
  const now = Date.parse('2026-11-07T12:00:00Z');
  const at = (text, tz = 'UTC') => new Date(parseWhen(text, { tz, now }).at).toISOString();
  assert.equal(at('in 2h stretch'), '2026-11-07T14:00:00.000Z');
  assert.equal(at('2h30m stretch'), '2026-11-07T14:30:00.000Z');
  assert.equal(at('tomorrow 9:00 call mum'), '2026-11-08T09:00:00.000Z');
  assert.equal(at('tomorrow 9:00 call mum', 'America/New_York'), '2026-11-08T14:00:00.000Z');
  assert.equal(at('tomorrow at 9am call mum'), '2026-11-08T09:00:00.000Z');
  assert.equal(at('at 18:30 tea'), '2026-11-07T18:30:00.000Z');
  assert.equal(at('11:00 brunch'), '2026-11-08T11:00:00.000Z', 'a time already gone today means tomorrow');
  assert.equal(at('friday 5pm pay rent'), '2026-11-13T17:00:00.000Z');
  assert.equal(at('2026-12-25 08:00 presents'), '2026-12-25T08:00:00.000Z');
  assert.equal(parseWhen('tomorrow 9:00 to call mum', { now }).text, 'call mum');
  assert.equal(parseWhen('me in 10 minutes to drink', { now }).text, 'drink');
  const daily = parseWhen('every day 8:00 water', { tz: 'Europe/London', now });
  assert.deepEqual(daily.repeat, { daily: '08:00', tz: 'Europe/London' });
  assert.deepEqual(parseWhen('every mon,wed,fri 18:00 gym', { now }).repeat.weekly.days, [1, 3, 5]);
  assert.deepEqual(parseWhen('every weekday 9am standup', { now }).repeat.weekly.days, [1, 2, 3, 4, 5]);
  assert.deepEqual(parseWhen('every 2h stretch', { now }).repeat, { everyMs: 2 * HOUR });
  for (const bad of ['today 9:00 x', 'in 30s x', 'every day water', 'soon x', 'every 10m x', 'in 2h', '2025-01-01 10:00 old', '2026-02-30 10:00 nope']) {
    assert.throws(() => parseWhen(bad, { now }), (e) => e.pocketTime === true, bad);
  }
});

test('resolveZone takes names, cities, offsets and suggests fixes', () => {
  assert.equal(resolveZone('Europe/London').zone, 'Europe/London');
  assert.equal(resolveZone('europe/paris').zone, 'Europe/Paris');
  assert.equal(resolveZone('new york').zone, 'America/New_York');
  assert.equal(resolveZone('gmt').zone, 'UTC');
  assert.equal(resolveZone('UTC+2').zone, 'Etc/GMT-2');
  const miss = resolveZone('tokio');
  assert.equal(miss.zone, null);
  assert.ok(miss.guesses.includes('Asia/Tokyo'));
});

test('/remind in 2h DMs the reminder when it is due', async () => {
  const h = await make();
  const ans = await h.slash('remind', 'in 2h stretch', { user: IDS.member });
  const text = lastText(h, ans);
  assert.match(text, /Reminder #1 set/);
  assert.match(text, /\(UTC\)/);
  assert.match(text, /stretch/);
  assert.equal(ans[ans.length - 1].type, 'ephemeral', 'the confirmation is private');
  assert.equal(reminders(h).length, 1);
  await h.advance(HOUR);
  assert.equal(dmTexts(h).length, 0, 'not yet');
  await h.advance(HOUR);
  const dms = dmTexts(h);
  assert.equal(dms.length, 1);
  assert.match(dms[0], /Reminder:\*\* stretch/);
  assert.doesNotMatch(dms[0], /offline/);
  assert.equal(reminders(h).length, 0);
});

test('time zones: reminders use the person\'s zone and show it', async () => {
  const h = await make();
  const set = await h.slash('pocket', 'tz new york', { user: IDS.member });
  assert.match(lastText(h, set), /America\/New_York/);
  const ans = await h.slash('remind', 'tomorrow 9:00 call mum', { user: IDS.member });
  assert.match(lastText(h, ans), /09:00 \(America\/New_York\)/);
  assert.equal(new Date(reminders(h)[0].at).toISOString(), '2026-11-08T14:00:00.000Z');
  const bad = await h.slash('pocket', 'tz Mars/Base', { user: IDS.member });
  assert.match(lastText(h, bad), /don't know that time zone/);
  const show = await h.slash('pocket', 'tz', { user: IDS.member });
  assert.match(lastText(h, show), /America\/New_York/);
});

test('changing the time zone moves repeating reminders with it', async () => {
  const h = await make();
  await h.slash('remind', 'every day 8:00 water', { user: IDS.member });
  assert.equal(reminders(h)[0].repeat.tz, 'UTC');
  const ans = await h.slash('pocket', 'tz Europe/Paris', { user: IDS.member });
  assert.match(lastText(h, ans), /1 repeating reminder now follows it/);
  const job = reminders(h)[0];
  assert.equal(job.repeat.tz, 'Europe/Paris');
  assert.equal(new Date(job.at).toISOString(), '2026-11-08T07:00:00.000Z');
  assert.equal(reminders(h).length, 1, 'moved, not copied');
});

test('closed DMs: the reminder is posted where it was set, with a mention', async () => {
  const h = await make();
  await h.slash('remind', 'in 10m check the oven @everyone', { user: IDS.member });
  h.fake.features.dms = false;
  await h.advance(10 * 60_000);
  const post = h.lastSent(G);
  assert.ok(post, 'posted in the channel');
  assert.match(post.content, new RegExp(`<@${IDS.member}>`));
  assert.match(post.content, /check the oven/);
  assert.doesNotMatch(post.content, /@everyone/, 'no mass pings from reminder text');
  assert.equal(reminders(h).length, 0);
});

test('closed DMs and no channel (set in DMs): it gives up quietly, no retry loop', async () => {
  const h = await make();
  await h.dm('remind in 5m drink water');
  assert.equal(reminders(h).length, 1);
  h.fake.features.dms = false;
  await h.advance(10 * 60_000);
  assert.equal(reminders(h).length, 0, 'not retried forever');
  assert.equal(h.sent(G).length, 0, 'nothing posted in a server');
});

test('Pocket uninstalled on the server: no channel fallback post', async () => {
  const h = await make();
  await h.slash('remind', 'in 10m stretch', { user: IDS.member });
  h.engine.settings.setEnabled(S, 'pocket', false);
  h.fake.features.dms = false;
  await h.advance(10 * 60_000);
  assert.equal(h.sent(G).length, 0);
});

test('a network hiccup while DMing is retried', async () => {
  const h = await make();
  await h.slash('remind', 'in 10m stretch', { user: IDS.member });
  h.fake.fail('POST', /\/users\/.+\/dm$/, { status: 503, error: 'busy', times: 1 });
  await h.advance(10 * 60_000);
  assert.equal(dmTexts(h).length, 0);
  await h.advance(60_000);
  assert.equal(dmTexts(h).length, 1, 'delivered on the retry');
  assert.equal(dmTexts(h).filter((t) => /stretch/.test(t)).length, 1, 'only once');
});

test('restart: a reminder due while the bot was off arrives late with an apology', async () => {
  const store = createMemoryStore();
  const a = await make({ store });
  await a.slash('remind', 'in 1h stretch', { user: IDS.member });
  a.engine.scheduler.stop();
  const b = await make({ store });
  b.clock.t = a.clock.t + 3 * HOUR;
  await b.runDue();
  const dms = dmTexts(b);
  assert.equal(dms.length, 1);
  assert.match(dms[0], /stretch/);
  assert.match(dms[0], /\(sorry, I was offline when this was due\)/);
});

test('repeating reminders fire each day and are capped at 10 per person', async () => {
  const h = await make();
  const ans = await h.slash('remind', 'every day 8:00 water', { user: IDS.member });
  assert.match(lastText(h, ans), /every day at 08:00/);
  await h.advance(3 * 24 * HOUR);
  const dms = dmTexts(h).filter((t) => /water/.test(t));
  assert.equal(dms.length, 3);
  assert.match(dms[0], /every day at 08:00/);
  for (let i = 0; i < 9; i++) await h.slash('remind', `every day 9:${String(i).padStart(2, '0')} thing ${i}`, { user: IDS.member });
  assert.equal(reminders(h).filter((j) => j.repeat).length, 10);
  const over = await h.slash('remind', 'every day 10:00 one too many', { user: IDS.member });
  assert.match(lastText(h, over), /Too many repeating reminders/);
  assert.equal(reminders(h).length, 10);
});

test('/remind list, cancel by number, undo, cancel all', async () => {
  const h = await make();
  await h.slash('remind', 'in 1h first', { user: IDS.member });
  await h.slash('remind', 'in 2h second', { user: IDS.member });
  const list = await h.slash('remind', 'list', { user: IDS.member });
  const text = lastText(h, list);
  assert.match(text, /#1/);
  assert.match(text, /second/);
  const cancel = await h.slash('remind', 'cancel 1', { user: IDS.member });
  assert.match(lastText(h, cancel), /Reminder #1 is cancelled/);
  assert.deepEqual(reminders(h).map((j) => j.data.n), [2]);
  const nope = await h.slash('remind', 'cancel 1', { user: IDS.member });
  assert.match(lastText(h, nope), /No reminder #1/);
  const undoByOther = await h.clickButton('Undo', { user: IDS.member2, in: cancel });
  assert.match(lastText(h, undoByOther), /Not your panel|Not yours/);
  assert.equal(reminders(h).length, 1);
  await h.clickButton('Undo', { user: IDS.member, in: cancel });
  assert.deepEqual(reminders(h).map((j) => j.data.n).sort(), [1, 2]);
  const all = await h.slash('remind', 'cancel all', { user: IDS.member });
  assert.match(lastText(h, all), /All 2 reminders/);
  assert.equal(reminders(h).length, 0);
  const others = await h.slash('remind', 'list', { user: IDS.member2 });
  assert.match(lastText(h, others), /Nothing waiting/);
});

test('reminders are personal: one person cannot see or cancel another\'s', async () => {
  const h = await make();
  await h.slash('remind', 'in 1h secret plan', { user: IDS.member });
  const list = await h.slash('remind', 'list', { user: IDS.member2 });
  assert.doesNotMatch(lastText(h, list), /secret plan/);
  const cancel = await h.slash('remind', 'cancel 1', { user: IDS.member2 });
  assert.match(lastText(h, cancel), /No reminder #1/);
  assert.equal(reminders(h).length, 1);
});

test('bad reminder input gets a friendly explanation', async () => {
  const h = await make();
  const ans = await h.slash('remind', 'soonish do stuff', { user: IDS.member });
  assert.match(lastText(h, ans), /didn't get the time/);
  assert.match(lastText(h, ans), /remind in 2h stretch/);
  const empty = await h.slash('remind', '', { user: IDS.member });
  assert.match(lastText(h, empty), /Reminders/);
  const noText = await h.slash('remind', 'in 2h', { user: IDS.member });
  assert.match(lastText(h, noText), /What should I remind you about/);
  assert.equal(reminders(h).length, 0);
});

test('typed !remind and /yap remind work too', async () => {
  const h = await make();
  await h.message('!remind in 30m tea', { user: IDS.member });
  await h.slash('yap', 'remind in 40m biscuits', { user: IDS.member });
  assert.deepEqual(reminders(h).map((j) => j.data.text), ['tea', 'biscuits']);
});

test('DMs: remind, notes, todos, tz, afk and help are understood', async () => {
  const h = await make();
  const dm = dmOf(IDS.member);
  await h.dm('remind in 1h drink water');
  assert.match(h.textOf(h.lastSent(dm)), /Reminder #1 set/);
  await h.dm('note buy milk');
  assert.match(h.textOf(h.lastSent(dm)), /Note 1 saved/);
  await h.dm('todo finish essay');
  assert.match(h.textOf(h.lastSent(dm)), /To-do 1 added/);
  await h.dm('tz Europe/London');
  assert.match(h.textOf(h.lastSent(dm)), /Europe\/London/);
  await h.dm('notes');
  assert.match(h.textOf(h.lastSent(dm)), /buy milk/);
  await h.dm('help');
  assert.match(h.textOf(h.lastSent(dm)), /remind in 2h stretch/);
  await h.dm('pocket');
  const panel = h.lastSent(dm);
  assert.match(h.textOf(panel), /YapOS Pocket/);
  assert.match(h.textOf(panel), /buy milk/, 'previews show in private DMs');
  await h.dm('afk napping');
  assert.ok(h.engine.service('pocket').afkOf(IDS.member));
  await h.advance(HOUR);
  assert.ok(dmTexts(h).some((t) => /Reminder:\*\* drink water/.test(t)));
});

test('DMs Pocket does not claim leave to other apps, and unknown DMs get the help card', async () => {
  const h = await make();
  const route = h.engine.dmRoutes.find((r) => r.app === 'pocket');
  for (const word of ['caption hi', 'gif', 'studio', 'hello']) assert.equal(!!route.match({ content: word }), false, word);
  for (const word of ['remind in 1h x', 'Note x', 'todos', 'afk', 'pocket', 'help', 'tz utc', 'notes', 'todo y']) assert.equal(!!route.match({ content: word }), true, word);
  const dm = dmOf(IDS.member);
  await h.dm('hello there');
  const first = h.lastSent(dm);
  assert.match(first.content, /Pocket/);
  assert.match(h.textOf(first), /remind in 2h stretch/);
  await h.dm('thanks');
  assert.match(h.lastSent(dm).content, /Type \*\*help\*\*/);
  assert.equal(h.lastSent(dm).embeds, null, 'the repeat answer is short');
});

test('DM panel buttons work in DMs and to-dos tick off', async () => {
  const h = await make();
  const dm = dmOf(IDS.member);
  await h.dm('todo water plants');
  await h.dm('todos');
  const panel = h.lastSent(dm);
  checkLimits(panel);
  const tick = h.findButton('1', panel);
  await h.click(tick.custom_id, { user: IDS.member, channel: dm, server: null, messageId: panel.id });
  const todos = h.engine.store.get('pocket', IDS.member).todos;
  assert.equal(todos[0].done, true);
});

test('/pocket panel is locked to its owner and switches views in place', async () => {
  const h = await make();
  await h.slash('pocket', 'note buy milk', { user: IDS.member });
  await h.slash('pocket', 'todo finish essay', { user: IDS.member });
  const ans = await h.slash('pocket', '', { user: IDS.member });
  const panel = ans[ans.length - 1];
  assert.equal(panel.type, 'reply', 'a panel with buttons is a normal message');
  checkLimits(panel);
  const text = h.textOf(panel);
  assert.match(text, /YapOS Pocket/);
  assert.match(text, /1 of 100/);
  assert.doesNotMatch(text, /buy milk/, 'no previews of private notes in a server');
  const other = await h.clickButton('To-dos', { user: IDS.member2, in: ans });
  assert.match(lastText(h, other), /Not your panel/);
  const todos = await h.clickButton('To-dos', { user: IDS.member, in: ans });
  const upd = todos[todos.length - 1];
  assert.equal(upd.type, 'update');
  assert.match(h.textOf(upd), /finish essay/);
  checkLimits(upd);
  const forged = await h.click(h.findButton('1', upd).custom_id, { user: IDS.member2 });
  assert.match(lastText(h, forged), /Not your panel/, 'the owner is in the button itself, so it holds after a restart');
  const ticked = await h.click(h.findButton('1', upd).custom_id, { user: IDS.member, messageId: panel.message.id });
  assert.match(h.textOf(ticked[ticked.length - 1]), /✅/);
  assert.equal(h.engine.store.get('pocket', IDS.member).todos[0].done, true);
  const back = await h.clickButton('Back', { user: IDS.member, in: ticked });
  assert.match(h.textOf(back[back.length - 1]), /0 open · 1 done/);
});

test('notes: add, list, delete by number with undo, full notebook', async () => {
  const h = await make();
  await h.slash('pocket', 'note buy milk', { user: IDS.member });
  await h.slash('pocket', 'note call the bank', { user: IDS.member });
  const del = await h.slash('pocket', 'note delete 1', { user: IDS.member });
  assert.match(lastText(h, del), /Note deleted/);
  assert.deepEqual(h.engine.store.get('pocket', IDS.member).notes.map((n) => n.text), ['call the bank']);
  await h.clickButton('Undo', { user: IDS.member, in: del });
  assert.deepEqual(h.engine.store.get('pocket', IDS.member).notes.map((n) => n.text), ['buy milk', 'call the bank']);
  const missing = await h.slash('pocket', 'note delete 9', { user: IDS.member });
  assert.match(lastText(h, missing), /No note 9/);
  const literal = await h.slash('pocket', 'note delete the old photos', { user: IDS.member });
  assert.match(lastText(h, literal), /Note 3 saved/, 'words after delete are just a note');
  h.engine.store.update('pocket', IDS.member, (u) => {
    u.notes = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, text: `n${i}`, at: 0 }));
    u.nextNote = 101;
    return u;
  });
  const full = await h.slash('pocket', 'note one more', { user: IDS.member });
  assert.match(lastText(h, full), /notebook is full/);
  assert.equal(h.engine.store.get('pocket', IDS.member).notes.length, 100);
  const long = await h.slash('pocket', `note ${'x'.repeat(400)}`, { user: IDS.member2 });
  assert.match(lastText(h, long), /under 300/);
});

test('notes panel: delete button and undo, pages of 10', async () => {
  const h = await make();
  h.engine.store.set('pocket', IDS.member, { notes: Array.from({ length: 23 }, (_, i) => ({ id: i + 1, text: `note ${i + 1}`, at: 0 })), nextNote: 24 });
  const ans = await h.slash('pocket', 'notes', { user: IDS.member });
  const panel = ans[ans.length - 1];
  checkLimits(panel);
  assert.match(h.textOf(panel), /page 1\/3/);
  const next = await h.clickButton('Next', { user: IDS.member, in: panel });
  const p2 = next[next.length - 1];
  assert.match(h.textOf(p2), /note 11/);
  checkLimits(p2);
  const del = await h.click(h.findButton('12', p2).custom_id, { user: IDS.member, messageId: panel.message.id });
  const after = del[del.length - 1];
  assert.match(h.textOf(after), /Deleted: note 12/);
  assert.equal(h.engine.store.get('pocket', IDS.member).notes.length, 22);
  checkLimits(after);
  await h.clickButton('Undo', { user: IDS.member, in: after });
  assert.equal(h.engine.store.get('pocket', IDS.member).notes.length, 23);
});

test('todos: add, done, undone, delete, clear done, full list', async () => {
  const h = await make();
  await h.slash('pocket', 'todo one', { user: IDS.member });
  await h.slash('pocket', 'todo two', { user: IDS.member });
  const done = await h.slash('pocket', 'todo done 2', { user: IDS.member });
  assert.match(lastText(h, done), /Done!/);
  const undone = await h.slash('pocket', 'todo undone 2', { user: IDS.member });
  assert.match(lastText(h, undone), /Back on the list/);
  await h.slash('pocket', 'todo done 1', { user: IDS.member });
  const clear = await h.slash('pocket', 'todo clear', { user: IDS.member });
  assert.match(lastText(h, clear), /Removed 1 finished to-do/);
  assert.deepEqual(h.engine.store.get('pocket', IDS.member).todos.map((t) => t.text), ['two']);
  await h.clickButton('Undo', { user: IDS.member, in: clear });
  assert.deepEqual(h.engine.store.get('pocket', IDS.member).todos.map((t) => t.text), ['one', 'two']);
  const del = await h.slash('pocket', 'todo delete 2', { user: IDS.member });
  assert.match(lastText(h, del), /To-do deleted/);
  await h.slash('pocket', 'todo clear', { user: IDS.member });
  const nothing = await h.slash('pocket', 'todo clear', { user: IDS.member });
  assert.match(lastText(h, nothing), /Nothing to clear/);
  h.engine.store.update('pocket', IDS.member, (u) => { u.todos = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, text: `t${i}`, done: false, at: 0 })); u.nextTodo = 101; return u; });
  const full = await h.slash('pocket', 'todo another', { user: IDS.member });
  assert.match(lastText(h, full), /list is full/);
  const huh = await h.slash('pocket', 'nots', { user: IDS.member });
  assert.match(lastText(h, huh), /Did you mean \*\*note/);
});

test('reminders view: cancel button, undo, and forms for adding', async () => {
  const h = await make();
  await h.slash('remind', 'in 1h alpha', { user: IDS.member });
  const ans = await h.slash('pocket', 'reminders', { user: IDS.member });
  const panel = ans[ans.length - 1];
  assert.match(h.textOf(panel), /alpha/);
  const res = await h.clickButton('#1', { user: IDS.member, in: panel });
  const after = res[res.length - 1];
  assert.match(h.textOf(after), /Cancelled #1/);
  assert.equal(reminders(h).length, 0);
  await h.clickButton('Undo', { user: IDS.member, in: after });
  assert.equal(reminders(h).length, 1);
  const home = await h.slash('pocket', '', { user: IDS.member });
  const notes = await h.clickButton('Notes', { user: IDS.member, in: home });
  const form = await h.clickButton('Add', { user: IDS.member, in: notes[notes.length - 1] });
  const modal = form.find((a) => a.type === 'modal');
  assert.ok(modal, 'a form opens');
  await h.submit(modal.modal.custom_id, { text: 'from the form' }, { user: IDS.member });
  assert.deepEqual(h.engine.store.get('pocket', IDS.member).notes.map((n) => n.text), ['from the form']);
  const tzForm = await h.clickButton('Time zone', { user: IDS.member, in: home });
  const tzModal = tzForm.find((a) => a.type === 'modal');
  await h.submit(tzModal.modal.custom_id, { tz: 'tokyo' }, { user: IDS.member });
  assert.equal(h.engine.service('pocket').timeZone(IDS.member), 'Asia/Tokyo');
});

test('AFK: mentions get one short note per 10 minutes, the next message welcomes back with links', async () => {
  const h = await make();
  const set = await h.slash('afk', 'lunch', { user: IDS.member });
  assert.match(lastText(h, set), /You're AFK/);
  await h.advance(25 * 60_000);
  await h.message(`hey <@${IDS.member}> you there?`, { user: IDS.member2 });
  const note = h.lastSent(G);
  assert.match(note.content, /💤 \*\*Sam\*\* is AFK: lunch \(since 25m ago\)/);
  const count = h.sent(G).length;
  await h.message(`<@${IDS.member}> again`, { user: IDS.member2 });
  await h.message(`<@${IDS.member}> and again`, { user: IDS.mod, channel: G });
  assert.equal(h.sent(G).length, count, 'no second note within 10 minutes');
  await h.message(`<@${IDS.member}> elsewhere`, { user: IDS.member2, channel: IDS.channels.news });
  assert.equal(h.sent(IDS.channels.news).length, 0, 'one note per person per 10 minutes, even in another channel');
  await h.advance(11 * 60_000);
  await h.message(`<@${IDS.member}> later`, { user: IDS.member2 });
  assert.equal(h.sent(G).length, count + 1, 'a new note after 10 minutes');
  await h.message('back now', { user: IDS.member });
  const wb = h.lastSent(G);
  assert.match(wb.content, /Welcome back/);
  assert.match(wb.content, /mentioned 5 times/);
  assert.match(wb.content, new RegExp(`<#${G}> by \\*\\*riley`));
  assert.match(wb.content, new RegExp(`<#${IDS.channels.news}>`));
  assert.equal(h.engine.service('pocket').afkOf(IDS.member), null);
  const quiet = h.sent(G).length;
  await h.message(`<@${IDS.member}> hi`, { user: IDS.member2 });
  assert.equal(h.sent(G).length, quiet, 'no note once they are back');
});

test('AFK: the !afk message itself does not clear it, /afk off does, nobody-mentioned case', async () => {
  const h = await make();
  await h.message('!afk walking the dog', { user: IDS.member });
  assert.ok(h.engine.service('pocket').afkOf(IDS.member), 'still AFK after the command message');
  const off = await h.slash('afk', 'off', { user: IDS.member });
  assert.match(lastText(h, off), /not AFK any more/);
  const again = await h.slash('afk', 'off', { user: IDS.member });
  assert.match(lastText(h, again), /weren't AFK/);
  await h.slash('afk', '', { user: IDS.member });
  await h.message('hello', { user: IDS.member });
  assert.match(h.lastSent(G).content, /Nobody mentioned you/);
});

test('AFK: reasons cannot ping, only the last 10 mentions are kept', async () => {
  const h = await make();
  await h.slash('afk', '@everyone party', { user: IDS.member });
  await h.message(`<@${IDS.member}>`, { user: IDS.member2 });
  assert.doesNotMatch(h.lastSent(G).content, /@everyone/);
  for (let i = 0; i < 14; i++) await h.message(`<@${IDS.member}> ${i}`, { user: IDS.member2 });
  const afk = h.engine.service('pocket').afkOf(IDS.member);
  assert.equal(afk.count, 15);
  assert.equal(afk.mentions.length, 10);
  await h.message('back', { user: IDS.member });
  assert.match(h.lastSent(G).content, /I keep the last 10/);
});

test('AFK is skipped where Pocket is uninstalled', async () => {
  const h = await make();
  await h.slash('afk', 'lunch', { user: IDS.member });
  h.engine.settings.setEnabled(S, 'pocket', false);
  await h.message(`<@${IDS.member}> hey`, { user: IDS.member2 });
  assert.equal(h.sent(G).length, 0);
  const cmd = await h.slash('afk', 'again', { user: IDS.member });
  assert.match(lastText(h, cmd), /isn't installed here/);
});

test('bookmarks: reacting 💬 DMs a copy, at most 20 an hour, duplicates ignored', async () => {
  const h = await make();
  const msg = await h.message('the answer is 42', { user: IDS.member2, attachment: 'abc/notes.txt' });
  await h.react(msg.id, '💬', { user: IDS.member });
  const dms = h.sent(dmOf(IDS.member));
  assert.equal(dms.length, 1);
  const text = h.textOf(dms[0]);
  assert.match(text, /Bookmark from #general/);
  assert.match(text, /the answer is 42/);
  assert.match(text, /Riley/);
  assert.match(text, /Test Town/);
  assert.match(text, /notes\.txt/);
  assert.match(text, /\(UTC\)/);
  await h.react(msg.id, '💬', { user: IDS.member });
  assert.equal(h.sent(dmOf(IDS.member)).length, 1, 'the same message twice is ignored');
  await h.react(msg.id, '👍', { user: IDS.member });
  assert.equal(h.sent(dmOf(IDS.member)).length, 1, 'other emoji do nothing');
  for (let i = 0; i < 25; i++) {
    const m = await h.message(`msg ${i}`, { user: IDS.member2 });
    await h.react(m.id, '💬', { user: IDS.member });
  }
  assert.equal(h.sent(dmOf(IDS.member)).length, 20, '20 an hour');
  await h.advance(HOUR + 1000);
  const m = await h.message('fresh', { user: IDS.member2 });
  await h.react(m.id, '💬', { user: IDS.member });
  assert.equal(h.sent(dmOf(IDS.member)).length, 21, 'allowed again after an hour');
  assert.equal(h.engine.store.get('pocket', IDS.member).bookmarks.total, 21);
});

test('bookmarks: closed DMs or a missing message do nothing and do not crash', async () => {
  const h = await make();
  const msg = await h.message('hi', { user: IDS.member2 });
  h.fake.features.dms = false;
  await h.react(msg.id, '💬', { user: IDS.member });
  assert.equal(h.sent(G).length, 0, 'nothing is posted in the channel');
  assert.equal(h.engine.store.get('pocket', IDS.member, null)?.bookmarks?.total ?? 0, 0);
  h.fake.features.dms = true;
  await h.react('00000000-0000-4000-8000-00000000dead', '💬', { user: IDS.member });
  assert.equal(h.sent().length, 0);
});

test('the home screen shows Pocket to members and opens it in place', async () => {
  const h = await make();
  const home = await h.slash('menu', '', { user: IDS.member });
  const tile = h.findButton('Pocket', home);
  assert.ok(tile, 'members see the Pocket tile');
  const opened = await h.click(tile.custom_id, { user: IDS.member, messageId: tile.messageId });
  const view = opened[opened.length - 1];
  assert.match(h.textOf(view), /YapOS Pocket/);
  checkLimits(view);
});

test('restart: notes, todos, tz and AFK survive on the same store', async () => {
  const store = createMemoryStore();
  const a = await make({ store });
  await a.slash('pocket', 'note keep me', { user: IDS.member });
  await a.slash('pocket', 'tz Europe/London', { user: IDS.member });
  await a.slash('afk', 'gone fishing', { user: IDS.member });
  await a.slash('remind', 'every day 8:00 water', { user: IDS.member });
  a.engine.scheduler.stop();
  const b = await make({ store });
  const ans = await b.slash('pocket', '', { user: IDS.member });
  const text = lastText(b, ans);
  assert.match(text, /Europe\/London/);
  assert.match(text, /gone fishing/);
  assert.match(text, /1 waiting \(1 repeating\)/);
  await b.message(`<@${IDS.member}>`, { user: IDS.member2 });
  assert.match(b.lastSent(G).content, /gone fishing/);
  await b.advance(24 * HOUR);
  assert.equal(dmTexts(b).filter((t) => /water/.test(t)).length, 1);
});

test('review: many 💬 reactions at once still stop at 20 an hour', async () => {
  const h = await make();
  const msgs = [];
  for (let i = 0; i < 25; i++) msgs.push(await h.message(`burst ${i}`, { user: IDS.member2 }));
  await Promise.all(msgs.map((m) => h.react(m.id, '💬', { user: IDS.member })));
  assert.equal(h.sent(dmOf(IDS.member)).length, 20);
  assert.equal(h.engine.store.get('pocket', IDS.member).bookmarks.total, 20);
});

test('review: a closed-DM bookmark does not use up the hourly allowance', async () => {
  const h = await make();
  const msg = await h.message('keep this', { user: IDS.member2 });
  h.fake.features.dms = false;
  await h.react(msg.id, '💬', { user: IDS.member });
  assert.equal(h.engine.store.get('pocket', IDS.member).bookmarks.times.length, 0);
  h.fake.features.dms = true;
  await h.react(msg.id, '💬', { user: IDS.member });
  assert.equal(h.sent(dmOf(IDS.member)).length, 1, 'the same message can be saved once DMs open');
});

test('review: a repeating reminder whose DM keeps failing falls back to the channel instead of vanishing', async () => {
  const h = await make();
  await h.slash('remind', 'every day 8:00 water @everyone', { user: IDS.member });
  h.fake.fail('POST', /\/users\/.+\/dm$/, { status: 503, error: 'busy' });
  await h.advance(21 * HOUR);
  const posts = h.sent(G).filter((m) => /water/.test(m.content || ''));
  assert.equal(posts.length, 1);
  assert.match(posts[0].content, new RegExp(`<@${IDS.member}>`));
  assert.doesNotMatch(posts[0].content, /@everyone/);
  assert.equal(reminders(h).length, 1, 'it keeps repeating');
});

test('review: AFK note goes out once per person per 10 minutes across channels', async () => {
  const h = await make();
  await h.slash('afk', 'lunch', { user: IDS.member });
  await h.message(`<@${IDS.member}> one`, { user: IDS.member2 });
  await h.message(`<@${IDS.member}> two`, { user: IDS.member2, channel: IDS.channels.news });
  await h.message(`<@${IDS.member}> three`, { user: IDS.mod, channel: IDS.channels.welcome });
  const notes = h.sent().filter((m) => /is AFK/.test(m.content || ''));
  assert.equal(notes.length, 1);
  assert.equal(h.engine.service('pocket').afkOf(IDS.member).count, 3, 'every mention is still counted');
});

test('review: notes list shows the age as plain italics, not a broken subtext marker', async () => {
  const h = await make();
  await h.slash('pocket', 'note buy milk', { user: IDS.member });
  const ans = await h.slash('pocket', 'notes', { user: IDS.member });
  const text = lastText(h, ans);
  assert.match(text, /\*\*1\.\*\* buy milk · \*just now\*/);
  assert.doesNotMatch(text, / -# /);
});

test('review: an undo that cannot be applied says so instead of staying silent', async () => {
  const h = await make();
  await h.slash('pocket', 'todo one', { user: IDS.member });
  await h.slash('pocket', 'todo done 1', { user: IDS.member });
  const clear = await h.slash('pocket', 'todo clear', { user: IDS.member });
  h.engine.store.update('pocket', IDS.member, (u) => { u.todos = Array.from({ length: 100 }, (_, i) => ({ id: 500 + i, text: `t${i}`, done: false, at: 0 })); return u; });
  const undo = await h.clickButton('Undo', { user: IDS.member, in: clear });
  assert.match(lastText(h, undo), /Couldn't undo that/);
  assert.equal(h.engine.store.get('pocket', IDS.member).todos.length, 100);
});

test('review: "10 minutes stretch" and "2 hours call" are understood', () => {
  const now = Date.parse('2026-11-07T12:00:00Z');
  assert.equal(parseWhen('10 minutes stretch', { now }).at, now + 10 * 60_000);
  assert.equal(parseWhen('2 hours call', { now }).text, 'call');
  assert.equal(new Date(parseWhen('5 pm tea', { now }).at).toISOString(), '2026-11-07T17:00:00.000Z');
});
test('the old bookmark emoji no longer sends a copy, only the speech bubble does', async () => {
  const h = await createHarness({ apps: ['pocket'] });
  const msg = h.fake.addUserMessage(IDS.channels.general, IDS.member2, 'save me');
  await h.react(msg.id, '🔖', { user: IDS.member });
  assert.equal(Object.keys(h.fake.state.dms).length, 0, 'no DM for the old emoji');
});
