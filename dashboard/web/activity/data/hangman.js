export const CATEGORIES = Object.freeze([
  Object.freeze({ id: 'animals', name: 'Animals', emoji: '🐾' }),
  Object.freeze({ id: 'food', name: 'Food', emoji: '🍕' }),
  Object.freeze({ id: 'places', name: 'Places', emoji: '🗺️' }),
  Object.freeze({ id: 'things', name: 'Things', emoji: '🧸' }),
  Object.freeze({ id: 'sports', name: 'Sports & hobbies', emoji: '⚽' }),
  Object.freeze({ id: 'jobs', name: 'Jobs', emoji: '🧑‍🔧' }),
  Object.freeze({ id: 'space', name: 'Space & science', emoji: '🔭' }),
  Object.freeze({ id: 'music', name: 'Music', emoji: '🎵' }),
  Object.freeze({ id: 'weather', name: 'Weather & seasons', emoji: '⛅' }),
  Object.freeze({ id: 'fantasy', name: 'Fantasy', emoji: '🐉' }),
]);

const LISTS = {
  animals: [
    'elephant', 'giraffe', 'penguin', 'dolphin', 'kangaroo', 'octopus', 'squirrel', 'hedgehog', 'flamingo', 'cheetah',
    'gorilla', 'hamster', 'panther', 'leopard', 'buffalo', 'camel', 'donkey', 'falcon', 'gazelle', 'iguana',
    'jaguar', 'koala', 'lobster', 'meerkat', 'narwhal', 'ostrich', 'parrot', 'raccoon', 'salmon', 'tortoise',
    'walrus', 'zebra', 'beaver', 'badger', 'chipmunk', 'ferret', 'otter', 'pelican', 'reindeer', 'seahorse',
  ],
  food: [
    'pancake', 'waffle', 'spaghetti', 'burrito', 'sandwich', 'pretzel', 'popcorn', 'cupcake', 'muffin', 'noodles',
    'pizza', 'avocado', 'broccoli', 'cucumber', 'pumpkin', 'tomato', 'pineapple', 'blueberry', 'raspberry', 'strawberry',
    'watermelon', 'coconut', 'cinnamon', 'pudding', 'omelette', 'lasagna', 'dumpling', 'biscuit', 'crumpet', 'cheddar',
    'yogurt', 'granola', 'pickle', 'sausage', 'meatball', 'tortilla', 'smoothie', 'lemonade', 'marshmallow', 'butter',
  ],
  places: [
    'volcano', 'glacier', 'canyon', 'desert', 'jungle', 'meadow', 'island', 'lagoon', 'prairie', 'tundra',
    'waterfall', 'river', 'mountain', 'valley', 'forest', 'beach', 'harbor', 'village', 'castle', 'lighthouse',
    'library', 'museum', 'airport', 'stadium', 'bakery', 'market', 'garden', 'orchard', 'cavern', 'pyramid',
    'swamp', 'oasis', 'geyser', 'reef', 'cliff', 'hillside', 'riverbank', 'bridge', 'tower', 'palace',
  ],
  things: [
    'umbrella', 'backpack', 'scissors', 'blanket', 'compass', 'lantern', 'teapot', 'keyboard', 'mirror', 'pillow',
    'ladder', 'hammer', 'bucket', 'candle', 'basket', 'bottle', 'camera', 'envelope', 'helmet', 'jigsaw',
    'kettle', 'magnet', 'necklace', 'paintbrush', 'pencil', 'quilt', 'sandal', 'suitcase', 'toothbrush', 'whistle',
    'wallet', 'zipper', 'button', 'calendar', 'notebook', 'sponge', 'stapler', 'doorbell', 'teaspoon', 'flashlight',
  ],
  sports: [
    'football', 'baseball', 'basketball', 'volleyball', 'tennis', 'hockey', 'cricket', 'skating', 'surfing', 'swimming',
    'cycling', 'archery', 'bowling', 'fencing', 'karate', 'climbing', 'camping', 'fishing', 'gardening', 'knitting',
    'painting', 'dancing', 'juggling', 'skiing', 'snowboard', 'rowing', 'sailing', 'golf', 'badminton', 'marathon',
    'trampoline', 'chess', 'puzzle', 'origami', 'pottery', 'baking', 'hiking', 'skateboard', 'frisbee', 'kayaking',
  ],
  jobs: [
    'teacher', 'doctor', 'farmer', 'baker', 'pilot', 'dentist', 'plumber', 'chef', 'painter', 'firefighter',
    'astronaut', 'scientist', 'librarian', 'mechanic', 'florist', 'gardener', 'engineer', 'architect', 'lifeguard', 'musician',
    'photographer', 'carpenter', 'tailor', 'nurse', 'veterinarian', 'sailor', 'detective', 'journalist', 'cashier', 'barber',
    'waiter', 'jeweler', 'director', 'magician', 'inventor', 'zookeeper', 'electrician', 'programmer', 'referee', 'mayor',
  ],
  space: [
    'planet', 'comet', 'galaxy', 'asteroid', 'meteor', 'nebula', 'orbit', 'gravity', 'rocket', 'satellite',
    'telescope', 'eclipse', 'universe', 'crater', 'jupiter', 'saturn', 'mercury', 'neptune', 'venus', 'molecule',
    'electron', 'fossil', 'crystal', 'battery', 'circuit', 'laser', 'microscope', 'experiment', 'energy', 'oxygen',
    'hydrogen', 'element', 'robot', 'dinosaur', 'skeleton', 'magnifier', 'spaceship', 'starlight', 'moonbeam', 'atom',
  ],
  music: [
    'guitar', 'piano', 'violin', 'trumpet', 'drums', 'flute', 'cello', 'harp', 'banjo', 'clarinet',
    'trombone', 'ukulele', 'xylophone', 'tambourine', 'accordion', 'saxophone', 'harmonica', 'melody', 'rhythm', 'chorus',
    'concert', 'orchestra', 'band', 'singer', 'microphone', 'tuba', 'bagpipes', 'maraca', 'triangle', 'cymbal',
    'lullaby', 'anthem', 'ballad', 'tempo', 'encore', 'rehearsal', 'festival', 'karaoke', 'opera', 'conductor',
  ],
  weather: [
    'sunshine', 'thunder', 'lightning', 'blizzard', 'tornado', 'hurricane', 'drizzle', 'rainbow', 'snowflake', 'icicle',
    'breeze', 'cloudy', 'foggy', 'frosty', 'hailstone', 'monsoon', 'puddle', 'autumn', 'winter', 'spring',
    'summer', 'forecast', 'heatwave', 'sleet', 'avalanche', 'cyclone', 'dewdrop', 'mist', 'rainstorm', 'snowman',
    'sunrise', 'sunset', 'temperature', 'climate', 'thermometer', 'humidity', 'windy', 'chilly', 'rainy', 'raincoat',
  ],
  fantasy: [
    'dragon', 'wizard', 'unicorn', 'mermaid', 'knight', 'princess', 'goblin', 'giant', 'fairy', 'potion',
    'treasure', 'pirate', 'dungeon', 'sorcerer', 'phoenix', 'griffin', 'troll', 'elf', 'kingdom', 'quest',
    'legend', 'riddle', 'crown', 'sword', 'shield', 'spell', 'cauldron', 'wand', 'ogre', 'centaur',
    'pegasus', 'enchanted', 'villain', 'hero', 'adventure', 'scroll', 'labyrinth', 'beanstalk', 'gnome', 'throne',
  ],
};

function build() {
  const out = [];
  const seen = new Set();
  for (const c of CATEGORIES) {
    for (const raw of LISTS[c.id] || []) {
      const w = String(raw).toLowerCase();
      if (!/^[a-z]{3,14}$/.test(w) || seen.has(w)) continue;
      seen.add(w);
      out.push(Object.freeze({ id: out.length, w, cat: c.id }));
    }
  }
  return Object.freeze(out);
}

export const WORDS = build();

export function wordById(id) {
  return Number.isInteger(id) && id >= 0 && id < WORDS.length ? WORDS[id] : null;
}

export function wordsIn(cat) {
  return WORDS.filter((x) => x.cat === cat);
}

export function categoryById(id) {
  return CATEGORIES.find((c) => c.id === id) || null;
}
