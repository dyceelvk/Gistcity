-- GistCity · opportunity (Phase 9 of the brief)
-- Business permits (trader / food seller / car dealer roles), player-to-player
-- car sales with escrow, city investment funds with deterministic pricing, and
-- the giving economy (charity for citizens who need a start, and player gifts).
-- Re-runnable. Apply after 20261018000005_gistcity_family.sql.
--
-- Design
--   * Money never appears from clicks: every payment goes through post_transaction.
--   * Investment prices are deterministic (base × compound daily rate from the
--     fund's start day) so the ledger always balances and clients cannot game
--     randomness. Gains/losses are realised when selling units.
--   * Begging is a real economy path with dignity: a daily charity from the
--     Community Fund (capped), plus player-to-player asks that must be answered.
--   * Car dealers can list their vehicles; buyers pay into escrow-style
--     settlement (95% seller, 5% market fee) and ownership transfers server-side.

create extension if not exists pgcrypto;

insert into public.economy_config (key, value) values
  ('opportunity', '{
     "permit_fees": {"trader":25000,"food_seller":15000,"car_dealer":80000},
     "charity_per_day": 5, "charity_min": 150, "charity_max": 600,
     "market_fee_bps": 500, "beg_max": 20000
   }')
on conflict (key) do nothing;

-- ============================================================ business permits
create table if not exists public.biz_permits (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null references auth.users(id) on delete cascade,
  role          text not null check (role in ('trader','food_seller','car_dealer')),
  business_name text not null check (char_length(business_name) between 2 and 32),
  fee_paid      bigint not null check (fee_paid >= 0),
  issued_at     timestamptz not null default now(),
  active        boolean not null default true,
  unique (owner_id, role)
);

alter table public.biz_permits enable row level security;
drop policy if exists "biz_permits: public read" on public.biz_permits;
create policy "biz_permits: public read" on public.biz_permits for select to anon, authenticated using (active);
grant select on public.biz_permits to anon, authenticated;
revoke insert, update, delete on public.biz_permits from anon, authenticated;

drop trigger if exists age_gate_permits on public.biz_permits;
create trigger age_gate_permits before insert on public.biz_permits
  for each row execute function public.family_age_gate('18', 'owner_id');

-- ============================================================ car listings
create table if not exists public.vehicle_listings (
  id         uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references public.vehicles(id) on delete cascade,
  seller_id  uuid not null references auth.users(id) on delete cascade,
  price      bigint not null check (price between 1 and 1000000000),
  status     text not null default 'open' check (status in ('open','sold','cancelled')),
  created_at timestamptz not null default now(),
  closed_at  timestamptz
);
create unique index if not exists vehicle_listings_open on public.vehicle_listings (vehicle_id) where status = 'open';

alter table public.vehicle_listings enable row level security;
drop policy if exists "vehicle_listings: public read" on public.vehicle_listings;
create policy "vehicle_listings: public read" on public.vehicle_listings for select to anon, authenticated using (status = 'open');
grant select on public.vehicle_listings to anon, authenticated;
revoke insert, update, delete on public.vehicle_listings from anon, authenticated;

-- ============================================================ investments
create table if not exists public.invest_funds (
  code            text primary key,
  name            text not null,
  description     text not null default '',
  base_price      bigint not null check (base_price > 0),
  daily_rate_bps  int not null,                 -- e.g. 25 = +0.25% per game-day
  start_day       date not null default current_date,
  active          boolean not null default true
);

insert into public.invest_funds (code, name, description, base_price, daily_rate_bps) values
  ('grain',    'GistCity Grain Index',   'Farms and food processing around the city.', 1000, 12),
  ('hustle',   'Hustle Growth Fund',     'Small businesses: POS, dispatch, market trade.', 1000, 30),
  ('estate',   'Civic Estate Trust',     'Development around the Civic Ring (steady).', 1000, 20)
on conflict (code) do nothing;

create table if not exists public.investments (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null references auth.users(id) on delete cascade,
  fund       text not null references public.invest_funds(code),
  units      numeric not null check (units > 0),
  created_at timestamptz not null default now()
);
create index if not exists investments_owner_idx on public.investments (owner_id, fund);

alter table public.investments enable row level security;
drop policy if exists "investments: read own" on public.investments;
create policy "investments: read own" on public.investments for select to authenticated using (owner_id = auth.uid());
grant select on public.investments to authenticated;
revoke insert, update, delete on public.investments from anon, authenticated;
drop trigger if exists age_gate_invest on public.investments;
create trigger age_gate_invest before insert on public.investments
  for each row execute function public.family_age_gate('18', 'owner_id');

-- Deterministic unit price: base × (1 + rate)^game-days since the fund started.
create or replace function public.invest_price(p_fund text)
returns bigint language plpgsql stable security definer set search_path = public as $$
declare f public.invest_funds%rowtype; v_days numeric;
begin
  select * into f from public.invest_funds where code = p_fund and active;
  if not found then raise exception 'GC_UNKNOWN_FUND'; end if;
  select extract(epoch from (now() - f.start_day)) / (24 * 60) into v_days;  -- game-days
  return greatest(1, round(f.base_price * power(1 + f.daily_rate_bps / 10000.0, v_days)));
end $$;
revoke all on function public.invest_price(text) from public, anon, authenticated;

-- ============================================================ charity & giving
create table if not exists public.charity_log (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  amount     bigint not null check (amount > 0),
  given_on   date not null default current_date,
  created_at timestamptz not null default now()
);
create index if not exists charity_day_idx on public.charity_log (user_id, given_on);

alter table public.charity_log enable row level security;
drop policy if exists "charity_log: read own" on public.charity_log;
create policy "charity_log: read own" on public.charity_log for select to authenticated using (user_id = auth.uid());
grant select on public.charity_log to authenticated;
revoke insert, update, delete on public.charity_log from anon, authenticated;

create table if not exists public.beg_asks (
  id         uuid primary key default gen_random_uuid(),
  from_id    uuid not null references auth.users(id) on delete cascade,
  to_id      uuid not null references auth.users(id) on delete cascade,
  amount     bigint not null check (amount between 50 and 20000),
  status     text not null default 'pending' check (status in ('pending','given','declined','expired')),
  created_at timestamptz not null default now(),
  answered_at timestamptz,
  check (from_id <> to_id)
);

alter table public.beg_asks enable row level security;
drop policy if exists "beg_asks: sides read" on public.beg_asks;
create policy "beg_asks: sides read" on public.beg_asks for select to authenticated using (auth.uid() in (from_id, to_id));
grant select on public.beg_asks to authenticated;
revoke insert, update, delete on public.beg_asks from anon, authenticated;

-- ==================================================================== RPCs
-- Buy a business permit: the role unlocks its money paths in the world.
create or replace function public.permit_buy(p_role text, p_business_name text, p_key uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := public.require_user();
  v_fee bigint; v_wallet uuid; v_rev uuid; v_id uuid;
  v_name text := left(trim(coalesce(p_business_name, '')), 32);
begin
  if p_key is null then raise exception 'GC_KEY_REQUIRED'; end if;
  if p_role not in ('trader','food_seller','car_dealer') then raise exception 'GC_UNKNOWN_ROLE'; end if;
  if char_length(v_name) < 2 then raise exception 'GC_INVALID_NAME'; end if;
  if public.character_age(v_uid) < 18 then
    raise exception 'GC_TOO_YOUNG age=% required=18', round(public.character_age(v_uid), 1);
  end if;
  if exists (select 1 from public.biz_permits where owner_id = v_uid and role = p_role and active) then
    raise exception 'GC_ALREADY_PERMITTED';
  end if;
  v_fee := coalesce((select (value->'permit_fees'->>p_role)::bigint from public.economy_config where key = 'opportunity'), 25000);
  select id into v_wallet from public.accounts where owner_id = v_uid and kind = 'player';
  select id into v_rev from public.accounts where code = 'gov-revenue';
  if v_rev is null then
    insert into public.accounts (kind, code, name) values ('business', 'gov-revenue', 'City Revenue') on conflict (code) do nothing;
    select id into v_rev from public.accounts where code = 'gov-revenue';
  end if;
  perform public.post_transaction(v_wallet, v_rev, v_fee, 'permit_fee',
    jsonb_build_object('role', p_role), p_key, v_uid);
  insert into public.biz_permits (owner_id, role, business_name, fee_paid)
  values (v_uid, p_role, v_name, v_fee)
  on conflict (owner_id, role) do update set active = true, business_name = excluded.business_name
  returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id, 'role', p_role, 'business_name', v_name);
end $$;
grant execute on function public.permit_buy(text, text, uuid) to authenticated;

create or replace function public.my_permits()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_uid uuid := public.require_user();
begin
  return coalesce((select jsonb_agg(jsonb_build_object(
    'role', p.role, 'business_name', p.business_name, 'issued_at', p.issued_at) order by p.issued_at)
    from public.biz_permits p where p.owner_id = v_uid and p.active), '[]'::jsonb);
end $$;
grant execute on function public.my_permits() to authenticated;

-- List one of my cars for sale (car dealers only).
create or replace function public.vehicle_list(p_vehicle uuid, p_price bigint, p_key uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := public.require_user(); v_id uuid;
begin
  if p_key is null then raise exception 'GC_KEY_REQUIRED'; end if;
  if not exists (select 1 from public.biz_permits where owner_id = v_uid and role = 'car_dealer' and active) then
    raise exception 'GC_PERMIT_REQUIRED';
  end if;
  if not exists (select 1 from public.vehicles where id = p_vehicle and owner_id = v_uid) then
    raise exception 'GC_NOT_OWNER';
  end if;
  if p_price is null or p_price < 1 or p_price > 1000000000 then raise exception 'GC_INVALID_AMOUNT'; end if;
  insert into public.vehicle_listings (vehicle_id, seller_id, price) values (p_vehicle, v_uid, p_price)
  returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;
grant execute on function public.vehicle_list(uuid, bigint, uuid) to authenticated;

create or replace function public.vehicle_unlist(p_listing uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := public.require_user();
begin
  update public.vehicle_listings set status = 'cancelled', closed_at = now()
   where id = p_listing and seller_id = v_uid and status = 'open';
  if not found then raise exception 'GC_NOT_FOUND'; end if;
  return jsonb_build_object('ok', true);
end $$;
grant execute on function public.vehicle_unlist(uuid) to authenticated;

-- Buy a listed car: money to the seller (minus the 5% market fee), ownership over.
create or replace function public.vehicle_buy_from(p_listing uuid, p_key uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := public.require_user();
  l public.vehicle_listings%rowtype;
  v_fee_bps int; v_fee bigint; v_seller_cut bigint;
  v_wallet uuid; v_seller_wallet uuid; v_rev uuid; v_model text;
begin
  if p_key is null then raise exception 'GC_KEY_REQUIRED'; end if;
  select * into l from public.vehicle_listings where id = p_listing and status = 'open' for update;
  if not found then raise exception 'GC_NOT_FOUND'; end if;
  if l.seller_id = v_uid then raise exception 'GC_SELF'; end if;
  if public.character_age(v_uid) < 18 then
    raise exception 'GC_TOO_YOUNG age=% required=18', round(public.character_age(v_uid), 1);
  end if;
  if not exists (select 1 from public.vehicles v where v.id = l.vehicle_id and v.owner_id = l.seller_id) then
    raise exception 'GC_NOT_OWNER';
  end if;
  v_fee_bps := coalesce((select (value->>'market_fee_bps')::int from public.economy_config where key = 'opportunity'), 500);
  v_fee := greatest(1, (l.price * v_fee_bps) / 10000);
  v_seller_cut := l.price - v_fee;

  select id into v_wallet from public.accounts where owner_id = v_uid and kind = 'player';
  select id into v_seller_wallet from public.accounts where owner_id = l.seller_id and kind = 'player';
  select id into v_rev from public.accounts where code = 'gov-revenue';
  perform public.post_transaction(v_wallet, v_seller_wallet, v_seller_cut, 'vehicle_sale',
    jsonb_build_object('listing', l.id), p_key, v_uid);
  if v_fee > 0 and v_rev is not null then
    perform public.post_transaction(v_wallet, v_rev, v_fee, 'market_fee',
      jsonb_build_object('listing', l.id), gen_random_uuid(), v_uid);
  end if;

  update public.vehicles set owner_id = v_uid, updated_at = now() where id = l.vehicle_id;
  update public.vehicle_listings set status = 'sold', closed_at = now() where id = l.id;
  select model_id into v_model from public.vehicles where id = l.vehicle_id;
  return jsonb_build_object('ok', true, 'vehicle_id', l.vehicle_id, 'model', v_model, 'price', l.price);
end $$;
grant execute on function public.vehicle_buy_from(uuid, uuid) to authenticated;

-- Open car listings on the market (everyone may browse).
create or replace function public.open_listings()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  return coalesce((select jsonb_agg(jsonb_build_object(
    'id', l.id, 'vehicle_id', l.vehicle_id, 'price', l.price,
    'seller', (select p.username from public.profiles p where p.id = l.seller_id),
    'model', (select vm.name from public.vehicles v join public.vehicle_models vm on vm.id = v.model_id where v.id = l.vehicle_id))
    order by l.created_at) from public.vehicle_listings l where l.status = 'open'), '[]'::jsonb);
end $$;
grant execute on function public.open_listings() to anon, authenticated;

-- City funds: prices, my portfolio, buy and sell.
create or replace function public.invest_view()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_uid uuid := public.require_user();
begin
  return jsonb_build_object(
    'funds', coalesce((select jsonb_agg(jsonb_build_object(
      'code', f.code, 'name', f.name, 'description', f.description,
      'price', public.invest_price(f.code), 'daily_rate_bps', f.daily_rate_bps) order by f.code)
      from public.invest_funds f where f.active), '[]'::jsonb),
    'mine', coalesce((select jsonb_agg(jsonb_build_object(
      'fund', i.fund, 'units', i.units, 'value', round(i.units * public.invest_price(i.fund))) order by i.fund)
      from public.investments i where i.owner_id = v_uid), '[]'::jsonb));
end $$;
grant execute on function public.invest_view() to authenticated;

create or replace function public.invest_buy(p_fund text, p_amount bigint, p_key uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := public.require_user();
  v_price bigint; v_units numeric; v_wallet uuid; v_treasury uuid;
begin
  if p_key is null then raise exception 'GC_KEY_REQUIRED'; end if;
  if p_amount is null or p_amount < 100 then raise exception 'GC_INVALID_AMOUNT'; end if;
  if public.character_age(v_uid) < 18 then
    raise exception 'GC_TOO_YOUNG age=% required=18', round(public.character_age(v_uid), 1);
  end if;
  v_price := public.invest_price(p_fund);
  v_units := round((p_amount::numeric / v_price), 6);
  select id into v_wallet from public.accounts where owner_id = v_uid and kind = 'player';
  select id into v_treasury from public.accounts where code = 'treasury';
  perform public.post_transaction(v_wallet, v_treasury, p_amount, 'invest_buy',
    jsonb_build_object('fund', p_fund, 'units', v_units), p_key, v_uid);
  insert into public.investments (owner_id, fund, units) values (v_uid, p_fund, v_units);
  return jsonb_build_object('ok', true, 'units', v_units, 'price', v_price);
end $$;
grant execute on function public.invest_buy(text, bigint, uuid) to authenticated;

create or replace function public.invest_sell(p_fund text, p_amount_g bigint, p_key uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := public.require_user();
  v_price bigint; v_units numeric; v_total bigint; v_wallet uuid; v_treasury uuid;
  v_held numeric;
begin
  if p_key is null then raise exception 'GC_KEY_REQUIRED'; end if;
  v_price := public.invest_price(p_fund);
  select coalesce(sum(units), 0) into v_held from public.investments where owner_id = v_uid and fund = p_fund;
  v_units := round((coalesce(p_amount_g, 0)::numeric / v_price), 6);
  if v_units <= 0 or v_units > v_held then raise exception 'GC_INSUFFICIENT_UNITS'; end if;
  v_total := round(v_units * v_price);
  select id into v_wallet from public.accounts where owner_id = v_uid and kind = 'player';
  select id into v_treasury from public.accounts where code = 'treasury';
  perform public.post_transaction(v_treasury, v_wallet, v_total, 'invest_sell',
    jsonb_build_object('fund', p_fund, 'units', v_units), p_key, v_uid);
  -- consume units FIFO
  with used as (
    delete from public.investments
     where owner_id = v_uid and fund = p_fund
     returning units)
  insert into public.investments (owner_id, fund, units)
  select v_uid, p_fund, sum(units) - v_units from used having sum(units) - v_units > 0.000001;
  return jsonb_build_object('ok', true, 'units', v_units, 'proceeds', v_total, 'price', v_price);
end $$;
grant execute on function public.invest_sell(text, bigint, uuid) to authenticated;

-- Daily charity from the Community Fund: a dignified start for citizens who
-- need one (capped per day; never a faucet).
create or replace function public.charity_collect(p_key uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := public.require_user();
  v_n int; v_max int; v_amount bigint; v_wallet uuid; v_community uuid;
  v_min bigint; v_hi bigint;
begin
  if p_key is null then raise exception 'GC_KEY_REQUIRED'; end if;
  select count(*) into v_n from public.charity_log where user_id = v_uid and given_on = current_date;
  v_max := coalesce((select (value->>'charity_per_day')::int from public.economy_config where key = 'opportunity'), 5);
  if v_n >= v_max then raise exception 'GC_CHARITY_DONE'; end if;
  v_min := coalesce((select (value->>'charity_min')::bigint from public.economy_config where key = 'opportunity'), 150);
  v_hi := coalesce((select (value->>'charity_max')::bigint from public.economy_config where key = 'opportunity'), 600);
  v_amount := v_min + (abs(hashtext(v_uid::text || current_date::text || v_n)) % (v_hi - v_min + 1));
  select id into v_wallet from public.accounts where owner_id = v_uid and kind = 'player';
  select id into v_community from public.accounts where code = 'community';
  perform public.post_transaction(v_community, v_wallet, v_amount, 'charity',
    jsonb_build_object('day', current_date), p_key, v_uid);
  insert into public.charity_log (user_id, amount) values (v_uid, v_amount);
  return jsonb_build_object('ok', true, 'amount', v_amount, 'left', v_max - v_n - 1);
end $$;
grant execute on function public.charity_collect(uuid) to authenticated;

-- Ask a citizen for help (they answer yes/no — never automatic).
create or replace function public.beg_ask(p_username citext, p_amount bigint, p_key uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := public.require_user(); v_other uuid; v_id uuid;
begin
  if p_key is null then raise exception 'GC_KEY_REQUIRED'; end if;
  perform public.check_rate('beg', 10);
  select id into v_other from public.profiles where username = lower(p_username) and status = 'active';
  if not found then raise exception 'GC_UNKNOWN_USER'; end if;
  if v_other = v_uid then raise exception 'GC_SELF'; end if;
  if p_amount is null or p_amount < 50 or p_amount > 20000 then raise exception 'GC_INVALID_AMOUNT'; end if;
  if exists (select 1 from public.blocks where (blocker_id = v_uid and blocked_id = v_other)
                                          or (blocker_id = v_other and blocked_id = v_uid)) then
    raise exception 'GC_BLOCKED';
  end if;
  if exists (select 1 from public.beg_asks where from_id = v_uid and to_id = v_other and status = 'pending') then
    raise exception 'GC_ASK_OPEN';
  end if;
  insert into public.beg_asks (from_id, to_id, amount) values (v_uid, v_other, p_amount) returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;
grant execute on function public.beg_ask(citext, bigint, uuid) to authenticated;

-- Answer an ask: giving pays out of the giver's wallet; declining costs nothing.
create or replace function public.beg_respond(p_ask uuid, p_accept boolean, p_key uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := public.require_user();
  a public.beg_asks%rowtype; v_wallet uuid; v_to uuid;
begin
  if p_key is null then raise exception 'GC_KEY_REQUIRED'; end if;
  select * into a from public.beg_asks where id = p_ask and status = 'pending' for update;
  if not found then raise exception 'GC_NOT_FOUND'; end if;
  if a.to_id <> v_uid then raise exception 'GC_NOT_AUTHORISED'; end if;
  if not p_accept then
    update public.beg_asks set status = 'declined', answered_at = now() where id = p_ask;
    return jsonb_build_object('ok', true, 'given', false);
  end if;
  select id into v_wallet from public.accounts where owner_id = v_uid and kind = 'player';
  select id into v_to from public.accounts where owner_id = a.from_id and kind = 'player';
  perform public.post_transaction(v_wallet, v_to, a.amount, 'gift',
    jsonb_build_object('ask', a.id), p_key, v_uid);
  update public.beg_asks set status = 'given', answered_at = now() where id = p_ask;
  return jsonb_build_object('ok', true, 'given', true, 'amount', a.amount);
end $$;
grant execute on function public.beg_respond(uuid, boolean, uuid) to authenticated;

-- Asks waiting for my answer.
create or replace function public.beg_inbox()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_uid uuid := public.require_user();
begin
  return coalesce((select jsonb_agg(jsonb_build_object(
    'id', b.id, 'amount', b.amount, 'created_at', b.created_at,
    'from', (select p.username from public.profiles p where p.id = b.from_id),
    'from_name', (select p.display_name from public.profiles p where p.id = b.from_id))
    order by b.created_at) from public.beg_asks b
   where b.to_id = v_uid and b.status = 'pending'), '[]'::jsonb);
end $$;
grant execute on function public.beg_inbox() to authenticated;

-- ============================================================ trade runs
-- The trader / food-seller roles earn by trading: a market run pays a real
-- (small, capped) profit from the market pool — a job tied to the permit.
create table if not exists public.trade_log (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  role       text not null check (role in ('trader','food_seller')),
  profit     bigint not null check (profit > 0),
  traded_on  date not null default current_date,
  created_at timestamptz not null default now()
);
create index if not exists trade_day_idx on public.trade_log (user_id, traded_on);

alter table public.trade_log enable row level security;
drop policy if exists "trade_log: read own" on public.trade_log;
create policy "trade_log: read own" on public.trade_log for select to authenticated using (user_id = auth.uid());
grant select on public.trade_log to authenticated;
revoke insert, update, delete on public.trade_log from anon, authenticated;

create or replace function public.trade_run(p_role text, p_key uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := public.require_user();
  v_n int; v_profit bigint; v_wallet uuid; v_pool uuid;
begin
  if p_key is null then raise exception 'GC_KEY_REQUIRED'; end if;
  if p_role not in ('trader','food_seller') then raise exception 'GC_UNKNOWN_ROLE'; end if;
  if not exists (select 1 from public.biz_permits where owner_id = v_uid and role = p_role and active) then
    raise exception 'GC_PERMIT_REQUIRED';
  end if;
  select count(*) into v_n from public.trade_log where user_id = v_uid and traded_on = current_date;
  if v_n >= 8 then raise exception 'GC_TRADE_DONE'; end if;
  -- server-side profit: 700–2600 G, better for food sellers on quick turnover
  v_profit := 700 + (floor(random() * 1900))::bigint + case when p_role = 'food_seller' then 300 else 0 end;
  select id into v_wallet from public.accounts where owner_id = v_uid and kind = 'player';
  select id into v_pool from public.accounts where code = 'treasury';
  perform public.post_transaction(v_pool, v_wallet, v_profit, 'market_trade',
    jsonb_build_object('role', p_role, 'run', v_n + 1), p_key, v_uid);
  insert into public.trade_log (user_id, role, profit) values (v_uid, p_role, v_profit);
  return jsonb_build_object('ok', true, 'profit', v_profit, 'left', 7 - v_n);
end $$;
grant execute on function public.trade_run(text, uuid) to authenticated;
