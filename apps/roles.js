import { defineApp } from '../engine/apps.js';
import { card, dialog, button, row, rows, select, ICONS } from '../engine/ui.js';
import { customId } from '../engine/router.js';
import { didYouMean, fuzzyFind, clip } from '../engine/parse.js';
import { friendly, explain, permName, looksLikeFeatureOff } from '../engine/errors.js';

const ID = 'roles';
const cid = (action, ...args) => customId(ID, action, ...args);
const MAX_ITEMS = 25;
const PAGE = 20;
const ITEM_PAGE = 10;
const MAX_TITLE = 100;
const MAX_TEXT = 1000;
const MAX_FOOTER = 200;
const MAX_NOTE = 100;
const MAX_LABEL = 80;
const MAX_LINK = 512;
const ROLES_COLOR = 0x9b59b6;
const TYPES = { buttons: 'Buttons', dropdown: 'Dropdown', reactions: 'Reactions' };
const MODES = { toggle: 'Toggle', unique: 'Pick one', add: 'Add only' };
const MODE_HELP = { toggle: 'click again to remove', unique: 'only one role from this menu at a time', add: 'roles are only given, never taken back' };
const STYLES = { primary: 'Blue', secondary: 'Grey', success: 'Green', danger: 'Red' };
const TABS = { content: { label: 'Content', emoji: '📝' }, roles: { label: 'Roles', emoji: '🎭' }, style: { label: 'Style', emoji: '🎨' }, settings: { label: 'Settings', emoji: '⚙️' } };
const TYPE_WORDS = { buttons: 'buttons', button: 'buttons', btn: 'buttons', dropdown: 'dropdown', select: 'dropdown', menu: 'dropdown', list: 'dropdown', reactions: 'reactions', reaction: 'reactions', react: 'reactions', emoji: 'reactions', emojis: 'reactions' };
const MODE_WORDS = { toggle: 'toggle', normal: 'toggle', unique: 'unique', one: 'unique', single: 'unique', pickone: 'unique', add: 'add', addonly: 'add', verify: 'add', verification: 'add', give: 'add' };
const STYLE_WORDS = { blue: 'primary', blurple: 'primary', primary: 'primary', grey: 'secondary', gray: 'secondary', secondary: 'secondary', default: 'secondary', normal: 'secondary', green: 'success', success: 'success', red: 'danger', danger: 'danger' };
const ACCENTS = { red: 0xed4245, orange: 0xe67e22, yellow: 0xfee75c, gold: 0xf1c40f, green: 0x57f287, teal: 0x1abc9c, cyan: 0x00bcd4, blue: 0x3498db, blurple: 0x5865f2, purple: 0x9b59b6, pink: 0xeb459e, grey: 0x95a5a6, gray: 0x95a5a6, black: 0x23272a, white: 0xffffff };
const PICTURE_HOSTS = ['files.yapper.website', 'www.yapin.gg', 'yapin.gg', 'i.imgur.com', 'media.tenor.com', 'media.giphy.com', 'i.giphy.com', 'upload.wikimedia.org', 'raw.githubusercontent.com', 'avatars.githubusercontent.com', 'user-images.githubusercontent.com', 'i.ytimg.com', 'cdn.discordapp.com', 'media.discordapp.net', 'pbs.twimg.com', 'i.redd.it', 'static-cdn.jtvnw.net', 'i.scdn.co', 's4.anilist.co', 'cdn.myanimelist.net', 'nekos.best', 'cdn.weeb.sh'];
const PICTURE_DOMAINS = ['klipy.com', 'rbxcdn.com'];
const SUBS = { new: 'new', create: 'new', make: 'new', list: 'list', menus: 'list', all: 'list', add: 'add', remove: 'remove', rm: 'remove', take: 'remove', post: 'post', send: 'post', publish: 'post', update: 'post', type: 'type', style: 'type', mode: 'mode', preview: 'preview', show: 'open', open: 'open', edit: 'open', delete: 'delete', del: 'delete', help: 'help', item: 'item', button: 'item', set: 'set', settings: 'set' };
const EMOJI_RE = /^(?:<a?:\w+:[\w-]+>|(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[0-9#*]️?⃣)[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}️‍⃣]*)$/u;

const blank = () => ({ menus: {}, seq: 0, notices: [] });
const data = (engine, sid) => engine.store.get(ID, sid, blank());
const own = (obj, key) => (obj && typeof key === 'string' && Object.hasOwn(obj, key) ? obj[key] : undefined);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const isEmoji = (t) => EMOJI_RE.test(String(t ?? '').trim());
const botId = (engine) => engine.bot.me?.id;
const hex = (n) => `#${Number(n).toString(16).padStart(6, '0')}`;
const isOff = (t) => /^(|none|no|off|reset|clear|remove|default|-)$/i.test(String(t ?? '').trim());

function normalizeItem(item, idx) {
  if (!item || typeof item !== 'object' || !item.roleId) return null;
  return {
    ...item,
    label: clip(String(item.label || 'Role'), MAX_LABEL),
    emoji: item.emoji || null,
    style: own(STYLES, item.style) ? item.style : 'secondary',
    note: typeof item.note === 'string' && item.note ? clip(item.note, MAX_NOTE) : null,
    pos: Number.isFinite(item.pos) ? item.pos : idx,
  };
}

function normalizeMenu(menu) {
  if (!menu || typeof menu !== 'object') return null;
  menu.items = (Array.isArray(menu.items) ? menu.items : []).map(normalizeItem);
  if (!own(TYPES, menu.type)) menu.type = 'buttons';
  if (!own(MODES, menu.mode)) menu.mode = 'toggle';
  menu.title = String(menu.title || 'Pick your roles');
  menu.description = String(menu.description || '');
  menu.color = Number.isInteger(menu.color) && menu.color >= 0 && menu.color <= 0xffffff ? menu.color : null;
  menu.image = typeof menu.image === 'string' && menu.image ? menu.image : null;
  menu.imageKind = menu.imageKind === 'thumbnail' ? 'thumbnail' : 'image';
  menu.footer = typeof menu.footer === 'string' && menu.footer ? menu.footer : null;
  menu.showList = menu.showList !== false;
  menu.maxRoles = Number.isInteger(menu.maxRoles) && menu.maxRoles > 0 ? Math.min(menu.maxRoles, MAX_ITEMS) : 0;
  menu.needRole = typeof menu.needRole === 'string' && menu.needRole ? menu.needRole : null;
  menu.defaultStyle = own(STYLES, menu.defaultStyle) ? menu.defaultStyle : 'secondary';
  return menu;
}

const getMenu = (engine, sid, mid) => normalizeMenu(own(data(engine, sid).menus, mid)) || null;

const liveItems = (menu) => (menu?.items || [])
  .map((item, idx) => ({ item, idx }))
  .filter((x) => x.item)
  .sort((a, b) => (a.item.pos ?? a.idx) - (b.item.pos ?? b.idx) || a.idx - b.idx);

const nextPos = (menu) => Math.max(-1, ...menu.items.filter(Boolean).map((i) => (Number.isFinite(i.pos) ? i.pos : 0))) + 1;

function saveMenu(engine, sid, mid, menu) {
  engine.store.update(ID, sid, (d) => { d.menus ||= {}; d.menus[mid] = menu; return d; }, blank());
  return menu;
}

function changeMenu(engine, sid, mid, fn) {
  const menu = getMenu(engine, sid, mid);
  if (!menu) return null;
  if (fn(menu) === false) return menu;
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
    d.menus[mid] = normalizeMenu({ title: clip(title || 'Pick your roles', MAX_TITLE), description: clip(description || '', MAX_TEXT), type, mode, channelId: null, messageId: null, postedAs: null, dirty: false, items });
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

function guardReason(engine, sid, roleId) {
  const core = engine.settings.core(sid);
  if ((core.adminRoles || []).includes(roleId)) return 'makes people a YapOS admin here';
  if ((core.modRoles || []).includes(roleId)) return 'makes people a YapOS moderator here';
  const tickets = engine.settings.appConfig(sid, 'tickets') || {};
  if ((tickets.staffRoles || []).includes(roleId)) return 'lets people into every ticket as ticket staff';
  const open = engine.store.get('tickets', sid, null)?.tickets || {};
  if (Object.values(open).some((t) => t && t.roleId === roleId)) return "opens someone's private ticket";
  const automod = engine.settings.appConfig(sid, 'automod') || {};
  if ((automod.exempt?.roles || []).includes(roleId)) return 'is skipped by Automod';
  return null;
}

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
    .filter((r) => !isEveryone(r, sid) && !isAuto(r) && !staffPerms(r).length && !guardReason(engine, sid, r.id) && typeof r.position === 'number' && r.position < top)
    .sort((a, b) => b.position - a.position);
}

function openSession(ctx, payload) {
  return ctx.engine.router.session({ ...payload, sid: ctx.serverId, uid: ctx.userId });
}

function ownSession(ctx, id, list) {
  const s = ctx.engine.router.getSession(id);
  return s && s.sid === ctx.serverId && s.uid === ctx.userId && Array.isArray(s[list]) ? s : null;
}

function postedProblem(ctx, mid, as) {
  const menu = getMenu(ctx.engine, ctx.serverId, mid);
  if (!menu) return null;
  if (!menu.messageId || menu.postedAs !== as) return "This role menu isn't posted right now, so it can't give out roles. Ask an admin if you need one.";
  const from = ctx.source?.message_id;
  if (from && from !== menu.messageId) return `This is an old copy of the menu. Use the newest one in <#${menu.channelId}>.`;
  return null;
}

async function gateProblem(engine, sid, uid, menu) {
  if (!menu?.needRole) return null;
  const need = (await roleMapOf(engine, sid)).get(menu.needRole);
  if (!need) return 'This menu needs a role that was deleted, so nobody can use it right now. Ask an admin to fix it in **/roles**.';
  let member = null;
  try { member = await engine.bot.member(sid, uid); } catch (e) { engine.log.debug('roles gate member lookup failed', e?.message); }
  if (member?.roles?.includes(need.id)) return null;
  return `Only people with **@${need.name}** can use this menu. Ask an admin if you think you should have it.`;
}

const gateCard = (text) => ({ embeds: [dialog.denied(null, { title: 'Needs a role', body: text })] });

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

async function emojiNote(engine, sid, emoji) {
  const id = /^<a?:\w+:([\w-]+)>$/.exec(String(emoji ?? ''))?.[1];
  if (!id) return '';
  const res = await engine.bot.emojis(sid).catch(() => null);
  const list = Array.isArray(res?.emojis) ? res.emojis : Array.isArray(res) ? res : null;
  if (!list || list.some((e) => e && String(e.id) === id)) return '';
  return "\n-# That emoji isn't from this server. It only shows if it comes from a server I'm in.";
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
  if (menu.footer) return menu.footer;
  const toggle = as === 'reactions' ? 'Remove your reaction to drop a role' : as === 'dropdown' ? 'Pick a role again to remove it' : 'Click again to remove a role';
  const base = { toggle, unique: 'You can have one role from this menu', add: 'Roles stay once you get them' }[menu.mode];
  return menu.maxRoles && menu.mode !== 'unique' ? `${base} · Up to ${plural(menu.maxRoles, 'role')} from this menu` : base;
}

function itemLine(item, as) {
  const note = item.note ? ` · ${item.note}` : '';
  if (as === 'reactions') return `${item.emoji || '❔'} → <@&${item.roleId}>${note}`;
  return `${item.emoji ? `${item.emoji} ` : ''}**${item.label}** → <@&${item.roleId}>${note}`;
}

function listText(menu, as, room) {
  const items = liveItems(menu).map(({ item }) => item);
  const tries = [
    (i) => itemLine(i, as),
    (i) => itemLine({ ...i, note: null }, as),
    (i) => `${i.emoji ? `${i.emoji} ` : ''}<@&${i.roleId}>`,
    (i) => `<@&${i.roleId}>`,
  ];
  for (const f of tries) {
    const text = items.map(f).join('\n');
    if (text.length <= room) return text;
  }
  return '';
}

function menuEmbed(menu, as) {
  const desc = menu.description || '';
  const list = menu.showList ? listText(menu, as, 3990 - desc.length) : '';
  const body = [desc, list].filter(Boolean).join('\n\n') || undefined;
  const picture = menu.image ? (menu.imageKind === 'thumbnail' ? { thumbnail: menu.image } : { image: menu.image }) : {};
  return card({ title: menu.title, body, color: menu.color ?? ROLES_COLOR, footer: footerFor(menu, as), ...picture });
}

function buttonRows(mid, menu, { disabled = false } = {}) {
  return rows(liveItems(menu).slice(0, MAX_ITEMS).map(({ item, idx }) => button(item.label, cid('p', mid, idx), item.style, item.emoji || undefined, { disabled })));
}

function dropdownRow(mid, menu, roleMap, { disabled = false } = {}) {
  const live = liveItems(menu).slice(0, MAX_ITEMS);
  const options = live.map(({ item, idx }) => {
    const role = roleMap?.get(item.roleId);
    const description = item.note || (role ? `Gives you @${role.name}` : '');
    return { label: item.label, value: String(idx), ...(item.emoji ? { emoji: item.emoji } : {}), ...(description ? { description } : {}) };
  });
  const most = menu.mode === 'unique' ? 1 : menu.maxRoles ? Math.min(menu.maxRoles, options.length) : options.length;
  return select(cid('d', mid), options, { placeholder: menu.mode === 'unique' ? 'Pick a role' : 'Pick your roles', min: 1, max: most, disabled });
}

function render(mid, menu, as, roleMap, opts) {
  const embeds = [menuEmbed(menu, as)];
  if (as === 'reactions') return { embeds, components: [] };
  if (as === 'dropdown') return { embeds, components: [dropdownRow(mid, menu, roleMap, opts)] };
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
  if (!current.length) throw friendly('This menu has no roles yet. Add some on the **Roles** tab first.', { title: 'Nothing to post' });
  if (menu.type === 'reactions') {
    const bare = current.filter((i) => !i.emoji);
    if (bare.length) throw friendly(`Reaction menus need an emoji on every role. Missing: ${bare.map((i) => `**${i.label}**`).join(', ')}.\nSet them on the **Roles** tab.`, { title: 'Emojis needed' });
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
    message = await engine.caps.attempt(sid, 'selects', () => deliver(render(mid, menu, 'dropdown', roleMap)), () => {
      as = 'buttons';
      notes.add("Dropdown menus aren't turned on for this server yet (they're still in testing on Yapin'), so I posted it as buttons instead. It works the same way.");
      return deliver(render(mid, menu, 'buttons', roleMap));
    });
  } else {
    message = await deliver(render(mid, menu, as, roleMap));
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

  const live = liveItems(menu).slice(0, as === 'reactions' ? menu.items.length : MAX_ITEMS).map(({ idx }) => idx);
  const postedEmojis = as === 'reactions' ? Object.fromEntries(liveItems(menu).map(({ item, idx }) => [idx, item.emoji])) : null;
  Object.assign(menu, { channelId, messageId: message.id, postedAs: as, dirty: false, reacted, live, postedEmojis });
  saveMenu(engine, sid, mid, menu);
  const where = await channelName(engine, sid, channelId);
  return { as, note: [`${ICONS.ok} ${sameSpot && message.id === old.messageId ? 'Updated the post' : 'Posted'} in **${where}**.`, ...notes].join('\n') };
}

function refusal(check, roleName, botRole) {
  const r = String(check.reason || '');
  if (check.kind === 'feature') return { kind: 'feature', text: "Giving out roles isn't turned on for this server yet (it's still in testing on Yapin'), so I couldn't change your roles. I've let the admins know." };
  if (check.kind === 'guard') return { kind: 'guard', text: `**@${roleName}** ${check.why}, so I won't hand it out from a menu. I've let the admins know.` };
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
  } else if (kind === 'guard') {
    notify(`guard:${item.roleId}`, `**@${roleName}** on the **${title}** menu ${check.why}, so I stopped handing it out. Take it off the menu.`);
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

const roleQueues = new Map();

function oneAtATime(key, fn) {
  const before = roleQueues.get(key) || Promise.resolve();
  const run = before.then(fn, fn);
  const tail = run.then(() => {}, () => {});
  roleQueues.set(key, tail);
  tail.then(() => { if (roleQueues.get(key) === tail) roleQueues.delete(key); });
  return run;
}

function changeRole(engine, sid, uid, mid, idx, intent) {
  return oneAtATime(`${sid}:${uid}`, () => changeRoleNow(engine, sid, uid, mid, idx, intent));
}

async function changeRoleNow(engine, sid, uid, mid, idx, intent) {
  const menu = getMenu(engine, sid, mid);
  if (!menu) return { problem: 'This role menu was deleted. Ask an admin if you need a role.' };
  const item = menu.items[idx];
  if (!item) return { problem: 'This button is out of date. An admin can press **Update post** in **/roles** to refresh it.' };
  if (Array.isArray(menu.live) && !menu.live.includes(idx)) return { problem: "That role isn't on the posted menu yet. An admin needs to press **Update post** in **/roles** first." };
  const check = await checkRole(engine, sid, item.roleId);
  if (!check.ok) return refuse(engine, sid, mid, idx, item, check);
  const role = check.role;
  if (staffPerms(role).length) return refuse(engine, sid, mid, idx, item, { kind: 'staff', role });
  const why = guardReason(engine, sid, role.id);
  if (why) return refuse(engine, sid, mid, idx, item, { kind: 'guard', role, why });
  let member;
  try { member = await engine.bot.member(sid, uid); } catch (e) { if (e?.status === 404) return { problem: "I couldn't find you in this server." }; throw e; }
  const mine = new Set(member?.roles || []);
  const has = mine.has(role.id);
  const want = intent === 'remove' ? false : intent === 'add' ? true : !has;
  if (!want && menu.mode === 'add') return { info: `You already have **@${role.name}**. This menu only gives roles, so ask an admin if you want it taken off.` };
  if (want === has) return { info: want ? `You already have **@${role.name}**.` : `You don't have **@${role.name}**.` };
  if (want && menu.mode !== 'unique' && menu.maxRoles > 0) {
    const held = new Set(menu.items.filter((o) => o && o.roleId !== role.id && mine.has(o.roleId)).map((o) => o.roleId)).size;
    if (held >= menu.maxRoles) return { problem: `You can have up to ${plural(menu.maxRoles, 'role')} from this menu. Remove one first.` };
  }
  const removed = [];
  try {
    if (want && menu.mode === 'unique') {
      for (const other of menu.items) {
        if (!other || other.roleId === role.id || !mine.has(other.roleId)) continue;
        const ok = await engine.perms.canManageRole(sid, other.roleId);
        if (!ok.ok || staffPerms(ok.role).length || guardReason(engine, sid, other.roleId)) continue;
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

function put(ctx, view) {
  if (isLive(ctx)) return ctx.update(view);
  if (typeof ctx.source.ack === 'function') return ctx.ephemeral(view);
  return ctx.reply(view);
}

function show(ctx, view) {
  const { fallbackComponents, ...main } = view;
  if (!fallbackComponents) return put(ctx, main);
  return ctx.engine.caps.attempt(ctx.serverId, 'selects', () => put(ctx, main), () => put(ctx, { ...main, components: fallbackComponents }));
}

const backHome = () => button('All menus', cid('home'), 'secondary', '⬅️');
const backMenu = (mid, tab = 'roles') => button('Back', cid('tab', mid, tab), 'secondary', '⬅️');
const missingMenu = () => ({ embeds: [dialog.warn('Menu not found', 'It may have been deleted. Open **/roles** to see your menus.')], components: [row(backHome())] });

function statusLine(menu) {
  if (!menu.messageId) return '📝 **Draft**, not posted yet';
  const as = menu.postedAs && menu.postedAs !== menu.type ? ` as ${TYPES[menu.postedAs].toLowerCase()}` : '';
  return `📌 **Posted** in <#${menu.channelId}>${as}${menu.dirty ? ' • changes not posted yet' : ''}`;
}

async function homeView(engine, sid, note) {
  const d = data(engine, sid);
  const list = Object.entries(d.menus || {}).map(([mid, m]) => [mid, normalizeMenu(m)]).filter(([, m]) => m);
  const lines = list.map(([mid, m]) => {
    const where = m.messageId ? `📌 <#${m.channelId}>${m.dirty ? ' • changes not posted yet' : ''}` : '📝 draft';
    return `\`${mid}\` **${clip(m.title, 60)}** · ${TYPES[m.type]} · ${MODES[m.mode]} · ${plural(liveItems(m).length, 'role')} · ${where}`;
  });
  const intro = 'Role menus let people pick their own roles with a click.';
  const body = [note, intro, lines.length ? lines.join('\n') : 'No role menus yet. Press **New menu** to make one.'].filter(Boolean).join('\n\n');
  const notices = (d.notices || []).slice(-3).map((n) => `• ${n.text}`).join('\n');
  const fields = notices ? [{ name: `${ICONS.warn} Needs a look`, value: notices }] : [];
  const opens = list.slice(0, 15).map(([mid, m]) => button(m.title, cid('open', mid), 'secondary', ICONS.roles));
  const tail = [button('New menu', cid('new'), 'primary', '➕')];
  if (notices) tail.push(button('Clear notes', cid('clear'), 'secondary', '🧹'));
  return {
    embeds: [card({ title: `${ICONS.roles} Role menus`, body, fields, color: 'roles', footer: 'Shortcuts: /roles new · /roles add m1 @Gamer 🎮 Gamers · /roles item m1 1 color green · /roles post m1 #get-roles' })],
    components: [...rows(opens).slice(0, 3), row(tail)],
  };
}

function chunkLines(lines, size = 1000) {
  const out = [];
  let cur = '';
  for (const line of lines) {
    if (cur && cur.length + line.length + 1 > size) { out.push(cur); cur = ''; }
    cur = cur ? `${cur}\n${line}` : line;
  }
  if (cur) out.push(cur);
  return out;
}

function contentTab(mid, menu) {
  const picture = menu.image ? `${menu.imageKind === 'thumbnail' ? 'Small, in the corner' : 'Big, under the text'}\n${menu.image}` : 'None';
  const fields = [
    { name: 'Title', value: menu.title },
    { name: 'Text', value: menu.description ? clip(menu.description, 500) : '*No text.*' },
    { name: 'Picture', value: picture },
    { name: 'Footer', value: menu.footer ? menu.footer : `Automatic: *${footerFor(menu, menu.type)}*`, inline: true },
    { name: 'Role list', value: menu.showList ? 'Shown under the text' : 'Hidden', inline: true },
  ];
  const rowsOut = [row(
    button('Title & text', cid('text', mid), 'secondary', '📝'),
    button('Picture', cid('imgform', mid), 'secondary', '🖼️'),
    button('Footer', cid('footform', mid), 'secondary', '🏷️'),
    button(menu.showList ? 'Role list: shown' : 'Role list: hidden', cid('showlist', mid, menu.showList ? 'off' : 'on'), menu.showList ? 'success' : 'secondary', '📋'),
  )];
  if (menu.image) {
    rowsOut.push(row(
      button('Big picture', cid('imgkind', mid, 'image'), menu.imageKind === 'image' ? 'success' : 'secondary', '🖼️'),
      button('Small corner picture', cid('imgkind', mid, 'thumbnail'), menu.imageKind === 'thumbnail' ? 'success' : 'secondary', '🔳'),
      button('Remove picture', cid('imgkind', mid, 'none'), 'danger', '✖️'),
    ));
  }
  return { fields, rows: rowsOut, tip: 'Typed: /roles set ' + mid + ' footer Have fun' };
}

function rolesTab(mid, menu, live, roleMap, page) {
  const lines = live.map(({ item }, n) => {
    const role = roleMap.get(item.roleId);
    const warn = !role ? ` ${ICONS.warn} role was deleted, it will be skipped` : '';
    return `\`${n + 1}\` ${item.emoji ? `${item.emoji} ` : ''}**${clip(item.label, 40)}** → ${role ? `<@&${role.id}>` : '@deleted-role'} · ${STYLES[item.style]}${warn}`;
  });
  const chunks = chunkLines(lines);
  const fields = chunks.length
    ? chunks.slice(0, 8).map((value, i) => ({ name: i === 0 ? `Roles (${live.length}/${MAX_ITEMS})` : '​', value }))
    : [{ name: `Roles (0/${MAX_ITEMS})`, value: 'None yet. Press **Add roles**.' }];
  const full = live.length >= MAX_ITEMS;
  const add = button('Add roles', cid('add', mid, 0), 'primary', '➕', { disabled: full });
  if (!live.length) return { fields, rows: [row(add)], tip: `Typed: /roles add ${mid} @role 🎮 Label` };
  const options = live.slice(0, MAX_ITEMS).map(({ item, idx }, n) => {
    const role = roleMap.get(item.roleId);
    return { label: `${n + 1}. ${item.label}`, value: String(idx), ...(item.emoji ? { emoji: item.emoji } : {}), description: `${role ? `@${role.name}` : 'Deleted role'} · ${STYLES[item.style]}${item.note ? ` · ${item.note}` : ''}` };
  });
  const pages = Math.max(1, Math.ceil(live.length / ITEM_PAGE));
  const p = Math.min(Math.max(0, Number(page) || 0), pages - 1);
  const pageBtns = live.slice(p * ITEM_PAGE, p * ITEM_PAGE + ITEM_PAGE).map(({ item, idx }) => button(`${live.findIndex((x) => x.idx === idx) + 1}. ${item.label}`, cid('item', mid, idx), 'secondary', item.emoji || undefined));
  const nav = [add];
  if (p > 0) nav.push(button('Previous', cid('tab', mid, 'roles', p - 1), 'secondary', '◀️'));
  if (p < pages - 1) nav.push(button('Next', cid('tab', mid, 'roles', p + 1), 'secondary', '▶️'));
  return {
    fields,
    rows: [select(cid('itemsel', mid), options, { placeholder: 'Pick a role to change its button', min: 1, max: 1 }), row(add)],
    fallbackRows: [...rows(pageBtns).slice(0, 2), row(nav)],
    tip: `Typed: /roles item ${mid} 1 label Gamers · color green · emoji 🎮 · up`,
  };
}

function styleButtons(current, idFor) {
  return Object.entries(STYLES).map(([s, label]) => button(label, idFor(s), s, s === current ? '✅' : undefined));
}

function styleTab(mid, menu, live) {
  const fields = [
    { name: 'Accent colour', value: menu.color === null ? 'Default (purple)' : hex(menu.color), inline: true },
    { name: 'Type', value: TYPES[menu.type], inline: true },
    { name: 'Colour for new buttons', value: STYLES[menu.defaultStyle], inline: true },
  ];
  return {
    fields,
    rows: [
      row(Object.entries(TYPES).map(([t, label]) => button(label, cid('type', mid, t), menu.type === t ? 'success' : 'secondary'))),
      row(styleButtons(menu.defaultStyle, (s) => cid('defstyle', mid, s))),
      row(
        button('Accent colour', cid('accform', mid), 'secondary', '🎨'),
        button('Use this colour on every button', cid('allstyle', mid), 'secondary', '🖌️', { disabled: !live.length }),
      ),
    ],
    tip: `Typed: /roles set ${mid} accent blue · /roles type ${mid} dropdown`,
  };
}

function settingsTab(mid, menu, roleMap) {
  const need = menu.needRole ? roleMap.get(menu.needRole) : null;
  const needText = !menu.needRole ? 'Anyone' : need ? `Only people with <@&${need.id}>` : `${ICONS.warn} The role was deleted, so nobody can use the menu`;
  const fields = [
    { name: 'Mode', value: `${MODES[menu.mode]}: ${MODE_HELP[menu.mode]}` },
    { name: 'Most roles per person', value: menu.mode === 'unique' ? 'One (Pick one mode)' : menu.maxRoles ? String(menu.maxRoles) : 'No limit', inline: true },
    { name: 'Who can use it', value: needText, inline: true },
  ];
  return {
    fields,
    rows: [
      row(Object.entries(MODES).map(([m, label]) => button(label, cid('mode', mid, m), menu.mode === m ? 'success' : 'secondary'))),
      row(
        button(`Max roles: ${menu.maxRoles || 'no limit'}`, cid('maxform', mid), 'secondary', '🔢'),
        button(menu.needRole ? `Needs @${need?.name || 'deleted role'}` : 'Needs a role: no', cid('needform', mid), 'secondary', '🔐'),
        menu.needRole ? button('Let anyone use it', cid('needclear', mid), 'secondary', '🔓') : null,
      ),
    ],
    tip: `Typed: /roles set ${mid} max 2 · /roles set ${mid} needs @Verified`,
  };
}

async function editorView(engine, sid, mid, note, { tab = 'roles', page = 0, undo = null } = {}) {
  const menu = getMenu(engine, sid, mid);
  if (!menu) return missingMenu();
  const t = own(TABS, tab) ? tab : 'roles';
  const roleMap = await roleMapOf(engine, sid);
  const live = liveItems(menu);
  const part = t === 'content' ? contentTab(mid, menu)
    : t === 'style' ? styleTab(mid, menu, live)
      : t === 'settings' ? settingsTab(mid, menu, roleMap)
        : rolesTab(mid, menu, live, roleMap, page);
  const tabRow = row(Object.entries(TABS).map(([k, v]) => button(v.label, cid('tab', mid, k), k === t ? 'primary' : 'secondary', v.emoji)));
  const actions = row(
    button('Preview', cid('preview', mid), 'secondary', '👀', { disabled: !live.length }),
    button(menu.messageId ? 'Update post' : 'Post', cid('post', mid), 'success', '📌', { disabled: !live.length }),
    button('Delete', cid('del', mid), 'danger', '🗑️'),
    backHome(),
    undo,
  );
  const body = [note, statusLine(menu)].filter(Boolean).join('\n\n');
  const embed = card({ title: `${ICONS.roles} ${menu.title}`, body, fields: part.fields, color: menu.color ?? ROLES_COLOR, footer: `Menu id ${mid} · ${part.tip}` });
  const view = { embeds: [embed], components: [tabRow, ...part.rows.slice(0, 3), actions] };
  if (part.fallbackRows) view.fallbackComponents = [tabRow, ...part.fallbackRows.slice(0, 3), actions];
  return view;
}

function lookText(type, item) {
  if (type === 'reactions') return `People react with ${item.emoji || 'its emoji'} to get this role. If you switch the menu to buttons, it looks like this:`;
  if (type === 'dropdown') return 'In the dropdown it shows its text, emoji and description. As a button it looks like this:';
  return 'This is how the button looks:';
}

async function itemView(engine, sid, mid, idx, note) {
  const menu = getMenu(engine, sid, mid);
  if (!menu) return missingMenu();
  const item = Number.isInteger(idx) ? menu.items[idx] : null;
  if (!item) return editorView(engine, sid, mid, `${ICONS.warn} That role isn't on the menu anymore.`);
  const role = (await roleMapOf(engine, sid)).get(item.roleId);
  const live = liveItems(menu);
  const n = live.findIndex((x) => x.idx === idx);
  const as = menu.type === 'reactions' ? 'reactions' : 'buttons';
  const fields = [
    { name: 'Gives', value: role ? `<@&${role.id}>` : `${ICONS.warn} a deleted role`, inline: true },
    { name: 'Colour', value: STYLES[item.style], inline: true },
    { name: 'Position', value: `${n + 1} of ${live.length}`, inline: true },
    { name: 'Emoji', value: item.emoji || 'None', inline: true },
    { name: 'Description', value: item.note || '*None*', inline: true },
    { name: 'On the posted menu', value: itemLine(item, as) },
  ];
  return {
    embeds: [card({ title: `✏️ ${item.label}`, body: [note, lookText(menu.type, item)].filter(Boolean).join('\n\n'), fields, color: menu.color ?? ROLES_COLOR, footer: `Typed: /roles item ${mid} ${n + 1} label … · color … · emoji … · up` })],
    components: [
      row(button(item.label, cid('item', mid, idx), item.style, item.emoji || undefined, { disabled: true })),
      row(
        button('Edit text & emoji', cid('itemform', mid, idx), 'primary', '✏️'),
        button('Up', cid('itemmove', mid, idx, 'up'), 'secondary', '⬆️', { disabled: n <= 0 }),
        button('Down', cid('itemmove', mid, idx, 'down'), 'secondary', '⬇️', { disabled: n >= live.length - 1 }),
        button('Remove', cid('unitem', mid, idx), 'danger', '➖'),
      ),
      row(styleButtons(item.style, (s) => cid('itemstyle', mid, idx, s))),
      row(backMenu(mid)),
    ],
  };
}

async function pickerView(engine, sid, sess, page = 0, note) {
  const found = engine.router.getSession(sess);
  const s = found && found.sid === sid && Array.isArray(found.roleIds) ? found : null;
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
  nav.push(button('Done', cid('tab', s.mid, 'roles'), 'success', '✅'));
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
    const why = guardReason(engine, sid, role.id);
    if (why) { skipped.push(`**${role.name}** ${why}, so it can't go on a menu anyone can click`); continue; }
    if (typeof role.position === 'number' && role.position >= myTop) { skipped.push(`**${role.name}** is at or above your highest role, so you can't hand it out`); continue; }
    menu.items.push({ roleId: role.id, emoji: extras.emoji || null, label: clip(extras.label || role.name, MAX_LABEL), style: menu.defaultStyle, note: null, pos: nextPos(menu) });
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

async function channelPicker(ctx, mid, note) {
  const { engine, serverId: sid } = ctx;
  const menu = getMenu(engine, sid, mid);
  if (!menu) return editorView(engine, sid, mid);
  const chans = await textChannels(engine, sid);
  const detected = (await engine.detectChannels(sid).catch(() => ({}))).roles || null;
  const ordered = detected ? [detected, ...chans.filter((c) => c.id !== detected.id)] : chans;
  const sess = openSession(ctx, { mid, channelIds: ordered.map((c) => c.id) });
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
  const known = (await textChannels(engine, sid)).some((c) => c.id === channelId);
  if (!known) return show(ctx, await editorView(engine, sid, mid, `${ICONS.warn} I can't find that channel in this server. Press **Post** and pick one from the list.`));
  const live = isLive(ctx);
  if (live) await ctx.update({ embeds: [dialog.info('Posting…', `Putting **${menu.title}** in **${await channelName(engine, sid, channelId)}**.`)], components: [] });
  try {
    const res = await postMenu(engine, sid, mid, channelId);
    return show(ctx, await editorView(engine, sid, mid, res.note));
  } catch (e) {
    if (!live) throw e;
    const { title, body } = explain(e, { action: 'post the menu', perm: 'send_messages' });
    return show(ctx, await editorView(engine, sid, mid, `${ICONS.error} **${title}**\n${body}`));
  }
}

async function startPost(ctx, mid) {
  const { engine, serverId: sid } = ctx;
  const menu = getMenu(engine, sid, mid);
  if (!menu) return show(ctx, await editorView(engine, sid, mid));
  if (!liveItems(menu).length) return show(ctx, await editorView(engine, sid, mid, `${ICONS.warn} Add at least one role before posting.`));
  if (menu.messageId && menu.channelId) return doPost(ctx, mid, menu.channelId);
  return show(ctx, await channelPicker(ctx, mid));
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
  if (!menu) return show(ctx, await editorView(engine, sid, mid));
  if (!liveItems(menu).length) return ctx.warn('Nothing to preview', 'Add some roles first.');
  const roleMap = await roleMapOf(engine, sid);
  const note = { content: `-# Preview of **${menu.title}**. Buttons are turned off here.` };
  if (menu.type === 'dropdown') {
    return engine.caps.attempt(sid, 'selects', () => ctx.ephemeral({ ...note, ...render(mid, menu, 'dropdown', roleMap, { disabled: true }) }), () => ctx.ephemeral({ content: `${note.content}\n-# Dropdowns aren't on for this server yet, so it will post as buttons.`, ...render(mid, menu, 'buttons', roleMap, { disabled: true }) }));
  }
  if (menu.type === 'reactions') return ctx.ephemeral({ content: `${note.content}\n-# I'll react with: ${liveItems(menu).map(({ item }) => item.emoji || '❔').join(' ')}`, ...render(mid, menu, 'reactions', roleMap) });
  return ctx.ephemeral({ ...note, ...render(mid, menu, 'buttons', roleMap, { disabled: true }) });
}

function setType(engine, sid, mid, type) {
  const menu = changeMenu(engine, sid, mid, (m) => { if (m.type === type) return false; m.type = type; return true; });
  if (!menu) return null;
  if (type === 'reactions') {
    const bare = liveItems(menu).filter(({ item }) => !item.emoji);
    if (bare.length) return `${ICONS.warn} Reaction menus need an emoji on every role. Missing: ${bare.map(({ item }) => `**${item.label}**`).join(', ')}. Set them on the **Roles** tab.`;
  }
  if (type === 'dropdown' && engine.caps.state(sid, 'selects') === false) return `${ICONS.info} Dropdowns aren't on for this server yet, so I'll post it as buttons until they are.`;
  return `${ICONS.ok} Type set to **${TYPES[type]}**.`;
}

function setMode(engine, sid, mid, mode) {
  return changeMenu(engine, sid, mid, (m) => { if (m.mode === mode) return false; m.mode = mode; return true; }) ? `${ICONS.ok} Mode set to **${MODES[mode]}**: ${MODE_HELP[mode]}.` : null;
}

function removeItem(ctx, mid, idx) {
  const { engine, serverId: sid } = ctx;
  const menu = getMenu(engine, sid, mid);
  const item = Number.isInteger(idx) ? menu?.items?.[idx] : null;
  if (!item) return null;
  changeMenu(engine, sid, mid, (m) => { m.items[idx] = null; });
  const u = engine.router.addUndo({
    serverId: sid,
    actorId: ctx.userId,
    perm: 'admin',
    label: `remove ${item.label}`,
    run: async (i) => {
      let why = null;
      const back = changeMenu(engine, sid, mid, (m) => {
        const live = liveItems(m);
        if (live.some((x) => x.item.roleId === item.roleId)) { why = `<@&${item.roleId}> is already on **${m.title}** again.`; return false; }
        if (live.length >= MAX_ITEMS) { why = `**${m.title}** is full (${MAX_ITEMS} roles). Take one off first.`; return false; }
        if (!m.items[idx]) m.items[idx] = item; else m.items.push(item);
        return true;
      });
      const embed = !back ? dialog.warn('Too late', 'That menu was deleted.') : why ? dialog.info('Nothing to undo', why) : dialog.ok('Role is back', `**${item.label}** is on **${menu.title}** again.`);
      await i.ephemeral('', { embeds: [embed] });
    },
  });
  return { item, undo: u.button };
}

function moveItem(engine, sid, mid, idx, dir) {
  let moved = false;
  changeMenu(engine, sid, mid, (m) => {
    const order = liveItems(m).map((x) => x.idx);
    const i = order.indexOf(idx);
    const j = dir === 'up' ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= order.length) return false;
    [order[i], order[j]] = [order[j], order[i]];
    order.forEach((k, n) => { m.items[k].pos = n; });
    moved = true;
    return true;
  });
  return moved;
}

function parseAccent(text) {
  const t = String(text ?? '').trim().toLowerCase().replace(/\s+/g, '');
  if (isOff(t)) return { value: null };
  const named = own(ACCENTS, t);
  if (named !== undefined) return { value: named };
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/.exec(t);
  if (!m) return { bad: `I don't know the colour **${clip(String(text), 40)}**. Use a name like ${Object.keys(ACCENTS).filter((k) => k !== 'gray').join(', ')}, or a hex code like #ff8800.` };
  const h = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
  return { value: parseInt(h, 16) };
}

function pictureProblem(raw) {
  const text = String(raw ?? '').trim();
  if (text.length > MAX_LINK) return `That link is too long. Picture links can be up to ${MAX_LINK} characters.`;
  let u;
  try { u = new URL(text); } catch { return "That isn't a link. Paste the full picture link, starting with https://."; }
  if (u.protocol !== 'https:') return 'Picture links have to start with **https://**.';
  if (u.username || u.password || u.port) return "That link has extra login or port details, so Yapin' won't show it. Paste a plain picture link.";
  const host = u.hostname.toLowerCase();
  if (PICTURE_HOSTS.includes(host) || PICTURE_DOMAINS.some((d) => host.endsWith(`.${d}`))) return null;
  return `Yapin' doesn't show pictures from **${clip(host, 60)}**. Upload the picture to Yapin' or i.imgur.com (media.tenor.com and media.giphy.com work too) and paste that link.`;
}

function applyPicture(engine, sid, mid, raw, kind) {
  const text = String(raw ?? '').trim();
  if (isOff(text)) {
    changeMenu(engine, sid, mid, (m) => { if (!m.image) return false; m.image = null; return true; });
    return { note: `${ICONS.ok} No picture on this menu.` };
  }
  const problem = pictureProblem(text);
  if (problem) return { bad: problem };
  changeMenu(engine, sid, mid, (m) => { m.image = text; if (kind) m.imageKind = kind; });
  return { note: `${ICONS.ok} Picture saved.` };
}

function applyFooter(engine, sid, mid, raw) {
  const text = String(raw ?? '').trim();
  if (isOff(text)) {
    changeMenu(engine, sid, mid, (m) => { if (!m.footer) return false; m.footer = null; return true; });
    return { note: `${ICONS.ok} The footer explains the menu by itself again.` };
  }
  changeMenu(engine, sid, mid, (m) => { m.footer = clip(text, MAX_FOOTER); });
  return { note: `${ICONS.ok} Footer saved.` };
}

function applyAccent(engine, sid, mid, raw) {
  const res = parseAccent(raw);
  if (res.bad) return res;
  changeMenu(engine, sid, mid, (m) => { m.color = res.value; });
  return { note: `${ICONS.ok} Accent colour set to **${res.value === null ? 'default' : hex(res.value)}**.` };
}

function applyMax(engine, sid, mid, raw) {
  const text = String(raw ?? '').trim();
  const n = isOff(text) || /^(no ?limit|unlimited|any)$/i.test(text) ? 0 : /^\d+$/.test(text) ? Number(text) : NaN;
  if (!Number.isInteger(n) || n < 0 || n > MAX_ITEMS) return { bad: `Type a number from 1 to ${MAX_ITEMS}, or 0 for no limit.` };
  changeMenu(engine, sid, mid, (m) => { m.maxRoles = n; });
  const menu = getMenu(engine, sid, mid);
  const extra = n && menu?.mode === 'unique' ? ' Pick one mode already allows only one, so this counts once you switch modes.' : '';
  return { note: `${ICONS.ok} ${n ? `People can hold up to ${plural(n, 'role')} from this menu.` : 'No limit on how many roles people take from this menu.'}${extra}` };
}

async function applyNeed(ctx, mid, raw) {
  const { engine, serverId: sid } = ctx;
  const text = String(raw ?? '').trim();
  if (isOff(text) || /^@?(everyone|anyone)$/i.test(text)) {
    changeMenu(engine, sid, mid, (m) => { if (!m.needRole) return false; m.needRole = null; return true; });
    return { note: `${ICONS.ok} Anyone can use this menu.` };
  }
  const role = await ctx.findRole(text);
  if (!role) return { bad: `I can't find a role called **${clip(text, 60)}**. Mention it like **@Verified** or type its name.` };
  if (isEveryone(role, sid)) return applyNeed(ctx, mid, '');
  changeMenu(engine, sid, mid, (m) => { m.needRole = role.id; });
  return { note: `${ICONS.ok} Only people with **@${role.name}** can use this menu now.` };
}

async function applyItem(ctx, mid, idx, what, value) {
  const { engine, serverId: sid } = ctx;
  const menu = getMenu(engine, sid, mid);
  const item = menu?.items?.[idx];
  if (!item) return { bad: "That role isn't on the menu anymore." };
  const w = String(what || '').toLowerCase();
  if (['label', 'name', 'text', 'title'].includes(w)) {
    if (!value) return { bad: 'Tell me the new text, like `label Gamers`.' };
    changeMenu(engine, sid, mid, (m) => { m.items[idx].label = clip(value, MAX_LABEL); });
    return { note: `${ICONS.ok} Button text set to **${clip(value, MAX_LABEL)}**.` };
  }
  if (w === 'emoji' || w === 'icon') {
    if (isOff(value)) {
      if (menu.type === 'reactions') return { bad: 'Reaction menus need an emoji on every role, so I kept this one.' };
      changeMenu(engine, sid, mid, (m) => { m.items[idx].emoji = null; });
      return { note: `${ICONS.ok} Emoji removed.` };
    }
    if (!isEmoji(value)) return { bad: `**${clip(value, 40)}** doesn't look like one emoji. Use a single emoji like 🎮, or a server emoji.` };
    changeMenu(engine, sid, mid, (m) => { m.items[idx].emoji = value; });
    return { note: `${ICONS.ok} Emoji set to ${value}.${await emojiNote(engine, sid, value)}` };
  }
  if (['color', 'colour', 'style'].includes(w)) {
    const s = own(STYLE_WORDS, String(value || '').toLowerCase());
    if (!s) return { bad: 'Pick **blue**, **grey**, **green** or **red**.' };
    changeMenu(engine, sid, mid, (m) => { m.items[idx].style = s; });
    return { note: `${ICONS.ok} Button colour set to **${STYLES[s]}**.` };
  }
  if (['desc', 'description', 'note', 'about', 'info'].includes(w)) {
    const note = isOff(value) ? null : clip(value, MAX_NOTE);
    changeMenu(engine, sid, mid, (m) => { m.items[idx].note = note; });
    return { note: `${ICONS.ok} ${note ? 'Description saved.' : 'Description removed.'}` };
  }
  if (w === 'up' || w === 'down') {
    return moveItem(engine, sid, mid, idx, w) ? { note: `${ICONS.ok} Moved ${w}.` } : { note: `${ICONS.info} It's already at the ${w === 'up' ? 'top' : 'bottom'}.` };
  }
  if (['remove', 'delete', 'rm'].includes(w)) {
    const out = removeItem(ctx, mid, idx);
    return { removed: true, note: `➖ Took **${out.item.label}** off the menu.`, undo: out.undo };
  }
  return { bad: 'I can change **label**, **emoji**, **color**, **desc**, **up**, **down** or **remove**. Like `/roles item m1 2 color green`.' };
}

function findMenuId(engine, sid, token) {
  const menus = data(engine, sid).menus || {};
  const t = String(token ?? '').trim().toLowerCase();
  if (!t) return null;
  if (own(menus, t)) return t;
  if (/^\d+$/.test(t) && own(menus, `m${t}`)) return `m${t}`;
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
  '`/roles item m1 2 label Gamers` · `color green` · `emoji 🎮` · `desc For ranked` · `up` · `down` · `remove`',
  '`/roles set m1 accent blue` · `image <link>` · `thumbnail <link>` · `footer <text>` · `list off` · `max 2` · `needs @Verified` · `title …` · `text …`',
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

async function runSet(ctx, mid, args) {
  const { engine, serverId: sid } = ctx;
  const what = String(args[0] || '').toLowerCase();
  const value = args.slice(1).join(' ').trim();
  const done = async (res, tab) => (res.bad ? ctx.warn("That didn't work", res.bad) : show(ctx, await editorView(engine, sid, mid, res.note, { tab })));
  if (['accent', 'color', 'colour'].includes(what)) return done(applyAccent(engine, sid, mid, value), 'style');
  if (['image', 'picture', 'banner', 'pic'].includes(what)) return done(applyPicture(engine, sid, mid, value, 'image'), 'content');
  if (['thumbnail', 'thumb', 'corner', 'icon'].includes(what)) return done(applyPicture(engine, sid, mid, value, 'thumbnail'), 'content');
  if (what === 'footer') return done(applyFooter(engine, sid, mid, value), 'content');
  if (['max', 'limit', 'maxroles'].includes(what)) return done(applyMax(engine, sid, mid, value), 'settings');
  if (['needs', 'need', 'require', 'requires', 'gate', 'lock'].includes(what)) return done(await applyNeed(ctx, mid, value), 'settings');
  if (['list', 'showlist', 'rolelist'].includes(what)) {
    const on = !/^(off|no|hide|hidden|false|0)$/i.test(value);
    changeMenu(engine, sid, mid, (m) => { m.showList = on; });
    return done({ note: `${ICONS.ok} The role list is ${on ? 'shown' : 'hidden'} on the posted menu.` }, 'content');
  }
  if (what === 'title') {
    if (!value) return ctx.warn("That didn't work", 'Tell me the new title, like `/roles set m1 title Verify!`.');
    changeMenu(engine, sid, mid, (m) => { m.title = clip(value, MAX_TITLE); });
    return done({ note: `${ICONS.ok} Title saved.` }, 'content');
  }
  if (['text', 'description', 'desc'].includes(what)) {
    changeMenu(engine, sid, mid, (m) => { m.description = isOff(value) ? '' : clip(value, MAX_TEXT); });
    return done({ note: `${ICONS.ok} Text saved.` }, 'content');
  }
  if (['default', 'buttons', 'newcolor', 'newcolour'].includes(what)) {
    const s = own(STYLE_WORDS, value.toLowerCase());
    if (!s) return ctx.warn("That didn't work", 'Pick **blue**, **grey**, **green** or **red**.');
    changeMenu(engine, sid, mid, (m) => { m.defaultStyle = s; });
    return done({ note: `${ICONS.ok} New buttons will be **${STYLES[s]}**.` }, 'style');
  }
  return ctx.warn('What should I change?', `Try one of these:\n${usage}`);
}

async function runItem(ctx, mid, args) {
  const { engine, serverId: sid } = ctx;
  const menu = getMenu(engine, sid, mid);
  const live = liveItems(menu);
  const n = /^#?\d+$/.test(args[0] || '') ? Number(String(args[0]).replace('#', '')) : null;
  const entry = n ? live[n - 1] : null;
  if (!entry) return ctx.warn('Which role?', `Tell me its number from the list, like \`/roles item ${mid} 1 color green\`. This menu has ${plural(live.length, 'role')}.`);
  if (!args[1]) return show(ctx, await itemView(engine, sid, mid, entry.idx));
  const res = await applyItem(ctx, mid, entry.idx, args[1], args.slice(2).join(' ').trim());
  if (res.bad) return ctx.warn("That didn't work", res.bad);
  if (res.removed) return show(ctx, await editorView(engine, sid, mid, res.note, { undo: res.undo }));
  return show(ctx, await itemView(engine, sid, mid, entry.idx, res.note));
}

async function runTyped(ctx) {
  const { engine, serverId: sid } = ctx;
  const argv = ctx.argv.map(String);
  const word = argv[0].toLowerCase().replace(/^\//, '');
  const sub = own(SUBS, word) || (findMenuId(engine, sid, word) && /^m?\d+$/.test(word) ? 'open' : null);
  if (!sub) {
    const guess = didYouMean(word, Object.keys(SUBS));
    return ctx.warn("I didn't get that", `${guess.length ? `Did you mean ${guess.map((g) => `**${g}**`).join(', ')}?\n\n` : ''}${usage}`);
  }
  const rest = own(SUBS, word) ? argv.slice(1) : argv;
  if (sub === 'help') return ctx.info('Role menu shortcuts', usage);
  if (sub === 'list') return show(ctx, await homeView(engine, sid));
  if (sub === 'new') {
    if (!rest.length) return openNewForm(ctx);
    const text = rest.join(' ');
    const [title, description = ''] = text.split('|').map((s) => s.trim());
    const mid = createMenu(engine, sid, { title, description });
    return show(ctx, await editorView(engine, sid, mid, `${ICONS.ok} Made **${clip(title, MAX_TITLE)}** (\`${mid}\`). Add roles next.`));
  }
  const mid = await needMenu(ctx, rest[0]);
  if (!mid) return null;
  const args = rest.slice(1);
  if (sub === 'open') return show(ctx, await editorView(engine, sid, mid, null, { tab: String(args[0] || '').toLowerCase() }));
  if (sub === 'preview') return previewMenu(ctx, mid);
  if (sub === 'delete') return deleteMenu(ctx, mid);
  if (sub === 'item') return runItem(ctx, mid, args);
  if (sub === 'set') return runSet(ctx, mid, args);
  if (sub === 'add') {
    if (!args.length) return show(ctx, await pickerView(engine, sid, openSession(ctx, { mid, roleIds: (await manageableRoles(engine, sid, ctx.userId)).map((r) => r.id) })));
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
    return show(ctx, await editorView(engine, sid, mid, `➖ Took **${out.item.label}** off the menu.`, { undo: out.undo }));
  }
  if (sub === 'type') {
    const t = own(TYPE_WORDS, (args[0] || '').toLowerCase());
    if (!t) return ctx.warn('Which type?', 'Pick **buttons**, **dropdown** or **reactions**, like `/roles type m1 buttons`.');
    return show(ctx, await editorView(engine, sid, mid, setType(engine, sid, mid, t), { tab: 'style' }));
  }
  if (sub === 'mode') {
    const m = own(MODE_WORDS, (args[0] || '').toLowerCase().replace(/[^a-z]/g, ''));
    if (!m) return ctx.warn('Which mode?', 'Pick **toggle** (click again to remove), **unique** (one role at a time) or **add** (only gives roles).');
    return show(ctx, await editorView(engine, sid, mid, setMode(engine, sid, mid, m), { tab: 'settings' }));
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
      { id: 'title', label: 'Title', placeholder: 'Pick your games', max: MAX_TITLE },
      { id: 'description', label: 'Text (optional)', style: 'paragraph', required: false, placeholder: 'Click a button to get pinged for that game.', max: MAX_TEXT },
    ],
  });
}

async function runCommand(ctx) {
  await ctx.require('admin');
  if (ctx.argv.length) return runTyped(ctx);
  return show(ctx, await homeView(ctx.engine, ctx.serverId));
}

const admin = (run) => ({
  perm: 'admin',
  run: async (ctx) => {
    await ctx.require('admin');
    return run(ctx);
  },
});

const formOpener = (kind, tab, build) => admin(async (ctx) => {
  const { engine, serverId: sid } = ctx;
  const mid = ctx.argv[0];
  const menu = getMenu(engine, sid, mid);
  if (!menu) return show(ctx, await editorView(engine, sid, mid));
  setPending(engine, sid, ctx.userId, { kind, mid, tab });
  return ctx.form(build(menu));
});

const formSaver = (kind, apply) => admin(async (ctx) => {
  const { engine, serverId: sid } = ctx;
  const p = takePending(engine, sid, ctx.userId, kind);
  if (!p) return ctx.warn('That form expired', 'Open the menu again from **/roles**.');
  if (!getMenu(engine, sid, p.mid)) return show(ctx, await homeView(engine, sid, `${ICONS.warn} That menu was deleted.`));
  const values = ctx.values && typeof ctx.values === 'object' && !Array.isArray(ctx.values) ? ctx.values : {};
  const res = await apply(ctx, p, values);
  if (res.bad) setPending(engine, sid, ctx.userId, p);
  const note = res.bad ? `${ICONS.warn} ${res.bad}` : res.note;
  if (Number.isInteger(p.idx)) return show(ctx, await itemView(engine, sid, p.mid, p.idx, note));
  return show(ctx, await editorView(engine, sid, p.mid, note, { tab: p.tab }));
});

const str = (v) => String(v ?? '').trim();

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
      const title = str(ctx.values?.title) || 'Pick your roles';
      const mid = createMenu(ctx.engine, ctx.serverId, { title, description: str(ctx.values?.description) });
      return show(ctx, await editorView(ctx.engine, ctx.serverId, mid, `${ICONS.ok} Made **${clip(title, MAX_TITLE)}**. Add some roles next.`));
    }),
    open: admin(async (ctx) => show(ctx, await editorView(ctx.engine, ctx.serverId, ctx.argv[0], null, { tab: ctx.argv[1] }))),
    tab: admin(async (ctx) => show(ctx, await editorView(ctx.engine, ctx.serverId, ctx.argv[0], null, { tab: ctx.argv[1], page: ctx.argv[2] }))),
    items: admin(async (ctx) => show(ctx, await editorView(ctx.engine, ctx.serverId, ctx.argv[0], null, { tab: 'roles', page: ctx.argv[1] }))),
    add: admin(async (ctx) => {
      const { engine, serverId: sid } = ctx;
      const mid = ctx.argv[0];
      if (!getMenu(engine, sid, mid)) return show(ctx, await editorView(engine, sid, mid));
      const sess = openSession(ctx, { mid, roleIds: (await manageableRoles(engine, sid, ctx.userId)).map((r) => r.id) });
      return show(ctx, await pickerView(engine, sid, sess, 0));
    }),
    addpg: admin(async (ctx) => {
      if (!ownSession(ctx, ctx.argv[0], 'roleIds')) return show(ctx, await homeView(ctx.engine, ctx.serverId, `${ICONS.warn} That picker expired. Open the menu again.`));
      return show(ctx, await pickerView(ctx.engine, ctx.serverId, ctx.argv[0], ctx.argv[1]));
    }),
    addsel: admin(async (ctx) => {
      const { engine, serverId: sid } = ctx;
      const s = ownSession(ctx, ctx.argv[0], 'roleIds');
      if (!s) return show(ctx, await homeView(engine, sid, `${ICONS.warn} That picker expired. Open the menu again.`));
      const map = await roleMapOf(engine, sid);
      const picked = (Array.isArray(ctx.values) ? ctx.values : []).map((v) => map.get(s.roleIds[Number(v)])).filter(Boolean);
      const res = await addRolesToMenu(engine, sid, s.mid, picked, {}, ctx.userId);
      return show(ctx, await editorView(engine, sid, s.mid, res.note || 'Nothing added.'));
    }),
    addbtn: admin(async (ctx) => {
      const { engine, serverId: sid } = ctx;
      const s = ownSession(ctx, ctx.argv[0], 'roleIds');
      if (!s) return show(ctx, await homeView(engine, sid, `${ICONS.warn} That picker expired. Open the menu again.`));
      const role = (await roleMapOf(engine, sid)).get(s.roleIds[Number(ctx.argv[1])]);
      const res = role ? await addRolesToMenu(engine, sid, s.mid, [role], {}, ctx.userId) : { note: `${ICONS.warn} That role doesn't exist anymore.` };
      return show(ctx, await pickerView(engine, sid, ctx.argv[0], 0, `${res.note}\nPick more, or press **Done**.`));
    }),
    item: admin(async (ctx) => show(ctx, await itemView(ctx.engine, ctx.serverId, ctx.argv[0], Number(ctx.argv[1])))),
    itemsel: admin(async (ctx) => {
      const v = Array.isArray(ctx.values) ? ctx.values[0] : null;
      return show(ctx, await itemView(ctx.engine, ctx.serverId, ctx.argv[0], /^\d+$/.test(String(v ?? '')) ? Number(v) : NaN));
    }),
    itemform: admin(async (ctx) => {
      const { engine, serverId: sid } = ctx;
      const [mid, idxS] = ctx.argv;
      const idx = Number(idxS);
      const item = Number.isInteger(idx) ? getMenu(engine, sid, mid)?.items?.[idx] : null;
      if (!item) return show(ctx, await editorView(engine, sid, mid, `${ICONS.warn} That role isn't on the menu anymore.`));
      setPending(engine, sid, ctx.userId, { kind: 'item', mid, idx });
      return ctx.form({
        title: 'Button text and emoji',
        action: 'itemsave',
        fields: [
          { id: 'label', label: 'Button text', value: item.label, max: MAX_LABEL },
          { id: 'emoji', label: 'Emoji (optional)', required: false, value: item.emoji || '', placeholder: '🎮', max: 64 },
          { id: 'note', label: 'Short description (optional)', required: false, value: item.note || '', placeholder: 'Get pinged for game nights', max: MAX_NOTE },
        ],
      });
    }),
    itemsave: formSaver('item', async (ctx, p, v) => {
      const { engine, serverId: sid } = ctx;
      const emoji = str(v.emoji);
      const label = str(v.label);
      const note = str(v.note);
      if (emoji && !isEmoji(emoji)) return { bad: `**${clip(emoji, 40)}** doesn't look like one emoji. Use a single emoji like 🎮, or a server emoji.` };
      const menu = getMenu(engine, sid, p.mid);
      if (!emoji && menu.type === 'reactions') return { bad: 'Reaction menus need an emoji on every role. Add one, like 🎮.' };
      const changed = changeMenu(engine, sid, p.mid, (m) => {
        const it = m.items[p.idx];
        if (!it) return false;
        it.emoji = emoji || null;
        if (label) it.label = clip(label, MAX_LABEL);
        it.note = note ? clip(note, MAX_NOTE) : null;
        return true;
      });
      return { note: changed?.items?.[p.idx] ? `${ICONS.ok} Saved.${await emojiNote(engine, sid, emoji)}` : `${ICONS.warn} That role isn't on the menu anymore.` };
    }),
    itemstyle: admin(async (ctx) => {
      const { engine, serverId: sid } = ctx;
      const [mid, idxS, style] = ctx.argv;
      const idx = Number(idxS);
      const ok = own(STYLES, style) && Number.isInteger(idx) && getMenu(engine, sid, mid)?.items?.[idx];
      if (ok) changeMenu(engine, sid, mid, (m) => { if (m.items[idx].style === style) return false; m.items[idx].style = style; return true; });
      return show(ctx, await itemView(engine, sid, mid, idx, ok ? `${ICONS.ok} Button colour set to **${STYLES[style]}**.` : null));
    }),
    itemmove: admin(async (ctx) => {
      const { engine, serverId: sid } = ctx;
      const [mid, idxS, dir] = ctx.argv;
      const idx = Number(idxS);
      const moved = (dir === 'up' || dir === 'down') && Number.isInteger(idx) && moveItem(engine, sid, mid, idx, dir);
      return show(ctx, await itemView(engine, sid, mid, idx, moved ? `${ICONS.ok} Moved ${dir}.` : null));
    }),
    unitem: admin(async (ctx) => {
      const { engine, serverId: sid } = ctx;
      const [mid, idxS] = ctx.argv;
      const out = removeItem(ctx, mid, Number(idxS));
      if (!out) return show(ctx, await editorView(engine, sid, mid, `${ICONS.warn} That role was already taken off.`));
      return show(ctx, await editorView(engine, sid, mid, `➖ Took **${out.item.label}** off the menu.`, { undo: out.undo }));
    }),
    text: formOpener('text', 'content', (menu) => ({
      title: 'Menu title and text',
      action: 'textsave',
      fields: [
        { id: 'title', label: 'Title', value: menu.title, max: MAX_TITLE },
        { id: 'description', label: 'Text (optional)', style: 'paragraph', required: false, value: menu.description, max: MAX_TEXT },
      ],
    })),
    textsave: formSaver('text', async (ctx, p, v) => {
      const title = str(v.title);
      changeMenu(ctx.engine, ctx.serverId, p.mid, (m) => { if (title) m.title = clip(title, MAX_TITLE); m.description = clip(str(v.description), MAX_TEXT); });
      return { note: `${ICONS.ok} Text saved.` };
    }),
    imgform: formOpener('img', 'content', (menu) => ({
      title: 'Menu picture',
      action: 'imgsave',
      fields: [{ id: 'url', label: 'Picture link (empty removes it)', required: false, value: menu.image || '', placeholder: 'https://i.imgur.com/abc.png', max: MAX_LINK }],
    })),
    imgsave: formSaver('img', async (ctx, p, v) => applyPicture(ctx.engine, ctx.serverId, p.mid, v.url)),
    imgkind: admin(async (ctx) => {
      const { engine, serverId: sid } = ctx;
      const [mid, kind] = ctx.argv;
      let note = null;
      if (kind === 'none') note = applyPicture(engine, sid, mid, '').note;
      else if (kind === 'image' || kind === 'thumbnail') {
        changeMenu(engine, sid, mid, (m) => { if (!m.image || m.imageKind === kind) return false; m.imageKind = kind; return true; });
        note = `${ICONS.ok} The picture shows ${kind === 'image' ? 'big, under the text' : 'small, in the corner'}.`;
      }
      return show(ctx, await editorView(engine, sid, mid, note, { tab: 'content' }));
    }),
    footform: formOpener('foot', 'content', (menu) => ({
      title: 'Menu footer',
      action: 'footsave',
      fields: [{ id: 'footer', label: 'Footer (empty = explain the menu)', required: false, value: menu.footer || '', placeholder: footerFor({ ...menu, footer: null }, menu.type), max: MAX_FOOTER }],
    })),
    footsave: formSaver('foot', async (ctx, p, v) => applyFooter(ctx.engine, ctx.serverId, p.mid, v.footer)),
    showlist: admin(async (ctx) => {
      const [mid, state] = ctx.argv;
      const on = state === 'on' ? true : state === 'off' ? false : null;
      if (on !== null) changeMenu(ctx.engine, ctx.serverId, mid, (m) => { if (m.showList === on) return false; m.showList = on; return true; });
      return show(ctx, await editorView(ctx.engine, ctx.serverId, mid, on === null ? null : `${ICONS.ok} The role list is ${on ? 'shown' : 'hidden'} on the posted menu.`, { tab: 'content' }));
    }),
    accform: formOpener('acc', 'style', (menu) => ({
      title: 'Accent colour',
      action: 'accsave',
      fields: [{ id: 'color', label: 'Colour name or hex (empty = default)', required: false, value: menu.color === null ? '' : hex(menu.color), placeholder: 'blue or #ff8800', max: 20 }],
    })),
    accsave: formSaver('acc', async (ctx, p, v) => applyAccent(ctx.engine, ctx.serverId, p.mid, v.color)),
    defstyle: admin(async (ctx) => {
      const [mid, style] = ctx.argv;
      const ok = !!own(STYLES, style);
      if (ok) changeMenu(ctx.engine, ctx.serverId, mid, (m) => { if (m.defaultStyle === style) return false; m.defaultStyle = style; return true; });
      return show(ctx, await editorView(ctx.engine, ctx.serverId, mid, ok ? `${ICONS.ok} New buttons will be **${STYLES[style]}**.` : null, { tab: 'style' }));
    }),
    allstyle: admin(async (ctx) => {
      const mid = ctx.argv[0];
      const menu = changeMenu(ctx.engine, ctx.serverId, mid, (m) => {
        const items = m.items.filter(Boolean);
        if (!items.length || items.every((i) => i.style === m.defaultStyle)) return false;
        items.forEach((i) => { i.style = m.defaultStyle; });
        return true;
      });
      return show(ctx, await editorView(ctx.engine, ctx.serverId, mid, menu ? `${ICONS.ok} Every button is **${STYLES[menu.defaultStyle]}** now.` : null, { tab: 'style' }));
    }),
    type: admin(async (ctx) => {
      const [mid, t] = ctx.argv;
      const note = own(TYPES, t) ? setType(ctx.engine, ctx.serverId, mid, t) : null;
      return show(ctx, await editorView(ctx.engine, ctx.serverId, mid, note, { tab: 'style' }));
    }),
    mode: admin(async (ctx) => {
      const [mid, m] = ctx.argv;
      const note = own(MODES, m) ? setMode(ctx.engine, ctx.serverId, mid, m) : null;
      return show(ctx, await editorView(ctx.engine, ctx.serverId, mid, note, { tab: 'settings' }));
    }),
    maxform: formOpener('max', 'settings', (menu) => ({
      title: 'Most roles per person',
      action: 'maxsave',
      fields: [{ id: 'max', label: `How many roles (0 = no limit, up to ${MAX_ITEMS})`, required: false, value: String(menu.maxRoles || 0), placeholder: '2', max: 3 }],
    })),
    maxsave: formSaver('max', async (ctx, p, v) => applyMax(ctx.engine, ctx.serverId, p.mid, v.max)),
    needform: formOpener('need', 'settings', () => ({
      title: 'Who can use this menu',
      action: 'needsave',
      fields: [{ id: 'role', label: 'Role needed (empty = anyone)', required: false, placeholder: '@Verified', max: 100 }],
    })),
    needsave: formSaver('need', async (ctx, p, v) => applyNeed(ctx, p.mid, v.role)),
    needclear: admin(async (ctx) => {
      const mid = ctx.argv[0];
      const res = await applyNeed(ctx, mid, '');
      return show(ctx, await editorView(ctx.engine, ctx.serverId, mid, res.note, { tab: 'settings' }));
    }),
    preview: admin((ctx) => previewMenu(ctx, ctx.argv[0])),
    post: admin((ctx) => startPost(ctx, ctx.argv[0])),
    postsel: admin((ctx) => doPost(ctx, ctx.argv[0], Array.isArray(ctx.values) ? ctx.values[0] : null)),
    postch: admin(async (ctx) => {
      const s = ownSession(ctx, ctx.argv[0], 'channelIds');
      const chId = s?.channelIds?.[Number(ctx.argv[1])];
      if (!s || !chId) return show(ctx, await homeView(ctx.engine, ctx.serverId, `${ICONS.warn} That channel list expired. Press **Post** again.`));
      return doPost(ctx, s.mid, chId);
    }),
    del: admin((ctx) => deleteMenu(ctx, ctx.argv[0])),
    p: {
      run: async (ctx) => {
        const [mid, idxS] = ctx.argv;
        const stale = postedProblem(ctx, mid, 'buttons');
        if (stale) return ctx.ephemeral(`${ICONS.warn} ${stale}`);
        const blocked = await gateProblem(ctx.engine, ctx.serverId, ctx.userId, getMenu(ctx.engine, ctx.serverId, mid));
        if (blocked) return ctx.ephemeral(gateCard(blocked));
        const res = await changeRole(ctx.engine, ctx.serverId, ctx.userId, mid, Number(idxS), 'toggle');
        return ctx.ephemeral(pickText([res]));
      },
    },
    d: {
      run: async (ctx) => {
        const mid = ctx.argv[0];
        const stale = postedProblem(ctx, mid, 'dropdown');
        if (stale) return ctx.ephemeral(`${ICONS.warn} ${stale}`);
        const menu = getMenu(ctx.engine, ctx.serverId, mid);
        const blocked = await gateProblem(ctx.engine, ctx.serverId, ctx.userId, menu);
        if (blocked) return ctx.ephemeral(gateCard(blocked));
        const picks = [...new Set((Array.isArray(ctx.values) ? ctx.values : []).map(Number))].slice(0, menu?.mode === 'unique' ? 1 : MAX_ITEMS);
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
    run: (ctx) => runCommand(ctx),
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
    'Each button can have its own text, emoji, colour and short description. The posted menu lists what every button gives.',
    'Modes: toggle (click again to remove), unique (one role from the menu at a time), add only. You can also cap how many roles one person takes, or only let people with a certain role use the menu.',
    'I can only hand out roles below my own role. Drag my role higher in Server settings → Roles if a role is missing.',
    'Typed shortcuts: /roles add m1 @Gamer 🎮 Gamers · /roles item m1 1 color green · /roles set m1 accent blue · /roles post m1 #get-roles',
  ],
});

async function onReaction(ctx, ev, added) {
  const { engine } = ctx;
  const sid = ev?.server_id;
  if (!sid || !ev.user_id || ev.user_id === botId(engine)) return;
  const entry = Object.entries(data(engine, sid).menus || {}).find(([, m]) => m && m.messageId && m.messageId === ev.message_id && m.postedAs === 'reactions');
  if (!entry) return;
  const mid = entry[0];
  const menu = normalizeMenu(entry[1]);
  const posted = menu.postedEmojis && typeof menu.postedEmojis === 'object' ? Object.entries(menu.postedEmojis) : null;
  const hit = posted ? posted.find(([, e]) => sameEmoji(e, ev.emoji)) : null;
  const idx = posted ? (hit ? Number(hit[0]) : -1) : menu.items.findIndex((i) => i && sameEmoji(i.emoji, ev.emoji));
  if (!Number.isInteger(idx) || idx < 0 || !menu.items[idx]) return;
  if (!added && menu.mode === 'add') return;
  const blocked = await gateProblem(engine, sid, ev.user_id, menu);
  if (blocked) { engine.log.debug(`[roles] reaction by ${ev.user_id} on ${mid}: ${blocked}`); return; }
  const res = await changeRole(engine, sid, ev.user_id, mid, idx, added ? 'add' : 'remove');
  if (res.problem) engine.log.debug(`[roles] reaction by ${ev.user_id} on ${mid}: ${res.problem}`);
}
