import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from './dom-shim.js';

installDom();
const kit = await import('../web/js/kit.js');

test('durations read like the bot reads them', () => {
  assert.equal(kit.parseDurationText('10m'), 600000);
  assert.equal(kit.parseDurationText('2h30m'), 9000000);
  assert.equal(kit.parseDurationText('1 week'), 604800000);
  assert.equal(kit.parseDurationText('15'), 900000);
  assert.equal(kit.parseDurationText('3 fortnights'), null);
  assert.equal(kit.parseDurationText('10m later'), null);
  assert.equal(kit.parseDurationText(''), null);
});

test('duration problems are plain sentences with the right limits', () => {
  assert.equal(kit.durationProblem('', kit.TIMEOUT_RANGE, { required: true }), 'Pick how long it should last.');
  assert.equal(kit.durationProblem('', kit.BAN_RANGE), '');
  assert.equal(kit.durationProblem('30s', kit.TIMEOUT_RANGE), 'That is too short. The shortest is 1 minute.');
  assert.match(kit.durationProblem('29d', kit.TIMEOUT_RANGE), /28 days/);
  assert.equal(kit.durationProblem('28d', kit.TIMEOUT_RANGE), '');
  assert.match(kit.durationProblem('400d', kit.BAN_RANGE), /1 year/);
  assert.equal(kit.durationProblem('1y', kit.BAN_RANGE), '');
  assert.equal(kit.durationProblem('1 year', kit.BAN_RANGE), '');
  assert.match(kit.durationProblem('2y', kit.BAN_RANGE), /1 year/);
  assert.match(kit.durationProblem('1y', kit.TIMEOUT_RANGE), /28 days/);
  assert.match(kit.durationProblem('soon', kit.BAN_RANGE), /like 10m/);
});

test('action bodies only carry the keys the Worker accepts', () => {
  assert.deepEqual(kit.buildActionBody('warn', { reason: '  spam  ' }).body, { action: 'warn', reason: 'spam' });
  assert.deepEqual(kit.buildActionBody('timeout', { duration: '1h', reason: '' }).body, { action: 'timeout', duration: '1h' });
  assert.match(kit.buildActionBody('timeout', {}).error, /how long/);
  assert.deepEqual(kit.buildActionBody('ban', { duration: '' }).body, { action: 'ban' });
  assert.deepEqual(kit.buildActionBody('ban', { duration: '1w', reason: 'raid' }).body, { action: 'ban', reason: 'raid', duration: '1w' });
  assert.deepEqual(kit.buildActionBody('role_add', { role_id: 'r1', reason: 'x' }).body, { action: 'role_add', role_id: 'r1' });
  assert.match(kit.buildActionBody('role_remove', {}).error, /role/);
  assert.deepEqual(kit.buildActionBody('nick', { nickname: '  ' }).body, { action: 'nick', nickname: '' });
  assert.match(kit.buildActionBody('nick', { nickname: 'x'.repeat(33) }).error, /32/);
  assert.match(kit.buildActionBody('nick', { nickname: '😀'.repeat(17) }).error, /32/, 'counted like the Worker and the bot count');
  assert.deepEqual(kit.buildActionBody('nick', { nickname: '😀'.repeat(16) }).body, { action: 'nick', nickname: '😀'.repeat(16) });
  assert.deepEqual(kit.buildActionBody('note', { note: 'watch them' }).body, { action: 'note', note: 'watch them' });
  assert.match(kit.buildActionBody('note', { note: '' }).error, /note/);
  assert.deepEqual(kit.buildActionBody('unwarn', { case: '12' }).body, { action: 'unwarn', case: 12 });
  assert.ok(kit.buildActionBody('unwarn', { case: 'x' }).error);
  assert.match(kit.buildActionBody('warn', { reason: 'x'.repeat(501) }).error, /500/);
  assert.ok(kit.buildActionBody('explode', {}).error);
});

test('confirm copy names the member and the length', () => {
  assert.equal(kit.confirmCopy('kick', 'Ava').title, 'Kick Ava?');
  assert.equal(kit.confirmCopy('ban', 'Ava', '1w').title, 'Ban Ava for 1w?');
  assert.equal(kit.confirmCopy('close').confirmLabel, 'Close ticket');
});

test('api paths and query strings are encoded and skip empty values', () => {
  assert.equal(kit.serverApi('s 1', 'members', 'u/2', 'actions'), '/api/servers/s%201/members/u%2F2/actions');
  assert.equal(kit.serverApi('s', 'tickets', 7), '/api/servers/s/tickets/7');
  assert.equal(kit.withQuery('/x', { q: 'a b', role: '', page: 2, sort: null }), '/x?q=a+b&page=2');
  assert.equal(kit.withQuery('/x', {}), '/x');
});

test('pages are read defensively', () => {
  assert.deepEqual(kit.readPage({ members: [1, 2], total: 120, page: 2, pages: 3, pageSize: 50, capped: true }, 'members'), { list: [1, 2], page: 2, pages: 3, total: 120, pageSize: 50, capped: true });
  assert.deepEqual(kit.readPage(null, 'tickets'), { list: [], page: 1, pages: 1, total: 0, pageSize: 50, capped: false });
});

