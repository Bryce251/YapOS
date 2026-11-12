import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, IDS, settle } from '../harness.js';
import { parsePoll, parseGiveaway, parseExtras } from '../../apps/engage.js';

const S = IDS.server;
const G = IDS.channels.general;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const make = async (opts = {}) => {
  const h = await createHarness({ apps: ['engage'], fakeClock: true, ...opts });
  h.engine.config.liveEditGapMs = 0;
  return h;
};
const lastText = (h, ans) => h.textOf(ans[ans.length - 1]);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const hasId = (m, part) => JSON.stringify(m.components || []).includes(part);
const pollCard = (h) => [...h.sent(G)].reverse().find((m) => hasId(m, ':vote:'));
const giveCard = (h) => [...h.sent(G)].reverse().find((m) => hasId(m, ':enter:'));
const buttonsOf = (m) => (m.components || []).flatMap((r) => r.components || []);
const voteId = (card, i) => buttonsOf(card).find((b) => b.custom_id?.includes(':vote:') && b.custom_id.endsWith(`:${i}`)).custom_id;
const vote = (h, card, i, user) => h.click(voteId(card, i), { user, messageId: card.id });
const enterId = (card) => buttonsOf(card).find((b) => b.custom_id?.includes(':enter:')).custom_id;
const enter = (h, card, user) => h.click(enterId(card), { user, messageId: card.id });

let extraSeq = 0;
function addMembers(h, n, roles = [IDS.roles.member]) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    const id = `a0000000-0000-4000-8000-0000000${String(900 + ++extraSeq).padStart(5, '0')}`;
    h.fake.state.members[S].push({ id, username: `user${extraSeq}`, display_name: `User ${extraSeq}`, nickname: null, roles: [...roles], joined_at: '2026-02-01T00:00:00Z' });
    ids.push(id);
  }
  h.engine.cache.invalidate(S);
  return ids;
}
const giveRole = (h, uid, rid) => {
  h.fake.memberOf(S, uid).roles.push(rid);
  h.engine.perms.invalidate();
};

test('commands are registered, short and the app is open to members', async () => {
  const h = await make();
  for (const name of ['poll', 'giveaway']) {
    const c = h.bot.commands.get(name);
    assert.ok(c, `/${name} exists`);
    assert.ok(c.description.length > 0 && c.description.length <= 100, `/${name} description length ${c.description.length}`);
  }
  const a = h.engine.apps.get('engage');
  assert.equal(a.def.panelPerm, 'member');
  assert.equal(a.meta.category, 'Community');
  assert.ok(a.def.help.length >= 3);
  assert.ok(h.engine.scheduler.has('engage.pollend'));
  assert.ok(h.engine.scheduler.has('engage.giveawayend'));
});

test('parsePoll reads options, length and flags', () => {
  assert.deepEqual(parsePoll('Best snack? | Chips | Pretzels | Fruit 2h'), { question: 'Best snack?', options: ['Chips', 'Pretzels', 'Fruit'], multi: false, anon: false, durationMs: 2 * HOUR });
  const p = parsePoll('Pick | A | B | multi anon 2h30m');
  assert.deepEqual(p.options, ['A', 'B']);
  assert.equal(p.multi, true);
  assert.equal(p.anon, true);
  assert.equal(p.durationMs, 2.5 * HOUR);
  assert.equal(parsePoll('Pick | Top 10 | Top 20').options[1], 'Top 20');
  assert.equal(parsePoll('Pick | A | B 3 days').durationMs, 3 * DAY);
  assert.deepEqual(parsePoll('Pizza tonight? 1h').options, []);
  assert.equal(parsePoll('Pizza tonight? 1h').question, 'Pizza tonight?');
  assert.deepEqual(parseExtras('2h multi nonsense').unknown, ['nonsense']);
});

test('parseGiveaway reads duration, winners, prize and requirements', () => {
  const g = parseGiveaway('1d 2 Nitro-style prize role @VIP level 5 host @sam');
  assert.equal(g.durationMs, DAY);
  assert.equal(g.winners, 2);
  assert.equal(g.prize, 'Nitro-style prize');
  assert.equal(g.roleTok, '@VIP');
  assert.equal(g.level, 5);
  assert.equal(g.hostTok, '@sam');
  assert.equal(parseGiveaway('12h Custom role of your choice').prize, 'Custom role of your choice');
  assert.equal(parseGiveaway('1 day 500 coins').winners, 1);
  assert.equal(parseGiveaway('1 day 500 coins').prize, '500 coins');
  assert.equal(parseGiveaway('2h 25 winners Big prize').problem, 'winners');
  assert.equal(parseGiveaway('A prize').durationMs, null);
});

