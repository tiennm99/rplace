# Code Standards

## Language & Style

- **JavaScript** (ES modules, no TypeScript)
- **Svelte 5** with runes ($state, $props, $derived, $effect)
- **kebab-case** for JS files, **PascalCase** for Svelte components
- Files under 200 lines
- No semicolons omission — use semicolons consistently

## Project Layout

```
src/
├── worker.js              # Worker entry (Hono routes)
├── durable-objects/       # Cloudflare Durable Objects
├── lib/                   # Shared libraries (worker + client)
├── client/                # Svelte SPA
│   ├── components/        # Svelte components (PascalCase)
│   ├── main.js            # Mount entry
│   └── App.svelte         # Root component
└── index.html             # Vite entry
```

## Conventions

### Worker (src/worker.js, src/lib/*)

- Functions receive `env` parameter for Cloudflare bindings (DO bindings, vars)
- No global state — Workers are stateless between requests
- Durable Object access via `env.CANVAS_ROOM.get(env.CANVAS_ROOM.idFromName('main'))`
- Identity flows through `resolveIdentity(request, env)` (cookie-first, IP fallback)
- Edge handlers validate input before forwarding to the DO; the DO re-validates at the trust boundary

### Client (src/client/*)

- Svelte 5 runes only (`$state`, `$props`, `$derived`, `$effect`)
- No stores — pass state via props and callbacks
- Canvas rendering is imperative (OffscreenCanvas + putImageData)
- Touch and mouse handlers coexist on the same canvas element

### Shared (src/lib/constants.js, src/lib/canvas-decoder.js)

- Imported by both worker and client
- Vite tree-shakes worker-only code from client bundle
- Constants are the single source of truth for canvas dimensions, colors, limits

## API Response Format

Success: `{ ok: true }`
Error: `{ error: "error_code", ...details }` with appropriate HTTP status (e.g., `retryAfter` on 429)
