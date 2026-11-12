import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, type, fire, flush } from './dom-shim.js';

const SID = '33333333-3333-4333-8333-333333333333';
const { document } = installDom({ url: `https://dash.example.test/servers/${SID}/members` });
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });

const { state, setDetail } = await import('../web/js/state.js');
const { renderMembers } = await import('../web/js/pages/members.js');
const { renderTickets } = await import('../web/js/pages/tickets.js');
const { renderMod } = await import('../web/js/pages/mod.js');
const { openMemberDrawer } = await import('../web/js/pages/member.js');

const ROLES = [
  { id: 'r-admin', name: 'Admins', color: 0xff3355, position: 9, manageable: false },
  { id: 'r-fans', name: 'Fans', color: '#22aa66', position: 3, manageable: true },
  { id: 'r-vip', name: 'VIP', color: null, position: 4, manageable: true },
];

const detail = (overview = {}) => ({ overview: { id: SID, name: 'Test Town', ...overview }, apps: [], settings: { lookups: { roles: ROLES, channels: [] } }, updatedAt: 1, level: 'admin' });

function makeCtx(api) {
  const main = document.createElement('main');
  document.body.replaceChildren(main);
  const ctrl = new AbortController();
  return { api, params: { sid: SID }, signal: ctrl.signal, main, setChrome() {}, setLeaveGuard() {}, abort: () => ctrl.abort() };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const never = () => new Promise(() => {});
const buttons = (root, re) => root.querySelectorAll('button').filter((b) => re.test(b.textContent));
const toastText = () => document.body.querySelector('.toast-root')?.textContent || '';
const drawerPanel = () => document.body.querySelector('.drawer-panel');

function memberDetail(extra = {}) {
  return {
    id: 'u1', name: 'Ava', username: 'ava', nickname: null, avatar_url: null, joined_at: '2025-01-02T00:00:00Z',
    roles: [{ id: 'r-fans', name: 'Fans', color: '#22aa66', position: 3, manageable: true }],
    timeout: null, banned: false, tempBan: null,
    notes: [{ id: 'n1', text: 'Was helpful', by: { id: 'm1', name: 'Mo' }, at: '2025-02-01T00:00:00Z' }],
    warnings: [{ case: 12, at: '2025-03-01T00:00:00Z', reason: 'caps' }],
    cases: [{ n: 12, type: 'warn', user: { id: 'u1', name: 'Ava' }, mod: { id: 'm1', name: 'Mo' }, reason: 'caps', at: '2025-03-01T00:00:00Z' }],
    levels: { level: 4, xp: 300 }, economy: { balance: 50 },
    can: { warn: true, unwarn: true, timeout: true, kick: true, ban: true, unban: false, role: true, nick: true, note: true },
    ...extra,
  };
}

test('the members page lists members with role chips, badges and filters', async () => {
  state.details.clear();
  window.history.replaceState(null, '', `/servers/${SID}/members`);
  const paths = [];
  const ctx = makeCtx({
    get: async (path) => {
      paths.push(path);
      if (path.includes('/members')) {
        return { grant: true, level: 'admin', total: 2, page: 1, pages: 1, pageSize: 50, capped: false, members: [
          { id: 'u1', name: 'Ava', username: 'ava', avatar_url: null, joined_at: '2025-01-02T00:00:00Z', roles: ['r-admin', 'r-fans'], bot: false, warnings: 2, cases: 3 },
          { id: 'b1', name: 'Helper', username: 'helper', avatar_url: null, joined_at: null, roles: [], bot: true, warnings: 0, cases: 0 },
        ] };
      }
      return detail();
    },
    job: never,
  });
  renderMembers(ctx);
  await flush();
  const rows = ctx.main.querySelectorAll('.member-row');
  assert.equal(rows.length, 2);
  assert.match(rows[0].textContent, /Ava/);
  assert.match(rows[0].textContent, /@ava/);
  assert.match(rows[0].textContent, /2 warns/);
  assert.match(rows[0].textContent, /3 cases/);
  const chips = rows[0].querySelectorAll('.role-chip');
  assert.deepEqual(chips.map((c) => c.textContent), ['Admins', 'Fans']);
  assert.equal(chips[0].style.props['--role-color'], '#ff3355');
  assert.match(rows[1].textContent, /BOT/);
  const roleSelect = ctx.main.querySelectorAll('select')[0];
  assert.deepEqual(roleSelect.querySelectorAll('option').map((o) => o.textContent), ['Any role', 'Admins', 'VIP', 'Fans']);
  assert.match(ctx.main.textContent, /2 members/);

  roleSelect.value = 'r-fans';
  fire(roleSelect, 'change');
  await flush();
  assert.match(window.location.search, /role=r-fans/);
  assert.ok(paths.some((p) => p.endsWith('/members?role=r-fans')));

  type(ctx.main.querySelector('input[type=search]'), 'av');
  await wait(650);
  await flush();
  assert.match(window.location.search, /q=av/);
  assert.ok(paths.some((p) => p.includes('/members?q=av&role=r-fans')));
  ctx.abort();
});

test('a members search with no matches offers to clear the filters', async () => {
  state.details.clear();
  window.history.replaceState(null, '', `/servers/${SID}/members?q=zzz`);
  const ctx = makeCtx({
    get: async (path) => (path.includes('/members') ? { grant: true, members: [], total: 0, page: 1, pages: 1, capped: true } : detail()),
    job: never,
  });
  renderMembers(ctx);
  await flush();
  assert.match(ctx.main.textContent, /No members match/);
  assert.match(ctx.main.textContent, /only keeps part of the member list/);
  buttons(ctx.main, /Clear filters/)[0].click();
  await flush();
  assert.equal(window.location.search, '');
  assert.equal(ctx.main.querySelector('input[type=search]').value, '');
  ctx.abort();
});

test('the members page waits on YapOS and shows a refused grant plainly', async () => {
  state.details.clear();
  window.history.replaceState(null, '', `/servers/${SID}/members`);
  let release = null;
  const ctx = makeCtx({
    get: async (path) => (path.includes('/members') ? { pending: true, job: 'j1' } : detail()),
    job: () => new Promise((r) => { release = r; }),
  });
  renderMembers(ctx);
  await flush();
  assert.match(ctx.main.textContent, /Waiting for YapOS/);
  release({ grant: false, level: 'member', error: 'You need to be an admin of this server.' });
  await flush();
  assert.match(ctx.main.textContent, /No access to this server/);
  ctx.abort();
});

test('the member drawer shows status, roles and runs a confirmed kick', async () => {
  state.details.clear();
  setDetail(SID, detail());
  const sent = [];
  const ctx = makeCtx({
    get: async () => ({ grant: true, level: 'admin', member: memberDetail({ timeout: { until: new Date(Date.now() + 3600000).toISOString() } }) }),
    job: never,
    run: async (method, path, body, opts) => {
      sent.push({ method, path, body });
      opts.onPending?.('j9');
      return { data: { grant: true, ok: true, action: 'kick', case: { n: 13 }, message: 'Kicked Ava. Case #13.', member: memberDetail({ name: 'Ava', banned: false, roles: [] }) } };
    },
  });
  let changed = 0;
  openMemberDrawer(ctx, { id: 'u1', name: 'Ava' }, { onChange: () => { changed += 1; } });
  await flush();
  const panel = drawerPanel();
  assert.match(panel.textContent, /Timed out · ends in/);
  assert.match(panel.textContent, /@ava/);
  assert.match(panel.textContent, /Joined/);
  assert.equal(panel.querySelectorAll('.member-hero .role-chip').length, 1);

  buttons(panel, /Moderate/)[0].click();
  const tiles = panel.querySelectorAll('.action-tile');
  assert.deepEqual(tiles.map((t) => t.dataset.action), ['warn', 'timeout', 'untimeout', 'kick', 'ban']);
  assert.ok(tiles.every((t) => !t.disabled));
  tiles.find((t) => t.dataset.action === 'kick').click();
  const form = panel.querySelector('.action-form');
  type(form.querySelector('textarea'), 'raiding');
  buttons(form, /Kick Ava/)[0].click();
  await flush();
  const dialog = document.body.querySelector('.dialog-panel');
  assert.match(dialog.textContent, /Kick Ava\?/);
  buttons(dialog, /^Kick$/)[0].click();
  await flush();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].method, 'POST');
  assert.equal(sent[0].path, `/api/servers/${SID}/members/u1/actions`);
  assert.deepEqual(sent[0].body, { action: 'kick', reason: 'raiding' });
  assert.match(toastText(), /Kicked Ava\. Case #13\./);
  assert.equal(changed, 1);
  assert.equal(drawerPanel().querySelectorAll('.member-hero .role-chip').length, 0);
  document.body.querySelector('.drawer-overlay').click();
});

