import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, IDS } from '../harness.js';
import { webAction } from '../../apps/clans.js';
import { GLOBAL_KEY } from '../../engine/global.js';

const make = () => createHarness({ apps: ['economy', 'levels', 'clans'], fakeClock: true });
const clans = (h) => h.engine.service('clans');
const fund = (h, uid, n) => h.engine.service('economy').add(GLOBAL_KEY, uid, n, 'Test funds');

test('clan commands write a feed of events the website turns into notifications', async () => {
  const h = await make();
  fund(h, IDS.member, 600);
  await h.slash('clan', 'create Night Owls OWL', { user: IDS.member });
  await h.slash('clan', `invite ${IDS.member2}`, { user: IDS.member });
  await h.slash('clan', 'accept OWL', { user: IDS.member2 });
  await h.slash('clan', `invite ${IDS.admin}`, { user: IDS.member });
  await h.slash('clan', 'decline OWL', { user: IDS.admin });
  await h.slash('clan', `leader ${IDS.member2}`, { user: IDS.member });
  await h.slash('clan', `kick ${IDS.member}`, { user: IDS.member2 });
  await h.slash('clan', 'join OWL', { user: IDS.mod });
  await h.slash('clan', 'leave', { user: IDS.mod });
  await h.slash('clan', 'disband', { user: IDS.member2 });
  const close = h.findButton('Close the clan');
  await h.click(close.custom_id, { user: IDS.member2, messageId: close.messageId });
  const feed = clans(h).feed();
  assert.ok(feed.id);
  assert.deepEqual(feed.events.map((e) => [e.kind, e.user || null]), [
    ['invite', IDS.member2],
    ['joined', IDS.member2],
    ['invite', IDS.admin],
    ['declined', IDS.admin],
    ['leader', IDS.member2],
    ['kicked', IDS.member],
    ['joined', IDS.mod],
    ['left', IDS.mod],
    ['disbanded', null],
  ]);
  assert.ok(feed.events.every((e, i) => e.seq === i + 1 && e.tag === 'OWL' && e.name === 'Night Owls'));
  assert.equal(feed.events[3].leader, IDS.member);
  assert.equal(feed.events[7].leader, IDS.member2);
  assert.deepEqual(feed.events[8].members, [IDS.member2]);
});

test('the directory carries the bank, upgrades, top depositors and live invites for the website', async () => {
  const h = await make();
  fund(h, IDS.member, 3000);
  await h.slash('clan', 'create Night Owls OWL', { user: IDS.member });
  await h.slash('clan', 'deposit 1000', { user: IDS.member });
  await h.slash('clan', `invite ${IDS.member2}`, { user: IDS.member });
  const [c] = clans(h).directory();
  assert.equal(c.bank, 1000);
  assert.equal(c.style, false);
  assert.deepEqual(c.deposits, { [IDS.member]: 1000 });
  assert.deepEqual(c.invites.map((x) => [x.user, x.by]), [[IDS.member2, IDS.member]]);
  await h.advance(8 * 86_400_000);
  assert.deepEqual(clans(h).directory()[0].invites, [], 'old invites are not sent');
  assert.equal(clans(h).settings().createCost, 500);
  assert.equal(clans(h).settings().default, true);
});

test('website actions reuse every bot check and report plain messages', async () => {
  const h = await make();
  fund(h, IDS.member, 600);
  const made = await webAction(h.engine, IDS.member, 'create', null, { name: 'Night Owls', tag: 'OWL' });
  assert.deepEqual(made, { ok: true, code: 'done', message: 'You founded [OWL] Night Owls!' });
  const id = clans(h).of(IDS.member).id;
  const look = await webAction(h.engine, IDS.member, 'tag', id, { tag: '0WL' });
  assert.equal(look.ok, true, 'your own look-alike tag is fine');
  fund(h, IDS.member2, 600);
  const taken = await webAction(h.engine, IDS.member2, 'create', null, { name: 'Other', tag: 'OWL' });
  assert.equal(taken.ok, false);
  assert.match(taken.message, /taken/);
  assert.doesNotMatch(taken.message, /\*\*|`|<@/);
  const locked = await webAction(h.engine, IDS.member, 'colour', id, { colour: 'teal' });
  assert.equal(locked.ok, false);
  assert.match(locked.message, /Unlock it first/);
  const shy = await webAction(h.engine, IDS.member2, 'tag', null, { tag: 'NEW' });
  assert.equal(shy.code, 'no_clan');
  const upper = await webAction(h.engine, IDS.member.toUpperCase(), 'privacy', id, { mode: 'invite' });
  assert.equal(upper.ok, true, 'ids are matched without caring about case');
  assert.equal(clans(h).get(id).join, 'invite');
  assert.equal((await webAction(h.engine, IDS.bot, 'leave', null, {})).code, 'bot');
});

test('once someone has had their invite DMs for the day, repeat invites do not flood their inbox or skip the hourly invite limit', async () => {
  const h = await make();
  const leaders = [[IDS.member, 'Night Owls', 'OWL'], [IDS.member2, 'Red Foxes', 'FOX'], [IDS.mod, 'Blue Jays', 'JAY'], [IDS.owner, 'Green Frogs', 'FRG']];
  for (const [uid, name, tag] of leaders) {
    fund(h, uid, 600);
    await h.slash('clan', `create ${name} ${tag}`, { user: uid });
  }
  for (const [uid] of leaders.slice(0, 3)) await h.slash('clan', `invite ${IDS.admin}`, { user: uid });
  const notes = () => clans(h).feed().events.filter((e) => e.kind === 'invite' && e.user === IDS.admin).length;
  assert.equal(notes(), 3);
  for (let i = 0; i < 15; i++) await webAction(h.engine, IDS.owner, 'invite', null, { target: IDS.admin });
  assert.equal(notes(), 4, 'one note for the new invite, not one per click');
});
