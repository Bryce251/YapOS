import { connect } from './bridge.js';
import { createEngine } from './engine.js';
import { GAMES } from './games/index.js';
import { mountApp } from './ui/app.js';
import { configureProfiles, wantProfiles } from './profiles.js';

export function askProfiles(bridge, list) {
  const ids = (Array.isArray(list) ? list : []).map((p) => (p && typeof p === 'object' ? p.id ?? p.user_id ?? p.userId : p));
  if (bridge && bridge.me) ids.push(bridge.me);
  return wantProfiles(ids.filter((id) => id !== null && id !== undefined));
}

export function boot(win) {
  const root = win.document.getElementById('app');
  if (!root) return null;
  configureProfiles({ win });
  const bridge = connect({ win });
  const engine = createEngine({ transport: bridge, games: GAMES });
  const app = mountApp({ root, engine, bridge, win });
  bridge.on('ready', (snap) => askProfiles(bridge, snap && snap.participants));
  bridge.on('participants', (m) => askProfiles(bridge, m && m.participants));
  return { bridge, engine, app };
}

if (typeof window !== 'undefined' && typeof document !== 'undefined' && window.document === document) boot(window);
