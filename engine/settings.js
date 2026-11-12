const CORE_DEFAULTS = { preset: null, setupDone: false, logChannel: null, modRoles: [], adminRoles: [], timezone: 'UTC', caps: {} };

function merge(defaults, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value === undefined ? structuredClone(defaults) : value;
  const out = structuredClone(defaults ?? {});
  for (const [k, v] of Object.entries(value)) {
    out[k] = defaults && typeof defaults[k] === 'object' && defaults[k] && !Array.isArray(defaults[k]) && v && typeof v === 'object' && !Array.isArray(v)
      ? merge(defaults[k], v) : v;
  }
  return out;
}

export function createSettings({ store, apps }) {
  const NS = 'settings';
  const doc = (sid) => store.get(NS, sid, { core: {}, apps: {} });
  const write = (sid, fn) => store.update(NS, sid, (d) => { d.core ||= {}; d.apps ||= {}; fn(d); }, { core: {}, apps: {} });

  const appMeta = (id) => apps?.get(id)?.meta || null;
  const toggleListeners = new Set();

  return {
    core: (sid) => merge(CORE_DEFAULTS, doc(sid).core),
    patchCore(sid, patch) { write(sid, (d) => { Object.assign(d.core, patch); }); return this.core(sid); },

    isEnabled(sid, appId) {
      const meta = appMeta(appId);
      if (meta?.core) return true;
      if (!sid) return true;
      const a = doc(sid).apps[appId];
      if (a && typeof a.enabled === 'boolean') return a.enabled;
      return meta?.defaultEnabled !== false;
    },
    setEnabled(sid, appId, on) {
      const was = this.isEnabled(sid, appId);
      write(sid, (d) => { d.apps[appId] = { ...(d.apps[appId] || {}), enabled: !!on }; });
      const now = this.isEnabled(sid, appId);
      if (sid && was !== now) for (const fn of [...toggleListeners]) fn(sid, appId, now);
    },
    onToggle(fn) { toggleListeners.add(fn); return () => toggleListeners.delete(fn); },

    appConfig(sid, appId) {
      const defaults = appMeta(appId)?.defaults || {};
      return merge(defaults, doc(sid).apps[appId]?.config);
    },
    patchApp(sid, appId, patch) {
      write(sid, (d) => {
        const cur = d.apps[appId] || {};
        d.apps[appId] = { ...cur, config: { ...(cur.config || {}), ...patch } };
      });
      return this.appConfig(sid, appId);
    },
    setApp(sid, appId, config) { write(sid, (d) => { d.apps[appId] = { ...(d.apps[appId] || {}), config }; }); },
    raw: (sid) => doc(sid),
    servers: () => store.keys(NS),
  };
}
