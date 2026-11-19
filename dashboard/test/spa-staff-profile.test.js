import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installDom, flush, FakeEvent } from './dom-shim.js';

const { document } = installDom({ url: 'https://dash.example.test/party/reports' });
document.documentElement = document.createElement('html');
if (typeof globalThis.requestAnimationFrame !== 'function') globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
const { openProfilePanel, readStaffProfile, canReset, staffProfileUrl, personUrl, nameStyleText, RESET_PARTS, HIDDEN_TAG } = await import('../web/js/pages/party-person.js');
const { modLogSentence, actionLabel, readModLog } = await import('../web/js/pages/party-modlog.js');
const { renderProfile, noticeLines, resetText, NOTICES_API } = await import('../web/js/pages/profile.js');
const { normalizeLeaderboard, hiddenHintText } = await import('../web/js/pages/party-leaderboard.js');
const { state } = await import('../web/js/state.js');

const REX = '77777777-7777-4777-8777-000000000001';
const BANNER = '/banner-img/b-abcdefghij-0123456789abcdef.png';
const click = (el) => el.dispatchEvent(new FakeEvent('click', { bubbles: true }));
const buttons = (root, re) => [...root.querySelectorAll('button')].filter((b) => re.test(b.textContent) || re.test(b.getAttribute('aria-label') || ''));
const autoYes = () => {
  const ok = [...document.querySelectorAll('.dialog-root button')].pop();
  if (ok) click(ok);
};

function personData(over = {}) {
  return {
    person: { id: REX, name: 'Real Rex', username: 'realrex', avatar: null, role: null, banned: null, card: null, hiddenNames: { name: true, username: false }, ...over },
    counts: { total: 0, open: 0, first: null, last: null, made: 0, games: [] },
    bans: [],
    reports: [],
    more: false,
    role: 'owner',
  };
}

function staffData(over = {}) {
  return {
    person: { id: REX, name: 'Real Rex', username: 'realrex', role: null },
    look: { banner: BANNER, bio: 'My bio', status: 'Busy', statusEmoji: '', pronouns: '', nameColour: '#ff3366', nameGradient: null, nameFont: 'serif', pins: ['vip', 'ach:msgs1k'], custom: true },
    hidden: { name: { reason: 'Rude', at: Date.now() - 1000, byName: 'Jolli' }, username: null },
    canAct: true,
    why: null,
    role: 'owner',
    ...over,
  };
}

test('staff profile data is read safely and only offers resets that would change something', () => {
  const s = readStaffProfile(staffData({ look: { banner: 'javascript:alert(1)', bio: 5, pins: [1, 'vip'] } }));
  assert.equal(s.look.banner, null);
  assert.equal(s.look.bio, '');
  assert.deepEqual(s.look.pins, ['vip']);
  const full = readStaffProfile(staffData());
  assert.deepEqual(RESET_PARTS.filter((r) => canReset(full.look, r.part)).map((r) => r.part), ['banner', 'bio', 'status', 'name-style', 'pins', 'all']);
  assert.equal(nameStyleText(full.look), 'colour #ff3366, Serif font');
  assert.equal(nameStyleText({ nameFont: 'default' }), 'Default');
  assert.equal(staffProfileUrl(REX, 'look', 'name-style'), `/api/party/profile/${REX}/look/name-style`);
  assert.equal(readStaffProfile(null).canAct, false);
});

