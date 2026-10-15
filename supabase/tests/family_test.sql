-- Behavioural tests for the GistCity family migration (ageing, marriages with
-- signed agreements, abstract childbirth, daily birth matching, age gates).
-- Run on a scratch database after the migrations:
--   psql -d gist_test -v ON_ERROR_STOP=1 -f supabase/tests/family_test.sql

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

-- ------------------------------------------------------------- age maths
select pg_temp.assert(abs(public.age_years(now()) - 0) < 0.01, 'newborn is 0');
select pg_temp.assert(abs(public.age_years(now() - interval '10080 seconds') - 10) < 0.01, 'one game-month is 10 y/o');
select pg_temp.assert(abs(public.age_years(now() - interval '20160 seconds') - (10 + 15.0/11)) < 0.01, 'two months ≈ 11.4 y/o');
select pg_temp.assert(abs(public.age_years(now() - interval '120960 seconds') - 25) < 0.01, 'twelve game-months is 25 y/o');
select pg_temp.assert(abs(public.age_years(now() - interval '131040 seconds') - 26) < 0.01, 'a year plus a month is 26 y/o');
select pg_temp.assert(abs(public.age_years(public.born_at_for_age(18)) - 18) < 0.02, 'born_at_for_age inverts age_years for 18');
select pg_temp.assert(abs(public.age_years(public.born_at_for_age(10)) - 10) < 0.02, 'born_at_for_age inverts age_years for 10');
select pg_temp.assert(abs(public.age_years(public.born_at_for_age(40)) - 40) < 0.02, 'born_at_for_age inverts age_years for 40');

-- -------------------------------------------------------- users & characters
insert into auth.users (id, email, raw_user_meta_data) values
  ('26111111-1111-1111-1111-111111111111', 'fada@test.dev',  '{"username":"fada_test","display_name":"Fada","tos_accepted":true,"privacy_accepted":true,"age_confirmed":true}'),
  ('26222222-2222-2222-2222-222222222222', 'fifa@test.dev',  '{"username":"fifa_test","display_name":"Fifa","tos_accepted":true,"privacy_accepted":true,"age_confirmed":true}'),
  ('26333333-3333-3333-3333-333333333333', 'kid@test.dev',   '{"username":"kid_test","display_name":"Kiddo","tos_accepted":true,"privacy_accepted":true,"age_confirmed":true}');

select pg_temp.assert((select count(*) from characters where owner_id in
  ('26111111-1111-1111-1111-111111111111','26222222-2222-2222-2222-222222222222','26333333-3333-3333-3333-333333333333') and kind = 'player') = 3,
  'every signup gets a player character');
select pg_temp.assert(abs(public.character_age('26111111-1111-1111-1111-111111111111') - 18) < 0.02, 'new players start at 18');

-- make Kiddo 10 years old
update public.characters set born_at = now() - interval '10080 seconds'
 where owner_id = '26333333-3333-3333-3333-333333333333';
select pg_temp.assert(abs(public.character_age('26333333-3333-3333-3333-333333333333') - 10) < 0.02, 'kid is 10 y/o');

-- --------------------------------------------------------------- age gates
do $$
begin
  begin
    insert into public.vehicles (owner_id, model_id, color, plate)
    values ('26333333-3333-3333-3333-333333333333', (select id from public.vehicle_models limit 1), '#000', 'GC-KID-1');
    perform pg_temp.assert(false, 'a 10 y/o must not own a vehicle');
  exception when others then
    if sqlerrm not like '%GC_TOO_YOUNG%' then raise; end if;
  end;
  begin
    insert into public.gov_applications (user_id, position_id)
    values ('26333333-3333-3333-3333-333333333333', (select id from public.gov_positions limit 1));
    perform pg_temp.assert(false, 'a 10 y/o must not apply for a government post');
  exception when others then
    if sqlerrm not like '%GC_TOO_YOUNG%' then raise; end if;
  end;
  begin
    insert into public.enrollments (user_id, course_id, status)
    values ('26333333-3333-3333-3333-333333333333', 'drivers-licence', 'enrolled');
    perform pg_temp.assert(false, 'a 10 y/o must not enrol at Unity College');
  exception when others then
    if sqlerrm not like '%GC_TOO_YOUNG%' then raise; end if;
  end;