test('members and roles normalize with colours and order', () => {
  const m = kit.normalizeMember({ id: 'u1', username: 'ava', roles: ['r1', 'r2'], warnings: 2, bot: true, joined_at: '2024-01-01T00:00:00Z' });
  assert.equal(m.name, 'ava');
  assert.equal(m.bot, true);
  assert.equal(m.warnings, 2);
  assert.equal(m.joined_at, Date.parse('2024-01-01T00:00:00Z'));
  const index = kit.rolesIndex([{ id: 'r1', name: 'Mods', color: 0xff0000, position: 5, manageable: false }, { id: 'r2', name: 'Fans', color: '#00ff00', position: 2, manageable: true }, { id: 'e', name: '@everyone', position: 0 }]);
  const list = kit.sortRoles(kit.roleList(['r2', 'r1', 'gone', 'e'], index));
  assert.deepEqual(list.map((r) => r.name), ['Mods', 'Fans', 'Unknown role']);
  assert.equal(list[0].color, '#ff0000');
  const fromObjects = kit.roleList([{ id: 'r2', name: 'Fans', color: null, position: 2, manageable: true }], index);
  assert.equal(fromObjects[0].manageable, true);
  const chip = kit.roleChip(list[0]);
  assert.equal(chip.style.props['--role-color'], '#ff0000');
  assert.equal(kit.roleChip({ name: 'Plain' }).style.props['--role-color'], undefined);
});

test('bar heights scale to the busiest day and keep small days visible', () => {
  assert.deepEqual(kit.barHeights([0, 1, 10, 5]), [0, 10, 100, 50]);
  assert.deepEqual(kit.barHeights([0, 0]), [0, 0]);
  assert.deepEqual(kit.barHeights([1, 200]), [4, 100]);
});

test('days are taken from the bot or zero filled', () => {
  const now = Date.parse('2026-03-14T10:00:00Z');
  const filled = kit.fillDays(null, 14, now);
  assert.equal(filled.length, 14);
  assert.equal(filled[13].day, '2026-03-14');
  assert.equal(filled[0].day, '2026-03-01');
  const given = kit.fillDays([{ day: '2026-03-13', count: 2 }, { day: '2026-03-14', count: '3' }], 14, now);
  assert.deepEqual(given, [{ day: '2026-03-13', count: 2 }, { day: '2026-03-14', count: 3 }]);
});

test('bar chart sets one --h per bar', () => {
  const chart = kit.barChart([{ day: '2026-03-13', count: 1 }, { day: '2026-03-14', count: 4 }]);
  const bars = chart.querySelectorAll('.bar');
  assert.equal(bars.length, 2);
  assert.equal(bars[0].style.props['--h'], '25%');
  assert.equal(bars[1].style.props['--h'], '100%');
  assert.match(chart.getAttribute('aria-label'), /5 in the last 2 days/);
});

test('type breakdown sorts by count with shares', () => {
  const out = kit.typeBreakdown({ warn: 3, ban: 1, kick: 0 });
  assert.deepEqual(out.map((t) => [t.type, t.count, t.share]), [['warn', 3, 75], ['ban', 1, 25]]);
  assert.equal(out[1].tone, 'danger');
});

test('tickets normalize and name their transcript files', () => {
  const t = kit.normalizeTicket({ number: 7, status: 'weird', name: 'Help Me!', opener: { id: 'u1', name: 'Ava' }, rating: 4.6, type: { id: 'x', name: 'Billing', emoji: '💳' } });
  assert.equal(t.status, 'open');
  assert.equal(t.rating, 5);
  assert.equal(t.opener.name, 'Ava');
  assert.equal(t.claimedBy, null);
  assert.equal(kit.transcriptFileName(t), 'ticket-7-help-me.txt');
  assert.equal(kit.transcriptFileName({ number: 3, name: 'ticket-3' }), 'ticket-3.txt');
  assert.deepEqual(kit.ticketStatus('closed'), { label: 'Closed', tone: 'neutral' });
});

test('stars round and label the rating', () => {
  const el = kit.stars(3.4);
  assert.equal(el.querySelectorAll('.star.is-on').length, 3);
  assert.equal(el.getAttribute('aria-label'), 'Rated 3 out of 5');
  assert.equal(kit.stars(null).getAttribute('aria-label'), 'Not rated');
});

test('tab bar switches with clicks and arrow keys', () => {
  const seen = [];
  const tabs = kit.tabBar({ items: [{ id: 'a', label: 'A', count: 2 }, { id: 'b', label: 'B' }], value: 'a', onChange: (id) => seen.push(id) });
  const [a, b] = tabs.el.querySelectorAll('.ftab');
  assert.equal(a.getAttribute('aria-selected'), 'true');
  b.click();
  assert.equal(tabs.value, 'b');
  assert.equal(b.getAttribute('aria-selected'), 'true');
  const ev = { type: 'keydown', key: 'ArrowRight', preventDefault() {} };
  for (const fn of b.listeners.get('keydown')) fn(ev);
  assert.equal(tabs.value, 'a');
  assert.deepEqual(seen, ['b', 'a']);
  tabs.setCount('b', 9);
  assert.equal(b.querySelector('.ftab-count').textContent, '9');
});

