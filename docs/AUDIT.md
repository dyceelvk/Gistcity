# GISTCITY — repository audit & implementation plan

_Audit date: 15 October 2026 · audited commit `6f1b2d1` (realistic characters) · GistCity is operated by Riel Inc._

This document is the first deliverable of the GISTCITY brief: what the project
was before the GISTCITY work, what already worked, what was broken or missing
against the brief, the prioritised plan, and exactly what the first
implementation slice (this commit) changed. It is kept honest on purpose —
anything not listed under **Implemented** is not built yet.

---

## 1. Architecture summary (as found)

| Layer | What was there |
| --- | --- |
| Client | Vite 6 + TypeScript + three.js 0.170, no UI framework. Single page (`index.html`) with a DOM HUD over a WebGL canvas. PWA service worker, Capacitor config for Android, Crushly WebView bridge (`gist:session`). |
| Characters | MakeHuman-derived CC0 bodies baked to GLB by `tools/mh_export.py` (53-bone rig, walk/run/idle clips, morph targets), runtime garment tailoring (`tailor.ts`), procedural fallback avatar. |
| World | Procedural single district (`world.ts`): roundabout, store, suya spot, buka, lounge, pitch, hustle hub, POS stand, apartment interior (`interior.ts`). NPC pedestrians on paths. No day/night, no traffic AI, no gravity (flat ground, circle-vs-box colliders). |
| Backend | Supabase. One migration: `gist_players` (whole game state as JSON + mirrored cash, own-row RLS) and a `gist_leaderboard` view. |
| Auth | Automatic **anonymous sign-in** on load + magic-link email, `linkEmail` to upgrade a guest. No username, no password, no consent capture. |
| Multiplayer | Realtime channel `gist:city`: presence (name + appearance) and a `pos` broadcast every 120 ms. No server validation of anything. |
| Economy | **Client-authoritative.** `hud.ts buy()` subtracted the price locally and pushed the item into a local array; `game.ts spend()` and `jobs.ts reward()` changed `cash` on the client, then the whole state was upserted to `gist_players`. Currency "₦", start cash 5,000. |
| Interactions | One "interact" button for the nearest zone; one fixed action per zone. No sit/sleep/eat states, no contextual menus, no needs. |
| Deploy | GitHub Pages preview (`publish-preview.yml`), Cloudflare Pages (`deploy-pages.yml`), Android APK (`build-android.yml`), bundle secret check (`scripts/check-bundle-secrets.mjs`). |

## 2. What was working

- Realistic, customisable characters with proper walk/run/idle animation and runtime clothing; Style Studio with full appearance control.
- Third-person movement (keyboard + touch joystick), orbit camera with occlusion, collisions with sliding.
- A small but polished district with signed buildings, NPCs with Pidgin dialogue, apartment interior with furniture placement.
- Hustles with objectives and a timing minigame; penalty-shootout minigame; achievements, XP/levels.
- Cloud save of the game state, live leaderboard, other players visible via Realtime.
- CI: typecheck, build, secret check, Pages publish, Cloudflare deploy workflow, Android build.

## 3. Broken, incomplete or unsafe against the GISTCITY brief

1. **No real accounts.** Anonymous sessions by default; no username, display name, password, confirm password, ToS/privacy/age acceptance, email verification or password reset.
2. **Economy fully trusted the client.** Any player could set any balance or inventory by editing the save; prices lived in client code; no ledger, no idempotency, no audit trail, no institutional accounts. Currency was ₦, not G.
3. **Character creation was optional and local** (`localStorage` flag), not tied to the account.
4. **No needs system**, no sit/sleep/eat/drink states or animations, no contextual action menus; a single interact button.
5. **Multiplayer state was unverified** (and still is for position — see plan): no distinction between registered / online / in-area / in-activity beyond raw presence.
6. **Missing domains entirely:** friends, messages, posts, blocks/reports, vehicles, dealership, schools/certificates, government hiring/RBAC/payroll, businesses, property/access control, family/marriage/children/age progression, churches, events, hospitals, day/night, traffic, graphics settings, LOD/streaming.
7. **Tests:** none for the database or the economy.

