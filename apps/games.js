import { randomBytes } from 'node:crypto';
import { defineApp } from '../engine/apps.js';
import { card, dialog, button, row, ICONS } from '../engine/ui.js';
import { customId } from '../engine/router.js';
import { tokenize, didYouMean, clip } from '../engine/parse.js';
import { accept as acceptValue, reject as rejectValue, boolField } from '../engine/dashboard.js';
import { HARD_CAP, atMost, isUnlimited, parseLimit, readLimit, storeLimit, limitText, withinLimit } from '../engine/limits.js';

const ID = 'games';
const cid = (action, ...args) => customId(ID, action, ...args);
const JOB = `${ID}.cleanup`;

const CHALLENGE_MS = 60_000;
const IDLE_MS = 2 * 60_000;
const ANSWER_MS = 20_000;
const BETWEEN_MS = 5_000;
const COUNT_EDIT_MS = 3_000;
const FINISHED_KEEP_MS = 10 * 60_000;
const CHECK_MS = 3 * 60_000;
const MAX_GAMES = 10;
const MAX_TRIVIA = 3;
const MAX_ROUND = 10;
const RECENT_KEEP = 60;
const PRIZE_ROUND_MIN = 3;
const LETTERS = ['A', 'B', 'C', 'D'];
const MEDALS = ['🥇', '🥈', '🥉'];

const KINDS = {
  ttt: { name: 'Tic-tac-toe', icon: '❌⭕', marks: ['❌', '⭕'], usage: '/game tictactoe @sam' },
  c4: { name: 'Connect 4', icon: '🔴🟡', marks: ['🔴', '🟡'], usage: '/game connect4 @sam' },
  rps: { name: 'Rock paper scissors', icon: '🪨📄✂️', marks: ['', ''], usage: '/game rps @sam' },
};

const ALIASES = {
  tictactoe: 'ttt', ttt: 'ttt', 'tic-tac-toe': 'ttt', tictac: 'ttt', xo: 'ttt', noughts: 'ttt', oxo: 'ttt',
  connect4: 'c4', 'connect-4': 'c4', c4: 'c4', connectfour: 'c4', connect: 'c4', four: 'c4',
  rps: 'rps', rockpaperscissors: 'rps', 'rock-paper-scissors': 'rps', rock: 'rps', roshambo: 'rps',
};

const SUBS = ['tictactoe', 'connect4', 'rps', 'list', 'stats', 'end', 'settings', 'bets', 'maxbet', 'prize'];

const RPS = {
  rock: { label: 'Rock', emoji: '🪨', beats: 'scissors' },
  paper: { label: 'Paper', emoji: '📄', beats: 'rock' },
  scissors: { label: 'Scissors', emoji: '✂️', beats: 'paper' },
};

export const CATEGORIES = {
  general: { name: 'General', icon: '💡' },
  science: { name: 'Science', icon: '🔬' },
  geography: { name: 'Geography', icon: '🌍' },
  history: { name: 'History', icon: '📜' },
  games: { name: 'Games', icon: '🎲' },
  music: { name: 'Music', icon: '🎵' },
};

const CATEGORY_ALIASES = {
  general: 'general', misc: 'general', random: 'general', gk: 'general',
  science: 'science', sci: 'science', nature: 'science',
  geography: 'geography', geo: 'geography', places: 'geography', world: 'geography', capitals: 'geography',
  history: 'history', hist: 'history', past: 'history',
  games: 'games', gaming: 'games', game: 'games', videogames: 'games', boardgames: 'games',
  music: 'music', songs: 'music', instruments: 'music',
};