test('a refused member action shows the plain reason and keeps the drawer', async () => {
  state.details.clear();
  setDetail(SID, detail());
  const ctx = makeCtx({
    get: async () => ({ grant: true, member: memberDetail() }),
    job: never,
    run: async () => ({ data: { grant: true, ok: false, error: 'My role needs to be above Ava to time them out.' } }),
  });
  openMemberDrawer(ctx, { id: 'u1', name: 'Ava' }, { tab: 'moderate' });
  await flush();
  const panel = drawerPanel();
  panel.querySelectorAll('.action-tile').find((t) => t.dataset.action === 'timeout').click();
  const form = panel.querySelector('.action-form');
  assert.equal(form.querySelector('.duration-chip.is-active').dataset.value, '1h');
  form.querySelectorAll('.duration-chip').find((c) => c.dataset.value === '1d').click();
  buttons(form, /Timeout Ava/)[0].click();
  await flush();
  assert.match(toastText(), /My role needs to be above Ava/);
  assert.match(drawerPanel().textContent, /Moderate/);
  document.body.querySelector('.drawer-overlay').click();
});

test('the member drawer can unwarn, add roles, set a nickname and add notes', async () => {
  state.details.clear();
  setDetail(SID, detail());
  const bodies = [];
  const ctx = makeCtx({
    get: async () => ({ grant: true, member: memberDetail() }),
    job: never,
    run: async (method, path, body) => {
      bodies.push(body);
      return { data: { grant: true, ok: true, message: 'Done.', member: memberDetail() } };
    },
  });
  openMemberDrawer(ctx, { id: 'u1', name: 'Ava' }, { tab: 'history' });
  await flush();
  buttons(drawerPanel(), /Unwarn/)[0].click();
  await flush();
  assert.deepEqual(bodies.at(-1), { action: 'unwarn', case: 12 });

  buttons(drawerPanel(), /^Roles/)[0].click();
  const panel = drawerPanel();
  const select = panel.querySelector('select');
  assert.deepEqual(select.querySelectorAll('option').map((o) => o.value), ['', 'r-vip']);
  select.value = 'r-vip';
  buttons(panel, /Add role/)[0].click();
  await flush();
  assert.deepEqual(bodies.at(-1), { action: 'role_add', role_id: 'r-vip' });

  drawerPanel().querySelector('.role-remove').click();
  await flush();
  assert.deepEqual(bodies.at(-1), { action: 'role_remove', role_id: 'r-fans' });

  const nick = drawerPanel().querySelector('input[aria-label=Nickname]');
  nick.value = 'Aves';
  buttons(drawerPanel(), /^Save$/)[0].click();
  await flush();
  assert.deepEqual(bodies.at(-1), { action: 'nick', nickname: 'Aves' });

  buttons(drawerPanel(), /^Notes/)[0].click();
  assert.match(drawerPanel().textContent, /Was helpful/);
  drawerPanel().querySelector('textarea').value = 'Keep an eye out';
  buttons(drawerPanel(), /Add note/)[0].click();
  await flush();
  assert.deepEqual(bodies.at(-1), { action: 'note', note: 'Keep an eye out' });
  document.body.querySelector('.drawer-overlay').click();
});

