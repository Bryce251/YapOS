import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, IDS } from '../harness.js';
import { checkName, checkTag, parseColour, capOf, CAPS, CAP_PRICES, STYLE_PRICE, BOOST_PRICE, BOOST } from '../../apps/clans.js';
import { GLOBAL_KEY } from '../../engine/global.js';

const S = IDS.server;
const make = () => createHarness({ apps: ['economy', 'levels', 'clans'], fakeClock: true });
const lastText = (h, ans) => h.textOf(ans[ans.length - 1]);
const eco = (h) => h.engine.service('economy');
const clans = (h) => h.engine.service('clans');
const fund = (h, uid, n) => eco(h).add(GLOBAL_KEY, uid, n, 'Test funds');
const doc = (h) => h.engine.store.get('clans', GLOBAL_KEY, {});
const dmOf = (uid) => `d${uid.slice(1)}`;

async function founded(h, uid = IDS.member, args = 'Night Owls OWL') {
  fund(h, uid, 600);
  const ans = await h.slash('clan', `create ${args}`, { user: uid });
  return ans;
}

test('clan names and tags are checked and filtered', () => {
  assert.equal(checkName('Night Owls').value, 'Night Owls');
  assert.ok(checkName('ab').error);
  assert.ok(checkName('x'.repeat(30)).error);
  assert.ok(checkName('Admin Team').error, 'no staff-looking names');
  assert.ok(checkName('YapOS Official').error);
  for (const n of ['Admins', 'The Moderators', 'YapinStaff', 'Owners', 'Developers']) assert.ok(checkName(n).error, `${n} is blocked`);
  assert.equal(checkName('Badminton Club').value, 'Badminton Club', 'words that only contain a staff word are fine');
  assert.ok(checkTag('MODZ').error);
  assert.ok(checkTag('ADMS').error);
  assert.equal(checkTag('owl').value, 'OWL');
  assert.equal(checkTag('[gg42]').value, 'GG42');
  assert.ok(checkTag('OW').error);
  assert.ok(checkTag('OWLSS').error);
  assert.ok(checkTag('MOD').error);
  assert.ok(checkTag('ADMN').error);
  assert.ok(checkTag('o-l').error);
  assert.equal(parseColour('#ff8800'), 0xff8800);
  assert.equal(parseColour('f80'), 0xff8800);
  assert.equal(parseColour('purple'), 0x9b59b6);
  assert.equal(parseColour('rainbow'), null);
  assert.deepEqual(CAPS, [10, 15, 20, 25]);
  assert.equal(capOf({ cap: 0 }), 10);
  assert.equal(capOf({ cap: 9 }), 25);
});