export const QUESTIONS = {
  general: [
    ['How many days are in a leap year?', '366', '365', '364', '367'],
    ['How many sides does a hexagon have?', '6', '5', '7', '8'],
    ['How many minutes are in a full day?', '1,440', '1,240', '1,340', '1,540'],
    ['How many hours are in a week?', '168', '144', '172', '186'],
    ['At sea level, water freezes at how many degrees Celsius?', '0', '32', '10', '-10'],
    ['Which colour do you get by mixing blue and yellow paint?', 'Green', 'Purple', 'Orange', 'Brown'],
    ['How many legs does a spider have?', '8', '6', '10', '12'],
    ['Which month has the fewest days?', 'February', 'April', 'June', 'November'],
    ['How many zeros are in one million?', '6', '5', '7', '9'],
    ['What is the Roman numeral for 50?', 'L', 'C', 'D', 'X'],
    ['Which number does the Roman numeral D stand for?', '500', '50', '100', '1,000'],
    ['How many players does one team have on the field in a standard soccer match?', '11', '10', '9', '12'],
    ['In which sport does the word "love" mean a score of zero?', 'Tennis', 'Golf', 'Cricket', 'Bowling'],
    ['Which is the only even prime number?', '2', '0', '4', '6'],
    ['What is 12 times 12?', '144', '124', '132', '156'],
    ['How many degrees are in a right angle?', '90', '45', '180', '360'],
    ['How many sides does an octagon have?', '8', '6', '10', '12'],
    ['What is the square root of 81?', '9', '8', '7', '11'],
    ['How many years are in a century?', '100', '10', '50', '1,000'],
    ['What is a baby kangaroo called?', 'Joey', 'Kit', 'Calf', 'Cub'],
    ['What do bees make from flower nectar?', 'Honey', 'Milk', 'Silk', 'Syrup'],
    ['What is the largest animal alive today?', 'Blue whale', 'African elephant', 'Giraffe', 'Whale shark'],
    ['How many sides does a pentagon have?', '5', '4', '6', '7'],
    ['How many letters are in the English alphabet?', '26', '24', '25', '28'],
    ['What do you call a word that reads the same backward and forward, like "level"?', 'Palindrome', 'Anagram', 'Acronym', 'Synonym'],
    ['How many seconds are in one hour?', '3,600', '360', '6,000', '1,200'],
    ['What is half of 250?', '125', '120', '150', '115'],
    ['How many weeks are in a year?', '52', '48', '50', '56'],
  ],
  science: [
    ['What is the largest planet in our solar system?', 'Jupiter', 'Saturn', 'Neptune', 'Earth'],
    ['Which planet is known as the Red Planet?', 'Mars', 'Venus', 'Jupiter', 'Mercury'],
    ['What is the chemical symbol for gold?', 'Au', 'Ag', 'Gd', 'Go'],
    ['What is the chemical symbol for sodium?', 'Na', 'So', 'Sd', 'S'],
    ['Which gas do plants take in from the air to make food?', 'Carbon dioxide', 'Oxygen', 'Nitrogen', 'Helium'],
    ["Which gas makes up most of Earth's atmosphere?", 'Nitrogen', 'Oxygen', 'Carbon dioxide', 'Argon'],
    ['Which planet is closest to the Sun?', 'Mercury', 'Venus', 'Mars', 'Earth'],
    ['How many bones does a typical adult human have?', '206', '186', '216', '256'],
    ['What is the hardest natural mineral?', 'Diamond', 'Quartz', 'Topaz', 'Granite'],
    ['At sea level, water boils at how many degrees Celsius?', '100', '90', '120', '212'],
    ['Which organ pumps blood around the body?', 'Heart', 'Liver', 'Lungs', 'Kidneys'],
    ['About how fast does light travel in a vacuum?', '300,000 km per second', '30,000 km per second', '3,000 km per second', '3,000,000 km per second'],
    ['Which force keeps the planets in orbit around the Sun?', 'Gravity', 'Magnetism', 'Friction', 'Static electricity'],
    ['Which element has atomic number 1?', 'Hydrogen', 'Helium', 'Oxygen', 'Carbon'],
    ['What is the chemical symbol for iron?', 'Fe', 'Ir', 'In', 'I'],
    ['Which planet is best known for its bright, wide rings?', 'Saturn', 'Jupiter', 'Uranus', 'Neptune'],
    ['Which blood cells carry oxygen around the body?', 'Red blood cells', 'White blood cells', 'Platelets', 'Nerve cells'],
    ['What is the centre of an atom called?', 'Nucleus', 'Electron', 'Orbit', 'Molecule'],
    ['How many planets are in our solar system?', '8', '7', '9', '10'],
    ['What is the largest organ of the human body?', 'Skin', 'Liver', 'Brain', 'Lungs'],
    ['Which unit is electrical resistance measured in?', 'Ohm', 'Volt', 'Watt', 'Ampere'],
    ['What kind of animal is a frog?', 'Amphibian', 'Reptile', 'Mammal', 'Fish'],
    ['Which vitamin does your skin make in sunlight?', 'Vitamin D', 'Vitamin A', 'Vitamin C', 'Vitamin K'],
    ['At what temperature are Celsius and Fahrenheit the same?', '-40', '0', '-32', '100'],
    ['What is the chemical formula of table salt?', 'NaCl', 'KCl', 'NaOH', 'CaCO3'],
    ['How many chambers does the human heart have?', '4', '2', '3', '6'],
    ['Which planet has the hottest average surface temperature?', 'Venus', 'Mercury', 'Mars', 'Jupiter'],
    ['What is H2O better known as?', 'Water', 'Salt', 'Hydrogen peroxide', 'Ammonia'],
  ],
  geography: [
    ['What is the capital of France?', 'Paris', 'Lyon', 'Marseille', 'Nice'],
    ['What is the capital of Japan?', 'Tokyo', 'Osaka', 'Kyoto', 'Hiroshima'],
    ['What is the capital of Australia?', 'Canberra', 'Sydney', 'Melbourne', 'Perth'],
    ['What is the capital of Canada?', 'Ottawa', 'Toronto', 'Vancouver', 'Montreal'],
    ['What is the largest ocean on Earth?', 'Pacific Ocean', 'Atlantic Ocean', 'Indian Ocean', 'Arctic Ocean'],
    ['Which mountain is the highest above sea level?', 'Mount Everest', 'K2', 'Kangchenjunga', 'Mont Blanc'],
    ['Which country is the largest by area?', 'Russia', 'Canada', 'China', 'United States'],
    ['What is the largest hot desert in the world?', 'Sahara', 'Gobi', 'Kalahari', 'Mojave'],
    ['What is the capital of Italy?', 'Rome', 'Milan', 'Venice', 'Naples'],
    ['What is the capital of Spain?', 'Madrid', 'Barcelona', 'Seville', 'Valencia'],
    ['What is the capital of Germany?', 'Berlin', 'Munich', 'Hamburg', 'Frankfurt'],
    ['What is the capital of Egypt?', 'Cairo', 'Alexandria', 'Giza', 'Luxor'],
    ['What is the capital of Brazil?', 'Brasília', 'Rio de Janeiro', 'São Paulo', 'Salvador'],
    ['What is the capital of Kenya?', 'Nairobi', 'Mombasa', 'Kisumu', 'Nakuru'],
    ['What is the capital of South Korea?', 'Seoul', 'Busan', 'Incheon', 'Daegu'],
    ['What is the capital of Argentina?', 'Buenos Aires', 'Córdoba', 'Rosario', 'Mendoza'],
    ['In which country is the city of Marrakesh?', 'Morocco', 'Algeria', 'Tunisia', 'Egypt'],
    ['Which river flows through London?', 'Thames', 'Seine', 'Danube', 'Severn'],
    ['Which river flows through Paris?', 'Seine', 'Loire', 'Rhine', 'Thames'],
    ['What is the smallest country in the world by area?', 'Vatican City', 'Monaco', 'San Marino', 'Liechtenstein'],
    ['Which US state is the largest by area?', 'Alaska', 'Texas', 'California', 'Montana'],
    ['On which continent is the Atacama Desert?', 'South America', 'Africa', 'Asia', 'Australia'],
    ['In which country is Mount Kilimanjaro?', 'Tanzania', 'Kenya', 'Uganda', 'Ethiopia'],
    ['Reykjavík is the capital of which country?', 'Iceland', 'Norway', 'Finland', 'Denmark'],
    ['Which ocean lies between Africa and Australia?', 'Indian Ocean', 'Atlantic Ocean', 'Pacific Ocean', 'Arctic Ocean'],
    ['What is the capital of New Zealand?', 'Wellington', 'Auckland', 'Christchurch', 'Queenstown'],
    ['What is the capital of Turkey?', 'Ankara', 'Istanbul', 'Izmir', 'Antalya'],
    ['In the seven-continent model, which continent is the largest?', 'Asia', 'Africa', 'North America', 'Antarctica'],
    ['What is the capital of Portugal?', 'Lisbon', 'Porto', 'Madrid', 'Faro'],
  ],
  history: [
    ['In which year did World War II end?', '1945', '1944', '1946', '1939'],
    ['In which year did World War I begin?', '1914', '1912', '1916', '1918'],
    ['Who was the first person to walk on the Moon?', 'Neil Armstrong', 'Buzz Aldrin', 'Yuri Gagarin', 'John Glenn'],
    ['In which year did people first land on the Moon?', '1969', '1967', '1971', '1965'],
    ['Who was the first person to travel into space?', 'Yuri Gagarin', 'Neil Armstrong', 'Alan Shepard', 'John Glenn'],
    ['Who was the first President of the United States?', 'George Washington', 'John Adams', 'Thomas Jefferson', 'Abraham Lincoln'],
    ['In which year did the Berlin Wall fall?', '1989', '1991', '1987', '1985'],
    ['In which year did the Titanic sink?', '1912', '1905', '1915', '1920'],
    ['Which ancient people built the great pyramids of Giza?', 'Ancient Egyptians', 'Romans', 'Greeks', 'Persians'],
    ['Who painted the Mona Lisa?', 'Leonardo da Vinci', 'Michelangelo', 'Raphael', 'Rembrandt'],
    ['In which city was Julius Caesar killed?', 'Rome', 'Athens', 'Alexandria', 'Carthage'],
    ['In which year did Christopher Columbus first reach the Americas?', '1492', '1488', '1498', '1502'],
    ['Genghis Khan founded which empire?', 'Mongol Empire', 'Ottoman Empire', 'Roman Empire', 'Persian Empire'],
    ['Which country gave the Statue of Liberty to the United States?', 'France', 'United Kingdom', 'Spain', 'Italy'],
    ['In which year was the Great Fire of London?', '1666', '1566', '1766', '1606'],
    ['Who was the first woman to win a Nobel Prize?', 'Marie Curie', 'Rosalind Franklin', 'Ada Lovelace', 'Florence Nightingale'],
    ['Which ship carried the Pilgrims to North America in 1620?', 'Mayflower', 'Santa Maria', 'Endeavour', 'Beagle'],
    ['In which year was the Magna Carta sealed?', '1215', '1066', '1315', '1415'],
    ['In which year was the Battle of Hastings?', '1066', '1215', '1100', '966'],
    ['Who was the British Prime Minister for most of World War II?', 'Winston Churchill', 'Neville Chamberlain', 'Clement Attlee', 'Harold Macmillan'],
    ['Which Roman city was buried when Mount Vesuvius erupted in 79 AD?', 'Pompeii', 'Rome', 'Ostia', 'Verona'],
    ['Who is usually credited with inventing the telephone?', 'Alexander Graham Bell', 'Thomas Edison', 'Nikola Tesla', 'Guglielmo Marconi'],
    ['In which year did the Soviet Union break up?', '1991', '1989', '1985', '1993'],
    ['Which Roman emperor had a wall built across northern England around 122 AD?', 'Hadrian', 'Nero', 'Augustus', 'Caligula'],
    ['Who was the first emperor of Rome?', 'Augustus', 'Julius Caesar', 'Nero', 'Caligula'],
    ['In which year did Nelson Mandela become President of South Africa?', '1994', '1990', '1999', '1988'],
    ['Who built the first European printing press with movable type?', 'Johannes Gutenberg', 'Galileo Galilei', 'Isaac Newton', 'Martin Luther'],
    ['The American colonies declared independence from which country in 1776?', 'Great Britain', 'France', 'Spain', 'The Netherlands'],
  ],
  games: [
    ['In chess, which piece can only move diagonally?', 'Bishop', 'Rook', 'Knight', 'Queen'],
    ['How many squares are on a chessboard?', '64', '81', '100', '49'],
    ['In chess, which piece can jump over other pieces?', 'Knight', 'Bishop', 'Rook', 'King'],
    ['How many pieces does each player start with in chess?', '16', '12', '14', '18'],
    ['How many dots are there in total on a standard six-sided die?', '21', '18', '20', '24'],
    ['On a standard die, what do opposite faces always add up to?', '7', '6', '8', '12'],
    ['How many pieces does each player start with in checkers on an 8x8 board?', '12', '10', '15', '16'],
    ['How many cards are in a standard deck, not counting jokers?', '52', '48', '54', '56'],
    ['How many squares make up each falling piece in Tetris?', '4', '3', '5', '6'],
    ['In poker, which of these hands is the strongest?', 'Royal flush', 'Four of a kind', 'Full house', 'Flush'],
    ['In classic Monopoly, how much do you collect for passing Go?', '$200', '$100', '$150', '$500'],
    ['How many letter tiles does each player hold in Scrabble?', '7', '6', '8', '10'],
    ['How many pins are set up in ten-pin bowling?', '10', '9', '12', '8'],
    ['What is the highest possible score in one game of ten-pin bowling?', '300', '200', '250', '400'],
    ['In Minecraft, which block do you need to build a Nether portal frame?', 'Obsidian', 'Cobblestone', 'Netherrack', 'Bedrock'],
    ['In Pac-Man, what do you eat so you can chase the ghosts?', 'Power pellets', 'Cherries', 'Keys', 'Coins'],
    ['Which company makes the Super Mario games?', 'Nintendo', 'Sega', 'Sony', 'Atari'],
    ['Which company created Sonic the Hedgehog?', 'Sega', 'Nintendo', 'Capcom', 'Konami'],
    ['How many squares are on a tic-tac-toe board?', '9', '6', '12', '16'],
    ['How many columns does a standard Connect 4 board have?', '7', '6', '8', '9'],
    ['In chess, what is it called when the king is attacked and cannot escape?', 'Checkmate', 'Stalemate', 'Castling', 'En passant'],
    ['In chess, which move lets the king and a rook move in the same turn?', 'Castling', 'En passant', 'Promotion', 'Fork'],
    ["In which board game do you try to sink your opponent's hidden ships?", 'Battleship', 'Risk', 'Stratego', 'Clue'],
    ['What is the name of the hero in most Legend of Zelda games?', 'Link', 'Zelda', 'Ganon', 'Navi'],
    ['What type of Pokémon is Pikachu?', 'Electric', 'Fire', 'Water', 'Normal'],
    ['In rock-paper-scissors, which choice beats scissors?', 'Rock', 'Paper', 'Scissors', 'None of them'],
    ['How many cards does each player get at the start of a game of Uno?', '7', '5', '8', '10'],
    ['How many tiles are in a standard double-six set of dominoes?', '28', '24', '32', '36'],
  ],
  music: [
    ['How many strings does a standard guitar have?', '6', '4', '5', '7'],
    ['How many strings does a violin have?', '4', '3', '5', '6'],
    ['How many keys does a standard modern piano have?', '88', '76', '92', '100'],
    ['How many lines are in a musical staff?', '5', '4', '6', '7'],
    ['Which instrument family does the trumpet belong to?', 'Brass', 'Woodwind', 'Strings', 'Percussion'],
    ['Which instrument family does the flute belong to?', 'Woodwind', 'Brass', 'Strings', 'Percussion'],
    ['Which composer kept writing music after losing his hearing, including his Ninth Symphony?', 'Ludwig van Beethoven', 'Wolfgang Amadeus Mozart', 'Johann Sebastian Bach', 'Frédéric Chopin'],
    ['Who composed the violin concertos called The Four Seasons?', 'Antonio Vivaldi', 'Johann Sebastian Bach', 'George Frideric Handel', 'Joseph Haydn'],
    ['In which city was Mozart born?', 'Salzburg', 'Vienna', 'Prague', 'Munich'],
    ['In 4/4 time, how many beats does a whole note last?', '4', '2', '1', '8'],
    ['What does "forte" mean in music?', 'Loud', 'Soft', 'Fast', 'Slow'],
    ['What does "piano" mean as an instruction in music?', 'Soft', 'Loud', 'Fast', 'Slow'],
    ['What does "tempo" describe in music?', 'How fast it is', 'How loud it is', 'How high it is', 'Which key it is in'],
    ['How many different notes are in a major scale, not counting the top note again?', '7', '5', '8', '12'],
    ['How many semitones are in an octave?', '12', '8', '10', '7'],
    ['Which clef is also called the G clef?', 'Treble clef', 'Bass clef', 'Alto clef', 'Tenor clef'],
    ['Which clef is also called the F clef?', 'Bass clef', 'Treble clef', 'Alto clef', 'Tenor clef'],
    ['What is a group of four musicians called?', 'Quartet', 'Trio', 'Quintet', 'Duet'],
    ['Timpani are a kind of what?', 'Drum', 'Horn', 'Harp', 'Flute'],
    ['Which Polish-born composer is famous for his piano nocturnes?', 'Frédéric Chopin', 'Franz Liszt', 'Franz Schubert', 'Edvard Grieg'],
    ['Who composed the music for the ballet The Nutcracker?', 'Pyotr Ilyich Tchaikovsky', 'Igor Stravinsky', 'Sergei Rachmaninoff', 'Sergei Prokofiev'],
    ['What is the highest standard singing voice?', 'Soprano', 'Alto', 'Tenor', 'Bass'],
    ['What is the lowest standard male singing voice?', 'Bass', 'Baritone', 'Tenor', 'Alto'],
    ['Who invented the saxophone?', 'Adolphe Sax', 'Antonio Stradivari', 'Johann Strauss', 'Hector Berlioz'],
    ['Antonio Stradivari was famous for making which instruments?', 'Violins', 'Pianos', 'Trumpets', 'Drums'],
    ['Going up the scale with English note names, which note comes after G?', 'A', 'H', 'F', 'B'],
    ['How many musicians play in a duet?', '2', '3', '4', '1'],
    ['Which large instrument with pipes and pedals is often found in churches?', 'Pipe organ', 'Harp', 'Accordion', 'Harpsichord'],
  ],
};

const ALL_QUESTIONS = Object.entries(QUESTIONS).flatMap(([category, list]) => list.map((q, i) => ({ key: `${category}:${i}`, category, q })));

export function tttWinner(board) {
  const lines = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];
  for (const line of lines) {
    const [a, b, c] = line;
    if (board[a] !== null && board[a] === board[b] && board[a] === board[c]) return { player: board[a], line };
  }
  return null;
}

export function c4Drop(board, col) {
  for (let r = board.length - 1; r >= 0; r--) if (board[r][col] === null) return r;
  return -1;
}

export function c4Line(board, r, c) {
  const p = board[r]?.[c];
  if (p === null || p === undefined) return null;
  for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
    const cells = [[r, c]];
    for (const s of [1, -1]) {
      let rr = r + dr * s;
      let cc = c + dc * s;
      while (rr >= 0 && rr < board.length && cc >= 0 && cc < board[0].length && board[rr][cc] === p) {
        cells.push([rr, cc]);
        rr += dr * s;
        cc += dc * s;
      }
    }
    if (cells.length >= 4) return cells;
  }
  return null;
}

export function rpsWinner(a, b) {
  if (!own(RPS, a) || !own(RPS, b) || a === b) return null;
  return RPS[a].beats === b ? 0 : 1;
}

