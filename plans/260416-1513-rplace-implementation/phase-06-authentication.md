---
phase: 6
title: "Authentication"
status: pending
effort: 3h
priority: P2
blocked_by: [5]
---

# Phase 6 — Authentication

## Overview
Add optional Google/GitHub OAuth via NextAuth.js. Anonymous users continue working via IP-based identity. Authenticated users get stable identity (no credit reset on IP change).

## Key Insights
- NextAuth.js App Router integration uses route handler at `app/api/auth/[...nextauth]/route.js`
- JWT strategy (no database session) — stateless, Vercel-friendly
- Anonymous users work immediately — auth is opt-in enhancement
- Transition: when user logs in, optionally migrate credits from anon identity to auth identity

## Data Flow

```
Anonymous:
  Request → getUserId() → hash(IP) → "anon:abc123"

Authenticated:
  Request → NextAuth session → session.user.id → "auth:google-12345"

Login Flow:
  1. User clicks "Sign in" → NextAuth OAuth flow
  2. Redirect to Google/GitHub → consent → callback
  3. NextAuth creates JWT session cookie
  4. Subsequent requests include session → getUserId returns auth ID
  5. Optional: migrate credits from anon key to auth key
```

## Architecture

### `src/lib/auth-options.js`

```js
// NextAuth configuration
// Providers: Google, GitHub
// Strategy: JWT (no database)
// Callbacks: include user ID in session
// Pages: custom sign-in page (optional, default works for MVP)
```

### `src/app/api/auth/[...nextauth]/route.js`

```js
// Standard NextAuth route handler
import NextAuth from 'next-auth';
import { authOptions } from '@/lib/auth-options';
const handler = NextAuth(authOptions);
export { handler as GET, handler as POST };
```

### Modify `src/lib/get-user-id.js`

```js
// Updated flow:
// 1. getServerSession(authOptions)
// 2. If session: return `auth:${session.user.id}`
// 3. Else: return `anon:${hash(ip)}`
```

## Related Code Files

### Create
- `src/lib/auth-options.js`
- `src/app/api/auth/[...nextauth]/route.js`

### Modify
- `src/lib/get-user-id.js` — add session check
- `src/app/components/user-info.js` — add login/logout buttons
- `src/app/layout.js` — wrap with SessionProvider (client-side)

## Implementation Steps

1. **Create `auth-options.js`**
   - Configure Google and GitHub providers from env vars
   - JWT strategy, no database adapter
   - Add `session` callback to expose provider account ID
   - Add `jwt` callback to persist user ID in token

2. **Create NextAuth route handler**
   - Standard catch-all route at `api/auth/[...nextauth]`

3. **Update `get-user-id.js`**
   - Import `getServerSession` from `next-auth`
   - Check session first, fallback to IP hash
   - Handle edge case: session exists but user.id missing

4. **Update `user-info.js` component**
   - Import `useSession` from `next-auth/react`
   - Show "Sign in" button when not authenticated
   - Show user avatar/name + "Sign out" when authenticated
   - Use `signIn()` and `signOut()` from next-auth/react

5. **Add SessionProvider wrapper**
   - Create `src/app/providers.js` — client component wrapping `SessionProvider`
   - Import in `layout.js`

6. **Credit migration (optional, nice-to-have)**
   - On first authenticated request: check if anon key has credits
   - If so: transfer credits from anon to auth key, delete anon key
   - Skip if complexity not worth it for MVP

## Todo List

- [ ] Create `auth-options.js` with Google + GitHub providers
- [ ] Create NextAuth route handler
- [ ] Create `providers.js` with SessionProvider
- [ ] Update layout.js with providers wrapper
- [ ] Update `get-user-id.js` with session check
- [ ] Update `user-info.js` with login/logout UI
- [ ] Test Google OAuth flow end-to-end
- [ ] Test GitHub OAuth flow end-to-end
- [ ] Test anonymous fallback still works
- [ ] Test credits persist across sessions for authenticated users

## Success Criteria
- Anonymous users can place pixels without signing in
- Google OAuth login/logout works
- GitHub OAuth login/logout works
- Authenticated user has stable identity (credits persist)
- Session persists across page refreshes (JWT cookie)
- No regression in anonymous flow

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| OAuth provider setup complexity (client ID/secret) | Low | Med | Document setup steps in README |
| NextAuth version breaking changes | Low | Med | Pin version; test before upgrade |
| SessionProvider SSR hydration issues | Med | Med | Wrap in client component boundary |

## Security Considerations
- NEXTAUTH_SECRET must be strong random string (32+ chars)
- OAuth callback URLs must be registered with providers
- JWT tokens are httpOnly cookies — no XSS exposure
- Rate limit keys use provider user ID — no spoofing possible
- CSRF protection built into NextAuth

## Rollback
Remove auth-options.js, NextAuth route, providers.js. Revert get-user-id.js to IP-only. Revert user-info.js to remove login buttons. App works fully anonymous.
