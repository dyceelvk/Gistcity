# GISTCITY — Your City. Your Style. Your Story.

A persistent, multiplayer 3D Nigerian life-simulation world in the browser.
Register as a citizen, create the character everyone else will see, walk a
Nigerian-inspired city, hustle for **G** (the city's currency), eat, drink,
rest in your flat, buy fits, sit on a bench and gist with real people.
**Powered by Riel Inc.**

> **Status:** Phases 1–2 of the GISTCITY plan (foundation, accounts, character
> creation, persistence, server-authorised economy, needs, furniture use,
> contextual interactions) are implemented and tested. Later phases (social
> graph & messaging, vehicles, education, government, businesses, property,
> family, church) are **not built yet** — see `docs/AUDIT.md` for the audit,
> what works, what is incomplete and the phase-by-phase plan.

GISTCITY is *not* GTA: no weapons, no crime loop. It is a lifestyle and social
world with its own identity.

**📱 Android APK (the product):** https://github.com/dyceelvk/Gistcity/releases/latest/download/GistCity.apk
— built and signed by `.github/workflows/build-android.yml` on every push to `main`
(Capacitor shell, game assets bundled in the APK, backend = Supabase).

**🌐 Web build:** https://dyceelvk.github.io/Gistcity/ — the same game in a browser;
it is also where verification / password-reset email links land (Site URL) and the
desktop test build. Production web hosting is Cloudflare Pages (see below).

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

- **Realistic human characters** — real scanned-quality bodies baked from
  [MakeHuman](http://www.makehumancommunity.org/) (CC0 assets) with the
  `tools/mh_export.py` pipeline: an African female and male base with slim /
  athletic / curvy body morphs and oval / round / square face morphs, 12 real
  hair meshes (afro, waves, braids, locs, bob, ponytail, long, …), eyes, brows
  and lashes, four shoe models, a 53-bone game rig and motion-captured
  walk / run / idle clips. Clothes and accessories are **tailored at runtime**
  (`src/game/tailor.ts` cuts tees, shirts, hoodies, blazers, kaftans, trousers,
  shorts, joggers and skirts directly from the body so every outfit fits every
  body). Players use the ~27k-triangle body; pedestrians use a 3k-triangle
  version. The character library is a one-time ~5.5 MB download (cached by the
  service worker); if it fails to load, the game falls back to the lighter
  procedural avatar in `src/game/avatar.ts`.
- **Character creator (Style Studio)** — skin tone, feminine/masculine build,
  body type, face shape, 12 hairstyles incl. gele, braids and locs, hair colour,
  beard, lips/makeup, shoe style, tops
  (tee, shirt, hoodie, crop, blazer, native/senator), bottoms (trousers, shorts,
  joggers, skirt), shoe colour, accessories (cap, shades, chain, bag, watch,
  earrings), one-tap vibes (Casual, Street, Baddie, Luxury, Corporate). Change
  anything, any time — from the HUD or your wardrobe.
- **Third-person controller** — walk/run with animation, orbit camera with
  building occlusion, circle-vs-box collision with sliding, touch joystick.
- **Gist City** — roundabout + GIST monument, zebra crossings, danfo, keke, parked
  cars, compounds with gates, water tanks, gens, signboards with real text:
  **GIST Fits** (clothing store), **Gist Heights** (your flat — enterable interior),
  **Suya Spot**, **Mama Nkechi Kitchen**, **Vibe Lounge**, **The Pitch**
  (penalty-shootout minigame), **Hustle Hub**, **QuickCash POS**, market stalls.
- **Accounts** — email + password registration with a unique username, display
  name, confirm-password, Terms / Privacy / age (16+) acceptance, email
  verification, sign in / sign out, password reset, change password and
  persistent sessions. Character creation is mandatory on first sign-in; the
  saved look is what other players see.
- **Economy in G** — server-authorised, atomic, idempotent ledger (see below).
  Hustles (dispatch runs, market runs, POS shifts with a timing minigame, penalty
  shootout side bets) pay from the city **payroll** account; store purchases are
  debited once and recorded in your inventory; food, drinks and lounge entry are
  consumables with effects; gifts to other citizens and donations are transfers.
- **Needs** — hunger, thirst and energy (0–100) fall slowly in real time (and a
  capped amount while you are away). Low needs show an indicator and slow you
  down a little; nothing can kill a character. Eat at Suya Spot / Mama Nkechi
  Kitchen, drink, and sleep in your flat (a mattress is always there; the Queen
  Bed from the store replaces it).
- **Contextual actions** — walk up to anything and a menu shows only what you can
  actually do there: sit on benches / sofa / dining chairs, sleep in bed, order
  from a menu, start a shift, greet / view profile / send G to a real player,
  gist with NPCs. Keyboard `E` or `1–6`, or tap on mobile.
- **The Civic Ring (society slice)** — a second ring of purposeful buildings,
  each with an enterable interior, staff and real services:
  **Unity College** (enrol, sit timed classes in a classroom, take the exam,
  receive a server-issued certificate — e.g. the *GistCity Driver's Licence*),
  **Odogwu Motors** (showroom; the sales desk only sells to licence holders;
  bought vehicles are owned, insured with a plate and spawn parked outside),
  **vehicles you can drive** (enter, drive with keyboard or touch, park, share
  keys; traffic cars, danfo and keke on the ring road), **GistCity General
  Hospital** (reception, doctor's treatment, ward), **Government Secretariat**
  (employment desk with the 10-step hiring workflow, departments, payroll),
  **Grace Chapel** (join/leave, seats, hourly services, voluntary offering basket,
  church account and expenses), plus **Unity Park**, a gym, and a bank and
  housing market marked *opening soon*. A **day/night cycle** (24 game-hours ≈
  48 real minutes) lights windows and street lamps at dusk; the **City** HUD tab
  lists who is registered / online / in your area / in an activity.
  Everything works offline in practice mode and goes through the
  `20261016000003_gistcity_society.sql` RPCs when Supabase is connected.
- **Life stats** — level/XP, popularity, reputation, hustle, achievements.
- **NPCs** who walk the streets and gist with you in Pidgin.
- **Multiplayer** (with Supabase) — other citizens rendered live in the city via
  Realtime presence/broadcast (position, animation and sitting pose), waves,
  public profiles, live leaderboard.
- **Practice mode** — without a backend the game runs offline on this device
  with the same rules, clearly labelled *Practice mode · offline*.

## Connect Supabase (accounts, economy, multiplayer)

1. Apply the migrations in `supabase/migrations/` **in order** to your Supabase
   project (paste into the SQL editor, or copy them into Crushly's
   `supabase/migrations/` folder so its `db-migrations.yml` workflow pushes them):
   - `20261014000001_gist.sql` — `gist_players` (saved game state, own-row RLS).
   - `20261015000002_gistcity_foundation.sql` — `economy_config`, `accounts`,
     `transactions` (the ledger), `profiles` (+ trigger that creates the profile
     and wallet on sign-up), `catalog_items`, `inventory`, `hustles`,
     `hustle_log`, the `public_profiles` and `gist_leaderboard` views and the
     RPCs the client calls: `username_available`, `me`, `my_wallet`,
     `purchase_item`, `complete_hustle`, `transfer_g`, `donate_g`,
     `economy_audit`.
2. **Authentication → Providers → Email**: keep *Confirm email* on. Disable
   anonymous sign-ins (the game no longer uses them). Set the Site URL / redirect
   URLs to where the game is hosted so verification and password-reset links
   land back in the game.
3. Put the public values in `.env` locally (copy `.env.example`) and in the GitHub
   secrets `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` for the workflows.

### How the G economy works

- Currency: **G**. The one-time initial allocation is **5,000,000,000,000 G**
  (`economy_config.total_supply`), minted once into the **Treasury** account and
  split by ledger transactions into **Payroll** (wages for hustles and, later,
  government jobs), **Development**, **Community** and **Starter pool**. These
  are institutional accounts — no player ever receives the supply. The split is
  documented in `economy_config.allocation` and can be changed by an admin with
  a new migration.
- Every new citizen receives a **10,000 G** starter grant from the starter pool.
- Every money movement is a row in `transactions` (source, destination, amount,
  reason, status, idempotency key, timestamp) written by the
  `post_transaction` function inside the database. Clients can only call the
  `SECURITY DEFINER` RPCs with a client-generated UUID idempotency key: a retry
  with the same key returns the original result (`replay: true`) and never
  charges twice. Balances can never go negative (check constraint + row locks).
- Prices come from `catalog_items`, pay from `hustles` — never from the client.
  `gist_players.cash` is only a mirror for the leaderboard.
- `select public.economy_audit()` verifies that the sum of all balances equals
  the supply and that no balance is negative.

### Database tests

`supabase/tests/run_local.sh` creates a throw-away database, applies every
migration twice (idempotency) and runs `supabase/tests/economy_test.sql` —
behavioural assertions for sign-up (profile + wallet + grant), RLS (players
cannot change roles, balances or other people's rows), purchases, replayed
purchases, insufficient funds, consumables, merchant credits, transfers,
donations, hustle pay and cooldowns, and the ledger audit. It runs in CI on
every change under `supabase/` (`.github/workflows/db-tests.yml`).

Realtime uses channel `gist:city` (presence + `pos`/`wave` broadcasts, ~8/s per
player). Nothing is persisted for it, so no extra tables.

## Deploy the web build — Cloudflare Pages

Create a Pages project named `gist` once (Workers & Pages → Create → Pages →
*Direct Upload*), add the four repository secrets listed in
`.github/workflows/deploy-pages.yml`, push to `main`. The workflow typechecks,
builds, refuses the deploy if a secret key reached the bundle, and publishes
`dist/`. Static assets are immutable-cached via `public/_headers`.

## Android

The APK is the primary deliverable. `build-android.yml` builds the web assets
with the `VITE_*` secrets, generates the Capacitor Android project, brands it
(`scripts/android-postsync.mjs`: launcher icons from `android-res/`, app name,
manifest flags), signs it with the release keystore from the
`ANDROID_KEYSTORE_*` secrets (falls back to debug signing when absent) and
publishes `GistCity.apk` as the latest GitHub Release. Package id
`com.rielinc.gistcity`, app name **GistCity**, min Android as per Capacitor 6
(API 22+), versionCode = 100 + build number.

Inside the app, account emails work without deep links: the player enters the
6-digit code from the verification / reset email (the email templates include
`{{ .Token }}`), or taps the link (which opens the web build) and then presses
*I tapped the link*.

Local build: `npm run build && npx cap add android && npx cap sync android &&
node scripts/android-postsync.mjs && npx cap open android`.

## Project layout

```
src/game/appearance.ts  appearance schema, presets, item catalogue
src/game/human.ts       realistic MakeHuman-based character runtime (morphs, hair, accessories, clips)
src/game/tailor.ts      runtime garment cutter (tops/bottoms lofted from the body mesh)
src/game/character.ts   makeCharacter(): Human when the library is loaded, Avatar fallback
src/game/avatar.ts      lightweight procedural human (fallback)
tools/mh_export.py      bakes public/characters/*.glb from a MakeHuman 1.2 data folder
src/game/world.ts       Gist City generator (buildings, props, zones, NPC paths)
src/game/interior.ts    your flat + furniture
src/game/game.ts        controller, interactions, jobs, apartment, sync, loop
src/game/jobs.ts        hustles · src/game/npc.ts pedestrians · src/game/camera.ts orbit cam
src/game/needs.ts       hunger / thirst / energy model · src/game/catalog.ts consumables
src/net/supabase.ts     auth, profile, economy RPC wrappers, cloud save, realtime presence, host bridge
src/net/economy.ts      the only place the game spends or earns G (server RPCs / offline practice)
src/ui/auth.ts          sign in · create account · verify · forgot / reset password
src/ui/hud.ts           HUD, action menu, needs, Style Studio, Store, Your Space, Jobs, Life, Rankings, Map, Account
supabase/migrations/    database schema (apply in order) · supabase/tests/ SQL test-suite
docs/AUDIT.md           architecture audit, feature status and the phase plan
```

## Roadmap

The GISTCITY plan is built in tested phases (details in `docs/AUDIT.md`):

1. ✅ Foundation — accounts, character creation, movement, interactions, needs
2. ✅ Persistence & economy — ledger in G, server-authorised purchases/pay, saves
3. ⏳ Social — friends, DMs with RLS, posts, blocks/reports, rate limits
   (presence tiers ✅, gifts/waves ✅, the rest pending)
4. ✅ Vehicles & dealership — ownership, licence-gated purchase, driving, traffic
5. ✅ Education & employment — timed classes, exams, server-issued certificates,
   government 10-step hiring queue paid from payroll (first positions)
6. ⏳ Businesses & property (bank and housing market are *opening soon*)
7. ⏳ Family (consent-based marriage, family records, age progression)
8. ✅ Church — join/leave, seats, hourly services, offerings, church account,
   expenses, pastor salary agreement and registration of new churches
9. ⏳ Polish — day/night ✅, static batching/LOD ✅, graphics settings, more districts

Places that are planned but not built yet are listed on the map as **coming soon**.

## Credits

- Character bodies, hair, eyes, shoes and the game rig are derived from the
  [MakeHuman](http://www.makehumancommunity.org/) 1.2 asset library, released
  under **CC0 1.0** (public domain). Thank you to the MakeHuman community.
- Everything else (city, clothing, UI, code) is original to this repository.