const states = new WeakMap();
function stateOf(engine) {
  let s = states.get(engine);
  if (!s) {
    s = { games: new Map(), busy: new Map(), finished: new Map(), trivia: new Map(), triviaByChannel: new Map(), recent: new Map(), timers: new Map(), timer: null, sweeping: null, disposed: false };
    states.set(engine, s);
  }
  return s;
}

const newId = () => randomBytes(5).toString('hex').slice(0, 8);
const busyKey = (sid, uid) => `${sid}:${uid}`;
const cfgOf = (engine, sid) => engine.settings.appConfig(sid, ID);
const mention = (uid) => (uid ? `<@${uid}>` : 'someone');
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const own = (obj, key) => (typeof key === 'string' && Object.hasOwn(obj, key) ? obj[key] : null);

function setTimer(engine, key, ms, fn) {
  const st = stateOf(engine);
  st.timers.set(key, { at: Date.now() + ms, fn });
  arm(engine);
}

function clearTimer(engine, key) {
  stateOf(engine).timers.delete(key);
}

function arm(engine) {
  const st = stateOf(engine);
  if (st.timer) clearTimeout(st.timer);
  st.timer = null;
  if (st.disposed || !st.timers.size) return;
  let next = Infinity;
  for (const t of st.timers.values()) next = Math.min(next, t.at);
  st.timer = setTimeout(() => {
    st.timer = null;
    sweep(engine).catch((e) => engine.log.error('[games] timer sweep failed:', e));
  }, Math.max(0, Math.min(next - Date.now(), 2_147_000_000)));
  st.timer.unref?.();
}

async function sweep(engine) {
  const st = stateOf(engine);
  if (st.sweeping) return st.sweeping;
  st.sweeping = (async () => {
    for (let guard = 0; guard < 1000; guard++) {
      const now = Date.now();
      let dueKey = null;
      let due = null;
      for (const [k, t] of st.timers) if (t.at <= now && (!due || t.at < due.at)) { due = t; dueKey = k; }
      if (!due) break;
      st.timers.delete(dueKey);
      try { await due.fn(); } catch (e) { engine.log.error('[games] timer failed:', e); }
    }
  })();
  try { await st.sweeping; } finally { st.sweeping = null; arm(engine); }
  return undefined;
}

const blankDoc = () => ({ open: {}, stats: {} });
function readDoc(engine, sid) {
  const d = engine.store.get(ID, sid, blankDoc()) || blankDoc();
  d.open ||= {};
  d.stats ||= {};
  return d;
}
function writeDoc(engine, sid, fn) {
  return engine.store.update(ID, sid, (d) => {
    const doc = d && typeof d === 'object' ? d : blankDoc();
    doc.open ||= {};
    doc.stats ||= {};
    fn(doc);
    return doc;
  }, blankDoc());
}

function watch(engine, sid, id, record) {
  writeDoc(engine, sid, (d) => { d.open[id] = { ...(d.open[id] || {}), ...record }; });
  const s = engine.scheduler;
  if (!s) return;
  try {
    s.schedule({ kind: JOB, at: s.now() + CHECK_MS, serverId: sid, key: id, data: { id } });
  } catch (e) {
    engine.log.warn(`[games] could not save a safety check for ${id}: ${e?.message}`);
  }
}

function unwatch(engine, sid, id) {
  if (readDoc(engine, sid).open[id]) writeDoc(engine, sid, (d) => { delete d.open[id]; });
  try { engine.scheduler?.cancelWhere({ kind: JOB, serverId: sid, key: id }); } catch (e) { engine.log.debug('[games] cancel check failed', e?.message); }
}

function economyFor(engine, sid) {
  const eco = engine.service('economy');
  if (!eco || typeof eco.take !== 'function' || typeof eco.add !== 'function') return null;
  if (sid && !engine.settings.isEnabled(sid, 'economy')) return null;
  return eco;
}

function money(engine, sid, n) {
  let c = null;
  try { c = engine.service('economy')?.currency?.(sid); } catch { c = null; }
  const emoji = c && typeof c === 'object' && typeof c.emoji === 'string' && c.emoji ? c.emoji : '🪙';
  return `**${Number(n).toLocaleString('en-US')}** ${emoji}`;
}

function moneyLimit(engine, sid, value, word = 'any amount') {
  return limitText(value, { word, fmt: (n) => money(engine, sid, n) });
}

function maxBetOf(cfg) {
  return readLimit(cfg?.maxBet, 1000, { min: 1, max: HARD_CAP });
}

function maxBetText(cfg) {
  const n = maxBetOf(cfg);
  return isUnlimited(n) ? 'inf' : String(n);
}

function prizeOf(cfg) {
  return readLimit(cfg?.triviaPrize, 0, { min: 0, max: HARD_CAP, unlimited: false });
}

async function balanceOf(eco, sid, uid) {
  try { return Number(await eco.balance(sid, uid)) || 0; } catch { return null; }
}

async function hold(engine, g, uid) {
  const eco = economyFor(engine, g.sid);
  if (!eco) return { ok: false, why: 'economy' };
  let after = null;
  try { after = await eco.take(g.sid, uid, g.bet, `${KINDS[g.kind].name} bet`); } catch (e) { engine.log.warn(`[games] could not hold a bet: ${e?.message}`); return { ok: false, why: 'error' }; }
  if (after === null || after === undefined || after === false) return { ok: false, why: 'funds' };
  writeDoc(engine, g.sid, (d) => {
    const o = (d.open[g.id] ||= { kind: g.kind, channelId: g.channelId, messageId: g.messageId, at: Date.now() });
    const held = o.held && Array.isArray(o.held.players) ? o.held : { amount: g.bet, players: [] };
    if (!held.players.includes(uid)) held.players.push(uid);
    o.held = held;
  });
  g.held = [...new Set([...(g.held || []), uid])];
  return { ok: true };
}

async function settle(engine, sid, gid, winnerId) {
  let held = null;
  const doc = readDoc(engine, sid);
  if (!doc.open[gid]?.held?.players?.length) return null;
  writeDoc(engine, sid, (d) => {
    const o = d.open[gid];
    if (o?.held?.players?.length) { held = o.held; o.held = null; }
  });
  if (!held) return null;
  const eco = engine.service('economy');
  if (!eco || typeof eco.add !== 'function') {
    writeDoc(engine, sid, (d) => { if (d.open[gid]) d.open[gid].held = held; });
    engine.log.warn(`[games] bets for game ${gid} are still held: the Economy app is not loaded`);
    return null;
  }
  const amount = Math.max(0, Math.floor(Number(held.amount) || 0));
  const players = held.players.filter(Boolean);
  try {
    if (winnerId && players.includes(winnerId) && players.length >= 2) {
      const pot = amount * players.length;
      await eco.add(sid, winnerId, pot, 'Game win');
      return { pot, winnerId };
    }
    for (const p of players) await eco.add(sid, p, amount, 'Game bet back');
    return { refunded: amount, players };
  } catch (e) {
    engine.log.error(`[games] could not pay out game ${gid}:`, e);
    return null;
  }
}

function recordGameStats(engine, g, result) {
  const [a, b] = g.players;
  if (!a || !b) return;
  const bump = (d, uid, field) => {
    const u = (d.stats[uid] ||= {});
    const s = (u[g.kind] ||= { w: 0, l: 0, d: 0 });
    s[field] = (Number(s[field]) || 0) + 1;
  };
  if (result.kind === 'draw') writeDoc(engine, g.sid, (d) => { bump(d, a, 'd'); bump(d, b, 'd'); });
  else if (['win', 'forfeit', 'gaveup'].includes(result.kind) && result.winner) {
    const loser = result.winner === a ? b : a;
    writeDoc(engine, g.sid, (d) => { bump(d, result.winner, 'w'); bump(d, loser, 'l'); });
  }
}

function freeGame(engine, g) {
  const st = stateOf(engine);
  st.games.delete(g.id);
  for (const uid of [g.challenger, ...g.players]) if (uid && st.busy.get(busyKey(g.sid, uid)) === g.id) st.busy.delete(busyKey(g.sid, uid));
  clearTimer(engine, `exp:${g.id}`);
  clearTimer(engine, `idle:${g.id}`);
}

function pruneFinished(st) {
  const now = Date.now();
  for (const [k, f] of st.finished) if (now - f.endedAt > FINISHED_KEEP_MS) st.finished.delete(k);
  while (st.finished.size > 200) st.finished.delete(st.finished.keys().next().value);
}

async function endGame(engine, g, result) {
  if (g.phase === 'over') return gameView(engine, g);
  const st = stateOf(engine);
  g.phase = 'over';
  g.result = result;
  freeGame(engine, g);
  const paysWinner = ['win', 'forfeit', 'gaveup'].includes(result.kind) && result.winner;
  g.payout = await settle(engine, g.sid, g.id, paysWinner ? result.winner : null);
  recordGameStats(engine, g, result);
  unwatch(engine, g.sid, g.id);
  if (['win', 'draw', 'forfeit', 'gaveup'].includes(result.kind) && g.players[0] && g.players[1]) {
    pruneFinished(st);
    st.finished.set(g.id, { kind: g.kind, sid: g.sid, players: [...g.players], bet: g.bet, endedAt: Date.now() });
  }
  return gameView(engine, g);
}

function editMessage(engine, channelId, messageId, view) {
  if (!channelId || !messageId) return Promise.resolve(null);
  return engine.budget.edit({ channelId, messageId, content: view.content ?? '', opts: { embeds: view.embeds, components: view.components } })
    .catch((e) => { engine.log.debug('[games] could not edit a game message', e?.message); return null; });
}

function betLine(engine, g) {
  if (!g.bet) return '';
  return `\n💰 Bet: ${money(engine, g.sid, g.bet)} each · winner takes ${money(engine, g.sid, g.bet * 2)}`;
}

function c4Text(g) {
  const header = '1️⃣2️⃣3️⃣4️⃣5️⃣6️⃣7️⃣';
  const marks = KINDS.c4.marks;
  const lines = g.board.map((r) => r.map((cell) => (cell === null ? '⚪' : marks[cell])).join(''));
  return `${header}\n${lines.join('\n')}`;
}

function resultText(engine, g) {
  const r = g.result;
  if (!r) return '';
  const loserOf = (w) => (g.players[0] === w ? g.players[1] : g.players[0]);
  let line = '';
  if (r.kind === 'win') line = `🏆 ${mention(r.winner)} wins!`;
  else if (r.kind === 'draw') line = "🤝 It's a draw.";
  else if (r.kind === 'forfeit') line = `⏰ ${mention(loserOf(r.winner))} didn't ${g.kind === 'rps' ? 'pick' : 'move'} for 2 minutes, so ${mention(r.winner)} wins.`;
  else if (r.kind === 'gaveup') line = `🏳️ ${mention(loserOf(r.winner))} gave up, so ${mention(r.winner)} wins.`;
  else if (r.kind === 'declined') line = `${mention(r.by)} said no thanks.`;
  else if (r.kind === 'expired') line = g.target ? `${mention(g.target)} didn't answer in time.` : 'Nobody accepted in time.';
  else if (r.kind === 'withdrawn') line = `${mention(g.challenger)} called it off.`;
  else line = `🚫 Cancelled: ${r.reason || 'the game stopped'}.`;
  const p = g.payout;
  if (p?.pot) line += `\n💰 ${mention(p.winnerId)} takes ${money(engine, g.sid, p.pot)}.`;
  else if (p?.refunded) line += `\n💰 ${p.players.length > 1 ? 'Both bets went back.' : `${mention(p.players[0])} got their bet back.`}`;
  return line;
}

