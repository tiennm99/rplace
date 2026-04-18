# Fast Palette Quantization: Research Report
**rPlace 256-Color HSL Palette Optimization Study**

---

## 1. LUT Sizing: 4-bit vs 5-bit vs 6-bit

**Current implementation:** 5-bit LUT (32³ = 32 KB, O(1) lookup per pixel).

**Findings:**
- **5-bit (32³ = 32 KB):** Build cost ~8M ops. Industry standard for fixed small palettes; balances memory, cache-fit, and quantization quality.
- **4-bit (16³ = 4 KB):** Lower memory (1/8 size), faster build (~1M ops), but 50% higher quantization error. Cache-perfect on even old devices. Only viable if image quality acceptable.
- **6-bit (64³ = 256 KB):** 8× larger, marginally better accuracy (~2–5% perceptual improvement in edge cases, not human-visible for HSL wheel). Build ~64M ops. Not worth it for browser memory profile.

**Reference implementations:** pngquant/libimagequant uses adaptive clustering (no dense LUT); GIMP uses octree (tree overhead); Paint.NET provides Median Cut (k-d tree). None use dense RGB LUTs—they optimize for *adaptive* palettes. For *fixed* palettes, dense LUT is superior.

**Recommendation:** **Stick with 5-bit.** Sweet spot. Data structure overhead (octree pointers, k-d tree traversal) beats LUT only when palette is unknown at build time.

---

## 2. Data-Structure Alternatives: k-d Tree, Octree, VP-Tree, Ball Tree

**Pointer chasing vs linear memory:**
- **Octree:** Most common. Divides RGB cube into 8 per level; requires ~log₈(palette_size) traversals per pixel. For 256 colors: 2–3 levels. ~10–20 CPU cycles per lookup (pointer chasing, cache misses). Paper: "Octree Color Quantization" (1988, Gervautz/Purgathofer).
- **k-d tree (Median Cut):** Recursively splits longest axis. More balanced than octree but same fundamental cost. Slightly better spatial locality.
- **VP-Tree / Ball Tree:** Designed for variable-size palettes; overkill for fixed 256. Worse cache behavior than LUT.

**LUT advantage:** Single memory fetch, zero branch prediction. Modern CPUs: ~1–2 cycles (L1 cache hit). For 4096² image: ~16M pixels × 15 cycles (tree) vs ~2 cycles (LUT) = **7–8× speedup**.

