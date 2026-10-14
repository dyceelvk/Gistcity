# GIST — Your City. Your Style. Your Story.

A 3D Nigerian life-simulation game. Create a GistCitizen, dress them your way,
walk a Nigerian-inspired city, hustle for Gist Cash, buy fits, furnish your flat
at Gist Heights, gist with people — and see other players in the city.
**Powered by Crushly.**

GIST is *not* GTA: no weapons, no crime loop. It is a lifestyle and social game.

**▶ Play it now:** https://dyceelvk.github.io/Gistcity/ — open on your Android phone and choose
*Add to Home screen* to install it like an app. (This is the preview link; production
hosting is Cloudflare Pages, see below.)

| Piece | Tech |
| --- | --- |
| Game | TypeScript + [Three.js](https://threejs.org) + Vite. Runs in any browser, in a Capacitor Android shell, or inside the Crushly app's WebView. |
| Accounts, saves, leaderboard, presence | Supabase (Auth, Postgres + RLS, Realtime) — the same project Crushly already uses. |
| Hosting & CDN | Cloudflare Pages (`.github/workflows/deploy-pages.yml`). |
| Android | Capacitor (`capacitor.config.ts`, `.github/workflows/build-android.yml`). |

No secrets live in this repo. The client only ever receives the Supabase
**anon / publishable** key, and the build refuses to start with a secret key.

## Play it locally

```bash
npm install
npm run dev          # http://localhost:5173
```

Controls — desktop: **W A S D** move · **Shift** run · **E / Space** interact ·
drag to look · scroll to zoom · **Esc** closes panels.
Mobile: left-thumb joystick, drag the right side to look, big green button to
interact, **RUN** toggle.

Without Supabase configured the game runs in **offline mode**: the character,
wardrobe, apartment and progress are saved in the browser (`localStorage`).

## What's in the prototype

- **Character creator (Style Studio)** — skin tone, face shape, 8 hairstyles incl.
  gele, braids and locs, hair colour, beard, lips/makeup, tops (tee, shirt,
  hoodie, crop, blazer, native/senator), bottoms (trousers, shorts, joggers,
  skirt), shoe colour, accessories (cap, shades, chain, bag, watch, earrings),
  one-tap vibes (Casual, Street, Baddie, Luxury, Corporate). Change anything,
  any time — from the HUD or your wardrobe.
- **Third-person controller** — walk/run with animation, orbit camera with
  building occlusion, circle-vs-box collision with sliding, touch joystick.
- **Gist City** — roundabout + GIST monument, zebra crossings, danfo, keke, parked
  cars, compounds with gates, water tanks, gens, signboards with real text:
  **GIST Fits** (clothing store), **Gist Heights** (your flat — enterable interior),
  **Suya Spot**, **Mama Nkechi Kitchen**, **Vibe Lounge**, **The Pitch**
  (penalty-shootout minigame), **Hustle Hub**, **QuickCash POS**, market stalls.
- **Economy** — Gist Cash; hustles (dispatch runs, market runs, POS shifts with a
  timing minigame); store purchases unlock styles; furniture appears in your flat.
- **Life stats** — level/XP, popularity, reputation, hustle, achievements.
- **NPCs** who walk the streets and gist with you in Pidgin.
- **Online** (when Supabase is configured) — anonymous or email sign-in, cloud
  save, live leaderboard, and other players rendered live in the city via
  Realtime presence/broadcast.

## Connect Supabase (cloud saves, leaderboard, multiplayer presence)

1. Apply the migration `supabase/migrations/20261014000001_gist.sql` to your
   Supabase project — copy it into Crushly's `supabase/migrations/` folder (the
   `db-migrations.yml` workflow pushes it) or paste it into the SQL editor. It
   creates `gist_players` (RLS: each user only reads/writes their own row) and
   the public `gist_leaderboard` view.
2. **Authentication → Providers → Anonymous sign-ins → enable** so progress syncs
   before the player gives an email. (Optional but recommended. Email magic
   links work either way; the Account panel lets a guest attach an email.)
3. Put the public values in `.env` locally (copy `.env.example`) and in the GitHub
   secrets `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` for the workflows.

Realtime uses channel `gist:city` (presence + `pos` broadcasts, ~8/s per player).
Nothing is persisted for it, so no extra tables.

> Prototype note: the economy is client-authoritative (the client writes its own
> cash). Before any real creator rewards, move the money-changing actions to
> Postgres RPCs / Edge Functions so rewards are granted server-side.

## Deploy the web build — Cloudflare Pages

Create a Pages project named `gist` once (Workers & Pages → Create → Pages →
*Direct Upload*), add the four repository secrets listed in
`.github/workflows/deploy-pages.yml`, push to `main`. The workflow typechecks,
builds, refuses the deploy if a secret key reached the bundle, and publishes
`dist/`. Static assets are immutable-cached via `public/_headers`.

## Android

Two options, both using the same `dist/`:

**A. Standalone APK (Capacitor)** — run the *Build Android APK* workflow
(`workflow_dispatch`) and download the artifact, or locally:

```bash
npm i -D @capacitor/cli @capacitor/core @capacitor/android
npm run build && npx cap add android && npx cap sync android && npx cap open android
```

**B. Inside the Crushly app** — add a "Gist" tab that renders the Pages URL in
`CrushlyApp/src/components/WebView.tsx` (already a dependency). To make the
player the same account as the Crushly member, post the session into the
WebView after it loads:

```ts
webviewRef.current?.postMessage(JSON.stringify({ type: 'gist:session', access_token, refresh_token }));
```

GIST calls `supabase.auth.setSession` with it and replies `{ type: 'gist:ready' }`
through `window.ReactNativeWebView.postMessage`.

## Project layout

```
src/game/appearance.ts  appearance schema, presets, item catalogue
src/game/avatar.ts      procedural customizable humanoid + walk/run animation
src/game/world.ts       Gist City generator (buildings, props, zones, NPC paths)
src/game/interior.ts    your flat + furniture
src/game/game.ts        controller, interactions, jobs, apartment, sync, loop
src/game/jobs.ts        hustles · src/game/npc.ts pedestrians · src/game/camera.ts orbit cam
src/net/supabase.ts     auth, cloud save, leaderboard, realtime presence, host bridge
src/ui/hud.ts           HUD, Style Studio, Store, Your Space, Jobs, Life, Rankings, Map
supabase/migrations/    database schema for the game
```

## Roadmap (next)

1. Swap the procedural avatar for rigged GLTF characters (same `Appearance`
   schema) served from Cloudflare; add idle/emote animations.
2. Server-authoritative economy (RPCs), daily hustles, Community Gist Challenges
   (scenario votes) and creator bonuses with eligibility checks.
3. Visiting friends' flats, chat bubbles between real players, more districts
   (Island / Mainland), day–night cycle.