function challengeView(engine, g) {
  const k = KINDS[g.kind];
  const who = g.target ? mention(g.target) : 'anyone here';
  const lines = [`${mention(g.challenger)} challenges ${who} to **${k.name}**!${betLine(engine, g)}`];
  if (g.phase === 'over') {
    lines.push('', resultText(engine, g));
    return { content: '', embeds: [card({ title: `🎮 ${k.name} challenge`, body: lines.join('\n'), color: 'muted', footer: false })], components: [] };
  }
  lines.push('', g.target ? `${mention(g.target)}, press **Accept** to play.` : 'Press **Accept** to play.');
  return {
    content: '',
    embeds: [card({ title: `🎮 ${k.name} challenge`, body: lines.join('\n'), color: 'games', footer: 'This challenge ends in 60 seconds.' })],
    components: [row(button('Accept', cid('acc', g.id), 'success', '✅'), button('Decline', cid('dec', g.id), 'danger', '✖️'))],
  };
}

function rematchRow(g) {
  if (g.phase !== 'over' || !['win', 'draw', 'forfeit', 'gaveup'].includes(g.result?.kind)) return null;
  return row(button('Rematch', cid('rm', g.id), 'primary', '🔁'));
}

function tttRows(g) {
  const over = g.phase === 'over';
  const winLine = g.winLine || [];
  const out = [];
  for (let r = 0; r < 3; r++) {
    const cells = [];
    for (let c = 0; c < 3; c++) {
      const i = r * 3 + c;
      const v = g.board[i];
      const label = v === null ? '·' : KINDS.ttt.marks[v];
      const style = winLine.includes(i) ? 'success' : v === 0 ? 'danger' : v === 1 ? 'primary' : 'secondary';
      cells.push(button(label, cid('mv', g.id, i), style, null, { disabled: over || v !== null }));
    }
    out.push(row(cells));
  }
  return out;
}

function c4Rows(g) {
  const cols = [];
  for (let c = 0; c < 7; c++) cols.push(button(String(c + 1), cid('mv', g.id, c), 'secondary', null, { disabled: c4Drop(g.board, c) < 0 }));
  return [row(cols.slice(0, 4)), row(cols.slice(4))];
}

function playView(engine, g) {
  const k = KINDS[g.kind];
  const [a, b] = g.players;
  const over = g.phase === 'over';
  const lines = [];
  if (g.kind === 'rps') {
    lines.push(`${mention(a)} vs ${mention(b)}${betLine(engine, g)}`, '');
    if (over && g.picks[a] && g.picks[b]) {
      for (const uid of [a, b]) lines.push(`${mention(uid)} picked ${RPS[g.picks[uid]].emoji} **${RPS[g.picks[uid]].label}**`);
    } else {
      for (const uid of [a, b]) lines.push(`${mention(uid)}: ${g.picks[uid] ? '✅ picked' : '⏳ choosing…'}`);
      if (!over) lines.push('', 'Pick with the buttons. Nobody sees your pick until you have both picked.');
    }
  } else {
    lines.push(`${k.marks[0]} ${mention(a)} vs ${k.marks[1]} ${mention(b)}${betLine(engine, g)}`);
    if (g.kind === 'c4') lines.push('', c4Text(g));
    if (!over) lines.push('', `▶️ ${mention(g.players[g.turn])}'s turn ${k.marks[g.turn]}`);
  }
  if (over) lines.push('', resultText(engine, g));
  const components = [];
  if (g.kind === 'ttt') components.push(...tttRows(g));
  if (!over && g.kind === 'c4') components.push(...c4Rows(g));
  if (!over && g.kind === 'rps') components.push(row(Object.entries(RPS).map(([key, r]) => button(r.label, cid('rps', g.id, key), 'secondary', r.emoji)), button('Give up', cid('ff', g.id), 'danger', '🏳️')));
  if (!over && g.kind !== 'rps') components.push(row(button('Give up', cid('ff', g.id), 'danger', '🏳️')));
  const again = rematchRow(g);
  if (again) components.push(again);
  const footer = over ? (again ? `Press Rematch to play again${g.bet ? ' for the same bet' : ''}.` : false) : 'Only the two players can move · 2 minutes per move';
  return { content: '', embeds: [card({ title: `${k.icon} ${k.name}${over ? ' · game over' : ''}`, body: lines.join('\n'), color: over ? 'muted' : 'games', footer })], components };
}

function gameView(engine, g) {
  if (g.phase === 'challenge' || g.phase === 'starting' || !g.players[1]) return challengeView(engine, g);
  return playView(engine, g);
}

function lostView(what) {
  const body = what === 'trivia'
    ? 'I restarted, so this trivia stopped early.\nStart a new one with **/trivia**.'
    : 'I restarted, so this game was cancelled. Any bets went back to the players.\nStart a new one with **/game**.';
  return { content: '', embeds: [card({ title: what === 'trivia' ? '🧠 Trivia stopped' : '🎮 Game cancelled', body, color: 'muted', footer: false })], components: [] };
}

function notInGame(g) {
  const who = g.players[1] ? `${mention(g.players[0])} and ${mention(g.players[1])}` : mention(g.challenger);
  return { embeds: [dialog.denied(null, { title: "You're not in this game", body: `Only ${who} can press these. Start your own with **/game**.` })] };
}

function initBoard(kind) {
  if (kind === 'ttt') return Array(9).fill(null);
  if (kind === 'c4') return Array.from({ length: 6 }, () => Array(7).fill(null));
  return null;
}

function startIdle(engine, g) {
  g.lastMoveAt = Date.now();
  setTimer(engine, `idle:${g.id}`, IDLE_MS, () => onIdle(engine, g.id));
}

async function onIdle(engine, gid) {
  const g = stateOf(engine).games.get(gid);
  if (!g || g.phase !== 'playing') return;
  const left = IDLE_MS - (Date.now() - g.lastMoveAt);
  if (left > 0) { setTimer(engine, `idle:${gid}`, left, () => onIdle(engine, gid)); return; }
  const view = await timeOut(engine, g);
  editMessage(engine, g.channelId, g.messageId, view);
}

async function timeOut(engine, g) {
  if (!engine.settings.isEnabled(g.sid, ID)) return endGame(engine, g, { kind: 'cancelled', reason: 'Games was uninstalled here' });
  if (g.kind === 'rps') {
    const waiting = g.players.filter((u) => !g.picks[u]);
    if (waiting.length === 2) return endGame(engine, g, { kind: 'cancelled', reason: 'nobody picked in time' });
    const winner = g.players.find((u) => g.picks[u]);
    return endGame(engine, g, { kind: 'forfeit', winner });
  }
  const winner = g.players[1 - g.turn];
  return endGame(engine, g, { kind: 'forfeit', winner });
}

async function onExpire(engine, gid) {
  const g = stateOf(engine).games.get(gid);
  if (!g || g.phase !== 'challenge') return;
  const left = CHALLENGE_MS - (Date.now() - g.createdAt);
  if (left > 0) { setTimer(engine, `exp:${gid}`, left, () => onExpire(engine, gid)); return; }
  const view = await endGame(engine, g, { kind: 'expired' });
  editMessage(engine, g.channelId, g.messageId, view);
}

function parseChallengeArgs(tokens) {
  let bet = null;
  let badBet = null;
  const names = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = String(tokens[i]);
    const low = t.toLowerCase();
    if (low === 'bet' || low === 'for' || low === 'wager') {
      const next = String(tokens[i + 1] ?? '');
      if (/^\d+$/.test(next.replace(/,/g, ''))) bet = Number(next.replace(/,/g, '')); else badBet = next || '?';
      i++;
      continue;
    }
    const num = t.replace(/,/g, '').replace(/coins?$/i, '');
    if (/^\d+$/.test(num) && !/^<@/.test(t)) { bet = Number(num); continue; }
    if (/^-\d+$/.test(num)) { badBet = t; continue; }
    if (/^(vs|against|with|me)$/i.test(low)) continue;
    names.push(t);
  }
  return { bet, badBet, who: names.join(' ').trim() };
}

function serverGames(st, sid) {
  return [...st.games.values()].filter((g) => g.sid === sid);
}

async function startChallenge(ctx, kind, tokens) {
  const { engine } = ctx;
  const st = stateOf(engine);
  const sid = ctx.serverId;
  const k = KINDS[kind];
  const { bet, badBet, who } = parseChallengeArgs(tokens);
  const mine = st.busy.get(busyKey(sid, ctx.userId));
  if (mine && st.games.has(mine)) return ctx.info("You're already in a game", 'Finish it first, or type **/game end** to give up.');
  if (serverGames(st, sid).length >= MAX_GAMES) return ctx.warn('Lots of games going', `There are already ${MAX_GAMES} games running here. Try again when one ends.`);
  let target = null;
  if (who) {
    const found = await ctx.findUser(who);
    if (!found?.id) return ctx.warn("I couldn't find them", `Nobody here matches **${clip(who.replace(/[<>@]/g, ''), 40)}**. Try \`${k.usage}\`.`);
    if (found.id === ctx.userId) return ctx.info("You can't play yourself", `Pick someone else, like \`${k.usage}\`, or leave the name out so anyone can join.`);
    if (found.id === engine.bot.me?.id) return ctx.info("I'd love to, but I can't press buttons", 'Challenge a person instead, or try **/trivia**.');
    const member = await engine.perms.member(sid, found.id).catch(() => null);
    if (!member) return ctx.warn("They're not here", "That person isn't in this server.");
    if (member.bot || member.is_bot) return ctx.info("Bots can't play", 'Challenge a person instead.');
    const theirs = st.busy.get(busyKey(sid, found.id));
    if (theirs && st.games.has(theirs)) return ctx.info("They're busy", `${mention(found.id)} is already in a game. Try again when it ends.`);
    target = found.id;
  }
  if (badBet !== null) return ctx.warn("That bet didn't work", 'Bets are whole numbers of coins, like `bet 50`.');
  if (bet !== null) {
    const cfg = cfgOf(engine, sid);
    const eco = economyFor(engine, sid);
    if (!eco) return ctx.info("Bets aren't available", 'Playing for coins needs the **Economy** app. An admin can install it with **/apps**. You can still play without a bet.');
    if (cfg.bets === false) return ctx.info('Bets are off here', 'An admin turned off betting. You can still play without a bet.');
    const maxBet = maxBetOf(cfg);
    if (!Number.isSafeInteger(bet) || bet < 1) return ctx.warn("That bet didn't work", 'Bets are whole numbers of coins, 1 or more.');
    if (!withinLimit(bet, maxBet) || bet > HARD_CAP) return ctx.warn('That bet is too big', `The biggest bet here is ${moneyLimit(engine, sid, atMost(maxBet, HARD_CAP))}.`);
    const have = await balanceOf(eco, sid, ctx.userId);
    if (have !== null && have < bet) return ctx.warn('Not enough coins', `You have ${money(engine, sid, have)}, so you can't bet ${money(engine, sid, bet)}.`);
  }
  const g = {
    id: newId(), sid, channelId: ctx.channelId, messageId: null, kind, challenger: ctx.userId, target,
    players: [ctx.userId, null], bet: bet || 0, phase: 'challenge', turn: 0, board: null, picks: {}, moves: 0,
    createdAt: Date.now(), lastMoveAt: Date.now(), held: [],
  };
  st.games.set(g.id, g);
  st.busy.set(busyKey(sid, ctx.userId), g.id);
  let sent;
  try {
    sent = await ctx.reply({ ...challengeView(engine, g), open: true });
  } catch (e) {
    freeGame(engine, g);
    throw e;
  }
  g.messageId = (sent?.message ?? sent)?.id ?? null;
  watch(engine, sid, g.id, { kind, channelId: g.channelId, messageId: g.messageId, at: Date.now(), held: null });
  setTimer(engine, `exp:${g.id}`, CHALLENGE_MS, () => onExpire(engine, g.id));
  return sent;
}

