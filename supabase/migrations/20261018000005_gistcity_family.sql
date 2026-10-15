-- GistCity · family & aging (Phase 7 of the brief)
-- Characters with accelerated simulated ageing, marriages that need a signed
-- marriage agreement from both sides, abstract childbirth (the "family room":
-- enter, fade to black, a newborn is registered), a daily birth registry that
-- matches newborns to the parents who gave birth that game-day, and age/wealth
-- gates so children cannot hold adult positions. Re-runnable.
--
-- Age model (mirrored in src/game/family.ts):
--   1 game day = 24 real minutes (the city clock), 1 game month = 7 game days.
--   age(months) = 10·months                      for the first month   (→ 10 y/o)
--               = 10 + 15·(months−1)/11          months 1..12         (→ 25 y/o)
--               = 25 + (months−12)               after a year
--   New players start at 18. Newborns start at 0 and grow through the same curve.

create extension if not exists pgcrypto;

-- ================================================================== config
insert into public.economy_config (key, value) values
  ('age_config', '{"game_day_minutes":24,"days_per_month":7,"adult_age":18,"childbearing_min":18,"childbearing_max":50,"registry_fee":2500}')
on conflict (key) do nothing;

-- ================================================================ characters
create table if not exists public.characters (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid references auth.users(id) on delete cascade,   -- null: a child not linked to an account
  kind        text not null default 'player' check (kind in ('player','child')),
  name        text not null check (char_length(name) between 1 and 24),
  gender      text check (gender in ('f','m','x')),
  born_at     timestamptz not null default now(),
  mother_id   uuid references public.characters(id) on delete set null,
  father_id   uuid references public.characters(id) on delete set null,
  deceased_at timestamptz,
  created_at  timestamptz not null default now()
);
create unique index if not exists characters_one_player on public.characters (owner_id) where kind = 'player';
create index if not exists characters_mother_idx on public.characters (mother_id);
create index if not exists characters_father_idx on public.characters (father_id);

alter table public.characters enable row level security;
drop policy if exists "characters: public read" on public.characters;
create policy "characters: public read" on public.characters for select to anon, authenticated using (true);
drop policy if exists "characters: own row readable" on public.characters;
drop policy if exists "characters: update own" on public.characters;
create policy "characters: update own" on public.characters for update to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
grant select on public.characters to anon, authenticated;
grant update (name, gender) on public.characters to authenticated;
revoke insert, delete on public.characters from anon, authenticated;

-- ================================================================= marriages
create table if not exists public.marriages (
  id           uuid primary key default gen_random_uuid(),
  partner_a    uuid not null references public.characters(id) on delete cascade,  -- proposer
  partner_b    uuid not null references public.characters(id) on delete cascade,
  status       text not null default 'proposed' check (status in ('proposed','active','ended')),
  agreement    text not null default '' check (char_length(agreement) <= 1000),
  signed_a     timestamptz,
  signed_b     timestamptz,
  proposed_by  uuid not null,                                   -- auth user id of the proposer
  created_at   timestamptz not null default now(),
  activated_at timestamptz,
  ended_at     timestamptz,
  end_reason   text,
  check (partner_a <> partner_b)
);
create index if not exists marriages_partner_b_idx on public.marriages (partner_b);
create unique index if not exists marriages_one_active_pair on public.marriages
  (least(partner_a, partner_b), greatest(partner_a, partner_b)) where status = 'active';

alter table public.marriages enable row level security;
drop policy if exists "marriages: partners read" on public.marriages;
create policy "marriages: partners read" on public.marriages for select to authenticated
  using (exists (select 1 from public.characters c
                 where c.id in (partner_a, partner_b) and c.owner_id = auth.uid()));
grant select on public.marriages to authenticated;
revoke insert, update, delete on public.marriages from anon, authenticated;

-- ==================================================================== births
create table if not exists public.births (
  id            uuid primary key default gen_random_uuid(),
  child_id      uuid not null references public.characters(id) on delete cascade,
  mother_id     uuid not null references public.characters(id) on delete cascade,
  father_id     uuid references public.characters(id) on delete set null,
  marriage_id   uuid references public.marriages(id) on delete set null,
  occurred_on   date not null default current_date,        -- the game-day registry date
  name          text not null check (char_length(name) between 1 and 24),
  registered_at timestamptz not null default now()
);
create index if not exists births_day_idx on public.births (occurred_on, registered_at);
-- one newborn per couple per game-day (the "matched to parents giving birth that day" rule)
create unique index if not exists births_one_per_couple_per_day on public.births (marriage_id, occurred_on) where marriage_id is not null;

