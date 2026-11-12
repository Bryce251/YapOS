import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, IDS, settle } from '../harness.js';

const S = IDS.server;
const LOG = IDS.channels.modlog;

async function make() {
  const h = await createHarness({ apps: ['tickets'] });
  h.engine.settings.patchApp(S, 'tickets', { logChannelId: LOG });
  return { h, svc: h.engine.service('tickets') };
}

const stored = (h) => h.store.get('tickets', S, { tickets: {} }).tickets;
const keptCopy = (h, n) => h.store.get('ticket-transcripts', `${S}-${n}`, null);

function seed(h, count) {
  h.store.update('tickets', S, (d) => {
    const tickets = {};
    for (let n = 1; n <= count; n++) {
      const closed = n % 3 === 0;
      tickets[n] = {
        id: `${S}:${n}`, number: n, channelId: closed ? null : `c-${n}`, roleId: null, openerId: n % 2 ? IDS.member : IDS.member2, typeId: 'support',
        claimedBy: n === 2 ? IDS.mod : null, status: closed ? 'closed' : 'open', createdAt: 1000 + n, closedAt: closed ? 2000 + n : null, closedBy: closed ? IDS.mod : null,
        reason: closed ? 'sorted' : null, answers: [{ q: 'What happened?', a: `case ${n}` }], topic: n === 7 ? 'Printer on fire' : `topic ${n}`, members: n === 2 ? [IDS.member2] : [],
        mode: 'role', name: `ticket-${String(n).padStart(4, '0')}`, cardId: null, lastActivityAt: 1500 + n, rating: closed && n <= 9 ? { stars: n === 3 ? 5 : 4 } : null,
      };
    }
    return { ...d, seq: count, tickets };
  }, { seq: 0, tickets: {} });
}

async function openTicket(h, user = IDS.member, topic = 'help please') {
  await h.slash('ticket', topic, { user });
  return Object.values(stored(h)).filter((t) => t.openerId === user).pop();
}

async function drive(promise) {
  let done = false;
  let value;
  let error;
  promise.then((v) => { done = true; value = v; }, (e) => { done = true; error = e; });
  for (let i = 0; !done && i < 20000; i++) {
    mock.timers.tick(1);
    await new Promise((r) => setImmediate(r));
  }
  if (error) throw error;
  return value;
}

async function withTimers(fn) {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const out = await drive(fn());
    mock.timers.tick(10_000);
    for (let i = 0; i < 40; i++) {
      mock.timers.tick(1);
      await new Promise((r) => setImmediate(r));
    }
    return out;
  } finally {
    mock.timers.reset();
  }
}

test('the tickets service is shared with the expected functions', async () => {
  const { svc } = await make();
  for (const fn of ['list', 'get', 'transcript', 'claim', 'unclaim', 'close']) assert.equal(typeof svc[fn], 'function', fn);
});

test('list filters by status, pages by 50, sorts newest first and adds counts and ratings', async () => {
  const { h, svc } = await make();
  seed(h, 120);
  const open = await svc.list(S);
  assert.equal(open.counts.open, 80);
  assert.equal(open.counts.closed, 40);
  assert.equal(open.total, 80);
  assert.equal(open.pageSize, 50);
  assert.equal(open.pages, 2);
  assert.equal(open.page, 1);
  assert.equal(open.tickets.length, 50);
  assert.equal(open.tickets[0].number, 119);
  assert.ok(open.tickets.every((t) => t.status === 'open'));
  assert.deepEqual(open.rating, { average: 4.3, count: 3 });

  const all = await svc.list(S, { status: 'all', page: 3 });
  assert.equal(all.total, 120);
  assert.equal(all.pages, 3);
  assert.equal(all.page, 3);
  assert.equal(all.tickets.length, 20);
  assert.equal(all.tickets[19].number, 1);

  const far = await svc.list(S, { status: 'closed', page: 99 });
  assert.equal(far.page, 1, 'a page past the end lands on the last page');
  assert.ok(far.tickets.every((t) => t.status === 'closed' && t.channelId === null));

  const odd = await svc.list(S, { status: 'nonsense' });
  assert.equal(odd.total, 80, 'unknown status falls back to open');
});

