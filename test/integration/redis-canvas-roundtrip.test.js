/**
 * Integration tests: BITFIELD write → GETRANGE read round-trip with real Redis.
 * Uses Testcontainers to spin up a Redis Docker container.
 * Verifies the exact command sequences our setPixels/getFullCanvas use.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GenericContainer } from 'testcontainers';
import Redis from 'ioredis';
import { decodeCanvas } from '../../src/lib/canvas-decoder.js';
import { CANVAS_WIDTH, BITS_PER_PIXEL, REDIS_CANVAS_KEY } from '../../src/lib/constants.js';

const TOTAL_PIXELS = CANVAS_WIDTH * CANVAS_WIDTH;
const CANVAS_BYTES = Math.ceil((TOTAL_PIXELS * BITS_PER_PIXEL) / 8);

let container;
let redis;

beforeAll(async () => {
  container = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .start();
  redis = new Redis({
    host: container.getHost(),
    port: container.getMappedPort(6379),
  });
}, 60000);

afterAll(async () => {
  await redis?.quit();
  await container?.stop();
});

/**
 * Replicate setPixels: build the same BITFIELD command our worker sends.
 */
async function writePixels(pixels) {
  const args = [];
  for (const { x, y, color } of pixels) {
    const offset = y * CANVAS_WIDTH + x;
    args.push('SET', 'u5', `#${offset}`, String(color));
  }
  return redis.call('BITFIELD', REDIS_CANVAS_KEY, ...args);
}

/**
 * Replicate getFullCanvas: GETRANGE → raw bytes → decode.
 * Uses Buffer (binary-safe, unlike Upstash REST JSON transport).
 */
async function readCanvasBytes() {
  const buf = await redis.getrangeBuffer(REDIS_CANVAS_KEY, 0, CANVAS_BYTES - 1);
  if (!buf || buf.length === 0) {
    return new Uint8Array(CANVAS_BYTES);
  }
  const bytes = new Uint8Array(buf.length);
  for (let i = 0; i < buf.length; i++) {
    bytes[i] = buf[i];
  }
  if (bytes.length < CANVAS_BYTES) {
    const padded = new Uint8Array(CANVAS_BYTES);
    padded.set(bytes);
    return padded;
  }
  return bytes;
}

describe('Redis BITFIELD canvas round-trip', () => {
  it('stores and reads back a single pixel', async () => {
    await writePixels([{ x: 0, y: 0, color: 15 }]);
    const bytes = await readCanvasBytes();
    const indices = decodeCanvas(bytes.buffer);
    expect(indices[0]).toBe(15);
  });

  it('round-trips all 32 color values', async () => {
    const pixels = [];
    for (let i = 0; i < 32; i++) {
      pixels.push({ x: i, y: 1, color: i });
    }
    await writePixels(pixels);
    const bytes = await readCanvasBytes();
    const indices = decodeCanvas(bytes.buffer);

    for (let i = 0; i < 32; i++) {
      expect(indices[1 * CANVAS_WIDTH + i]).toBe(i);
    }
  });

  it('handles pixels at various canvas positions', async () => {
    const testCases = [
      { x: 0, y: 0, color: 1 },
      { x: 2047, y: 0, color: 31 },
      { x: 0, y: 2047, color: 16 },
      { x: 2047, y: 2047, color: 8 },
      { x: 1024, y: 1024, color: 20 },
    ];
    await writePixels(testCases);
    const bytes = await readCanvasBytes();
    const indices = decodeCanvas(bytes.buffer);

    for (const { x, y, color } of testCases) {
      expect(indices[y * CANVAS_WIDTH + x]).toBe(color);
    }
  });

  it('overwrites existing pixels correctly', async () => {
    await writePixels([{ x: 500, y: 500, color: 10 }]);
    let bytes = await readCanvasBytes();
    let indices = decodeCanvas(bytes.buffer);
    expect(indices[500 * CANVAS_WIDTH + 500]).toBe(10);

    // Overwrite
    await writePixels([{ x: 500, y: 500, color: 25 }]);
    bytes = await readCanvasBytes();
    indices = decodeCanvas(bytes.buffer);
    expect(indices[500 * CANVAS_WIDTH + 500]).toBe(25);
  });

  it('batch writes are atomic (all pixels in one BITFIELD)', async () => {
    const batchSize = 100;
    const pixels = [];
    for (let i = 0; i < batchSize; i++) {
      pixels.push({ x: i, y: 2, color: i % 32 });
    }
    await writePixels(pixels);
    const bytes = await readCanvasBytes();
    const indices = decodeCanvas(bytes.buffer);

    for (let i = 0; i < batchSize; i++) {
      expect(indices[2 * CANVAS_WIDTH + i]).toBe(i % 32);
    }
  });

  it('adjacent pixels do not corrupt each other (5-bit boundary)', async () => {
    // 5-bit values pack across byte boundaries; verify no bleed
    const pixels = [];
    for (let i = 0; i < 16; i++) {
      pixels.push({ x: i, y: 3, color: 31 }); // all bits set
    }
    // Interleave with zeros
    for (let i = 16; i < 32; i++) {
      pixels.push({ x: i, y: 3, color: 0 });
    }
    await writePixels(pixels);
    const bytes = await readCanvasBytes();
    const indices = decodeCanvas(bytes.buffer);

    for (let i = 0; i < 16; i++) {
      expect(indices[3 * CANVAS_WIDTH + i]).toBe(31);
    }
    for (let i = 16; i < 32; i++) {
      expect(indices[3 * CANVAS_WIDTH + i]).toBe(0);
    }
  });
});

