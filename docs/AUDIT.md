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

## 7. Society slice (commit after `0c26814`)

**Database** — `supabase/migrations/20261016000003_gistcity_society.sql` (+ `supabase/tests/society_test.sql`, PASS on PostgreSQL 17): institutional accounts for the college, hospital, dealership, church and government; hospital services and medicines as catalog items bought through the existing `purchase_item()`; `courses`, `enrollments`, `exam_log`, `certificates` (issued only by `school_take_exam()` after `school_attend_class()` has recorded the required classes; `verify_certificate()` for third parties); `vehicle_models`, `vehicles`, `vehicle_access` with `buy_vehicle()` (checks the driver's-licence certificate server-side, debits once under an idempotency key, credits the dealership), `park_vehicle()`, `vehicle_share()`, `vehicle_can_drive()`; government tables `gov_config`, `gov_departments`, `gov_positions`, `gov_steps`, `gov_applications`, `gov_employees`, `gov_audit_log`, `gov_interview_questions` with the 10-step workflow (`gov_apply` → `gov_process`/`gov_advance`/`gov_reject` → `gov_attend_interview` → `gov_accept_offer`) and `gov_work_shift()` paid from the **payroll** account with audit rows; `churches`, `church_members`, `church_services`, `church_attendance`, `church_expenses`, `church_salary_agreements` with `church_join/leave/attend`, `church_offer()` (atomic transfer into the church account), `church_register()`, `church_pay()` (authorised expenses) and `church_salary()` (pastor agreement); `city_stats()` for the presence tiers; RLS on every table, SECURITY DEFINER RPCs, no client-supplied prices, balances or certificates.

**Client** — `src/game/civic.ts` (Civic Ring exteriors), `interiors.ts` (room builder: college, dealer, hospital, secretariat, chapel), `vehicles.ts` (owned/parked/driven cars, traffic AI, remote cars), `daycycle.ts`, `bake.ts` (static batching), `src/net/society.ts` (online RPC path + offline practice fallback), `src/ui/society-ui.ts` (school/dealer/hospital/government/church/online/vehicles panels, countdowns patched in place so buttons never detach mid-tap).

**Verified headless (Chromium, SwiftShader, practice mode)** — enrol → 3 classes → exam → `graduate` achievement → licence; dealer refuses unlicensed buyers, sells once licensed (`wheels` achievement, car spawns parked at the dealer); enter / drive / park gating ("stop the car first"); hospital treatment debits 2,500 G and heals; church join; government employment desk; presence/vehicle panels; day/dusk/night lighting; mobile (Pixel 7 emulation): 153 draw calls / 128k triangles, desktop city 300 calls / 185k triangles (was 855 calls before batching).

**Not verified** — against a live Supabase project (migrations not yet applied: no access token was available); driving *feel* on a real phone (headless runs at ~3 fps); government salaries are paid per worked shift (`gov_work_shift`), not by a scheduled payroll run yet.

## 8. Phase 1 — core gameplay repair & human behaviour (this commit)

**Defects found by the new headless gameplay test** (`scripts/game-smoke.mjs`, 38 checks):
- **Slow-motion at low frame rates.** `frame()` clamped `dt` to 0.05 s (20 fps floor), so on
  weaker devices the whole simulation ran in slow motion — characters crawled, cars barely
  moved. This is the "they don't walk or run like a human / can't drive" symptom.
  **Fixed:** `dt` is now honest down to ~4 fps (clamp 0.25 s) and the movement / vehicle
  physics run in ≤5 substeps of 0.05 s so collisions stay stable at any frame rate.
- **Momentum leak while asleep / seated** (found by writing the "no walking while sleeping"
  assertion): the new integration path could apply leftover velocity. Guarded, and
  `stopSitting` / `stopSleeping` now clear velocity.
- Interactions showed a menu but **nothing ever responded**: `gistWith()` printed one canned
  NPC line with no way to answer.

**Implemented**
- `src/game/activity.ts` — explicit activity state machine
  (IDLE / WALKING / RUNNING / SITTING / EATING / DRINKING / SLEEPING / WORKING /
  DRIVING / TALKING / CHANGING_CLOTHES / INTERACTING) with compatibility rules
  (no walking while sleeping, no driving outside a car, eating keeps your seat,
  WORKING overlays locomotion for hustles), timed sequences that end themselves,
  and an activity chip in the HUD + presence broadcast.
- `src/game/dialogue.ts` + HUD dialogue card + `cloud.say` realtime channel:
  NPC conversations with **real response choices** (personas for traders, area youth,
  officials, church members, mechanics — 2-round exchanges, city tips, popularity/xp),
  player ↔ player talk with quick replies where **both sides respond** (their reply
  arrives live over the channel, shows as a speech bubble + toast).
- Paced EATING / DRINKING / INTERACTING sequences (2–4 s) with needs bars visibly
  recovering through the sequence instead of instant teleport-style effects.
- Private changing room: the wardrobe and the new GIST Fits changing booth curtain the
  world while the Style Studio is open (CHANGING_CLOTHES). Per the brief's safety rules
  this is privacy-realism, **not** explicit anatomy.
- Sit / sleep / drive / wake / park all report through the state machine; presence and
  the HUD chip show what the character is doing ("driving a Toks Corolla 2012" …).

**Tests performed** — `node scripts/game-smoke.mjs` (headless Chromium + SwiftShader,
practice mode): **38/38 pass** — boot & realistic GLB character; walk 3.3 m/s with walk
anim; run with run anim; natural stop → idle; no walking through solid objects;
sit/stand; EATING sequence (cash −500, hunger +15); DRINKING sequence; sleep (lying pose,
energy recovers, cannot walk while asleep, clean wake); buy car → enter (DRIVING, avatar
seated inside) → drive 13 m → must stop → park & persist; NPC conversation opens with
choices, picking one gets an actual reply, TALKING state + chip, clean close; changing
room state + curtain; save + vehicle persistence. Also `npm run typecheck` and
`npm run build` pass.

**Remaining defects** — presence position sync is still client-trusted (server movement
sanity check planned with the social phase); emoji icons need a system emoji font in the
headless container only (real browsers are fine).

**Infrastructure still required** — none for this phase (works online and offline).

## 9. Phase 2 — public citizen pages & private DMs (this commit)

**Server** (`supabase/migrations/20261017000004_gistcity_social.sql`, re-runnable):
- `profile_media` (public photos ≤24 & clips ≤8 per page), `follows`, `blocks`,
  `reports` (rules-first moderation, staff-readable), `dm_conversations`
  (canonical pair, one thread per two citizens), `dm_messages` (membership-checked,
  idempotent `client_key`, optional attachment under the conversation folder),
  `rate_limits` (per-minute buckets: 30 DMs, 5 reports, 60 follows…).
- SECURITY DEFINER RPCs: `profile_page` (identity, bio, occupation from gov job,
  gallery, follower counts, follow/block/DM relationship), `follow_toggle`,
  `block_toggle` (removes follows both ways, stops DMs both ways — the blocked
  side is never told), `report_user`, `media_add`/`media_delete` (path must be in
  your own folder), `dm_start`, `dm_send`, `dm_threads`, `dm_history`,
  `dm_mark_read`. Every table is RLS-locked and direct writes are revoked.
- Storage buckets & policies: `profile-media` (public read, owner-scoped writes)
  and `dm-media` (private; reads/writes only for the two conversation members).
- `dm_messages` joins `supabase_realtime` for live delivery.

**Client**:
- `src/net/social.ts` — `Social` interface with `CloudSocial` (RPC + storage +
  realtime inbox) and `LocalSocial` (practice mode: local citizens with seeded
  gallery photos, a local mailbox with human-timed replies, uploads capped).
- `src/ui/social-ui.ts` — full citizen page (picture/initial avatar, display name,
  @username, occupation, bio, followers/following/posts, photo & clip gallery,
  Follow / Message / Block / Report, and on your own page: edit bio, add photo,
  add clip, delete media) + the DM panel (thread list with unread badges, chat
  bubbles with timestamps and photo attachments, composer, live replies, toast +
  badge on incoming mail). Tap any citizen in the world → their page → Message.
  Your own page & inbox are on the Life panel and the new DM button.

**Tests performed**:
- `node scripts/db-tests.mjs` (embedded PostgreSQL, same migrations + suites as
  CI's `run_local.sh`): **9/9 steps pass** — all migrations incl. idempotent
  re-apply, economy tests, society tests, and the new `social_test.sql`
  (4 users, profile pages, media ownership rules, follow graph, block privacy &
  DM interdiction both ways, report validation + rate limit, DM membership/RLS,
  idempotent send, unread accounting, attachments confined to the conversation,
  signed-out rejection).
- `node scripts/game-smoke.mjs`: **47/47 checks pass** — the Phase-1 gameplay
  suite plus: tapping a citizen opens their public page with their photo
  gallery; following works; DM opens with a composer; a sent message appears;
  **the other side actually replies** ("E choke 😂"); my page shows upload
  controls; an uploaded photo renders in my gallery; blocking disables messaging.

**Remaining defects** — profile pages don't yet show level/popularity from
`gist_players` (public_profiles still does); DM attachments render only images
(clips in DMs are permitted as files but preview as photos); presence position
sync is still client-trusted (server movement check pending).

**Infrastructure still required** — apply the migration to the Supabase project
with `supabase db push` (no deploy token in this environment), enable realtime
for `dm_messages` (handled by the migration's publication guard), and create the
two storage buckets (also handled by the migration when storage exists).

## 10. Phase 3 — family, marriage & accelerated ageing (this commit)

**Server** (`supabase/migrations/20261018000005_gistcity_family.sql`, re-runnable):
- `characters` (players + newborns, parents linked), `marriages` (proposal →
  both sign the **marriage agreement** → active; either partner may end it),
  `births` (the daily registry; one newborn per couple per game-day).
- Accelerated age model (mirrored in `src/game/family.ts`): 1 game-day = 24 real
  minutes, 1 game-month = 7 game-days; month 0→1 = 0→10 y/o, month 1→12 = 10→25
  y/o, then +1 year per month. `age_years()` / `born_at_for_age()` /
  `character_age()`; new players start at 18 via a profiles trigger (existing
  accounts backfilled).
- **Age gates** as table triggers, not UI-only: school enrolment 16+, government
  applications 18+, vehicle ownership 18+ (`GC_TOO_YOUNG` — a 10 y/o cannot be a
  car owner or a house seller; property eligibility lands with the registry).
- RPCs: `character_me`, `marriage_propose` (adults only, no blocks, single),
  `marriage_sign` (both signatures required), `marriage_end`, `marriages_mine`,
  `family_tree` (spouse/children/parents with ages), `childbirth` — the abstract
  **family room** (enter → fade to black → newborn registered to both parents,
  registry fee through the ledger), `birth_registry` (every baby **matched to the
  parents who gave birth that day**), and `profile_page` now includes age.

**Client**:
- `src/game/family.ts` (the age math), `src/net/family.ts` (Cloud RPCs + local
  practice save with the same rules), `src/ui/family-ui.ts` — the Civil Registry
  panel: propose with an editable marriage agreement, dual-signature status,
  withdraw/end, the family tree, and today's birth registry.
- In-world: the `gov-registry` desk is open (no longer "coming soon"), and the
  hospital has the **Maternity room: start a family** action — the family-room
  scene fades to black (`#fade`), stays abstract and non-explicit per the
  brief's safety rules, and announces the newborn. The Life panel and citizen
  pages show age; marriage & family is removed from the map's "coming soon".

**Tests performed** — `node scripts/db-tests.mjs`: **11/11 steps pass** including
the new `family_test.sql` (age-maths boundaries 0/10/≈11.4/25/26, inverse
`born_at_for_age`, 18 y/o at signup, GC_TOO_YOUNG gates at 10 and 17 for
vehicles/gov/school-with-16-min, self/child/already-married proposals, dual
signature activation, family tree both sides, childbirth matching to both
parents, one-per-day rule, registry listing, leaving a marriage, RLS privacy,
and an economy supply audit at the end). `node scripts/game-smoke.mjs`:
**59/59 checks pass** — age 18 on Life, proposal → both signatures → active,
tree shows spouse, family room asks the name, fade to black in/out, newborn in
today's registry matched to both parents, newborn in the tree, second birth
rejected with the server message.

**Remaining defects** — marrying an offline player waits for their signature
(realtime for marriage events not wired — the registry panel refreshes itself);
children exist as registry records (they cannot yet be played or claimed by
their own accounts); inheritance/wills not implemented.

**Infrastructure still required** — apply the migration to the Supabase project
(`supabase db push`).