test('list rows have the contract shape and search covers topic, number and names', async () => {
  const { h, svc } = await make();
  seed(h, 12);
  const hit = await svc.list(S, { q: 'PRINTER' });
  assert.equal(hit.total, 1);
  const row = hit.tickets[0];
  assert.deepEqual(Object.keys(row).sort(), ['channelId', 'claimedBy', 'closedAt', 'createdAt', 'lastActivityAt', 'members', 'name', 'number', 'opener', 'rating', 'status', 'topic', 'type'].sort());
  assert.equal(row.number, 7);
  assert.deepEqual(row.type, { id: 'support', name: 'Support', emoji: '🎫' });
  assert.deepEqual(row.opener, { id: IDS.member, name: 'Sam' });
  assert.equal(row.claimedBy, null);
  assert.equal(row.channelId, 'c-7');

  const byNumber = await svc.list(S, { q: '0002' });
  assert.equal(byNumber.total, 1);
  assert.deepEqual(byNumber.tickets[0].claimedBy, { id: IDS.mod, name: 'Mo' });
  assert.equal(byNumber.tickets[0].members, 1);

  const byName = await svc.list(S, { status: 'all', q: 'riley' });
  assert.equal(byName.total, 6);
  const none = await svc.list(S, { q: 'nothing like this' });
  assert.deepEqual([none.total, none.pages, none.page, none.tickets.length], [0, 1, 1, 0]);
});

test('get returns details, answers and people, or null', async () => {
  const { h, svc } = await make();
  seed(h, 3);
  const t = await svc.get(S, 2);
  assert.equal(t.number, 2);
  assert.deepEqual(t.answers, [{ q: 'What happened?', a: 'case 2' }]);
  assert.deepEqual(t.people, [{ id: IDS.member2, name: 'Riley' }]);
  assert.equal(t.closedBy, null);
  const closed = await svc.get(S, 3);
  assert.equal(closed.reason, 'sorted');
  assert.deepEqual(closed.closedBy, { id: IDS.mod, name: 'Mo' });
  assert.equal(closed.rating, 5);
  assert.equal(await svc.get(S, 99), null);
});