## 4. Prioritised plan (phases)

| Phase | Scope | Status |
| --- | --- | --- |
| 1 Foundation | Registration/login/verification/reset/session, username availability, mandatory character creation, movement + poses (sit/sleep), collisions, contextual actions, needs, mobile UI | **Done (this commit)** |
| 2 Persistence & economy | Migrations with RLS, profiles, ledger in G with institutional accounts, server-authorised atomic idempotent purchases/pay/transfers/donations, inventory, saves, audit function, SQL test-suite + CI | **Done (this commit)** |
| 3 Social | Friends, DMs (RLS), public posts & media via signed URLs, blocks/reports, rate limits, rules-first moderation (AI only flags), presence tiers (registered / online / in-area / in-activity) | Not started |
| 4 Vehicles | Dealership, server-verified purchase & ownership, enter/drive/exit with animations and sync | Not started |
| 5 Education & employment | School enrolment, server-issued verified certificates, government 10-step hiring workflow with queue, payroll from the payroll account, RBAC roles/departments, audit logs | Not started |
| 6 Business & property | Business registration, employees, accounts, housing ownership and access control | Not started |
| 7 Family | Consent-based marriage, family records, newborns linked to parents, child protection, server-controlled single age-progression rate | Not started |
| 8 Church | Registration, pastor/staff, Church tab, seat reservation, offering basket (atomic donations), church account/budget/expenses, salary agreements | Not started |
| 9 Polish | Day/night, traffic, LOD/streaming, graphics settings, more districts (school, government office, hospital, church, dealership, bank — currently *coming soon* on the map) | Not started |

## 5. Implemented in this commit (Phases 1–2)

### Database (`supabase/migrations/20261015000002_gistcity_foundation.sql`)
- `economy_config`: currency **G**, `total_supply = 5,000,000,000,000`, documented `allocation` (Treasury 4.0 T = 80 %, Payroll 0.5 T = 10 %, Development 0.3 T = 6 %, Community 0.1 T = 2 %, Starter pool 0.1 T = 2 %), `starter_grant = 10,000`, `min_age = 16`, username rules and reserved names.
- `accounts` (player / treasury / payroll / development / community / starter_pool / business / church / sink) with `balance >= 0` check; one-time mint of the supply into Treasury and allocation by ledger transactions; merchant accounts for the city's businesses.
- `transactions` ledger: id, source, destination, amount, reason, status, idempotency key (unique), metadata, timestamp. Written only by `post_transaction()` (revoked from clients) under row locks.
- `profiles`: citext unique `username` (`^[a-z0-9_]{3,20}$`), `display_name`, `bio`, `role`, `status`, `tos_accepted_at`, `privacy_accepted_at`, `age_confirmed`, `character_ready`. Created by the `handle_new_user` trigger on `auth.users` together with the wallet and the starter grant; clients get column-level update rights only on `display_name`, `bio`, `avatar_url`, `character_ready`.
- `catalog_items` (wardrobe/furniture + consumables with `effects`), `inventory`, `hustles` pay table with cooldowns, `hustle_log`.
- RPCs (all `SECURITY DEFINER`, all keyed by a client UUID for idempotent replays): `username_available`, `me`, `my_wallet`, `purchase_item`, `complete_hustle`, `transfer_g`, `donate_g`, `economy_audit`. Error codes `GC_*` (insufficient funds, already owned, cooldown, unknown item/user/account, self transfer, not signed in).
- `public_profiles` view, rebuilt `gist_leaderboard` using wallet balances.

