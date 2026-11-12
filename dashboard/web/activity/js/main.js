import { connect } from './bridge.js';
import { createEngine } from './engine.js';
import { GAMES } from './games/index.js';
import { mountApp } from './ui/app.js';

export function boot(win) {
  const root = win.document.getElementById('app');
  if (!root) return null;
  const bridge = connect({ win });
  const engine = createEngine({ transport: bridge, games: GAMES });
  const app = mountApp({ root, engine, bridge, win });
  return { bridge, engine, app };
}

if (typeof window !== 'undefined' && typeof document !== 'undefined' && window.document === document) boot(window);
