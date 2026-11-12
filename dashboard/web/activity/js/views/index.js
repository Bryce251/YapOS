import { createTriviaView } from './trivia.js';
import { createWyrView } from './wyr.js';
import { createDrawView } from './draw.js';
import { createChainView } from './chain.js';

export const VIEWS = Object.freeze({
  trivia: createTriviaView,
  wyr: createWyrView,
  draw: createDrawView,
  chain: createChainView,
});

export function viewFor(id) {
  return VIEWS[id] || null;
}
