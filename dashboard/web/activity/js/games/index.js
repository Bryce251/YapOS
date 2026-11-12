import trivia from './trivia.js';
import wyr from './wyr.js';
import draw from './draw.js';
import chain from './chain.js';

export const GAMES = Object.freeze([trivia, draw, chain, wyr]);

export function gameById(id) {
  return GAMES.find((g) => g.id === id) || null;
}
