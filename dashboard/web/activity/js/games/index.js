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
import sketchduel from './sketchduel.js';
import story from './story.js';
import hangman from './hangman.js';
import musicquiz from './musicquiz.js';
import closest from './closest.js';
import name5 from './name5.js';
import beatdrop from './beatdrop.js';
import typerace from './typerace.js';
import memory from './memory.js';

export const GAMES = Object.freeze([trivia, draw, chain, wyr, odd, telephone, scramble, hive, emoji, hottakes, truths, reflex, bluff, pixel, higherlower, sketchduel, story, hangman, musicquiz, typerace, memory, beatdrop, closest, name5]);

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
