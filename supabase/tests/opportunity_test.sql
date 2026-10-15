-- Behavioural tests for the GistCity opportunity migration (business permits,
-- car sales with escrow, investments, charity & player giving).
-- Run on a scratch database after the migrations:
--   psql -d gist_test -v ON_ERROR_STOP=1 -f supabase/tests/opportunity_test.sql

\set ON_ERROR_STOP on
\set QUIET on

create or replace function pg_temp.assert(cond boolean, msg text) returns void language plpgsql as $$
begin if not cond then raise exception 'ASSERTION FAILED: %', msg; end if; end $$;

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

-- ------------------------------------------------------------------ setup
insert into auth.users (id, email, raw_user_meta_data) values
  ('27111111-1111-1111-1111-111111111111', 'ode@test.dev', '{"username":"ode_test","display_name":"Ode","tos_accepted":true,"privacy_accepted":true,"age_confirmed":true}'),
  ('27222222-2222-2222-2222-222222222222', 'kemi@test.dev','{"username":"kemi_test","display_name":"Kemi","tos_accepted":true,"privacy_accepted":true,"age_confirmed":true}');

-- fund both wallets with real ledger transfers
select pg_temp.logout();
select pg_temp.assert((public.post_transaction(
  (select id from public.accounts where code = 'treasury'),
  (select id from public.accounts where owner_id = '27111111-1111-1111-1111-111111111111' and kind = 'player'),
  200000, 'test_grant', '{}', gen_random_uuid(), null)) > 0, 'funded ode');
select pg_temp.assert((public.post_transaction(
  (select id from public.accounts where code = 'treasury'),
  (select id from public.accounts where owner_id = '27222222-2222-2222-2222-222222222222' and kind = 'player'),
  200000, 'test_grant', '{}', gen_random_uuid(), null)) > 0, 'funded kemi');

-- ---------------------------------------------------------------- permits
select pg_temp.login('27111111-1111-1111-1111-111111111111');
do $$
declare w0 bigint; r jsonb;
begin
  select balance into w0 from public.accounts where owner_id = auth.uid() and kind = 'player';
  begin
    perform permit_buy('drug_lord', 'Bad Biz', gen_random_uuid());
    perform pg_temp.assert(false, 'unknown role must raise');
  exception when others then
    if sqlerrm not like '%GC_UNKNOWN_ROLE%' then raise; end if;
  end;
  begin
    perform permit_buy('trader', 'x', gen_random_uuid());
    perform pg_temp.assert(false, 'short business name must raise');
  exception when others then
    if sqlerrm not like '%GC_INVALID_NAME%' then raise; end if;
  end;
  r := permit_buy('trader', 'Ode Global Ventures', gen_random_uuid());
  perform pg_temp.assert((r->>'ok')::boolean, 'trader permit issued');
  perform pg_temp.assert((select balance from public.accounts where owner_id = auth.uid() and kind = 'player') = w0 - 25000, 'fee paid to the city');
  perform pg_temp.assert((select count(*) from biz_permits where owner_id = auth.uid() and role = 'trader') = 1, 'permit recorded');
  begin
    perform permit_buy('trader', 'Ode Global Ventures', gen_random_uuid());
    perform pg_temp.assert(false, 'second permit for the same role must raise');
  exception when others then
    if sqlerrm not like '%GC_ALREADY_PERMITTED%' then raise; end if;
  end;
end $$;
select pg_temp.assert((my_permits()->0->>'role') = 'trader', 'my_permits lists the role');

-- a child cannot buy a permit (and no money moves)
select pg_temp.logout();
update public.characters set born_at = now() - interval '10080 seconds'
 where owner_id = '27222222-2222-2222-2222-222222222222';
select pg_temp.login('27222222-2222-2222-2222-222222222222');
do $$
declare w0 bigint;
begin
  select balance into w0 from public.accounts where owner_id = auth.uid() and kind = 'player';
  begin
    perform permit_buy('car_dealer', 'Baby Motors', gen_random_uuid());
    perform pg_temp.assert(false, 'a child must not hold a business permit');
  exception when others then
    if sqlerrm not like '%GC_TOO_YOUNG%' then raise; end if;
  end;
  perform pg_temp.assert((select balance from public.accounts where owner_id = auth.uid() and kind = 'player') = w0, 'no money moved on rejection');
end $$;

-- ------------------------------------------------------- car dealer sales
select pg_temp.logout();
update public.characters set born_at = public.born_at_for_age(30)
 where owner_id = '27222222-2222-2222-2222-222222222222';
