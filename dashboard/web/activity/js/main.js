import { connect } from './bridge.js';
import { createEngine } from './engine.js';
import { GAMES } from './games/index.js';
import { mountApp } from './ui/app.js';
import { configureProfiles, wantProfiles } from './profiles.js';
import { configureAdmins, refreshAdmins } from './admin.js';

function idsOf(bridge, list) {
  const ids = (Array.isArray(list) ? list : []).map((p) => (p && typeof p === 'object' ? p.id ?? p.user_id ?? p.userId : p));
  if (bridge && bridge.me) ids.push(typeof bridge.me === 'object' ? bridge.me.id ?? bridge.me.user_id ?? bridge.me.userId : bridge.me);
  return ids.filter((id) => id !== null && id !== undefined).map(String);
}

export function askProfiles(bridge, list) {
  const ids = (Array.isArray(list) ? list : []).map((p) => (p && typeof p === 'object' ? p.id ?? p.user_id ?? p.userId : p));
  if (bridge && bridge.me) ids.push(bridge.me);
  return wantProfiles(ids.filter((id) => id !== null && id !== undefined));
}

export function askAdmins(bridge, list) {
  return refreshAdmins(idsOf(bridge, list)).catch(() => false);
}

export function boot(win) {
  const root = win.document.getElementById('app');
  if (!root) return null;
  configureProfiles({ win });
  configureAdmins({ win });
  const bridge = connect({ win });
  const engine = createEngine({ transport: bridge, games: GAMES });
  const app = mountApp({ root, engine, bridge, win });
  const seen = (list) => {
    askProfiles(bridge, list);
    askAdmins(bridge, list);
  };
  bridge.on('ready', (snap) => seen(snap && snap.participants));
  bridge.on('participants', (m) => seen(m && m.participants));
  return { bridge, engine, app };
}

if (typeof window !== 'undefined' && typeof document !== 'undefined' && window.document === document) boot(window);
