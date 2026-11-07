import { defineApp } from '../engine/apps.js';
import { card, dialog, button, row, rows, select, ICONS } from '../engine/ui.js';
import { customId } from '../engine/router.js';
import { didYouMean, fuzzyFind, clip } from '../engine/parse.js';
import { friendly, explain, permName, looksLikeFeatureOff } from '../engine/errors.js';

const ID = 'roles';
const cid = (action, ...args) => customId(ID, action, ...args);
const MAX_ITEMS = 25;
const PAGE = 20;
const TYPES = { buttons: 'Buttons', dropdown: 'Dropdown', reactions: 'Reactions' };
const MODES = { toggle: 'Toggle', unique: 'Pick one', add: 'Add only' };
const MODE_HELP = { toggle: 'click again to remove', unique: 'only one role from this menu at a time', add: 'roles are only given, never taken back' };
const TYPE_WORDS = { buttons: 'buttons', button: 'buttons', btn: 'buttons', dropdown: 'dropdown', select: 'dropdown', menu: 'dropdown', list: 'dropdown', reactions: 'reactions', reaction: 'reactions', react: 'reactions', emoji: 'reactions', emojis: 'reactions' };
const MODE_WORDS = { toggle: 'toggle', normal: 'toggle', unique: 'unique', one: 'unique', single: 'unique', pickone: 'unique', add: 'add', addonly: 'add', verify: 'add', verification: 'add', give: 'add' };
const SUBS = { new: 'new', create: 'new', make: 'new', list: 'list', menus: 'list', all: 'list', add: 'add', remove: 'remove', rm: 'remove', take: 'remove', post: 'post', send: 'post', publish: 'post', update: 'post', type: 'type', style: 'type', mode: 'mode', preview: 'preview', show: 'open', open: 'open', edit: 'open', delete: 'delete', del: 'delete', help: 'help' };
const EMOJI_RE = /^(?:<a?:\w+:[\w-]+>|(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[0-9#*]️?⃣)[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}️‍⃣]*)$/u;

const blank = () => ({ menus: {}, seq: 0, notices: [] });
const data = (engine, sid) => engine.store.get(ID, sid, blank());
const getMenu = (engine, sid, mid) => (mid && data(engine, sid).menus?.[mid]) || null;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const isEmoji = (t) => EMOJI_RE.test(String(t ?? '').trim());
const liveItems = (menu) => (menu?.items || []).map((item, idx) => ({ item, idx })).filter((x) => x.item);
const botId = (engine) => engine.bot.me?.id;

function saveMenu(engine, sid, mid, menu) {
  engine.store.update(ID, sid, (d) => { d.menus ||= {}; d.menus[mid] = menu; return d; }, blank());
  return menu;
}

function changeMenu(engine, sid, mid, fn) {
  const menu = getMenu(engine, sid, mid);
  if (!menu) return null;
  fn(menu);
  if (menu.messageId) menu.dirty = true;
  return saveMenu(engine, sid, mid, menu);
}

function dropMenu(engine, sid, mid) {
  engine.store.update(ID, sid, (d) => { if (d.menus) delete d.menus[mid]; return d; }, blank());
}

function createMenu(engine, sid, { title, description = '', type = 'buttons', mode = 'toggle', items = [] }) {
  let mid = null;
  engine.store.update(ID, sid, (d) => {
    d.menus ||= {};
    d.seq = (d.seq || 0) + 1;
    mid = `m${d.seq}`;
    d.menus[mid] = { title: clip(title || 'Pick your roles', 100), description: clip(description || '', 1000), type, mode, channelId: null, messageId: null, postedAs: null, dirty: false, items };
    return d;
  }, blank());
  return mid;
}

const pendingKey = (sid, uid) => `form:${sid}:${uid}`;
const setPending = (engine, sid, uid, value) => engine.store.set(ID, pendingKey(sid, uid), { ...value, at: Date.now() });
function takePending(engine, sid, uid, kind) {
  const p = engine.store.get(ID, pendingKey(sid, uid), null);
  if (!p || p.kind !== kind || Date.now() - p.at > 30 * 60_000) return null;
  engine.store.delete(ID, pendingKey(sid, uid));
  return p;
}

const isEveryone = (r, sid) => /^@?everyone$/i.test(r.name) || r.id === 'everyone' || r.id === sid;
const isAuto = (r) => !!r.auto && r.auto !== 'none';
const STAFF_PERMS = ['administrator', 'manage_server', 'manage_roles', 'manage_channels', 'manage_messages', 'manage_webhooks', 'manage_emojis', 'manage_events', 'manage_nicknames', 'kick_members', 'ban_members', 'timeout_members', 'move_members', 'mute_members', 'mention_everyone', 'view_audit_log'];
const staffPerms = (r) => STAFF_PERMS.filter((k) => r?.perms?.[k] || r?.[k] === true);
const staffList = (r) => staffPerms(r).map((k) => permName(k)).join(', ');

async function actorTop(engine, sid, actorId) {
  if (!actorId) return Infinity;
  const s = await engine.perms.server(sid).catch(() => null);
  if (s?.owner_id === actorId) return Infinity;
  return engine.perms.topPosition(sid, actorId);
}

async function roleMapOf(engine, sid) {
  const all = await engine.perms.roles(sid).catch(() => []);
  return new Map(all.map((r) => [r.id, r]));
}

async function manageableRoles(engine, sid, actorId) {
  const all = await engine.perms.roles(sid);
  const top = Math.min(await engine.perms.topPosition(sid, botId(engine)), await actorTop(engine, sid, actorId));
  return all
    .filter((r) => !isEveryone(r, sid) && !isAuto(r) && !staffPerms(r).length && typeof r.position === 'number' && r.position < top)
    .sort((a, b) => b.position - a.position);
}

async function textChannels(engine, sid) {
  const all = await engine.cache.channels(sid).catch(() => []);
  return all.filter((c) => c.type === 'text' || c.kind === 'text');
}

async function channelName(engine, sid, chId) {
  const c = (await textChannels(engine, sid)).find((x) => x.id === chId);
  return c ? `#${c.name}` : 'that channel';
}

function sameEmoji(a, b) {
  const norm = (e) => String(e ?? '').replace(/️/g, '').trim();
  const idOf = (e) => /:(\d+|[\w-]{8,})>?$/.exec(String(e ?? ''))?.[1];
  if (!a || !b) return false;
  if (norm(a) === norm(b)) return true;
  const ia = idOf(a);
  return !!ia && ia === idOf(b);
}

async function notifyAdmins(engine, sid, key, text) {
  let fresh = false;
  engine.store.update(ID, sid, (d) => {
    d.notices ||= [];
    if (d.notices.some((n) => n.key === key)) return d;
    fresh = true;
    d.notices.push({ key, text, at: Date.now() });
    d.notices = d.notices.slice(-10);
    return d;
  }, blank());
  if (!fresh) return;
  const embed = dialog.warn('Role menu needs a look', `${text}\n\n-# Open **/roles** to fix it.`);
  const mod = engine.service('mod');
  if (mod?.log) {
    try { await mod.log(sid, embed); return; } catch (e) { engine.log.debug('mod log failed', e?.message); }
  }
  const logChannel = engine.settings.core(sid).logChannel;
  if (logChannel) engine.budget.send({ serverId: sid, channelId: logChannel, content: '', opts: { embeds: [embed] }, priority: 'low' }).catch((e) => engine.log.debug('roles notice failed', e?.message));
}

function footerFor(menu, as) {
  if (as === 'reactions') return { toggle: 'React to get a role. Remove your reaction to drop it.', unique: 'React to get a role. You can hold one role from this menu.', add: 'React to get a role.' }[menu.mode];
  const verb = as === 'dropdown' ? 'Pick' : 'Click';
  return { toggle: `${verb} a role to get it. ${verb} it again to remove it.`, unique: `${verb} a role to get it. You can hold one role from this menu.`, add: `${verb} a role to get it.` }[menu.mode];
}

function menuEmbed(menu, as) {
  const lines = liveItems(menu).map(({ item }) => `${item.emoji ? `${item.emoji} ` : '• '}**${item.label}**`);
  const body = [menu.description, lines.join('\n')].filter(Boolean).join('\n\n');
  return card({ title: `${ICONS.roles} ${menu.title}`, body, color: 'roles', footer: footerFor(menu, as) });
}

function buttonRows(mid, menu, { disabled = false } = {}) {
  return rows(liveItems(menu).slice(0, MAX_ITEMS).map(({ item, idx }) => button(item.label, cid('p', mid, idx), 'secondary', item.emoji || undefined, { disabled })));
}

function dropdownRow(mid, menu, { disabled = false } = {}) {
  const live = liveItems(menu).slice(0, MAX_ITEMS);
  const options = live.map(({ item, idx }) => ({ label: item.label, value: String(idx), ...(item.emoji ? { emoji: item.emoji } : {}) }));
  return select(cid('d', mid), options, { placeholder: menu.mode === 'unique' ? 'Pick a role' : 'Pick your roles', min: 1, max: menu.mode === 'unique' ? 1 : options.length, disabled });
}

function render(mid, menu, as, opts) {
  const embeds = [menuEmbed(menu, as)];
  if (as === 'reactions') return { embeds, components: [] };
  if (as === 'dropdown') return { embeds, components: [dropdownRow(mid, menu, opts)] };
  return { embeds, components: buttonRows(mid, menu, opts) };
}

async function postMenu(engine, sid, mid, channelId) {
  engine.perms.invalidate(`r:${sid}`);
  const roleMap = await roleMapOf(engine, sid);
  const menu = getMenu(engine, sid, mid);
  if (!menu) throw friendly("That menu doesn't exist anymore.", { title: 'Menu not found' });
  const notes = new Set();
  const gone = liveItems(menu).filter(({ item }) => !roleMap.has(item.roleId));
  if (gone.length) notes.add(`Skipped ${plural(gone.length, 'deleted role')} (${gone.map(({ item }) => `**${item.label}**`).join(', ')}) and took ${gone.length === 1 ? 'it' : 'them'} off this menu.`);
  menu.items = menu.items.map((item) => (item && roleMap.has(item.roleId) ? item : null));
  const current = liveItems(menu).map(({ item }) => item);
  if (!current.length) throw friendly('This menu has no roles yet. Add some with **Add roles** first.', { title: 'Nothing to post' });
  if (menu.type === 'reactions') {
    const bare = current.filter((i) => !i.emoji);
    if (bare.length) throw friendly(`Reaction menus need an emoji on every role. Missing: ${bare.map((i) => `**${i.label}**`).join(', ')}.\nSet them with **Edit roles**.`, { title: 'Emojis needed' });
    const seen = new Set();
    const dupes = current.filter((i) => { const k = String(i.emoji).replace(/️/g, ''); if (seen.has(k)) return true; seen.add(k); return false; });
    if (dupes.length) throw friendly(`Two roles share the emoji ${dupes[0].emoji}. Each role needs its own emoji in a reaction menu.`, { title: 'Emojis must be different' });
  }

  const sameSpot = !!menu.messageId && menu.channelId === channelId;
  const deliver = async (payload) => {
    if (sameSpot) {
      try {
        return await engine.bot.edit(channelId, menu.messageId, '', { embeds: payload.embeds, components: payload.components });
      } catch (e) {
        if (e?.status !== 404) throw e;
        notes.add('The old post was gone, so I posted a fresh one.');
      }
    }
    return engine.budget.send({ serverId: sid, channelId, content: '', opts: { embeds: payload.embeds, components: payload.components }, priority: 'normal' });
  };

  let as = menu.type;
  let message;
  if (menu.type === 'dropdown') {
    message = await engine.caps.attempt(sid, 'selects', () => deliver(render(mid, menu, 'dropdown')), () => {
      as = 'buttons';
      notes.add("Dropdown menus aren't turned on for this server yet (they're still in testing on Yapin'), so I posted it as buttons instead. It works the same way.");
      return deliver(render(mid, menu, 'buttons'));
    });
  } else {
    message = await deliver(render(mid, menu, as));
  }
  if (!message?.id) throw friendly("Yapin' didn't confirm the post. Try again in a moment.", { title: "Couldn't post the menu" });

  const old = { channelId: menu.channelId, messageId: menu.messageId, postedAs: menu.postedAs };
  const sameMessage = !!old.messageId && old.messageId === message.id;
  const prevReacted = !sameMessage ? [] : Array.isArray(menu.reacted) ? menu.reacted : old.postedAs === 'reactions' ? current.map((i) => i.emoji).filter(Boolean) : [];
  if (old.messageId && !sameMessage) {
    await engine.bot.delete(old.channelId, old.messageId).catch(() => notes.add("I couldn't take down the old post. You can delete it by hand."));
  }
  const wanted = as === 'reactions' ? current.map((i) => i.emoji) : [];
  for (const e of prevReacted) {
    if (!wanted.some((w) => sameEmoji(w, e))) await engine.bot.unreact(channelId, message.id, e).catch((err) => engine.log.debug('unreact failed', err?.message));
  }

  const reacted = [];
  if (as === 'reactions') {
    const failed = [];
    for (const emoji of wanted) {
      if (prevReacted.some((e) => sameEmoji(e, emoji))) { reacted.push(emoji); continue; }
      try { await engine.bot.react(channelId, message.id, emoji); reacted.push(emoji); } catch { failed.push(emoji); }
    }
    if (failed.length) notes.add(`I couldn't add these reactions: ${failed.join(' ')}. Custom emojis must come from a server I'm in. People can still add them themselves.`);
  }

  Object.assign(menu, { channelId, messageId: message.id, postedAs: as, dirty: false, reacted });
  saveMenu(engine, sid, mid, menu);
  const where = await channelName(engine, sid, channelId);
  return { as, note: [`${ICONS.ok} ${sameSpot && message.id === old.messageId ? 'Updated the post' : 'Posted'} in **${where}**.`, ...notes].join('\n') };
}

function refusal(check, roleName, botRole) {
  const r = String(check.reason || '');
  if (check.kind === 'feature') return { kind: 'feature', text: "Giving out roles isn't turned on for this server yet (it's still in testing on Yapin'), so I couldn't change your roles. I've let the admins know." };
  if (check.kind === 'staff') return { kind: 'staff', text: `**@${roleName}** has staff permissions, so I won't hand it out from a menu. I've let the admins know.` };
  if (/exist/i.test(r)) return { kind: 'deleted', text: 'That role was deleted, so I can\'t give it out. I\'ve let the admins know.' };
  if (/automatic/i.test(r)) return { kind: 'auto', text: `**@${roleName}** is given out automatically, so it can't be picked here.` };
  if (/needs/i.test(r)) return { kind: 'perm', text: "I'm missing the **Manage Roles** permission, so I can't change roles right now. I've let the admins know." };
  return { kind: 'high', text: `I can't give out **@${roleName}** because it's above my role. An admin needs to drag my role (**${botRole}**) above it in Server settings → Roles. I've let them know.` };
}

async function refuse(engine, sid, mid, idx, item, check) {
  const botRole = await engine.perms.botRoleName(sid).catch(() => 'YapOS');
  const roleName = check.role?.name || item.label;
  const { kind, text } = refusal(check, roleName, botRole);
  const menu = getMenu(engine, sid, mid);
  const title = menu?.title || mid;
  const notify = (key, msg) => { notifyAdmins(engine, sid, key, msg).catch((e) => engine.log.debug('roles notice failed', e?.message)); };
  if (kind === 'deleted') {
    changeMenu(engine, sid, mid, (m) => { if (m.items[idx]) m.items[idx].missing = true; });
    notify(`deleted:${mid}:${item.roleId}`, `The role behind **${item.label}** on the **${title}** menu was deleted. People clicking it get nothing. Remove it or press **Update post** to skip it.`);
  } else if (kind === 'high') {
    notify(`high:${item.roleId}`, `I can't hand out **@${roleName}** from the **${title}** menu because it's above my role (**${botRole}**). Drag my role higher in Server settings → Roles.`);
  } else if (kind === 'perm') {
    notify('perm', `My role (**${botRole}**) is missing **Manage Roles**, so role menus can't give out roles.`);
  } else if (kind === 'feature') {
    notify('feature', "Yapin' turned down a role change because role management is still in testing for this server, so role menus can't give out roles yet. They'll start working once it's turned on.");
  } else if (kind === 'staff') {
    notify(`staff:${item.roleId}`, `**@${roleName}** on the **${title}** menu has staff permissions (${staffList(check.role)}), so I stopped handing it out. Take it off the menu, or remove those permissions from the role.`);
  }
  return { problem: text };
}

async function checkRole(engine, sid, roleId) {
  let check = await engine.perms.canManageRole(sid, roleId);
  if (!check.ok) {
    engine.perms.invalidate(`r:${sid}`);
    check = await engine.perms.canManageRole(sid, roleId);
  }
  return check;
}

async function changeRole(engine, sid, uid, mid, idx, intent) {
  const menu = getMenu(engine, sid, mid);
  if (!menu) return { problem: 'This role menu was deleted. Ask an admin if you need a role.' };
  const item = menu.items[idx];
  if (!item) return { problem: 'This button is out of date. An admin can press **Update post** in **/roles** to refresh it.' };
  const check = await checkRole(engine, sid, item.roleId);
  if (!check.ok) return refuse(engine, sid, mid, idx, item, check);
  const role = check.role;
  if (staffPerms(role).length) return refuse(engine, sid, mid, idx, item, { kind: 'staff', role });
  let member;
  try { member = await engine.bot.member(sid, uid); } catch (e) { if (e?.status === 404) return { problem: "I couldn't find you in this server." }; throw e; }
  const mine = new Set(member?.roles || []);
  const has = mine.has(role.id);
  const want = intent === 'remove' ? false : intent === 'add' ? true : !has;
  if (!want && menu.mode === 'add') return { info: `You already have **@${role.name}**. This menu only gives roles, so ask an admin if you want it taken off.` };
  if (want === has) return { info: want ? `You already have **@${role.name}**.` : `You don't have **@${role.name}**.` };
  const removed = [];
  try {
    if (want && menu.mode === 'unique') {
      for (const other of menu.items) {
        if (!other || other.roleId === role.id || !mine.has(other.roleId)) continue;
        const ok = await engine.perms.canManageRole(sid, other.roleId);
        if (!ok.ok || staffPerms(ok.role).length) continue;
        await engine.bot.removeRole(sid, uid, other.roleId);
        removed.push(ok.role.name);
      }
    }
    if (want) await engine.bot.addRole(sid, uid, role.id);
    else await engine.bot.removeRole(sid, uid, role.id);
  } catch (e) {
    const withRemoved = (r) => ({ ...r, removed });
    if (looksLikeFeatureOff(e)) {
      engine.caps.mark(sid, 'roles', false, e?.message);
      return withRemoved(await refuse(engine, sid, mid, idx, item, { kind: 'feature', role }));
    }
    if (e?.status === 404 || e?.status === 403) {
      engine.perms.invalidate(`r:${sid}`);
      const again = await engine.perms.canManageRole(sid, item.roleId);
      if (!again.ok) return withRemoved(await refuse(engine, sid, mid, idx, item, again));
      if (e.status === 403) return withRemoved(await refuse(engine, sid, mid, idx, item, { reason: 'above', role }));
    }
    throw e;
  } finally {
    engine.perms.invalidate(`m:${sid}:${uid}`);
  }
  return want ? { added: role.name, removed } : { removed: [role.name] };
}

function pickText(results) {
  const lines = [];
  for (const r of results) {
    if (r.added) lines.push(`${ICONS.ok} Added **@${r.added}**`);
    for (const name of r.removed || []) lines.push(`➖ Removed **@${name}**`);
    if (r.info) lines.push(`${ICONS.info} ${r.info}`);
    if (r.problem) lines.push(`${ICONS.warn} ${r.problem}`);
  }
  return lines.join('\n') || 'Nothing changed.';
}

function isLive(ctx) { return typeof ctx.source.update === 'function' && (ctx.kind === 'button' || ctx.kind === 'select'); }

function show(ctx, view) {
  if (isLive(ctx)) return ctx.update(view);
  if (typeof ctx.source.ack === 'function') return ctx.ephemeral(view);
  return ctx.reply(view);
}

function showSel(ctx, view) {
  const { fallbackComponents, ...main } = view;
  if (!fallbackComponents) return show(ctx, main);
  return ctx.engine.caps.attempt(ctx.serverId, 'selects', () => show(ctx, main), () => show(ctx, { ...main, components: fallbackComponents }));
}

const backHome = () => button('All menus', cid('home'), 'secondary', '⬅️');
const backMenu = (mid) => button('Back', cid('open', mid), 'secondary', '⬅️');

async function homeView(engine, sid, note) {
  const d = data(engine, sid);
  const list = Object.entries(d.menus || {});
  const lines = list.map(([mid, m]) => `\`${mid}\` **${m.title}**: ${plural(liveItems(m).length, 'role')} · ${TYPES[m.type]} · ${MODES[m.mode]} · ${m.messageId ? `posted in <#${m.channelId}>` : 'draft'}`);
  const intro = 'Role menus let people pick their own roles with a click.';
  const body = [note, intro, lines.length ? lines.join('\n') : 'No role menus yet. Press **New menu** to make one.'].filter(Boolean).join('\n\n');
  const notices = (d.notices || []).slice(-3).map((n) => `• ${n.text}`).join('\n');
  const fields = notices ? [{ name: `${ICONS.warn} Needs a look`, value: notices }] : [];
  const opens = list.slice(0, 15).map(([mid, m]) => button(m.title, cid('open', mid), 'secondary', ICONS.roles));
  const tail = [button('New menu', cid('new'), 'primary', '➕')];
  if (notices) tail.push(button('Clear notes', cid('clear'), 'secondary', '🧹'));
  return {
    embeds: [card({ title: `${ICONS.roles} Role menus`, body, fields, color: 'roles', footer: 'Shortcuts: /roles new · /roles add m1 @Gamer 🎮 Gamers · /roles post m1 #get-roles' })],
    components: [...rows(opens).slice(0, 3), row(tail)],
  };
}

async function editorView(engine, sid, mid, note, extra = []) {
  const menu = getMenu(engine, sid, mid);
  if (!menu) return { embeds: [dialog.warn('Menu not found', 'It may have been deleted. Open **/roles** to see your menus.')], components: [row(backHome())] };
  const roleMap = await roleMapOf(engine, sid);
  const live = liveItems(menu);
  const lines = live.map(({ item }, n) => {
    const role = roleMap.get(item.roleId);
    const tag = !role ? ` ${ICONS.warn} role was deleted, it will be skipped` : role.name !== item.label ? ` (@${role.name})` : '';
    return `${n + 1}. ${item.emoji ? `${item.emoji} ` : ''}**${item.label}**${tag}`;
  });
  const status = menu.messageId
    ? `Posted in <#${menu.channelId}>${menu.postedAs && menu.postedAs !== menu.type ? ` as ${TYPES[menu.postedAs].toLowerCase()}` : ''}${menu.dirty ? `\n${ICONS.warn} You changed things since posting. Press **Update post** to apply them.` : ''}`
    : 'Draft, not posted yet';
  const fields = [
    { name: `Roles (${live.length}/${MAX_ITEMS})`, value: lines.join('\n') || 'None yet. Press **Add roles**.' },
    { name: 'Type', value: TYPES[menu.type], inline: true },
    { name: 'Mode', value: `${MODES[menu.mode]}: ${MODE_HELP[menu.mode]}`, inline: true },
    { name: 'Status', value: status },
  ];
  const body = [note, menu.description || '*No description.*'].filter(Boolean).join('\n\n');
  const full = live.length >= MAX_ITEMS;
  return {
    embeds: [card({ title: `${ICONS.roles} ${menu.title}`, body, fields, color: 'roles', footer: `Menu id ${mid} · typed: /roles add ${mid} @role 🎮 Label` })],
    components: [
      row(
        button('Add roles', cid('add', mid, 0), 'primary', '➕', { disabled: full }),
        button('Edit roles', cid('items', mid, 0), 'secondary', '✏️', { disabled: !live.length }),
        button('Edit text', cid('text', mid), 'secondary', '📝'),
      ),
      row(Object.entries(TYPES).map(([t, label]) => button(label, cid('type', mid, t), menu.type === t ? 'success' : 'secondary'))),
      row(Object.entries(MODES).map(([m, label]) => button(label, cid('mode', mid, m), menu.mode === m ? 'success' : 'secondary'))),
      row(
        button('Preview', cid('preview', mid), 'secondary', '👀', { disabled: !live.length }),
        button(menu.messageId ? 'Update post' : 'Post', cid('post', mid), 'success', '📌', { disabled: !live.length }),
        button('Delete', cid('del', mid), 'danger', '🗑️'),
        backHome(),
      ),
      ...(extra.length ? [row(extra)] : []),
    ],
  };
}

async function pickerView(engine, sid, sess, page = 0, note) {
  const s = engine.router.getSession(sess);
  if (!s) return { embeds: [dialog.warn('This picker expired', 'Open the menu again from **/roles**.')], components: [row(backHome())] };
  const menu = getMenu(engine, sid, s.mid);
  if (!menu) return editorView(engine, sid, s.mid);
  const roleMap = await roleMapOf(engine, sid);
  const taken = new Set(liveItems(menu).map(({ item }) => item.roleId));
  const room = MAX_ITEMS - taken.size;
  const avail = s.roleIds.map((id, i) => ({ role: roleMap.get(id), i })).filter((x) => x.role && !taken.has(x.role.id));
  const pages = Math.max(1, Math.ceil(avail.length / PAGE));
  const p = Math.min(Math.max(0, Number(page) || 0), pages - 1);
  const slice = avail.slice(p * PAGE, p * PAGE + PAGE);
  const can = await engine.perms.botCan(sid, 'manage_roles');
  const botRole = await engine.perms.botRoleName(sid).catch(() => 'YapOS');
  const tips = [];
  if (!can.ok) tips.push(`${ICONS.warn} My role needs **Manage Roles** before these menus can give out roles.`);
  if (!avail.length) tips.push(`There are no more roles I can hand out. I can only use roles below my role (**${botRole}**) and yours, and never @everyone, automatic roles or roles with staff permissions. Make a new role, or drag my role higher in Server settings → Roles.`);
  else if (room <= 0) tips.push(`This menu is full (${MAX_ITEMS} roles).`);
  else tips.push(`Pick the roles to add. Roles above my role (**${botRole}**) or yours, roles with staff permissions, automatic roles and @everyone are hidden.${pages > 1 ? `\nPage ${p + 1} of ${pages}.` : ''}`);
  tips.push(`-# Or type: /roles add ${s.mid} @role 🎮 Label`);
  const nav = [];
  if (p > 0) nav.push(button('Previous', cid('addpg', sess, p - 1), 'secondary', '◀️'));
  if (p < pages - 1) nav.push(button('Next', cid('addpg', sess, p + 1), 'secondary', '▶️'));
  nav.push(button('Done', cid('open', s.mid), 'success', '✅'));
  const embeds = [card({ title: `➕ Add roles to ${menu.title}`, body: [note, ...tips].filter(Boolean).join('\n\n'), color: 'roles' })];
  if (!slice.length || room <= 0) return { embeds, components: [row(nav)] };
  const options = slice.map(({ role, i }) => ({ label: role.name, value: String(i) }));
  return {
    embeds,
    components: [select(cid('addsel', sess), options, { placeholder: 'Pick roles to add', min: 1, max: Math.min(options.length, room) }), row(nav)],
    fallbackComponents: [...rows(slice.map(({ role, i }) => button(role.name, cid('addbtn', sess, i), 'secondary'))).slice(0, 4), row(nav)],
  };
}

async function addRolesToMenu(engine, sid, mid, roles, extras = {}, actorId = null) {
  const added = [];
  const skipped = [];
  const menu = getMenu(engine, sid, mid);
  if (!menu) throw friendly("That menu doesn't exist anymore.", { title: 'Menu not found' });
  const myTop = await actorTop(engine, sid, actorId);
  for (const role of roles) {
    if (liveItems(menu).length >= MAX_ITEMS) { skipped.push(`**${role.name}**: the menu is full (${MAX_ITEMS} roles)`); continue; }
    if (liveItems(menu).some(({ item }) => item.roleId === role.id)) { skipped.push(`**${role.name}** is already on this menu`); continue; }
    if (isEveryone(role, sid)) { skipped.push('@everyone can\'t go on a menu'); continue; }
    const check = await engine.perms.canManageRole(sid, role.id);
    if (!check.ok) { skipped.push(check.reason); continue; }
    if (staffPerms(role).length) { skipped.push(`**${role.name}** has staff permissions (${staffList(role)}), so anyone clicking the menu would get them. Use a role without those permissions`); continue; }
    if (typeof role.position === 'number' && role.position >= myTop) { skipped.push(`**${role.name}** is at or above your highest role, so you can't hand it out`); continue; }
    menu.items.push({ roleId: role.id, emoji: extras.emoji || null, label: clip(extras.label || role.name, 80) });
    added.push(role.name);
  }
  if (added.length) {
    if (menu.messageId) menu.dirty = true;
    saveMenu(engine, sid, mid, menu);
  }
  const parts = [];
  if (added.length) parts.push(`${ICONS.ok} Added ${added.map((n) => `**${n}**`).join(', ')}.`);
  if (skipped.length) parts.push(`${ICONS.warn} Skipped: ${skipped.join('; ')}`);
  return { added, note: parts.join('\n') };
}

async function itemsView(engine, sid, mid, page = 0) {
  const menu = getMenu(engine, sid, mid);
  if (!menu) return editorView(engine, sid, mid);
  const live = liveItems(menu);
  const pages = Math.max(1, Math.ceil(live.length / PAGE));
  const p = Math.min(Math.max(0, Number(page) || 0), pages - 1);
  const btns = live.slice(p * PAGE, p * PAGE + PAGE).map(({ item, idx }) => button(item.label, cid('item', mid, idx), 'secondary', item.emoji || undefined));
  const nav = [];
  if (p > 0) nav.push(button('Previous', cid('items', mid, p - 1), 'secondary', '◀️'));
  if (p < pages - 1) nav.push(button('Next', cid('items', mid, p + 1), 'secondary', '▶️'));
  nav.push(backMenu(mid));
  return {
    embeds: [card({ title: `✏️ Edit roles on ${menu.title}`, body: live.length ? 'Pick a role to change its emoji or label, or to take it off the menu.' : 'This menu has no roles yet.', color: 'roles' })],
    components: [...rows(btns).slice(0, 4), row(nav)],
  };
}

async function itemView(engine, sid, mid, idx, note) {
  const menu = getMenu(engine, sid, mid);
  const item = menu?.items?.[idx];
  if (!item) return editorView(engine, sid, mid, `${ICONS.warn} That role isn't on the menu anymore.`);
  const role = (await roleMapOf(engine, sid)).get(item.roleId);
  const body = [note, `Role: ${role ? `**@${role.name}**` : `${ICONS.warn} deleted`}`, `Emoji: ${item.emoji || 'none'}`, `Label: **${item.label}**`].filter(Boolean).join('\n');
  return {
    embeds: [card({ title: `✏️ ${item.label}`, body, color: 'roles' })],
    components: [row(
      button('Emoji & label', cid('itemform', mid, idx), 'primary', '😀'),
      button('Remove from menu', cid('unitem', mid, idx), 'danger', '➖'),
      button('Back', cid('items', mid, 0), 'secondary', '⬅️'),
    )],
  };
}

async function channelPicker(engine, sid, mid, note) {
  const menu = getMenu(engine, sid, mid);
  if (!menu) return editorView(engine, sid, mid);
  const chans = await textChannels(engine, sid);
  const detected = (await engine.detectChannels(sid).catch(() => ({}))).roles || null;
  const ordered = detected ? [detected, ...chans.filter((c) => c.id !== detected.id)] : chans;
  const sess = engine.router.session({ mid, channelIds: ordered.map((c) => c.id) });
  const body = [note, `Where should **${menu.title}** go?${detected ? ` I'd suggest **#${detected.name}**.` : ''}`, `-# Or type: /roles post ${mid} #channel`].filter(Boolean).join('\n\n');
  const embeds = [card({ title: '📌 Post the menu', body, color: 'roles' })];
  const back = backMenu(mid);
  if (!ordered.length) return { embeds: [dialog.warn('No channels', "I can't see any text channels to post in.")], components: [row(back)] };
  const quick = detected ? button(`Post in #${detected.name}`, cid('postch', sess, 0), 'primary', '📌') : null;
  return {
    embeds,
    components: [select(cid('postsel', mid), ordered.slice(0, 25).map((c) => ({ label: `#${c.name}`, value: c.id })), { placeholder: 'Pick a channel' }), row(quick, back)],
    fallbackComponents: [...rows(ordered.slice(0, 20).map((c, i) => button(`#${c.name}`, cid('postch', sess, i), i === 0 && detected ? 'primary' : 'secondary'))).slice(0, 4), row(back)],
  };
}

async function doPost(ctx, mid, channelId) {
  const { engine, serverId: sid } = ctx;
  const menu = getMenu(engine, sid, mid);
  if (!menu) return show(ctx, await editorView(engine, sid, mid));
  const live = isLive(ctx);
  if (live) await ctx.update({ embeds: [dialog.info('Posting…', `Putting **${menu.title}** in **${await channelName(engine, sid, channelId)}**.`)], components: [] });
  try {
    const res = await postMenu(engine, sid, mid, channelId);
    const view = await editorView(engine, sid, mid, res.note);
    return live ? ctx.update(view) : show(ctx, view);
  } catch (e) {
    if (!live) throw e;
    const { title, body } = explain(e, { action: 'post the menu', perm: 'send_messages' });
    return ctx.update(await editorView(engine, sid, mid, `${ICONS.error} **${title}**\n${body}`));
  }
}

async function startPost(ctx, mid) {
  const { engine, serverId: sid } = ctx;
  const menu = getMenu(engine, sid, mid);
  if (!menu) return show(ctx, await editorView(engine, sid, mid));
  if (!liveItems(menu).length) return show(ctx, await editorView(engine, sid, mid, `${ICONS.warn} Add at least one role before posting.`));
  if (menu.messageId && menu.channelId) return doPost(ctx, mid, menu.channelId);
  return showSel(ctx, await channelPicker(engine, sid, mid));
}

async function deleteMenu(ctx, mid) {
  const { engine, serverId: sid } = ctx;
  const menu = getMenu(engine, sid, mid);
  if (!menu) return show(ctx, await homeView(engine, sid, `${ICONS.warn} That menu was already deleted.`));
  dropMenu(engine, sid, mid);
  const u = engine.router.addUndo({
    serverId: sid,
    actorId: ctx.userId,
    perm: 'admin',
    label: `delete ${menu.title}`,
    run: async (i) => {
      saveMenu(engine, sid, mid, { ...menu, messageId: null, postedAs: null, dirty: false, reacted: [] });
      const wasPosted = !!(menu.messageId && menu.channelId);
      await i.ephemeral('', { embeds: [dialog.ok('Menu restored', `**${menu.title}** is back${wasPosted ? ` and I'm posting it again in <#${menu.channelId}>` : ''}.`)] });
      if (!wasPosted) return;
      try {
        await postMenu(engine, sid, mid, menu.channelId);
      } catch (e) {
        const { title, body } = explain(e, { action: 'post the menu again' });
        await i.ephemeral('', { embeds: [dialog.warn(title, `${body}\nThe menu is saved as a draft. Post it from **/roles**.`)] }).catch(() => {});
      }
    },
  });
  await show(ctx, {
    embeds: [dialog.ok('Menu deleted', `**${menu.title}** is gone${menu.messageId ? ' and I took down its post' : ''}.\nChanged your mind? Press **Undo** within 10 minutes.`)],
    components: [row(u.button, backHome())],
  });
  if (menu.messageId) await engine.bot.delete(menu.channelId, menu.messageId).catch((e) => engine.log.debug('old role menu already gone', e?.message));
}

async function previewMenu(ctx, mid) {
  const { engine, serverId: sid } = ctx;
  const menu = getMenu(engine, sid, mid);
  if (!menu) return ctx.ephemeral(await editorView(engine, sid, mid));
  if (!liveItems(menu).length) return ctx.warn('Nothing to preview', 'Add some roles first.');
  const note = { content: `-# Preview of **${menu.title}**. Buttons are turned off here.` };
  if (menu.type === 'dropdown') {
    return engine.caps.attempt(sid, 'selects', () => ctx.ephemeral({ ...note, ...render(mid, menu, 'dropdown', { disabled: true }) }), () => ctx.ephemeral({ content: `${note.content}\n-# Dropdowns aren't on for this server yet, so it will post as buttons.`, ...render(mid, menu, 'buttons', { disabled: true }) }));
  }
  if (menu.type === 'reactions') return ctx.ephemeral({ content: `${note.content}\n-# I'll react with: ${liveItems(menu).map(({ item }) => item.emoji || '❔').join(' ')}`, ...render(mid, menu, 'reactions') });
  return ctx.ephemeral({ ...note, ...render(mid, menu, 'buttons', { disabled: true }) });
}

function setType(engine, sid, mid, type) {
  const menu = changeMenu(engine, sid, mid, (m) => { m.type = type; });
  if (!menu) return null;
  if (type === 'reactions') {
    const bare = liveItems(menu).filter(({ item }) => !item.emoji);
    if (bare.length) return `${ICONS.warn} Reaction menus need an emoji on every role. Missing: ${bare.map(({ item }) => `**${item.label}**`).join(', ')}. Use **Edit roles** to set them.`;
  }
  if (type === 'dropdown' && engine.caps.state(sid, 'selects') === false) return `${ICONS.info} Dropdowns aren't on for this server yet, so I'll post it as buttons until they are.`;
  return `${ICONS.ok} Type set to **${TYPES[type]}**.`;
}

function setMode(engine, sid, mid, mode) {
  return changeMenu(engine, sid, mid, (m) => { m.mode = mode; }) ? `${ICONS.ok} Mode set to **${MODES[mode]}**: ${MODE_HELP[mode]}.` : null;
}

function removeItem(ctx, mid, idx) {
  const { engine, serverId: sid } = ctx;
  const menu = getMenu(engine, sid, mid);
  const item = menu?.items?.[idx];
  if (!item) return null;
  changeMenu(engine, sid, mid, (m) => { m.items[idx] = null; });
  const u = engine.router.addUndo({
    serverId: sid,
    actorId: ctx.userId,
    perm: 'admin',
    label: `remove ${item.label}`,
    run: async (i) => {
      const back = changeMenu(engine, sid, mid, (m) => { if (!m.items[idx]) m.items[idx] = item; else m.items.push(item); });
      await i.ephemeral('', { embeds: [back ? dialog.ok('Role is back', `**${item.label}** is on **${menu.title}** again.`) : dialog.warn('Too late', 'That menu was deleted.')] });
    },
  });
  return { item, undo: u.button };
}

function findMenuId(engine, sid, token) {
  const menus = data(engine, sid).menus || {};
  const t = String(token ?? '').trim().toLowerCase();
  if (!t) return null;
  if (menus[t]) return t;
  if (/^\d+$/.test(t) && menus[`m${t}`]) return `m${t}`;
  const hit = fuzzyFind(t, Object.entries(menus), { key: ([, m]) => m.title });
  return hit?.item?.[0] || null;
}

async function takeRole(ctx, tokens) {
  const stop = tokens.findIndex((t, i) => i > 0 && (isEmoji(t) || /^<[@#]/.test(t)));
  const most = /^<@&/.test(tokens[0] || '') ? 1 : Math.min(3, stop < 0 ? tokens.length : stop);
  for (let n = most; n >= 1; n--) {
    const role = await ctx.findRole(tokens.slice(0, n).join(' '));
    if (role) return { role, rest: tokens.slice(n) };
  }
  return { role: null, rest: tokens };
}

const usage = [
  '`/roles` opens the editor',
  '`/roles new Games` makes a menu',
  '`/roles add m1 @Gamer 🎮 Gamers` adds a role (emoji and label are optional)',
  '`/roles remove m1 @Gamer` takes one off',
  '`/roles type m1 buttons|dropdown|reactions`',
  '`/roles mode m1 toggle|unique|add`',
  '`/roles post m1 #get-roles` posts or updates it',
  '`/roles preview m1` · `/roles delete m1` · `/roles list`',
].join('\n');

async function needMenu(ctx, token) {
  const mid = findMenuId(ctx.engine, ctx.serverId, token);
  if (!mid) {
    const list = Object.keys(data(ctx.engine, ctx.serverId).menus || {});
    await ctx.warn('Which menu?', `${token ? `I can't find a menu called **${token}**.` : 'Tell me which menu, like `m1`.'}${list.length ? ` Your menus: ${list.map((m) => `\`${m}\``).join(', ')}.` : ' There are no menus yet. Try `/roles new Games`.'}`);
    return null;
  }
  return mid;
}

async function runTyped(ctx) {
  const { engine, serverId: sid } = ctx;
  const argv = ctx.argv.map(String);
  const word = argv[0].toLowerCase().replace(/^\//, '');
  const sub = SUBS[word] || (findMenuId(engine, sid, word) && /^m?\d+$/.test(word) ? 'open' : null);
  if (!sub) {
    const guess = didYouMean(word, Object.keys(SUBS));
    return ctx.warn("I didn't get that", `${guess.length ? `Did you mean ${guess.map((g) => `**${g}**`).join(', ')}?\n\n` : ''}${usage}`);
  }
  const rest = SUBS[word] ? argv.slice(1) : argv;
  if (sub === 'help') return ctx.info('Role menu shortcuts', usage);
  if (sub === 'list') return show(ctx, await homeView(engine, sid));
  if (sub === 'new') {
    if (!rest.length) return openNewForm(ctx);
    const text = rest.join(' ');
    const [title, description = ''] = text.split('|').map((s) => s.trim());
    const mid = createMenu(engine, sid, { title, description });
    return show(ctx, await editorView(engine, sid, mid, `${ICONS.ok} Made **${clip(title, 100)}** (\`${mid}\`). Add roles next.`));
  }
  const mid = await needMenu(ctx, rest[0]);
  if (!mid) return null;
  const args = rest.slice(1);
  if (sub === 'open') return show(ctx, await editorView(engine, sid, mid));
  if (sub === 'preview') return previewMenu(ctx, mid);
  if (sub === 'delete') return deleteMenu(ctx, mid);
  if (sub === 'add') {
    if (!args.length) return showSel(ctx, await pickerView(engine, sid, engine.router.session({ mid, roleIds: (await manageableRoles(engine, sid, ctx.userId)).map((r) => r.id) })));
    const { role, rest: after } = await takeRole(ctx, args);
    if (!role) return ctx.warn("I can't find that role", `Mention it like **@Gamer** or type its name.\n\n${usage}`);
    const emoji = after[0] && isEmoji(after[0]) ? after[0] : null;
    const label = (emoji ? after.slice(1) : after).join(' ').trim();
    const res = await addRolesToMenu(engine, sid, mid, [role], { emoji, label }, ctx.userId);
    return show(ctx, await editorView(engine, sid, mid, res.note));
  }
  if (sub === 'remove') {
    const menu = getMenu(engine, sid, mid);
    const n = /^#?\d+$/.test(args[0] || '') ? Number(args[0].replace('#', '')) : null;
    let idx = -1;
    if (n !== null) idx = liveItems(menu)[n - 1]?.idx ?? -1;
    else {
      const { role } = await takeRole(ctx, args);
      idx = menu.items.findIndex((i) => i && (role ? i.roleId === role.id : normalizeLabel(i.label) === normalizeLabel(args.join(' '))));
    }
    if (idx < 0) return ctx.warn('Not on this menu', 'Tell me the role, like **@Gamer**, or its number from the list.');
    const out = removeItem(ctx, mid, idx);
    return show(ctx, await editorView(engine, sid, mid, `➖ Took **${out.item.label}** off the menu.`, [out.undo]));
  }
  if (sub === 'type') {
    const t = TYPE_WORDS[(args[0] || '').toLowerCase()];
    if (!t) return ctx.warn('Which type?', 'Pick **buttons**, **dropdown** or **reactions**, like `/roles type m1 buttons`.');
    return show(ctx, await editorView(engine, sid, mid, setType(engine, sid, mid, t)));
  }
  if (sub === 'mode') {
    const m = MODE_WORDS[(args[0] || '').toLowerCase().replace(/[^a-z]/g, '')];
    if (!m) return ctx.warn('Which mode?', 'Pick **toggle** (click again to remove), **unique** (one role at a time) or **add** (only gives roles).');
    return show(ctx, await editorView(engine, sid, mid, setMode(engine, sid, mid, m)));
  }
  if (sub === 'post') {
    if (!args.length) return startPost(ctx, mid);
    const ch = await ctx.findChannel(args.join(' '));
    if (!ch) return ctx.warn("I can't find that channel", 'Mention it like **#get-roles**.');
    return doPost(ctx, mid, ch.id);
  }
  return null;
}

const normalizeLabel = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

function openNewForm(ctx) {
  return ctx.form({
    title: 'New role menu',
    action: 'created',
    fields: [
      { id: 'title', label: 'Title', placeholder: 'Pick your games', max: 100 },
      { id: 'description', label: 'Description (optional)', style: 'paragraph', required: false, placeholder: 'Click a button to get pinged for that game.', max: 1000 },
    ],
  });
}

async function runCommand(ctx) {
  if (ctx.argv.length) return runTyped(ctx);
  return show(ctx, await homeView(ctx.engine, ctx.serverId));
}

const admin = (run) => ({ perm: 'admin', run });

export const { setup, teardown, check } = defineApp({
  id: ID,
  name: 'Roles',
  icon: ICONS.roles,
  description: 'Role menus: buttons, dropdowns or reactions.',
  category: 'Community',

  commands: {
    roles: { description: 'Role menus people click to get roles. Try /roles new or /roles add m1 @Gamer 🎮 (admins)', perm: 'admin', run: runCommand },
  },

  components: {
    home: admin(async (ctx) => show(ctx, await homeView(ctx.engine, ctx.serverId))),
    clear: admin(async (ctx) => {
      ctx.engine.store.update(ID, ctx.serverId, (d) => { d.notices = []; return d; }, blank());
      return show(ctx, await homeView(ctx.engine, ctx.serverId, `${ICONS.ok} Notes cleared.`));
    }),
    new: admin((ctx) => openNewForm(ctx)),
    created: admin(async (ctx) => {
      const title = String(ctx.values?.title || '').trim() || 'Pick your roles';
      const mid = createMenu(ctx.engine, ctx.serverId, { title, description: String(ctx.values?.description || '').trim() });
      return show(ctx, await editorView(ctx.engine, ctx.serverId, mid, `${ICONS.ok} Made **${clip(title, 100)}**. Add some roles next.`));
    }),
    open: admin(async (ctx) => show(ctx, await editorView(ctx.engine, ctx.serverId, ctx.argv[0]))),
    add: admin(async (ctx) => {
      const { engine, serverId: sid } = ctx;
      const mid = ctx.argv[0];
      if (!getMenu(engine, sid, mid)) return show(ctx, await editorView(engine, sid, mid));
      const sess = engine.router.session({ mid, roleIds: (await manageableRoles(engine, sid, ctx.userId)).map((r) => r.id) });
      return showSel(ctx, await pickerView(engine, sid, sess, 0));
    }),
    addpg: admin(async (ctx) => showSel(ctx, await pickerView(ctx.engine, ctx.serverId, ctx.argv[0], ctx.argv[1]))),
    addsel: admin(async (ctx) => {
      const { engine, serverId: sid } = ctx;
      const s = engine.router.getSession(ctx.argv[0]);
      if (!s) return show(ctx, await homeView(engine, sid, `${ICONS.warn} That picker expired. Open the menu again.`));
      const map = await roleMapOf(engine, sid);
      const picked = (ctx.values || []).map((v) => map.get(s.roleIds[Number(v)])).filter(Boolean);
      const res = await addRolesToMenu(engine, sid, s.mid, picked, {}, ctx.userId);
      return show(ctx, await editorView(engine, sid, s.mid, res.note || 'Nothing added.'));
    }),
    addbtn: admin(async (ctx) => {
      const { engine, serverId: sid } = ctx;
      const s = engine.router.getSession(ctx.argv[0]);
      if (!s) return show(ctx, await homeView(engine, sid, `${ICONS.warn} That picker expired. Open the menu again.`));
      const role = (await roleMapOf(engine, sid)).get(s.roleIds[Number(ctx.argv[1])]);
      const res = role ? await addRolesToMenu(engine, sid, s.mid, [role], {}, ctx.userId) : { note: `${ICONS.warn} That role doesn't exist anymore.` };
      return showSel(ctx, await pickerView(engine, sid, ctx.argv[0], 0, `${res.note}\nPick more, or press **Done**.`));
    }),
    items: admin(async (ctx) => show(ctx, await itemsView(ctx.engine, ctx.serverId, ctx.argv[0], ctx.argv[1]))),
    item: admin(async (ctx) => show(ctx, await itemView(ctx.engine, ctx.serverId, ctx.argv[0], Number(ctx.argv[1])))),
    itemform: admin(async (ctx) => {
      const { engine, serverId: sid } = ctx;
      const [mid, idxS] = ctx.argv;
      const item = getMenu(engine, sid, mid)?.items?.[Number(idxS)];
      if (!item) return show(ctx, await editorView(engine, sid, mid, `${ICONS.warn} That role isn't on the menu anymore.`));
      setPending(engine, sid, ctx.userId, { kind: 'item', mid, idx: Number(idxS) });
      return ctx.form({
        title: 'Emoji and label',
        action: 'itemsave',
        fields: [
          { id: 'emoji', label: 'Emoji (optional)', required: false, value: item.emoji || '', placeholder: '🎮', max: 64 },
          { id: 'label', label: 'Label people see', value: item.label, max: 80 },
        ],
      });
    }),
    itemsave: admin(async (ctx) => {
      const { engine, serverId: sid } = ctx;
      const p = takePending(engine, sid, ctx.userId, 'item');
      if (!p) return ctx.warn('That form expired', 'Open the role again from **/roles** → **Edit roles**.');
      const emoji = String(ctx.values?.emoji || '').trim();
      const label = String(ctx.values?.label || '').trim();
      if (emoji && !isEmoji(emoji)) {
        setPending(engine, sid, ctx.userId, p);
        return show(ctx, await itemView(engine, sid, p.mid, p.idx, `${ICONS.warn} **${clip(emoji, 40)}** doesn't look like one emoji. Use a single emoji like 🎮, or a server emoji.`));
      }
      const menu = changeMenu(engine, sid, p.mid, (m) => { const it = m.items[p.idx]; if (it) { it.emoji = emoji || null; if (label) it.label = clip(label, 80); } });
      if (!menu) return show(ctx, await homeView(engine, sid, `${ICONS.warn} That menu was deleted.`));
      return show(ctx, await itemView(engine, sid, p.mid, p.idx, `${ICONS.ok} Saved.`));
    }),
    unitem: admin(async (ctx) => {
      const { engine, serverId: sid } = ctx;
      const [mid, idxS] = ctx.argv;
      const out = removeItem(ctx, mid, Number(idxS));
      if (!out) return show(ctx, await editorView(engine, sid, mid, `${ICONS.warn} That role was already taken off.`));
      return show(ctx, await editorView(engine, sid, mid, `➖ Took **${out.item.label}** off the menu.`, [out.undo]));
    }),
    text: admin(async (ctx) => {
      const { engine, serverId: sid } = ctx;
      const mid = ctx.argv[0];
      const menu = getMenu(engine, sid, mid);
      if (!menu) return show(ctx, await editorView(engine, sid, mid));
      setPending(engine, sid, ctx.userId, { kind: 'text', mid });
      return ctx.form({
        title: 'Menu text',
        action: 'textsave',
        fields: [
          { id: 'title', label: 'Title', value: menu.title, max: 100 },
          { id: 'description', label: 'Description (optional)', style: 'paragraph', required: false, value: menu.description, max: 1000 },
        ],
      });
    }),
    textsave: admin(async (ctx) => {
      const { engine, serverId: sid } = ctx;
      const p = takePending(engine, sid, ctx.userId, 'text');
      if (!p) return ctx.warn('That form expired', 'Open the menu again from **/roles** → **Edit text**.');
      const title = String(ctx.values?.title || '').trim();
      const menu = changeMenu(engine, sid, p.mid, (m) => { if (title) m.title = clip(title, 100); m.description = clip(String(ctx.values?.description || '').trim(), 1000); });
      if (!menu) return show(ctx, await homeView(engine, sid, `${ICONS.warn} That menu was deleted.`));
      return show(ctx, await editorView(engine, sid, p.mid, `${ICONS.ok} Text saved.`));
    }),
    type: admin(async (ctx) => {
      const [mid, t] = ctx.argv;
      const note = TYPES[t] ? setType(ctx.engine, ctx.serverId, mid, t) : null;
      return show(ctx, await editorView(ctx.engine, ctx.serverId, mid, note));
    }),
    mode: admin(async (ctx) => {
      const [mid, m] = ctx.argv;
      const note = MODES[m] ? setMode(ctx.engine, ctx.serverId, mid, m) : null;
      return show(ctx, await editorView(ctx.engine, ctx.serverId, mid, note));
    }),
    preview: admin((ctx) => previewMenu(ctx, ctx.argv[0])),
    post: admin((ctx) => startPost(ctx, ctx.argv[0])),
    postsel: admin((ctx) => doPost(ctx, ctx.argv[0], ctx.values?.[0])),
    postch: admin(async (ctx) => {
      const s = ctx.engine.router.getSession(ctx.argv[0]);
      const chId = s?.channelIds?.[Number(ctx.argv[1])];
      if (!s || !chId) return show(ctx, await homeView(ctx.engine, ctx.serverId, `${ICONS.warn} That channel list expired. Press **Post** again.`));
      return doPost(ctx, s.mid, chId);
    }),
    del: admin((ctx) => deleteMenu(ctx, ctx.argv[0])),
    p: {
      run: async (ctx) => {
        const [mid, idxS] = ctx.argv;
        const res = await changeRole(ctx.engine, ctx.serverId, ctx.userId, mid, Number(idxS), 'toggle');
        return ctx.ephemeral(pickText([res]));
      },
    },
    d: {
      run: async (ctx) => {
        const mid = ctx.argv[0];
        const menu = getMenu(ctx.engine, ctx.serverId, mid);
        const picks = [...new Set((ctx.values || []).map(Number))].slice(0, menu?.mode === 'unique' ? 1 : MAX_ITEMS);
        const results = [];
        for (const idx of picks) results.push(await changeRole(ctx.engine, ctx.serverId, ctx.userId, mid, idx, 'toggle'));
        return ctx.ephemeral(pickText(results));
      },
    },
  },

  events: {
    reaction_add: (ctx, ev) => onReaction(ctx, ev, true),
    reaction_remove: (ctx, ev) => onReaction(ctx, ev, false),
  },

  yap: [{
    words: ['roles', 'rolemenu', 'reactionroles'],
    run: async (ctx) => {
      await ctx.require('admin');
      return runCommand(ctx);
    },
  }],

  panel: async (ctx) => {
    const isAdmin = ctx.engine.perms.atLeast(await ctx.level(), 'admin');
    if (!isAdmin) return ctx.info('Role menus', 'Admins post role menus in channels. Click a button (or pick, or react) on one to get a role, and click again to drop it.');
    return show(ctx, await homeView(ctx.engine, ctx.serverId));
  },

  presets: {
    gaming: { enabled: true, config: {} },
    friends: { enabled: true, config: {} },
    study: { enabled: true, config: {} },
    community: { enabled: true, config: {} },
    roleplay: { enabled: true, config: {} },
  },

  applyPreset: async (engine, serverId, { preset, channels = {} } = {}) => {
    const where = channels.roles ? `#${channels.roles.name}` : 'a channel like #get-roles';
    if (preset !== 'gaming') return `${ICONS.roles} Roles: ready. Build a role menu with **/roles** and post it in **${where}**.`;
    const d = engine.store.get(ID, serverId, blank());
    const existing = Object.entries(d.menus || {}).find(([, m]) => /^games$/i.test(m.title));
    const mid = existing ? existing[0] : createMenu(engine, serverId, { title: 'Games', description: 'Pick the games you play so others can find you for a match.' });
    return `${ICONS.roles} Roles: drafted a **Games** menu (\`${mid}\`). Add your game roles with **/roles** and post it in **${where}**.`;
  },

  help: [
    'Role menus come in three types: buttons (up to 25), a dropdown, or reactions.',
    'Modes: toggle (click again to remove), unique (one role from the menu at a time), add only.',
    'I can only hand out roles below my own role. Drag my role higher in Server settings → Roles if a role is missing.',
    'Typed shortcuts: /roles add m1 @Gamer 🎮 Gamers · /roles post m1 #get-roles · /roles type m1 reactions',
  ],
});

async function onReaction(ctx, ev, added) {
  const { engine } = ctx;
  const sid = ev?.server_id;
  if (!sid || !ev.user_id || ev.user_id === botId(engine)) return;
  const entry = Object.entries(data(engine, sid).menus || {}).find(([, m]) => m.messageId && m.messageId === ev.message_id && m.postedAs === 'reactions');
  if (!entry) return;
  const [mid, menu] = entry;
  const idx = menu.items.findIndex((i) => i && sameEmoji(i.emoji, ev.emoji));
  if (idx < 0) return;
  if (!added && menu.mode === 'add') return;
  const res = await changeRole(engine, sid, ev.user_id, mid, idx, added ? 'add' : 'remove');
  if (res.problem) engine.log.debug(`[roles] reaction by ${ev.user_id} on ${mid}: ${res.problem}`);
}
