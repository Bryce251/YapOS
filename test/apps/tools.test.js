import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, IDS, settle } from '../harness.js';
import { customId } from '../../engine/router.js';
import { parseSchedule, parseColour, repeatText } from '../../apps/tools.js';

const S = IDS.server;
const G = IDS.channels.general;
const NEWS = IDS.channels.news;
const make = (opts = {}) => createHarness({ apps: ['tools'], fakeClock: true, ...opts });
const last = (h, ans) => h.textOf(ans[ans.length - 1]);
const doc = (h) => h.engine.store.get('tools', S, {}) || {};
const tags = (h) => doc(h).tags || {};
const posts = (h) => Object.values(doc(h).posts || {});
const jobs = (h) => h.engine.scheduler.list({ kind: 'tools.post', serverId: S });
const textIn = (h, ch) => h.sent(ch).map((m) => h.textOf(m)).join('\n---\n');
const MON_9 = Date.parse('2026-11-09T09:00:00Z');

async function waitFor(fn, tries = 80) {
  for (let i = 0; i < tries; i++) {
    if (await fn()) return true;
    await settle(1);
  }
  return false;
}

async function addTag(h, name, text, user = IDS.mod) {
  return h.slash('tag', `add ${name} ${text}`, { user });
}

async function newDraft(h, values = {}, user = IDS.admin) {
  const open = await h.slash('embed', '', { user });
  assert.equal(open[0].type, 'modal', 'the form pops up');
  const ans = await h.submit(customId('tools', 'esave'), { title: 'Movie night', text: 'Friday at 8 in voice', colour: '', image: '', footer: '', ...values }, { user });
  return ans;
}

test('tools commands fit Yapin limits and the tile is open to members', async () => {
  const h = await make();
  for (const name of ['tag', 'embed', 'schedule']) {
    const c = h.bot.commands.get(name);
    assert.ok(c, `/${name} exists`);
    assert.ok(c.description.length > 0 && c.description.length <= 100, `/${name} description fits`);
  }
  const app = h.engine.apps.get('tools');
  assert.equal(app.def.panelPerm, 'member');
  assert.ok(app.def.help.length >= 3);
  assert.ok(h.engine.scheduler.has('tools.post'), 'the post job is registered');
});

test('tags: a mod adds one, anyone posts it with /tag or !name, placeholders fill in, uses count', async () => {
  const h = await make();
  const saved = await addTag(h, 'Rules', 'Hi {user}, welcome to {server}! Be nice.\nNo spam.');
  assert.match(last(h, saved), /Tag saved/);
  assert.ok(tags(h).rules, 'names are lowercased');
  assert.equal(tags(h).rules.text, 'Hi {user}, welcome to {server}! Be nice.\nNo spam.', 'line breaks are kept');

  const used = await h.slash('tag', 'rules', { user: IDS.member });
  assert.equal(used[0].type, 'reply', 'posted for everyone to see');
  assert.equal(used[0].content, `Hi <@${IDS.member}>, welcome to Test Town! Be nice.\nNo spam.`);

  await h.message('!rules', { user: IDS.member2 });
  assert.equal(h.lastSent(G).content, `Hi <@${IDS.member2}>, welcome to Test Town! Be nice.\nNo spam.`);
  assert.equal(tags(h).rules.uses, 2);

  const info = await h.slash('tag', 'info rules', { user: IDS.member });
  const text = last(h, info);
  assert.match(text, /!rules/);
  assert.match(text, /Mo/);
  assert.match(text, /Uses\n2/);
});

test('tags: refusals for members, bad names, reserved words, command names, long text and duplicates', async () => {
  const h = await make();
  const member = await addTag(h, 'rules', 'text', IDS.member);
  assert.match(last(h, member), /Needs Mod/);
  assert.equal(tags(h).rules, undefined);

  assert.match(last(h, await addTag(h, 'b@d!', 'x')), /lowercase letters/);
  assert.match(last(h, await addTag(h, 'a'.repeat(33), 'x')), /1 to 32/);
  assert.match(last(h, await addTag(h, 'list', 'x')), /word \/tag uses itself/);
  assert.match(last(h, await addTag(h, 'menu', 'x')), /already a YapOS command/);
  assert.match(last(h, await addTag(h, 'long', 'x'.repeat(2001))), /up to 2000/);
  await addTag(h, 'faq', 'Read the pins');
  assert.match(last(h, await addTag(h, 'faq', 'Again')), /already exists/);
  assert.equal(tags(h).faq.text, 'Read the pins');
});

