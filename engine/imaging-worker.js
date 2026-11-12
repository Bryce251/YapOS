import { parentPort } from 'node:worker_threads';
import { renderGif } from './imaging.js';

parentPort.once('message', async ({ input, job }) => {
  try {
    const result = await renderGif(Buffer.from(input), job);
    const bytes = result.bytes;
    const out = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice();
    parentPort.postMessage({ ok: true, output: out.buffer, frames: result.frames, localPalettes: result.localPalettes, stopped: result.stopped, width: result.width, height: result.height }, [out.buffer]);
  } catch (e) {
    parentPort.postMessage({ ok: false, error: { message: String(e?.message || e), code: e?.code || 'decode' } });
  }
});
