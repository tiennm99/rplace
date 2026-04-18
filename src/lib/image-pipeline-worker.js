import { createPipeline } from './image-pipeline.js';
import { paletteToRgba } from './image-to-palette.js';

// Staged pipeline, lives for the worker's lifetime.
const pipeline = createPipeline();

self.onmessage = (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'set-source') {
      const buf = new Uint8ClampedArray(msg.buffer);
      pipeline.setSource(buf, msg.width, msg.height);
      self.postMessage({ type: 'ack', id: msg.id });
      return;
    }
    if (msg.type === 'run') {
      if (!pipeline.hasSource()) {
        self.postMessage({ type: 'error', id: msg.id, error: 'No source set.' });
        return;
      }
      const { indices, width, height } = pipeline.run(msg.params);
      // Preview RGBA is rebuilt here (cheap) so the main thread can render
      // without another pass over the palette.
      const preview = paletteToRgba(indices, width, height);
      self.postMessage({
        type: 'result',
        id: msg.id,
        quick: !!msg.quick,
        width, height,
        indices: indices.buffer,
        preview: preview.buffer,
      }, [indices.buffer, preview.buffer]);
      return;
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: msg.id, error: String(err?.message || err) });
  }
};
