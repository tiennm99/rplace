import { transformRgba } from './image-transform.js';
import { resizeRgba } from './image-resize.js';
import { applyColorCorrection } from './image-color-correction.js';
import { rgbaToPalette } from './image-to-palette.js';

/**
 * Staged image pipeline: transform → resize → color-correction → quantize.
 *
 * Each stage holds a single cached slot keyed by the inputs it depends on,
 * so changing only one slider (e.g. brightness) reuses T and R and only
 * reruns C and Q.
 *
 * Q (quantize) is intentionally *not* cached — we transfer its buffer to
 * the main thread (detaches it), and the quantize pass is already the
 * cheapest stage to redo on a cache miss.
 *
 * Typical usage:
 *   const p = createPipeline();
 *   p.setSource(rgba, w, h);
 *   const { indices, width, height } = p.run(params);
 */
export function createPipeline() {
  let src = null;
  const slots = { T: null, R: null, C: null };

  function useStage(name, key, build) {
    const s = slots[name];
    if (s && s.key === key) return s.data;
    const data = build();
    slots[name] = { key, data };
    return data;
  }

  return {
    setSource(buf, width, height) {
      src = { buf, width, height };
      slots.T = slots.R = slots.C = null;
    },
    hasSource() { return src !== null; },
    source() { return src; },

    /**
     * @param {{
     *   flipH: boolean, flipV: boolean, rotation: 0|90|180|270,
     *   resizeW: number, resizeH: number, resampleMethod: 'nearest'|'bilinear'|'box',
     *   brightness: number, contrast: number, saturation: number, gamma: number,
     *   ditherMethod: string, skipWhite: boolean, whiteThreshold: number, paintTransparent: boolean,
     * }} params
     * @returns {{ indices: Int16Array, width: number, height: number }}
     */
    run(params) {
      if (!src) throw new Error('Pipeline: no source set.');
      const {
        flipH, flipV, rotation,
        resizeW, resizeH, resampleMethod,
        brightness, contrast, saturation, gamma,
        ditherMethod, skipWhite, whiteThreshold, paintTransparent,
      } = params;

      const kT = `${flipH ? 1 : 0}|${flipV ? 1 : 0}|${rotation}`;
      const kR = `${kT}|${resizeW}|${resizeH}|${resampleMethod}`;
      const kC = `${kR}|${brightness}|${contrast}|${saturation}|${gamma}`;

      const T = useStage('T', kT, () => {
        if (!flipH && !flipV && rotation === 0) {
          return { rgba: src.buf, width: src.width, height: src.height };
        }
        return transformRgba(src.buf, src.width, src.height, { flipH, flipV, rotation });
      });

      const R = useStage('R', kR, () => {
        if (resizeW === T.width && resizeH === T.height) {
          return { rgba: T.rgba, width: T.width, height: T.height };
        }
        const buf = resizeRgba(T.rgba, T.width, T.height, resizeW, resizeH, resampleMethod);
        return { rgba: buf, width: resizeW, height: resizeH };
      });

      const C = useStage('C', kC, () => {
        if (brightness === 0 && contrast === 0 && saturation === 0 && gamma === 1) {
          return { rgba: R.rgba, width: R.width, height: R.height };
        }
        const buf = applyColorCorrection(R.rgba, R.width, R.height, { brightness, contrast, saturation, gamma });
        return { rgba: buf, width: R.width, height: R.height };
      });

      const indices = rgbaToPalette(C.rgba, C.width, C.height, {
        method: ditherMethod, skipWhite, whiteThreshold, paintTransparent,
      });
      return { indices, width: C.width, height: C.height };
    },
  };
}
