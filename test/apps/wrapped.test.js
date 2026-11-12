import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, IDS, settle, eventStamp } from '../harness.js';
import { readMonth, flush, personality, monthKey, shiftMonth } from '../../apps/wrapped.js';
import { runBeforeExit } from '../../engine/storage.js';

const S = IDS.server;
const G = IDS.channels.general;
const NEWS = IDS.channels.news;
const MODLOG = IDS.channels.modlog;
const OTHER_BOT = 'b0000000-0000-4000-8000-0000000000b2';
const NOV = '2026-11';
const make = (opts = {}) => createHarness({ apps: ['wrapped'], fakeClock: true, ...opts });
const lastText = (h, ans) => h.textOf(ans[ans.length - 1]);

let evSeq = 900000;
async function reactTo(h, messageId, emoji, { user, author, channel = G }) {
  await h.bot.handle({ id: ++evSeq, type: 'reaction_add', data: { message_id: messageId, channel_id: channel, server_id: S, user_id: user, username: 'x', emoji, message_author_id: author }, created_at: eventStamp() });
  await settle();
}

async function unreact(h, messageId, emoji, { user, author, channel = G }) {
  await h.bot.handle({ id: ++evSeq, type: 'reaction_remove', data: { message_id: messageId, channel_id: channel, server_id: S, user_id: user, username: 'x', emoji, message_author_id: author }, created_at: eventStamp() });
  await settle();
}

async function say(h, n, opts) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(await h.message(`hello there ${i}`, opts));
  return out;
}

test('wrapped: counts messages, channels, hours, reactions and voice, and ignores bots', async () => {
  const h = await make();
  const [first] = await say(h, 3, { user: IDS.member });
  await say(h, 1, { user: IDS.member, channel: NEWS });
  await say(h, 1, { user: IDS.member2 });
  await h.message('beep boop', { user: OTHER_BOT, authorBot: true });
  await h.message('I am the bot', { user: IDS.bot });
  await reactTo(h, first.id, '🔥', { user: IDS.member2, author: IDS.member });
  await reactTo(h, first.id, '🔥', { user: IDS.mod, author: IDS.member });
  await reactTo(h, first.id, '😂', { user: IDS.member, author: IDS.member });
  await reactTo(h, first.id, '🔥', { user: IDS.bot, author: IDS.member });
  await h.voiceJoin(IDS.member);
  h.clock.t += 30 * 60_000;
  await h.voiceLeave(IDS.member);

  const m = readMonth(h.engine, S, NOV);
  assert.equal(m.msgs, 5);
  assert.equal(m.ch[G], 4);
  assert.equal(m.ch[NEWS], 1);
  assert.equal(m.hours[12], 5);
  assert.equal(m.dow[6], 5);
  const u = m.users[IDS.member];
  assert.equal(u.m, 4);
  assert.deepEqual(u.d, [7]);
  assert.equal(u.rr, 2, 'own reaction and the bot do not count as received');
  assert.equal(u.rg, 1);
  assert.equal(u.vs, 1800);
  assert.equal(m.users[IDS.member2].m, 1);
  assert.equal(m.users[IDS.member2].rg, 1);
  assert.equal(m.users[IDS.bot], undefined);
  assert.equal(m.emojis['🔥'], 2);
  assert.equal(m.reacted[first.id].n, 2);
  assert.equal(m.vs, 1800);

  flush(h.engine, S);
  const saved = h.store.get('wrapped', S);
  assert.ok(saved.months[NOV]);
  assert.ok(!JSON.stringify(saved).includes('hello there'), 'message text is never stored');
});