end $$;

-- a 17 y/o can study but not drive or work for government
update public.characters set born_at = public.born_at_for_age(17)
 where owner_id = '26333333-3333-3333-3333-333333333333';
insert into public.enrollments (user_id, course_id, status)
values ('26333333-3333-3333-3333-333333333333', 'drivers-licence', 'enrolled');
select pg_temp.assert((select count(*) from enrollments where user_id = '26333333-3333-3333-3333-333333333333') = 1, '17 y/o can enrol (school min age 16)');
do $$
begin
  begin
    insert into public.vehicles (owner_id, model_id, color, plate)
    values ('26333333-3333-3333-3333-333333333333', (select id from public.vehicle_models limit 1), '#000', 'GC-K17-1');
    perform pg_temp.assert(false, 'a 17 y/o must not buy a vehicle');
  exception when others then
    if sqlerrm not like '%GC_TOO_YOUNG%' then raise; end if;
  end;
end $$;

-- --------------------------------------------------------------- marriage
select pg_temp.login('26111111-1111-1111-1111-111111111111');
do $$
declare v_id uuid;
begin
  begin
    perform marriage_propose('fada_test', 'we are partners');
    perform pg_temp.assert(false, 'self-marriage must raise');
  exception when others then
    if sqlerrm not like '%GC_SELF%' then raise; end if;
  end;
  begin
    perform marriage_propose('kid_test', 'hello');
    perform pg_temp.assert(false, 'proposing to a child must raise');
  exception when others then
    if sqlerrm not like '%GC_TOO_YOUNG%' then raise; end if;
  end;
  v_id := (marriage_propose('fifa_test', 'Share the hustle, share the home, respect always.'))->>'marriage_id';
  perform pg_temp.assert(v_id is not null, 'proposal created');
  perform pg_temp.assert((select status from marriages where id = v_id) = 'proposed', 'starts proposed');
  perform pg_temp.assert((select agreement from marriages where id = v_id) like '%respect always%', 'agreement text stored');
  -- a second open proposal is refused
  begin
    perform marriage_propose('fifa_test', 'again');
    perform pg_temp.assert(false, 'double proposal must raise');
  exception when others then
    if sqlerrm not like '%GC_PROPOSAL_OPEN%' then raise; end if;
  end;
  -- a stranger cannot sign
  perform pg_temp.logout();
  perform pg_temp.login('26333333-3333-3333-3333-333333333333');
  begin
    perform marriage_sign(v_id);
    perform pg_temp.assert(false, 'a non-partner must not sign');
  exception when others then
    if sqlerrm not like '%GC_NOT_AUTHORISED%' then raise; end if;
  end;
  -- both signatures activate the marriage
  perform pg_temp.logout();
  perform pg_temp.login('26111111-1111-1111-1111-111111111111');
  perform pg_temp.assert((marriage_sign(v_id)->>'status') = 'proposed', 'one signature is not enough');
  perform pg_temp.logout();
  perform pg_temp.login('26222222-2222-2222-2222-222222222222');
  perform pg_temp.assert((marriage_sign(v_id)->>'status') = 'active', 'both signatures activate the marriage');
  begin
    perform marriage_sign(v_id);
    perform pg_temp.assert(false, 'signing a closed agreement must raise');
  exception when others then
    if sqlerrm not like '%GC_NOT_OPEN%' then raise; end if;
  end;

  -- married people cannot marry again (Fifa is now 20 and marriage-eligible)
  perform pg_temp.logout();
  perform pg_temp.login('26111111-1111-1111-1111-111111111111');
  begin
    perform marriage_propose('fifa_test', 'nope');
    perform pg_temp.assert(false, 'married citizen must not propose again');
  exception when others then
    if sqlerrm not like '%GC_ALREADY_MARRIED%' then raise; end if;
  end;
end $$;