test('duration picker switches between chips and a custom length', () => {
  const values = [];
  const p = kit.durationPicker({ value: '1h', onChange: (v) => values.push(v) });
  const chips = p.el.querySelectorAll('.duration-chip');
  assert.equal(chips.find((c) => c.dataset.value === '1h').getAttribute('aria-pressed'), 'true');
  chips.find((c) => c.dataset.value === '1d').click();
  assert.equal(p.value, '1d');
  const custom = p.el.querySelector('input');
  custom.value = '2h30m';
  for (const fn of custom.listeners.get('input')) fn({});
  assert.equal(p.value, '2h30m');
  assert.ok(chips.every((c) => c.getAttribute('aria-pressed') === 'false'));
  const ban = kit.durationPicker({ presets: [], allowNone: true, value: '' });
  assert.equal(ban.value, '');
  assert.equal(ban.el.querySelector('.duration-chip').getAttribute('aria-pressed'), 'true');
});

test('hero stats show the final value right away when motion is reduced', () => {
  window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  assert.equal(kit.heroStat({ label: 'Cases', value: 1234 }).querySelector('.stat-value').textContent, '1,234');
  assert.equal(kit.heroStat({ label: 'Cases', value: null }).querySelector('.stat-value').textContent, '–');
  assert.equal('countUp' in kit, false, 'one count-up lives in ui.js');
});

test('downloads use a blob url and a download link', () => {
  const made = [];
  const revoked = [];
  const original = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  URL.createObjectURL = (blob) => {
    made.push(blob);
    return 'blob:test/1';
  };
  URL.revokeObjectURL = (u) => revoked.push(u);
  let clicked = null;
  document.body.addEventListener('click', (e) => {
    clicked = e.target;
  });
  try {
    const url = kit.downloadText('ticket-1.txt', 'hello');
    assert.equal(url, 'blob:test/1');
    assert.equal(made[0].type, 'text/plain;charset=utf-8');
    assert.equal(clicked.getAttribute('download'), 'ticket-1.txt');
    assert.equal(clicked.href, 'blob:test/1');
    assert.equal(clicked.isConnected, false);
  } finally {
    URL.createObjectURL = original.create;
    URL.revokeObjectURL = original.revoke;
  }
});

test('job answers that carry a plain error turn into that error', async () => {
  const answers = [{ grant: true, level: 'admin', tickets: [], error: "Tickets isn't installed here. Install it first." }, { grant: false, level: 'member', error: 'Admins only.' }, { grant: true, level: 'admin', tickets: [] }];
  const ctx = { api: { get: async () => answers.shift(), job: async () => null } };
  await assert.rejects(kit.readJob(ctx, '/x'), (e) => e.code === 'job_error' && /isn't installed/.test(e.message));
  await assert.rejects(kit.readJob(ctx, '/x'), (e) => e.code === 'forbidden' && e.message === 'Admins only.');
  assert.deepEqual((await kit.readJob(ctx, '/x')).tickets, []);
});

test('a confirm over a drawer: Escape only cancels the confirm and the page stays locked', async () => {
  const ui = await import('../web/js/ui.js');
  const raf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (fn) => { fn(0); return 0; };
  try {
    const d = ui.drawer({ title: 'Member' });
    assert.ok(document.body.classList.contains('has-modal'));
    const asked = ui.confirmDialog({ title: 'Kick?', body: 'Sure?' });
    const esc = { key: 'Escape', preventDefault() {} };
    for (const fn of [...document.listeners.get('keydown')]) fn(esc);
    assert.equal(await asked, false);
    assert.equal(document.querySelector('.dialog-root'), null);
    assert.ok(d.root.classList.contains('is-open'), 'the drawer stays open');
    assert.ok(document.body.classList.contains('has-modal'), 'the page behind the drawer stays locked');
    d.close();
    assert.equal(document.body.classList.contains('has-modal'), false);
  } finally {
    globalThis.requestAnimationFrame = raf;
  }
});

test('searches wait for the one in flight and only send the latest text', async () => {
  const sent = [];
  let release = null;
  const s = kit.latestSearch((q) => {
    sent.push(q);
    return new Promise((r) => { release = r; });
  }, { delay: 5 });
  s.push('a');
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(sent, [], 'one letter is too short to search');
  s.push('av');
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(sent, ['av']);
  s.push('ava');
  await new Promise((r) => setTimeout(r, 20));
  s.push('ava b');
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(sent, ['av'], 'nothing new starts while one is waiting');
  release();
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(sent, ['av', 'ava b'], 'only the latest text goes next');
  release();
  s.push('');
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(sent, ['av', 'ava b', ''], 'clearing the box still searches');
  release();
  s.cancel();
  s.push('zz');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sent.length, 3);
});
