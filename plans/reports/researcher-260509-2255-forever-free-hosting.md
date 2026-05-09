# Research Report: Best Forever-Free Hosting for rplace

**Date:** 2026-05-09 22:55 (Asia/Saigon)
**Scope:** Find the best **truly always-free** (not trial, not credits) cloud hosting for rplace's stack: WS broadcast hub + HTTP API + Redis-like KV + static SPA.
**Verdict:** **Stay on Cloudflare.** It is *the* forever-free fit for this workload. Only realistic alternative is Oracle Cloud Always Free + self-host, with operational cost.

---

## Use Case Constraints (rplace specific)

| Need | Numbers |
|---|---|
| Static SPA | ~1 MB Svelte build |
| HTTP API (Hono) | low QPS, hobby-scale |
| WebSocket broadcast | one global room, all clients fan-out from one place |
| Storage | 16 MB canvas + per-user cooldown TTL keys |
| Egress | up to ~5 MB gzipped per `/api/canvas` (cached 10s) |
| Stateful coordinator | required (broadcast hub) |

---

## Free-Tier Reality Check (May 2026)

| Platform | Forever-Free? | WebSocket Server? | Stateful Actor? | Verdict for rplace |
|---|---|---|---|---|
| **Cloudflare Workers + DO** | ✅ Yes | ✅ Yes (Hibernation API) | ✅ Yes (DO) | **Best fit, current** |
| **Oracle Cloud Always Free** | ✅ Yes | ✅ Yes (real VM) | ✅ Yes (any) | Viable backup; ops cost |
| **Google Cloud Run** | ✅ Yes (180K vCPU-s/mo) | ⚠️ Limited (no long-lived WS as a server, max 60min request) | ❌ | Marginal; cold starts |
| **Vercel Hobby** | ✅ (limits) | ❌ | ❌ | Not viable, see prev report |
| **Netlify Free** | ✅ (limits) | ❌ | ❌ | Not viable, see prev report |
| **Render Free** | ⚠️ 750 hr/mo + auto-sleep | ✅ (when awake) | ❌ | 30–50s cold start kills WS UX |
| **Koyeb Free** | ✅ Yes (1 service) | ✅ | ❌ | Decent backup, single instance limit |
| **Fly.io** | ❌ Removed for new signups in 2026 | — | — | **Out** |
| **Railway** | ❌ Trial credit only ($5/mo) | — | — | **Out** |
| **Heroku** | ❌ Killed free tier 2022 | — | — | **Out** |
| **AWS Free Tier** | ❌ 12 months only | — | — | **Out** |

---

## Why Cloudflare Wins (Numbers)

### Workers Free (always-free)
- **100,000 requests / day** — at 1 req/sec rate-limit, that's 100K user actions/day before hitting the cap. Plenty for hobby.
- **10 ms CPU / request** — broadcasts and BITFIELD ops finish in <1ms.
- **Static assets**: free, unlimited bandwidth.

### Durable Objects Free (since 2024)
- **5 GB SQLite storage** (we use 0 — state is in Upstash).
- **WebSocket Hibernation = idle sockets cost $0 CPU.** Critical: a connected-but-idle client doesn't burn the request quota.
- Available on Workers Free plan with SQLite backend (the only DO option currently used by rplace).

### Upstash Redis Free (always-free)
- **500K commands / month** (~16K/day). Bumped from 10K/day in March 2025.
- **256 MB storage** — canvas is 16 MB, fits 16× over.
- ⚠️ **Possible squeeze:** `/api/canvas` uses 4 GETRANGE = 4 commands per fetch. If the 10s cache-control isn't honored by clients, traffic spikes can chew through 500K/mo. Already mitigated by `Cache-Control: max-age=10, s-maxage=10`.

### Total monthly cost: $0. Forever.

---

## The One Real Alternative: Oracle Cloud Always Free

If you need a non-Cloudflare backup, **Oracle Cloud Always Free** is the only platform offering a *real* VM forever-free that can host a WS server.

| Resource | Limit |
|---|---|
| ARM Ampere A1 | 4 OCPU + 24 GB RAM (split across up to 4 VMs) |
| Block storage | 200 GB |
| Egress | 10 TB/month outbound |
| AMD x86 VM | 2× shape with 1/8 OCPU + 1 GB RAM (small) |

### Pros
- True root access. Run any WS server (Bun, Node, Go, Rust).
- Generous resources — overkill for rplace.
- Forever, not trial.

