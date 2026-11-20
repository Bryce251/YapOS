import { analyze } from './beat-analyze.js';

const scope = typeof WorkerGlobalScope === 'function' && typeof self === 'object' && self instanceof WorkerGlobalScope ? self : null;

export function handleAnalyzeMessage(data, post) {
  const d = data && typeof data === 'object' ? data : {};
  try {
    if (!(d.pcm instanceof Float32Array) || !d.pcm.length) throw new Error('empty');
    let last = -1;
    const analysis = analyze(d.pcm, d.sr || 22050, {
      onProgress: (p) => {
        const step = Math.floor(p * 50);
        if (step === last) return;
        last = step;
        post({ id: d.id, type: 'progress', p });
      },
    });
    post({ id: d.id, type: 'done', analysis });
  } catch {
    post({ id: d.id, type: 'error', message: 'This song could not be read. Try an MP3.' });
  }
}

if (scope) scope.addEventListener('message', (e) => handleAnalyzeMessage(e.data, (msg) => scope.postMessage(msg)));
