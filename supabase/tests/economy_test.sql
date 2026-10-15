-- Behavioural tests for the GistCity foundation migration.
-- Run on a scratch database after local_auth_stub.sql + the migrations:
--   psql -d gist_test -v ON_ERROR_STOP=1 -f supabase/tests/economy_test.sql
-- Every block raises if an expectation fails; the last line prints PASS.

\set ON_ERROR_STOP on
\set QUIET on

create or replace function pg_temp.assert(cond boolean, msg text) returns void language plpgsql as $$
begin if not cond then raise exception 'ASSERTION FAILED: %', msg; end if; end $$;

-- helpers to act as a signed-in user through RLS
create or replace function pg_temp.login(u uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', u::text, false);
  execute 'set role authenticated';
end $$;
create or replace function pg_temp.logout() returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claim.sub', '', false);
end $$;

-- ---------------------------------------------------------------- registration
select pg_temp.assert(username_available('ada_lagos'), 'fresh username is available');
select pg_temp.assert(not username_available('admin'), 'reserved username is not available');
select pg_temp.assert(not username_available('Ab'), 'too-short username rejected');
select pg_temp.assert(not username_available('has space'), 'invalid characters rejected');

insert into auth.users (id, email, raw_user_meta_data) values
  ('11111111-1111-1111-1111-111111111111', 'ada@example.com',  '{"username":"Ada_Lagos","display_name":"Ada","tos_accepted":true,"privacy_accepted":true,"age_confirmed":true}'),
  ('22222222-2222-2222-2222-222222222222', 'bayo@example.com', '{"username":"bayo","display_name":"Bayo","tos_accepted":true,"privacy_accepted":true,"age_confirmed":true}'),
  ('33333333-3333-3333-3333-333333333333', 'dup@example.com',  '{"username":"ada_lagos","display_name":"Impostor","tos_accepted":true,"privacy_accepted":true,"age_confirmed":true}');

select pg_temp.assert((select username::text from profiles where id = '11111111-1111-1111-1111-111111111111') = 'ada_lagos', 'username stored lower-case');
select pg_temp.assert((select username::text from profiles where id = '33333333-3333-3333-3333-333333333333') like 'citizen_%', 'duplicate username at signup falls back to a generated one');
select pg_temp.assert(not username_available('ADA_LAGOS'), 'availability check is case-insensitive');
select pg_temp.assert((select tos_accepted_at is not null and privacy_accepted_at is not null and age_confirmed from profiles where id = '11111111-1111-1111-1111-111111111111'), 'consents recorded');
select pg_temp.assert((select balance from accounts where owner_id = '11111111-1111-1111-1111-111111111111' and kind = 'player') = 10000, 'starter grant credited');
select pg_temp.assert((select balance from accounts where code = 'starter_pool') = 100000000000 - 3 * 10000, 'starter grants came out of the pool, not minted');
select pg_temp.assert((economy_audit()->>'ok')::boolean, 'supply still balances after signups');

-- ------------------------------------------------------------------- RLS: Ada
select pg_temp.login('11111111-1111-1111-1111-111111111111');
select pg_temp.assert((select count(*) from profiles) = 1, 'a player only reads their own profile row');
select pg_temp.assert((select count(*) from public_profiles) = 3, 'public_profiles view exposes everyone''s public columns');
select pg_temp.assert((select (me()->>'balance')::bigint) = 10000, 'me() returns balance');

-- cannot grant yourself a role, touch balances, or write inventory
do $$ begin
  update profiles set role = 'admin' where id = auth.uid();
  perform pg_temp.assert(false, 'role update should be denied');
exception when insufficient_privilege then null; end $$;
select pg_temp.assert((select role from profiles where id = auth.uid()) = 'player', 'role unchanged');
update profiles set display_name = 'Ada ✨' where id = auth.uid();
select pg_temp.assert((select display_name from profiles where id = auth.uid()) = 'Ada ✨', 'display name change applied');

do $$ begin
  update accounts set balance = 999999999 where owner_id = auth.uid();
  perform pg_temp.assert(false, 'balance update should be denied');
exception when insufficient_privilege then null; end $$;
do $$ begin
  insert into inventory (user_id, item_id) values (auth.uid(), 'acc-chain');
  perform pg_temp.assert(false, 'inventory insert should be denied');
exception when insufficient_privilege then null; end $$;
do $$ begin
  insert into transactions (to_account, amount, reason) values ((select id from accounts where owner_id = auth.uid()), 5, 'x');
  perform pg_temp.assert(false, 'transaction insert should be denied');
exception when insufficient_privilege then null; end $$;
do $$ begin
  perform post_transaction(null, null, 1, 'x', '{}', null, null);
  perform pg_temp.assert(false, 'post_transaction must not be callable by players');
exception when insufficient_privilege then null; end $$;

-- -------------------------------------------------------------- purchases
-- Ada buys a cap (1,500 G)
select pg_temp.assert((purchase_item('acc-cap', 'aaaaaaaa-0000-0000-0000-000000000001')->>'ok')::boolean, 'purchase succeeds');
select pg_temp.assert((select (me()->>'balance')::bigint) = 8500, 'balance debited');
select pg_temp.assert((select count(*) from inventory where item_id = 'acc-cap') = 1, 'item in inventory');
-- replay with the same idempotency key: no second charge
select pg_temp.assert((purchase_item('acc-cap', 'aaaaaaaa-0000-0000-0000-000000000001')->>'replay')::boolean, 'replay detected');
select pg_temp.assert((select (me()->>'balance')::bigint) = 8500, 'replay did not charge again');
-- buying the same durable item again with a new key is refused
select pg_temp.assert((purchase_item('acc-cap', 'aaaaaaaa-0000-0000-0000-000000000002')->>'error') = 'GC_ALREADY_OWNED', 'duplicate durable purchase refused');
-- cannot afford
select pg_temp.assert((purchase_item('native-gold', 'aaaaaaaa-0000-0000-0000-000000000003')->>'error') = 'GC_INSUFFICIENT_FUNDS', 'insufficient funds refused');
select pg_temp.assert((select (me()->>'balance')::bigint) = 8500, 'failed purchase did not debit');
-- consumable food: charged, effects returned, not stored
select pg_temp.assert((purchase_item('food-suya', 'aaaaaaaa-0000-0000-0000-000000000004')->'effects'->>'hunger')::int = 35, 'consumable returns effects');
select pg_temp.assert((select count(*) from inventory where item_id = 'food-suya') = 0, 'consumable not added to inventory');
select pg_temp.assert((select (me()->>'balance')::bigint) = 8000, 'food charged');
-- unknown item
do $$ begin
  perform purchase_item('nope', 'aaaaaaaa-0000-0000-0000-000000000005');
  perform pg_temp.assert(false, 'unknown item must raise');
exception when others then perform pg_temp.assert(sqlerrm = 'GC_UNKNOWN_ITEM', 'unknown item error code'); end $$;

-- merchant received the money
select pg_temp.assert((select balance from accounts where code = 'biz:gist_fits') = 1500, 'GIST Fits credited');
select pg_temp.assert((select balance from accounts where code = 'biz:suya_spot') = 500, 'Suya Spot credited');

-- ------------------------------------------------------------- transfers
select pg_temp.assert((transfer_g('bayo', 1000, 'for your transport', 'bbbbbbbb-0000-0000-0000-000000000001')->>'ok')::boolean, 'gift succeeds');
select pg_temp.assert((transfer_g('bayo', 1000, 'again?', 'bbbbbbbb-0000-0000-0000-000000000001')->>'ok')::boolean, 'gift replay ok');
select pg_temp.assert((select (me()->>'balance')::bigint) = 7000, 'gift replay did not double-charge');
select pg_temp.assert((transfer_g('ada_lagos', 10, null, 'bbbbbbbb-0000-0000-0000-000000000002')->>'error') = 'GC_SELF_TRANSFER', 'self transfer refused');
select pg_temp.assert((transfer_g('nobody', 10, null, 'bbbbbbbb-0000-0000-0000-000000000003')->>'error') = 'GC_UNKNOWN_USER', 'unknown recipient refused');
select pg_temp.assert((transfer_g('bayo', 1000000, null, 'bbbbbbbb-0000-0000-0000-000000000004')->>'error') = 'GC_INSUFFICIENT_FUNDS', 'cannot gift more than you have');
select pg_temp.assert((donate_g('community', 500, 'cccccccc-0000-0000-0000-000000000001')->>'ok')::boolean, 'donation to community fund');
select pg_temp.assert((donate_g('treasury', 500, 'cccccccc-0000-0000-0000-000000000002')->>'error') = 'GC_UNKNOWN_ACCOUNT', 'cannot donate to the treasury');

-- ---------------------------------------------------------------- hustles
select pg_temp.assert((complete_hustle('dispatch', 'dddddddd-0000-0000-0000-000000000001')->>'paid')::bigint = 1500, 'hustle paid from payroll');
select pg_temp.assert((complete_hustle('dispatch', 'dddddddd-0000-0000-0000-000000000002')->>'error') = 'GC_COOLDOWN', 'cooldown enforced');
select pg_temp.assert((complete_hustle('dispatch', 'dddddddd-0000-0000-0000-000000000001')->>'replay')::boolean, 'hustle replay ok');
select pg_temp.assert((select (me()->>'balance')::bigint) = 8000, 'balance after hustle = 7000 - 500 + 1500');
select pg_temp.assert((select balance from accounts where code = 'payroll') = 500000000000 - 1500, 'payroll debited');

-- Ada sees only her own transactions; Bayo's view differs
select pg_temp.assert((select count(*) from transactions) = 6, 'ada sees her 6 transactions (grant, cap, suya, gift, donation, hustle)');
select pg_temp.logout();
select pg_temp.login('22222222-2222-2222-2222-222222222222');
select pg_temp.assert((select count(*) from transactions) = 2, 'bayo sees his 2 transactions (grant, gift received)');
select pg_temp.assert((select (me()->>'balance')::bigint) = 11000, 'bayo received the gift');
select pg_temp.assert((select count(*) from inventory) = 0, 'bayo cannot see ada''s inventory');
select pg_temp.logout();

-- ---------------------------------------------------------------- signed out
do $$ begin
  perform set_config('request.jwt.claim.sub', '', false);
  perform purchase_item('acc-cap', 'eeeeeeee-0000-0000-0000-000000000001');
  perform pg_temp.assert(false, 'signed-out purchase must fail');
exception when others then perform pg_temp.assert(sqlerrm = 'GC_NOT_SIGNED_IN', 'signed-out error code'); end $$;

-- ---------------------------------------------------------------- invariants
select pg_temp.assert((economy_audit()->>'ok')::boolean, 'no G was created or destroyed');
select pg_temp.assert((select count(*) from transactions where idempotency_key is not null) = (select count(distinct idempotency_key) from transactions where idempotency_key is not null), 'idempotency keys unique');
select pg_temp.assert(not exists (select 1 from accounts where balance < 0), 'no negative balances');

\echo PASS: all GistCity economy & profile tests passed
