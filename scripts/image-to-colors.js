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
import { transformRgba } from '../src/lib/image-transform.js';

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    output: { type: 'string', short: 'o' },
    'alpha-threshold': { type: 'string', default: '128' },
    dither: { type: 'boolean', default: false },
    'dither-method': { type: 'string' }, // see DITHER_METHODS; overrides --dither
    width: { type: 'string' },
    height: { type: 'string' },
    method: { type: 'string', default: 'nearest' }, // nearest | bilinear | box
    'flip-h': { type: 'boolean', default: false },
    'flip-v': { type: 'boolean', default: false },
    rotate: { type: 'string', default: '0' }, // 0 | 90 | 180 | 270 (CW)
  },
  allowPositionals: true,
});

if (positionals.length < 1) {
  console.error('Usage: node scripts/image-to-colors.js <input> [-o output.json] [--alpha-threshold 128] [--dither|--dither-method <name>] [--width N] [--height N] [--method nearest|bilinear|box] [--flip-h] [--flip-v] [--rotate 0|90|180|270]');
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

const { width: rawW, height: rawH } = info;

const rotation = parseInt(values.rotate, 10);
if (![0, 90, 180, 270].includes(rotation)) {
  console.error('--rotate must be 0, 90, 180, or 270');
  process.exit(1);
}

const transformed = (values['flip-h'] || values['flip-v'] || rotation !== 0)
  ? transformRgba(data, rawW, rawH, { flipH: values['flip-h'], flipV: values['flip-v'], rotation })
  : { rgba: data, width: rawW, height: rawH };
const srcW = transformed.width;
const srcH = transformed.height;

// Optional resize — defaults to post-transform dims. Aspect-preserve when only one of W/H given.
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
  ? transformed.rgba
  : resizeRgba(transformed.rgba, srcW, srcH, outW, outH, values.method);

// sharp raw buffer has channels=4 after ensureAlpha; same layout as Canvas ImageData.
const ditherMethod = values['dither-method'] ?? (values.dither ? 'floyd' : 'none');
const indices = rgbaToPalette(working, outW, outH, { alphaThreshold, method: ditherMethod });
const pixels = Array.from(indices);
const opaque = pixels.reduce((n, p) => n + (p >= 0 ? 1 : 0), 0);

await writeFile(output, JSON.stringify({ width: outW, height: outH, pixels }));
const transformNote = (values['flip-h'] || values['flip-v'] || rotation !== 0)
  ? ` [transform: ${[values['flip-h'] && 'flipH', values['flip-v'] && 'flipV', rotation !== 0 && `rot${rotation}`].filter(Boolean).join('+')}]`
  : '';
const resizeNote = (outW !== srcW || outH !== srcH) ? ` (resized from ${srcW}x${srcH} via ${values.method})` : '';
const ditherNote = ditherMethod !== 'none' ? ` [dither: ${ditherMethod}]` : '';
console.log(`Wrote ${output}: ${outW}x${outH}${resizeNote}${transformNote}, ${opaque}/${pixels.length} opaque pixels${ditherNote}`);