test('creating a clan costs 500 Shards, and you can only be in one', async () => {
  const h = await make();
  const broke = await h.slash('clan', 'create Night Owls OWL', { user: IDS.member });
  assert.match(lastText(h, broke), /Not enough Shards/);
  assert.equal(clans(h).of(IDS.member), null);

  const ans = await founded(h);
  assert.match(lastText(h, ans), /Night Owls \[OWL\] is founded!/);
  assert.equal(eco(h).balance(S, IDS.member), 100);
  const mine = clans(h).of(IDS.member);
  assert.equal(mine.name, 'Night Owls');
  assert.equal(mine.tag, 'OWL');
  assert.equal(mine.leader, true);

  fund(h, IDS.member, 600);
  const second = await h.slash('clan', 'create Day Larks LARK', { user: IDS.member });
  assert.match(lastText(h, second), /already have a clan/);

  fund(h, IDS.member2, 600);
  const taken = await h.slash('clan', 'create Other Owls owl', { user: IDS.member2 });
  assert.match(lastText(h, taken), /tag is taken/);
  const sameName = await h.slash('clan', 'create night owls NITE', { user: IDS.member2 });
  assert.match(lastText(h, sameName), /name is taken/);
  assert.equal(eco(h).balance(S, IDS.member2), 600, 'nothing charged for a refused clan');
  const bad = await h.slash('clan', 'create Mod Squad SQD', { user: IDS.member2 });
  assert.match(lastText(h, bad), /isn't allowed/);
});

test('leaders invite, people accept, and the cap holds', async () => {
  const h = await make();
  await founded(h);
  const notLeader = await h.slash('clan', 'invite @alex', { user: IDS.member2 });
  assert.match(lastText(h, notLeader), /No clan yet/);

  const inv = await h.slash('clan', 'invite @riley', { user: IDS.member });
  assert.match(lastText(h, inv), /Sent your invite to <@.+> in their DMs/);
  const box = h.sent(dmOf(IDS.member2));
  assert.equal(box.length, 1);
  assert.match(h.textOf(box[0]), /invited you to join \*\*Night Owls\*\* \[OWL\]/);
  const join = h.findButton('Join [OWL]', box);
  assert.ok(join);
  const stranger = await h.click(join.custom_id, { user: IDS.admin, messageId: join.messageId, server: null, channel: dmOf(IDS.member2) });
  assert.doesNotMatch(lastText(h, stranger), /Welcome/);
  const ok = await h.click(join.custom_id, { user: IDS.member2, messageId: join.messageId, server: null, channel: dmOf(IDS.member2) });
  assert.match(lastText(h, ok), /Welcome to Night Owls \[OWL\]/);
  assert.equal(clans(h).of(IDS.member2).tag, 'OWL');
  assert.equal(clans(h).of(IDS.member2).leader, false);

  const again = await h.slash('clan', 'invite @riley', { user: IDS.member });
  assert.match(lastText(h, again), /already in/);

  const c = Object.values(doc(h).clans)[0];
  h.engine.store.update('clans', GLOBAL_KEY, (d) => {
    for (let i = 0; i < 8; i++) d.clans[c.id].members.push(`fake-${i}`);
    return d;
  }, {});
  const full = await h.slash('clan', 'invite @alex', { user: IDS.member });
  assert.match(lastText(h, full), /clan is full/);
});

test('typed accept works, and a leader leaving hands the clan on', async () => {
  const h = await make();
  await founded(h);
  await h.slash('clan', 'invite @riley', { user: IDS.member });
  const none = await h.slash('clan', 'accept', { user: IDS.admin });
  assert.match(lastText(h, none), /No invites/);
  const yes = await h.slash('clan', 'accept OWL', { user: IDS.member2 });
  assert.match(lastText(h, yes), /Welcome/);

  const left = await h.slash('clan', 'leave', { user: IDS.member });
  assert.match(lastText(h, left), /leads it now/);
  assert.equal(clans(h).of(IDS.member), null);
  assert.equal(clans(h).of(IDS.member2).leader, true);

  const last = await h.slash('clan', 'leave', { user: IDS.member2 });
  assert.match(lastText(h, last), /Clan closed/);
  assert.equal(Object.keys(doc(h).clans).length, 0);
});

test('the bank only takes deposits and upgrades are bought from it', async () => {
  const h = await make();
  await founded(h);
  await h.slash('clan', 'invite @riley', { user: IDS.member });
  await h.slash('clan', 'accept', { user: IDS.member2 });

  const tooMuch = await h.slash('clan', 'deposit 5000', { user: IDS.member2 });
  assert.match(lastText(h, tooMuch), /Not enough Shards/);
  fund(h, IDS.member2, 3000);
  const dep = await h.slash('clan', 'deposit 2.5k', { user: IDS.member2 });
  assert.match(lastText(h, dep), /\+2,500 to the Night Owls bank/);
  assert.match(lastText(h, dep), /can't be paid out/);
  assert.equal(eco(h).balance(S, IDS.member2), 500);
  const c = () => clans(h).get(Object.keys(doc(h).clans)[0]);
  assert.equal(c().bank, 2500);

  for (const word of ['withdraw', 'pay', 'give', 'take']) {
    const ans = await h.slash('clan', `${word} 100`, { user: IDS.member });
    assert.doesNotMatch(lastText(h, ans), /\+100|paid you|withdrew/i, `/clan ${word} moves nothing`);
  }
  assert.equal(c().bank, 2500);
  assert.equal(eco(h).balance(S, IDS.member), 100);

  const memberBuy = await h.slash('clan', 'upgrade members', { user: IDS.member2 });
  assert.match(lastText(h, memberBuy), /Only the leader/);

  const cap = await h.slash('clan', 'upgrade members', { user: IDS.member });
  assert.match(lastText(h, cap), /room for \*\*15 members\*\*/);
  assert.equal(c().bank, 2500 - CAP_PRICES[0]);
  assert.equal(capOf(c()), 15);

  const noStyle = await h.slash('clan', 'colour #ff8800', { user: IDS.member });
  assert.match(lastText(h, noStyle), /Unlock it first/);
  const style = await h.slash('clan', 'upgrade style', { user: IDS.member });
  assert.match(lastText(h, style), /colour and banner/);
  assert.equal(c().bank, 2500 - CAP_PRICES[0] - STYLE_PRICE);
  const colour = await h.slash('clan', 'colour #ff8800', { user: IDS.member });
  assert.match(lastText(h, colour), /#ff8800/);
  assert.equal(clans(h).of(IDS.member).colour, '#ff8800');
  const banner = await h.slash('clan', 'banner Night owls never sleep', { user: IDS.member });
  assert.match(lastText(h, banner), /Night owls never sleep/);

  const boost = await h.slash('clan', 'upgrade boost', { user: IDS.member });
  assert.match(lastText(h, boost), /Not enough in the bank/);
  assert.equal(clans(h).xpBoost(IDS.member), 0);
  h.engine.store.update('clans', GLOBAL_KEY, (d) => { Object.values(d.clans)[0].bank = BOOST_PRICE; return d; }, {});
  await h.slash('clan', 'upgrade boost', { user: IDS.member });
  assert.equal(clans(h).xpBoost(IDS.member), BOOST);
  assert.equal(clans(h).xpBoost(IDS.member2), BOOST);
  assert.equal(clans(h).xpBoost(IDS.admin), 0);
});

test('the clan XP boost adds 5% to chat XP for members', async () => {
  const h = await make();
  await founded(h);
  h.engine.store.update('clans', GLOBAL_KEY, (d) => { Object.values(d.clans)[0].boost = true; return d; }, {});
  const { boostXp } = await import('../../apps/levels.js');
  assert.equal(boostXp(h.engine, S, IDS.member, 20), 21);
  assert.equal(boostXp(h.engine, S, IDS.member2, 20), 20);
});

test('leaders kick, hand over and rename the tag; the clan board ranks by total level', async () => {
  const h = await make();
  await founded(h);
  await h.slash('clan', 'invite @riley', { user: IDS.member });
  await h.slash('clan', 'accept', { user: IDS.member2 });
  const notYou = await h.slash('clan', 'kick @sam', { user: IDS.member2 });
  assert.match(lastText(h, notYou), /Only the leader/);
  const tag = await h.slash('clan', 'tag NITE', { user: IDS.member });
  assert.match(lastText(h, tag), /\[NITE\]/);
  const hand = await h.slash('clan', 'leader @riley', { user: IDS.member });
  assert.match(lastText(h, hand), /leads \*\*Night Owls\*\* \[NITE\] now/);
  const kick = await h.slash('clan', 'kick @sam', { user: IDS.member2 });
  assert.match(lastText(h, kick), /no longer in/);
  assert.equal(clans(h).of(IDS.member), null);

  fund(h, IDS.admin, 600);
  await h.slash('clan', 'create Day Larks LARK', { user: IDS.admin });
  await h.engine.service('levels').addXp(null, IDS.admin, 5000, 'test');
  const top = await h.slash('clan', 'top', { user: IDS.member2 });
  const text = lastText(h, top);
  assert.match(text, /Clan top/);
  assert.ok(text.indexOf('Day Larks') < text.indexOf('Night Owls'), 'higher total level ranks first');
  const board = clans(h).board('level');
  assert.equal(board[0].tag, 'LARK');
  const season = clans(h).board('season');
  assert.equal(season[0].tag, 'LARK');
});

test('/clan on its own shows your clan or how to start one', async () => {
  const h = await make();
  const intro = await h.slash('clan', '', { user: IDS.member });
  assert.match(lastText(h, intro), /Team up/);
  assert.ok(h.findButton('Create a clan', intro));
  await founded(h);
  const home = await h.slash('clan', '', { user: IDS.member });
  assert.match(lastText(h, home), /Night Owls \[OWL\]/);
  assert.match(lastText(h, home), /Clan bank/);
  assert.ok(h.findButton('Deposit', home));
  const info = await h.slash('clan', 'info OWL', { user: IDS.member2 });
  assert.match(lastText(h, info), /Night Owls \[OWL\]/);
  assert.ok(!h.findButton('Deposit', info), 'outsiders get no deposit button');
});

test('disbanding needs a confirm and only the owner sets the create cost', async () => {
  const h = await make();
  await founded(h);
  const ask = await h.slash('clan', 'disband', { user: IDS.member });
  assert.match(lastText(h, ask), /Close the clan\?/);
  const btn = h.findButton('Close the clan', ask);
  const ans = await h.click(btn.custom_id, { user: IDS.member, messageId: btn.messageId });
  assert.match(lastText(h, ans), /is closed/);
  assert.equal(clans(h).of(IDS.member), null);

  const no = await h.slash('clan', 'cost 0', { user: IDS.admin });
  assert.match(lastText(h, no), /Owner only/);
  const yes = await h.slash('clan', 'cost 0', { user: IDS.owner });
  assert.match(lastText(h, yes), /free now/);
  const free = await h.slash('clan', 'create Free Folk FREE', { user: IDS.member2 });
  assert.match(lastText(h, free), /is founded!/);
  assert.equal(eco(h).balance(S, IDS.member2), 0);
});

test('clans has one command and its descriptions fit', async () => {
  const h = await make();
  const app = h.engine.apps.get('clans');
  const cmds = Object.entries(app.def.commands);
  assert.equal(cmds.length, 1);
  for (const [, c] of cmds) assert.ok(c.description.length <= 100);
});

test('the bot owner can use YapOS and Yapin names and tags for a clan, nobody else can', () => {
  assert.equal(checkName("Yapin'", { owner: true }).value, "Yapin'");
  assert.equal(checkTag('YAP', { owner: true }).value, 'YAP');
  assert.ok(checkName("Yapin'").error);
  assert.ok(checkTag('YAP').error);
  assert.ok(checkName('Admin Team').error);
  assert.equal(checkName('Admin Team', { owner: true }).value, 'Admin Team');
  assert.equal(checkName("Night Owls'").value, "Night Owls'");
});

const OUT = 'a0000000-0000-4000-8000-0000000000f1';
const DM = (uid) => ({ server: null, channel: dmOf(uid), user: uid });
function stranger(h, id = OUT, username = 'jo') {
  (h.fake.state.members.elsewhere ||= []).push({ id, username, display_name: username, nickname: null, roles: [], joined_at: '2026-01-01T00:00:00Z' });
  return id;
}

test('/clan invite takes a user id from DMs and the invite lands in their DMs with buttons', async () => {
  const h = await make();
  await founded(h);
  stranger(h);
  const before = h.sent(IDS.channels.general).length;
  const ans = await h.slash('clan', `invite ${OUT}`, DM(IDS.member));
  assert.match(lastText(h, ans), new RegExp(`Sent your invite to <@${OUT}> in their DMs`));
  const box = h.sent(dmOf(OUT));
  assert.equal(box.length, 1);
  const text = h.textOf(box[0]);
  assert.match(text, /Clan invite/);
  assert.match(text, new RegExp(`<@${IDS.member}> invited you to join \\*\\*Night Owls\\*\\* \\[OWL\\]`));
  assert.match(text, /1\/10 members/);
  assert.match(text, /\/clan accept OWL/);
  assert.ok(h.findButton('No thanks', box));
  const join = h.findButton('Join [OWL]', box);
  const ok = await h.click(join.custom_id, { ...DM(OUT), messageId: join.messageId });
  assert.match(lastText(h, ok), /Welcome to Night Owls \[OWL\]/);
  assert.equal(clans(h).of(OUT).tag, 'OWL');
  assert.equal(h.sent(IDS.channels.general).length, before, 'nothing posted in the server');
});

test('/clan invite works with a mention or an id in a server, and names only in a server', async () => {
  const h = await make();
  await founded(h);
  const byMention = await h.slash('clan', `invite <@${IDS.member2}>`, { user: IDS.member });
  assert.match(lastText(h, byMention), /in their DMs/);
  assert.equal(h.sent(dmOf(IDS.member2)).length, 1);
  stranger(h);
  const byId = await h.slash('clan', `invite ${OUT}`, { user: IDS.member });
  assert.match(lastText(h, byId), /in their DMs/);
  assert.equal(h.sent(dmOf(OUT)).length, 1);
  const byAtId = await h.slash('clan', `invite @${IDS.admin}`, { user: IDS.member });
  assert.match(lastText(h, byAtId), /in their DMs/);
  const byName = await h.slash('clan', 'invite morgan', DM(IDS.member));
  assert.match(lastText(h, byName), /Use their user id here/);
  assert.equal(h.sent(dmOf(IDS.mod)).length, 0);
});

test('/clan invite refuses unknown ids, bots and yourself', async () => {
  const h = await make();
  await founded(h);
  const ghost = 'a0000000-0000-4000-8000-0000000000ee';
  const unknown = await h.slash('clan', `invite ${ghost}`, DM(IDS.member));
  assert.match(lastText(h, unknown), /No Yapin' account has that id/);
  const unknownHere = await h.slash('clan', `invite ${ghost}`, { user: IDS.member });
  assert.match(lastText(h, unknownHere), /No Yapin' account has that id/);
  const bot = await h.slash('clan', `invite ${IDS.bot}`, DM(IDS.member));
  assert.match(lastText(h, bot), /Bots can't join clans/);
  const botHere = await h.slash('clan', `invite <@${IDS.bot}>`, { user: IDS.member });
  assert.match(lastText(h, botHere), /Bots can't join clans/);
  const self = await h.slash('clan', `invite ${IDS.member}`, DM(IDS.member));
  assert.match(lastText(h, self), /That's you/);
  assert.equal(Object.keys(doc(h).invites).length, 0);
});

test('No thanks in the DM declines, and old or closed clan invites say so', async () => {
  const h = await make();
  await founded(h);
  await h.slash('clan', 'invite @riley', { user: IDS.member });
  let box = h.sent(dmOf(IDS.member2));
  const no = h.findButton('No thanks', box);
  const ans = await h.click(no.custom_id, { ...DM(IDS.member2), messageId: no.messageId });
  assert.match(lastText(h, ans), /Invite declined/);
  assert.equal(doc(h).invites[IDS.member2], undefined);

  await h.skip(8 * 86_400_000);
  await h.slash('clan', 'invite @riley', { user: IDS.member });
  box = h.sent(dmOf(IDS.member2));
  assert.equal(box.length, 2);
  await h.skip(8 * 86_400_000);
  const late = h.findButton('Join [OWL]', [box[1]]);
  const old = await h.click(late.custom_id, { ...DM(IDS.member2), messageId: late.messageId });
  assert.match(lastText(h, old), /That invite ran out/);
  assert.equal(clans(h).of(IDS.member2), null);

  await h.slash('clan', 'invite @riley', { user: IDS.member });
  const fresh = h.findButton('Join [OWL]', [h.lastSent(dmOf(IDS.member2))]);
  const ask = await h.slash('clan', 'disband', { user: IDS.member });
  const close = h.findButton('Close the clan', ask);
  await h.click(close.custom_id, { user: IDS.member, messageId: close.messageId });
  const gone = await h.click(fresh.custom_id, { ...DM(IDS.member2), messageId: fresh.messageId });
  assert.match(lastText(h, gone), /That clan is gone/);
});

test('a full clan refuses the DM button', async () => {
  const h = await make();
  await founded(h);
  await h.slash('clan', 'invite @riley', { user: IDS.member });
  const join = h.findButton('Join [OWL]', h.sent(dmOf(IDS.member2)));
  h.engine.store.update('clans', GLOBAL_KEY, (d) => {
    for (let i = 0; i < 9; i++) Object.values(d.clans)[0].members.push(`fake-${i}`);
    return d;
  }, {});
  const full = await h.click(join.custom_id, { ...DM(IDS.member2), messageId: join.messageId });
  assert.match(lastText(h, full), /That clan is full/);
});

test('when DMs fail the invite falls back to the channel in a server, or is saved from DMs', async () => {
  const h = await make();
  await founded(h);
  h.fake.features.dms = false;
  const here = await h.slash('clan', 'invite @riley', { user: IDS.member });
  const text = lastText(h, here);
  assert.match(text, /invited you to join \*\*Night Owls\*\* \[OWL\]/);
  assert.match(text, /couldn't DM you/);
  assert.ok(h.findButton('Join [OWL]', here));
  assert.equal(h.sent(dmOf(IDS.member2)).length, 0);

  const h2 = await make();
  await founded(h2);
  h2.fake.features.dms = false;
  stranger(h2);
  const fromDm = await h2.slash('clan', `invite ${OUT}`, DM(IDS.member));
  assert.match(lastText(h2, fromDm), /Their DMs are closed/);
  assert.match(lastText(h2, fromDm), /\/clan accept OWL/);
  const yes = await h2.slash('clan', 'accept OWL', DM(OUT));
  assert.match(lastText(h2, yes), /Welcome/);
});

test('leaders get 10 DM invites an hour, and re-inviting within a day only refreshes the invite', async () => {
  const h = await make();
  await founded(h);
  const first = await h.slash('clan', 'invite @riley', { user: IDS.member });
  assert.match(lastText(h, first), /in their DMs/);
  await h.skip(3_600_000);
  const again = await h.slash('clan', 'invite @riley', { user: IDS.member });
  assert.match(lastText(h, again), /in the last 24 hours, so I didn't DM them again/);
  assert.equal(h.sent(dmOf(IDS.member2)).length, 1);
  assert.equal(doc(h).invites[IDS.member2][0].at, h.now(), 'the saved invite is refreshed');
  await h.skip(24 * 3_600_000);
  await h.slash('clan', 'invite @riley', { user: IDS.member });
  assert.equal(h.sent(dmOf(IDS.member2)).length, 2, 'a day later it DMs again');

  await h.skip(2 * 3_600_000);
  const ids = Array.from({ length: 11 }, (_, i) => stranger(h, `a0000000-0000-4000-8000-0000000001${String(i).padStart(2, '0')}`, `p${i}`));
  for (const id of ids.slice(0, 10)) {
    const ans = await h.slash('clan', `invite ${id}`, DM(IDS.member));
    assert.match(lastText(h, ans), /in their DMs/);
  }
  const over = await h.slash('clan', `invite ${ids[10]}`, DM(IDS.member));
  assert.match(lastText(h, over), /Slow down a little/);
  assert.match(lastText(h, over), /10 clan invites an hour/);
  assert.equal(h.sent(dmOf(ids[10])).length, 0);
  assert.equal(doc(h).invites[ids[10]], undefined);
  await h.skip(3_600_000);
  const later = await h.slash('clan', `invite ${ids[10]}`, DM(IDS.member));
  assert.match(lastText(h, later), /in their DMs/);
});

test('clan help and the command mention user ids and DMs', async () => {
  const h = await make();
  const app = h.engine.apps.get('clans');
  assert.match(app.def.commands.clan.description, /user id/);
  assert.match(app.def.help.join('\n'), /user id/);
  assert.match(app.def.help.join('\n'), /DMs/);
});

test('ids in odd formats are cleaned up, and fake mentions are refused in DMs', async () => {
  const h = await make();
  await founded(h);
  stranger(h);
  const upper = await h.slash('clan', `invite <@!${OUT.toUpperCase()}>`, DM(IDS.member));
  assert.match(lastText(h, upper), new RegExp(`Sent your invite to <@${OUT}> in their DMs`));
  assert.ok(doc(h).invites[OUT], 'stored under the real lower-case id');
  const join = h.findButton('Join [OWL]', h.sent(dmOf(OUT)));
  const ok = await h.click(join.custom_id, { ...DM(OUT), messageId: join.messageId });
  assert.match(lastText(h, ok), /Welcome to Night Owls/);
  const fake = await h.slash('clan', 'invite <@notanid>', DM(IDS.member));
  assert.match(lastText(h, fake), /Use their user id here/);
  const selfUpper = await h.slash('clan', `invite ${IDS.member.toUpperCase()}`, DM(IDS.member));
  assert.match(lastText(h, selfUpper), /That's you/);
});

test('someone who said no thanks is not DMed again by that clan for a week', async () => {
  const h = await make();
  await founded(h);
  await h.slash('clan', 'invite @riley', { user: IDS.member });
  const no = h.findButton('No thanks', h.sent(dmOf(IDS.member2)));
  await h.click(no.custom_id, { ...DM(IDS.member2), messageId: no.messageId });
  await h.skip(2 * 86_400_000);
  const again = await h.slash('clan', 'invite @riley', { user: IDS.member });
  assert.match(lastText(h, again), /said no thanks/);
  assert.equal(h.sent(dmOf(IDS.member2)).length, 1);
  assert.equal(doc(h).invites[IDS.member2], undefined);
  await h.skip(6 * 86_400_000);
  const week = await h.slash('clan', 'invite @riley', { user: IDS.member });
  assert.match(lastText(h, week), /in their DMs/);
  assert.equal(h.sent(dmOf(IDS.member2)).length, 2);
});

test('one person gets at most 3 clan invite DMs a day, later invites are saved quietly', async () => {
  const h = await make();
  const leaders = [[IDS.member, 'Night Owls OWL'], [IDS.admin, 'Day Larks LRK'], [IDS.mod, 'Red Foxes FOX'], [IDS.owner, 'Blue Jays JAY']];
  for (const [uid, args] of leaders) await founded(h, uid, args);
  stranger(h);
  for (const [uid] of leaders.slice(0, 3)) {
    const ans = await h.slash('clan', `invite ${OUT}`, DM(uid));
    assert.match(lastText(h, ans), /in their DMs/);
  }
  const fourth = await h.slash('clan', `invite ${OUT}`, DM(IDS.owner));
  assert.match(lastText(h, fourth), /saved yours without a DM/);
  assert.match(lastText(h, fourth), /\/clan accept JAY/);
  assert.equal(h.sent(dmOf(OUT)).length, 3);
  const yes = await h.slash('clan', 'accept JAY', DM(OUT));
  assert.match(lastText(h, yes), /Welcome to Blue Jays/);
});

test('a DM Join button cannot be used after the invite is gone from the store', async () => {
  const h = await make();
  await founded(h);
  await h.slash('clan', 'invite @riley', { user: IDS.member });
  const join = h.findButton('Join [OWL]', h.sent(dmOf(IDS.member2)));
  const other = await h.click(join.custom_id, { user: IDS.admin, server: null, channel: dmOf(IDS.admin), messageId: join.messageId });
  assert.doesNotMatch(lastText(h, other), /Welcome/);
  assert.equal(clans(h).of(IDS.admin), null);
  h.engine.store.update('clans', GLOBAL_KEY, (d) => { delete d.invites[IDS.member2]; return d; }, {});
  const late = await h.click(join.custom_id, { ...DM(IDS.member2), messageId: join.messageId });
  assert.match(lastText(h, late), /That invite ran out/);
  assert.equal(clans(h).of(IDS.member2), null);
});
