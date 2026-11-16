import * as sound from '../ui/sfx.js';
import * as juicy from '../ui/juice.js';
import { createTriviaView } from './trivia.js';
import { createWyrView } from './wyr.js';
import { createDrawView } from './draw.js';
import { createChainView } from './chain.js';
import { createOddView } from './odd.js';
import { createTelephoneView } from './telephone.js';
import { createScrambleView } from './scramble.js';
import { createHiveView } from './hive.js';
import { createEmojiView } from './emoji.js';
import { createHottakesView } from './hottakes.js';
import { createTruthsView } from './truths.js';
import { createReflexView } from './reflex.js';
import { createBluffView } from './bluff.js';
import { createPixelView } from './pixel.js';
import { createHigherlowerView } from './higherlower.js';

function soundOf(over) {
  if (over && typeof over.play === 'function') return over;
  const s = sound.sfx || sound.default;
  return s && typeof s.play === 'function' ? s : null;
}

function juiceOf(over) {
  if (over && typeof over === 'object') return over;
  if (typeof juicy.burst === 'function' || typeof juicy.floatText === 'function') return juicy;
  return juicy.default && typeof juicy.default === 'object' ? juicy.default : null;
}

function centre(el) {
  if (!el || typeof el.getBoundingClientRect !== 'function') return null;
  const r = el.getBoundingClientRect();
  if (!r || !(r.width > 0) || !(r.height > 0)) return null;
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

export function cueKit({ sfx, juice } = {}) {
  const s = soundOf(sfx);
  const j = juiceOf(juice);
  return {
    play(name, opts) {
      try {
        if (s) s.play(name, opts);
      } catch {
        return;
      }
    },
    burst(el, opts) {
      try {
        const at = centre(el);
        if (at && j && typeof j.burst === 'function') j.burst(at.x, at.y, opts);
      } catch {
        return;
      }
    },
    float(el, text, opts) {
      try {
        if (el && j && typeof j.floatText === 'function') j.floatText(el, text, opts);
      } catch {
        return;
      }
    },
  };
}

function cued(create) {
  return (deps = {}) => create({ ...deps, cues: cueKit(deps) });
}

export const VIEWS = Object.freeze({
  trivia: cued(createTriviaView),
  wyr: cued(createWyrView),
  draw: cued(createDrawView),
  chain: cued(createChainView),
  odd: cued(createOddView),
  telephone: cued(createTelephoneView),
  scramble: cued(createScrambleView),
  hive: cued(createHiveView),
  emoji: cued(createEmojiView),
  hottakes: cued(createHottakesView),
  truths: cued(createTruthsView),
  reflex: cued(createReflexView),
  bluff: cued(createBluffView),
  pixel: cued(createPixelView),
  higherlower: cued(createHigherlowerView),
});

export function viewFor(id) {
  return VIEWS[id] || null;
}