test('the profile panel shows the look, resets one part and hides a username with a reason', async () => {
  state.partyOwner = true;
  state.partyAdmin = true;
  const calls = [];
  const events = [];
  let staff = staffData();
  const api = {
    get: async (p) => (p === personUrl(REX) ? personData() : staff),
    post: async (p, body) => {
      calls.push(['POST', p, body]);
      staff = staffData({ hidden: { ...staff.hidden, username: { reason: body.reason || null, at: Date.now() } } });
      return staff;
    },
    request: async (method, p) => {
      calls.push([method, p]);
      staff = staffData({ look: { ...staff.look, bio: '' } });
      return staff;
    },
  };
  openProfilePanel({ api, id: REX, role: 'owner', onChanged: (e) => events.push(e) });
  await flush();
  await flush();
  let panel = document.querySelector('.drawer-panel');
  assert.match(panel.textContent, new RegExp(HIDDEN_TAG));
  assert.match(panel.querySelector('.person-name').textContent, /Real Rex/, 'staff see the real name');
  const img = panel.querySelector('.person-profile-tools .owner-look-banner');
  assert.equal(img.getAttribute('src') || img.src, BANNER);
  assert.match(panel.textContent, /My bio/);
  assert.equal(buttons(panel, /^Clear pronouns$/).length, 0, 'nothing to clear');
  click(buttons(panel, /^Clear about me$/)[0]);
  await flush();
  autoYes();
  await flush();
  await flush();
  assert.deepEqual(calls[0], ['DELETE', `/api/party/profile/${REX}/look/bio`]);
  panel = document.querySelector('.drawer-panel');
  assert.equal(buttons(panel, /^Clear about me$/).length, 0, 'the button goes once the bio is empty');
  assert.equal(buttons(panel, /^Hide display name$/).length, 0, 'already hidden');
  assert.equal(buttons(panel, /^Show display name again$/).length, 1);
  panel.querySelector('.hide-reason').value = 'Slur in handle';
  click(buttons(panel, /^Hide username$/)[0]);
  await flush();
  autoYes();
  await flush();
  await flush();
  assert.deepEqual(calls[1], ['POST', `/api/party/profile/${REX}/hide`, { what: 'username', reason: 'Slur in handle' }]);
  assert.deepEqual(events.map((e) => e.type), ['profileReset', 'nameHide']);
  assert.deepEqual(events[1].hidden, { name: true, username: true });
  document.body.replaceChildren();
});

test('admins looking at someone they cannot change get no reset buttons and a reason why', async () => {
  const api = {
    get: async (p) => (p === personUrl(REX) ? { ...personData({ role: 'admin' }), role: 'admin' } : staffData({ canAct: false, why: "Party admins can't change other party admins' profiles. Ask the owner." })),
  };
  openProfilePanel({ api, id: REX, role: 'admin' });
  await flush();
  await flush();
  const panel = document.querySelector('.drawer-panel');
  for (const r of RESET_PARTS) assert.equal(buttons(panel, new RegExp(`^${r.label}$`)).length, 0, r.label);
  assert.equal(buttons(panel, /^Hide username$/).length, 0);
  assert.match(panel.textContent, /Ask the owner/);
  document.body.replaceChildren();
});

test('profile resets and name hiding read as plain sentences in the mod log, with a hidden tag for staff', () => {
  const e = (action, detail = {}, target = { id: REX, name: 'Sam' }) => ({ action, actor: { name: 'Juno' }, target, detail });
  assert.equal(modLogSentence(e('profile_banner_remove')), "Juno removed Sam's profile banner picture");
  assert.equal(modLogSentence(e('profile_text_clear', { fields: ['bio'] })), "Juno cleared Sam's about me");
  assert.equal(modLogSentence(e('profile_text_clear', { fields: ['bio', 'status', 'pronouns'] })), "Juno cleared Sam's about me, status and pronouns");
  assert.equal(modLogSentence(e('profile_name_style_reset')), "Juno reset Sam's name colour and style");
  assert.equal(modLogSentence(e('profile_pins_clear')), "Juno cleared Sam's pinned badges");
  assert.equal(modLogSentence(e('profile_reset')), "Juno reset Sam's whole profile look");
  assert.equal(modLogSentence(e('name_hide', { what: 'name', reason: 'Rude' })), "Juno hid Sam's display name on YapOS: Rude");
  assert.equal(modLogSentence(e('name_unhide', { what: 'username' })), "Juno showed Sam's username on YapOS again");
  assert.equal(actionLabel('profile_reset'), 'Whole profiles reset');
  assert.equal(actionLabel('name_hide'), 'Names hidden');
  const read = readModLog({ entries: [{ id: 'a1', action: 'name_hide', actor: { id: 'x', name: 'Juno' }, target: { id: REX, name: 'Sam', hiddenNames: { name: true } }, detail: {}, created: 1 }] });
  assert.deepEqual(read.entries[0].target.hiddenNames, { name: true, username: false });
});