-- family tree shows the spouse
select pg_temp.assert((family_tree('fada_test')->'spouse'->>'name') = 'Fifa', 'family tree lists the spouse');
select pg_temp.assert((family_tree('fifa_test')->'spouse'->>'name') = 'Fada', 'the tree works from both sides');

-- ------------------------------------------------------------------- birth
select pg_temp.login('26111111-1111-1111-1111-111111111111');
do $$
declare v_mar uuid; r jsonb; v_child uuid;
begin
  select id into v_mar from marriages where status = 'active' limit 1;
  -- registry fee is paid from the wallet: fund it with a real ledger transfer
  perform pg_temp.logout();
  perform public.post_transaction(
    (select id from public.accounts where code = 'treasury'),
    (select id from public.accounts where owner_id = '26111111-1111-1111-1111-111111111111' and kind = 'player'),
    10000, 'test_grant', '{"note":"family test funding"}', gen_random_uuid(), null);
  perform pg_temp.login('26111111-1111-1111-1111-111111111111');

  begin
    perform childbirth(v_mar, '');
    perform pg_temp.assert(false, 'a nameless baby must raise');
  exception when others then
    if sqlerrm not like '%GC_INVALID_NAME%' then raise; end if;
  end;

  r := childbirth(v_mar, 'Chidinma');
  perform pg_temp.assert((r->>'ok')::boolean, 'baby born in the family room');
  v_child := (r->>'child_id')::uuid;
  perform pg_temp.assert((select name from characters where id = v_child) = 'Chidinma', 'newborn registered with the chosen name');
  perform pg_temp.assert((select mother_id from characters where id = v_child) =
    (select id from characters where owner_id = '26111111-1111-1111-1111-111111111111'), 'matched to the parent who gave birth');
  perform pg_temp.assert((select father_id from characters where id = v_child) =
    (select id from characters where owner_id = '26222222-2222-2222-2222-222222222222'), 'matched to the other parent');
  perform pg_temp.assert(abs(public.age_years((select born_at from characters where id = v_child))) < 0.02, 'the newborn is 0 y/o');

  -- today's registry matches the baby to both parents
  perform pg_temp.assert((birth_registry()->0->>'name') = 'Chidinma', 'birth registry lists the newborn');
  perform pg_temp.assert((birth_registry()->0->>'mother') = 'Fada', 'registry shows parent one');
  perform pg_temp.assert((birth_registry()->0->>'father') = 'Fifa', 'registry shows parent two');

  -- one baby per couple per day
  begin
    perform childbirth(v_mar, 'Chidinma II');
    perform pg_temp.assert(false, 'a second birth the same day must raise');
  exception when others then
    if sqlerrm not like '%GC_ALREADY_BORN_TODAY%' then raise; end if;
  end;

  -- the tree grows
  perform pg_temp.assert((family_tree()->'children'->0->>'name') = 'Chidinma', 'family tree lists the child');
  perform pg_temp.assert((family_tree()->'children'->0->>'age')::numeric < 1, 'child age is newborn');
end $$;

-- --------------------------------------------------------------- leave one
select pg_temp.login('26222222-2222-2222-2222-222222222222');
do $$
declare v_mar uuid;
begin
  select id into v_mar from marriages where status = 'active' limit 1;
  perform pg_temp.assert((marriage_end(v_mar, 'we tried')->>'ok')::boolean, 'either partner can leave the marriage');
  perform pg_temp.assert((select status from marriages where id = v_mar) = 'ended', 'marriage ended');
end $$;

-- ------------------------------------------------------------------- RLS
select pg_temp.login('26333333-3333-3333-3333-333333333333');
select pg_temp.assert((select count(*) from marriages) = 0, 'marriages are private to the partners');
select pg_temp.assert((select count(*) from characters) > 0, 'character rows are public (family trees)');
select pg_temp.assert((select count(*) from births) = 1, 'the birth registry is public');

-- the family phase must not disturb the G economy
select pg_temp.logout();
select pg_temp.assert((economy_audit()->>'ok')::boolean, 'supply still balances after family tests');

select 'PASS: all GistCity family tests passed' as result;
