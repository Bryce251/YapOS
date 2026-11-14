export const IDEAS = Object.freeze([
  'A food you love or refuse to eat',
  'The strangest place you have fallen asleep',
  'A talent nobody would guess you have',
  'Your very first pet, or the pet you wanted',
  'A place you have visited',
  'Something you collected as a kid',
  'A game you are secretly great at',
  'A snack you could eat every day',
  'A time you got hopelessly lost',
  'A hobby you tried once and gave up',
  'The weirdest thing in your room right now',
  'A sport you played or almost played',
  'Something you are scared of',
  'A famous landmark you have seen in person',
  'A skill you learned from a video',
  'A dream job you had as a kid',
  'An instrument you can or cannot play',
  'Your go-to karaoke style',
  'A small accident that turned out funny',
  'A record you hold in your friend group',
  'The longest you have stayed awake',
  'Something you built or made yourself',
  'A wild thing a pet of yours did',
  'A food you cooked that went badly',
  'The number of countries you have been to',
  'Something you won',
  'A movie you have watched way too many times',
  'A nickname someone gave you',
  'An animal you have touched or held',
  'A weird habit you have',
  'The most unusual job you have done',
  'A sport or game you invented',
  'Something you can do with your eyes closed',
  'Your favourite weather',
  'A thing you broke by accident',
  'A language you can say a few words in',
  'A season you love or dislike',
  'Something brave you did',
  'An award or badge you got at school',
  'A fun fact about your name',
]);

export const SAMPLES = Object.freeze([
  ['I have been to three different countries', 'I can juggle four oranges', 'I once ate a whole pizza by myself'],
  ['I have a pet lizard named Toast', 'I learned to swim when I was ten', 'I can whistle with my fingers'],
  ['I was born during a snowstorm', 'I have never seen a horror movie', 'I can solve a puzzle cube'],
  ['I once won a spelling contest', 'I am scared of butterflies', 'I have climbed a real mountain'],
  ['I can name every planet backwards', 'I once fell asleep at a birthday party', 'I have met a penguin up close'],
  ['I sleep with two pillows on my feet', 'I can type without looking', 'I grew a pumpkin bigger than my head'],
]);

export function ideaAt(n) {
  const i = Math.abs(Math.floor(Number(n) || 0)) % IDEAS.length;
  return IDEAS[i];
}

export function sampleAt(n) {
  const i = Math.abs(Math.floor(Number(n) || 0)) % SAMPLES.length;
  return SAMPLES[i];
}