alter table public.births enable row level security;
drop policy if exists "births: registry is public" on public.births;
create policy "births: registry is public" on public.births for select to anon, authenticated using (true);
grant select on public.births to anon, authenticated;
revoke insert, update, delete on public.births from anon, authenticated;

-- ================================================================ age helpers
-- Years from a birth timestamp, using the accelerated city calendar.
create or replace function public.age_years(p_born_at timestamptz)
returns numeric language sql stable as $$
  select round(case
    when m <= 1  then 10 * m
    when m <= 12 then 10 + 15 * (m - 1) / 11
    else 25 + (m - 12)
  end, 2)
  from (select extract(epoch from (now() - p_born_at)) / (24 * 60 * 7) as m) s;
$$;

-- A user's age: their player character, or 25 for accounts from before this phase.
create or replace function public.character_age(p_owner uuid)
returns numeric language sql stable security definer set search_path = public as $$
  select coalesce((select public.age_years(c.born_at) from public.characters c
                   where c.owner_id = p_owner and c.kind = 'player' limit 1), 25::numeric);
$$;
grant execute on function public.character_age(uuid) to authenticated;

-- The birth timestamp that makes a character p_age years old today
-- (inverse of age_years; mirrored in src/game/family.ts).
create or replace function public.born_at_for_age(p_age numeric)
returns timestamptz language sql stable as $$
  select now() - (case
    when p_age <= 10 then (p_age / 10.0) * 10080
    when p_age <= 25 then (1 + 11 * (p_age - 10) / 15.0) * 10080
    else (12 + (p_age - 25)) * 10080
  end) * interval '1 second';
$$;

-- Every account gets a grown-up character row (18 y/o) when they sign up.
create or replace function public.family_new_character()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.characters (owner_id, kind, name, gender, born_at)
  values (new.id, 'player', left(new.display_name, 24), null, public.born_at_for_age(18))
  on conflict do nothing;
  return new;
end $$;
drop trigger if exists family_new_character on public.profiles;
create trigger family_new_character after insert on public.profiles
  for each row execute function public.family_new_character();

-- Existing accounts (created before this migration) get their character here.
insert into public.characters (owner_id, kind, name, born_at)
select p.id, 'player', left(p.display_name, 24), public.born_at_for_age(18)
from public.profiles p
where not exists (select 1 from public.characters c where c.owner_id = p.id and c.kind = 'player');

-- Age gate on adult tables: arguments are (min_age, user_column).
create or replace function public.family_age_gate()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_age numeric; v_min int := coalesce(TG_ARGV[0], '18')::int; v_col text := coalesce(TG_ARGV[1], 'user_id');
begin
  execute format('select public.character_age(($1::jsonb->>%L)::uuid)', v_col) using to_jsonb(new) into v_age;
  if v_age < v_min then
    raise exception 'GC_TOO_YOUNG age=% required=%', round(v_age, 1), v_min;
  end if;
  return new;
end $$;

drop trigger if exists age_gate_enroll on public.enrollments;
create trigger age_gate_enroll before insert on public.enrollments
  for each row execute function public.family_age_gate('16', 'user_id');
drop trigger if exists age_gate_gov on public.gov_applications;
create trigger age_gate_gov before insert on public.gov_applications
  for each row execute function public.family_age_gate('18', 'user_id');
drop trigger if exists age_gate_vehicles on public.vehicles;
create trigger age_gate_vehicles before insert on public.vehicles
  for each row execute function public.family_age_gate('18', 'owner_id');

-- =================================================================== RPCs
create or replace function public.require_user()
returns uuid language plpgsql stable security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_status text;
begin
  if v_uid is null then raise exception 'GC_NOT_SIGNED_IN'; end if;
  select status into v_status from public.profiles where id = v_uid;
  if v_status is distinct from 'active' then raise exception 'GC_ACCOUNT_RESTRICTED'; end if;
  return v_uid;
end $$;
revoke all on function public.require_user() from public, anon, authenticated;

-- My character card (age included).
create or replace function public.character_me()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_uid uuid := public.require_user(); c public.characters%rowtype;
begin
  select * into c from public.characters where owner_id = v_uid and kind = 'player';
  if not found then raise exception 'GC_UNKNOWN_USER'; end if;
  return jsonb_build_object(
    'id', c.id, 'name', c.name, 'gender', c.gender,
    'born_at', c.born_at, 'age', public.age_years(c.born_at),
    'is_child', public.age_years(c.born_at) < 18);
end $$;
grant execute on function public.character_me() to authenticated;