async function rematch(ctx, oldId) {
  const { engine } = ctx;
  const st = stateOf(engine);
  pruneFinished(st);
  const f = st.finished.get(oldId);
  if (!f) return ctx.info('That rematch button expired', 'Start a new game with **/game**.');
  if (!f.players.includes(ctx.userId)) return ctx.ephemeral({ embeds: [dialog.denied(null, { title: "You're not in this game", body: `Only ${mention(f.players[0])} and ${mention(f.players[1])} can ask for a rematch. Start your own with **/game**.` })] });
  const other = f.players.find((u) => u !== ctx.userId);
  for (const uid of [ctx.userId, other]) {
    const gid = st.busy.get(busyKey(ctx.serverId, uid));
    if (gid && st.games.has(gid)) return ctx.info('Someone is busy', `${mention(uid)} is already in another game.`);
  }
  if (serverGames(st, ctx.serverId).length >= MAX_GAMES) return ctx.warn('Lots of games going', `There are already ${MAX_GAMES} games running here. Try again when one ends.`);
  st.finished.delete(oldId);
  if (f.bet) {
    const eco = economyFor(engine, ctx.serverId);
    if (!eco || cfgOf(engine, ctx.serverId).bets === false) {
      st.finished.set(oldId, f);
      return ctx.info("Bets aren't available now", 'Start a new game without a bet with **/game**.');
    }
    const have = await balanceOf(eco, ctx.serverId, ctx.userId);
    if (have !== null && have < f.bet) {
      st.finished.set(oldId, f);
      return ctx.warn('Not enough coins', `You have ${money(engine, ctx.serverId, have)}, so you can't bet ${money(engine, ctx.serverId, f.bet)} again.`);
    }
  }
  const g = {
    id: newId(), sid: ctx.serverId, channelId: ctx.channelId, messageId: ctx.source?.message_id ?? null, kind: f.kind, challenger: ctx.userId, target: other,
    players: [ctx.userId, null], bet: f.bet || 0, phase: 'challenge', turn: 0, board: null, picks: {}, moves: 0,
    createdAt: Date.now(), lastMoveAt: Date.now(), held: [],
  };
  st.games.set(g.id, g);
  st.busy.set(busyKey(g.sid, ctx.userId), g.id);
  watch(engine, g.sid, g.id, { kind: g.kind, channelId: g.channelId, messageId: g.messageId, at: Date.now(), held: null });
  setTimer(engine, `exp:${g.id}`, CHALLENGE_MS, () => onExpire(engine, g.id));
  return ctx.update(challengeView(engine, g));
}

function messageInUse(engine, messageId) {
  if (!messageId) return false;
  const st = stateOf(engine);
  for (const g of st.games.values()) if (g.messageId === messageId) return true;
  for (const t of st.trivia.values()) if (t.messageId === messageId) return true;
  return false;
}

async function lostGame(ctx, gid) {
  if (messageInUse(ctx.engine, ctx.source?.message_id)) return ctx.info('That button is out of date', 'Use the buttons on the message as it is now.');
  const rec = await closeLost(ctx.engine, ctx.serverId, gid);
  if (!rec) return ctx.info('That game is over', 'Start a new one with **/game**.');
  return ctx.update(lostView('game'));
}

async function closeLost(engine, sid, id) {
  const rec = readDoc(engine, sid).open[id] || null;
  if (rec) await settle(engine, sid, id, null);
  unwatch(engine, sid, id);
  return rec;
}

async function accept(ctx, g) {
  const { engine } = ctx;
  const st = stateOf(engine);
  const uid = ctx.userId;
  if (g.phase === 'starting') return ctx.info('Starting…', 'This game is starting right now.');
  if (g.phase !== 'challenge') return ctx.info('Already started', 'This challenge was already accepted.');
  if (uid === g.challenger) return ctx.info(g.target ? `Waiting for ${(await nameOf(engine, g.sid, g.target))}` : 'Waiting for someone', "You can't accept your own challenge. Press **Decline** to call it off.");
  if (g.target && uid !== g.target) return ctx.ephemeral({ embeds: [dialog.denied(null, { title: 'This challenge is for someone else', body: `Only ${mention(g.target)} can accept. Start your own with **/game**.` })] });
  if (Date.now() - g.createdAt > CHALLENGE_MS) return ctx.update(await endGame(engine, g, { kind: 'expired' }));
  const theirs = st.busy.get(busyKey(g.sid, uid));
  if (theirs && theirs !== g.id && st.games.has(theirs)) return ctx.info('Finish your other game first', 'You can only play one game at a time. Type **/game end** to give up the other one.');
  g.phase = 'starting';
  st.busy.set(busyKey(g.sid, uid), g.id);
  clearTimer(engine, `exp:${g.id}`);
  const backToChallenge = () => {
    g.phase = 'challenge';
    if (st.busy.get(busyKey(g.sid, uid)) === g.id) st.busy.delete(busyKey(g.sid, uid));
    setTimer(engine, `exp:${g.id}`, Math.max(1000, CHALLENGE_MS - (Date.now() - g.createdAt)), () => onExpire(engine, g.id));
  };
  if (g.bet) {
    if (!economyFor(engine, g.sid)) {
      g.players[1] = null;
      return ctx.update(await endGame(engine, g, { kind: 'cancelled', reason: 'bets need the Economy app, which is not installed any more' }));
    }
    const first = await hold(engine, g, g.challenger);
    if (g.phase !== 'starting') return endedWhileStarting(ctx, g);
    if (!first.ok) {
      const reason = first.why === 'funds' ? `${await nameOf(engine, g.sid, g.challenger)} doesn't have enough coins for the bet any more` : "I couldn't hold the bets right now";
      return ctx.update(await endGame(engine, g, { kind: 'cancelled', reason }));
    }
    const second = await hold(engine, g, uid);
    if (g.phase !== 'starting') return endedWhileStarting(ctx, g);
    if (!second.ok) {
      await settle(engine, g.sid, g.id, null);
      g.held = [];
      backToChallenge();
      if (second.why === 'funds') {
        const have = await balanceOf(economyFor(engine, g.sid) || { balance: () => null }, g.sid, uid);
        return ctx.warn('Not enough coins', `You need ${money(engine, g.sid, g.bet)} to accept${have !== null ? ` and you have ${money(engine, g.sid, have)}` : ''}.`);
      }
      return ctx.warn("I couldn't hold the bets", 'Nothing was taken. Try again in a moment.');
    }
  }
  g.players = [g.challenger, uid];
  if (Math.random() >= 0.5) g.players.reverse();
  g.turn = 0;
  g.board = initBoard(g.kind);
  g.picks = {};
  g.phase = 'playing';
  startIdle(engine, g);
  return ctx.update(playView(engine, g));
}

async function endedWhileStarting(ctx, g) {
  const { engine } = ctx;
  await settle(engine, g.sid, g.id, null);
  unwatch(engine, g.sid, g.id);
  g.held = [];
  return ctx.info('That game was ended', 'It was called off while it was starting. Any coins taken went back.');
}

async function nameOf(engine, sid, uid) {
  const m = await engine.perms.member(sid, uid).catch(() => null);
  return String(m?.nickname || m?.display_name || m?.username || 'them').replace(/[<>@*_`~|]/g, '');
}

async function decline(ctx, g) {
  const { engine } = ctx;
  if (g.phase !== 'challenge') return ctx.info('Already started', 'This challenge was already accepted.');
  if (ctx.userId === g.challenger) return ctx.update(await endGame(engine, g, { kind: 'withdrawn' }));
  if (!g.target) return ctx.info('Only the challenger can call this off', 'Press **Accept** if you want to play.');
  if (ctx.userId !== g.target) return ctx.ephemeral({ embeds: [dialog.denied(null, { title: 'This challenge is for someone else', body: `Only ${mention(g.target)} can answer it.` })] });
  return ctx.update(await endGame(engine, g, { kind: 'declined', by: ctx.userId }));
}

function idleOver(g) {
  return g.phase === 'playing' && Date.now() - g.lastMoveAt > IDLE_MS;
}

async function move(ctx, g, arg) {
  const { engine } = ctx;
  if (!g.players.includes(ctx.userId) || !g.players[1]) return ctx.ephemeral(notInGame(g));
  if (g.phase !== 'playing') return ctx.info('Not yet', 'This game is not running right now.');
  if (idleOver(g)) return ctx.update(await timeOut(engine, g));
  if (g.players[g.turn] !== ctx.userId) return ctx.info("It's not your turn", `Wait for ${mention(g.players[g.turn])} to move.`);
  const n = Number(arg);
  if (g.kind === 'ttt') {
    if (!Number.isInteger(n) || n < 0 || n > 8 || g.board[n] !== null) return ctx.info('That square is taken', 'Pick an empty one.');
    g.board[n] = g.turn;
    g.moves++;
    const win = tttWinner(g.board);
    if (win) { g.winLine = win.line; return ctx.update(await endGame(engine, g, { kind: 'win', winner: g.players[win.player] })); }
    if (g.board.every((c) => c !== null)) return ctx.update(await endGame(engine, g, { kind: 'draw' }));
  } else if (g.kind === 'c4') {
    const r = Number.isInteger(n) && n >= 0 && n < 7 ? c4Drop(g.board, n) : -1;
    if (r < 0) return ctx.info('That column is full', 'Pick another column.');
    g.board[r][n] = g.turn;
    g.moves++;
    if (c4Line(g.board, r, n)) return ctx.update(await endGame(engine, g, { kind: 'win', winner: g.players[g.turn] }));
    if (g.board[0].every((c) => c !== null)) return ctx.update(await endGame(engine, g, { kind: 'draw' }));
  } else {
    return ctx.info('Use the pick buttons', 'Press Rock, Paper or Scissors.');
  }
  g.turn = 1 - g.turn;
  startIdle(engine, g);
  return ctx.update(playView(engine, g));
}

async function pick(ctx, g, choice) {
  const { engine } = ctx;
  if (!g.players.includes(ctx.userId) || !g.players[1]) return ctx.ephemeral(notInGame(g));
  if (g.phase !== 'playing') return ctx.info('Not yet', 'This game is not running right now.');
  if (idleOver(g)) return ctx.update(await timeOut(engine, g));
  if (!own(RPS, choice)) return ctx.info('Pick again', 'Press Rock, Paper or Scissors.');
  if (g.picks[ctx.userId]) {
    const had = RPS[g.picks[ctx.userId]];
    return ctx.info('You already picked', `You picked ${had.emoji} **${had.label}**. Waiting for the other player.`);
  }
  g.picks[ctx.userId] = choice;
  const [a, b] = g.players;
  if (g.picks[a] && g.picks[b]) {
    const w = rpsWinner(g.picks[a], g.picks[b]);
    return ctx.update(await endGame(engine, g, w === null ? { kind: 'draw' } : { kind: 'win', winner: g.players[w] }));
  }
  startIdle(engine, g);
  const other = g.players.find((u) => u !== ctx.userId);
  await ctx.update(playView(engine, g));
  return ctx.ephemeral(`You picked ${RPS[choice].emoji} **${RPS[choice].label}**. Waiting for ${mention(other)}.`);
}

async function giveUp(ctx, g) {
  const { engine } = ctx;
  if (!g.players.includes(ctx.userId) || !g.players[1]) return ctx.ephemeral(notInGame(g));
  if (g.phase !== 'playing') return ctx.info('Not yet', 'This game is not running right now.');
  const winner = g.players.find((u) => u !== ctx.userId);
  return ctx.update(await endGame(engine, g, { kind: 'gaveup', winner }));
}

function gameAction(fn) {
  return {
    run: async (ctx) => {
      const g = stateOf(ctx.engine).games.get(ctx.argv[0]);
      if (!g || g.sid !== ctx.serverId) return lostGame(ctx, ctx.argv[0]);
      return fn(ctx, g, ctx.argv[1]);
    },
  };
}

async function endCommand(ctx, tokens) {
  const { engine } = ctx;
  const st = stateOf(engine);
  const sid = ctx.serverId;
  const who = tokens.join(' ').trim();
  let uid = ctx.userId;
  let byMod = false;
  if (who && !/^(mine|my|me)$/i.test(who)) {
    const found = await ctx.findUser(who);
    if (!found?.id) return ctx.warn("I couldn't find them", `Nobody here matches **${clip(who.replace(/[<>@]/g, ''), 40)}**.`);
    if (found.id !== ctx.userId) {
      await ctx.require('mod');
      byMod = true;
    }
    uid = found.id;
  }
  const gid = st.busy.get(busyKey(sid, uid));
  const g = gid && st.games.get(gid);
  if (!g) return ctx.info('No game to end', byMod ? `${mention(uid)} isn't in a game right now.` : "You're not in a game right now.");
  let view;
  if (byMod) view = await endGame(engine, g, { kind: 'cancelled', reason: 'a moderator ended it' });
  else if (g.phase === 'challenge') view = await endGame(engine, g, { kind: 'withdrawn' });
  else if (g.phase === 'playing') view = await endGame(engine, g, { kind: 'gaveup', winner: g.players.find((u) => u !== uid) });
  else return ctx.info('One moment', 'That game is starting right now. Try again in a second.');
  editMessage(engine, g.channelId, g.messageId, view);
  return ctx.ok('Game ended', byMod ? `${mention(uid)}'s game was cancelled and any bets went back.` : 'You left the game.');
}

function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pickQuestions(st, channelId, category, count) {
  const pool = ALL_QUESTIONS.filter((x) => !category || x.category === category);
  const recent = new Set(st.recent.get(channelId) || []);
  let fresh = pool.filter((x) => !recent.has(x.key));
  if (fresh.length < count) fresh = pool;
  const chosen = shuffle(fresh).slice(0, count);
  const list = [...(st.recent.get(channelId) || []), ...chosen.map((x) => x.key)].slice(-RECENT_KEEP);
  st.recent.set(channelId, list);
  if (st.recent.size > 500) st.recent.delete(st.recent.keys().next().value);
  return chosen.map((x) => {
    const [q, ...opts] = x.q;
    const order = shuffle(opts.map((text, i) => ({ text, right: i === 0 })));
    return { q, category: x.category, options: order.map((o) => o.text), answer: order.findIndex((o) => o.right) };
  });
}

function triviaTitle(t) {
  const q = t.questions[t.index];
  const cat = CATEGORIES[q.category];
  const n = t.total > 1 ? ` · ${t.index + 1}/${t.total}` : '';
  return `🧠 Trivia${n} · ${cat.icon} ${cat.name}`;
}

function scoreLines(t, limit = 10) {
  const list = [...t.scores.entries()].filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]);
  return list.slice(0, limit).map(([uid, s], i) => `${MEDALS[i] || `**${i + 1}.**`} ${mention(uid)} · ${plural(s, 'point')}`);
}

