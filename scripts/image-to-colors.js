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

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    output: { type: 'string', short: 'o' },
    'alpha-threshold': { type: 'string', default: '128' },
    dither: { type: 'boolean', default: false },
  },
  allowPositionals: true,
});

if (positionals.length < 1) {
  console.error('Usage: node scripts/image-to-colors.js <input.png|jpg|webp> [-o output.json] [--alpha-threshold 128] [--dither]');
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

const { width, height } = info;

if (width > CANVAS_WIDTH || height > CANVAS_HEIGHT) {
  console.warn(`Warning: image ${width}x${height} exceeds canvas ${CANVAS_WIDTH}x${CANVAS_HEIGHT}. Upload will fail at the boundary.`);
}

// sharp raw buffer has channels=4 after ensureAlpha; same layout as Canvas ImageData.
const indices = rgbaToPalette(data, width, height, { alphaThreshold, dither: values.dither });
const pixels = Array.from(indices);
const opaque = pixels.reduce((n, p) => n + (p >= 0 ? 1 : 0), 0);

await writeFile(output, JSON.stringify({ width, height, pixels }));
console.log(`Wrote ${output}: ${width}x${height}, ${opaque}/${pixels.length} opaque pixels${values.dither ? ' [dithered]' : ''}`);
