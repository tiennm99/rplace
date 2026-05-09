# Canvas Resize Procedure

The canvas dimensions are driven by two constants. Storage chunks auto-derive,
so resizing is a config change followed by a redeploy — no migration code
needed.

## Steps

1. Edit `src/lib/constants.js`:

   ```js
   export const CANVAS_WIDTH  = 8192;   // was 4096
   export const CANVAS_HEIGHT = 8192;   // was 4096
   ```

   `TOTAL_PIXELS` and `CHUNK_COUNT` recompute automatically. Bumping to
   `8192×8192` raises `CHUNK_COUNT` from 256 to 1024 (still well under the
   1 GB single-DO limit, which would allow ~32K×32K).

2. Build and deploy:

   ```bash
   npm run deploy
   ```

3. The DO lazy-initializes any missing chunks on the next read. New
   bytes are zero-filled (palette index 0 — pure black). Existing pixels
   keep their `(x, y)` coordinates; the canvas just becomes larger around
   them.

## Caveats

- **Shrinking** the canvas leaves orphan chunk rows past the new
  `CHUNK_COUNT`. Existing reads are unaffected (they only iterate up to
  the new limit), but storage usage stays high until they're cleaned up.
  To reclaim: connect to the DO and run
  `DELETE FROM canvas_chunks WHERE chunk_id >= NEW_CHUNK_COUNT`.
- **Aspect ratio change** (non-square) is fine. The 1-D byte-layout
  (`y * CANVAS_WIDTH + x`) still holds. Just make sure clients pull
  the new constants too — frontend reads them from the same module.
- **Storage cap.** SQLite-backed DO storage is 1 GB on the Free plan.
  A 1-byte-per-pixel canvas fits up to roughly **32,768 × 32,768**
  before hitting that ceiling.

## Free-tier monitoring

After resize, watch:
- Cloudflare Workers requests/day (free cap: 100,000)
- Durable Object storage size (free cap: 1 GB per DO)

Both visible on the Cloudflare dashboard for the rplace project.