test('/poll posts a public card with a button per option, live bars and an end job', async () => {
  const h = await make();
  const ans = await h.slash('poll', 'Best snack? | Chips | Pretzels | Fruit 2h', { user: IDS.member });
  assert.match(lastText(h, ans), /Poll #1 is live/);
  assert.equal(ans[ans.length - 1].type, 'ephemeral');
  const card = pollCard(h);
  assert.ok(card, 'card posted');
  const text = h.textOf(card);
  assert.match(text, /📊 Best snack\?/);
  assert.match(text, /Chips/);
  assert.match(text, /0 voters/);
  assert.match(text, /Ends in \*\*2h\*\*/);
  assert.equal(buttonsOf(card).filter((b) => b.custom_id.includes(':vote:')).length, 3);
  assert.ok(buttonsOf(card).some((b) => b.label === 'End now'));
  assert.ok(buttonsOf(card).some((b) => b.label === 'Voters'));
  for (const b of buttonsOf(card)) assert.ok(Buffer.byteLength(b.custom_id) <= 100);
  const jobs = h.engine.scheduler.list({ kind: 'engage.pollend', serverId: S });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].key, '1');
  assert.equal(jobs[0].at, h.now() + 2 * HOUR);
  assert.equal(h.engine.router.panelOwner(card.id), null, 'poll card is not locked to anyone');
});

test('voting answers privately, edits the card in place, and allows changing and taking back', async () => {
  const h = await make();
  await h.slash('poll', 'Best snack? | Chips | Pretzels | Fruit', { user: IDS.member });
  const card = pollCard(h);
  const before = h.sent(G).length;
  let ans = await vote(h, card, 0, IDS.member2);
  assert.equal(ans[0].type, 'ephemeral');
  assert.match(lastText(h, ans), /You voted for \*\*Chips\*\*/);
  await settle();
  assert.match(h.textOf(card), /100%\*\* · 1 vote/);
  assert.match(h.textOf(card), /1 voter/);
  ans = await vote(h, card, 1, IDS.member2);
  assert.match(lastText(h, ans), /Vote changed/);
  assert.match(lastText(h, ans), /was \*\*Chips\*\*/);
  ans = await vote(h, card, 1, IDS.member2);
  assert.match(lastText(h, ans), /took back/);
  await vote(h, card, 2, IDS.member);
  await vote(h, card, 2, IDS.mod);
  await settle();
  const text = h.textOf(card);
  assert.match(text, /2 voters/);
  assert.match(text, /Fruit\*\*\n🟦🟦🟦🟦🟦🟦🟦🟦🟦🟦 \*\*100%\*\* · 2 votes/);
  assert.equal(h.sent(G).length, before, 'no new messages per click');
  const doc = h.store.get('engage', `${S}.poll.1`);
  assert.deepEqual(Object.keys(doc.votes).sort(), [IDS.member, IDS.mod].sort());
});

test('multi polls let people pick several and toggle each pick', async () => {
  const h = await make();
  await h.slash('poll', 'Games tonight? | Chess | Uno | Poker multi', { user: IDS.member });
  const card = pollCard(h);
  await vote(h, card, 0, IDS.member2);
  const ans = await vote(h, card, 2, IDS.member2);
  assert.match(lastText(h, ans), /Your votes: \*\*Chess\*\*, \*\*Poker\*\*/);
  await vote(h, card, 0, IDS.member);
  await settle();
  assert.match(h.textOf(card), /Chess\*\*\n🟦{10} \*\*100%\*\* · 2 votes/u);
  assert.match(h.textOf(card), /Pick as many as you like/);
  const off = await vote(h, card, 0, IDS.member2);
  assert.match(lastText(h, off), /took back/);
  assert.deepEqual(h.store.get('engage', `${S}.poll.1`).votes[IDS.member2], [2]);
});

test('card edits are coalesced: many clicks, few edits, latest state wins', async () => {
  const h = await make();
  h.engine.config.liveEditGapMs = 400;
  await h.slash('poll', 'Coalesce? | Yes | No', { user: IDS.member });
  const card = pollCard(h);
  const voters = addMembers(h, 6);
  const edits = () => h.fake.callsTo('PATCH', new RegExp(`/messages/${card.id}$`)).length;
  for (const u of voters) await vote(h, card, 0, u);
  assert.ok(edits() <= 2, `edits so far ${edits()}`);
  await wait(500);
  await settle();
  assert.ok(edits() <= 3, `edits after the gap ${edits()}`);
  assert.match(h.textOf(card), /6 voters/);
});