describe('Redis rate limiter Lua script', () => {
  const CREDIT_SCRIPT = `
local data = redis.call('HGETALL', KEYS[1])
local lastUpdate = 0
local credits = tonumber(ARGV[3])

if #data > 0 then
  for i = 1, #data, 2 do
    if data[i] == 'lu' then lastUpdate = tonumber(data[i+1]) end
    if data[i] == 'cr' then credits = tonumber(data[i+1]) end
  end
end

local elapsed = tonumber(ARGV[2]) - lastUpdate
local accrued = math.min(tonumber(ARGV[3]), credits + math.floor(elapsed * tonumber(ARGV[4])))
local count = tonumber(ARGV[1])

if accrued < count then
  return {0, accrued, count - accrued}
end

local remaining = accrued - count
redis.call('HSET', KEYS[1], 'lu', ARGV[2], 'cr', remaining)
redis.call('EXPIRE', KEYS[1], 86400)
return {1, remaining, 0}
`;

  const MAX_CREDITS = 256;
  const REGEN_RATE = 1;
  const key = 'rplace:credits:test-user';

  async function checkCredits(count, now) {
    return redis.eval(CREDIT_SCRIPT, 1, key, count, now, MAX_CREDITS, REGEN_RATE);
  }

  it('grants full credits to new user', async () => {
    await redis.del(key);
    const result = await checkCredits(1, 1000);
    expect(result[0]).toBe(1);  // allowed
    expect(result[1]).toBe(255); // remaining
    expect(result[2]).toBe(0);  // retryAfter
  });

  it('deducts credits correctly', async () => {
    await redis.del(key);
    await checkCredits(10, 1000);
    // 256 - 10 = 246, no time passed so no regen
    const result = await checkCredits(5, 1000);
    expect(result[0]).toBe(1);
    expect(result[1]).toBe(241); // 246 - 5
  });

  it('regenerates credits over time', async () => {
    await redis.del(key);
    await checkCredits(256, 1000); // spend all (remaining = 0)
    // Wait 10 seconds → 10 credits regenerated
    const result = await checkCredits(5, 1010);
    expect(result[0]).toBe(1);
    expect(result[1]).toBe(5); // 10 regen - 5 spent
  });

  it('rejects when insufficient credits', async () => {
    await redis.del(key);
    await checkCredits(256, 1000); // spend all
    // No time passed, 0 credits
    const result = await checkCredits(1, 1000);
    expect(result[0]).toBe(0); // denied
    expect(result[2]).toBe(1); // retryAfter = 1 credit needed
  });

  it('caps credits at MAX_CREDITS', async () => {
    await redis.del(key);
    await checkCredits(1, 1000); // remaining = 255
    // Wait a very long time → should cap at 256
    const result = await checkCredits(1, 2000);
    expect(result[0]).toBe(1);
    expect(result[1]).toBe(255); // 256 (capped) - 1
  });
});
