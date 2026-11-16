export const KINDS = Object.freeze([
  Object.freeze({ id: 'nursery', name: 'Nursery rhymes', emoji: '🧸' }),
  Object.freeze({ id: 'folk', name: 'Folk songs', emoji: '🪕' }),
  Object.freeze({ id: 'classical', name: 'Classical', emoji: '🎻' }),
  Object.freeze({ id: 'holiday', name: 'Holiday songs', emoji: '🎄' }),
]);

const NAMES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

export function midiOf(name) {
  const m = /^([A-G])([#b]?)(-?\d)$/.exec(String(name));
  if (!m) return null;
  const shift = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0;
  return 12 * (Number(m[3]) + 1) + NAMES[m[1]] + shift;
}

export function parseNotes(text) {
  const out = [];
  for (const token of String(text).trim().split(/\s+/)) {
    const [name, len] = token.split(':');
    const beats = Number(len);
    if (!(beats > 0)) throw new Error(`Bad note ${token}`);
    if (name === 'R') {
      out.push([0, beats]);
      continue;
    }
    const midi = midiOf(name);
    if (midi === null) throw new Error(`Bad note ${token}`);
    out.push([midi, beats]);
  }
  return out;
}

const ROWS = [
  ['twinkle', 'Twinkle, Twinkle, Little Star', 'nursery', 'Traditional French melody (1761)', 110,
    'C4:1 C4:1 G4:1 G4:1 A4:1 A4:1 G4:2 F4:1 F4:1 E4:1 E4:1 D4:1 D4:1 C4:2 G4:1 G4:1 F4:1 F4:1 E4:1 E4:1 D4:2'],
  ['marylamb', 'Mary Had a Little Lamb', 'nursery', 'Traditional', 120,
    'E4:1 D4:1 C4:1 D4:1 E4:1 E4:1 E4:2 D4:1 D4:1 D4:2 E4:1 G4:1 G4:2 E4:1 D4:1 C4:1 D4:1 E4:1 E4:1 E4:1 E4:1 D4:1 D4:1 E4:1 D4:1 C4:4'],
  ['rowboat', 'Row, Row, Row Your Boat', 'nursery', 'Traditional (1852)', 150,
    'C4:1.5 C4:1.5 C4:1 D4:0.5 E4:1.5 E4:1 D4:0.5 E4:1 F4:0.5 G4:3 C5:0.5 C5:0.5 C5:0.5 G4:0.5 G4:0.5 G4:0.5 E4:0.5 E4:0.5 E4:0.5 C4:0.5 C4:0.5 C4:0.5 G4:1 F4:0.5 E4:1 D4:0.5 C4:3'],
  ['londonbridge', 'London Bridge Is Falling Down', 'nursery', 'Traditional', 120,
    'G4:1.5 A4:0.5 G4:1 F4:1 E4:1 F4:1 G4:2 D4:1 E4:1 F4:2 E4:1 F4:1 G4:2 G4:1.5 A4:0.5 G4:1 F4:1 E4:1 F4:1 G4:2 D4:2 G4:2 E4:1 C4:3'],
  ['oldmacdonald', 'Old MacDonald Had a Farm', 'nursery', 'Traditional', 130,
    'G4:1 G4:1 G4:1 D4:1 E4:1 E4:1 D4:2 B4:1 B4:1 A4:1 A4:1 G4:3 D4:1 G4:1 G4:1 G4:1 D4:1 E4:1 E4:1 D4:2 B4:1 B4:1 A4:1 A4:1 G4:3'],
  ['frerejacques', 'Frère Jacques', 'nursery', 'Traditional French', 120,
    'C4:1 D4:1 E4:1 C4:1 C4:1 D4:1 E4:1 C4:1 E4:1 F4:1 G4:2 E4:1 F4:1 G4:2 G4:0.5 A4:0.5 G4:0.5 F4:0.5 E4:1 C4:1 G4:0.5 A4:0.5 G4:0.5 F4:0.5 E4:1 C4:1 C4:1 G3:1 C4:2 C4:1 G3:1 C4:2'],
  ['hotcrossbuns', 'Hot Cross Buns', 'nursery', 'Traditional', 110,
    'E4:1 D4:1 C4:2 E4:1 D4:1 C4:2 C4:0.5 C4:0.5 C4:0.5 C4:0.5 D4:0.5 D4:0.5 D4:0.5 D4:0.5 E4:1 D4:1 C4:2'],
  ['threeblindmice', 'Three Blind Mice', 'nursery', 'Traditional (1609)', 120,
    'E4:1 D4:1 C4:2 E4:1 D4:1 C4:2 G4:1 F4:0.5 F4:0.5 E4:2 G4:1 F4:0.5 F4:0.5 E4:2'],
  ['thisoldman', 'This Old Man', 'nursery', 'Traditional', 120,
    'G4:1 E4:1 G4:2 G4:1 E4:1 G4:2 A4:1 G4:1 F4:1 E4:1 D4:1 E4:1 F4:2 E4:1 F4:1 G4:1 C4:0.5 C4:0.5 C4:1 C4:0.5 C4:0.5 C4:0.5 D4:0.5 E4:0.5 F4:0.5 G4:2 G4:1 D4:1 D4:1 F4:1 E4:1 D4:1 C4:2'],
  ['birthday', 'Happy Birthday to You', 'folk', 'Traditional, public domain melody (1893)', 100,
    'G4:0.75 G4:0.25 A4:1 G4:1 C5:1 B4:2 G4:0.75 G4:0.25 A4:1 G4:1 D5:1 C5:2 G4:0.75 G4:0.25 G5:1 E5:1 C5:1 B4:1 A4:2 F5:0.75 F5:0.25 E5:1 C5:1 D5:1 C5:2'],
  ['saints', 'When the Saints Go Marching In', 'folk', 'Traditional spiritual', 150,
    'C4:1 E4:1 F4:1 G4:4 C4:1 E4:1 F4:1 G4:4 C4:1 E4:1 F4:1 G4:2 E4:2 C4:2 E4:2 D4:4 R:1 E4:1 E4:1 D4:1 C4:3 C4:1 E4:2 G4:2 G4:1 F4:3'],
  ['greensleeves', 'Greensleeves', 'folk', 'Traditional English (16th century)', 140,
    'A4:1 C5:2 D5:1 E5:1.5 F5:0.5 E5:1 D5:2 B4:1 G4:1.5 A4:0.5 B4:1 C5:2 A4:1 A4:1.5 G#4:0.5 A4:1 B4:2 G#4:1 E4:2 A4:1 C5:2 D5:1 E5:1.5 F5:0.5 E5:1 D5:2 B4:1 G4:1.5 A4:0.5 B4:1 C5:1.5 B4:0.5 A4:1 G#4:1.5 F#4:0.5 G#4:1 A4:3'],
  ['amazinggrace', 'Amazing Grace', 'folk', 'Traditional hymn tune "New Britain" (1829)', 90,
    'D4:1 G4:2 B4:0.5 G4:0.5 B4:2 A4:1 G4:2 E4:1 D4:2 D4:1 G4:2 B4:0.5 G4:0.5 B4:2 A4:1 D5:3'],
  ['auldlangsyne', 'Auld Lang Syne', 'folk', 'Traditional Scottish', 100,
    'C4:1 F4:1.5 F4:0.5 F4:1 A4:1 G4:1.5 F4:0.5 G4:1 A4:0.5 G4:0.5 F4:1.5 F4:0.5 A4:1 C5:1 D5:3 D5:1 C5:1.5 A4:0.5 A4:1 F4:1 G4:1.5 F4:0.5 G4:1 A4:0.5 G4:0.5 F4:1.5 D4:0.5 D4:1 C4:1 F4:3'],
  ['yankeedoodle', 'Yankee Doodle', 'folk', 'Traditional American', 120,
    'C4:0.5 C4:0.5 D4:0.5 E4:0.5 C4:0.5 E4:0.5 D4:0.5 G3:0.5 C4:0.5 C4:0.5 D4:0.5 E4:0.5 C4:1 B3:1 C4:0.5 C4:0.5 D4:0.5 E4:0.5 F4:0.5 E4:0.5 D4:0.5 C4:0.5 B3:0.5 G3:0.5 A3:0.5 B3:0.5 C4:1 C4:1'],
  ['ohsusanna', 'Oh! Susanna', 'folk', 'Stephen Foster (1826–1864)', 130,
    'C4:0.5 D4:0.5 E4:1 G4:1 G4:1.5 A4:0.5 G4:1 E4:1 C4:1.5 D4:0.5 E4:1 E4:1 D4:1 C4:1 D4:3 C4:0.5 D4:0.5 E4:1 G4:1 G4:1.5 A4:0.5 G4:1 E4:1 C4:1.5 D4:0.5 E4:1 E4:1 D4:1 D4:1 C4:3'],
  ['sakura', 'Sakura Sakura', 'folk', 'Traditional Japanese', 80,
    'A4:1 A4:1 B4:2 A4:1 A4:1 B4:2 A4:1 B4:1 C5:1 B4:1 A4:1 B4:0.5 A4:0.5 F4:2 E4:1 C4:1 E4:1 F4:1 E4:1 E4:0.5 C4:0.5 B3:2'],
  ['korobeiniki', 'Korobeiniki', 'folk', 'Traditional Russian', 140,
    'E5:1 B4:0.5 C5:0.5 D5:1 C5:0.5 B4:0.5 A4:1 A4:0.5 C5:0.5 E5:1 D5:0.5 C5:0.5 B4:1.5 C5:0.5 D5:1 E5:1 C5:1 A4:1 A4:2 R:0.5 D5:1 F5:0.5 A5:1 G5:0.5 F5:0.5 E5:1.5 C5:0.5 E5:1 D5:0.5 C5:0.5 B4:1 B4:0.5 C5:0.5 D5:1 E5:1 C5:1 A4:1 A4:2'],
  ['odetojoy', 'Ode to Joy', 'classical', 'Ludwig van Beethoven (1770–1827)', 120,
    'E4:1 E4:1 F4:1 G4:1 G4:1 F4:1 E4:1 D4:1 C4:1 C4:1 D4:1 E4:1 E4:1.5 D4:0.5 D4:2 E4:1 E4:1 F4:1 G4:1 G4:1 F4:1 E4:1 D4:1 C4:1 C4:1 D4:1 E4:1 D4:1.5 C4:0.5 C4:2'],
  ['furelise', 'Für Elise', 'classical', 'Ludwig van Beethoven (1770–1827)', 130,
    'E5:0.5 D#5:0.5 E5:0.5 D#5:0.5 E5:0.5 B4:0.5 D5:0.5 C5:0.5 A4:1.5 C4:0.5 E4:0.5 A4:0.5 B4:1.5 E4:0.5 G#4:0.5 B4:0.5 C5:1.5 E4:0.5 E5:0.5 D#5:0.5 E5:0.5 D#5:0.5 E5:0.5 B4:0.5 D5:0.5 C5:0.5 A4:1.5'],
  ['beethoven5', 'Symphony No. 5', 'classical', 'Ludwig van Beethoven (1770–1827)', 108,
    'R:0.5 G4:0.5 G4:0.5 G4:0.5 D#4:4 R:0.5 F4:0.5 F4:0.5 F4:0.5 D4:4'],
  ['nachtmusik', 'Eine kleine Nachtmusik', 'classical', 'Wolfgang Amadeus Mozart (1756–1791)', 130,
    'G4:1 R:0.5 D4:0.5 G4:1 R:0.5 D4:0.5 G4:0.5 D4:0.5 G4:0.5 B4:0.5 D5:2 C5:1 R:0.5 A4:0.5 C5:1 R:0.5 A4:0.5 C5:0.5 A4:0.5 F#4:0.5 A4:0.5 D4:2'],
  ['turkishmarch', 'Turkish March', 'classical', 'Wolfgang Amadeus Mozart (1756–1791)', 120,
    'B4:0.25 A4:0.25 G#4:0.25 A4:0.25 C5:1 D5:0.25 C5:0.25 B4:0.25 C5:0.25 E5:1 F5:0.25 E5:0.25 D#5:0.25 E5:0.25 B5:0.25 A5:0.25 G#5:0.25 A5:0.25 B5:0.25 A5:0.25 G#5:0.25 A5:0.25 C6:2'],
  ['symphony40', 'Symphony No. 40', 'classical', 'Wolfgang Amadeus Mozart (1756–1791)', 110,
    'D#5:0.5 D5:0.5 D5:1 D#5:0.5 D5:0.5 D5:1 D#5:0.5 D5:0.5 D5:1 A#5:1 R:0.5 A#5:0.5 A5:0.5 G5:0.5 G5:1 F5:0.5 D#5:0.5 D#5:1 D5:0.5 C5:0.5 C5:1'],
  ['mountainking', 'In the Hall of the Mountain King', 'classical', 'Edvard Grieg (1843–1907)', 120,
    'B3:0.5 C#4:0.5 D4:0.5 E4:0.5 F#4:0.5 D4:0.5 F#4:1 F4:0.5 C#4:0.5 F4:1 E4:0.5 C4:0.5 E4:1 B3:0.5 C#4:0.5 D4:0.5 E4:0.5 F#4:0.5 D4:0.5 F#4:0.5 B4:0.5 A4:0.5 F#4:0.5 D4:0.5 F#4:0.5 A4:2'],
  ['morningmood', 'Morning Mood', 'classical', 'Edvard Grieg (1843–1907)', 100,
    'G4:1 E4:0.5 D4:0.5 C4:0.5 D4:0.5 E4:0.5 G4:0.5 E4:0.5 D4:0.5 C4:0.5 D4:0.5 E4:0.25 D4:0.25 E4:0.5 G4:0.5 E4:0.5 G4:0.5 A4:0.5 E4:0.5 A4:0.5 G4:0.5 E4:0.5 D4:0.5 C4:3'],
  ['canon', 'Canon in D', 'classical', 'Johann Pachelbel (1653–1706)', 90,
    'F#5:2 E5:2 D5:2 C#5:2 B4:2 A4:2 B4:2 C#5:2 D5:2 C#5:2 B4:2 A4:2 G4:2 F#4:2 G4:2 E4:2'],
  ['brahmslullaby', 'Lullaby (Wiegenlied)', 'classical', 'Johannes Brahms (1833–1897)', 110,
    'E4:0.5 E4:0.5 G4:2 E4:0.5 E4:0.5 G4:2 E4:0.5 G4:0.5 C5:1 B4:1.5 A4:0.5 A4:1 G4:1 D4:0.5 E4:0.5 F4:1 D4:1 D4:0.5 E4:0.5 F4:2 D4:0.5 F4:0.5 B4:0.5 A4:0.5 G4:1 B4:1 C5:3'],
  ['bridalchorus', 'Bridal Chorus (Here Comes the Bride)', 'classical', 'Richard Wagner (1813–1883)', 70,
    'C4:1 F4:0.75 F4:0.25 F4:2 C4:1 G4:0.75 E4:0.25 F4:2 C4:1 F4:0.75 A#4:0.25 A#4:1 A4:0.75 G4:0.25 F4:1 E4:0.75 F4:0.25 G4:2'],
  ['cancan', 'Can-Can (Infernal Galop)', 'classical', 'Jacques Offenbach (1819–1880)', 140,
    'C4:1 D4:0.5 F4:0.5 E4:0.5 D4:0.5 G4:1 G4:1 G4:0.5 A4:0.5 E4:0.5 F4:0.5 D4:1 D4:1 D4:0.5 F4:0.5 E4:0.5 D4:0.5 C4:0.5 C5:0.5 B4:0.5 A4:0.5 G4:0.5 F4:0.5 E4:0.5 D4:0.5 C4:1'],
  ['bluedanube', 'The Blue Danube', 'classical', 'Johann Strauss II (1825–1899)', 150,
    'D4:1 D4:1 F#4:1 A4:1 A4:2 R:1 A5:1 A5:1 R:1 F#5:1 F#5:1 R:1 D4:1 D4:1 F#4:1 A4:1 A4:2 R:1 A5:1 A5:1 R:1 G5:1 G5:1'],
  ['minuetg', 'Minuet in G', 'classical', 'Christian Petzold (1677–1733)', 120,
    'D5:1 G4:0.5 A4:0.5 B4:0.5 C5:0.5 D5:1 G4:1 G4:1 E5:1 C5:0.5 D5:0.5 E5:0.5 F#5:0.5 G5:1 G4:1 G4:1 C5:1 D5:0.5 C5:0.5 B4:0.5 A4:0.5 B4:1 C5:0.5 B4:0.5 A4:0.5 G4:0.5 F#4:1 G4:0.5 A4:0.5 B4:0.5 G4:0.5 A4:3'],
  ['toccata', 'Toccata and Fugue in D Minor', 'classical', 'Johann Sebastian Bach (1685–1750)', 60,
    'A5:0.25 G5:0.25 A5:2.5 G5:0.25 F5:0.25 E5:0.25 D5:0.25 C#5:1 D5:2.5 R:1 A4:0.25 G4:0.25 A4:2.5 E4:0.5 F4:0.5 C#4:0.5 D4:2.5'],
  ['entertainer', 'The Entertainer', 'classical', 'Scott Joplin (c. 1868–1917)', 90,
    'D4:0.25 D#4:0.25 E4:0.25 C5:0.5 E4:0.25 C5:0.5 E4:0.25 C5:1.25 C5:0.25 D5:0.25 D#5:0.25 E5:0.25 C5:0.25 D5:0.25 E5:0.5 B4:0.25 D5:0.5 C5:1.5'],
  ['jinglebells', 'Jingle Bells', 'holiday', 'James Lord Pierpont (1822–1893)', 140,
    'E4:1 E4:1 E4:2 E4:1 E4:1 E4:2 E4:1 G4:1 C4:1.5 D4:0.5 E4:4 F4:1 F4:1 F4:1.5 F4:0.5 F4:1 E4:1 E4:1 E4:0.5 E4:0.5 E4:1 D4:1 D4:1 E4:1 D4:2 G4:2'],
  ['silentnight', 'Silent Night', 'holiday', 'Franz Xaver Gruber (1787–1863)', 100,
    'G4:1.5 A4:0.5 G4:1 E4:3 G4:1.5 A4:0.5 G4:1 E4:3 D5:2 D5:1 B4:3 C5:2 C5:1 G4:3 A4:2 A4:1 C5:1.5 B4:0.5 A4:1 G4:1.5 A4:0.5 G4:1 E4:3'],
  ['ochristmastree', 'O Christmas Tree', 'holiday', 'Traditional German', 90,
    'D4:1 G4:0.75 G4:0.25 G4:1.5 A4:0.5 B4:0.75 B4:0.25 B4:1.5 B4:0.5 A4:0.5 B4:0.5 C5:1 F#4:1 A4:1 G4:1'],
  ['deckthehalls', 'Deck the Halls', 'holiday', 'Traditional Welsh', 120,
    'C5:1.5 A#4:0.5 A4:1 G4:1 F4:1 G4:1 A4:1 F4:1 G4:0.5 A4:0.5 A#4:0.5 G4:0.5 A4:1.5 G4:0.5 F4:1 E4:1 F4:2'],
  ['wewishyou', 'We Wish You a Merry Christmas', 'holiday', 'Traditional English', 130,
    'D4:1 G4:1 G4:0.5 A4:0.5 G4:0.5 F#4:0.5 E4:1 E4:1 E4:1 A4:1 A4:0.5 B4:0.5 A4:0.5 G4:0.5 F#4:1 D4:1 D4:1 B4:1 B4:0.5 C5:0.5 B4:0.5 A4:0.5 G4:1 E4:1 D4:0.5 D4:0.5 E4:1 A4:1 F#4:1 G4:2'],
  ['joytotheworld', 'Joy to the World', 'holiday', 'Arranged by Lowell Mason (1792–1872)', 100,
    'D5:1 C#5:0.75 B4:0.25 A4:1.5 G4:0.5 F#4:1 E4:1 D4:1.5 A4:0.5 B4:1.5 B4:0.5 C#5:1.5 C#5:0.5 D5:3'],
  ['godrestye', 'God Rest Ye Merry, Gentlemen', 'holiday', 'Traditional English', 130,
    'E4:1 E4:1 B4:1 B4:1 A4:1 G4:1 F#4:1 E4:1 D4:1 E4:1 F#4:1 G4:1 A4:1 B4:3'],
  ['harkherald', 'Hark! The Herald Angels Sing', 'holiday', 'Felix Mendelssohn (1809–1847)', 110,
    'D4:1 G4:1 G4:1.5 F#4:0.5 G4:1 B4:1 B4:1 A4:1 D5:1 D5:1 D5:1.5 C5:0.5 B4:1 A4:1 B4:2'],
  ['ocomeall', 'O Come, All Ye Faithful', 'holiday', 'John Francis Wade (1711–1786)', 100,
    'G4:1 G4:2 D4:1 G4:1 A4:2 D4:2 B4:1 A4:1 B4:1 C5:1 B4:2 A4:1 G4:1 G4:2'],
  ['goodkingwenceslas', 'Good King Wenceslas', 'holiday', 'Traditional (1582)', 120,
    'G4:1 G4:1 G4:1 A4:1 G4:1 G4:1 D4:2 E4:1 D4:1 E4:1 F#4:1 G4:2 G4:2'],
];

export const TUNES = Object.freeze(
  ROWS.map(([key, title, kind, by, bpm, notes], i) => Object.freeze({ id: i + 1, key, title, kind, by, bpm, notes: Object.freeze(parseNotes(notes).map((n) => Object.freeze(n))) })),
);

const BY_ID = new Map(TUNES.map((t) => [t.id, t]));

export function tuneById(id) {
  return BY_ID.get(id) || null;
}

export function tunesIn(kind) {
  return TUNES.filter((t) => t.kind === kind);
}