-- Propose marriage. Both adults, both single, no blocks between them.
create or replace function public.marriage_propose(p_partner citext, p_terms text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := public.require_user();
  v_me public.characters%rowtype; v_them public.characters%rowtype; v_them_user uuid;
  v_id uuid;
begin
  perform public.check_rate('marriage', 10);
  select * into v_me from public.characters where owner_id = v_uid and kind = 'player';
  select id into v_them_user from public.profiles where username = lower(p_partner) and status = 'active';
  if not found then raise exception 'GC_UNKNOWN_USER'; end if;
  if v_them_user = v_uid then raise exception 'GC_SELF'; end if;
  select * into v_them from public.characters where owner_id = v_them_user and kind = 'player';
  if not found then raise exception 'GC_UNKNOWN_USER'; end if;
  if public.age_years(v_me.born_at) < 18 or public.age_years(v_them.born_at) < 18 then
    raise exception 'GC_TOO_YOUNG age=18 required=18';
  end if;
  if exists (select 1 from public.blocks where (blocker_id = v_uid and blocked_id = v_them_user)
                                          or (blocker_id = v_them_user and blocked_id = v_uid)) then
    raise exception 'GC_BLOCKED';
  end if;
  if exists (select 1 from public.marriages m where m.status = 'active'
               and (v_me.id in (m.partner_a, m.partner_b) or v_them.id in (m.partner_a, m.partner_b))) then
    raise exception 'GC_ALREADY_MARRIED';
  end if;
  if exists (select 1 from public.marriages m where m.status = 'proposed'
               and v_me.id in (m.partner_a, m.partner_b)) then
    raise exception 'GC_PROPOSAL_OPEN';
  end if;
  insert into public.marriages (partner_a, partner_b, agreement, proposed_by)
  values (v_me.id, v_them.id, left(coalesce(p_terms, ''), 1000), v_uid)
  returning id into v_id;
  return jsonb_build_object('ok', true, 'marriage_id', v_id);
end $$;
grant execute on function public.marriage_propose(citext, text) to authenticated;

-- Countersign (or first-sign) the marriage agreement. Both signatures activate.
create or replace function public.marriage_sign(p_marriage uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := public.require_user();
  v_me public.characters%rowtype;
  m public.marriages%rowtype;
begin
  select * into v_me from public.characters where owner_id = v_uid and kind = 'player';
  select * into m from public.marriages where id = p_marriage;
  if not found then raise exception 'GC_NOT_FOUND'; end if;
  if m.status <> 'proposed' then raise exception 'GC_NOT_OPEN'; end if;
  if v_me.id not in (m.partner_a, m.partner_b) then raise exception 'GC_NOT_AUTHORISED'; end if;

  if v_me.id = m.partner_a then
    if m.signed_a is not null then raise exception 'GC_ALREADY_SIGNED'; end if;
    update public.marriages set signed_a = now() where id = p_marriage;
  else
    if m.signed_b is not null then raise exception 'GC_ALREADY_SIGNED'; end if;
    update public.marriages set signed_b = now() where id = p_marriage;
  end if;

  update public.marriages
     set status = 'active', activated_at = now()
   where id = p_marriage and signed_a is not null and signed_b is not null;

  return jsonb_build_object('ok', true, 'status',
    (select status from public.marriages where id = p_marriage));
end $$;
grant execute on function public.marriage_sign(uuid) to authenticated;

-- My marriage records (proposals, active, ended) with both signatures visible.
create or replace function public.marriages_mine()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_uid uuid := public.require_user(); v_me uuid;
begin
  select id into v_me from public.characters where owner_id = v_uid and kind = 'player';
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', m.id, 'status', m.status, 'agreement', m.agreement,
      'partner', (select c.name from public.characters c
                   where c.id = case when m.partner_a = v_me then m.partner_b else m.partner_a end),
      'i_signed', (m.partner_a = v_me and m.signed_a is not null) or (m.partner_b = v_me and m.signed_b is not null),
      'partner_signed', (m.partner_a = v_me and m.signed_b is not null) or (m.partner_b = v_me and m.signed_a is not null),
      'created_at', m.created_at, 'activated_at', m.activated_at) order by m.created_at desc)
    from public.marriages m where v_me in (m.partner_a, m.partner_b)), '[]'::jsonb);
end $$;
grant execute on function public.marriages_mine() to authenticated;

