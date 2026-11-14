const isEveryone = (r, sid) => r.id === 'everyone' || r.id === sid || /^@?everyone$/i.test(String(r.name));

export async function sinkRole(engine, sid, role, tag = 'roles') {
  if (!role?.id) return false;
  const all = await engine.perms.roles(sid).catch(() => []);
  const others = all.filter((r) => r.id !== role.id && !isEveryone(r, sid) && typeof r.position === 'number');
  if (!others.length) return true;
  const bottom = Math.max(1, Math.min(...others.map((r) => r.position)));
  const current = typeof role.position === 'number' ? role.position : all.find((r) => r.id === role.id)?.position;
  if (typeof current === 'number' && current <= bottom) return true;
  try {
    const moved = await engine.bot.editRole(sid, role.id, { position: bottom });
    engine.perms.invalidate(`r:${sid}`);
    return !(typeof moved?.position === 'number' && moved.position > bottom);
  } catch (e) {
    engine.log.debug(`[${tag}] could not move a role to the bottom`, e?.message);
    return false;
  }
}
