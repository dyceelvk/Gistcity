-- GistCity · foundation (Phase 1–2)
-- Accounts & profiles, the server-authoritative G economy, the item catalogue,
-- inventories and hustle payroll. Re-runnable. Apply after 20261014000001_gist.sql.
--
-- Design
--   * Every unit of G lives in exactly one row of public.accounts. The initial
--     supply (5,000,000,000,000 G) is minted ONCE into the Treasury and then
--     allocated to institutional accounts by ordinary ledger transactions, so
--     sum(accounts.balance) == total supply at all times (see economy_audit()).
--   * Clients never write balances, inventories or transactions. They call the
--     SECURITY DEFINER functions below; each takes an idempotency key so a
--     retried tap or request can never charge twice.
--   * New players receive a starter grant from the Starter Pool (not minted).

create extension if not exists citext;
create extension if not exists pgcrypto;

-- =============================================================== economy config
create table if not exists public.economy_config (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

insert into public.economy_config (key, value) values
  ('currency',        '{"code":"G","name":"GistCity G","symbol":"G"}'),
  ('total_supply',    '5000000000000'),
  ('starter_grant',   '10000'),
  -- Initial allocation of the 5 trillion G supply. The Treasury keeps the
  -- remainder (4.0 T) as the reserve; nothing here is credited to players.
  ('allocation',      '{"treasury":4000000000000,"payroll":500000000000,"development":300000000000,"community":100000000000,"starter_pool":100000000000}'),
  ('min_age',         '16'),
  ('username_rules',  '{"pattern":"^[a-z0-9_]{3,20}$","reserved":["admin","administrator","gistcity","gist","government","treasury","support","moderator","system","official","police","pastor","church","bank","null","undefined"]}')
on conflict (key) do nothing;

-- ===================================================================== accounts
create table if not exists public.accounts (
  id         uuid primary key default gen_random_uuid(),
  kind       text not null check (kind in ('player','treasury','payroll','development','community','starter_pool','business','church','sink')),
  code       text unique,                                  -- system/business accounts: 'treasury', 'biz:gist_fits', …
  owner_id   uuid references auth.users(id) on delete set null,
  name       text not null,
  balance    bigint not null default 0 check (balance >= 0),
  created_at timestamptz not null default now()
);
create unique index if not exists accounts_one_wallet_per_player on public.accounts (owner_id) where kind = 'player';

create table if not exists public.transactions (
  id              bigint generated always as identity primary key,
  idempotency_key uuid unique,
  from_account    uuid references public.accounts(id),      -- null only for the one-time mint
  to_account      uuid not null references public.accounts(id),
  amount          bigint not null check (amount > 0),
  reason          text not null,
  ref             jsonb not null default '{}'::jsonb,
  actor_id        uuid,
  status          text not null default 'posted' check (status in ('posted','reversed')),
  created_at      timestamptz not null default now()
);
create index if not exists transactions_from_idx on public.transactions (from_account, created_at desc);
create index if not exists transactions_to_idx   on public.transactions (to_account, created_at desc);

-- System accounts + one-time mint & allocation (idempotent: guarded by the mint row).
do $$
declare
  v_treasury uuid; v_total bigint; v_alloc jsonb; k text; v_acc uuid;
begin
  insert into public.accounts (kind, code, name) values ('treasury', 'treasury', 'GistCity Treasury') on conflict (code) do nothing;
  insert into public.accounts (kind, code, name) values ('payroll', 'payroll', 'Government Payroll') on conflict (code) do nothing;
  insert into public.accounts (kind, code, name) values ('development', 'development', 'City Development Fund') on conflict (code) do nothing;
  insert into public.accounts (kind, code, name) values ('community', 'community', 'Community & Churches Fund') on conflict (code) do nothing;
  insert into public.accounts (kind, code, name) values ('starter_pool', 'starter_pool', 'New Citizen Starter Pool') on conflict (code) do nothing;
  insert into public.accounts (kind, code, name) values ('business', 'biz:gist_fits', 'GIST Fits (clothing store)') on conflict (code) do nothing;
  insert into public.accounts (kind, code, name) values ('business', 'biz:suya_spot', 'Suya Spot') on conflict (code) do nothing;
  insert into public.accounts (kind, code, name) values ('business', 'biz:mama_nkechi', 'Mama Nkechi Kitchen') on conflict (code) do nothing;
  insert into public.accounts (kind, code, name) values ('business', 'biz:vibe_lounge', 'Vibe Lounge') on conflict (code) do nothing;
  insert into public.accounts (kind, code, name) values ('business', 'biz:furniture', 'Gist Heights Home Store') on conflict (code) do nothing;

  select id into v_treasury from public.accounts where code = 'treasury';
  if not exists (select 1 from public.transactions where reason = 'mint') then
    select (value)::bigint into v_total from public.economy_config where key = 'total_supply';
    update public.accounts set balance = balance + v_total where id = v_treasury;
    insert into public.transactions (from_account, to_account, amount, reason, ref) values (null, v_treasury, v_total, 'mint', '{"note":"initial supply"}');
    select value into v_alloc from public.economy_config where key = 'allocation';
    for k in select jsonb_object_keys(v_alloc) loop
      if k <> 'treasury' then
        select id into v_acc from public.accounts where code = k;
        update public.accounts set balance = balance - (v_alloc->>k)::bigint where id = v_treasury;
        update public.accounts set balance = balance + (v_alloc->>k)::bigint where id = v_acc;
        insert into public.transactions (from_account, to_account, amount, reason, ref) values (v_treasury, v_acc, (v_alloc->>k)::bigint, 'allocation', jsonb_build_object('to', k));
      end if;
    end loop;
  end if;
end $$;

-- ===================================================================== profiles
create table if not exists public.profiles (
  id                  uuid primary key references auth.users(id) on delete cascade,
  username            citext not null unique check (username ~ '^[a-z0-9_]{3,20}$'),
  display_name        text not null check (char_length(display_name) between 1 and 24),
  bio                 text not null default '' check (char_length(bio) <= 280),
  avatar_url          text,
  role                text not null default 'player' check (role in ('player','official','moderator','admin')),
  status              text not null default 'active' check (status in ('active','suspended','banned')),
  tos_accepted_at     timestamptz,
  privacy_accepted_at timestamptz,
  age_confirmed       boolean not null default false,
  character_ready     boolean not null default false,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create or replace function public.username_valid(p text)
returns boolean language sql stable as $$
  select p is not null
     and p ~ '^[a-z0-9_]{3,20}$'
     and not exists (
       select 1 from public.economy_config c, jsonb_array_elements_text(c.value->'reserved') r
       where c.key = 'username_rules' and r = lower(p));
$$;

-- Anyone (even before signing up) may check whether a username is free.
create or replace function public.username_available(p text)
returns boolean language sql stable security definer set search_path = public as $$
  select public.username_valid(lower(p)) and not exists (select 1 from public.profiles where username = lower(p));
$$;
grant execute on function public.username_available(text) to anon, authenticated;

-- Profile + wallet + starter grant for every new auth user. Registration metadata:
--   { username, display_name, tos_accepted, privacy_accepted, age_confirmed }
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  md jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_user text := lower(coalesce(md->>'username', ''));
  v_name text := left(coalesce(nullif(trim(md->>'display_name'), ''), 'New GistCitizen'), 24);
  v_wallet uuid; v_pool uuid; v_grant bigint;
begin
  if not public.username_valid(v_user) or exists (select 1 from public.profiles where username = v_user) then
    v_user := 'citizen_' || substr(replace(new.id::text, '-', ''), 1, 8);
  end if;
  insert into public.profiles (id, username, display_name, tos_accepted_at, privacy_accepted_at, age_confirmed)
  values (new.id, v_user, v_name,
          case when coalesce((md->>'tos_accepted')::boolean, false) then now() end,
          case when coalesce((md->>'privacy_accepted')::boolean, false) then now() end,
          coalesce((md->>'age_confirmed')::boolean, false))
  on conflict (id) do nothing;

  insert into public.accounts (kind, owner_id, name) values ('player', new.id, v_user || ' wallet')
  on conflict do nothing;
  select id into v_wallet from public.accounts where owner_id = new.id and kind = 'player';
  select id into v_pool from public.accounts where code = 'starter_pool';
  select (value)::bigint into v_grant from public.economy_config where key = 'starter_grant';
  if v_grant > 0 and (select balance from public.accounts where id = v_pool) >= v_grant
     and not exists (select 1 from public.transactions where to_account = v_wallet and reason = 'starter_grant') then
    update public.accounts set balance = balance - v_grant where id = v_pool;
    update public.accounts set balance = balance + v_grant where id = v_wallet;
    insert into public.transactions (from_account, to_account, amount, reason, actor_id) values (v_pool, v_wallet, v_grant, 'starter_grant', new.id);
  end if;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Players may edit their own public details, never their role/status/username/flags.
create or replace function public.profiles_guard()
returns trigger language plpgsql as $$
begin
  if current_setting('role', true) = 'authenticated' then
    new.id := old.id; new.username := old.username; new.role := old.role; new.status := old.status;
    new.tos_accepted_at := old.tos_accepted_at; new.privacy_accepted_at := old.privacy_accepted_at; new.age_confirmed := old.age_confirmed;
    new.created_at := old.created_at;
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists profiles_guard on public.profiles;
create trigger profiles_guard before update on public.profiles for each row execute function public.profiles_guard();

alter table public.profiles enable row level security;
drop policy if exists "profiles: read own" on public.profiles;
create policy "profiles: read own" on public.profiles for select to authenticated using (id = auth.uid());
drop policy if exists "profiles: update own" on public.profiles;
create policy "profiles: update own" on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
grant select, update (display_name, bio, avatar_url, character_ready) on public.profiles to authenticated;

-- What other players may see about you.
create or replace view public.public_profiles as
  select p.id, p.username, p.display_name, p.bio, p.avatar_url, p.created_at,
         coalesce(g.level, 1) as level, coalesce(g.popularity, 0) as popularity
  from public.profiles p left join public.gist_players g on g.id = p.id
  where p.status = 'active';
grant select on public.public_profiles to authenticated;

-- ==================================================================== catalogue
create table if not exists public.catalog_items (
  id         text primary key,
  category   text not null check (category in ('top','bottom','accessory','furniture','food','drink','service')),
  name       text not null,
  price      bigint not null check (price >= 0),
  merchant   text not null references public.accounts(code),
  consumable boolean not null default false,
  effects    jsonb not null default '{}'::jsonb,       -- needs/stat effects applied by the client on consumption
  active     boolean not null default true
);
insert into public.catalog_items (id, category, name, price, merchant, consumable, effects) values
  ('hoodie-black',  'top',       'Lagos Nights Hoodie',  3500, 'biz:gist_fits', false, '{}'),
  ('crop-pink',     'top',       'Baddie Crop Set',      4200, 'biz:gist_fits', false, '{}'),
  ('blazer-navy',   'top',       'Marina Blazer',        7500, 'biz:gist_fits', false, '{}'),
  ('native-gold',   'top',       'Senator Native',       9000, 'biz:gist_fits', false, '{}'),
  ('skirt-black',   'bottom',    'Pencil Skirt',         2800, 'biz:gist_fits', false, '{}'),
  ('acc-cap',       'accessory', 'Snapback Cap',         1500, 'biz:gist_fits', false, '{}'),
  ('acc-glasses',   'accessory', 'Designer Shades',      2500, 'biz:gist_fits', false, '{}'),
  ('acc-chain',     'accessory', 'Cuban Chain',          6000, 'biz:gist_fits', false, '{}'),
  ('acc-bag',       'accessory', 'Mini Bag',             3200, 'biz:gist_fits', false, '{}'),
  ('acc-watch',     'accessory', 'Gold Watch',           8000, 'biz:gist_fits', false, '{}'),
  ('acc-earrings',  'accessory', 'Hoop Earrings',        1800, 'biz:gist_fits', false, '{}'),
  ('furn-bed',      'furniture', 'Queen Bed',            6000, 'biz:furniture', false, '{}'),
  ('furn-sofa',     'furniture', 'Velvet Sofa',          7000, 'biz:furniture', false, '{}'),
  ('furn-tv',       'furniture', '55" Smart TV',         9500, 'biz:furniture', false, '{}'),
  ('furn-rug',      'furniture', 'Ankara Rug',           2200, 'biz:furniture', false, '{}'),
  ('furn-plant',    'furniture', 'Monstera Plant',       1200, 'biz:furniture', false, '{}'),
  ('furn-fridge',   'furniture', 'Double-door Fridge',   8000, 'biz:furniture', false, '{}'),
  ('furn-ac',       'furniture', 'Split AC',             7500, 'biz:furniture', false, '{}'),
  ('furn-art',      'furniture', 'Wall Art',             1800, 'biz:furniture', false, '{}'),
  ('furn-lamp',     'furniture', 'Floor Lamp',           1400, 'biz:furniture', false, '{}'),
  ('furn-dining',   'furniture', 'Dining Set',           5200, 'biz:furniture', false, '{}'),
  ('food-suya',     'food',      'Suya (beef, extra pepper)',  500, 'biz:suya_spot',   true, '{"hunger":35,"popularity":2,"xp":8}'),
  ('drink-water',   'drink',     'Pure water sachet',          100, 'biz:suya_spot',   true, '{"thirst":35}'),
  ('food-jollof',   'food',      'Jollof, plantain & chicken', 800, 'biz:mama_nkechi', true, '{"hunger":60,"thirst":10,"reputation":1,"xp":10}'),
  ('drink-zobo',    'drink',     'Cold zobo',                  250, 'biz:mama_nkechi', true, '{"thirst":55}'),
  ('drink-chapman', 'drink',     'Chapman',                    400, 'biz:vibe_lounge', true, '{"thirst":50,"popularity":1}'),
  ('svc-lounge',    'service',   'Vibe Lounge entry',         1500, 'biz:vibe_lounge', true, '{"popularity":5,"xp":15,"energy":-5}')
on conflict (id) do update set name = excluded.name, price = excluded.price, merchant = excluded.merchant, consumable = excluded.consumable, effects = excluded.effects, category = excluded.category;

alter table public.catalog_items enable row level security;
drop policy if exists "catalog: public read" on public.catalog_items;
create policy "catalog: public read" on public.catalog_items for select to anon, authenticated using (active);
grant select on public.catalog_items to anon, authenticated;

-- ==================================================================== inventory
create table if not exists public.inventory (
  user_id     uuid not null references auth.users(id) on delete cascade,
  item_id     text not null references public.catalog_items(id),
  qty         integer not null default 1 check (qty >= 0),
  acquired_at timestamptz not null default now(),
  primary key (user_id, item_id)
);
alter table public.inventory enable row level security;
drop policy if exists "inventory: read own" on public.inventory;
create policy "inventory: read own" on public.inventory for select to authenticated using (user_id = auth.uid());
grant select on public.inventory to authenticated;

-- ====================================================================== hustles
-- Server pay table for the gig jobs at the Hustle Hub. Paid from Government Payroll.
create table if not exists public.hustles (
  id          text primary key,
  title       text not null,
  pay         bigint not null check (pay >= 0),
  cooldown_s  integer not null default 60,
  active      boolean not null default true
);
insert into public.hustles (id, title, pay, cooldown_s) values
  ('dispatch', 'Dispatch rider', 1500, 90),
  ('market',   'Market runs',    2000, 120),
  ('pos',      'POS agent',      2000, 120),
  ('pitch',    'Penalty shootout side bets', 1000, 180)
on conflict (id) do update set title = excluded.title, pay = excluded.pay, cooldown_s = excluded.cooldown_s;
grant select on public.hustles to anon, authenticated;

create table if not exists public.hustle_log (
  id           bigint generated always as identity primary key,
  user_id      uuid not null references auth.users(id) on delete cascade,
  hustle_id    text not null references public.hustles(id),
  completed_at timestamptz not null default now(),
  paid         bigint not null
);
create index if not exists hustle_log_user_idx on public.hustle_log (user_id, hustle_id, completed_at desc);
alter table public.hustle_log enable row level security;
drop policy if exists "hustle_log: read own" on public.hustle_log;
create policy "hustle_log: read own" on public.hustle_log for select to authenticated using (user_id = auth.uid());
grant select on public.hustle_log to authenticated;

-- ======================================================================= ledger
alter table public.accounts enable row level security;
alter table public.transactions enable row level security;
drop policy if exists "accounts: read own or institutional" on public.accounts;
create policy "accounts: read own or institutional" on public.accounts for select to authenticated
  using (owner_id = auth.uid() or kind <> 'player');
drop policy if exists "transactions: read own" on public.transactions;
create policy "transactions: read own" on public.transactions for select to authenticated
  using (exists (select 1 from public.accounts a where a.owner_id = auth.uid() and a.id in (from_account, to_account)));
grant select on public.accounts, public.transactions to authenticated;

-- Internal: move G between two accounts atomically. Not callable by clients.
create or replace function public.post_transaction(p_from uuid, p_to uuid, p_amount bigint, p_reason text, p_ref jsonb, p_key uuid, p_actor uuid)
returns bigint language plpgsql security definer set search_path = public as $$
declare v_id bigint; v_bal bigint;
begin
  if p_amount is null or p_amount <= 0 then raise exception 'GC_INVALID_AMOUNT'; end if;
  if p_from is null or p_to is null or p_from = p_to then raise exception 'GC_INVALID_ACCOUNT'; end if;
  if p_key is not null then
    select id into v_id from transactions where idempotency_key = p_key;
    if found then return v_id; end if;
  end if;
  perform 1 from accounts where id in (p_from, p_to) order by id for update;
  select balance into v_bal from accounts where id = p_from;
  if v_bal is null then raise exception 'GC_INVALID_ACCOUNT'; end if;
  if v_bal < p_amount then raise exception 'GC_INSUFFICIENT_FUNDS'; end if;
  update accounts set balance = balance - p_amount where id = p_from;
  update accounts set balance = balance + p_amount where id = p_to;
  insert into transactions (idempotency_key, from_account, to_account, amount, reason, ref, actor_id)
  values (p_key, p_from, p_to, p_amount, p_reason, coalesce(p_ref, '{}'::jsonb), p_actor) returning id into v_id;
  return v_id;
exception when unique_violation then
  select id into v_id from transactions where idempotency_key = p_key;
  return v_id;
end $$;
revoke all on function public.post_transaction(uuid, uuid, bigint, text, jsonb, uuid, uuid) from public, anon, authenticated;

create or replace function public.my_wallet()
returns uuid language sql stable security definer set search_path = public as $$
  select id from public.accounts where owner_id = auth.uid() and kind = 'player';
$$;
grant execute on function public.my_wallet() to authenticated;

-- Everything the client needs after sign-in: profile, balance, inventory, saved state.
create or replace function public.me()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v jsonb;
begin
  if auth.uid() is null then raise exception 'GC_NOT_SIGNED_IN'; end if;
  select jsonb_build_object(
    'profile', (select to_jsonb(p) - 'tos_accepted_at' - 'privacy_accepted_at' from public.profiles p where p.id = auth.uid()),
    'balance', coalesce((select balance from public.accounts where owner_id = auth.uid() and kind = 'player'), 0),
    'inventory', coalesce((select jsonb_agg(item_id order by acquired_at) from public.inventory where user_id = auth.uid() and qty > 0), '[]'::jsonb),
    'state', (select state from public.gist_players where id = auth.uid()),
    'currency', (select value from public.economy_config where key = 'currency')
  ) into v;
  return v;
end $$;
grant execute on function public.me() to authenticated;

-- Buy a catalogue item. Durable goods go to the inventory once; consumables are
-- paid for and the effects are returned for the client to apply.
create or replace function public.purchase_item(p_item text, p_key uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid(); v_wallet uuid; v_merchant uuid; it record; v_tx bigint; v_owned boolean; v_status text;
begin
  if v_uid is null then raise exception 'GC_NOT_SIGNED_IN'; end if;
  if p_key is null then raise exception 'GC_KEY_REQUIRED'; end if;
  select status into v_status from profiles where id = v_uid;
  if v_status is distinct from 'active' then raise exception 'GC_ACCOUNT_RESTRICTED'; end if;
  select * into it from catalog_items where id = p_item and active;
  if not found then raise exception 'GC_UNKNOWN_ITEM'; end if;
  select id into v_wallet from accounts where owner_id = v_uid and kind = 'player';
  select id into v_merchant from accounts where code = it.merchant;
  if v_wallet is null or v_merchant is null then raise exception 'GC_INVALID_ACCOUNT'; end if;

  -- replay of a request we already processed
  select id into v_tx from transactions where idempotency_key = p_key;
  if found then
    return jsonb_build_object('ok', true, 'replay', true, 'item', it.id, 'balance', (select balance from accounts where id = v_wallet));
  end if;

  if not it.consumable then
    select exists (select 1 from inventory where user_id = v_uid and item_id = it.id and qty > 0) into v_owned;
    if v_owned then return jsonb_build_object('ok', false, 'error', 'GC_ALREADY_OWNED', 'balance', (select balance from accounts where id = v_wallet)); end if;
  end if;

  if it.price > 0 then
    begin
      v_tx := post_transaction(v_wallet, v_merchant, it.price, 'purchase', jsonb_build_object('item', it.id), p_key, v_uid);
    exception when others then
      if sqlerrm = 'GC_INSUFFICIENT_FUNDS' then
        return jsonb_build_object('ok', false, 'error', 'GC_INSUFFICIENT_FUNDS', 'balance', (select balance from accounts where id = v_wallet));
      end if;
      raise;
    end;
  end if;
  if not it.consumable then
    insert into inventory (user_id, item_id) values (v_uid, it.id) on conflict (user_id, item_id) do update set qty = greatest(inventory.qty, 1);
  end if;
  return jsonb_build_object('ok', true, 'item', it.id, 'tx', v_tx, 'effects', it.effects, 'balance', (select balance from accounts where id = v_wallet));
end $$;
grant execute on function public.purchase_item(text, uuid) to authenticated;

-- Voluntary gift/donation to another citizen (by username). Nothing is created: it moves existing G.
create or replace function public.transfer_g(p_to_username text, p_amount bigint, p_note text, p_key uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_from uuid; v_to uuid; v_to_user uuid; v_tx bigint;
begin
  if v_uid is null then raise exception 'GC_NOT_SIGNED_IN'; end if;
  if p_key is null then raise exception 'GC_KEY_REQUIRED'; end if;
  if p_amount is null or p_amount <= 0 or p_amount > 1000000000 then raise exception 'GC_INVALID_AMOUNT'; end if;
  select id into v_to_user from profiles where username = lower(p_to_username) and status = 'active';
  if v_to_user is null then return jsonb_build_object('ok', false, 'error', 'GC_UNKNOWN_USER'); end if;
  if v_to_user = v_uid then return jsonb_build_object('ok', false, 'error', 'GC_SELF_TRANSFER'); end if;
  select id into v_from from accounts where owner_id = v_uid and kind = 'player';
  select id into v_to from accounts where owner_id = v_to_user and kind = 'player';
  begin
    v_tx := post_transaction(v_from, v_to, p_amount, 'gift', jsonb_build_object('note', left(coalesce(p_note, ''), 140)), p_key, v_uid);
  exception when others then
    if sqlerrm = 'GC_INSUFFICIENT_FUNDS' then
      return jsonb_build_object('ok', false, 'error', 'GC_INSUFFICIENT_FUNDS', 'balance', (select balance from accounts where id = v_from));
    end if;
    raise;
  end;
  return jsonb_build_object('ok', true, 'tx', v_tx, 'balance', (select balance from accounts where id = v_from));
end $$;
grant execute on function public.transfer_g(text, bigint, text, uuid) to authenticated;

-- Voluntary donation to an institutional account (church / community fund / business tip).
create or replace function public.donate_g(p_account_code text, p_amount bigint, p_key uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_from uuid; v_to uuid; v_tx bigint;
begin
  if v_uid is null then raise exception 'GC_NOT_SIGNED_IN'; end if;
  if p_key is null then raise exception 'GC_KEY_REQUIRED'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'GC_INVALID_AMOUNT'; end if;
  select id into v_to from accounts where code = p_account_code and kind in ('community','church','business','development');
  if v_to is null then return jsonb_build_object('ok', false, 'error', 'GC_UNKNOWN_ACCOUNT'); end if;
  select id into v_from from accounts where owner_id = v_uid and kind = 'player';
  begin
    v_tx := post_transaction(v_from, v_to, p_amount, 'donation', jsonb_build_object('to', p_account_code), p_key, v_uid);
  exception when others then
    if sqlerrm = 'GC_INSUFFICIENT_FUNDS' then
      return jsonb_build_object('ok', false, 'error', 'GC_INSUFFICIENT_FUNDS', 'balance', (select balance from accounts where id = v_from));
    end if;
    raise;
  end;
  return jsonb_build_object('ok', true, 'tx', v_tx, 'balance', (select balance from accounts where id = v_from));
end $$;
grant execute on function public.donate_g(text, bigint, uuid) to authenticated;

-- Pay a completed Hustle Hub gig from Government Payroll (server pay table + cooldown).
create or replace function public.complete_hustle(p_hustle text, p_key uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); h record; v_last timestamptz; v_wallet uuid; v_payroll uuid; v_tx bigint; v_status text;
begin
  if v_uid is null then raise exception 'GC_NOT_SIGNED_IN'; end if;
  if p_key is null then raise exception 'GC_KEY_REQUIRED'; end if;
  select status into v_status from profiles where id = v_uid;
  if v_status is distinct from 'active' then raise exception 'GC_ACCOUNT_RESTRICTED'; end if;
  select * into h from hustles where id = p_hustle and active;
  if not found then raise exception 'GC_UNKNOWN_HUSTLE'; end if;
  select id into v_wallet from accounts where owner_id = v_uid and kind = 'player';
  select id into v_payroll from accounts where code = 'payroll';
  select id into v_tx from transactions where idempotency_key = p_key;
  if found then return jsonb_build_object('ok', true, 'replay', true, 'paid', h.pay, 'balance', (select balance from accounts where id = v_wallet)); end if;
  select max(completed_at) into v_last from hustle_log where user_id = v_uid and hustle_id = h.id;
  if v_last is not null and v_last > now() - make_interval(secs => h.cooldown_s) then
    return jsonb_build_object('ok', false, 'error', 'GC_COOLDOWN', 'retry_in', ceil(extract(epoch from (v_last + make_interval(secs => h.cooldown_s) - now())))::int, 'balance', (select balance from accounts where id = v_wallet));
  end if;
  begin
    v_tx := post_transaction(v_payroll, v_wallet, h.pay, 'hustle_pay', jsonb_build_object('hustle', h.id), p_key, v_uid);
  exception when others then
    if sqlerrm = 'GC_INSUFFICIENT_FUNDS' then return jsonb_build_object('ok', false, 'error', 'GC_PAYROLL_EMPTY'); end if;
    raise;
  end;
  insert into hustle_log (user_id, hustle_id, paid) values (v_uid, h.id, h.pay);
  return jsonb_build_object('ok', true, 'tx', v_tx, 'paid', h.pay, 'balance', (select balance from accounts where id = v_wallet));
end $$;
grant execute on function public.complete_hustle(text, uuid) to authenticated;

-- Supply audit: must always report ok = true.
create or replace function public.economy_audit()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'total_supply', (select (value)::bigint from public.economy_config where key = 'total_supply'),
    'in_accounts', (select coalesce(sum(balance), 0) from public.accounts),
    'ok', (select (value)::bigint from public.economy_config where key = 'total_supply') = (select coalesce(sum(balance), 0) from public.accounts),
    'accounts', (select jsonb_object_agg(code, balance) from public.accounts where code is not null),
    'players', (select count(*) from public.accounts where kind = 'player'));
$$;
grant execute on function public.economy_audit() to authenticated;

-- ======================================================= leaderboard & saves
-- The wallet is now the source of truth for G; gist_players.cash is only a mirror.
drop view if exists public.gist_leaderboard;
create view public.gist_leaderboard as
  select g.id, coalesce(p.display_name, g.display_name) as display_name, p.username, g.popularity, g.level,
         coalesce(a.balance, 0)::bigint as cash
  from public.gist_players g
  left join public.profiles p on p.id = g.id
  left join public.accounts a on a.owner_id = g.id and a.kind = 'player'
  where coalesce(p.status, 'active') = 'active'
  order by g.popularity desc, g.level desc, cash desc
  limit 100;
grant select on public.gist_leaderboard to anon, authenticated;

-- Anonymous sign-ins are no longer used: players register with a username.