test('claim: only one of two staff wins, the card is edited and members are refused', async () => {
  const { h, svc } = await make();
  const t = await openTicket(h);
  const refused = await svc.claim(S, t.number, IDS.member2);
  assert.equal(refused.ok, false);
  assert.match(refused.error, /Only staff/);

  const [a, b] = await Promise.all([svc.claim(S, t.number, IDS.mod), svc.claim(S, t.number, IDS.admin)]);
  assert.equal([a, b].filter((r) => r.ok).length, 1, 'exactly one claim wins');
  const loser = a.ok ? b : a;
  assert.match(loser.error, /already handling this ticket/);
  const claimer = stored(h)[t.number].claimedBy;
  assert.ok([IDS.mod, IDS.admin].includes(claimer));
  const winner = a.ok ? a : b;
  assert.match(winner.message, /You claimed ticket #0001/);
  assert.equal(winner.ticket.claimedBy.id, claimer);

  await settle();
  const cardMsg = h.fake.state.messages[t.channelId].find((m) => m.id === stored(h)[t.number].cardId);
  assert.ok(h.findButton('Claimed', [cardMsg]), 'the card shows it is claimed');
  assert.ok(h.findButton('Unclaim', [cardMsg]));
  const notes = h.sent(t.channelId).filter((m) => /claimed this ticket/.test(m.content));
  assert.equal(notes.length, 1, 'one claim note in the ticket');

  const again = await svc.claim(S, t.number, claimer);
  assert.equal(again.ok, true);
  assert.match(again.message, /already claimed/);
  assert.equal((await svc.claim(S, 404, IDS.mod)).ok, false);
});

test('unclaim: only the claimer or an admin, and the card goes back to Claim', async () => {
  const { h, svc } = await make();
  const t = await openTicket(h);
  const early = await svc.unclaim(S, t.number, IDS.mod);
  assert.equal(early.ok, false);
  assert.match(early.error, /Nobody has claimed/);
  await svc.claim(S, t.number, IDS.admin);
  const denied = await svc.unclaim(S, t.number, IDS.mod);
  assert.equal(denied.ok, false);
  assert.match(denied.error, /Only the person who claimed/);
  assert.equal(stored(h)[t.number].claimedBy, IDS.admin);
  await svc.claim(S, t.number, IDS.admin);
  const done = await svc.unclaim(S, t.number, IDS.admin);
  assert.equal(done.ok, true);
  assert.equal(done.ticket.claimedBy, null);
  assert.equal(stored(h)[t.number].claimedBy, null);
  const cardMsg = h.fake.state.messages[t.channelId].find((m) => m.id === stored(h)[t.number].cardId);
  assert.ok(h.findButton(/^Claim$/, [cardMsg]), 'Claim is back on the card');
  assert.ok(h.sent(t.channelId).some((m) => /unclaimed this ticket/.test(m.content)));
});

test('transcript is live for open tickets and stored on close; close refuses outsiders', async () => {
  const { h, svc } = await make();
  const t = await openTicket(h, IDS.member, 'printer on fire');
  await h.message('hello, my printer is on fire', { user: IDS.member, channel: t.channelId });
  const live = await svc.transcript(S, t.number);
  assert.equal(live.live, true);
  assert.match(live.text, /hello, my printer is on fire/);
  assert.ok(live.count >= 1);

  const outsider = await svc.close(S, t.number, { by: IDS.member2, reason: 'nope' });
  assert.equal(outsider.ok, false);
  assert.match(outsider.error, /Only staff or the person who opened/);
  assert.equal(stored(h)[t.number].status, 'open');

  const out = await withTimers(() => svc.close(S, t.number, { by: IDS.mod, reason: 'fixed it' }));
  assert.equal(out.ok, true);
  assert.match(out.message, /Closed ticket #0001\. The transcript went to the log channel\./);
  const saved = stored(h)[t.number];
  assert.equal(saved.status, 'closed');
  assert.equal(saved.reason, 'fixed it');
  assert.equal(saved.hasTranscript, true);
  assert.equal('transcript' in saved, false, 'the ticket record never holds the transcript text');
  const doc = keptCopy(h, t.number);
  assert.match(doc.text, /hello, my printer is on fire/);
  assert.match(doc.text, /Reason: fixed it/);
  assert.ok(doc.count >= 1);

  const copy = await svc.transcript(S, t.number);
  assert.deepEqual(copy, { text: doc.text, count: doc.count, live: false });
  const row = (await svc.list(S, { status: 'closed' })).tickets[0];
  assert.equal(row.number, t.number);
  assert.equal('transcript' in row, false, 'rows never carry the transcript');

  const twice = await svc.close(S, t.number, { by: IDS.mod });
  assert.equal(twice.ok, false);
  assert.match(twice.error, /already closed/);
  assert.equal(await svc.transcript(S, 404), null);
});

test('closed tickets without a stored copy have no transcript', async () => {
  const { h, svc } = await make();
  seed(h, 3);
  assert.equal(await svc.transcript(S, 3), null);
});

test('very long transcripts keep the last 200000 characters', async () => {
  const { h, svc } = await make();
  const t = await openTicket(h);
  for (let i = 0; i < 5; i++) await h.message(`${String(i).repeat(45000)}`, { user: IDS.member, channel: t.channelId });
  await h.message('THE END', { user: IDS.member, channel: t.channelId });
  const live = await svc.transcript(S, t.number);
  assert.equal(live.text.length, 200000);
  assert.match(live.text, /THE END\n$/);
  await withTimers(() => svc.close(S, t.number, { by: IDS.mod }));
  const saved = keptCopy(h, t.number).text;
  assert.equal(saved.length, 200000);
  assert.match(saved, /THE END\n$/);
});

test('a stored ticket with an old inline transcript is moved out on the next write', async () => {
  const { h, svc } = await make();
  seed(h, 3);
  h.store.update('tickets', S, (d) => {
    d.tickets[3].transcript = 'old copy';
    d.tickets[3].transcriptCount = 7;
    return d;
  });
  await openTicket(h);
  const t3 = stored(h)[3];
  assert.equal('transcript' in t3, false);
  assert.equal(t3.hasTranscript, true);
  assert.deepEqual(await svc.transcript(S, 3), { text: 'old copy', count: 7, live: false });
});

test('pruning drops the oldest transcript records past the limit', async () => {
  const { h } = await make();
  seed(h, 75);
  h.store.update('tickets', S, (d) => {
    for (const t of Object.values(d.tickets)) if (t.status === 'closed') t.hasTranscript = true;
    return d;
  });
  for (let n = 3; n <= 75; n += 3) h.store.set('ticket-transcripts', `${S}-${n}`, { text: `copy ${n}`, count: 1, at: n });
  await openTicket(h);
  const left = Object.values(stored(h)).filter((t) => t.hasTranscript).map((t) => t.number);
  assert.equal(left.length, 20);
  assert.equal(Math.min(...left), 18);
  assert.equal(keptCopy(h, 15), null);
  assert.equal(keptCopy(h, 3), null);
  assert.ok(keptCopy(h, 18));
});

test('live transcripts are reused for a short while', async () => {
  const { h, svc } = await make();
  const t = await openTicket(h);
  await h.message('first line', { user: IDS.member, channel: t.channelId });
  const calls = { n: 0 };
  const orig = h.engine.bot.messagesAfter;
  h.engine.bot.messagesAfter = async (...a) => { calls.n++; return orig.apply(h.engine.bot, a); };
  const a = await svc.transcript(S, t.number);
  const before = calls.n;
  const b = await svc.transcript(S, t.number);
  assert.equal(calls.n, before, 'the second view did not read the channel again');
  assert.deepEqual(a, b);
});