function questionView(t) {
  const q = t.questions[t.index];
  const opts = q.options.map((o, i) => `**${LETTERS[i]}** · ${o}`).join('\n');
  const body = `**${q.q}**\n\n${opts}\n\n⏱️ ${ANSWER_MS / 1000} seconds · everyone can answer once`;
  const count = t.answers.size;
  const buttons = q.options.map((o, i) => button(clip(`${LETTERS[i]} · ${o}`, 80), cid('ta', t.id, t.index, i), 'secondary'));
  return {
    content: '',
    embeds: [card({ title: triviaTitle(t), body, color: 'games', footer: `🙋 ${plural(count, 'answer')} so far` })],
    components: [row(buttons), row(button('Stop', cid('ts', t.id), 'danger', '⏹️'))],
  };
}

function revealCard(t) {
  const q = t.questions[t.index];
  const opts = q.options.map((o, i) => (i === q.answer ? `✅ **${LETTERS[i]} · ${o}**` : `${LETTERS[i]} · ${o}`)).join('\n');
  const right = t.lastRight || [];
  const shown = right.slice(0, 15).map(mention).join(', ');
  const more = right.length > 15 ? ` and ${right.length - 15} more` : '';
  const who = right.length ? `**Got it right (${right.length}):** ${shown}${more}\n⚡ Fastest: ${mention(right[0])}` : 'Nobody got it this time.';
  return card({ title: triviaTitle(t), body: `**${q.q}**\n\n${opts}\n\n${who}`, color: right.length ? 'ok' : 'muted', footer: `🙋 ${plural(t.answers.size, 'answer')}` });
}

function revealButtons(t) {
  const q = t.questions[t.index];
  return q.options.map((o, i) => button(clip(`${LETTERS[i]} · ${o}`, 80), cid('ta', t.id, t.index, i), i === q.answer ? 'success' : 'secondary', null, { disabled: true }));
}

function revealView(t) {
  const lines = scoreLines(t, 5);
  const e = revealCard(t);
  e.description = `${e.description}\n\n⏭️ Next question in ${BETWEEN_MS / 1000} seconds…${lines.length ? `\n\n**Scores**\n${lines.join('\n')}` : ''}`;
  return { content: '', embeds: [e], components: [row(revealButtons(t))] };
}

function againButton(t) {
  const label = t.total > 1 ? 'Play again' : 'Another question';
  return button(label, cid('tagain', t.total, t.category || 'all'), 'primary', '🔁');
}

function finalView(engine, t) {
  const embeds = [];
  if (t.revealed) embeds.push(revealCard(t));
  if (t.total > 1 || t.stoppedBy) {
    const lines = scoreLines(t);
    const parts = [lines.length ? lines.join('\n') : 'Nobody scored this time.'];
    if (t.prize?.length) parts.push('', `🪙 ${t.prize.map((p) => mention(p.uid)).join(', ')} won ${money(engine, t.sid, t.prize[0].amount)}${t.prize.length > 1 ? ' each' : ''}.`);
    if (t.stoppedBy) parts.push('', `⏹️ Stopped by ${mention(t.stoppedBy)}.`);
    const asked = t.revealed ? t.index + 1 : t.index;
    embeds.push(card({ title: '🏆 Trivia results', body: parts.join('\n'), color: 'games', footer: `${plural(asked, 'question')} asked` }));
  }
  const components = [];
  if (t.revealed) components.push(row(revealButtons(t)));
  components.push(row(againButton(t)));
  return { content: '', embeds, components };
}

function recordTriviaStats(engine, t, winners) {
  const correct = t.correct;
  if (!correct.size && !winners.length) return;
  writeDoc(engine, t.sid, (d) => {
    for (const [uid, n] of correct) {
      const u = (d.stats[uid] ||= {});
      const s = (u.trivia ||= { correct: 0, wins: 0 });
      s.correct = (Number(s.correct) || 0) + n;
    }
    for (const uid of winners) {
      const u = (d.stats[uid] ||= {});
      const s = (u.trivia ||= { correct: 0, wins: 0 });
      s.wins = (Number(s.wins) || 0) + 1;
    }
  });
}

async function finishTrivia(engine, t, { stoppedBy = null } = {}) {
  const st = stateOf(engine);
  if (t.phase === 'done') return finalView(engine, t);
  t.phase = 'done';
  t.stoppedBy = stoppedBy;
  st.trivia.delete(t.id);
  if (st.triviaByChannel.get(t.channelId) === t.id) st.triviaByChannel.delete(t.channelId);
  clearTimer(engine, `tq:${t.id}`);
  clearTimer(engine, `tc:${t.id}`);
  unwatch(engine, t.sid, t.id);
  let winners = [];
  const complete = t.revealed && t.index >= t.total - 1;
  if (t.total > 1 && !stoppedBy && complete) {
    const top = Math.max(0, ...t.scores.values());
    if (top > 0) winners = [...t.scores.entries()].filter(([, s]) => s === top).map(([uid]) => uid);
  }
  const prize = prizeOf(cfgOf(engine, t.sid));
  const eco = economyFor(engine, t.sid);
  t.prize = [];
  if (winners.length && prize > 0 && t.total >= PRIZE_ROUND_MIN && eco) {
    for (const uid of winners) {
      try {
        await eco.add(t.sid, uid, prize, 'Trivia win');
        t.prize.push({ uid, amount: prize });
      } catch (e) {
        engine.log.warn(`[games] could not pay a trivia prize: ${e?.message}`);
      }
    }
  }
  recordTriviaStats(engine, t, winners);
  return finalView(engine, t);
}

function editTrivia(engine, t, view) {
  return editMessage(engine, t.channelId, t.messageId, view);
}

async function reveal(engine, tid) {
  const t = stateOf(engine).trivia.get(tid);
  if (!t || t.phase !== 'asking') return;
  if (!engine.settings.isEnabled(t.sid, ID)) {
    editTrivia(engine, t, await finishTrivia(engine, t, { stoppedBy: null }));
    return;
  }
  t.phase = 'reveal';
  clearTimer(engine, `tc:${t.id}`);
  const q = t.questions[t.index];
  const right = [...t.answers.entries()].filter(([, a]) => a.choice === q.answer).sort((x, y) => x[1].at - y[1].at).map(([uid]) => uid);
  for (const uid of right) {
    t.scores.set(uid, (t.scores.get(uid) || 0) + 1);
    t.correct.set(uid, (t.correct.get(uid) || 0) + 1);
  }
  t.lastRight = right;
  t.revealed = true;
  if (t.index >= t.total - 1) {
    editTrivia(engine, t, await finishTrivia(engine, t));
    return;
  }
  editTrivia(engine, t, revealView(t));
  setTimer(engine, `tq:${t.id}`, BETWEEN_MS, () => nextQuestion(engine, t.id));
}

async function nextQuestion(engine, tid) {
  const t = stateOf(engine).trivia.get(tid);
  if (!t || t.phase !== 'reveal') return;
  t.index++;
  t.answers = new Map();
  t.lastRight = [];
  t.revealed = false;
  t.phase = 'asking';
  t.askedAt = Date.now();
  t.lastCountEdit = Date.now();
  editTrivia(engine, t, questionView(t));
  setTimer(engine, `tq:${t.id}`, ANSWER_MS, () => reveal(engine, t.id));
}

function bumpCount(engine, t) {
  const now = Date.now();
  const since = now - t.lastCountEdit;
  if (since >= COUNT_EDIT_MS) {
    t.lastCountEdit = now;
    editTrivia(engine, t, questionView(t));
    return;
  }
  const key = `tc:${t.id}`;
  if (stateOf(engine).timers.has(key)) return;
  const index = t.index;
  setTimer(engine, key, COUNT_EDIT_MS - since, async () => {
    if (t.phase !== 'asking' || t.index !== index) return;
    t.lastCountEdit = Date.now();
    editTrivia(engine, t, questionView(t));
  });
}

function parseTriviaArgs(tokens) {
  let count = null;
  let category = null;
  let unknown = null;
  for (const raw of tokens) {
    const tok = String(raw).toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (!tok) continue;
    if (/^\d+$/.test(tok)) { count = Number(tok); continue; }
    if (/^(all|any|mixed|everything|round|questions?|of|q)$/.test(tok)) continue;
    if (own(CATEGORY_ALIASES, tok)) { category = CATEGORY_ALIASES[tok]; continue; }
    unknown ||= tok;
  }
  return { count, category, unknown };
}

function categoriesView() {
  const lines = Object.entries(CATEGORIES).map(([k, c]) => `${c.icon} **${c.name}** · ${QUESTIONS[k].length} questions · \`/trivia ${k}\``);
  return { embeds: [card({ title: '🧠 Trivia categories', body: `${lines.join('\n')}\n\n-# Mix them up with just **/trivia**. Add a number for a round: \`/trivia 5 science\` (up to ${MAX_ROUND}).`, color: 'games', footer: false })] };
}

