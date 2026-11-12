import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, IDS, settle } from '../harness.js';

const S = IDS.server;
const G = IDS.channels.general;
const BOARD = IDS.channels.news;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const lastText = (h, ans) => h.textOf(ans[ans.length - 1]);

async function make() {
  const h = await createHarness({ apps: ['starboard'] });
  h.engine.config.starboardSettleMs = 0;
  return h;
}

async function star(h, msgId, user, opts = {}) {
  await h.react(msgId, opts.emoji || '⭐', { user, channel: G, remove: !!opts.remove });
  await wait(5);
  await settle();
  await wait(5);
  await settle();
}

const boardPosts = (h) => h.sent(BOARD);

test('starboard: admins set it up, members only see how it works', async () => {
  const h = await make();
  assert.ok(h.bot.commands.get('starboard').description.length <= 100);
  const member = await h.slash('starboard', '#announcements');
  assert.match(lastText(h, member), /Admin/i);
  const info = await h.slash('starboard', '');
  assert.match(lastText(h, info), /hasn't set up a starboard/);
  const on = await h.slash('starboard', '#announcements', { user: IDS.admin });
  assert.match(lastText(h, on), /Starboard is on/);
  assert.equal(h.engine.settings.appConfig(S, 'starboard').channelId, BOARD);
  const n = await h.slash('starboard', '2', { user: IDS.admin });
  assert.match(lastText(h, n), /needs \*\*2\*\*/);
  const bad = await h.slash('starboard', 'emoji hello', { user: IDS.admin });
  assert.match(lastText(h, bad), /didn't work/);
  await h.slash('starboard', 'emoji 🌟', { user: IDS.admin });
  assert.equal(h.engine.settings.appConfig(S, 'starboard').emoji, '🌟');
});

test('starboard: a message that reaches the stars is posted once, with links, and the count updates', async () => {
  const h = await make();
  await h.slash('starboard', '#announcements', { user: IDS.admin });
  await h.message('this is the funniest thing ever', { user: IDS.member, attachment: 'aad5e2c5-f95e-4655-8cd8-5de16c1b8038/r2-1794-cat.png' });
  const msg = h.fake.state.messages[G].at(-1);

  await star(h, msg.id, IDS.member);
  await star(h, msg.id, IDS.member2);
  await star(h, msg.id, IDS.mod);
  assert.equal(boardPosts(h).length, 0, 'own star does not count, so only 2 of 3');

  await star(h, msg.id, IDS.admin);
  const posts = boardPosts(h);
  assert.equal(posts.length, 1);
  const post = posts[0];
  assert.match(post.content, /⭐ \*\*3\*\*/);
  const embed = post.embeds[0];
  assert.match(embed.description, /funniest thing/);
  assert.equal(embed.image.url, 'https://files.yapper.website/attachments/aad5e2c5-f95e-4655-8cd8-5de16c1b8038/r2-1794-cat.png');
  const link = `https://www.yapper.website/?server=${S}&channel=${G}&msg=${msg.id}`;
  assert.equal(embed.url, link);
  assert.equal(post.components[0].components[0].url, link);

  await star(h, msg.id, IDS.owner);
  await wait(20);
  assert.equal(boardPosts(h).length, 1, 'never posted twice');
  const edited = h.fake.state.messages[BOARD].find((m) => m.id === post.id);
  assert.match(edited.content, /\*\*4\*\*/);

  await star(h, msg.id, IDS.owner, { remove: true });
  await wait(1700);
  assert.match(h.fake.state.messages[BOARD].find((m) => m.id === post.id).content, /\*\*3\*\*/);
});

test('starboard: other emojis, the board channel itself and a missing channel are ignored', async () => {
  const h = await make();
  await h.message('hello', { user: IDS.member });
  const msg = h.fake.state.messages[G].at(-1);
  for (const u of [IDS.member2, IDS.mod, IDS.admin]) await star(h, msg.id, u);
  assert.equal(h.sent(BOARD).length, 0, 'not set up yet');
  await h.slash('starboard', '#announcements', { user: IDS.admin });
  for (const u of [IDS.member2, IDS.mod, IDS.admin]) await star(h, msg.id, u, { emoji: '👍' });
  assert.equal(boardPosts(h).length, 0);
  await star(h, msg.id, IDS.owner);
  assert.equal(boardPosts(h).length, 1, 'the earlier stars count once a star arrives after setup');
});