-- Ode's car (admin creates it; purchases normally go through the dealership RPC)
insert into public.vehicles (owner_id, model_id, color, plate)
values ('27111111-1111-1111-1111-111111111111', (select id from public.vehicle_models limit 1), '#123', 'GC-ODE-1');
select pg_temp.login('27111111-1111-1111-1111-111111111111');
do $$
declare v_car uuid; v_list uuid; r jsonb;
begin
  perform permit_buy('car_dealer', 'Ode Motors', gen_random_uuid());
  select id into v_car from public.vehicles where plate = 'GC-ODE-1';
  r := vehicle_list(v_car, 50000, gen_random_uuid());
  perform pg_temp.assert((r->>'ok')::boolean, 'car listed for sale');
  v_list := (r->>'id')::uuid;
  begin
    perform vehicle_buy_from(v_list, gen_random_uuid());
    perform pg_temp.assert(false, 'buying your own listing must raise');
  exception when others then
    if sqlerrm not like '%GC_SELF%' then raise; end if;
  end;
end $$;

select pg_temp.logout();
select pg_temp.login('27222222-2222-2222-2222-222222222222');
do $$
declare v_list uuid; r jsonb; w0 bigint; w1 bigint; v_fee bigint;
begin
  select id into v_list from public.vehicle_listings where status = 'open' limit 1;
  select balance into w0 from public.accounts where owner_id = auth.uid() and kind = 'player';
  select balance into w1 from public.accounts where owner_id = '27111111-1111-1111-1111-111111111111' and kind = 'player';
  r := vehicle_buy_from(v_list, gen_random_uuid());
  perform pg_temp.assert((r->>'ok')::boolean, 'bought the listed car');
  v_fee := greatest(1, (50000 * 500) / 10000);
  perform pg_temp.assert((select balance from public.accounts where owner_id = auth.uid() and kind = 'player') = w0 - 50000, 'buyer paid the price');
  perform pg_temp.assert((select balance from public.accounts where owner_id = '27111111-1111-1111-1111-111111111111' and kind = 'player') = w1 + 50000 - v_fee, 'seller received price minus market fee');
  perform pg_temp.assert((select owner_id from public.vehicles where plate = 'GC-ODE-1') = auth.uid(), 'ownership transferred');
  perform pg_temp.assert((select status from public.vehicle_listings where id = v_list) = 'sold', 'listing closed');
end $$;

-- no permit, no listing
select pg_temp.logout();
select pg_temp.login('27222222-2222-2222-2222-222222222222');
do $$
declare v_car uuid;
begin
  select id into v_car from public.vehicles where owner_id = auth.uid() limit 1;
  begin
    perform vehicle_list(v_car, 30000, gen_random_uuid());
    perform pg_temp.assert(false, 'listing without a car_dealer permit must raise');
  exception when others then
    if sqlerrm not like '%GC_PERMIT_REQUIRED%' then raise; end if;
  end;
end $$;

-- ----------------------------------------------------------- investments
select pg_temp.logout();
select pg_temp.login('27111111-1111-1111-1111-111111111111');
do $$
declare r jsonb; u0 numeric; w0 bigint; p0 bigint;
begin
  r := invest_view();
  perform pg_temp.assert(jsonb_array_length(r->'funds') = 3, 'three city funds');
  perform pg_temp.assert((r->'funds'->0->>'price')::bigint >= 1000, 'prices start at the base');
  begin
    perform invest_buy('grain', 50, gen_random_uuid());
    perform pg_temp.assert(false, 'buying under 100 G must raise');
  exception when others then
    if sqlerrm not like '%GC_INVALID_AMOUNT%' then raise; end if;
  end;
  begin
    perform invest_buy('moon', 5000, gen_random_uuid());
    perform pg_temp.assert(false, 'unknown fund must raise');
  exception when others then
    if sqlerrm not like '%GC_UNKNOWN_FUND%' then raise; end if;
  end;
  select balance into w0 from public.accounts where owner_id = auth.uid() and kind = 'player';
  r := invest_buy('grain', 50000, gen_random_uuid());
  perform pg_temp.assert((r->>'ok')::boolean, 'bought units');
  perform pg_temp.assert((select balance from public.accounts where owner_id = auth.uid() and kind = 'player') = w0 - 50000, 'investment paid from the wallet');
  u0 := (select sum(units) from public.investments where owner_id = auth.uid() and fund = 'grain');
  perform pg_temp.assert(u0 > 0, 'units recorded');
  -- selling everything returns the same value (no price movement inside a game-day)
  r := invest_sell('grain', 50000, gen_random_uuid());
  perform pg_temp.assert((r->>'ok')::boolean, 'sold units back');
  perform pg_temp.assert((select coalesce(sum(units), 0) from public.investments where owner_id = auth.uid() and fund = 'grain') = 0, 'all units consumed');
  begin
    perform invest_sell('grain', 50000, gen_random_uuid());
    perform pg_temp.assert(false, 'selling more than held must raise');
  exception when others then
    if sqlerrm not like '%GC_INSUFFICIENT_UNITS%' then raise; end if;
  end;