### Tests (`supabase/tests/`)
- `run_local.sh` creates a throw-away database, applies all migrations twice (idempotency) and runs `economy_test.sql`: sign-up trigger (lower-cased username, duplicate → `citizen_xxxxxxxx` fallback, consents, grant from the starter pool), RLS (own rows only, role change rejected, direct writes to accounts / inventory / transactions rejected, `post_transaction` not callable), purchases (debit, inventory, replay without double charge, already-owned, insufficient funds, consumables return effects, unknown item), merchant credits, transfers (self/unknown), donations, hustle pay + cooldown + replay, per-user ledger visibility, signed-out errors, audit (sum of balances == supply, no negatives). Runs in CI (`.github/workflows/db-tests.yml`).

### Client
- `src/net/supabase.ts`: password auth (sign up with username/display name/consents in metadata, sign in, resend verification, reset/update password, sign out, session restore), profile & economy RPC wrappers with transient retry, `MeData` bootstrap, presence with pose, `wave` broadcast.
- `src/ui/auth.ts`: sign in / create account (live username check, confirm password, age ≥ 16, Terms & Privacy links) / verify notice with resend / forgot & reset password. `public/terms.html`, `public/privacy.html`.
- `src/main.ts` boot flow: backend → session → auth screen if needed → `me()` → state built from the **server** wallet and inventory → mandatory character creation on first sign-in (`character_ready`) → game. No backend → labelled practice mode.
- `src/net/economy.ts`: the only code path that spends or earns G — server RPCs with idempotency keys online, same rules on the local save offline; server balance always replaces the local number.
- `src/game/needs.ts` + state: hunger / thirst / energy 0–100, slow real-time decay, capped offline catch-up, sleep regeneration, gentle speed penalty when critical, persisted.
- `src/game/catalog.ts`: consumables mirror (display only).
- Poses: `human.ts` layers a seated pose over the animation in character space (no accumulation on untracked bones); lying pose on the bed; remote players show the sitting pose.
- World: benches (park and pitch-side) expose seats; the flat always has a mattress (the store's Queen Bed replaces it), sofa and dining seats when owned.
- `src/game/game.ts`: contextual action menus (only actions that can run are shown; hotkeys `E`, `1–6`, tap), sit / stand, sleep / wake with overlay, order food & drink with effects, pay hustles through the server pay table, greet / view profile / send G to real players, waves from others, needs tick, broadcast pose.
- HUD: wallet in G, needs bars, Life panel with needs, Account panel (username, email + verification, change password, legal links, sign out), public profile card, amount dialog, map legend with **coming soon** entries for unbuilt places.
- Branding: *Powered by Riel Inc.* (README, package description, loading screen, auth screen, legal pages, in-game GIST monument).

### Verified
- `npm run typecheck`, `npm run build`, bundle secret check: pass.
- `supabase/tests/run_local.sh` on PostgreSQL 17: **PASS** (and a deliberately failing assertion makes it exit 1).
- Headless browser runs (desktop + 412×915 mobile): boot in practice mode with 10,000 G and ticking needs; sit on a bench (pose, seat snap, stand up); order suya + water (debit, hunger/thirst effects, achievement); sleep on the mattress (lying pose, energy regeneration, wake); character creation gate (cannot be dismissed before *ENTER GISTCITY*); store purchase through the economy facade; hustle payout; practice-mode account panel; map "coming soon" legend; persistence across reload; auth screen validation (username sanitising, password mismatch, consent, unreachable-server message).
- Not verified end-to-end against a live Supabase project (no project credentials in this environment): the SQL behaviour is covered by the database tests and the client wrappers mirror those contracts.

## 6. Known gaps carried into the next phases

- Position/animation updates are broadcast peer-to-peer via Realtime and not validated by a server; a server-side movement sanity check (speed/teleport limits) is planned with the presence tiers in Phase 3.
- The economy returns consumable *effects* to the client; needs themselves are stored in the player's saved state (a cheater could edit their own hunger but cannot create G, items, or affect anyone else).
- Face scan for character creation is not implemented (and will stay optional when it is).
- Day/night, traffic, gravity/stairs, LOD/streaming and graphics settings are Phase 9.
