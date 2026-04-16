/**
 * Manages pending pixel strokes with undo/redo support.
 * Pixels accumulate locally until explicit submit.
 */
export function createPixelBuffer() {
  let strokes = [];
  let undone = [];

  return {
    /** Add a completed stroke (array of {x, y, color}) */
    addStroke(pixels) {
      if (!pixels.length) return;
      strokes.push([...pixels]);
      undone = [];
    },

    /** Remove last stroke and push to redo stack */
    undo() {
      if (!strokes.length) return null;
      const stroke = strokes.pop();
      undone.push(stroke);
      return stroke;
    },

    /** Re-apply last undone stroke */
    redo() {
      if (!undone.length) return null;
      const stroke = undone.pop();
      strokes.push(stroke);
      return stroke;
    },

    /** Clear all pending strokes and redo history */
    clear() {
      strokes = [];
      undone = [];
    },

    /** Deduplicated pending pixels (last stroke wins per coord) */
    getAllPixels() {
      const map = new Map();
      for (const stroke of strokes) {
        for (const { x, y, color } of stroke) {
          map.set(y * 65536 + x, { x, y, color });
        }
      }
      return [...map.values()];
    },

    /** Get pending color at (x,y), or -1 if not pending */
    getColorAt(x, y) {
      for (let i = strokes.length - 1; i >= 0; i--) {
        for (const p of strokes[i]) {
          if (p.x === x && p.y === y) return p.color;
        }
      }
      return -1;
    },

    /** Set of all affected coordinate keys (y*65536+x) */
    getAffectedKeys() {
      const set = new Set();
      for (const stroke of strokes) {
        for (const { x, y } of stroke) set.add(y * 65536 + x);
      }
      return set;
    },

    get canUndo() { return strokes.length > 0; },
    get canRedo() { return undone.length > 0; },
    get pixelCount() {
      const set = new Set();
      for (const stroke of strokes) {
        for (const { x, y } of stroke) set.add(y * 65536 + x);
      }
      return set.size;
    },
  };
}
