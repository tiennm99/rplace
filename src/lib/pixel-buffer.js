import { CANVAS_WIDTH } from './constants.js';

/** Pack (x,y) into a single integer key. CANVAS_WIDTH ≤ 65535 invariant. */
function keyOf(x, y) { return y * 65536 + x; }
function xOf(key) { return key % 65536; }
function yOf(key) { return Math.floor(key / 65536); }

/**
 * Manages pending pixel strokes with undo/redo support.
 * Pixels accumulate locally until explicit submit.
 * Maintains a Map<key,color> cache of last-write-wins state across all strokes —
 * O(1) getColorAt / pixelCount, rebuilt only on stroke add/undo/redo/clear.
 */
export function createPixelBuffer() {
  if (CANVAS_WIDTH > 65535) {
    throw new Error(`pixel-buffer key encoding requires CANVAS_WIDTH <= 65535, got ${CANVAS_WIDTH}`);
  }

  let strokes = [];
  let undone = [];
  let cache = null; // Map<key, color> | null (null = needs rebuild)

  function rebuild() {
    cache = new Map();
    for (const stroke of strokes) {
      for (const { x, y, color } of stroke) {
        cache.set(keyOf(x, y), color);
      }
    }
  }

  function ensureCache() {
    if (cache === null) rebuild();
    return cache;
  }

  return {
    addStroke(pixels) {
      if (!pixels.length) return;
      strokes.push([...pixels]);
      undone = [];
      cache = null;
    },

    undo() {
      if (!strokes.length) return null;
      const stroke = strokes.pop();
      undone.push(stroke);
      cache = null;
      return stroke;
    },

    redo() {
      if (!undone.length) return null;
      const stroke = undone.pop();
      strokes.push(stroke);
      cache = null;
      return stroke;
    },

    clear() {
      strokes = [];
      undone = [];
      cache = null;
    },

    /** Deduplicated pending pixels (last stroke wins per coord) */
    getAllPixels() {
      const map = ensureCache();
      const out = [];
      for (const [key, color] of map) {
        out.push({ x: xOf(key), y: yOf(key), color });
      }
      return out;
    },

    /** Get pending color at (x,y), or -1 if not pending */
    getColorAt(x, y) {
      const c = ensureCache().get(keyOf(x, y));
      return c === undefined ? -1 : c;
    },

    /** Set of all affected coordinate keys (y*65536+x) */
    getAffectedKeys() {
      return new Set(ensureCache().keys());
    },

    get canUndo() { return strokes.length > 0; },
    get canRedo() { return undone.length > 0; },
    get pixelCount() { return ensureCache().size; },
  };
}