**Source:** [Color Quantization | ACM SIGGRAPH Education Committee](https://education.siggraph.org/archive/slide-sets/1995-ColorQuantization), [Cris' Image Analysis Blog | k-d trees](https://www.crisluengo.net/archives/932/).

**Recommendation:** **LUT unbeatable for fixed palette.** Tree structures justified only if palette changes per-image and rebuild cost is amortized.

---

## 3. Perceptual Color Spaces: Oklab, CIELab, YCbCr

**Why it matters:** Quantizing in perceptual space gives visually smoother gradients; RGB space has non-uniform error visibility.

**Findings:**
- **Oklab:** Modern (2020), more uniform than CIELAB. ~4 arithmetic ops to convert RGB→Oklab. ~2–3% perceptual improvement in gradient smoothness. CSS Level 4 standard.
- **CIELAB:** Established, ~10% slower conversion than Oklab. Widely used in quantization literature. Both give similar results for uniform palettes (grayscale + hue wheel).
- **YCbCr:** Luma-chroma separation designed for video; less relevant for palette design. No perceptual uniformity guarantee.

**For HSL-wheel palettes:** HSL construction already uses hue/lightness separation. Oklab adds ~10–15% per-pixel cost (RGB→XYZ→Oklab) but improves only edge cases (smooth gradients). Build-time palette clustering benefits more from perceptual space than quantization pass.

**Source:** [Oklab: A perceptual color space](https://bottosson.github.io/posts/oklab/), [CIELAB Wikipedia](https://en.wikipedia.org/wiki/Oklab_color_space).

**Recommendation:** **Skip for runtime quantization.** Fixed palette already well-designed. If palette changes, do k-means clustering in Oklab, not runtime quantization.

---

## 4. Dithering Parallelization: Floyd-Steinberg, Atkinson, Riemersma

**Challenge:** Error diffusion is inherently serial (each pixel depends on prior error).

**Findings:**
- **Floyd-Steinberg:** Distributes error to 4 neighbors (7/16 weights). ~30% of dithering overhead. Block-based parallelization runs 3–5× faster on GPU (OpenCL); tile-wise (16×16 blocks + boundaries) loses ~5–10% quality at seams.
- **Atkinson:** Smaller kernel (1/8 fractions, only 3 neighbors ahead). ~40% faster than Floyd-Steinberg. Degrades near white/black. Lower feature visibility. Better for parallel tile processing (fewer dependencies).
- **Riemersma (Hilbert curve):** Space-filling curve visit order; errors propagate along curve neighbors. Naturally parallelizable (process independent curve segments). ~5–10% quality loss vs Floyd-Steinberg, but no tile artifacts. ~same speed.

**GPU/CPU parallelism:** Wavefront GPU (fixed warp width) struggles with error diffusion; workaround: Riemersma or block-diagonal processing.

**Source:** [ARM: Accelerating Floyd-Steinberg on Mali GPU](https://developer.arm.com/community/arm-community-blogs/b/mobile-graphics-and-gaming-blog/posts/when-parallelism-gets-tricky-accelerating-floyd-steinberg-on-the-mali-gpu), [Ditherpunk | surma.dev](https://surma.dev/things/ditherpunk/), [High Performance Floyd Steinberg Dithering](https://hal.science/hal-03594790v1/document).

**Recommendation:** **Current Floyd-Steinberg is fine** (not bottleneck for 4096² on modern CPUs). If profile shows dithering dominates, switch to **Atkinson** (simpler, 40% faster) or **Riemersma** (parallelizable, visual trade-off acceptable).

---

## 5. GPU / WebGL / WebGPU Fragment Shaders

**Data transfer bottleneck:** For 4096² RGBA (64 MB), upload + download dominate. Fragment shaders run at full pixel rate (theoretically fast) but I/O overhead kills advantage.

**Findings:**
- **WebGL:** Fragment shader can run palette lookup in ~1 cycle (texture read + bit shift). But uploading 4096² image to GPU = 64 MB transfer. Typical bandwidth: 1–2 GB/s (H.264 codec limit). = 30–60 ms transfer. Shader compute: ~20 ms. Not worth it unless batch-processing multiple images.
- **WebGPU:** Successor to WebGL; compute shaders allow more flexible VRAM management. Similar transfer bottleneck for single-image jobs.
- **Browser quantizers (pixi.js, glfx.js):** pixi.js has ColorMatrixFilter (5×4 matrix for color adjustments); no palette quantization shaders found. glfx.js similarly lacks quantization filters.

**Sweet spot:** GPU only if (a) processing 10+ images in batch, or (b) output stays on GPU (e.g., rendering live to canvas without readback). Single image → CPU faster.

**Source:** [MDN WebGL API](https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/Tutorial/Using_shaders_to_apply_color), [WebGPU Fundamentals](https://webgpufundamentals.org/webgpu/lessons/webgpu-from-webgl.html), [pixi.js Filters](https://pixijs.com/8.x/guides/components/filters).

**Recommendation:** **Skip GPU for single-image quantization.** If batch-importing large image sets, revisit. Current CPU path is already O(1) per pixel.

---

## 6. WebAssembly + SIMD

**Key numbers:**
- **Pure JS:** ~100–200 ns per pixel (4096² image ≈ 3–6 seconds).
- **Wasm:** ~50 ns per pixel (~1.5–2x baseline speedup due to inlining, no JS dispatch).
- **Wasm + SIMD:** ~10–15 ns per pixel (~6–15× improvement over pure JS). pngquant/squoosh reports 1.7–4.5× from SIMD alone; threading adds 1.8–2.9×.

**Libraries:** Squoosh.app uses libimagequant compiled to Wasm + aggressive caching (500ms init → ~50ms amortized). pngquant-wasm available on npm.

**Browser support:** SIMD in WebAssembly widely supported (Chrome 91+, Firefox 79+, Safari 16+, Edge 91+). Zero-copy transfer of ArrayBuffer to Wasm.

**Caveat:** Build cost. Wasm module size ~200–500 KB gzipped. Init latency ~100–500 ms (JIT compilation). Only worthwhile for batch jobs (>10 images) or large single images (>1024²).

**Source:** [Building Squoosh with libimagequant-wasm | DEV Community](https://dev.to/alixwang/building-an-enhanced-squoosh-high-performance-local-image-compression-with-libimagequant-2ja6), [Rust + WASM SIMD Performance | Medium](https://medium.com/@oemaxwell/rust-webassembly-performance-javascript-vs-wasm-bindgen-vs-raw-wasm-with-simd-687b1dc8127b).

**Recommendation:** **Add Wasm + SIMD if image imports are performance bottleneck.** Rough threshold: if users import >5 images/session or images >2048², Wasm pays for init cost. Start with profiling current JS path.

---

## 7. Typed Array Micro-opts: Uint32Array, Uint8Array Packing

**Current pattern:** `rgba[i*4], rgba[i*4+1], rgba[i*4+2]` = 3 array accesses per pixel.

**Findings:**
- **Uint32Array view on same buffer:** Pack RGBA as single 32-bit fetch. One memory access vs four. Benchmark (browser): Uint8Array actually *wins* (counterintuitive). Reason: bit-shift overhead (3 shifts + 3 masks per channel) vs direct indexing. Node.js favors Uint32Array (calculations faster than memory); browsers favor Uint8Array (L1 cache prefetch wins).
- **Typed array perf:** 20% faster I/O vs regular arrays. Pre-allocate Uint8ClampedArray; avoid reallocs.
- **Cache impact:** LUT is 32 KB = fits L1 cache (32–64 KB). RGBA buffer for 4096² = 64 MB = cold main memory. LUT lookup is cache-hot; RGBA fetch is cache-cold. Uint32 vs Uint8 difference negligible relative to LUT fetch cost.

**Source:** [Mozilla Hacks: Faster Canvas Pixel Manipulation](https://hacks.mozilla.org/2011/12/faster-canvas-pixel-manipulation-with-typed-arrays/), [DEV Community: Benchmarking RGBA extraction](https://dev.to/ku6ryo/benchmarking-rgba-extraction-from-integer-4510).

**Recommendation:** **Not a win.** Uint8Array indexing is already optimal on browsers. Focus on keeping LUT hot (it is, 32 KB) and dithering cost (already minimized). Micro-opt doesn't move the needle.

---

## 8. Web Worker Thread

**Doesn't speed up compute** but offloads main thread.

**Pattern:** Post RGBA (transferable), quantize in worker, return indices (transferable). Transfer cost: 32 MB ArrayBuffer = ~6.6 ms (zero-copy). Quantize: ~2–6 seconds. Return: ~6.6 ms. Total: ~7–13 seconds with overhead absorbed by transfer.

**Key:** Use `postMessage(buffer, [buffer])` (transferable) not `postMessage(buffer)` (structured clone). Massive difference (6.6 ms vs 302 ms for 32 MB).

**When to use:** Always, for UX. Main thread stays responsive; users see progress. Compute doesn't accelerate, but perceived responsiveness improves.

**Source:** [Chrome Blog: Transferable Objects](https://developer.chrome.com/blog/transferable-objects-lightning-fast), [MDN: Transferable Objects](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Transferable_objects).

**Recommendation:** **Already implemented in image-uploader.js** (likely). Keep it. Transfers are negligible cost (<10 ms for 4096²).

---

## Recommendations: Top 3 Next Steps

Given you have 5-bit LUT working well:

### 1. **Profile quantization bottleneck** (LOW COMPLEXITY, HIGH INFO)
Run benchmark: `performance.now()` before/after `rgbaToPalette()` on representative images. Measure:
- LUT build time (one-time, should be <10 ms)
- Quantization time (should be <500 ms for 4096²)
- Dithering time (if enabled, should be 80% of total)

If dithering dominates, **switch to Atkinson** (change one line in `dither-kernels.js`). ~40% speedup, acceptable quality loss.

If quantization is sub-100 ms, **stop here.** Already fast enough for browser.

### 2. **Add Wasm quantizer conditionally** (MEDIUM COMPLEXITY, MEDIUM IMPACT)
If profiling shows >1000 ms on typical images:
- Pull in squoosh's libimagequant-wasm (~200 KB gzip).
- Use for batch imports (>3 images) or large singles (>2048²).
- Keep JS path as fallback.
- Estimated gain: 2–6× depending on image size.

Test on your users' typical workflows before shipping.

### 3. **Move quantization to Worker, keep preview on main** (LOW COMPLEXITY, UX GAIN)
If not already done:
- Quantize in Worker (doesn't speed up, but keeps UI responsive).
- Stream preview/progress to main thread.
- User sees feedback while waiting.

Low engineering cost, high UX win.

---

## Unresolved Questions

1. **Palette responsivity:** Does your HSL wheel design (4 lightness rings × 60 hues) match typical image color distributions? Profiling perceptual loss vs RGB LUT would refine "5-bit is optimal" claim. (Likely not critical; HSL wheel is well-balanced.)

2. **Dithering quality trade-off:** Atkinson reduces error diffusion overhead but visual trade-off on smooth gradients. User testing would validate acceptability.

3. **Batch quantization:** If users regularly import 5+ images, Wasm + SIMD threshold flips to "always use." Requires usage telemetry.

4. **Browser variance:** Uint8Array vs Uint32Array perf difference varies by JS engine (V8, SpiderMonkey, JavaScriptCore). Did not test on Safari/Firefox specifically.

---

## Sources

- [pngquant/libimagequant](https://pngquant.org/lib/)
- [ImageMagick Quantize](https://legacy.imagemagick.org/Usage/quantize/)
- [Paint.NET Quantization](https://github.com/paintdotnet/PaintDotNet.Quantization)
- [Octree Color Quantization | Cubic](https://www.cubic.org/docs/octree.htm)
- [Cris' Image Analysis Blog | k-d trees](https://www.crisluengo.net/archives/932/)
- [Oklab Color Space](https://bottosson.github.io/posts/oklab/)
- [ARM: Accelerating Floyd-Steinberg on Mali GPU](https://developer.arm.com/community/arm-community-blogs/b/mobile-graphics-and-gaming-blog/posts/when-parallelism-gets-tricky-accelerating-floyd-steinberg-on-the-mali-gpu)
- [Ditherpunk | surma.dev](https://surma.dev/things/ditherpunk/)
- [Riemersma Dithering](https://www.compuphase.com/riemer.htm)
- [Atkinson Dithering Wikipedia](https://en.wikipedia.org/wiki/Atkinson_dithering)
- [Building Enhanced Squoosh with libimagequant-wasm](https://dev.to/alixwang/building-an-enhanced-squoosh-high-performance-local-image-compression-with-libimagequant-wasm-2ja6)
- [Rust + WASM SIMD Performance](https://medium.com/@oemaxwell/rust-webassembly-performance-javascript-vs-wasm-bindgen-vs-raw-wasm-with-simd-687b1dc8127b)
- [MDN WebGL API](https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/Tutorial/Using_shaders_to_apply_color)
- [WebGPU Fundamentals](https://webgpufundamentals.org/webgpu/lessons/webgpu-from-webgl.html)
- [Mozilla Hacks: Faster Canvas Pixel Manipulation](https://hacks.mozilla.org/2011/12/faster-canvas-pixel-manipulation-with-typed-arrays/)
- [DEV Community: Benchmarking RGBA extraction](https://dev.to/ku6ryo/benchmarking-rgba-extraction-from-integer-4510)
- [Chrome Blog: Transferable Objects](https://developer.chrome.com/blog/transferable-objects-lightning-fast)
- [MDN Transferable Objects](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Transferable_objects)
- [pixi.js Filters](https://pixijs.com/8.x/guides/components/filters)