test('tags: a name with a space is refused rather than saved under the first word', async () => {
  const h = await make();
  const ans = await h.slash('tag', 'add "two words" hello', { user: IDS.mod });
  assert.ok(!tags(h)['"two'], 'no tag with a quote in it');
  assert.match(last(h, ans), /doesn't work/);
});

test('tags: the server limit of 200 holds', async () => {
  const h = await make();
  const many = {};
  for (let i = 0; i < 200; i++) many[`t${i}`] = { name: `t${i}`, text: 'x', authorId: IDS.mod, createdAt: 1, uses: 0 };
  h.engine.store.set('tools', S, { tags: many });
  const ans = await addTag(h, 'one-more', 'x');
  assert.match(last(h, ans), /Too many tags/);
  assert.equal(Object.keys(tags(h)).length, 200);
});

test('tags: unknown names suggest the closest tag, chat stays quiet when nothing is close, commands are never hijacked', async () => {
  const h = await make();
  await addTag(h, 'rules', 'Be nice');
  const slash = await h.slash('tag', 'rulez', { user: IDS.member });
  assert.match(last(h, slash), /Did you mean \*\*!rules\*\*/);

  await h.message('!rulez', { user: IDS.member });
  assert.match(h.textOf(h.lastSent(G)), /Did you mean \*\*!rules\*\*/);
  const before = h.sent(G).length;
  await h.message('!play some song', { user: IDS.member });
  assert.equal(h.sent(G).length, before, 'no reply for a far-off word');
  await h.message('hello !rules', { user: IDS.member });
  assert.equal(h.sent(G).length, before, 'only messages that start with !name count');
  await h.message('!help', { user: IDS.member });
  assert.doesNotMatch(h.textOf(h.lastSent(G)), /Be nice/);
});

test('tags: a 3 second cooldown per person per tag stops spam', async () => {
  const h = await make();
  await addTag(h, 'rules', 'Be nice');
  const before = h.sent(G).length;
  await h.message('!rules', { user: IDS.member });
  await h.message('!rules', { user: IDS.member });
  await h.message('!rules', { user: IDS.member });
  assert.equal(h.sent(G).length, before + 1, 'only one post');
  await h.message('!rules', { user: IDS.member2 });
  assert.equal(h.sent(G).length, before + 2, 'someone else still can');
  const slash = await h.slash('tag', 'rules', { user: IDS.member });
  assert.match(last(h, slash), /Slow down/);
  assert.equal(tags(h).rules.uses, 2);
});

test('tags: "did you mean" in chat is limited so a typo spam cannot eat the message budget', async () => {
  const h = await make();
  await addTag(h, 'rules', 'Be nice');
  const before = h.sent(G).length;
  for (let i = 0; i < 6; i++) await h.message('!rulez', { user: IDS.member });
  assert.equal(h.sent(G).length, before + 1, 'one suggestion, then quiet');
  await h.message('!rulez', { user: IDS.member2 });
  assert.equal(h.sent(G).length, before + 2, 'someone else still gets help');
});

test('tags: @everyone and role pings in a tag never ping', async () => {
  const h = await make();
  await addTag(h, 'ping', `Hey @everyone and @here and <@&${IDS.roles.gamer}>`);
  const ans = await h.slash('tag', 'ping', { user: IDS.member });
  const out = ans[0].content;
  assert.doesNotMatch(out, /@everyone|@here/);
  assert.doesNotMatch(out, /<@&/);
  assert.match(out, /\*\*@Gamer\*\*/);
});

test('tags: edit and delete come with Undo', async () => {
  const h = await make();
  await addTag(h, 'faq', 'Old text');
  const edit = await h.slash('tag', 'edit faq New text', { user: IDS.mod });
  assert.match(last(h, edit), /Tag updated/);
  assert.equal(tags(h).faq.text, 'New text');
  await h.clickButton('Undo', { user: IDS.mod, in: edit });
  assert.equal(tags(h).faq.text, 'Old text');

  const missing = await h.slash('tag', 'edit fqa whatever', { user: IDS.mod });
  assert.match(last(h, missing), /Did you mean \*\*!faq\*\*/);

  const del = await h.slash('tag', 'delete faq', { user: IDS.mod });
  assert.match(last(h, del), /Tag deleted/);
  assert.equal(tags(h).faq, undefined);
  const memberUndo = await h.click(h.findButton('Undo', del).custom_id, { user: IDS.member });
  assert.match(last(h, memberUndo), /Needs Mod/);
  assert.equal(tags(h).faq, undefined);
  await h.clickButton('Undo', { user: IDS.mod, in: del });
  assert.equal(tags(h).faq.text, 'Old text');
  const nope = await h.slash('tag', 'delete faq', { user: IDS.member });
  assert.match(last(h, nope), /Needs Mod/);
});

test('tags: /tag add without text opens a form, and the form saves', async () => {
  const h = await make();
  const ans = await h.slash('tag', 'add', { user: IDS.mod });
  assert.equal(ans[0].type, 'modal');
  await h.submit(customId('tools', 'tagsave'), { name: '!Welcome', text: 'Hello {user}' }, { user: IDS.mod });
  assert.equal(tags(h).welcome.text, 'Hello {user}');
  const sneaky = await h.submit(customId('tools', 'tagsave'), { name: 'sneaky', text: 'x' }, { user: IDS.member });
  assert.match(last(h, sneaky), /Needs Mod/);
  assert.equal(tags(h).sneaky, undefined);
});

test('tags: the list pages with buttons', async () => {
  const h = await make();
  const many = {};
  for (let i = 0; i < 20; i++) { const n = `tag${String(i).padStart(2, '0')}`; many[n] = { name: n, text: `text ${i}`, authorId: IDS.mod, createdAt: 1, uses: 0 }; }
  h.engine.store.set('tools', S, { tags: many });
  const list = await h.slash('tag', 'list', { user: IDS.member });
  assert.match(last(h, list), /Tags \(20\)/);
  assert.match(last(h, list), /Page 1 of 2/);
  assert.match(last(h, list), /!tag00/);
  assert.doesNotMatch(last(h, list), /!tag19/);
  const next = await h.clickButton('Next', { user: IDS.member, in: list });
  assert.match(last(h, next), /Page 2 of 2/);
  assert.match(last(h, next), /!tag19/);
});

test('embed: members and mods are refused', async () => {
  const h = await make();
  assert.match(last(h, await h.slash('embed', '', { user: IDS.member })), /Needs Admin/);
  assert.match(last(h, await h.slash('embed', '', { user: IDS.mod })), /Needs Admin/);
  const sneaky = await h.submit(customId('tools', 'esave'), { title: 'x', text: 'y' }, { user: IDS.mod });
  assert.match(last(h, sneaky), /Needs Admin/);
});

test('embed: the form makes a draft with a live preview, colours, picture checks and sending', async () => {
  const h = await make();
  const preview = await newDraft(h, { colour: 'blue', footer: 'See you there' });
  const msg = preview[preview.length - 1];
  assert.match(msg.content, /Preview.*draft #1/);
  assert.equal(msg.embeds[0].title, 'Movie night');
  assert.equal(msg.embeds[0].description, 'Friday at 8 in voice');
  assert.equal(msg.embeds[0].color, 0x3498db);
  assert.equal(msg.embeds[0].footer.text, 'See you there');
  for (const label of ['Edit', 'Colour', 'Image', 'Send to #channel', 'Discard']) assert.ok(h.findButton(label, preview), label);

  const colours = await h.clickButton('Colour', { user: IDS.admin, in: preview });
  assert.ok(colours.length, 'answered');
  const panelMsg = h.fake.state.messages[G].find((m) => m.id === msg.message.id);
  assert.match(panelMsg.content, /Pick a colour/);
  await h.click(customId('tools', 'ecolour', IDS.admin, 1, 'ed4245'), { user: IDS.admin, messageId: panelMsg.id });
  assert.equal(panelMsg.embeds[0].color, 0xed4245);
  assert.match(panelMsg.content, /Preview/);

  await h.submit(customId('tools', 'ecolsave'), { colour: 'not a colour' }, { user: IDS.admin, messageId: panelMsg.id });
  assert.match(panelMsg.content, /Colours look like/);
  assert.equal(panelMsg.embeds[0].color, 0xed4245, 'a bad colour changes nothing');

  await h.click(customId('tools', 'eimage', IDS.admin, 1), { user: IDS.admin, messageId: panelMsg.id });
  await h.submit(customId('tools', 'eimgsave'), { image: 'https://evil.example.com/x.png' }, { user: IDS.admin, messageId: panelMsg.id });
  assert.match(panelMsg.content, /doesn't show pictures from \*\*evil\.example\.com\*\*/);
  assert.equal(panelMsg.embeds[0].image, undefined);
  await h.submit(customId('tools', 'eimgsave'), { image: 'http://i.imgur.com/x.png' }, { user: IDS.admin, messageId: panelMsg.id });
  assert.match(panelMsg.content, /https:\/\//);
  await h.submit(customId('tools', 'eimgsave'), { image: 'https://i.imgur.com/x.png' }, { user: IDS.admin, messageId: panelMsg.id });
  assert.equal(panelMsg.embeds[0].image.url, 'https://i.imgur.com/x.png');

  await h.click(customId('tools', 'esend', IDS.admin, 1), { user: IDS.admin, messageId: panelMsg.id });
  assert.match(panelMsg.content, /Where should draft #1 go/);
  assert.ok(panelMsg.components.some((r) => r.components.some((c) => c.type === 'select')), 'a channel picker');
  await h.pick(customId('tools', 'epick', IDS.admin, 1), [NEWS], { user: IDS.admin, messageId: panelMsg.id });
  const posted = h.lastSent(NEWS);
  assert.ok(posted, 'posted in the news channel');
  assert.equal(posted.embeds[0].title, 'Movie night');
  assert.equal(posted.embeds[0].color, 0xed4245);
  assert.equal(posted.components, null, 'the announcement has no buttons');
  assert.match(panelMsg.content, /Posted draft #1 in/);

  const undo = h.findButton('Undo', [panelMsg]);
  await h.click(undo.custom_id, { user: IDS.admin, messageId: panelMsg.id });
  assert.equal(h.sent(NEWS).length, 0, 'Undo takes the announcement down');
  assert.ok(doc(h).drafts[IDS.admin].list.length === 1, 'the draft stays saved');
});

test('embed: a draft needs a title or text, and bad colour or picture in the form only warn', async () => {
  const h = await make();
  await h.slash('embed', '', { user: IDS.admin });
  const empty = await h.submit(customId('tools', 'esave'), { title: '', text: '', colour: '', image: '', footer: '' }, { user: IDS.admin });
  assert.match(last(h, empty), /title or some text/);
  const ans = await newDraft(h, { colour: 'bluish', image: 'https://example.org/a.png' });
  const msg = ans[ans.length - 1];
  assert.match(msg.content, /Colours look like/);
  assert.match(msg.content, /example\.org/);
  assert.equal(msg.embeds[0].title, 'Movie night', 'the rest is saved');
});

test('embed: the channel picker falls back to buttons when select menus are off', async () => {
  const h = await make({ features: { selects: false } });
  const preview = await newDraft(h);
  const msg = h.fake.state.messages[G].find((m) => m.id === preview[preview.length - 1].message.id);
  await h.click(customId('tools', 'esend', IDS.admin, 1), { user: IDS.admin, messageId: msg.id });
  assert.ok(!msg.components.some((r) => r.components.some((c) => c.type === 'select')));
  const btn = h.findButton('#announcements', [msg]);
  assert.ok(btn, 'a button for each channel');
  await h.click(btn.custom_id, { user: IDS.admin, messageId: msg.id });
  assert.equal(h.lastSent(NEWS).embeds[0].title, 'Movie night');
});

test('embed: role pings only offer mentionable roles and the post pings that role', async () => {
  const h = await make();
  const preview = await newDraft(h);
  const msg = h.fake.state.messages[G].find((m) => m.id === preview[preview.length - 1].message.id);
  await h.click(customId('tools', 'eping', IDS.admin, 1), { user: IDS.admin, messageId: msg.id });
  const options = msg.components.flatMap((r) => r.components).filter((c) => c.type === 'select').flatMap((s) => s.options.map((o) => o.label));
  assert.deepEqual(options.sort(), ['@Gamer', '@Moderator']);
  await h.pick(customId('tools', 'erolepick', IDS.admin, 1), [IDS.roles.vip], { user: IDS.admin, messageId: msg.id });
  assert.match(msg.content, /can't be pinged/);
  await h.pick(customId('tools', 'erolepick', IDS.admin, 1), [IDS.roles.gamer], { user: IDS.admin, messageId: msg.id });
  assert.match(msg.content, /pings \*\*@Gamer\*\*/);
  assert.doesNotMatch(msg.content, /<@&/, 'the preview never pings');
  await h.slash('embed', `send 1 <#${NEWS}>`, { user: IDS.admin });
  assert.equal(h.lastSent(NEWS).content, `<@&${IDS.roles.gamer}>`);
  await h.click(customId('tools', 'erole', IDS.admin, 1, '-'), { user: IDS.admin, messageId: msg.id });
  assert.equal(doc(h).drafts[IDS.admin].list[0].pingRoleId, null);
});

test('embed: typed send, list, discard with Undo and only 5 drafts kept', async () => {
  const h = await make();
  for (let i = 1; i <= 5; i++) {
    await h.slash('embed', 'new', { user: IDS.admin });
    await h.submit(customId('tools', 'esave'), { title: `Post ${i}`, text: '' }, { user: IDS.admin });
  }
  const list = await h.slash('embed', 'list', { user: IDS.admin });
  assert.match(last(h, list), /Your drafts \(5\/5\)/);
  await h.slash('embed', 'new', { user: IDS.admin });
  const sixth = await h.submit(customId('tools', 'esave'), { title: 'Post 6', text: '' }, { user: IDS.admin });
  assert.match(last(h, sixth), /oldest one \(#1\) was removed/);
  assert.deepEqual(doc(h).drafts[IDS.admin].list.map((d) => d.n).sort((a, b) => a - b), [2, 3, 4, 5, 6]);

  await h.slash('embed', 'send #announcements', { user: IDS.admin });
  assert.equal(h.lastSent(NEWS).embeds[0].title, 'Post 6', 'the newest draft by default');
  await h.slash('embed', 'send 3 announcements', { user: IDS.admin });
  assert.equal(h.lastSent(NEWS).embeds[0].title, 'Post 3');
  assert.match(last(h, await h.slash('embed', 'send 1 #announcements', { user: IDS.admin })), /no draft #1/);
  assert.match(last(h, await h.slash('embed', 'send 3 #nowhere-at-all', { user: IDS.admin })), /couldn't find that channel/);

  const del = await h.slash('embed', 'delete 3', { user: IDS.admin });
  assert.match(last(h, del), /Draft discarded/);
  assert.ok(!doc(h).drafts[IDS.admin].list.some((d) => d.n === 3));
  await h.clickButton('Undo', { user: IDS.admin, in: del });
  assert.ok(doc(h).drafts[IDS.admin].list.some((d) => d.n === 3));
  assert.match(last(h, await h.slash('embed', 'sned', { user: IDS.admin })), /Did you mean .*\*\*send\*\*/);
});

test('embed: another admin cannot press someone else\'s draft buttons', async () => {
  const h = await make();
  const other = h.addSecondAdmin();
  const preview = await newDraft(h);
  const msg = preview[preview.length - 1].message;
  const locked = await h.click(customId('tools', 'ediscard', IDS.admin, 1), { user: other, messageId: msg.id });
  assert.match(last(h, locked), /Not your panel/);
  const direct = await h.click(customId('tools', 'ediscard', IDS.admin, 1), { user: other });
  assert.match(last(h, direct), /Not your panel/);
  assert.equal(doc(h).drafts[IDS.admin].list.length, 1);
});

test('drafts survive a restart', async () => {
  const a = await make();
  await newDraft(a);
  a.engine.scheduler.stop();
  const b = await make({ store: a.store });
  const ans = await b.slash('embed', 'open 1', { user: IDS.admin });
  assert.match(last(b, ans), /Movie night/);
  const expired = await b.submit(customId('tools', 'eimgsave'), { image: '' }, { user: IDS.admin });
  assert.match(last(b, expired), /expired/);
});

test('schedule parser: the formats people type', () => {
  const now = Date.parse('2026-11-07T12:00:00Z');
  const p = (t, tz = 'UTC') => parseSchedule(t, { tz, now });
  assert.deepEqual(p('every monday 9:00 Weekly meeting in voice!'), { at: null, repeat: { weekly: { days: [1], time: '09:00' }, tz: 'UTC' }, tz: 'UTC', draftNo: null, text: 'Weekly meeting in voice!' });
  assert.deepEqual(p('daily 18:00 Good evening').repeat, { daily: '18:00', tz: 'UTC' });
  assert.equal(p('in 2h Doors open').at, now + 2 * 3600_000);
  assert.equal(p('in 1d 6h x').at, now + 30 * 3600_000);
  assert.equal(p('on 2026-12-25 10:00 Merry').at, Date.parse('2026-12-25T10:00:00Z'));
  assert.equal(p('on 2026-12-25 10:00 tz America/New_York Merry').at, Date.parse('2026-12-25T15:00:00Z'));
  assert.equal(p('on 2026-12-25 10am Merry', 'Europe/Paris').at, Date.parse('2026-12-25T09:00:00Z'));
  assert.deepEqual(p('weekly mon,thu 18:30 x').repeat.weekly, { days: [1, 4], time: '18:30' });
  assert.deepEqual(p('every weekday at 8am x').repeat.weekly.days, [1, 2, 3, 4, 5]);
  assert.deepEqual(p('every monday and friday 6 pm x').repeat.weekly, { days: [1, 5], time: '18:00' });
  assert.deepEqual(p('monthly 15th 12:00 x').repeat.monthly, { day: 15, time: '12:00' });
  assert.deepEqual(p('every 6h x').repeat, { everyMs: 6 * 3600_000 });
  assert.equal(p('weekly mon 9:00 embed 2').draftNo, 2);
  assert.equal(p('weekly mon 9:00 embed 2').text, '');
  assert.equal(p('tomorrow 9:00 hi').at, Date.parse('2026-11-08T09:00:00Z'));
  assert.equal(p('at 11:00 hi').at, Date.parse('2026-11-08T11:00:00Z'), 'a passed time today means tomorrow');
  assert.equal(p('on friday 20:00 hi').at, Date.parse('2026-11-13T20:00:00Z'));
  assert.equal(p('daily 18:00 tz europe/london hi').tz, 'Europe/London');
  assert.match(p('every 10m spam').error, /at least 1 hour/);
  assert.match(p('on 2020-01-01 10:00 old').error, /already passed/);
  assert.match(p('on 2026-02-30 10:00 x').error, /doesn't exist/);
  assert.match(p('daily 18:00 tz Mars/Base x').error, /time zone/);
  assert.match(p('daily x').error, /Add a time/);
  assert.match(p('monthly 31 9:00 x').error, /1 to 28/);
  assert.match(p('sometime soon').error, /When should it go out/);
  assert.match(p('today 9:00 x').error, /already passed/);
  assert.equal(repeatText({ weekly: { days: [1], time: '09:00' }, tz: 'UTC' }), 'every Monday at 09:00 (UTC)');
  assert.equal(repeatText({ monthly: { day: 2, time: '12:00' }, tz: 'Europe/London' }), 'on the 2nd of every month at 12:00 (Europe/London)');
  assert.deepEqual(parseColour('#f80'), { ok: true, value: 0xff8800 });
  assert.equal(parseColour('nope').ok, false);
});

test('schedule: a weekly post goes out every Monday at 9 and the list shows the next time', async () => {
  const h = await make();
  const ans = await h.slash('schedule', `<#${NEWS}> every monday 9:00 Weekly meeting in voice!`, { user: IDS.admin });
  const text = last(h, ans);
  assert.match(text, /Post scheduled/);
  assert.match(text, /every Monday at 09:00 \(UTC\)/);
  assert.match(text, /Mon 9 Nov, 09:00 UTC/);
  assert.equal(jobs(h)[0].at, MON_9);

  const list = await h.slash('schedule', 'list', { user: IDS.admin });
  assert.match(last(h, list), /#1/);
  assert.match(last(h, list), /next Mon 9 Nov, 09:00 UTC/);

  await h.advanceTo(MON_9 - 1000);
  assert.equal(h.sent(NEWS).length, 0);
  await h.advanceTo(MON_9 + 1000);
  assert.equal(h.sent(NEWS).length, 1);
  assert.equal(h.lastSent(NEWS).content, 'Weekly meeting in voice!');
  await h.advance(7 * 86_400_000);
  assert.equal(h.sent(NEWS).length, 2);
  assert.equal(posts(h)[0].runs, 2);
});

test('schedule: one-off posts go out once and leave the list; typed chat works too', async () => {
  const h = await make();
  await h.message(`!schedule <#${NEWS}> in 2h Doors open soon!`, { user: IDS.admin });
  assert.equal(posts(h).length, 1);
  await h.advance(2 * 3600_000);
  assert.equal(h.lastSent(NEWS).content, 'Doors open soon!');
  assert.equal(posts(h).length, 0);
  assert.equal(jobs(h).length, 0);
  await h.advance(86_400_000);
  assert.equal(h.sent(NEWS).length, 1);
});

test('schedule: the server time zone is used unless tz is given', async () => {
  const h = await make();
  h.engine.settings.patchCore(S, { timezone: 'Europe/Paris' });
  await h.slash('schedule', `<#${NEWS}> daily 18:00 Bonsoir`, { user: IDS.admin });
  assert.equal(jobs(h)[0].at, Date.parse('2026-11-07T17:00:00Z'));
  const ny = await h.slash('schedule', `<#${NEWS}> on 2026-12-25 10:00 tz America/New_York Merry`, { user: IDS.admin });
  assert.match(last(h, ny), /America\/New_York/);
  assert.equal(jobs(h).find((j) => j.data.postId === 2).at, Date.parse('2026-12-25T15:00:00Z'));
});

test('schedule: refusals for members, bad input, missing channel and the 50 post limit', async () => {
  const h = await make();
  assert.match(last(h, await h.slash('schedule', `<#${NEWS}> daily 9:00 hi`, { user: IDS.member })), /Needs Admin/);
  assert.match(last(h, await h.slash('schedule', `<#${NEWS}> daily 9:00 hi`, { user: IDS.mod })), /Needs Admin/);
  assert.match(last(h, await h.slash('schedule', '#nowhere-at-all daily 9:00 hi', { user: IDS.admin })), /couldn't find that channel/);
  assert.match(last(h, await h.slash('schedule', `<#${NEWS}> every 5m spam`, { user: IDS.admin })), /at least 1 hour/);
  assert.match(last(h, await h.slash('schedule', `<#${NEWS}> daily 9:00`, { user: IDS.admin })), /What should I post/);
  assert.match(last(h, await h.slash('schedule', `<#${NEWS}> daily 9:00 embed 4`, { user: IDS.admin })), /no draft #4/);
  assert.match(last(h, await h.slash('schedule', `<#${NEWS}> daily 9:00 ${'x'.repeat(2001)}`, { user: IDS.admin })), /up to 2000/);
  assert.match(last(h, await h.slash('schedule', 'pause 9', { user: IDS.admin })), /no post \*\*#9\*\*/);
  assert.equal(jobs(h).length, 0);

  const full = {};
  for (let i = 1; i <= 50; i++) full[i] = { id: i, channelId: NEWS, text: 'x', embed: null, repeat: null, at: h.now() + 86_400_000, tz: 'UTC', paused: true };
  h.engine.store.set('tools', S, { posts: full, nextPost: 51 });
  assert.match(last(h, await h.slash('schedule', `<#${NEWS}> daily 9:00 hi`, { user: IDS.admin })), /Too many scheduled posts/);
});

test('schedule: pause, resume and cancel with Undo, from commands and list buttons', async () => {
  const h = await make();
  await h.slash('schedule', `<#${NEWS}> every monday 9:00 Meeting`, { user: IDS.admin });
  const paused = await h.slash('schedule', 'pause 1', { user: IDS.admin });
  assert.match(last(h, paused), /Post paused/);
  assert.equal(jobs(h).length, 0);
  await h.advanceTo(MON_9 + 1000);
  assert.equal(h.sent(NEWS).length, 0, 'paused posts stay quiet');
  const resumed = await h.slash('schedule', 'resume #1', { user: IDS.admin });
  assert.match(last(h, resumed), /Mon 16 Nov, 09:00 UTC/);
  assert.equal(jobs(h).length, 1);

  const list = await h.slash('schedule', '', { user: IDS.admin });
  const listMsg = list[list.length - 1].message;
  await h.click(customId('tools', 'spause', 1), { user: IDS.admin, messageId: listMsg.id });
  assert.equal(posts(h)[0].paused, true);
  await h.click(customId('tools', 'sresume', 1), { user: IDS.admin, messageId: listMsg.id });
  assert.equal(posts(h)[0].paused, false);
  const memberClick = await h.click(customId('tools', 'scancel', 1), { user: IDS.member });
  assert.match(last(h, memberClick), /Needs Admin/);
  assert.equal(posts(h).length, 1);

  const cancelled = await h.slash('schedule', 'cancel 1', { user: IDS.admin });
  assert.match(last(h, cancelled), /Post cancelled/);
  assert.equal(posts(h).length, 0);
  assert.equal(jobs(h).length, 0);
  await h.clickButton('Undo', { user: IDS.admin, in: cancelled });
  assert.equal(posts(h).length, 1);
  assert.equal(jobs(h).length, 1);
  await h.advanceTo(Date.parse('2026-11-16T09:00:01Z'));
  assert.equal(h.lastSent(NEWS).content, 'Meeting');
});

test('schedule: @everyone, @here and roles nobody may @mention in scheduled text never ping', async () => {
  const h = await make();
  const ans = await h.slash('schedule', `<#${NEWS}> in 1h Hey @everyone @here <@&${IDS.roles.vip}> <@&${IDS.roles.gamer}>`, { user: IDS.admin });
  assert.match(last(h, ans), /won't ping/);
  await h.advance(3600_000 + 10_000);
  const out = h.lastSent(NEWS).content;
  assert.doesNotMatch(out, /@everyone|@here/);
  assert.doesNotMatch(out, new RegExp(`<@&${IDS.roles.vip}>`));
  assert.match(out, /\*\*@VIP\*\*/i);
  assert.match(out, new RegExp(`<@&${IDS.roles.gamer}>`), 'a role anyone may @mention still pings');
});

test('schedule: cancelling from a full list keeps the New and Refresh buttons next to Undo', async () => {
  const h = await make();
  for (let i = 0; i < 12; i++) await h.slash('schedule', `<#${NEWS}> daily ${String(i).padStart(2, '0')}:30 Post ${i}`, { user: IDS.admin });
  const list = await h.slash('schedule', 'list', { user: IDS.admin });
  const msgId = list[list.length - 1].message.id;
  await h.click(customId('tools', 'scancel', 1), { user: IDS.admin, messageId: msgId });
  const msg = h.fake.state.messages[G].find((m) => m.id === msgId);
  assert.ok(msg.components.length <= 5);
  const labels = msg.components.flatMap((r) => r.components.map((b) => b.label));
  for (const l of ['New scheduled post', 'Refresh']) assert.ok(labels.includes(l), l);
  assert.ok(labels.some((l) => /^Undo/.test(l)));
  assert.ok(msg.components.every((r) => r.components.length <= 5));
});

test('embed: a double click on a channel posts the announcement once', async () => {
  const h = await make();
  const preview = await newDraft(h);
  const msg = preview[preview.length - 1].message;
  await h.click(customId('tools', 'esend', IDS.admin, 1), { user: IDS.admin, messageId: msg.id });
  await Promise.all([
    h.pick(customId('tools', 'epick', IDS.admin, 1), [NEWS], { user: IDS.admin, messageId: msg.id }),
    h.pick(customId('tools', 'epick', IDS.admin, 1), [NEWS], { user: IDS.admin, messageId: msg.id }),
  ]);
  assert.equal(h.sent(NEWS).length, 1);
});

test('schedule: a saved announcement can be scheduled and keeps its look', async () => {
  const h = await make();
  const preview = await newDraft(h, { colour: '#ff8800' });
  const msg = preview[preview.length - 1].message;
  await h.click(customId('tools', 'erole', IDS.admin, 1, IDS.roles.gamer), { user: IDS.admin, messageId: msg.id });
  const ans = await h.slash('schedule', `<#${NEWS}> weekly mon 9:00 embed 1`, { user: IDS.admin });
  assert.match(last(h, ans), /Movie night/);
  await h.slash('embed', 'delete 1', { user: IDS.admin });
  await h.advanceTo(MON_9 + 1000);
  const posted = h.lastSent(NEWS);
  assert.equal(posted.embeds[0].title, 'Movie night');
  assert.equal(posted.embeds[0].color, 0xff8800);
  assert.equal(posted.content, `<@&${IDS.roles.gamer}>`);
});

test('schedule: a post whose channel is gone logs once and pauses itself', async () => {
  const h = await make();
  h.engine.settings.patchCore(S, { logChannel: IDS.channels.modlog });
  await h.slash('schedule', `<#${NEWS}> daily 9:00 Morning`, { user: IDS.admin });
  h.fake.state.channels[S] = h.fake.state.channels[S].filter((c) => c.id !== NEWS);
  await h.advance(3 * 86_400_000);
  const logs = h.sent(IDS.channels.modlog).filter((m) => /paused/i.test(h.textOf(m)));
  assert.equal(logs.length, 1, 'one log line');
  assert.match(h.textOf(logs[0]), /no longer exists/);
  assert.equal(posts(h)[0].paused, true);
  assert.equal(jobs(h).length, 0);
  const list = await h.slash('schedule', 'list', { user: IDS.admin });
  assert.match(last(h, list), /paused \(its channel is gone\)/);
  const resume = await h.slash('schedule', 'resume 1', { user: IDS.admin });
  assert.match(last(h, resume), /channel is gone/);
});

test('schedule: posts survive a restart, and a one-off that came due while off still goes out', async () => {
  const a = await make();
  await a.slash('schedule', `<#${NEWS}> in 3h Back soon`, { user: IDS.admin });
  await a.slash('schedule', `<#${NEWS}> every monday 9:00 Meeting`, { user: IDS.admin });
  a.engine.scheduler.stop();
  const b = await make({ store: a.store });
  b.clock.t = a.clock.t + 5 * 3600_000;
  await b.runDue();
  assert.equal(b.lastSent(NEWS).content, 'Back soon');
  assert.equal(Object.values(b.engine.store.get('tools', S).posts).length, 1);
  await b.advanceTo(MON_9 + 1000);
  assert.equal(b.lastSent(NEWS).content, 'Meeting');
});

test('schedule: a repeating post more than an hour late skips that run instead of posting stale', async () => {
  const h = await make();
  await h.slash('schedule', `<#${NEWS}> daily 13:00 Lunch`, { user: IDS.admin });
  await h.skip(3 * 3600_000);
  assert.equal(h.sent(NEWS).length, 0);
  assert.ok(posts(h)[0].lastSkippedAt);
  await h.advance(86_400_000);
  assert.equal(h.sent(NEWS).length, 1);
});

test('schedule: a handler running twice posts once', async () => {
  const h = await make();
  await h.slash('schedule', `<#${NEWS}> daily 13:00 Lunch`, { user: IDS.admin });
  const job = jobs(h)[0];
  const run = h.engine.apps.get('tools').def.jobs.post;
  const copy = { ...job, attempt: 1, late: false, lateByMs: 0, missed: 0 };
  await run(copy, h.engine);
  await run(copy, h.engine);
  await settle();
  assert.equal(h.sent(NEWS).length, 1);
});

test('schedule: nothing posts while Tools is uninstalled, one-offs wait paused', async () => {
  const h = await make();
  await h.slash('schedule', `<#${NEWS}> in 1h Soon`, { user: IDS.admin });
  await h.slash('schedule', `<#${NEWS}> daily 13:00 Lunch`, { user: IDS.admin });
  h.engine.settings.setEnabled(S, 'tools', false);
  await h.advance(2 * 3600_000);
  assert.equal(h.sent(NEWS).length, 0);
  const once = posts(h).find((p) => p.id === 1);
  assert.equal(once.paused, true);
  h.engine.settings.setEnabled(S, 'tools', true);
  await h.slash('schedule', 'resume 1', { user: IDS.admin });
  await h.advance(10_000);
  assert.equal(h.lastSent(NEWS).content, 'Soon');
});

test('schedule: the form makes a post', async () => {
  const h = await make();
  const ans = await h.slash('schedule', 'new', { user: IDS.admin });
  assert.equal(ans[0].type, 'modal');
  const saved = await h.submit(customId('tools', 'ssave'), { channel: '#announcements', when: 'every friday 20:00', text: 'Game night!', tz: 'Europe/London' }, { user: IDS.admin });
  assert.match(last(h, saved), /every Friday at 20:00 \(Europe\/London\)/);
  assert.equal(posts(h)[0].text, 'Game night!');
});

test('panel: admins see counts and shortcuts, members see the tag list', async () => {
  const h = await make();
  await addTag(h, 'rules', 'Be nice');
  await newDraft(h);
  await h.slash('schedule', `<#${NEWS}> every monday 9:00 Meeting`, { user: IDS.admin });
  const home = await h.slash('menu', '', { user: IDS.admin });
  const tile = h.findButton('Tools', home);
  assert.ok(tile, 'admins get the tile');
  const opened = await h.click(tile.custom_id, { user: IDS.admin, messageId: tile.messageId });
  const homeMsg = h.fake.state.messages[G].find((m) => m.id === tile.messageId);
  const text = h.textOf(homeMsg) + last(h, opened);
  assert.match(text, /Tags:\*\* 1 of 200/);
  assert.match(text, /Your drafts:\*\* 1 of 5/);
  assert.match(text, /Scheduled posts:\*\* 1/);
  for (const label of ['Tags', 'New announcement', 'My drafts', 'Scheduled posts']) assert.ok(h.findButton(label, [homeMsg]), label);

  const memberHome = await h.slash('menu', '', { user: IDS.member });
  assert.ok(h.findButton('Tools', memberHome), 'members get the tile for the tag list');
  const viaYap = await h.slash('yap', 'tags', { user: IDS.member });
  assert.match(last(h, viaYap), /!rules/);
  const memberPanel = await h.click(customId('system', 'open', 'tools'), { user: IDS.member });
  assert.match(last(h, memberPanel), /Tags \(1\)/);
  assert.doesNotMatch(last(h, memberPanel), /drafts/i);
});
