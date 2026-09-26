// Nomi italiani degli accordi (Do, Re♭m…), con diesis o bemolli come nell'armatura della
// tonalità: in Re maggiore Fa♯m, non Sol♭m.

const SHARP_NAMES = ['Do', 'Do♯', 'Re', 'Re♯', 'Mi', 'Fa', 'Fa♯', 'Sol', 'Sol♯', 'La', 'La♯', 'Si'];
const FLAT_NAMES = ['Do', 'Re♭', 'Re', 'Mi♭', 'Mi', 'Fa', 'Sol♭', 'Sol', 'La♭', 'La', 'Si♭', 'Si'];

export function usesSharps(key) {
  if (!key) return false;
  const major = key.mode === 'minor' ? (key.tonic + 3) % 12 : key.tonic;
  return [7, 2, 9, 4, 11, 6].includes(major);
}

// label: 0–11 maggiori (Do = 0), 12–23 minori.
export function chordName(label, key) {
  return (usesSharps(key) ? SHARP_NAMES : FLAT_NAMES)[label % 12] + (label < 12 ? '' : 'm');
}
