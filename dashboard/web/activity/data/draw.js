export const TIERS = Object.freeze([
  { id: 'easy', name: 'Easy', emoji: '🟢' },
  { id: 'medium', name: 'Medium', emoji: '🟡' },
  { id: 'hard', name: 'Hard', emoji: '🔴' },
]);

const EASY = [
  'cat', 'dog', 'sun', 'moon', 'star', 'tree', 'house', 'car', 'fish', 'apple',
  'banana', 'ball', 'cake', 'hat', 'shoe', 'boat', 'bird', 'flower', 'cloud', 'rain',
  'snowman', 'egg', 'cup', 'book', 'clock', 'key', 'door', 'chair', 'bed', 'pizza',
  'duck', 'frog', 'snake', 'spider', 'heart', 'smile', 'kite', 'bus', 'train', 'cookie',
  'carrot', 'ice cream', 'rainbow', 'candle', 'bell', 'crown', 'ghost', 'robot', 'rocket', 'sock',
  'glasses', 'umbrella', 'pencil', 'lamp', 'mouse', 'cow', 'pig', 'bee', 'leaf', 'mountain',
  'island', 'window', 'grapes', 'lemon', 'cherry', 'donut', 'worm', 'whale', 'ladybug', 'nose',
];

const MEDIUM = [
  'giraffe', 'penguin', 'octopus', 'volcano', 'lighthouse', 'castle', 'dragon', 'unicorn', 'guitar', 'piano',
  'drum', 'ladder', 'bridge', 'tent', 'campfire', 'backpack', 'telescope', 'magnet', 'compass', 'toaster',
  'pirate', 'wizard', 'mermaid', 'astronaut', 'airplane', 'helicopter', 'submarine', 'tractor', 'bicycle', 'skateboard',
  'snowflake', 'tornado', 'waterfall', 'cactus', 'mushroom', 'pineapple', 'sandwich', 'popcorn', 'pancake', 'hamburger',
  'toothbrush', 'scissors', 'hammer', 'envelope', 'balloon', 'present', 'trophy', 'anchor', 'parachute', 'igloo',
  'pyramid', 'windmill', 'scarecrow', 'dinosaur', 'kangaroo', 'turtle', 'snail', 'butterfly', 'jellyfish', 'owl',
  'fireworks', 'sandcastle', 'swing', 'treasure chest', 'crayon', 'watermelon', 'flamingo', 'hedgehog', 'teapot', 'lollipop',
];

const HARD = [
  'traffic jam', 'sunburn', 'homework', 'jump rope', 'roller coaster', 'hot air balloon', 'bowling', 'fishing rod', 'birthday party', 'time machine',
  'haunted house', 'shooting star', 'solar system', 'treasure map', 'message in a bottle', 'skyscraper', 'lawn mower', 'vacuum cleaner', 'washing machine', 'sleepwalking',
  'daydream', 'shadow', 'earthquake', 'avalanche', 'photographer', 'detective', 'magician', 'juggler', 'lifeguard', 'firefighter',
  'beekeeper', 'trampoline', 'escalator', 'seesaw', 'hourglass', 'chandelier', 'fingerprint', 'footprint', 'constellation', 'eclipse',
  'piggy bank', 'snow globe', 'music box', 'spaghetti', 'tug of war', 'hide and seek', 'sandstorm', 'high five', 'wishbone', 'library',
  'museum', 'zoo keeper', 'waiter', 'scuba diver', 'dentist', 'snowball fight', 'pillow fight', 'bubble bath', 'treehouse', 'garden gnome',
];

function build() {
  const out = [];
  const add = (list, tier) => {
    for (const w of list) out.push({ id: out.length, w, tier });
  };
  add(EASY, 'easy');
  add(MEDIUM, 'medium');
  add(HARD, 'hard');
  return Object.freeze(out.map((x) => Object.freeze(x)));
}

export const WORDS = build();

export function wordById(id) {
  return Number.isInteger(id) && id >= 0 && id < WORDS.length ? WORDS[id] : null;
}

export function wordsIn(tier) {
  return WORDS.filter((x) => x.tier === tier);
}
