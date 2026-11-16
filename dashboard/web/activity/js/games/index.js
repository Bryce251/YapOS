import trivia from './trivia.js';
import wyr from './wyr.js';
import draw from './draw.js';
import chain from './chain.js';
import odd from './odd.js';
import telephone from './telephone.js';
import scramble from './scramble.js';
import hive from './hive.js';
import emoji from './emoji.js';
import hottakes from './hottakes.js';
import truths from './truths.js';
import reflex from './reflex.js';
import bluff from './bluff.js';
import pixel from './pixel.js';
import higherlower from './higherlower.js';

export const GAMES = Object.freeze([trivia, draw, chain, wyr, odd, telephone, scramble, hive, emoji, hottakes, truths, reflex, bluff, pixel, higherlower]);

export const CATEGORIES = Object.freeze([
  Object.freeze({ id: 'drawing', name: 'Drawing', emoji: '🎨' }),
  Object.freeze({ id: 'words', name: 'Words', emoji: '🔤' }),
  Object.freeze({ id: 'quiz', name: 'Quiz', emoji: '🧠' }),
  Object.freeze({ id: 'party', name: 'Party', emoji: '🎉' }),
  Object.freeze({ id: 'quick', name: 'Quick', emoji: '⚡' }),
]);

export function gameById(id) {
  return GAMES.find((g) => g.id === id) || null;
}