test('the scheduler ends the poll: winner highlighted, buttons disabled, votes closed', async () => {
  const h = await make();
  await h.slash('poll', 'Best snack? | Chips | Pretzels 2h', { user: IDS.member });
  const card = pollCard(h);
  await vote(h, card, 1, IDS.member2);
  await vote(h, card, 1, IDS.mod);
  await vote(h, card, 0, IDS.member);
  await h.advance(2 * HOUR);
  await settle();
  const text = h.textOf(card);
  assert.match(text, /🏆 \*\*Pretzels\*\* wins with 2 votes \(67%\)/);
  assert.match(text, /Poll ended/);
  assert.doesNotMatch(text, /late/);
  const votes = buttonsOf(card).filter((b) => b.custom_id.includes(':vote:'));
  assert.ok(votes.every((b) => b.disabled));
  assert.equal(votes[1].style, 'success');
  assert.ok(!buttonsOf(card).some((b) => b.label === 'End now'));
  const ans = await h.click(votes[0].custom_id, { user: IDS.member2, messageId: card.id });
  assert.match(lastText(h, ans), /This poll has ended/);
  assert.equal(h.engine.scheduler.list({ kind: 'engage.pollend' }).length, 0);
});

test('ties and empty polls end with plain results', async () => {
  const h = await make();
  await h.slash('poll', 'Tie? | A | B 1h', { user: IDS.member });
  const tie = pollCard(h);
  await vote(h, tie, 0, IDS.member);
  await vote(h, tie, 1, IDS.member2);
  await h.slash('poll', 'Empty? | A | B 1h', { user: IDS.member2 });
  const empty = pollCard(h);
  await h.advance(HOUR);
  await settle();
  assert.match(h.textOf(tie), /tie between \*\*A\*\* and \*\*B\*\*/);
  assert.match(h.textOf(empty), /Nobody voted/);
});

