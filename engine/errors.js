export const PERM_NAMES = {
  administrator: 'Administrator', manage_server: 'Manage Server', manage_roles: 'Manage Roles', manage_channels: 'Manage Channels',
  manage_messages: 'Manage Messages', manage_webhooks: 'Manage Webhooks', manage_emojis: 'Manage Emoji', manage_events: 'Manage Events',
  manage_nicknames: 'Manage Nicknames', kick_members: 'Kick Members', ban_members: 'Ban Members', timeout_members: 'Timeout Members',
  move_members: 'Move Members', mute_members: 'Mute Members', send_messages: 'Send Messages', embed_links: 'Embed Links',
  attach_files: 'Attach Files', add_reactions: 'Add Reactions', mention_everyone: 'Mention @everyone', read_history: 'Read Message History',
  view_channel: 'View Channel', connect: 'Connect', speak: 'Speak', view_audit_log: 'View Audit Log', create_invite: 'Create Invite',
};
export const permName = (p) => PERM_NAMES[p] || String(p).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

export class FriendlyError extends Error {
  constructor(message, { title = "Couldn't do that", hint } = {}) {
    super(message);
    this.friendly = true;
    this.title = title;
    this.hint = hint;
  }
}
export const friendly = (message, opts) => new FriendlyError(message, opts);

export function explain(err, ctx = {}) {
  if (err?.friendly) return { title: err.title, body: err.message + (err.hint ? `\n\n-# ${err.hint}` : '') };
  const status = err?.status;
  const raw = String(err?.message || '');
  const what = ctx.action ? `${ctx.action}${ctx.target ? ` ${ctx.target}` : ''}` : 'do that';
  if (status === 403) {
    const needs = ctx.perm ? `My role needs **${permName(ctx.perm)}**` : 'My role is missing a permission for this';
    const above = ctx.target ? ` and must be above ${ctx.target}'s highest role` : '';
    return {
      title: `I couldn't ${what}`,
      body: `${needs}${above}.\n\n-# Fix: Server settings → Roles → drag **${ctx.botRole || 'my role'}** higher and tick the permission.${/test/i.test(raw) ? ' (This feature may still be in testing on Yapin\'.)' : ''}`,
    };
  }
  if (status === 404) return { title: `I couldn't ${what}`, body: "I can't find that anymore. It may have been deleted, or I can't see it." };
  if (status === 409) return { title: `I couldn't ${what}`, body: "They aren't in a voice channel right now." };
  if (status === 429) {
    const s = Math.ceil(err.retryAfter || 5);
    return { title: "I'm being rate-limited", body: `Yapin' asked me to slow down. Try again in about ${s} second${s === 1 ? '' : 's'}.` };
  }
  if (status === 400) return { title: `I couldn't ${what}`, body: `Yapin' didn't accept that${raw && raw.length < 160 ? `: ${raw}` : '.'}` };
  if (status === 401) return { title: 'My token stopped working', body: 'The bot owner needs to make a new token in Settings → Developer.' };
  if (status === 503 || status === 502 || status === 504) return { title: "Yapin' is busy", body: 'Nothing was changed. Try again in a few seconds.' };
  if (err?.name === 'TimeoutError' || /fetch failed|ECONN|ENOTFOUND|network/i.test(raw)) return { title: "I can't reach Yapin'", body: 'The connection dropped. Try again in a moment.' };
  return { title: 'Something went wrong', body: 'That failed on my side. The owner can see the details in the bot log.' };
}

export function looksLikeFeatureOff(err) {
  const s = err?.status;
  const raw = String(err?.message || '');
  return (s === 400 || s === 403 || s === 404) && /test|flag|not (yet )?(available|enabled|supported)|unknown (component )?type|feature/i.test(raw);
}
