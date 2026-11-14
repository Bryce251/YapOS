const ROWS = [
  ['animals', 'Animals', '🐾', ['cat', 'dog', 'elephant', 'giraffe', 'lion', 'rabbit', 'snake', 'monkey', 'zebra', 'kangaroo', 'horse', 'frog']],
  ['sea', 'Sea Life', '🌊', ['fish', 'shark', 'octopus', 'whale', 'crab', 'jellyfish', 'starfish', 'dolphin', 'seahorse', 'lobster', 'turtle']],
  ['birds', 'Birds', '🐦', ['owl', 'duck', 'parrot', 'eagle', 'chicken', 'flamingo', 'swan', 'peacock', 'penguin', 'pelican', 'toucan']],
  ['bugs', 'Bugs', '🐞', ['bee', 'butterfly', 'spider', 'ant', 'ladybug', 'snail', 'worm', 'caterpillar', 'dragonfly', 'grasshopper', 'firefly']],
  ['food', 'Food', '🍕', ['pizza', 'burger', 'hot dog', 'taco', 'sandwich', 'pancake', 'spaghetti', 'sushi', 'fries', 'popcorn', 'pretzel', 'soup']],
  ['fruit', 'Fruit', '🍎', ['apple', 'banana', 'grapes', 'strawberry', 'pineapple', 'watermelon', 'cherry', 'lemon', 'pear', 'orange', 'coconut']],
  ['veg', 'Vegetables', '🥕', ['carrot', 'broccoli', 'corn', 'potato', 'mushroom', 'tomato', 'pumpkin', 'onion', 'pepper', 'peas', 'lettuce']],
  ['sweets', 'Desserts', '🍰', ['cake', 'ice cream', 'cookie', 'cupcake', 'pie', 'lollipop', 'candy cane', 'donut', 'pudding', 'waffle', 'chocolate']],
  ['drinks', 'Drinks', '🥤', ['coffee', 'milkshake', 'lemonade', 'tea', 'juice box', 'soda', 'hot cocoa', 'smoothie', 'water bottle', 'milk']],
  ['places', 'Places', '📍', ['bakery', 'library', 'hospital', 'airport', 'zoo', 'museum', 'lighthouse', 'playground', 'cinema', 'supermarket', 'train station']],
  ['jobs', 'Jobs', '💼', ['doctor', 'chef', 'firefighter', 'pilot', 'teacher', 'farmer', 'mechanic', 'police officer', 'painter', 'dentist', 'plumber']],
  ['sports', 'Sports', '⚽', ['soccer', 'basketball', 'tennis', 'baseball', 'golf', 'swimming', 'skiing', 'bowling', 'boxing', 'surfing', 'skateboarding']],
  ['home', 'Things at Home', '🏠', ['lamp', 'chair', 'bed', 'sofa', 'clock', 'door', 'window', 'mirror', 'toothbrush', 'pillow', 'television']],
  ['kitchen', 'Kitchen', '🍳', ['fork', 'spoon', 'frying pan', 'kettle', 'toaster', 'fridge', 'oven', 'mug', 'plate', 'blender', 'whisk']],
  ['vehicles', 'Vehicles', '🚗', ['car', 'bus', 'train', 'bicycle', 'airplane', 'boat', 'helicopter', 'rocket', 'scooter', 'motorcycle', 'submarine']],
  ['weather', 'Weather', '⛅', ['rain', 'snow', 'sunshine', 'rainbow', 'tornado', 'lightning', 'cloud', 'wind', 'fog', 'hail', 'umbrella']],
  ['school', 'School', '🎒', ['pencil', 'backpack', 'ruler', 'notebook', 'eraser', 'desk', 'chalkboard', 'scissors', 'glue', 'calculator', 'globe']],
  ['clothes', 'Clothes', '👕', ['hat', 'tie', 'sock', 'scarf', 'glove', 'jacket', 'dress', 'shirt', 'boots', 'sunglasses', 'pajamas']],
  ['music', 'Music', '🎵', ['guitar', 'piano', 'drum', 'trumpet', 'violin', 'microphone', 'harp', 'flute', 'headphones', 'saxophone']],
  ['nature', 'Nature', '🌳', ['tree', 'flower', 'mountain', 'river', 'volcano', 'waterfall', 'cactus', 'leaf', 'island', 'cave', 'desert']],
  ['space', 'Space', '🚀', ['moon', 'star', 'planet', 'comet', 'alien', 'astronaut', 'telescope', 'satellite', 'flying saucer', 'meteor', 'space station']],
  ['toys', 'Toys', '🧸', ['teddy bear', 'kite', 'yo yo', 'ball', 'doll', 'robot', 'puzzle', 'blocks', 'jump rope', 'marbles', 'spinning top']],
  ['fantasy', 'Fantasy', '🐉', ['dragon', 'unicorn', 'wizard', 'fairy', 'mermaid', 'ghost', 'castle', 'giant', 'knight', 'treasure', 'magic wand', 'crown']],
  ['tools', 'Tools', '🔧', ['hammer', 'saw', 'screwdriver', 'wrench', 'ladder', 'shovel', 'drill', 'paintbrush', 'tape measure', 'rake', 'flashlight']],
  ['party', 'Party Time', '🎉', ['present', 'party hat', 'candle', 'confetti', 'balloon', 'fireworks', 'disco ball', 'bouncy castle', 'magician', 'birthday card', 'streamers']],
  ['body', 'Body Parts', '✋', ['hand', 'foot', 'eye', 'nose', 'ear', 'mouth', 'hair', 'tooth', 'elbow', 'knee', 'thumb']],
  ['farm', 'Farm', '🚜', ['cow', 'pig', 'sheep', 'barn', 'tractor', 'hay', 'goat', 'rooster', 'scarecrow', 'fence', 'windmill']],
  ['beach', 'Beach Day', '🏖️', ['sandcastle', 'beach ball', 'seashell', 'sunscreen', 'flip flops', 'bucket', 'wave', 'palm tree', 'towel', 'lifeguard', 'surfboard']],
  ['city', 'City', '🏙️', ['skyscraper', 'traffic light', 'bridge', 'taxi', 'fountain', 'statue', 'subway', 'crosswalk', 'bench', 'mailbox', 'streetlight']],
  ['camping', 'Camping', '⛺', ['tent', 'campfire', 'marshmallow', 'sleeping bag', 'lantern', 'compass', 'map', 'canoe', 'hiking boots', 'bear', 'fishing rod']],
  ['games', 'Games', '🎲', ['chess', 'playing cards', 'dice', 'video game', 'tic tac toe', 'dominoes', 'checkers', 'pinball', 'darts', 'bingo']],
  ['dinos', 'Dinosaur Days', '🦕', ['lava', 'egg', 'fossil', 'bone', 'footprint', 'nest', 'fern', 'swamp', 'claw', 'tail']],
];

export const TOPICS = Object.freeze(
  ROWS.map(([id, name, emoji, words]) => Object.freeze({ id, name, emoji, words: Object.freeze(words.slice()) })),
);

function build() {
  const out = [];
  for (const t of TOPICS) for (const w of t.words) out.push(Object.freeze({ id: out.length, w, topic: t.id }));
  return Object.freeze(out);
}

export const WORDS = build();

export function wordById(id) {
  return Number.isInteger(id) && id >= 0 && id < WORDS.length ? WORDS[id] : null;
}

export function topicById(id) {
  return TOPICS.find((t) => t.id === id) || null;
}

export function wordsOf(topicId) {
  return WORDS.filter((w) => w.topic === topicId);
}
