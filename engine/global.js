export const GLOBAL_KEY = 'global';
export const CURRENCY = { name: 'Shards', emoji: '💎' };

const asId = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

export const globalConfig = (engine, appId) => engine.settings.appConfig(GLOBAL_KEY, appId);
export const patchGlobalConfig = (engine, appId, patch) => engine.settings.patchApp(GLOBAL_KEY, appId, patch);

export function globalDoc(engine, ns, blank) {
  return engine.store.get(ns, GLOBAL_KEY, blank);
}

export function mutateGlobal(engine, ns, fn, blank) {
  let out;
  engine.store.update(ns, GLOBAL_KEY, (d) => { out = fn(d); }, blank);
  return out;
}

export function serverKeys(engine, ns) {
  const keys = engine.store.keys ? engine.store.keys(ns) : [];
  return [...keys].filter((k) => k !== GLOBAL_KEY);
}

export function mergeOnce(engine, ns, { blank, fold, flag = 'merged' }) {
  const doc = globalDoc(engine, ns, blank());
  if (doc && doc[flag]) return { merged: false, servers: 0 };
  let servers = 0;
  const out = mutateGlobal(engine, ns, (d) => {
    if (d[flag]) return { merged: false, servers: 0 };
    for (const key of serverKeys(engine, ns)) {
      const from = engine.store.get(ns, key, null);
      if (!from) continue;
      servers += 1;
      fold(d, from, key);
    }
    d[flag] = true;
    return { merged: true, servers };
  }, blank());
  return out || { merged: true, servers };
}

export function ownerIds(engine) {
  const list = globalDoc(engine, 'economy', {}).givers;
  return Array.isArray(list) ? list.filter(Boolean).map(String) : [];
}

export function canGiveCurrency(engine, uid) {
  const id = asId(uid);
  if (!id) return false;
  if (engine.isBotOwner?.(id)) return true;
  return ownerIds(engine).includes(id);
}

export function allowGiver(engine, uid) {
  const id = asId(uid);
  if (!id) return ownerIds(engine);
  return mutateGlobal(engine, 'economy', (d) => {
    d.givers = Array.isArray(d.givers) ? d.givers : [];
    if (!d.givers.includes(id)) d.givers.push(id);
    return d.givers.slice();
  }, {});
}

export function denyGiver(engine, uid) {
  const id = asId(uid);
  if (!id) return ownerIds(engine);
  return mutateGlobal(engine, 'economy', (d) => {
    d.givers = (Array.isArray(d.givers) ? d.givers : []).filter((x) => x !== id);
    return d.givers.slice();
  }, {});
}