test('wrapped: personal card shows the numbers, rank and a personality, and is a public reply', async () => {
  const h = await make();
  const msgs = await say(h, 12, { user: IDS.member });
  await say(h, 2, { user: IDS.member2 });
  await reactTo(h, msgs[0].id, '🎉', { user: IDS.member, author: IDS.member2 });
  const ans = await h.slash('wrapped', '', { user: IDS.member });
  const a = ans[ans.length - 1];
  assert.equal(a.type, 'reply', 'public so people can share it');
  const text = h.textOf(a);
  assert.match(text, /sam's Wrapped · November 2026/i);
  assert.match(text, /\*\*12\*\* · #1 of 2/);
  assert.match(text, new RegExp(`<#${G}>`));
  assert.match(text, /12:00 UTC/);
  assert.match(text, /Chatterbox/);
  assert.match(text, /1 given · 0 received/);
  assert.match(text, /🎉 × 1/);
  assert.ok(h.findButton('Server Wrapped', a));
  assert.ok(h.findButton('Last month', a));

  const other = await h.slash('wrapped', '@riley', { user: IDS.member });
  assert.match(lastText(h, other), /riley's Wrapped/i);
  assert.match(lastText(h, other), /#2 of 2/);

  const none = await h.slash('wrapped', '', { user: IDS.mod });
  assert.match(lastText(h, none), /Nothing to wrap yet/);
  const last = await h.slash('wrapped', 'last', { user: IDS.member });
  assert.match(lastText(h, last), /No recap for October 2026/);
  const bad = await h.slash('wrapped', 'zzzzqqq', { user: IDS.member });
  assert.match(lastText(h, bad), /couldn't find that member/);
});

test('wrapped: personality rules are deterministic', () => {
  const base = { m: 0, ch: {}, h: {}, d: [], rg: 0, rr: 0, vs: 0, e: {} };
  const hist = (h, n) => { const a = Array(24).fill(0); a[h] = n; return a; };
  assert.equal(personality({ u: { ...base, m: 2 }, rank: 5, localHist: hist(12, 2), daysSoFar: 10 }).title, 'Lurker');
  assert.equal(personality({ u: { ...base, m: 50 }, rank: 2, localHist: hist(2, 50), daysSoFar: 10 }).title, 'Chatterbox');
  assert.equal(personality({ u: { ...base, m: 20 }, rank: 6, localHist: hist(2, 20), daysSoFar: 10 }).title, 'Night Owl');
  assert.equal(personality({ u: { ...base, m: 20 }, rank: 6, localHist: hist(7, 20), daysSoFar: 10 }).title, 'Early Bird');
  assert.equal(personality({ u: { ...base, m: 10, rr: 30 }, rank: 6, localHist: hist(14, 10), daysSoFar: 10 }).title, 'Hype Machine');
  assert.equal(personality({ u: { ...base, m: 6, rg: 20 }, rank: 6, localHist: hist(14, 6), daysSoFar: 10 }).title, 'Reactor');
  assert.equal(personality({ u: { ...base, m: 6, vs: 3 * 3600 }, rank: 6, localHist: hist(14, 6), daysSoFar: 10 }).title, 'Voice Regular');
  assert.equal(personality({ u: { ...base, m: 8, d: [1, 2, 3, 4, 5, 6, 7] }, rank: 6, localHist: hist(14, 8), daysSoFar: 10 }).title, 'Steady');
  assert.equal(personality({ u: { ...base, m: 8, d: [1] }, rank: 6, localHist: hist(14, 8), daysSoFar: 10 }).title, 'Good Vibes');
});

test('wrapped: most active hour uses the member time zone from Pocket when there is one', async () => {
  const h = await make();
  h.engine.services.set('pocket', { timeZone: () => 'Asia/Tokyo' });
  await say(h, 3, { user: IDS.member });
  const ans = await h.slash('wrapped', '', { user: IDS.member });
  assert.match(lastText(h, ans), /21:00 \(Asia\/Tokyo\)/);
});

test('wrapped: server card ranks the top chatters, channels, emojis and member of the month', async () => {
  const h = await make();
  const [m1] = await say(h, 5, { user: IDS.member2 });
  await say(h, 3, { user: IDS.member });
  await say(h, 1, { user: IDS.mod, channel: NEWS });
  await reactTo(h, m1.id, '🔥', { user: IDS.member, author: IDS.member2 });
  const ans = await h.slash('wrapped', 'server', { user: IDS.member });
  const a = ans[ans.length - 1];
  assert.equal(a.type, 'reply');
  const text = h.textOf(a);
  assert.match(text, /Test Town Wrapped · November 2026/);
  assert.match(text, /\*\*9\*\*/);
  const top = a.embeds[0].fields.find((f) => /Top chatters/.test(f.name)).value;
  assert.ok(top.indexOf(IDS.member2) < top.indexOf(IDS.member), 'most messages first');
  assert.ok(top.indexOf(IDS.member) < top.indexOf(IDS.mod));
  assert.match(text, new RegExp(`<#${G}> · 8`));
  assert.match(text, /🔥 1/);
  assert.match(text, /Saturdays/);
  assert.match(text, new RegExp(`Member of the month[\\s\\S]*<@${IDS.member2}>`));
  assert.match(text, /1 reaction · \[jump to it\]/);
  const viaYap = await h.slash('yap', 'recap server', { user: IDS.member });
  assert.match(lastText(h, viaYap), /Test Town Wrapped/);
});

test('wrapped: buttons toggle months for the opener and show others their own view', async () => {
  const h = await make();
  await say(h, 4, { user: IDS.member });
  const ans = await h.slash('wrapped', '', { user: IDS.member });
  const card = ans[ans.length - 1];
  const toggle = h.findButton('Last month', card);
  const mine = await h.click(toggle.custom_id, { user: IDS.member, messageId: card.message?.id });
  assert.equal(mine[0].type, 'update');
  assert.match(h.textOf(mine[0]), /October 2026/);
  const theirs = await h.click(toggle.custom_id, { user: IDS.member2, messageId: card.message?.id });
  assert.equal(theirs[0].type, 'ephemeral');
  assert.match(h.textOf(theirs[0]), /sam's Wrapped · October 2026/i);
  const srv = await h.click(h.findButton('Server Wrapped', card).custom_id, { user: IDS.member2, messageId: card.message?.id });
  assert.equal(srv[0].type, 'ephemeral');
  assert.match(h.textOf(srv[0]), /Test Town Wrapped · November 2026/);
});

test('wrapped: a new month keeps the old one as last month and prunes anything older', async () => {
  const h = await make();
  await say(h, 2, { user: IDS.member });
  h.clock.t = Date.parse('2026-12-03T10:00:00Z');
  await say(h, 1, { user: IDS.member });
  assert.equal(readMonth(h.engine, S, NOV).users[IDS.member].m, 2);
  assert.equal(readMonth(h.engine, S, '2026-12').users[IDS.member].m, 1);
  const last = await h.slash('wrapped', 'last', { user: IDS.member });
  assert.match(lastText(h, last), /November 2026/);
  assert.match(lastText(h, last), /\*\*2\*\*/);

  h.clock.t = Date.parse('2027-01-02T10:00:00Z');
  await say(h, 1, { user: IDS.member });
  flush(h.engine, S);
  assert.deepEqual(Object.keys(h.store.get('wrapped', S).months).sort(), ['2026-12', '2027-01']);
  assert.equal(readMonth(h.engine, S, NOV), null);
  assert.equal(shiftMonth('2027-01', -1), '2026-12');
  assert.equal(monthKey(Date.parse('2027-01-31T23:59:59Z')), '2027-01');
});

test('wrapped: /wrapped post is admin only, schedules a monthly job and posts the server card', async () => {
  const h = await make();
  const denied = await h.slash('wrapped', 'post #announcements', { user: IDS.member });
  assert.match(lastText(h, denied), /Admin/i);
  assert.equal(h.engine.scheduler.list({ kind: 'wrapped.post', serverId: S }).length, 0);

  const on = await h.slash('wrapped', 'post #announcements', { user: IDS.admin });
  assert.match(lastText(h, on), /Monthly Wrapped is on/);
  assert.equal(h.engine.settings.appConfig(S, 'wrapped').postChannelId, NEWS);
  const jobs = h.engine.scheduler.list({ kind: 'wrapped.post', serverId: S });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].at, Date.parse('2026-12-01T12:00:00Z'));

  await say(h, 3, { user: IDS.member2 });
  await say(h, 1, { user: IDS.member });
  assert.equal(h.sent(NEWS).length, 0);
  await h.advanceTo(Date.parse('2026-12-01T12:00:05Z'));
  const posts = h.sent(NEWS);
  assert.equal(posts.length, 1);
  const text = h.textOf(posts[0]);
  assert.match(text, /November 2026 Wrapped/);
  assert.match(text, new RegExp(`🥇 <@${IDS.member2}> · 3`));
  assert.ok(h.findButton('My Wrapped', posts[0]));
  assert.equal(h.engine.scheduler.list({ kind: 'wrapped.post', serverId: S })[0].at, Date.parse('2027-01-01T12:00:00Z'));

  const off = await h.slash('wrapped', 'post off', { user: IDS.admin });
  assert.match(lastText(h, off), /Monthly post is off/);
  assert.equal(h.engine.scheduler.list({ kind: 'wrapped.post', serverId: S }).length, 0);
  assert.ok(h.bot.commands.get('wrapped').description.length <= 100);
});

test('wrapped: starboard hits show on the card when the starboard has posts', async () => {
  const h = await make();
  await say(h, 2, { user: IDS.member });
  h.store.set('starboard', `${S}.posts`, { x1: { starId: 's', authorId: IDS.member, at: h.clock.t, count: 4 }, x2: { starId: 't', authorId: IDS.member, at: Date.parse('2026-09-01T00:00:00Z'), count: 3 } });
  const ans = await h.slash('wrapped', '', { user: IDS.member });
  assert.match(lastText(h, ans), /1 post made it/);
});

test('wrapped: private channels never count and never show on the cards', async () => {
  const h = await make();
  h.fake.state.overrides[`${NEWS}:everyone`] = { allow: [], deny: ['view_channel'] };
  const [pub] = await say(h, 2, { user: IDS.member });
  const [secret] = await say(h, 3, { user: IDS.member, channel: MODLOG });
  await say(h, 2, { user: IDS.member2, channel: NEWS });
  await reactTo(h, secret.id, '🤫', { user: IDS.member2, author: IDS.member, channel: MODLOG });
  await reactTo(h, pub.id, '🔥', { user: IDS.member2, author: IDS.member });

  const m = readMonth(h.engine, S, NOV);
  assert.equal(m.msgs, 2);
  assert.equal(m.ch[MODLOG], undefined);
  assert.equal(m.ch[NEWS], undefined);
  assert.equal(m.users[IDS.member].m, 2);
  assert.equal(m.users[IDS.member].ch[MODLOG], undefined);
  assert.equal(m.users[IDS.member2].m, 0);
  assert.equal(m.users[IDS.member2].rg, 1);
  assert.equal(m.users[IDS.member].rr, 1);
  assert.equal(m.emojis['🤫'], undefined);
  assert.equal(m.reacted[secret.id], undefined);

  flush(h.engine, S);
  const doc = h.store.get('wrapped', S);
  doc.months[NOV].ch[MODLOG] = 50;
  doc.months[NOV].users[IDS.member].ch[MODLOG] = 50;
  doc.months[NOV].reacted[secret.id] = { n: 9, c: MODLOG, a: IDS.member };
  h.store.set('wrapped', S, doc);

  const srv = lastText(h, await h.slash('wrapped', 'server', { user: IDS.member }));
  assert.ok(!srv.includes(MODLOG), 'old data from a private channel stays hidden');
  assert.ok(!srv.includes(secret.id));
  assert.match(srv, new RegExp(`<#${G}> · 2`));
  assert.match(srv, /1 reaction · \[jump to it\]/);
  assert.ok(srv.includes(pub.id));
  const mine = lastText(h, await h.slash('wrapped', '', { user: IDS.member }));
  assert.ok(!mine.includes(MODLOG));
  assert.match(mine, new RegExp(`<#${G}> \\(2\\)`));
});

test('wrapped: the same reaction counts once and removing it takes it back', async () => {
  const h = await make();
  const [msg] = await say(h, 1, { user: IDS.member });
  for (let i = 0; i < 5; i++) await reactTo(h, msg.id, '🔥', { user: IDS.member2, author: IDS.member });
  let m = readMonth(h.engine, S, NOV);
  assert.equal(m.emojis['🔥'], 1);
  assert.equal(m.users[IDS.member2].rg, 1);
  assert.equal(m.users[IDS.member2].e['🔥'], 1);
  assert.equal(m.users[IDS.member].rr, 1);
  assert.equal(m.reacted[msg.id].n, 1);

  await unreact(h, msg.id, '🔥', { user: IDS.member2, author: IDS.member });
  await unreact(h, msg.id, '🔥', { user: IDS.member2, author: IDS.member });
  await unreact(h, msg.id, '🔥', { user: IDS.mod, author: IDS.member });
  m = readMonth(h.engine, S, NOV);
  assert.equal(m.emojis['🔥'] ?? 0, 0);
  assert.equal(m.users[IDS.member2].rg, 0);
  assert.equal(m.users[IDS.member].rr, 0);
  assert.equal(m.reacted[msg.id], undefined);

  for (let i = 0; i < 3; i++) {
    await reactTo(h, msg.id, '🔥', { user: IDS.member2, author: IDS.member });
    await unreact(h, msg.id, '🔥', { user: IDS.member2, author: IDS.member });
  }
  await reactTo(h, msg.id, '🔥', { user: IDS.member2, author: IDS.member });
  await reactTo(h, msg.id, '😂', { user: IDS.member2, author: IDS.member });
  m = readMonth(h.engine, S, NOV);
  assert.equal(m.users[IDS.member2].rg, 2);
  assert.equal(m.users[IDS.member].rr, 2);
  assert.equal(m.reacted[msg.id].n, 2);
});

test('wrapped: other bots are never counted or named member of the month', async () => {
  const h = await make();
  const SNEAKY = 'b0000000-0000-4000-8000-0000000000b3';
  h.fake.state.members[S].push({ id: SNEAKY, username: 'sneaky', display_name: 'Sneaky', nickname: null, roles: [], joined_at: '2026-01-08T00:00:00Z', bot: true });
  h.fake.state.members[S].push({ id: OTHER_BOT, username: 'helper', display_name: 'Helper', nickname: null, roles: [], joined_at: '2026-01-08T00:00:00Z', is_bot: true });
  const [msg] = await say(h, 1, { user: IDS.member });
  await h.message('beep', { user: OTHER_BOT, authorBot: true });
  await reactTo(h, msg.id, '🤖', { user: OTHER_BOT, author: IDS.member });
  await reactTo(h, 'm-from-bot', '👍', { user: IDS.member, author: OTHER_BOT });
  for (const e of ['😀', '😁', '😂', '🤣', '😃']) await reactTo(h, 'm-by-riley', e, { user: IDS.member, author: IDS.member2 });
  await say(h, 6, { user: SNEAKY });

  const m = readMonth(h.engine, S, NOV);
  assert.equal(m.users[OTHER_BOT], undefined);
  assert.equal(m.emojis['🤖'], undefined);
  assert.equal(m.users[IDS.member].rr, 0);
  assert.equal(m.reacted['m-from-bot'], undefined);
  assert.equal(m.users[IDS.member2].rr, 5);
  assert.equal(m.users[IDS.member2].m, 0);

  const a = (await h.slash('wrapped', 'server', { user: IDS.member })).pop();
  const mom = a.embeds[0].fields.find((f) => /Member of the month/.test(f.name)).value;
  assert.ok(mom.includes(IDS.member), 'skips the bot and the member with no messages');
  const top = a.embeds[0].fields.find((f) => /Top chatters/.test(f.name)).value;
  assert.ok(!top.includes(SNEAKY));
  assert.ok(!h.textOf(a).includes(OTHER_BOT));

  const RADIO = 'b0000000-0000-4000-8000-0000000000b4';
  h.fake.state.members[S].push({ id: RADIO, username: 'radio', display_name: 'Radio', nickname: null, roles: [], joined_at: '2026-01-08T00:00:00Z', bot: true });
  await h.voiceJoin(RADIO);
  await settle();
  h.clock.t += 60 * 60_000;
  await h.voiceLeave(RADIO);
  const after = readMonth(h.engine, S, NOV);
  assert.equal(after.users[RADIO]?.vs || 0, 0, 'a bot sitting in voice adds no voice time');
  assert.equal(after.vs || 0, 0);
});

test('wrapped: open voice sessions and buffered counts survive a restart', async () => {
  const h1 = await make();
  await h1.voiceJoin(IDS.member);
  await say(h1, 2, { user: IDS.member });
  assert.ok(runBeforeExit(h1.store) >= 1);
  assert.equal(h1.store.get('wrapped', S).months[NOV].users[IDS.member].m, 2, 'the exit hook saves the buffer');

  const h2 = await make({ store: h1.store });
  h2.clock.t = h1.clock.t + 45 * 60_000;
  await h2.voiceLeave(IDS.member);
  const m = readMonth(h2.engine, S, NOV);
  assert.equal(m.users[IDS.member].vs, 2700);
  assert.equal(m.users[IDS.member].m, 2);
  assert.equal(h2.store.get('wrapped', `${S}.voice`, null), null);
});

test('wrapped: monthly post config is only saved once the job is scheduled', async () => {
  const h = await make();
  const orig = h.engine.scheduler.schedule;
  h.engine.scheduler.schedule = () => { throw new Error('disk full'); };
  const r = await h.slash('wrapped', 'post #announcements', { user: IDS.admin });
  assert.match(lastText(h, r), /couldn't schedule/);
  assert.equal(h.engine.settings.appConfig(S, 'wrapped').postChannelId, null);
  h.engine.scheduler.schedule = orig;

  await h.slash('wrapped', 'post #announcements', { user: IDS.admin });
  h.engine.scheduler.cancelWhere({ kind: 'wrapped.post', serverId: S });
  const st = await h.slash('wrapped', 'post', { user: IDS.admin });
  assert.match(lastText(h, st), /It is off right now/);
  assert.match(lastText(h, st), /\/wrapped post #channel/);
});

test('wrapped: a late event from last month never wipes the current month', async () => {
  const h = await make();
  h.clock.t = Date.parse('2026-12-01T00:30:00Z');
  await say(h, 2, { user: IDS.member });
  await h.bot.handle({ id: ++evSeq, type: 'message', data: { id: 'm-late-1', channel_id: G, server_id: S, author_id: IDS.member2, author: { id: IDS.member2, username: 'riley' }, content: 'late', created_at: '2026-11-30T23:50:00.000Z' }, created_at: eventStamp() });
  await settle();
  assert.equal(readMonth(h.engine, S, '2026-12').users[IDS.member].m, 2);
  assert.equal(readMonth(h.engine, S, NOV).users[IDS.member2].m, 1);
});
