// Persistence for the in-progress image-import job, so a refresh / crash
// doesn't lose the remaining pixels of a half-placed upload.
//
// We store the original decoded source image as a PNG dataURL alongside the
// full pipeline config + running `placed` count. On resume the caller re-runs
// the same transform → resize → palette pipeline and the uploader continues
// from the saved `placed` offset.
//
// Storage: localStorage (single key). Heavy images may overflow the 5-10MB
// quota; we catch QuotaExceededError and degrade to "save disabled" rather
// than crash.

const KEY = 'rplace:image-job:v1';

/**
 * Serialize an ImageData-style source (RGBA Uint8ClampedArray + dims) to a
 * PNG dataURL via OffscreenCanvas. Returns null on failure.
 * @param {Uint8ClampedArray} srcRgba
 * @param {number} width
 * @param {number} height
 * @returns {Promise<string|null>}
 */
export async function rgbaToDataUrl(srcRgba, width, height) {
  try {
    const oc = new OffscreenCanvas(width, height);
    const ctx = oc.getContext('2d');
    ctx.putImageData(new ImageData(new Uint8ClampedArray(srcRgba), width, height), 0, 0);
    const blob = await oc.convertToBlob({ type: 'image/png' });
    return await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

/**
 * Decode a PNG dataURL back into { rgba, width, height }. Returns null on failure.
 * @param {string} dataUrl
 */
export async function dataUrlToRgba(dataUrl) {
  try {
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    const oc = new OffscreenCanvas(w, h);
    const ctx = oc.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, w, h);
    return { rgba: data, width: w, height: h };
  } catch {
    return null;
  }
}

/**
 * Persist the full job record. Returns true on success, false on quota/other error.
 * @param {object} job
 */
export function saveJob(job) {
  try {
    localStorage.setItem(KEY, JSON.stringify(job));
    return true;
  } catch {
    return false;
  }
}

/** Read the stored job, or null if none / corrupt. */
export function loadJob() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Update just the `placed` counter without re-serializing the image. */
export function updateJobProgress(placed) {
  try {
    const job = loadJob();
    if (!job) return;
    job.placed = placed;
    job.updatedAt = Date.now();
    localStorage.setItem(KEY, JSON.stringify(job));
  } catch { /* quota etc. — ignore, user will just lose resume checkpoint */ }
}

export function clearJob() {
  try { localStorage.removeItem(KEY); } catch { /* no-op */ }
}
