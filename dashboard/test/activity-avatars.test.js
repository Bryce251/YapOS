import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { configureProfiles, resetProfiles, rememberProfiles, profileOf, profileAvatar, pickAvatar, reportBrokenAvatar, OWN_AVATAR, HEAL_ENDPOINT, HEAL_MAX } from '../web/activity/js/profiles.js';
import { safeAvatar, person } from '../web/activity/js/players.js';
import { cleanUser } from '../web/activity/js/account.js';
import { cleanCard } from '../web/activity/js/ui/profilecard.js';
import { readBoard } from '../web/activity/js/ui/leaderboard.js';

const A = '11111111-1111-4111-8111-aaaaaaaaaaaa';
const OWN = '/avatar-img/a-abcdefghij-0123456789abcdef.gif';
const OWN_STILL = '/avatar-img/a-abcdefghij-fedcba9876543210-still.webp';
const YAPIN = 'https://files.yapper.website/avatars/u1/r2-1-a.png';

function win(reduce = false) {
  return { location: { href: 'https://yapos.dev/activity/' }, matchMedia: (q) => ({ matches: reduce && q.includes('reduce') }), dispatchEvent() {}, CustomEvent: class { constructor(type) { this.type = type; } } };
}

test('Party accepts only exact uploaded picture paths besides the Yapin hosts', () => {
  resetProfiles();
  configureProfiles({ win: win() });
  assert.equal(profileAvatar(OWN), OWN);
  assert.equal(profileAvatar(`https://yapos.dev${OWN}`), OWN, 'a same-site link becomes the plain path');
  assert.equal(profileAvatar(`https://evil.example${OWN}`), null);
  assert.equal(profileAvatar('/avatar-img/../../x.png'), null);
  assert.equal(profileAvatar('/avatar-img/a-abcdefghij-0123456789abcdef.svg'), null);
  assert.equal(profileAvatar(YAPIN), YAPIN);
  assert.equal(safeAvatar(OWN_STILL), OWN_STILL);
  assert.equal(safeAvatar('/avatar-img/a-abcdefghij-0123456789abcdef.png?x'), null);
  assert.ok(OWN_AVATAR.test(OWN));
  assert.equal(cleanUser({ id: A, username: 'bea', avatar_url: OWN, avatar_still: OWN_STILL }).avatar_url, OWN);
  assert.equal(cleanUser({ id: A, username: 'bea', avatar_url: OWN, avatar_still: OWN_STILL }).avatar_still, OWN_STILL);
  assert.equal(cleanUser({ id: A, username: 'bea', avatar_url: 'javascript:alert(1)' }).avatar_url, null);
  resetProfiles();
});

test('moving pictures keep moving in Party, and people who prefer less motion get the still', () => {
  resetProfiles();
  configureProfiles({ win: win(false) });
  rememberProfiles([{ id: A, username: 'bea', display_name: 'Bea', avatar: OWN, avatarStill: OWN_STILL }]);
  assert.equal(profileOf(A).avatar, OWN);
  assert.equal(person({ id: A, name: 'Bea' }).avatar, OWN);
  resetProfiles();
  configureProfiles({ win: win(true) });
  rememberProfiles([{ id: A, username: 'bea', display_name: 'Bea', avatar: OWN, avatarStill: OWN_STILL }]);
  assert.equal(profileOf(A).avatar, OWN_STILL);
  assert.equal(pickAvatar({ avatar: YAPIN, avatarStill: 'https://evil.example/x.png' }, true), YAPIN, 'a bad still is ignored');
  resetProfiles();
});

test('the Party card plays the moving picture, shows the still for reduced motion, and the leaderboard uses the still', () => {
  const card = cleanCard({ name: 'Bea', avatar: OWN, avatarStill: OWN_STILL, level: 2 });
  assert.equal(card.avatar, OWN);
  assert.equal(card.avatarStill, OWN_STILL);
  assert.equal(cleanCard({ hidden: true, name: 'Bea', avatar: OWN, avatarStill: OWN_STILL }).avatarStill, OWN_STILL);
  assert.equal(cleanCard({ name: 'Bea', avatar: 'https://evil.example/a.gif' }).avatar, null);
  const board = readBoard({ rows: [{ id: A, name: 'Bea', avatar: OWN, avatarStill: OWN_STILL, value: 5 }, { id: 'b', name: 'Cat', avatar: YAPIN, value: 3 }] });
  assert.equal(board.rows[0].avatar, OWN_STILL);
  assert.equal(board.rows[1].avatar, YAPIN);
  const src = readFileSync(new URL('../web/activity/js/ui/profilecard.js', import.meta.url), 'utf8');
  assert.match(src, /card\.avatarStill && !motionOk\(win\)/, 'the hero picture checks the motion setting');
});

test('a broken Yapin picture in Party shows initials, is forgotten and reported once in batches', async () => {
  resetProfiles();
  const posts = [];
  const queue = [];
  configureProfiles({ win: win(), fetch: async (url, init) => posts.push({ url, body: JSON.parse(init.body) }), setTimeout: (fn) => queue.push(fn) });
  rememberProfiles([{ id: A, username: 'bea', display_name: 'Bea', avatar: YAPIN }]);
  assert.equal(reportBrokenAvatar(A, YAPIN), true);
  assert.equal(profileOf(A).avatar, null, 'initials show at once');
  assert.equal(reportBrokenAvatar(A, YAPIN), false, 'only once');
  assert.equal(reportBrokenAvatar('b1', OWN), false, 'uploaded pictures are not Yapin pictures');
  for (let i = 0; i < 12; i++) reportBrokenAvatar(`p${i}`, YAPIN);
  while (queue.length) await queue.shift()();
  assert.equal(posts[0].url, HEAL_ENDPOINT);
  assert.equal(posts[0].body.ids.length, 10);
  assert.equal(posts[0].body.ids[0], A.toLowerCase());
  assert.equal(posts[1].body.ids.length, 3);
  for (let i = 0; i < HEAL_MAX; i++) reportBrokenAvatar(`q${i}`, YAPIN);
  assert.equal(reportBrokenAvatar('late', YAPIN), false, 'a session never reports more than its limit');
  rememberProfiles([{ id: A, username: 'bea', display_name: 'Bea', avatar: YAPIN }]);
  assert.equal(profileOf(A).avatar, null, 'the same broken link coming back from the server is not shown again');
  rememberProfiles([{ id: A, username: 'bea', display_name: 'Bea', avatar: 'https://files.yapper.website/avatars/u1/r2-2-b.png' }]);
  assert.equal(profileOf(A).avatar, 'https://files.yapper.website/avatars/u1/r2-2-b.png', 'a fresh picture shows straight away');
  resetProfiles();
});

test('the Party avatar reports broken pictures and the activity CSS did not grow', () => {
  const dom = readFileSync(new URL('../web/activity/js/ui/dom.js', import.meta.url), 'utf8');
  assert.match(dom, /reportBrokenAvatar\(uid, p\.avatar\)/);
  for (const f of ['activity.css', 'party.css', 'profilecard.css', 'leaderboard.css']) {
    const css = readFileSync(new URL(`../web/activity/css/${f}`, import.meta.url), 'utf8');
    assert.equal(/avatar-img|av-crop|avatar-pic/.test(css), false, `${f} needs no new rules for uploaded pictures`);
  }
});