end $$;

-- -------------------------------------------------- charity & giving
select pg_temp.logout();
select pg_temp.login('27222222-2222-2222-2222-222222222222');
do $$
declare r jsonb; i int; w0 bigint; v_ask uuid;
begin
  select balance into w0 from public.accounts where owner_id = auth.uid() and kind = 'player';
  r := charity_collect(gen_random_uuid());
  perform pg_temp.assert((r->>'ok')::boolean, 'charity collected');
  perform pg_temp.assert((r->>'amount')::bigint between 150 and 600, 'charity is modest, not a faucet');
  perform pg_temp.assert((select balance from public.accounts where owner_id = auth.uid() and kind = 'player') > w0, 'charity lands in the wallet');
  -- the daily cap
  for i in 1..4 loop perform charity_collect(gen_random_uuid()); end loop;
  begin
    perform charity_collect(gen_random_uuid());
    perform pg_temp.assert(false, 'charity past the daily cap must raise');
  exception when others then
    if sqlerrm not like '%GC_CHARITY_DONE%' then raise; end if;
  end;

  -- ask a citizen for help; they answer
  r := beg_ask('ode_test', 1000, gen_random_uuid());
  perform pg_temp.assert((r->>'ok')::boolean, 'ask sent');
  v_ask := (r->>'id')::uuid;
  begin
    perform beg_ask('ode_test', 1000, gen_random_uuid());
    perform pg_temp.assert(false, 'a second open ask must raise');
  exception when others then
    if sqlerrm not like '%GC_ASK_OPEN%' then raise; end if;
  end;
end $$;

select pg_temp.logout();
select pg_temp.login('27111111-1111-1111-1111-111111111111');
do $$
declare v_ask uuid; w0 bigint; w1 bigint; r jsonb;
begin
  perform pg_temp.assert((jsonb_array_length(beg_inbox())) = 1, 'the ask arrives in their inbox');
  select id into v_ask from public.beg_asks where status = 'pending' limit 1;
  select balance into w0 from public.accounts where owner_id = '27111111-1111-1111-1111-111111111111' and kind = 'player';
  select balance into w1 from public.accounts where owner_id = '27222222-2222-2222-2222-222222222222' and kind = 'player';
  r := beg_respond(v_ask, true, gen_random_uuid());
  perform pg_temp.assert((r->>'given')::boolean, 'gift given');
  perform pg_temp.assert((select balance from public.accounts where owner_id = '27111111-1111-1111-1111-111111111111' and kind = 'player') = w0 - 1000, 'giver paid');
  perform pg_temp.assert((select balance from public.accounts where owner_id = '27222222-2222-2222-2222-222222222222' and kind = 'player') = w1 + 1000, 'asker received');
  perform pg_temp.assert((select status from public.beg_asks where id = v_ask) = 'given', 'ask settled');
end $$;

-- --------------------------------------------------- trader money path
select pg_temp.logout();
select pg_temp.login('27111111-1111-1111-1111-111111111111');
do $$
declare r jsonb; w0 bigint; i int;
begin
  select balance into w0 from public.accounts where owner_id = auth.uid() and kind = 'player';
  r := trade_run('trader', gen_random_uuid());
  perform pg_temp.assert((r->>'ok')::boolean, 'market run pays the trader');
  perform pg_temp.assert((r->>'profit')::bigint between 700 and 2800, 'profit is modest');
  perform pg_temp.assert((select balance from public.accounts where owner_id = auth.uid() and kind = 'player') > w0, 'profit landed in the wallet');
  begin
    perform trade_run('food_seller', gen_random_uuid());
    perform pg_temp.assert(false, 'trading without that permit must raise');
  exception when others then
    if sqlerrm not like '%GC_PERMIT_REQUIRED%' then raise; end if;
  end;
end $$;

-- the ledger still balances through all of it
select pg_temp.logout();
select pg_temp.assert((economy_audit()->>'ok')::boolean, 'supply still balances after opportunity tests');

-- tidy up so later suites (society) see the city they expect
delete from public.vehicle_listings where vehicle_id in (select id from public.vehicles where plate = 'GC-ODE-1');
delete from public.vehicles where plate = 'GC-ODE-1';

select 'PASS: all GistCity opportunity tests passed' as result;