test('a member who left but is banned only offers unban', async () => {
  state.details.clear();
  setDetail(SID, detail());
  const ctx = makeCtx({
    get: async () => ({ grant: true, member: memberDetail({ joined_at: null, roles: [], banned: true, tempBan: { until: new Date(Date.now() + 86400000).toISOString() }, can: { warn: false, timeout: false, kick: false, ban: false, unban: true, role: false, nick: false, note: true } }) }),
    job: never,
    run: never,
  });
  openMemberDrawer(ctx, { id: 'u1', name: 'Ava' }, { tab: 'moderate' });
  await flush();
  const panel = drawerPanel();
  assert.match(panel.textContent, /Banned · ends in/);
  assert.match(panel.textContent, /Not in the server right now/);
  const tiles = panel.querySelectorAll('.action-tile');
  assert.deepEqual(tiles.filter((t) => !t.disabled).map((t) => t.dataset.action), ['unban']);
  document.body.querySelector('.drawer-overlay').click();
});

const TICKETS = [
  { number: 9, status: 'open', name: 'ticket-9', topic: 'Refund please', type: { id: 'b', name: 'Billing', emoji: '💳' }, opener: { id: 'u1', name: 'Ava' }, claimedBy: null, members: 2, createdAt: '2025-03-01T00:00:00Z', closedAt: null, lastActivityAt: null, rating: null, channelId: 'c9' },
  { number: 8, status: 'open', name: 'ticket-8', topic: null, type: null, opener: { id: 'u2', name: 'Ben' }, claimedBy: { id: 'm1', name: 'Mo' }, members: 3, createdAt: '2025-02-01T00:00:00Z', closedAt: null, lastActivityAt: null, rating: 4, channelId: 'c8' },
];