async function runTrivia(ctx, tokens = ctx.argv) {
  const first = String(tokens[0] || '').toLowerCase();
  if (/^(categories|category|cats|list|topics|help)$/.test(first)) return ctx.ephemeral(categoriesView());
  if (/^(stop|end|cancel)$/.test(first)) return stopFromCommand(ctx);
  const { count, category, unknown } = parseTriviaArgs(tokens);
  if (unknown) {
    const guess = didYouMean(unknown, Object.keys(CATEGORY_ALIASES));
    return ctx.warn("I don't know that category", `There's no **${clip(unknown, 30)}** category.${guess.length ? ` Did you mean ${[...new Set(guess.map((g) => CATEGORY_ALIASES[g]))].map((g) => `**${g}**`).join(', ')}?` : ''}\nCategories: ${Object.keys(CATEGORIES).join(', ')}.`);
  }
  const total = Math.min(MAX_ROUND, Math.max(1, count || 1));
  return startTrivia(ctx, { total, category, reuse: false });
}

async function stopFromCommand(ctx) {
  const st = stateOf(ctx.engine);
  const tid = st.triviaByChannel.get(ctx.channelId);
  const t = tid && st.trivia.get(tid);
  if (!t) return ctx.info('No trivia here', 'Nothing is running in this channel.');
  if (t.starterId !== ctx.userId) await ctx.require('mod');
  editTrivia(ctx.engine, t, await finishTrivia(ctx.engine, t, { stoppedBy: ctx.userId }));
  return ctx.ok('Trivia stopped', 'The scores so far are on the trivia message.');
}

async function startTrivia(ctx, { total, category, reuse }) {
  const { engine } = ctx;
  const st = stateOf(engine);
  const sid = ctx.serverId;
  const running = st.triviaByChannel.get(ctx.channelId);
  if (running && st.trivia.has(running)) return ctx.info('Trivia is already running here', 'Answer the current question, or wait for it to finish.');
  const inServer = [...st.trivia.values()].filter((t) => t.sid === sid).length;
  if (inServer >= MAX_TRIVIA) return ctx.warn('Lots of trivia going', `There are already ${MAX_TRIVIA} trivia games running here. Try again when one ends.`);
  const questions = pickQuestions(st, ctx.channelId, category, total);
  if (!questions.length) return ctx.warn('No questions', 'I ran out of questions for that. Try another category.');
  const t = {
    id: newId(), sid, channelId: ctx.channelId, messageId: null, starterId: ctx.userId, total: questions.length, category,
    questions, index: 0, answers: new Map(), scores: new Map(), correct: new Map(), lastRight: [], revealed: false,
    phase: 'asking', askedAt: Date.now(), lastCountEdit: Date.now(), prize: [], stoppedBy: null,
  };
  st.trivia.set(t.id, t);
  st.triviaByChannel.set(ctx.channelId, t.id);
  const view = questionView(t);
  let sent = null;
  try {
    if (reuse && ctx.source?.message_id) {
      await ctx.update(view);
      t.messageId = ctx.source.message_id;
    } else {
      sent = await ctx.reply({ ...view, open: true });
      t.messageId = (sent?.message ?? sent)?.id ?? null;
    }
  } catch (e) {
    st.trivia.delete(t.id);
    st.triviaByChannel.delete(ctx.channelId);
    throw e;
  }
  watch(engine, sid, t.id, { kind: 'trivia', channelId: t.channelId, messageId: t.messageId, at: Date.now(), held: null });
  setTimer(engine, `tq:${t.id}`, ANSWER_MS, () => reveal(engine, t.id));
  return sent;
}

async function answer(ctx) {
  const { engine } = ctx;
  const [tid, qi, choice] = ctx.argv;
  const t = stateOf(engine).trivia.get(tid);
  if (!t || t.sid !== ctx.serverId) {
    if (messageInUse(engine, ctx.source?.message_id)) return ctx.info('Too late', 'That question is already over.');
    const rec = await closeLost(engine, ctx.serverId, tid);
    if (!rec) return ctx.info('Too late', 'That trivia is already over.');
    return ctx.update(lostView('trivia'));
  }
  const c = Number(choice);
  if (Number(qi) !== t.index || t.phase !== 'asking') return ctx.info('Too late', 'That question is already over.');
  if (Date.now() - t.askedAt > ANSWER_MS) {
    sweep(engine).catch(() => {});
    return ctx.info("Time's up", 'The answer shows in a moment.');
  }
  const had = t.answers.get(ctx.userId);
  if (had) return ctx.info('You already answered', `You picked **${LETTERS[had.choice]}**. One answer per question.`);
  if (!Number.isInteger(c) || c < 0 || c > 3) return ctx.info('Pick again', 'Press one of the answer buttons.');
  t.answers.set(ctx.userId, { choice: c, at: Date.now() });
  await ctx.ephemeral(`🔒 Locked in **${LETTERS[c]}**. The answer shows when the time is up.`);
  bumpCount(engine, t);
  return undefined;
}

async function stopTrivia(ctx) {
  const { engine } = ctx;
  const t = stateOf(engine).trivia.get(ctx.argv[0]);
  if (!t || t.sid !== ctx.serverId) {
    if (messageInUse(engine, ctx.source?.message_id)) return ctx.info('Already over', 'That trivia already ended.');
    const rec = await closeLost(engine, ctx.serverId, ctx.argv[0]);
    if (!rec) return ctx.info('Already over', 'That trivia already ended.');
    return ctx.update(lostView('trivia'));
  }
  if (t.starterId !== ctx.userId) {
    const level = await ctx.level();
    if (!engine.perms.atLeast(level, 'mod')) return ctx.ephemeral({ embeds: [dialog.denied(null, { title: "You can't stop this one", body: `Only ${mention(t.starterId)} or a moderator can stop this trivia.` })] });
  }
  const view = await finishTrivia(engine, t, { stoppedBy: ctx.userId });
  await ctx.ack();
  editTrivia(engine, t, view);
  return undefined;
}

async function playAgain(ctx) {
  const total = Math.min(MAX_ROUND, Math.max(1, Number(ctx.argv[0]) || 1));
  const category = own(CATEGORIES, ctx.argv[1]) ? ctx.argv[1] : null;
  return startTrivia(ctx, { total, category, reuse: true });
}

function recordOf(engine, sid, uid) {
  return readDoc(engine, sid).stats[uid] || {};
}

function recordLines(engine, sid, uid) {
  const s = recordOf(engine, sid, uid);
  const lines = [];
  for (const [kind, k] of Object.entries(KINDS)) {
    const r = s[kind];
    if (!r) continue;
    lines.push(`${k.icon} **${k.name}** · ${plural(r.w || 0, 'win')} · ${plural(r.l || 0, 'loss', 'losses')} · ${plural(r.d || 0, 'draw')}`);
  }
  if (s.trivia) lines.push(`🧠 **Trivia** · ${plural(s.trivia.correct || 0, 'right answer')} · ${plural(s.trivia.wins || 0, 'round win')}`);
  return lines;
}

