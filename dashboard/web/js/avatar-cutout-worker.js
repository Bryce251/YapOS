import { cutOut } from './avatar-cutout.js';

const scope = typeof WorkerGlobalScope === 'function' && typeof self === 'object' && self instanceof WorkerGlobalScope ? self : null;

export function handleCutMessage(data, post) {
  const d = data && typeof data === 'object' ? data : {};
  try {
    const out = cutOut(new Uint8ClampedArray(d.data), d.width, d.height, d.options || {});
    post({ id: d.id, ok: true, out }, [out.rgba.buffer]);
  } catch (err) {
    post({ id: d.id, ok: false, message: err instanceof Error ? err.message : 'Cut-out failed.' });
  }
}

if (scope) scope.addEventListener('message', (e) => handleCutMessage(e.data, (msg, transfer) => scope.postMessage(msg, transfer || [])));