test('the person gets a plain notice about what staff changed, with no staff name', () => {
  assert.equal(resetText({ action: 'profile_text_clear', fields: ['bio'] }), 'your about me was cleared');
  assert.equal(resetText({ action: 'profile_text_clear', fields: ['bio', 'pronouns'] }), 'your about me and pronouns were cleared');
  assert.equal(resetText({ action: 'nope' }), '');
  const lines = noticeLines({ hidden: { name: { at: 1 }, username: null }, resets: [{ action: 'profile_banner_remove', at: 5 }, { action: 'profile_text_clear', fields: ['status'], at: 4 }, { action: 'profile_banner_remove', at: 3 }] });
  assert.equal(lines.length, 2);
  assert.match(lines[0].text, /Staff hid your display name on YapOS/);
  assert.match(lines[1].text, /^Staff reset part of your profile: your banner picture was removed and your status was cleared\./);
  assert.deepEqual(noticeLines({ hidden: {}, resets: [] }), []);
  assert.match(noticeLines({ hidden: { name: {}, username: {} } })[0].text, /display name and username/);
});

function mountProfile(user, { usernameHidden = true } = {}) {
  const root = document.createElement('div');
  document.body.replaceChildren(root);
  const ctrl = new AbortController();
  const asked = [];
  const ctx = {
    params: { name: 'realrex' },
    signal: ctrl.signal,
    api: {
      get: async (p) => {
        asked.push(p);
        if (p === NOTICES_API) return { hidden: { name: { at: 1 }, username: usernameHidden ? { at: 1 } : null }, resets: [{ action: 'profile_pins_clear', at: 2 }] };
        return { profile: { username: usernameHidden ? null : 'realrex', usernameHidden, nameHidden: true, hint: '777777', name: 'Hidden name', level: 3, xp: 10, badges: [], achievements: [], season: [], party: { games: 1, wins: 0 } } };
      },
    },
    setTitle(t) { ctx.title = t; },
    getUser: async () => user,
    setLeaveGuard() {},
  };
  renderProfile(root, ctx);
  return { root, ctx, asked };
}

test('a hidden profile shows Hidden name and @hidden, and only its owner sees the staff notice', async () => {
  const mine = mountProfile({ id: REX, username: 'realrex' });
  await flush();
  await flush();
  await flush();
  assert.equal(mine.ctx.title, 'Hidden name');
  assert.equal(mine.root.querySelector('.profile-name').textContent, 'Hidden name');
  assert.equal(mine.root.querySelector('.profile-handle').textContent, '@hidden');
  assert.ok(mine.asked.includes(NOTICES_API));
  assert.match(mine.root.querySelector('.profile-staff-notice').textContent, /Staff hid your display name and username on YapOS/);
  assert.match(mine.root.querySelector('.profile-staff-notice').textContent, /pinned badges were cleared/);
  assert.equal(buttons(mine.root, /Customize profile/).length, 1, 'they can still edit their own profile');
  const other = mountProfile({ id: 'someone-else', username: 'nina' });
  await flush();
  await flush();
  await flush();
  assert.equal(other.root.querySelector('.profile-staff-notice'), null);
  assert.ok(!other.asked.includes(NOTICES_API));
  const out = mountProfile(null);
  await flush();
  await flush();
  assert.equal(out.root.querySelector('.profile-staff-notice'), null);
  document.body.replaceChildren();
});

test('hidden rows on the Party leaderboard carry a short id hint for staff', () => {
  const view = normalizeLeaderboard({ rows: [{ rank: 1, id: REX, name: 'Hidden name', username: null, nameHidden: true, hint: '777777', value: 5 }, { rank: 2, id: 'b', name: 'Bea', username: 'bea', value: 3 }] });
  assert.equal(hiddenHintText(view.rows[0]), 'Hidden by YapOS staff (id 777777)');
  assert.equal(hiddenHintText(view.rows[1]), '');
  assert.equal(view.rows[1].hiddenHint, undefined);
});

test('the new files have no comments, inline styles, unsafe DOM or forbidden wording', () => {
  const files = ['../worker/hidden-names.js', '../worker/staff-profile.js', '../web/activity/js/hidden.js', '../web/js/pages/party-person.js', '../web/js/pages/profile.js', '../web/css/profile.css', '../web/css/replay.css'];
  for (const f of files) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.equal(/\/\*[\s\S]*?\*\//.test(src), false, f);
    if (f.endsWith('.js')) {
      assert.equal(/^\s*\/\/(?!\/)/m.test(src), false, f);
      assert.equal(/style=|innerHTML|outerHTML|insertAdjacentHTML/.test(src), false, f);
    }
    if (f.endsWith('.css')) assert.equal(/[^\x00-\x7f]/.test(src), false, f);
    assert.equal(/\b(claude|anthropic)\b/i.test(src), false, f);
  }
  const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
  assert.match(schema, /CREATE TABLE IF NOT EXISTS party_hidden_names \(/);
});