async function statsCommand(ctx, tokens) {
  const who = tokens.join(' ').trim();
  let uid = ctx.userId;
  if (who) {
    const found = await ctx.findUser(who);
    if (!found?.id) return ctx.warn("I couldn't find them", `Nobody here matches **${clip(who.replace(/[<>@]/g, ''), 40)}**.`);
    uid = found.id;
  }
  const lines = recordLines(ctx.engine, ctx.serverId, uid);
  const name = await nameOf(ctx.engine, ctx.serverId, uid);
  const body = lines.length ? lines.join('\n') : `${uid === ctx.userId ? "You haven't" : `${name} hasn't`} played yet. Try **/game tictactoe @someone** or **/trivia**.`;
  return ctx.ephemeral({ embeds: [card({ title: `📊 ${uid === ctx.userId ? 'Your' : `${name}'s`} game record`, body, color: 'games', footer: false })] });
}

function listView(engine, sid) {
  const st = stateOf(engine);
  const lines = Object.values(KINDS).map((k) => `${k.icon} **${k.name}** · \`${k.usage}\``);
  lines.push('🧠 **Trivia** · `/trivia`, `/trivia 5 science`');
  const live = serverGames(st, sid).map((g) => {
    const k = KINDS[g.kind];
    const who = g.players[1] ? `${mention(g.players[0])} vs ${mention(g.players[1])}` : `${mention(g.challenger)} is waiting${g.target ? ` for ${mention(g.target)}` : ''}`;
    return `${k.icon} ${who} in <#${g.channelId}>`;
  });
  const quiz = [...st.trivia.values()].filter((t) => t.sid === sid).map((t) => `🧠 Trivia in <#${t.channelId}>${t.total > 1 ? ` (question ${t.index + 1}/${t.total})` : ''}`);
  const fields = [{ name: 'Playing now', value: [...live, ...quiz].join('\n') || 'Nothing right now.' }];
  return { embeds: [card({ title: '🎮 Games', body: `${lines.join('\n')}\n\n-# Add \`bet 50\` to play for coins (needs the Economy app).`, fields, color: 'games', footer: false })] };
}

function panelView(engine, sid, uid, isAdmin) {
  const st = stateOf(engine);
  const cfg = cfgOf(engine, sid);
  const eco = economyFor(engine, sid);
  const intro = [
    'Challenge someone to a game played right here in chat:',
    ...Object.values(KINDS).map((k) => `${k.icon} **${k.name}** · \`${k.usage}\``),
    '🧠 **Trivia** for everyone · `/trivia`, or `/trivia 5 science` for a round',
  ];
  const panelMaxBet = maxBetOf(cfg);
  if (eco && cfg.bets !== false) intro.push('', `💰 Add \`bet 50\` to play for coins (${isUnlimited(panelMaxBet) ? 'bet any amount you like' : `up to ${money(engine, sid, panelMaxBet)}`}).`);
  const record = recordLines(engine, sid, uid);
  const playing = serverGames(st, sid).length;
  const quiz = [...st.trivia.values()].filter((t) => t.sid === sid).length;
  const fields = [
    { name: 'Your record', value: record.length ? record.join('\n') : 'No games yet.' },
    { name: 'Playing now', value: `${plural(playing, 'game')} · ${plural(quiz, 'trivia', 'trivia')}`, inline: true },
  ];
  const buttons = [
    button('Trivia question', cid('tnew', 1), 'primary', '🧠'),
    button('Trivia round', cid('tnew', 5), 'secondary', '🏆'),
    button('Games list', cid('list'), 'secondary', '📋'),
  ];
  if (isAdmin) buttons.push(button('Settings', cid('settings'), 'secondary', '⚙️'));
  return { embeds: [card({ title: `${ICONS.games} Games`, body: intro.join('\n'), fields, color: 'games' })], components: [row(buttons)] };
}

function settingsView(engine, sid) {
  const cfg = cfgOf(engine, sid);
  const eco = economyFor(engine, sid);
  const lines = [
    `💰 **Bets:** ${cfg.bets !== false ? '🟢 On' : '⚪ Off'}${eco ? '' : ' *(needs the Economy app)*'}`,
    `📈 **Biggest bet:** ${moneyLimit(engine, sid, maxBetOf(cfg), 'No limit')}`,
    `🏆 **Trivia round prize:** ${prizeOf(cfg) > 0 ? `${money(engine, sid, prizeOf(cfg))} for the winner of a round of ${PRIZE_ROUND_MIN}+ questions` : 'Off'}`,
    '',
    '-# Typed: `/game bets off` · `/game maxbet 500` (or `inf`) · `/game prize 50` (0 turns it off)',
  ];
  return {
    embeds: [card({ title: '⚙️ Games settings', body: lines.join('\n'), color: 'games', footer: false })],
    components: [row(
      button(cfg.bets !== false ? 'Turn bets off' : 'Turn bets on', cid('tbets'), cfg.bets !== false ? 'secondary' : 'success', '💰'),
      button('Prize and max bet', cid('setform'), 'primary', '✏️'),
    )],
  };
}

const MAXBET_HELP = 'Use a whole number of coins, like `/game maxbet 500`, or `inf` for no limit at all.';
const PRIZE_HELP = 'Use a whole number of coins, like `/game prize 50`, or `0` to turn it off.';

function checkMaxBet(raw) {
  return parseLimit(raw, { min: 1, max: HARD_CAP });
}

function checkPrize(raw) {
  if (/^off$/i.test(String(raw ?? '').trim())) return 0;
  return parseLimit(raw, { min: 0, max: HARD_CAP, unlimited: false });
}

const DASHBOARD = [
  boolField({ key: 'bets', label: 'Allow coin bets', help: "Lets players add 'bet 50' to a game to play for Economy coins." }),
  {
    key: 'maxBet', label: 'Biggest bet allowed', type: 'number', web: true, unlimited: true, min: 1, max: HARD_CAP, step: 1,
    help: 'The largest number of coins one player can bet on a game. Type inf for no limit at all.',
    validate: (ctx, v) => {
      const n = checkMaxBet(v);
      return n === null ? rejectValue(MAXBET_HELP) : acceptValue(storeLimit(n));
    },
  },
  {
    key: 'triviaPrize', label: 'Trivia round prize (coins)', type: 'number', web: true, min: 0, max: HARD_CAP, step: 1,
    help: 'Coins paid to the winner of a trivia round of 3 or more questions. 0 turns it off.',
    validate: (ctx, v) => {
      const n = checkPrize(v);
      return n === null ? rejectValue(PRIZE_HELP) : acceptValue(n);
    },
  },
];

async function adminSetting(ctx, sub, rest) {
  await ctx.require('admin');
  const { engine } = ctx;
  const sid = ctx.serverId;
  if (sub === 'settings' || sub === 'config') return ctx.ephemeral(settingsView(engine, sid));
  if (sub === 'bets') {
    const v = String(rest[0] || '').toLowerCase();
    const next = /^(on|yes|true|enable)$/.test(v) ? true : /^(off|no|false|disable)$/.test(v) ? false : cfgOf(engine, sid).bets === false;
    ctx.patchConfig({ bets: next });
    return ctx.ok('Saved', next ? 'People can bet coins on games now.' : 'Betting is off. Games still work without bets.');
  }
  if (sub === 'maxbet') {
    const n = checkMaxBet(rest[0]);
    if (n === null) return ctx.warn("That didn't work", MAXBET_HELP);
    ctx.patchConfig({ maxBet: storeLimit(n) });
    return ctx.ok('Saved', isUnlimited(n) ? 'There is no limit on bets now.' : `The biggest bet is now ${money(engine, sid, n)}.`);
  }
  if (sub === 'prize') {
    const n = checkPrize(rest[0]);
    if (n === null) return ctx.warn("That didn't work", PRIZE_HELP);
    ctx.patchConfig({ triviaPrize: n });
    return ctx.ok('Saved', n ? `The winner of a trivia round (${PRIZE_ROUND_MIN}+ questions) gets ${money(engine, sid, n)}.` : 'Trivia rounds give no coins now.');
  }
  return null;
}

async function showPanel(ctx) {
  const isAdmin = ctx.engine.perms.atLeast(await ctx.level(), 'admin');
  return ctx.ephemeral(panelView(ctx.engine, ctx.serverId, ctx.userId, isAdmin));
}

async function runGame(ctx, tokens = ctx.argv) {
  const first = String(tokens[0] || '').toLowerCase().replace(/^\//, '');
  const rest = tokens.slice(1);
  if (!first || first === 'menu' || first === 'panel' || first === 'home') return showPanel(ctx);
  if (first === 'list' || first === 'games' || first === 'help' || first === 'all') return ctx.ephemeral(listView(ctx.engine, ctx.serverId));
  if (first === 'stats' || first === 'record' || first === 'score' || first === 'scores') return statsCommand(ctx, rest);
  if (first === 'end' || first === 'stop' || first === 'quit' || first === 'forfeit' || first === 'cancel') return endCommand(ctx, rest);
  if (['settings', 'config', 'bets', 'maxbet', 'prize'].includes(first)) return adminSetting(ctx, first, rest);
  if (first === 'trivia' || first === 'quiz') return runTrivia(ctx, rest);
  const kind = own(ALIASES, first);
  if (kind) return startChallenge(ctx, kind, rest);
  const guess = didYouMean(first, [...Object.keys(ALIASES), ...SUBS]);
  const shown = clip(first.replace(/[<>@`*_~|]/g, ''), 30);
  return ctx.warn("I didn't get that", `I don't know the game **${shown || '?'}**.${guess.length ? ` Did you mean ${[...new Set(guess)].map((g) => `**${g}**`).join(', ')}?` : ''}\nTry \`/game tictactoe @sam\`, \`/game connect4 @sam\`, \`/game rps @sam\` or \`/game list\`.`);
}

async function cleanupJob(job, engine) {
  const st = stateOf(engine);
  const id = job.data?.id || job.key;
  const sid = job.serverId;
  if (!id || !sid) return undefined;
  const enabled = engine.settings.isEnabled(sid, ID);
  const g = st.games.get(id);
  if (g) {
    if (enabled) return { reschedule: engine.scheduler.now() + CHECK_MS };
    const view = await endGame(engine, g, { kind: 'cancelled', reason: 'Games was uninstalled here' });
    await editMessage(engine, g.channelId, g.messageId, view);
    return undefined;
  }
  const t = st.trivia.get(id);
  if (t) {
    if (enabled) return { reschedule: engine.scheduler.now() + CHECK_MS };
    await editTrivia(engine, t, await finishTrivia(engine, t));
    return undefined;
  }
  const rec = await closeLost(engine, sid, id);
  if (rec?.channelId && rec.messageId) await editMessage(engine, rec.channelId, rec.messageId, lostView(rec.kind === 'trivia' ? 'trivia' : 'game'));
  return undefined;
}

export const { setup, teardown, check } = defineApp({
  id: ID,
  name: 'Games',
  icon: ICONS.games,
  description: 'Tic-tac-toe, Connect 4, rock paper scissors and trivia.',
  category: 'Fun',
  phase: 3,
  panelPerm: 'member',

  defaults: {
    bets: true,
    maxBet: 1000,
    triviaPrize: 25,
  },

  dashboard: DASHBOARD,

  commands: {
    game: { description: 'Play someone: /game tictactoe @sam, /game connect4 @sam, /game rps @sam bet 50, /game list', run: (ctx) => runGame(ctx, ctx.argv) },
    trivia: { description: 'Trivia for everyone here: /trivia, /trivia 5 for a round, /trivia science, /trivia categories', run: (ctx) => runTrivia(ctx, ctx.argv) },
  },

  components: {
    acc: gameAction(accept),
    dec: gameAction(decline),
    mv: gameAction(move),
    rps: gameAction(pick),
    ff: gameAction(giveUp),
    rm: { run: (ctx) => rematch(ctx, ctx.argv[0]) },
    ta: { run: answer },
    ts: { run: stopTrivia },
    tagain: { run: playAgain },
    tnew: { run: (ctx) => startTrivia(ctx, { total: Math.min(MAX_ROUND, Math.max(1, Number(ctx.argv[0]) || 1)), category: null, reuse: false }) },
    list: { run: (ctx) => ctx.ephemeral(listView(ctx.engine, ctx.serverId)) },
    settings: { perm: 'admin', run: (ctx) => ctx.ephemeral(settingsView(ctx.engine, ctx.serverId)) },
    tbets: {
      perm: 'admin',
      run: async (ctx) => {
        await ctx.require('admin');
        ctx.patchConfig({ bets: ctx.config().bets === false });
        return ctx.update(settingsView(ctx.engine, ctx.serverId));
      },
    },
    setform: {
      perm: 'admin',
      run: async (ctx) => {
        await ctx.require('admin');
        const cfg = ctx.config();
        return ctx.form({
          title: 'Games settings',
          action: 'setsave',
          fields: [
            { id: 'prize', label: 'Trivia round prize in coins (0 = off)', style: 'short', value: String(prizeOf(cfg)), max: 20 },
            { id: 'maxbet', label: 'Biggest bet allowed (inf = no limit)', style: 'short', value: maxBetText(cfg), max: 20 },
          ],
        });
      },
    },
    setsave: {
      perm: 'admin',
      run: async (ctx) => {
        await ctx.require('admin');
        const prize = checkPrize(ctx.values?.prize);
        const maxBet = checkMaxBet(ctx.values?.maxbet);
        if (prize === null) return ctx.warn("That prize didn't work", 'Use a whole number of coins, or 0 to turn it off.');
        if (maxBet === null) return ctx.warn("That max bet didn't work", 'Use a whole number of coins, 1 or more, or `inf` for no limit.');
        ctx.patchConfig({ triviaPrize: prize, maxBet: storeLimit(maxBet) });
        return ctx.ok('Saved', `Trivia round prize: ${prize ? money(ctx.engine, ctx.serverId, prize) : 'off'}. Biggest bet: ${moneyLimit(ctx.engine, ctx.serverId, maxBet, 'no limit')}.`);
      },
    },
  },

  jobs: {
    cleanup: cleanupJob,
  },

  onUninstall: (engine, sid) => {
    const s = engine.scheduler;
    if (!s) return;
    for (const job of s.list({ kind: JOB, serverId: sid })) s.schedule({ kind: JOB, at: s.now(), serverId: sid, key: job.key, data: job.data });
  },

  yap: [
    { words: ['game', 'games'], run: (ctx) => runGame(ctx, ctx.argv) },
    { words: ['tictactoe', 'ttt', 'connect4', 'c4', 'rps'], run: (ctx) => runGame(ctx, [ctx.word, ...ctx.argv]) },
    { words: ['trivia', 'quiz'], run: (ctx) => runTrivia(ctx, ctx.argv) },
  ],

  panel: showPanel,

  services: (engine) => ({
    isPlaying: (sid, uid) => {
      const gid = stateOf(engine).busy.get(busyKey(sid, uid));
      return !!gid && stateOf(engine).games.has(gid);
    },
    active: (sid) => {
      const st = stateOf(engine);
      return { games: serverGames(st, sid).length, trivia: [...st.trivia.values()].filter((t) => t.sid === sid).length };
    },
    trivia: (channelId) => {
      const st = stateOf(engine);
      const t = st.trivia.get(st.triviaByChannel.get(channelId));
      if (!t) return null;
      const q = t.questions[t.index];
      return { id: t.id, index: t.index, total: t.total, phase: t.phase, question: q.q, options: [...q.options], answer: q.answer, category: q.category };
    },
    game: (sid, uid) => {
      const st = stateOf(engine);
      const g = st.games.get(st.busy.get(busyKey(sid, uid)));
      return g ? { id: g.id, kind: g.kind, phase: g.phase, players: [...g.players], turn: g.turn, bet: g.bet, messageId: g.messageId } : null;
    },
    sweep: () => sweep(engine),
  }),

  help: [
    'Games are played in one message. Only the two players can press the board; everyone else gets a short private note. Each move has 2 minutes, or that player forfeits.',
    'Challenges last 60 seconds. Leave the name out (`/game tictactoe`) and anyone can accept. **Rematch** at the end plays again.',
    'Bets: add `bet 50` (needs the Economy app). Both bets are held when the challenge is accepted; the winner takes the pot, a draw or a cancel gives them back.',
    'Trivia: `/trivia`, `/trivia 5`, `/trivia history`. 20 seconds per question, everyone answers once. Categories: general, science, geography, history, games, music.',
    'Give up with `/game end`. Mods: `/game end @sam` ends a stuck game and gives bets back. Admins: `/game bets off`, `/game maxbet 500`, `/game prize 50`.',
  ],

  dispose: (engine) => {
    const st = states.get(engine);
    if (st) {
      st.disposed = true;
      if (st.timer) clearTimeout(st.timer);
      st.timers.clear();
    }
    states.delete(engine);
  },
});
