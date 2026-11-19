import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkClanName, checkClanTag, parseClanColour, tagSkeleton, CREATE_COST, STYLE_PRICE, BOOST_PRICE, NAME_MAX, BANNER_MAX } from '../web/js/clan-rules.js';
import { checkName, checkTag, parseColour, tagSkeleton as botSkeleton, CREATE_COST as BOT_COST, STYLE_PRICE as BOT_STYLE, BOOST_PRICE as BOT_BOOST } from '../../apps/clans.js';

const NAMES = [
  'Night Owls', 'x', 'ab', 'abc', 'A'.repeat(24), 'A'.repeat(25), 'Staff Room', 'The Moderators', 'YapinStaff', 'Owners', 'Developers', 'Admins',
  "Yapin'", 'Admin Team', 'yapos fans', 'Official Club', 'Mods R Us', 'Bots', 'Help Desk', 'Café Crew', 'Night_Owls', 'Night-Owls.', '-bad', 'bad-',
  'ok name 2', 'Sys Ops', 'helpers', 'devs united', 'Supportive', 'night  owls', '<@123> crew', 'Dev', 'Moderatorz', 'Ownr', 'Good Vibes', 'Ünïcödé Fans',
];
const TAGS = ['OWL', 'owl', '[GG42]', 'GG', 'TOOLONG', 'MOD', 'YAP', 'DEV', 'SYS', 'BOT', 'O0L', '0WL', 'L1S8', 'AB!', ' NEW ', 'HELP', 'yos', 'ADM', 'abcd'];
const COLOURS = ['teal', 'GRAY', 'grey', '#ff8800', 'ff8800', '#f80', 'f80', '#ff880', 'blue ', 'nope', '', null, '#FFFFFF', 'violet'];

test('the website uses exactly the same clan name, tag and colour rules as the bot', () => {
  for (const owner of [false, true]) {
    for (const n of NAMES) assert.deepEqual(checkClanName(n, { owner }), checkName(n, { owner }), `name ${JSON.stringify(n)} owner=${owner}`);
    for (const t of TAGS) assert.deepEqual(checkClanTag(t, { owner }), checkTag(t, { owner }), `tag ${JSON.stringify(t)} owner=${owner}`);
  }
  for (const c of COLOURS) assert.equal(parseClanColour(c), parseColour(c), `colour ${JSON.stringify(c)}`);
  for (const t of TAGS) assert.equal(tagSkeleton(t), botSkeleton(t));
  assert.equal(tagSkeleton('0WL'), tagSkeleton('OWL'));
  assert.equal(tagSkeleton('L1S8'), 'IISB');
  assert.deepEqual([CREATE_COST, STYLE_PRICE, BOOST_PRICE], [BOT_COST, BOT_STYLE, BOT_BOOST]);
  assert.equal(NAME_MAX, 24);
  assert.equal(BANNER_MAX, 60);
  assert.ok(checkClanName('Staff Room').error);
  assert.equal(checkClanName('YapOS Staff', { owner: true }).value, 'YapOS Staff');
});