test('the tickets page shows tabs with counts, rows and the rating', async () => {
  state.details.clear();
  window.history.replaceState(null, '', `/servers/${SID}/tickets`);
  const paths = [];
  const ctx = makeCtx({
    get: async (path) => {
      paths.push(path);
      if (path.includes('/tickets')) return { grant: true, tickets: TICKETS, total: 2, page: 1, pages: 1, pageSize: 50, counts: { open: 2, closed: 5 }, rating: { average: 4.25, count: 4 } };
      return detail();
    },
    job: never,
  });
  renderTickets(ctx);
  await flush();
  const rows = ctx.main.querySelectorAll('.ticket-row');
  assert.equal(rows.length, 2);
  assert.match(rows[0].textContent, /#9/);
  assert.match(rows[0].textContent, /Refund please/);
  assert.match(rows[0].textContent, /💳/);
  assert.match(rows[0].textContent, /Unclaimed/);
  assert.match(rows[1].textContent, /Claimed by Mo/);
  assert.equal(rows[1].querySelectorAll('.star.is-on').length, 4);
  const counts = ctx.main.querySelectorAll('.ftab-count').map((c) => c.textContent);
  assert.deepEqual(counts, ['2', '5', '7']);
  assert.match(ctx.main.textContent, /4\.3 from 4 ratings/);
  buttons(ctx.main, /Closed/)[0].click();
  await flush();
  assert.match(window.location.search, /status=closed/);
  assert.ok(paths.some((p) => p.endsWith('/tickets?status=closed')));
  ctx.abort();
});

test('the ticket drawer shows the transcript, downloads it and closes with a reason', async () => {
  state.details.clear();
  window.history.replaceState(null, '', `/servers/${SID}/tickets`);
  const sent = [];
  let ticketReads = 0;
  const ctx = makeCtx({
    get: async (path) => {
      if (/\/tickets\/9$/.test(path)) {
        ticketReads += 1;
        return { grant: true, ticket: { ...TICKETS[0], answers: [{ q: 'Order number?', a: 'A-100' }], reason: null, closedBy: null, people: [{ id: 'u1', name: 'Ava' }] }, transcript: { text: '[10:00] Ava: hi\n[10:01] Mo: hello', count: 2, live: true } };
      }
      if (path.includes('/tickets')) return { grant: true, tickets: TICKETS, total: 2, page: 1, pages: 1, counts: { open: 2, closed: 0 }, rating: { average: null, count: 0 } };
      return detail();
    },
    job: never,
    run: async (method, path, body) => {
      sent.push({ path, body });
      return { data: { grant: true, ok: true, message: 'Ticket #9 is closing.', ticket: { ...TICKETS[0], status: 'closing' } } };
    },
  });
  renderTickets(ctx);
  await flush();
  ctx.main.querySelectorAll('.ticket-row')[0].click();
  await flush();
  const panel = drawerPanel();
  assert.match(panel.textContent, /Order number\?/);
  assert.match(panel.textContent, /A-100/);
  assert.match(panel.textContent, /Live · 2 messages/);
  assert.match(panel.querySelector('.transcript-text').textContent, /Mo: hello/);

  const made = [];
  const original = URL.createObjectURL;
  URL.createObjectURL = (blob) => {
    made.push(blob);
    return 'blob:test/9';
  };
  let link = null;
  const grab = (e) => { if (e.target.localName === 'a') link = e.target; };
  document.body.addEventListener('click', grab);
  try {
    buttons(panel, /Download/)[0].click();
  } finally {
    URL.createObjectURL = original;
    document.body.removeEventListener('click', grab);
  }
  assert.equal(made.length, 1);
  assert.equal(link.getAttribute('download'), 'ticket-9.txt');
  assert.equal(await made[0].text(), '[10:00] Ava: hi\n[10:01] Mo: hello');

  assert.equal(buttons(panel, /^Claim$/).length, 1);
  type(panel.querySelector('.ticket-actions textarea'), 'sorted');
  buttons(panel, /Close ticket/)[0].click();
  await flush();
  const dialog = document.body.querySelector('.dialog-panel');
  assert.match(dialog.textContent, /Close this ticket\?/);
  buttons(dialog, /Close ticket/)[0].click();
  await flush();
  assert.deepEqual(sent[0], { path: `/api/servers/${SID}/tickets/9/actions`, body: { action: 'close', reason: 'sorted' } });
  assert.match(toastText(), /Ticket #9 is closing\./);
  assert.equal(ticketReads, 2);
  document.body.querySelector('.drawer-overlay').click();
  ctx.abort();
});

test('the moderation page shows stats, the chart, the breakdown and runs a quick warn', async () => {
  state.details.clear();
  window.history.replaceState(null, '', `/servers/${SID}/mod`);
  const days = Array.from({ length: 14 }, (_, i) => ({ day: `2026-03-${String(i + 1).padStart(2, '0')}`, count: i === 13 ? 4 : i % 2 }));
  const sent = [];
  const ctx = makeCtx({
    get: async (path) => {
      if (path.includes('/members')) return { grant: true, members: [{ id: 'u1', name: 'Ava', username: 'ava', roles: [] }], total: 1, page: 1, pages: 1 };
      return detail({
        stats: { casesByDay: days, casesByType: { warn: 6, ban: 2 }, activeWarns: 3, activeTimeouts: null, tempBans: 1, tickets: { open: 1, closed7d: 2 }, newMembers7d: 4 },
        recent: [{ n: 5, type: 'ban', user: { id: 'u2', name: 'Ben' }, mod: { id: 'm1', name: 'Mo' }, reason: 'raid', at: Date.now() }],
      });
    },
    job: never,
    run: async (method, path, body) => {
      sent.push({ path, body });
      return { data: { grant: true, ok: true, message: 'Warned Ava. Case #6.', member: {} } };
    },
  });
  renderMod(ctx);
  await flush();
  const values = ctx.main.querySelectorAll('.stat-value').map((v) => v.textContent);
  assert.deepEqual(values, ['8', '3', '–', '1']);
  assert.match(ctx.main.textContent, /Not tracked yet/);
  assert.equal(ctx.main.querySelectorAll('.bar').length, 14);
  assert.equal(ctx.main.querySelectorAll('.bar')[13].style.props['--h'], '100%');
  assert.deepEqual(ctx.main.querySelectorAll('.type-bar-count').map((c) => c.textContent), ['6 · 75%', '2 · 25%']);
  assert.match(ctx.main.textContent, /Ben/);
  assert.ok(ctx.main.querySelector(`a[href="/servers/${SID}/cases"]`));

  const quick = ctx.main.querySelector('.quick-card');
  assert.equal(buttons(quick, /^Warn$/).find((b) => b.classList.contains('btn-primary')).disabled, true);
  type(quick.querySelector('input[type=search]'), 'av');
  await wait(650);
  await flush();
  quick.querySelector('.quick-result').click();
  assert.match(quick.textContent, /@ava/);
  type(quick.querySelectorAll('textarea')[0], 'spam');
  buttons(quick, /Warn Ava/)[0].click();
  await flush();
  assert.deepEqual(sent[0], { path: `/api/servers/${SID}/members/u1/actions`, body: { action: 'warn', reason: 'spam' } });
  assert.match(toastText(), /Warned Ava\. Case #6\./);

  quick.querySelectorAll('.quick-actions button').find((b) => b.dataset.action === 'timeout').click();
  assert.ok(quick.querySelector('.duration-picker'));
  ctx.abort();
});

test('the drawer lists only roles the moderator can give, and Unwarn follows can.unwarn', async () => {
  state.details.clear();
  setDetail(SID, detail());
  const m = memberDetail({ assignable: [], can: { warn: false, unwarn: true, timeout: false, kick: false, ban: false, unban: false, role: true, nick: false, note: true } });
  const ctx = makeCtx({ get: async () => ({ grant: true, member: m }), job: never });
  const d = openMemberDrawer(ctx, { id: 'u1', name: 'Ava' }, { tab: 'history' });
  await flush();
  assert.equal(buttons(drawerPanel(), /Unwarn/).length, 1, 'a mod can remove a warning even when a new warn is blocked');
  buttons(drawerPanel(), /^Roles/)[0].click();
  assert.deepEqual(drawerPanel().querySelector('select').querySelectorAll('option').map((o) => o.value), ['']);
  assert.match(drawerPanel().textContent, /No roles you can give/);
  ctx.abort();
  await flush();
  assert.ok(!document.body.querySelector('.drawer-root') || document.body.querySelector('.drawer-root').classList.contains('is-closing'), 'leaving the page closes the drawer');
  d?.close?.();
});
