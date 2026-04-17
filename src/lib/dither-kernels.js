/**
 * Dither kernels (error-diffusion) and threshold matrices (ordered).
 *
 * Error-diffusion kernel entries: [dx, dy, weight]. Weights are fractions so
 * sums tell you how much error is redistributed (Floyd = 1.0, Atkinson = 0.75).
 *
 * Bayer matrices are normalized to 0..1 (divided by N*N).
 */

const FS = 1 / 16;
export const KERNEL_FLOYD = [
  [ 1, 0, 7 * FS],
  [-1, 1, 3 * FS],
  [ 0, 1, 5 * FS],
  [ 1, 1, 1 * FS],
];

// Atkinson (original Mac) — only diffuses 6/8 of the error; gives a softer look.
const ATK = 1 / 8;
export const KERNEL_ATKINSON = [
  [ 1, 0, ATK],
  [ 2, 0, ATK],
  [-1, 1, ATK],
  [ 0, 1, ATK],
  [ 1, 1, ATK],
  [ 0, 2, ATK],
];

// Jarvis-Judice-Ninke — 12-entry kernel over 3 rows, smoother than FS.
const JJN = 1 / 48;
export const KERNEL_JARVIS = [
  [ 1, 0, 7 * JJN], [ 2, 0, 5 * JJN],
  [-2, 1, 3 * JJN], [-1, 1, 5 * JJN], [0, 1, 7 * JJN], [1, 1, 5 * JJN], [2, 1, 3 * JJN],
  [-2, 2, 1 * JJN], [-1, 2, 3 * JJN], [0, 2, 5 * JJN], [1, 2, 3 * JJN], [2, 2, 1 * JJN],
];

// Burkes
const BUR = 1 / 32;
export const KERNEL_BURKES = [
  [ 1, 0, 8 * BUR], [ 2, 0, 4 * BUR],
  [-2, 1, 2 * BUR], [-1, 1, 4 * BUR], [0, 1, 8 * BUR], [1, 1, 4 * BUR], [2, 1, 2 * BUR],
];

// Sierra (3-line)
const SIE = 1 / 32;
export const KERNEL_SIERRA = [
  [ 1, 0, 5 * SIE], [ 2, 0, 3 * SIE],
  [-2, 1, 2 * SIE], [-1, 1, 4 * SIE], [0, 1, 5 * SIE], [1, 1, 4 * SIE], [2, 1, 2 * SIE],
  [-1, 2, 2 * SIE], [0, 2, 3 * SIE], [1, 2, 2 * SIE],
];

// Sierra Lite — cheapest non-trivial
const SLT = 1 / 4;
export const KERNEL_SIERRA_LITE = [
  [ 1, 0, 2 * SLT],
  [-1, 1, 1 * SLT],
  [ 0, 1, 1 * SLT],
];

export const ERROR_DIFFUSION_KERNELS = {
  floyd: KERNEL_FLOYD,
  atkinson: KERNEL_ATKINSON,
  jarvis: KERNEL_JARVIS,
  burkes: KERNEL_BURKES,
  sierra: KERNEL_SIERRA,
  'sierra-lite': KERNEL_SIERRA_LITE,
};

// Bayer threshold matrices. Values are normalized to [0, 1).
const BAYER_2 = [
  [0, 2],
  [3, 1],
].map((row) => row.map((v) => v / 4));

const BAYER_4 = [
  [ 0,  8,  2, 10],
  [12,  4, 14,  6],
  [ 3, 11,  1,  9],
  [15,  7, 13,  5],
].map((row) => row.map((v) => v / 16));

const BAYER_8 = [
  [ 0, 32,  8, 40,  2, 34, 10, 42],
  [48, 16, 56, 24, 50, 18, 58, 26],
  [12, 44,  4, 36, 14, 46,  6, 38],
  [60, 28, 52, 20, 62, 30, 54, 22],
  [ 3, 35, 11, 43,  1, 33,  9, 41],
  [51, 19, 59, 27, 49, 17, 57, 25],
  [15, 47,  7, 39, 13, 45,  5, 37],
  [63, 31, 55, 23, 61, 29, 53, 21],
].map((row) => row.map((v) => v / 64));

export const BAYER_MATRICES = {
  'bayer-2': BAYER_2,
  'bayer-4': BAYER_4,
  'bayer-8': BAYER_8,
};

export const DITHER_METHODS = [
  'none', 'floyd', 'atkinson', 'jarvis', 'burkes', 'sierra', 'sierra-lite',
  'bayer-2', 'bayer-4', 'bayer-8',
];