### Cons (brutal)
- **You become the sysadmin.** Patches, monitoring, TLS, restarts — all yours.
- **Idle reaping**: <10% CPU + <10% network for 7 days → Oracle stops the VM. rplace is bursty hobby traffic, this is real risk. Mitigation: a cron `dd if=/dev/urandom` every 6h or a small load-gen.
- **Single region** — no edge. Latency for users far from your chosen region (vs Cloudflare's ~330 PoPs).
- **Capacity issues** — A1 instances are notoriously hard to provision in popular regions ("Out of Capacity" loops). Plan for retries.
- **Vendor risk** — Oracle has historically been quick to terminate "abusive" free accounts.

### When to choose
Only if Cloudflare becomes unavailable to you (account ban, geographic restriction, org policy). Otherwise the operational debt is not worth it.

---

## Stack Recommendation (Forever-Free)

### Primary (current, optimal)
```
Cloudflare Workers (Hono)
  ├── Durable Object (CanvasRoom) — WS broadcast hub
  └── Upstash Redis Free — canvas BITFIELD + cooldown
```

### Backup (if forced off Cloudflare)
```
Oracle Cloud A1 VM (single instance, 1 OCPU, 6 GB RAM)
  ├── Caddy (TLS + static SPA)
  ├── Bun + Hono server (HTTP API + native ws)
  └── Upstash Redis Free  (or local valkey-server, free)
```

A1 backup loses: edge latency, zero-config TLS, automatic scaling, hibernation-cheap idle WS.
A1 backup gains: full control, no platform-specific lock-in, no vendor-shaped architecture.

---

## What Changed in 2025–2026 (worth knowing)

- **Fly.io removed free tier for new signups** (legacy accounts grandfathered).
- **Railway moved to $5/mo trial credit** model — no longer "always free."
- **Cloudflare DOs now free on Workers Free plan** (SQLite backend), making the rplace stack 100% free where it used to require paid Workers.
- **Upstash bumped Redis free tier** from 10K/day to 500K/month commands.
- **Oracle Cloud expanded A1 outbound** to 10 TB/month.

Net effect: Cloudflare's free-tier moat got **wider**, not narrower.

---

## Recommendation

**Do nothing.** The current Cloudflare Workers + DO + Upstash stack is the unambiguous winner for rplace's exact shape of workload at $0/month forever. Any move is a downgrade in capability or an upgrade in operational burden.

If you specifically want a backup plan documented, set up an **Oracle Cloud A1 VM** in your closest region as a cold-standby. Don't migrate; just keep it provisioned in case of CF account loss.

---

## Unresolved Questions

1. Why is migration on the table? (Cost = $0 already; capability = best-in-class.) The motivation matters more than the answer.
2. Geographic constraints? (Cloudflare is restricted in certain countries/orgs.)
3. Risk tolerance for vendor lock-in vs. operational burden? (CF = locked-in but free; Oracle = portable but ops-heavy.)
4. Is Upstash 500K cmd/mo enough at projected traffic? Worth measuring current `/api/canvas` and `/api/place` rates over a week.

---

## Sources

- [Cloudflare Workers Pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Cloudflare Durable Objects Pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Which Cloudflare Services Are Free? 2025 Free Tier Guide (DEV)](https://dev.to/ioniacob/which-cloudflare-services-are-free-2025-free-tier-guide-53jl)
- [Oracle Cloud Free Tier (Official)](https://www.oracle.com/cloud/free/)
- [Oracle Cloud Always Free VPS 2026 Real Limits](https://space-node.net/blog/oracle-vps-free-tier-review-2026)
- [Setup Always Free VPS 4 OCPU 24GB RAM Oracle Guide 2026 (Medium)](https://medium.com/@imvinojanv/setup-always-free-vps-with-4-ocpu-24gb-ram-and-200gb-storage-the-ultimate-oracle-cloud-guide-bed5cbf73d34)
- [Upstash Redis Pricing & Limits](https://upstash.com/docs/redis/overall/pricing)
- [Upstash New Pricing Higher Limits (March 2025)](https://upstash.com/blog/redis-new-pricing)
- [Platforms with a Real Free Tier 2026 (Render Blog)](https://render.com/articles/platforms-with-a-real-free-tier-for-developers-in-2026)
- [Free Cloud Deployment Platforms 2026 (SnapDeploy)](https://snapdeploy.dev/blog/free-cloud-deployment-platforms-2026-comparison)
- [Best Always-Free Tier Cloud Platforms (GitHub gist)](https://gist.github.com/hashirahmad/8df502f8d9e3b01f7998c55c22447c4f)