-- Leave the marriage. No one is ever trapped in a relationship.
create or replace function public.marriage_end(p_marriage uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := public.require_user(); v_me public.characters%rowtype; m public.marriages%rowtype;
begin
  select * into v_me from public.characters where owner_id = v_uid and kind = 'player';
  select * into m from public.marriages where id = p_marriage;
  if not found then raise exception 'GC_NOT_FOUND'; end if;
  if m.status <> 'active' then raise exception 'GC_NOT_OPEN'; end if;
  if v_me.id not in (m.partner_a, m.partner_b) then raise exception 'GC_NOT_AUTHORISED'; end if;
  update public.marriages set status = 'ended', ended_at = now(),
    end_reason = left(coalesce(p_reason, ''), 200) where id = p_marriage;
  return jsonb_build_object('ok', true);
end $$;
grant execute on function public.marriage_end(uuid, text) to authenticated;

-- The family tree of a citizen: self + spouse + children + parents + ages.
create or replace function public.family_tree(p_username citext default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_target uuid; c public.characters%rowtype; spouse public.characters%rowtype;
  v_kids jsonb; v_mom public.characters%rowtype; v_dad public.characters%rowtype;
begin
  if p_username is null then
    v_target := v_uid;
  else
    select id into v_target from public.profiles where username = lower(p_username) and status = 'active';
    if not found then raise exception 'GC_UNKNOWN_USER'; end if;
  end if;
  select * into c from public.characters where owner_id = v_target and kind = 'player';
  if not found then raise exception 'GC_UNKNOWN_USER'; end if;

  select * into spouse from public.characters k
   where k.id in (
     select case when m.partner_a = c.id then m.partner_b else m.partner_a end
     from public.marriages m
      where m.status = 'active' and c.id in (m.partner_a, m.partner_b))
   limit 1;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', k.id, 'name', k.name, 'age', public.age_years(k.born_at),
    'born_at', k.born_at, 'gender', k.gender) order by k.born_at), '[]'::jsonb)
    into v_kids
    from public.characters k where k.mother_id = c.id or k.father_id = c.id;

  select * into v_mom from public.characters where id = c.mother_id;
  select * into v_dad from public.characters where id = c.father_id;

  return jsonb_build_object(
    'self', jsonb_build_object('id', c.id, 'name', c.name, 'age', public.age_years(c.born_at),
      'gender', c.gender, 'born_at', c.born_at, 'username',
      (select username from public.profiles where id = v_target)),
    'spouse', case when spouse.id is null then null else jsonb_build_object(
      'id', spouse.id, 'name', spouse.name, 'age', public.age_years(spouse.born_at), 'gender', spouse.gender) end,
    'children', v_kids,
    'parents', jsonb_build_object(
      'mother', case when v_mom.id is null then null else jsonb_build_object('id', v_mom.id, 'name', v_mom.name, 'age', public.age_years(v_mom.born_at)) end,
      'father', case when v_dad.id is null then null else jsonb_build_object('id', v_dad.id, 'name', v_dad.name, 'age', public.age_years(v_dad.born_at)) end));
end $$;
grant execute on function public.family_tree(citext) to anon, authenticated;

