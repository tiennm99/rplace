#!/usr/bin/env node
/**
 * Convert PNG/JPG/WebP image to rplace palette JSON.
 *
 * Usage:
 *   node scripts/image-to-colors.js <input> [-o output.json] [--alpha-threshold N]
 *
 * Output JSON: { width, height, pixels: number[] }
 *   - pixels is a flat row-major array of length width*height
 *   - each entry is a palette index [0..31], or -1 for transparent (skipped on upload)
 */
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import sharp from 'sharp';
import { CANVAS_WIDTH, CANVAS_HEIGHT } from '../src/lib/constants.js';
import { rgbaToPalette } from '../src/lib/image-to-palette.js';
import { resizeRgba } from '../src/lib/image-resize.js';

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    output: { type: 'string', short: 'o' },
    'alpha-threshold': { type: 'string', default: '128' },
    dither: { type: 'boolean', default: false },
    width: { type: 'string' },
    height: { type: 'string' },
    method: { type: 'string', default: 'nearest' }, // nearest | bilinear | box
  },
  allowPositionals: true,
});

if (positionals.length < 1) {
  console.error('Usage: node scripts/image-to-colors.js <input> [-o output.json] [--alpha-threshold 128] [--dither] [--width N] [--height N] [--method nearest|bilinear|box]');
  process.exit(1);
}

const input = positionals[0];
const output = values.output ?? input.replace(/\.[^.]+$/, '.json');
const alphaThreshold = parseInt(values['alpha-threshold'], 10);

if (!Number.isFinite(alphaThreshold) || alphaThreshold < 0 || alphaThreshold > 255) {
  console.error('--alpha-threshold must be an integer in [0, 255]');
  process.exit(1);
}

const { data, info } = await sharp(input)
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });

const { width: srcW, height: srcH } = info;

// Optional resize — defaults to source dims. Aspect-preserve when only one of W/H given.
const reqW = values.width ? parseInt(values.width, 10) : null;
const reqH = values.height ? parseInt(values.height, 10) : null;
let outW = reqW ?? (reqH ? Math.round(srcW * reqH / srcH) : srcW);
let outH = reqH ?? (reqW ? Math.round(srcH * reqW / srcW) : srcH);
if (outW < 1 || outH < 1) {
  console.error('Resolved width/height must be >= 1');
  process.exit(1);
}
if (outW > CANVAS_WIDTH || outH > CANVAS_HEIGHT) {
  console.warn(`Warning: output ${outW}x${outH} exceeds canvas ${CANVAS_WIDTH}x${CANVAS_HEIGHT}. Upload will fail at the boundary.`);
}

const working = (outW === srcW && outH === srcH)
  ? data
  : resizeRgba(data, srcW, srcH, outW, outH, values.method);

// sharp raw buffer has channels=4 after ensureAlpha; same layout as Canvas ImageData.
const indices = rgbaToPalette(working, outW, outH, { alphaThreshold, dither: values.dither });
const pixels = Array.from(indices);
const opaque = pixels.reduce((n, p) => n + (p >= 0 ? 1 : 0), 0);

await writeFile(output, JSON.stringify({ width: outW, height: outH, pixels }));
const resizeNote = (outW !== srcW || outH !== srcH) ? ` (resized from ${srcW}x${srcH} via ${values.method})` : '';
console.log(`Wrote ${output}: ${outW}x${outH}${resizeNote}, ${opaque}/${pixels.length} opaque pixels${values.dither ? ' [dithered]' : ''}`);
