import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, IDS } from '../harness.js';
import { cardView, embedView, bestSeason, badgeNames } from '../../apps/profile.js';
import { privacyOf, setPrivacy } from '../../engine/profile-data.js';
import { renderProfileCard, CARD_W, CARD_H } from '../../engine/profile-card.js';
import { mutateGlobal, SEASON_NS } from '../../engine/global.js';

const S = IDS.server;
const G = IDS.channels.general;

async function make(opts = {}) {
  const h = await createHarness({ apps: ['levels', 'economy', 'quests', 'profile'], fakeClock: true, ...opts });
  h.clock.t = Date.parse('2026-11-15T12:00:00Z');
  return h;
}

const pngSize = (buf) => ({ w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) });
const filesIn = (h) => h.sent(G).filter((m) => m.files?.length);

function baseData(over = {}) {
  return {
    id: IDS.member,
    level: { xp: 1200, level: 5, into: 100, need: 400, frac: 0.25 },
    shards: 777,
    privacy: { hidden: false, showShards: false },
    party: { games: 12, wins: 4, fav: 'draw', badges: ['first-game', 'games-10'] },
    season: [{ month: '2026-09', rank: 3, kind: 'shards' }, { month: '2026-10', rank: 1, kind: 'xp' }],
    quests: { done: 2, total: 3 },
    clan: { name: 'Night Owls', tag: 'OWL', colour: '#f1c40f' },
    achievements: ['msgs-10k', 'tickets-100'],
    ...over,
  };
}

test('profile: the card view keeps Shards private unless it is yours or you chose to show them', () => {
  const mine = cardView(baseData(), { name: 'Sam', username: 'sam', viewerIsOwner: true });
  assert.equal(mine.tiles[0].value, '777');
  const theirs = cardView(baseData(), { name: 'Sam', username: 'sam', viewerIsOwner: false });
  assert.equal(theirs.tiles[0].value, 'Private');
  const shown = cardView(baseData({ privacy: { hidden: false, showShards: true } }), { name: 'Sam', username: 'sam', viewerIsOwner: false });
  assert.equal(shown.tiles[0].value, '777');
  assert.equal(mine.tiles[1].value, '4 of 12');
  assert.equal(mine.tiles[2].value, '2 / 3');
  assert.equal(mine.tiles[3].value, '2');
  assert.equal(mine.accent, '#f1c40f');
  assert.match(mine.footer, /Best season: #1 XP · October 2026/);
  assert.match(mine.footer, /Badges: First game, Party regular/);
  assert.match(mine.footer, /Loves Draw & Guess/);
  assert.deepEqual(bestSeason([]), null);
  assert.deepEqual(badgeNames(['nope', 'wins-10']), ['🥇 Winner']);
});

test('profile: the embed fallback lists the same things', () => {
  const data = baseData();
  const view = cardView(data, { name: 'Sam', username: 'sam', viewerIsOwner: true });
  const e = embedView(data, view);
  const text = JSON.stringify(e);
  assert.match(text, /Level 5/);
  assert.match(text, /\[OWL\] Night Owls/);
  assert.match(text, /Party badges/);
  assert.match(text, /October 2026/);
});

test('profile: the card renders as a PNG', () => {
  const view = cardView(baseData(), { name: 'Sam 🎉 the Great', username: 'sam', viewerIsOwner: true });
  const png = renderProfileCard(view);
  assert.ok(Buffer.isBuffer(png));
  assert.deepEqual(pngSize(png), { w: CARD_W, h: CARD_H });
  assert.equal(renderProfileCard(view, { font: null }), null);
});

test('profile: /profile sends a picture card with a Privacy button for yourself', async () => {
  const h = await make();
  h.engine.service('levels').addXp(S, IDS.member, 600, 'test');
  const ans = await h.slash('profile', '', { user: IDS.member });
  const pics = filesIn(h);
  assert.equal(pics.length, 1, `answers: ${JSON.stringify(ans.map((a) => a.type))}`);
  assert.equal(pics[0].files[0].name, 'profile.png');
  assert.deepEqual(pngSize(pics[0].files[0].bytes), { w: CARD_W, h: CARD_H });
  assert.ok(h.findButton('Privacy', pics), 'Privacy button on your own card');
});

test('profile: someone else\'s card has no Privacy button and never their Shards', async () => {
  const h = await make();
  h.engine.service('economy').add(S, IDS.member2, 4321, 'test');
  await h.slash('profile', '@riley', { user: IDS.member });
  const pics = filesIn(h);
  assert.equal(pics.length, 1);
  assert.equal(h.findButton('Privacy', pics), null);
});

test('profile: when files are off it falls back to an embed card', async () => {
  const h = await make({ features: { files: false } });
  mutateGlobal(h.engine, SEASON_NS, (d) => { d.badges = { [IDS.member]: [{ month: '2026-10', kind: 'xp', rank: 2, score: 900 }] }; }, {});
  const ans = await h.slash('profile', '', { user: IDS.member });
  const all = [...ans, ...h.sent(G)];
  const text = all.map((a) => h.textOf(a)).join('\n');
  assert.match(text, /Level 0/);
  assert.match(text, /#2 XP · October 2026/);
  assert.equal(h.engine.caps.state(S, 'files'), false);
  const again = await h.slash('profile', '', { user: IDS.member });
  assert.match([...again, ...h.sent(G)].map((a) => h.textOf(a)).join('\n'), /Level 0/);
});

test('profile: a name that matches nobody gets a kind answer', async () => {
  const h = await make();
  const ans = await h.slash('profile', 'nobody-like-this', { user: IDS.member });
  assert.match(h.textOf(ans[ans.length - 1]), /couldn't find them/);
  const bot = await h.slash('profile', `<@${IDS.bot}>`, { user: IDS.member });
  assert.match(h.textOf(bot[bot.length - 1]), /don't have a profile/);
});

test('profile: /profile privacy toggles the public page and Shards, only for yourself', async () => {
  const h = await make();
  let ans = await h.slash('profile', 'privacy', { user: IDS.member });
  let text = [...ans, ...h.sent(G)].map((a) => h.textOf(a)).join('\n');
  assert.match(text, /Profile privacy/);
  assert.match(text, /never shows which servers/);
  const hide = h.findButton('Hide my profile');
  assert.ok(hide);
  ans = await h.click(hide.custom_id, { user: IDS.member2, messageId: hide.messageId });
  assert.equal(privacyOf(h.engine, IDS.member).hidden, false, 'someone else cannot press it');
  await h.click(hide.custom_id, { user: IDS.member, messageId: hide.messageId });
  assert.equal(privacyOf(h.engine, IDS.member).hidden, true);
  await h.slash('profile', 'shards on', { user: IDS.member });
  assert.equal(privacyOf(h.engine, IDS.member).showShards, true);
  await h.slash('profile', 'shards off', { user: IDS.member });
  assert.equal(privacyOf(h.engine, IDS.member).showShards, false);
  await h.slash('profile', 'show', { user: IDS.member });
  assert.equal(privacyOf(h.engine, IDS.member).hidden, false);
  setPrivacy(h.engine, IDS.member, { hidden: true });
  text = h.textOf((await h.slash('profile', 'privacy', { user: IDS.member })).pop());
  assert.ok(text.length > 0);
});
