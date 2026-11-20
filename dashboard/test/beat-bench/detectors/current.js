import { detect } from '../../../web/js/beat-analyze.js';

export const name = 'beat-analyze.js (shipped)';

export function analyze(mono, sampleRate) {
  return detect(mono, sampleRate);
}