test('End now works for the creator and mods, not for other members', async () => {
  const h = await make();
  await h.slash('poll', 'End me? | Yes | No', { user: IDS.member });
  const card = pollCard(h);
  const endId = buttonsOf(card).find((b) => b.label === 'End now').custom_id;
  let ans = await h.click(endId, { user: IDS.member2, messageId: card.id });
  assert.match(lastText(h, ans), /Only the person who started this poll or a moderator/);
  assert.equal(h.store.get('engage', `${S}.poll.1`).ended, false);
  ans = await h.click(endId, { user: IDS.member, messageId: card.id });
  assert.match(lastText(h, ans), /Poll #1 ended/);
  await settle();
  assert.match(h.textOf(card), /ended early/);
  assert.equal(h.engine.scheduler.list({ kind: 'engage.pollend' }).length, 0);
  await h.slash('poll', 'Mod ends? | Yes | No', { user: IDS.member });
  ans = await h.slash('poll', 'end 2', { user: IDS.mod });
  assert.match(lastText(h, ans), /Poll #2 ended/);
  ans = await h.slash('poll', 'end 2', { user: IDS.mod });
  assert.match(lastText(h, ans), /Already ended/);
  ans = await h.slash('poll', 'end 99', { user: IDS.mod });
  assert.match(lastText(h, ans), /no poll #99/);
});

test('anonymous polls hide voters; open polls list them', async () => {
  const h = await make();
  await h.slash('poll', 'Secret? | Yes | No anon', { user: IDS.member });
  const anon = pollCard(h);
  assert.ok(!buttonsOf(anon).some((b) => b.label === 'Voters'));
  assert.match(h.textOf(anon), /anonymous/);
  await h.slash('poll', 'Open? | Yes | No', { user: IDS.member });
  const open = pollCard(h);
  await vote(h, open, 0, IDS.member2);
  const ans = await h.click(buttonsOf(open).find((b) => b.label === 'Voters').custom_id, { user: IDS.mod, messageId: open.id });
  assert.match(lastText(h, ans), new RegExp(`Yes\\*\\* \\(1\\): <@${IDS.member2}>`));
  const forced = await h.click(`yo:engage:voters:1`, { user: IDS.mod, messageId: anon.id });
  assert.match(lastText(h, forced), /anonymous/);
});

test('poll input problems get friendly answers and post nothing', async () => {
  const h = await make();
  const cases = [
    ['Q | Only one', /Add another option/],
    [`Q | ${Array.from({ length: 11 }, (_, i) => `O${i}`).join(' | ')}`, /up to 10 options/],
    ['Q | Same | same', /in there twice/],
    ['Q | A | B 8d', /up to 7 days/],
    ['Q | A | B 30s', /at least 1 minute/],
    [`Q | ${'x'.repeat(81)} | B`, /under 80 characters/],
    [`${'q'.repeat(201)} | A | B`, /under 200 characters/],
  ];
  for (const [args, re] of cases) {
    const ans = await h.slash('poll', args, { user: IDS.member });
    assert.match(lastText(h, ans), re, args.slice(0, 30));
  }
  assert.equal(pollCard(h), undefined);
  assert.equal(h.engine.scheduler.list({ kind: 'engage.pollend' }).length, 0);
});

test('a question alone makes a yes/no poll, typed commands work, mentions are defused', async () => {
  const h = await make();
  await h.message('!poll Pizza tonight @everyone? 3h', { user: IDS.member });
  const card = pollCard(h);
  assert.deepEqual(buttonsOf(card).filter((b) => b.custom_id.includes(':vote:')).map((b) => b.label), ['Yes', 'No']);
  assert.doesNotMatch(h.textOf(card), /@everyone/);
  assert.match(h.textOf(card), /Ends in \*\*3h\*\*/);
});

test('poll limits: 3 running per member, 20 per server', async () => {
  const h = await make();
  for (let i = 0; i < 3; i++) await h.slash('poll', `Q${i} | A | B`, { user: IDS.member });
  let ans = await h.slash('poll', 'Q4 | A | B', { user: IDS.member });
  assert.match(lastText(h, ans), /already have 3 polls running/);
  for (let i = 3; i < 20; i++) await h.slash('poll', `Q${i} | A | B`, { user: IDS.mod });
  ans = await h.slash('poll', 'Q21 | A | B', { user: IDS.mod });
  assert.match(lastText(h, ans), /already has 20 polls running/);
  ans = await h.slash('poll', 'list', { user: IDS.member });
  assert.match(lastText(h, ans), /Running \(20\/20\)/);
  await h.advance(DAY);
  ans = await h.slash('poll', 'Fresh | A | B', { user: IDS.mod });
  assert.match(lastText(h, ans), /Poll #21 is live/);
  const index = h.store.get('engage', S);
  assert.ok(index.poll.length <= 21, `kept ${index.poll.length}`);
});

test('polls and votes survive a restart; a late end says so', async () => {
  const a = await make();
  await a.slash('poll', 'Survive? | Yes | No 1h', { user: IDS.member });
  const card = pollCard(a);
  await vote(a, card, 0, IDS.member2);
  a.engine.scheduler.stop();
  await a.store.flush();
  const b = await make({ store: a.store });
  b.fake.state.messages = a.fake.state.messages;
  b.clock.t = a.clock.t;
  await vote(b, card, 0, IDS.member);
  await b.skip(3 * HOUR);
  await settle();
  const text = b.textOf(card);
  assert.match(text, /🏆 \*\*Yes\*\* wins with 2 votes/);
  assert.match(text, /late because I was offline/);
});

test('the poll form posts a poll and rejects unknown extras', async () => {
  const h = await make();
  let ans = await h.submit('yo:engage:pollsubmit', { question: 'Lunch?', options: 'Tacos\nSushi\nSalad', extras: '90m multi' }, { user: IDS.member });
  assert.match(lastText(h, ans), /Poll #1 is live/);
  const card = pollCard(h);
  assert.match(h.textOf(card), /Tacos/);
  assert.equal(h.store.get('engage', `${S}.poll.1`).multi, true);
  ans = await h.submit('yo:engage:pollsubmit', { question: 'Lunch?', options: 'A\nB', extras: 'soon' }, { user: IDS.member });
  assert.match(lastText(h, ans), /I didn't get the extras/);
});

test('/giveaway is for mods by default and posts a public card with requirements', async () => {
  const h = await make();
  let ans = await h.slash('giveaway', '1d 2 Nitro-style prize', { user: IDS.member });
  assert.match(lastText(h, ans), /Only moderators/);
  ans = await h.slash('giveaway', '1d 2 Nitro-style prize role @VIP host @riley', { user: IDS.mod });
  assert.match(lastText(h, ans), /Giveaway #1 is live/);
  const card = giveCard(h);
  const text = h.textOf(card);
  assert.match(text, /🎉 Nitro-style prize/);
  assert.match(text, /\*\*2\*\* winners/);
  assert.match(text, /\*\*0\*\* entries/);
  assert.match(text, new RegExp(`Hosted by <@${IDS.member2}>`));
  assert.match(text, new RegExp(`must have <@&${IDS.roles.vip}>`));
  assert.match(text, /Ends in \*\*1d\*\*/);
  assert.equal(h.engine.router.panelOwner(card.id), null);
  const job = h.engine.scheduler.list({ kind: 'engage.giveawayend' })[0];
  assert.equal(job.key, '1');
  assert.equal(job.at, h.now() + DAY);
});

test('giveaway input problems are explained', async () => {
  const h = await make();
  const cases = [
    ['Big prize', /How long should it run/],
    ['1d', /What is the prize/],
    ['2h 25 winners Big prize', /Pick 1 to 20 winners/],
    ['40d Prize', /up to 30 days/],
    ['1d Prize role @Nobodyhere', /couldn't find that role/],
    ['1d Prize level 5', /Levels is off here/],
    ['1d Prize host @zzzzzz', /couldn't find the host/],
    ['lsit', /Did you mean \*\*\/giveaway list\*\*/],
  ];
  for (const [args, re] of cases) {
    const ans = await h.slash('giveaway', args, { user: IDS.mod });
    assert.match(lastText(h, ans), re, args);
  }
  assert.equal(giveCard(h), undefined);
});

test('entering checks the role, answers privately, counts live, and a second press offers to leave', async () => {
  const h = await make();
  await h.slash('giveaway', '1d 1 Prize role @VIP', { user: IDS.mod });
  const card = giveCard(h);
  let ans = await enter(h, card, IDS.member);
  assert.equal(ans[0].type, 'ephemeral');
  assert.match(lastText(h, ans), /You need the \*\*@VIP\*\* role to enter/);
  giveRole(h, IDS.member, IDS.roles.vip);
  ans = await enter(h, card, IDS.member);
  assert.match(lastText(h, ans), /You're in!/);
  assert.match(lastText(h, ans), /\*\*1 entry\*\*/);
  await settle();
  assert.match(h.textOf(card), /\*\*1\*\* entry/);
  const before = h.sent(G).length;
  ans = await enter(h, card, IDS.member);
  assert.match(lastText(h, ans), /already in/);
  assert.match(lastText(h, ans), /once more/);
  assert.equal(ans.at(-1).type, 'ephemeral');
  ans = await enter(h, card, IDS.member);
  assert.match(lastText(h, ans), /already in/, 'a quick double tap does not leave');
  assert.deepEqual(h.store.get('engage', `${S}.giveaway.1`).entries, [IDS.member]);
  await wait(1100);
  const left = await enter(h, card, IDS.member);
  assert.match(lastText(h, left), /You left the giveaway/);
  assert.equal(left.at(-1).type, 'ephemeral');
  assert.equal(h.sent(G).length, before, 'pressing Enter again never posts a message in the channel');
  await settle();
  assert.match(h.textOf(card), /\*\*0\*\* entries/);
  assert.deepEqual(h.store.get('engage', `${S}.giveaway.1`).entries, []);
});

test('level requirements use the Levels app', async () => {
  const h = await make({ apps: ['engage', 'levels'] });
  await h.slash('giveaway', '1d 1 Prize level 5', { user: IDS.mod });
  const card = giveCard(h);
  let ans = await enter(h, card, IDS.member);
  assert.match(lastText(h, ans), /need to be \*\*level 5\*\*/);
  await h.slash('levels', 'set @sam 6', { user: IDS.admin });
  ans = await enter(h, card, IDS.member);
  assert.match(lastText(h, ans), /You're in!/);
  assert.match(h.textOf(card), /level 5\+/);
});

test('the end job draws valid winners, skips people who left or lost the role, pings once and logs', async () => {
  const h = await make();
  h.engine.settings.patchCore(S, { logChannel: IDS.channels.modlog });
  await h.slash('giveaway', '2h 2 Shiny prize role @VIP', { user: IDS.mod });
  const card = giveCard(h);
  const people = addMembers(h, 4, [IDS.roles.member, IDS.roles.vip]);
  for (const u of people) await enter(h, card, u);
  h.fake.state.members[S] = h.fake.state.members[S].filter((m) => m.id !== people[0]);
  h.fake.memberOf(S, people[1]).roles = [IDS.roles.member];
  await h.advance(2 * HOUR);
  await settle();
  const g = h.store.get('engage', `${S}.giveaway.1`);
  assert.equal(g.ended, true);
  assert.deepEqual([...g.winnerIds].sort(), [people[2], people[3]].sort());
  const text = h.textOf(card);
  assert.match(text, /🏆 Winners: /);
  assert.ok(buttonsOf(card)[0].disabled);
  const ann = h.sent(G).filter((m) => /Congratulations/.test(m.content));
  assert.equal(ann.length, 1);
  assert.match(ann[0].content, new RegExp(`<@${people[2]}>`));
  assert.match(ann[0].content, /Shiny prize/);
  assert.match(h.textOf(h.lastSent(IDS.channels.modlog)), /Giveaway ended/);
  await h.engine.scheduler.runDue();
  await settle();
  assert.equal(h.sent(G).filter((m) => /Congratulations/.test(m.content)).length, 1, 'running again does not announce twice');
  const late = await enter(h, card, people[2]);
  assert.match(lastText(h, late), /has ended/);
});

test('no entries means no winner, said plainly', async () => {
  const h = await make();
  await h.slash('giveaway', '1h Lonely prize', { user: IDS.mod });
  const card = giveCard(h);
  await h.advance(HOUR);
  await settle();
  assert.match(h.textOf(card), /Nobody entered, so nobody won/);
  assert.ok(h.sent(G).some((m) => /no entries, so there's no winner/.test(m.content)));
});

test('reroll picks from the rest, only for the host or mods', async () => {
  const h = await make();
  await h.slash('giveaway', '1h 1 Prize host @sam', { user: IDS.mod });
  const card = giveCard(h);
  const people = addMembers(h, 2);
  for (const u of people) await enter(h, card, u);
  let ans = await h.slash('giveaway', 'reroll 1', { user: IDS.member });
  assert.match(lastText(h, ans), /hasn't ended yet/);
  await h.advance(HOUR);
  const first = h.store.get('engage', `${S}.giveaway.1`).winnerIds;
  assert.equal(first.length, 1);
  ans = await h.slash('giveaway', 'reroll 1', { user: IDS.member2 });
  assert.match(lastText(h, ans), /Only the host/);
  ans = await h.slash('giveaway', 'reroll 1', { user: IDS.member });
  assert.match(lastText(h, ans), /Rerolled/);
  const other = people.find((u) => u !== first[0]);
  assert.match(lastText(h, ans), new RegExp(`<@${other}>`));
  await settle();
  assert.match(h.textOf(card), new RegExp(`Rerolled: <@${other}>`));
  assert.ok(h.sent(G).some((m) => /Reroll for \*\*Prize\*\*/.test(m.content)));
  ans = await h.slash('giveaway', 'reroll 1', { user: IDS.mod });
  assert.match(lastText(h, ans), /Rerolled/);
  assert.match(lastText(h, ans), /already won, so I drew from all the entries again/);
  await settle();
  const reroll = h.findButton('Reroll', card);
  assert.ok(reroll, 'ended card has a Reroll button');
  ans = await h.click(reroll.custom_id, { user: IDS.member2 });
  assert.match(lastText(h, ans), /Only the host/);
  ans = await h.click(reroll.custom_id, { user: IDS.mod });
  assert.match(lastText(h, ans), /Rerolled/);
});

test('/giveaway end ends early, cancels the job and /giveaway list shows them', async () => {
  const h = await make();
  await h.slash('giveaway', '1d 1 Early prize', { user: IDS.mod });
  await h.slash('giveaway', '2d 3 Later prize', { user: IDS.mod });
  const card = giveCard(h);
  await enter(h, card, IDS.member);
  let ans = await h.slash('giveaway', 'list', { user: IDS.member });
  assert.match(lastText(h, ans), /Running \(2\/20\)/);
  assert.match(lastText(h, ans), /Later prize · 1 entry/);
  ans = await h.slash('giveaway', 'end 2', { user: IDS.member });
  assert.match(lastText(h, ans), /Only the host/);
  ans = await h.slash('giveaway', 'end #2', { user: IDS.mod });
  assert.match(lastText(h, ans), /Giveaway #2 ended/);
  assert.match(lastText(h, ans), new RegExp(`<@${IDS.member}>`));
  assert.equal(h.engine.scheduler.list({ kind: 'engage.giveawayend' }).length, 1);
  await settle();
  assert.match(h.textOf(card), /Ended early/);
  ans = await h.slash('giveaway', 'end 2', { user: IDS.mod });
  assert.match(lastText(h, ans), /Already ended/);
  ans = await h.slash('giveaway', 'list', { user: IDS.member });
  assert.match(lastText(h, ans), /Recently ended/);
});

test('giveaways survive a restart and a late end still ends and says so', async () => {
  const a = await make();
  await a.slash('giveaway', '1h 1 Restart prize', { user: IDS.mod });
  const card = giveCard(a);
  await enter(a, card, IDS.member);
  a.engine.scheduler.stop();
  const b = await make({ store: a.store });
  b.fake.state.messages = a.fake.state.messages;
  b.clock.t = a.clock.t;
  await b.skip(5 * HOUR);
  await settle();
  const g = b.store.get('engage', `${S}.giveaway.1`);
  assert.equal(g.ended, true);
  assert.deepEqual(g.winnerIds, [IDS.member]);
  assert.match(b.textOf(card), /late because I was offline/);
  const ann = b.sent(G).find((m) => /Congratulations/.test(m.content));
  assert.match(ann.content, /sorry, this ended .* late because I was offline/);
});

test('leaving the server removes the entry; giveaways are capped at 20', async () => {
  const h = await make();
  await h.slash('giveaway', '1d 1 Prize', { user: IDS.mod });
  const card = giveCard(h);
  await enter(h, card, IDS.member2);
  await h.leave(IDS.member2);
  await settle();
  assert.deepEqual(h.store.get('engage', `${S}.giveaway.1`).entries, []);
  assert.match(h.textOf(card), /\*\*0\*\* entries/);
  for (let i = 1; i < 20; i++) await h.slash('giveaway', `1d Prize ${i}`, { user: IDS.mod });
  const ans = await h.slash('giveaway', '1d One too many', { user: IDS.mod });
  assert.match(lastText(h, ans), /already has 20 giveaways running/);
});

test('while Engage is uninstalled the end waits, then finishes once it is back', async () => {
  const h = await make();
  await h.slash('poll', 'Paused? | Yes | No 1h', { user: IDS.member });
  const card = pollCard(h);
  h.engine.settings.setEnabled(S, 'engage', false);
  await h.advance(HOUR);
  assert.equal(h.store.get('engage', `${S}.poll.1`).ended, false);
  assert.equal(h.engine.scheduler.list({ kind: 'engage.pollend' }).length, 1);
  const refused = await vote(h, card, 0, IDS.member2);
  assert.match(lastText(h, refused), /isn't installed here/);
  h.engine.settings.setEnabled(S, 'engage', true);
  await h.advance(HOUR);
  await settle();
  const p = h.store.get('engage', `${S}.poll.1`);
  assert.equal(p.ended, true);
  assert.equal(p.late, true);
});

test('a failed post rolls back so nothing is left half made', async () => {
  const h = await make();
  h.fake.fail('POST', new RegExp(`/channels/${G}/messages$`), { status: 403, times: 1 });
  const ans = await h.slash('poll', 'Fails? | Yes | No', { user: IDS.member });
  assert.match(lastText(h, ans), /Send Messages/);
  assert.equal(h.store.get('engage', `${S}.poll.1`, null), null);
  assert.equal(h.engine.scheduler.list({ kind: 'engage.pollend' }).length, 0);
  const again = await h.slash('poll', 'Works? | Yes | No', { user: IDS.member });
  assert.match(lastText(h, again), /is live/);
});

test('panel: members see polls and giveaways; admins can change who starts them', async () => {
  const h = await make();
  await h.slash('poll', 'Panel? | Yes | No', { user: IDS.member });
  const a = h.engine.apps.get('engage');
  const memberCtx = h.engine.contextFor({ server_id: S, channel_id: G, user_id: IDS.member, username: 'sam', id: 'x1' }, { app: 'engage' });
  await a.def.panel(memberCtx);
  await settle();
  const memberPanel = h.lastSent(G);
  const mText = h.textOf(memberPanel);
  assert.match(mText, /Polls running \(1\)/);
  assert.match(mText, /New poll/);
  assert.doesNotMatch(mText, /New giveaway/);
  assert.doesNotMatch(mText, /Polls: everyone/);
  const adminCtx = h.engine.contextFor({ server_id: S, channel_id: G, user_id: IDS.admin, username: 'alex', id: 'x2' }, { app: 'engage' });
  await a.def.panel(adminCtx);
  await settle();
  const adminPanel = h.lastSent(G);
  assert.match(h.textOf(adminPanel), /New giveaway/);
  const denied = await h.click('yo:engage:tpoll', { user: IDS.member, messageId: null });
  assert.match(lastText(h, denied), /Only admins/);
  await h.clickButton('Polls: everyone', { user: IDS.admin, in: adminPanel });
  assert.equal(h.engine.settings.appConfig(S, 'engage').pollPerm, 'mod');
  const ans = await h.slash('poll', 'Now? | Yes | No', { user: IDS.member });
  assert.match(lastText(h, ans), /Only moderators/);
});

test('the giveaway form validates and creates', async () => {
  const h = await make();
  let ans = await h.submit('yo:engage:givesubmit', { prize: 'Form prize', duration: '2h', winners: '3', extras: 'host @sam' }, { user: IDS.mod });
  assert.match(lastText(h, ans), /Giveaway #1 is live/);
  const g = h.store.get('engage', `${S}.giveaway.1`);
  assert.equal(g.winners, 3);
  assert.equal(g.hostId, IDS.member);
  ans = await h.submit('yo:engage:givesubmit', { prize: 'X', duration: '2h', winners: '', extras: 'whatever' }, { user: IDS.mod });
  assert.match(lastText(h, ans), /didn't get the requirements/);
  ans = await h.submit('yo:engage:givesubmit', { prize: 'X', duration: '2h', winners: '' }, { user: IDS.member });
  assert.match(lastText(h, ans), /Only moderators/);
});

test('polls and giveaways are numbered separately', async () => {
  const h = await make();
  await h.slash('poll', 'First? | A | B', { user: IDS.member });
  const ans = await h.slash('giveaway', '1d Prize', { user: IDS.mod });
  assert.match(lastText(h, ans), /Giveaway #1 is live/);
  assert.match(h.textOf(giveCard(h)), /Giveaway #1/);
});

test('/yap routes to polls and giveaways', async () => {
  const h = await make();
  await h.slash('yap', 'poll Yap? | A | B', { user: IDS.member });
  assert.ok(pollCard(h));
  const ans = await h.slash('yap', 'giveaway list', { user: IDS.member });
  assert.match(lastText(h, ans), /Giveaways/);
});

test('poll options that look like flags or lengths are kept as options', () => {
  assert.deepEqual(parsePoll('Channel? | Public | Private').options, ['Public', 'Private']);
  assert.equal(parsePoll('Channel? | Public | Private').anon, false);
  assert.deepEqual(parsePoll('Mode? | Solo | Multi').options, ['Solo', 'Multi']);
  assert.equal(parsePoll('Mode? | Solo | Multi').multi, false);
  assert.deepEqual(parsePoll('Q | Stay public | Go private').options, ['Stay public', 'Go private']);
  const m = parsePoll('Meeting? | 30 min | 1 hour | 2 hours');
  assert.deepEqual(m.options, ['30 min', '1 hour', '2 hours']);
  assert.equal(m.durationMs, null);
  const t = parsePoll('Q | 1h | 2h');
  assert.deepEqual(t.options, ['1h', '2h']);
  assert.equal(t.durationMs, null);
  const both = parsePoll('Q | 1h | 2h | 3h 1d');
  assert.deepEqual(both.options, ['1h', '2h', '3h']);
  assert.equal(both.durationMs, DAY);
  const flags = parsePoll('Q | A | B | anon 2h');
  assert.deepEqual(flags.options, ['A', 'B']);
  assert.equal(flags.anon, true);
  assert.equal(flags.durationMs, 2 * HOUR);
  assert.deepEqual(parsePoll('Q | Chips | Pretzels | 2h').options, ['Chips', 'Pretzels']);
});

test('a full giveaway refuses new entries', async () => {
  const h = await make();
  await h.slash('giveaway', '1d 1 Prize', { user: IDS.mod });
  const card = giveCard(h);
  h.store.update('engage', `${S}.giveaway.1`, (g) => ({ ...g, entries: Array.from({ length: 10_000 }, (_, i) => `u${i}`) }));
  const ans = await enter(h, card, IDS.member);
  assert.match(lastText(h, ans), /full/);
  assert.equal(h.store.get('engage', `${S}.giveaway.1`).entries.length, 10_000);
});

test('ending a giveaway early still announces when the first post fails', async () => {
  const h = await make();
  await h.slash('giveaway', '1d 1 Prize', { user: IDS.mod });
  const card = giveCard(h);
  await enter(h, card, IDS.member);
  h.fake.fail('POST', new RegExp(`^/channels/${G}/messages$`), { status: 500, error: 'Server hiccup', times: 1 });
  const ans = await h.slash('giveaway', 'end 1', { user: IDS.mod });
  assert.match(lastText(h, ans), /try again in a minute/);
  assert.equal(h.store.get('engage', `${S}.giveaway.1`).ended, true);
  assert.ok(!h.sent(G).some((m) => /Congratulations/.test(m.content || '')));
  await h.advance(2 * MIN);
  await settle();
  const posts = h.sent(G).filter((m) => /Congratulations/.test(m.content || ''));
  assert.equal(posts.length, 1);
  assert.match(posts[0].content, new RegExp(IDS.member));
  await h.advance(DAY);
  await settle();
  assert.equal(h.sent(G).filter((m) => /Congratulations/.test(m.content || '')).length, 1);
});

test('long voter lists and long running lists are shortened without cutting a mention in half', async () => {
  const h = await make();
  const opts = Array.from({ length: 10 }, (_, i) => `Option ${i} ${'x'.repeat(60)}`);
  await h.slash('poll', `Big one? | ${opts.join(' | ')}`, { user: IDS.member });
  const card = pollCard(h);
  const votes = {};
  for (let i = 0; i < 300; i++) votes[`b0000000-0000-4000-8000-${String(i).padStart(12, '0')}`] = [i % 10];
  h.store.update('engage', `${S}.poll.1`, (p) => ({ ...p, votes }));
  const btn = buttonsOf(card).find((b) => b.custom_id.includes(':voters:'));
  const ans = await h.click(btn.custom_id, { user: IDS.member2, messageId: card.id });
  const body = ans.at(-1).embeds?.[0]?.description || h.textOf(ans.at(-1));
  assert.ok(body.length <= 4000, `body is ${body.length}`);
  assert.ok(!/<@[^>]*$/m.test(body), 'no half mention');
  assert.match(body, /and \d+ more/);
  const items = [];
  for (let i = 1; i <= 20; i++) {
    items.push(i);
    h.store.set('engage', `${S}.poll.${i}`, { id: i, serverId: S, channelId: G, messageId: null, question: `Question number ${i} ${'y'.repeat(50)}`, options: ['A', 'B'], votes: {}, createdBy: IDS.member, createdAt: h.now(), endsAt: h.now() + HOUR, ended: false });
  }
  h.store.set('engage', S, { seqs: { poll: 20, giveaway: 0 }, poll: items, giveaway: [] });
  const list = await h.slash('poll', 'list', { user: IDS.member });
  const field = list.at(-1).embeds[0].fields[0].value;
  assert.ok(field.length <= 1024);
  assert.match(field, /…and \d+ more$/);
  assert.ok(!/<#[^>]*$/m.test(field));
});