-- The "family room": register a newborn to the married couple.
-- Abstract and non-explicit by design — the client shows a fade to black.
create or replace function public.childbirth(p_marriage uuid, p_name text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := public.require_user();
  v_me public.characters%rowtype; v_partner public.characters%rowtype;
  m public.marriages%rowtype; v_child uuid; v_fee bigint; v_wallet uuid; v_registry uuid;
  v_name text := left(trim(coalesce(p_name, '')), 24);
begin
  select * into v_me from public.characters where owner_id = v_uid and kind = 'player';
  select * into m from public.marriages where id = p_marriage;
  if not found then raise exception 'GC_NOT_FOUND'; end if;
  if m.status <> 'active' then raise exception 'GC_NOT_MARRIED'; end if;
  if v_me.id not in (m.partner_a, m.partner_b) then raise exception 'GC_NOT_AUTHORISED'; end if;
  select * into v_partner from public.characters
   where id = case when m.partner_a = v_me.id then m.partner_b else m.partner_a end;

  if public.age_years(v_me.born_at) < 18 or public.age_years(v_me.born_at) > 50
     or public.age_years(v_partner.born_at) < 18 or public.age_years(v_partner.born_at) > 50 then
    raise exception 'GC_NOT_ELIGIBLE_AGE';
  end if;
  if char_length(v_name) < 1 then raise exception 'GC_INVALID_NAME'; end if;
  if exists (select 1 from public.births where marriage_id = m.id and occurred_on = current_date) then
    raise exception 'GC_ALREADY_BORN_TODAY';
  end if;

  -- registry fee (server-side money, like every other payment)
  v_fee := coalesce((select (value->>'registry_fee')::bigint from public.economy_config where key = 'age_config'), 2500);
  select id into v_wallet from public.accounts where owner_id = v_uid and kind = 'player';
  select id into v_registry from public.accounts where code = 'gov-revenue';
  if v_registry is null then
    insert into public.accounts (kind, code, name) values ('business', 'gov-revenue', 'Civil Registry') on conflict (code) do nothing;
    select id into v_registry from public.accounts where code = 'gov-revenue';
  end if;
  if v_fee > 0 then
    perform public.post_transaction(v_wallet, v_registry, v_fee, 'birth_registration',
      jsonb_build_object('marriage', m.id), gen_random_uuid(), v_uid);
  end if;

  -- the newborn: matched to both parents of this birth, this game-day.
  -- Abstract and non-explicit: the "family room" is a fade to black in the client.
  insert into public.characters (owner_id, kind, name, gender, mother_id, father_id)
  values (null, 'child', v_name, null, v_me.id, v_partner.id)
  returning id into v_child;
  insert into public.births (child_id, mother_id, father_id, marriage_id, occurred_on, name)
  values (v_child, v_me.id, v_partner.id, m.id, current_date, v_name);

  return jsonb_build_object('ok', true, 'child_id', v_child, 'name', v_name, 'born_on', current_date);
end $$;
grant execute on function public.childbirth(uuid, text) to authenticated;

-- Today's birth registry: every newborn matched to the parents who gave birth
-- that day. `p_on` defaults to today's game-day date.
create or replace function public.birth_registry(p_on date default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_day date := coalesce(p_on, current_date);
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', b.id, 'name', b.name, 'born_on', b.occurred_on,
      'child_id', b.child_id,
      'mother', (select c.name from public.characters c where c.id = b.mother_id),
      'father', (select c.name from public.characters c where c.id = b.father_id),
      'registered_at', b.registered_at) order by b.registered_at) from public.births b
    where b.occurred_on = v_day), '[]'::jsonb);
end $$;
grant execute on function public.birth_registry(date) to anon, authenticated;

-- Age on the public profile page (replaces the Phase-6 definition with the extra field).
create or replace function public.profile_page(p_username citext)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_p   public.profiles%rowtype;
  v_media jsonb; v_followers int; v_following int;
  v_i_follow boolean; v_follows_me boolean; v_can_dm boolean; v_blocked_by_me boolean;
  v_occupation text; v_char public.characters%rowtype;
begin
  select * into v_p from public.profiles where username = lower(p_username) and status = 'active';
  if not found then raise exception 'GC_UNKNOWN_USER'; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', m.id, 'kind', m.kind, 'path', m.path, 'caption', m.caption,
           'created_at', m.created_at) order by m.created_at desc), '[]'::jsonb)
    into v_media
    from (select * from public.profile_media where owner_id = v_p.id order by created_at desc limit 24) m;

  select count(*) into v_followers from public.follows where followee_id = v_p.id;
  select count(*) into v_following from public.follows where follower_id = v_p.id;

  v_i_follow := v_uid is not null and exists (
    select 1 from public.follows where follower_id = v_uid and followee_id = v_p.id);
  v_follows_me := v_uid is not null and exists (
    select 1 from public.follows where follower_id = v_p.id and followee_id = v_uid);
  v_blocked_by_me := v_uid is not null and exists (
    select 1 from public.blocks where blocker_id = v_uid and blocked_id = v_p.id);
  v_can_dm := v_uid is not null and v_uid <> v_p.id and not v_blocked_by_me
    and not exists (select 1 from public.blocks
                    where (blocker_id = v_uid and blocked_id = v_p.id)
                       or (blocker_id = v_p.id and blocked_id = v_uid));

  select coalesce((select g.title from public.gov_employees e
                   join public.gov_positions g on g.id = e.position_id
                   where e.user_id = v_p.id and e.active limit 1), 'Citizen')
    into v_occupation;
  select * into v_char from public.characters where owner_id = v_p.id and kind = 'player';

  return jsonb_build_object(
    'id', v_p.id, 'username', v_p.username, 'display_name', v_p.display_name,
    'bio', v_p.bio, 'avatar_url', v_p.avatar_url, 'created_at', v_p.created_at,
    'occupation', v_occupation,
    'age', case when v_char.id is null then 25 else public.age_years(v_char.born_at) end,
    'followers', v_followers, 'following', v_following,
    'i_follow', v_i_follow, 'follows_me', v_follows_me,
    'can_dm', v_can_dm, 'blocked_by_me', v_blocked_by_me,
    'media', v_media);
end $$;
grant execute on function public.profile_page(citext) to anon, authenticated;
