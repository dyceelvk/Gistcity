-- Behavioural tests for the GistCity society migration (education, vehicles,
-- government employment, churches). Runs after economy_test.sql on the same
-- scratch database (users ada 1111…, bayo 2222…, impostor 3333… exist).

\set ON_ERROR_STOP on
\set QUIET on

create or replace function pg_temp.assert(cond boolean, msg text) returns void language plpgsql as $$
begin if not cond then raise exception 'ASSERTION FAILED: %', msg; end if; end $$;
create or replace function pg_temp.login(u uuid) returns void language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', u::text, false); execute 'set role authenticated'; end $$;
create or replace function pg_temp.logout() returns void language plpgsql as $$
begin execute 'reset role'; perform set_config('request.jwt.claim.sub', '', false); end $$;
create or replace function pg_temp.wallet(u uuid) returns bigint language sql as $$ select balance from public.accounts where owner_id = u and kind = 'player' $$;
create or replace function pg_temp.acct(c text) returns bigint language sql as $$ select balance from public.accounts where code = c $$;
-- superuser top-up for tests (moves G from the treasury; nothing is minted)
create or replace function pg_temp.topup(u uuid, amt bigint) returns void language plpgsql as $$
begin perform public.post_transaction((select id from public.accounts where code = 'treasury'), (select id from public.accounts where owner_id = u and kind = 'player'), amt, 'test_topup', '{}'::jsonb, gen_random_uuid(), null); end $$;


-- ------------------------------------------------------------------ education
do $$
declare r jsonb; w0 bigint; s0 bigint; k uuid := gen_random_uuid(); cert jsonb;
begin
  w0 := pg_temp.wallet('11111111-1111-1111-1111-111111111111'::uuid); s0 := pg_temp.acct('inst:school');
  perform pg_temp.login('11111111-1111-1111-1111-111111111111'::uuid);
  r := public.school_enroll('drivers-licence', k);
  perform pg_temp.assert((r->>'ok')::boolean, 'enrol ok: ' || r::text);
  r := public.school_enroll('drivers-licence', k);
  perform pg_temp.assert((r->>'replay')::boolean, 'enrol replay flagged');
  perform pg_temp.logout();
  perform pg_temp.assert(pg_temp.wallet('11111111-1111-1111-1111-111111111111'::uuid) = w0 - 3000, 'tuition charged once');
  perform pg_temp.assert(pg_temp.acct('inst:school') = s0 + 3000, 'tuition reached the school account');

  perform pg_temp.login('11111111-1111-1111-1111-111111111111'::uuid);
  r := public.school_take_exam('drivers-licence', gen_random_uuid());
  perform pg_temp.assert(r->>'error' = 'GC_CLASSES_INCOMPLETE', 'exam refused before classes');
  r := public.school_attend_class('drivers-licence');
  perform pg_temp.assert((r->>'ok')::boolean and (r->>'classes_attended')::int = 1, 'first class attended');
  r := public.school_attend_class('drivers-licence');
  perform pg_temp.assert(r->>'error' = 'GC_COOLDOWN', 'second class blocked by cooldown');
  perform pg_temp.logout();
  update public.enrollments set last_class_at = now() - interval '1 hour' where user_id = '11111111-1111-1111-1111-111111111111'::uuid;
  perform pg_temp.login('11111111-1111-1111-1111-111111111111'::uuid);
  r := public.school_attend_class('drivers-licence');
  perform pg_temp.assert((r->>'ready')::boolean, 'ready for exam after required classes');
  perform pg_temp.logout();
  -- two extra classes guarantee a pass (score >= 70, pass mark 60): deterministic for the test
  update public.enrollments set classes_attended = 4 where user_id = '11111111-1111-1111-1111-111111111111'::uuid and course_id = 'drivers-licence';
  perform pg_temp.login('11111111-1111-1111-1111-111111111111'::uuid);
  k := gen_random_uuid();
  r := public.school_take_exam('drivers-licence', k);
  perform pg_temp.assert((r->>'passed')::boolean, 'exam passed: ' || r::text);
  cert := r->'certificate';
  perform pg_temp.assert(cert->>'serial' like 'GC-%', 'certificate serial issued');
  r := public.school_take_exam('drivers-licence', k);
  perform pg_temp.assert((r->>'replay')::boolean and (r->>'passed')::boolean, 'exam replay returns the same result');
  r := public.school_enroll('drivers-licence', gen_random_uuid());
  perform pg_temp.assert(r->>'error' = 'GC_ALREADY_CERTIFIED', 'cannot re-enrol after certification');
  r := public.verify_certificate(cert->>'serial');
  perform pg_temp.assert((r->>'valid')::boolean and r->>'holder' like 'Ada%', 'certificate verifies publicly');
  r := public.my_education();
  perform pg_temp.assert(jsonb_array_length(r->'certificates') = 1, 'my_education lists the certificate');
  perform pg_temp.assert((select count(*) from public.certificates) = 1, 'RLS: ada sees only her certificate');
  perform pg_temp.logout();
  perform pg_temp.assert(public.has_certificate('11111111-1111-1111-1111-111111111111'::uuid, 'drivers-licence'), 'has_certificate true');
  perform pg_temp.assert(not public.has_certificate('22222222-2222-2222-2222-222222222222'::uuid, 'drivers-licence'), 'bayo has no licence');
end $$;

-- ------------------------------------------------------------------- vehicles
do $$
declare r jsonb; k uuid := gen_random_uuid(); v uuid; w0 bigint; d0 bigint; st0 int;
begin
  perform pg_temp.login('22222222-2222-2222-2222-222222222222'::uuid);
  r := public.buy_vehicle('keke-napep', '#f1c40f', 60, 10, 0, gen_random_uuid());
  perform pg_temp.assert(r->>'error' = 'GC_LICENCE_REQUIRED', 'no licence, no vehicle');
  perform pg_temp.logout();
  perform pg_temp.login('11111111-1111-1111-1111-111111111111'::uuid);
  r := public.buy_vehicle('keke-napep', '#f1c40f', 60, 10, 0, gen_random_uuid());
  perform pg_temp.assert(r->>'error' = 'GC_INSUFFICIENT_FUNDS', 'cannot afford a keke yet');
  perform pg_temp.logout();
  perform pg_temp.topup('11111111-1111-1111-1111-111111111111'::uuid, 100000);
  w0 := pg_temp.wallet('11111111-1111-1111-1111-111111111111'::uuid); d0 := pg_temp.acct('inst:dealership'); st0 := (select stock from public.vehicle_models where id = 'keke-napep');
  perform pg_temp.login('11111111-1111-1111-1111-111111111111'::uuid);
  r := public.buy_vehicle('keke-napep', '#f1c40f', 60, 10, 0, k);
  perform pg_temp.assert((r->>'ok')::boolean, 'keke bought: ' || r::text);
  v := (r->'vehicle'->>'id')::uuid;
  r := public.buy_vehicle('keke-napep', '#f1c40f', 60, 10, 0, k);
  perform pg_temp.assert((r->>'replay')::boolean and (r->'vehicle'->>'id')::uuid = v, 'duplicate purchase request returns the same vehicle');
  perform pg_temp.logout();
  perform pg_temp.assert(pg_temp.wallet('11111111-1111-1111-1111-111111111111'::uuid) = w0 - 45000, 'charged exactly once');
  perform pg_temp.assert(pg_temp.acct('inst:dealership') = d0 + 45000, 'dealership received the payment');
  perform pg_temp.assert((select stock from public.vehicle_models where id = 'keke-napep') = st0 - 1, 'stock decremented once');
  perform pg_temp.assert((select owner_id from public.vehicles where id = v) = '11111111-1111-1111-1111-111111111111'::uuid, 'ownership assigned');
  perform pg_temp.assert((select count(*) from public.transactions where reason = 'vehicle_purchase') = 1, 'one ledger entry');

  perform pg_temp.login('22222222-2222-2222-2222-222222222222'::uuid);
  begin
    r := public.park_vehicle(v, 1, 2, 0, 'city');
    perform pg_temp.assert(false, 'bayo must not move ada''s keke');
  exception when others then perform pg_temp.assert(sqlerrm = 'GC_NOT_AUTHORISED', 'park refused: ' || sqlerrm); end;
  perform pg_temp.logout();
  perform pg_temp.login('11111111-1111-1111-1111-111111111111'::uuid);
  r := public.vehicle_share(v, 'bayo', true);
  perform pg_temp.assert((r->>'ok')::boolean, 'key shared with bayo');
  perform pg_temp.logout();
  perform pg_temp.login('22222222-2222-2222-2222-222222222222'::uuid);
  r := public.park_vehicle(v, 12, -8, 1.5, 'city');
  perform pg_temp.assert((r->>'ok')::boolean, 'key holder can park');
  r := public.my_vehicles();
  perform pg_temp.assert(jsonb_array_length(r) = 1 and not (r->0->>'mine')::boolean, 'shared vehicle listed as not mine');
  perform pg_temp.logout();
  perform pg_temp.assert((select x from public.vehicles where id = v) = 12, 'parking position stored');
end $$;

-- ----------------------------------------------------------------- government
do $$
declare r jsonb; app uuid; q jsonb; answers jsonb := '{}'::jsonb; qid int; pay0 bigint; w0 bigint; k uuid := gen_random_uuid(); i int;
begin
  update public.gov_config set value = '0' where key = 'step_interval_s';
  perform pg_temp.login('22222222-2222-2222-2222-222222222222'::uuid);
  r := public.gov_apply('registry-clerk');
  perform pg_temp.assert(r->>'error' = 'GC_CERTIFICATE_REQUIRED', 'application needs the diploma');
  perform pg_temp.logout();
  perform pg_temp.login('11111111-1111-1111-1111-111111111111'::uuid);
  r := public.gov_apply('road-marshal');
  perform pg_temp.assert((r->>'ok')::boolean, 'ada applied: ' || r::text);
  app := (r->>'application_id')::uuid;
  r := public.gov_apply('road-marshal');
  perform pg_temp.assert(r->>'error' = 'GC_APPLICATION_OPEN', 'only one open application');
  for i in 1..6 loop perform public.gov_process(); end loop;
  r := public.gov_my_status();
  perform pg_temp.assert((r->'application'->>'step')::int = 6, 'auto steps reached interview (step 6), got ' || (r->'application'->>'step'));
  perform pg_temp.assert((r->'application'->>'queue_no') is not null, 'queue number assigned');
  q := public.gov_interview_questions();
  perform pg_temp.assert(jsonb_array_length(q->'questions') = 3, 'three interview questions');
  perform pg_temp.assert(q->'questions'->0 ? 'answer' = false, 'answers are not exposed');
  perform pg_temp.logout();
  -- answer correctly using the hidden answer key (test only)
  for i in 0..2 loop
    qid := (q->'questions'->i->>'id')::int;
    answers := answers || jsonb_build_object(qid::text, (select answer from public.gov_interview_questions where id = qid));
  end loop;
  perform pg_temp.login('11111111-1111-1111-1111-111111111111'::uuid);
  r := public.gov_attend_interview(answers);
  perform pg_temp.assert((r->>'passed')::boolean and (r->>'step')::int = 8, 'interview passed → offer issued');
  r := public.gov_work_shift(gen_random_uuid());
  perform pg_temp.assert(r->>'error' = 'GC_NOT_EMPLOYED', 'no salary before onboarding');
  r := public.gov_accept_offer(true);
  perform pg_temp.assert((r->>'ok')::boolean and (r->>'step')::int = 10 and r->>'employee_no' like 'GOV-%', 'onboarded with employee number');
  perform pg_temp.logout();
  pay0 := pg_temp.acct('payroll'); w0 := pg_temp.wallet('11111111-1111-1111-1111-111111111111'::uuid);
  perform pg_temp.login('11111111-1111-1111-1111-111111111111'::uuid);
  r := public.gov_work_shift(k);
  perform pg_temp.assert((r->>'ok')::boolean and (r->>'paid')::bigint = 15000, 'shift paid 15,000 G');
  r := public.gov_work_shift(k);
  perform pg_temp.assert((r->>'replay')::boolean, 'same shift key is not paid twice');
  r := public.gov_work_shift(gen_random_uuid());
  perform pg_temp.assert(r->>'error' = 'GC_COOLDOWN', 'next shift waits for the cooldown');
  r := public.gov_my_status();
  perform pg_temp.assert(r->'employment'->>'title' = 'Road Safety Marshal' and (r->'employment'->>'shifts_worked')::int = 1, 'status shows employment');
  r := public.gov_apply('registry-clerk');
  perform pg_temp.assert(r->>'error' = 'GC_ALREADY_EMPLOYED', 'employees cannot apply again');
  perform pg_temp.logout();
  perform pg_temp.assert(pg_temp.acct('payroll') = pay0 - 15000, 'salary came from the payroll account');
  perform pg_temp.assert(pg_temp.wallet('11111111-1111-1111-1111-111111111111'::uuid) = w0 + 15000, 'salary reached the wallet');
  perform pg_temp.assert((select count(*) from public.gov_audit_log where target_id = app::text) >= 8, 'every step was audited');
  perform pg_temp.assert((select count(*) from public.gov_audit_log where action = 'salary_paid') = 1, 'salary audited');
  perform pg_temp.assert(jsonb_array_length((select history from public.gov_applications where id = app)) >= 9, 'application history complete');
  update public.gov_config set value = '20' where key = 'step_interval_s';
end $$;

-- ------------------------------------------------------------------- churches
do $$
declare r jsonb; k uuid := gen_random_uuid(); c0 bigint; w0 bigint; v_sid bigint; v_cid uuid; v_slug text;
begin
  select ch.id into v_cid from public.churches ch where ch.slug = 'grace-chapel';
  insert into public.church_services (church_id, title, every_min, offset_min, duration_min) values (v_cid, 'Test service (always live)', 10, 0, 10) returning id into v_sid;
  perform pg_temp.login('11111111-1111-1111-1111-111111111111'::uuid);
  r := public.church_info('grace-chapel');
  perform pg_temp.assert(r->>'name' = 'Grace Chapel GistCity' and (r->>'seats')::int = 48 and (r->>'members')::int = 0, 'church info: ' || r::text);
  r := public.church_join('grace-chapel');
  perform pg_temp.assert((r->>'ok')::boolean and (r->>'members')::int = 1, 'joined');
  perform pg_temp.logout();
  c0 := pg_temp.acct('church:grace-chapel'); w0 := pg_temp.wallet('11111111-1111-1111-1111-111111111111'::uuid);
  perform pg_temp.login('11111111-1111-1111-1111-111111111111'::uuid);
  r := public.church_offer('grace-chapel', 1000, k);
  perform pg_temp.assert((r->>'ok')::boolean, 'offering ok');
  r := public.church_offer('grace-chapel', 1000, k);
  perform pg_temp.assert((r->>'ok')::boolean, 'offering replay ok');
  r := public.church_offer('grace-chapel', 0, gen_random_uuid());
  perform pg_temp.assert(r->>'error' = 'GC_INVALID_AMOUNT', 'zero offering rejected');
  r := public.church_attend(v_sid);
  perform pg_temp.assert((r->>'ok')::boolean and (r->>'seat_no')::int = 1, 'seat 1 reserved');
  r := public.church_attend(v_sid);
  perform pg_temp.assert((r->>'replay')::boolean and (r->>'seat_no')::int = 1, 'same seat on repeat');
  perform pg_temp.logout();
  perform pg_temp.assert(pg_temp.acct('church:grace-chapel') = c0 + 1000 and pg_temp.wallet('11111111-1111-1111-1111-111111111111'::uuid) = w0 - 1000, 'offering moved exactly 1,000 G once');
  perform pg_temp.login('22222222-2222-2222-2222-222222222222'::uuid);
  r := public.church_attend(v_sid);
  perform pg_temp.assert((r->>'seat_no')::int = 2, 'bayo got seat 2');
  perform pg_temp.logout();
  update public.churches ch set seats = 10 where ch.id = v_cid; insert into auth.users (id, email, raw_user_meta_data) select gen_random_uuid(), 'filler' || g || '@example.com', '{"username":"filler_user","display_name":"Filler","tos_accepted":true,"privacy_accepted":true,"age_confirmed":true}'::jsonb from generate_series(1, 8) g;
  insert into public.church_attendance (service_id, occurrence, user_id, seat_no) select v_sid, (select occurrence from public.service_state(10, 0, 10)), u.id, 2 + row_number() over () from auth.users u where u.email like 'filler%';
  perform pg_temp.login('33333333-3333-3333-3333-333333333333'::uuid);
  r := public.church_attend(v_sid);
  perform pg_temp.assert(r->>'error' = 'GC_NO_SEATS', 'hall full');
  perform pg_temp.logout();
  update public.churches ch set seats = 48 where ch.id = v_cid;
  perform pg_temp.login('11111111-1111-1111-1111-111111111111'::uuid);
  r := public.church_info('grace-chapel');
  perform pg_temp.assert((r->>'attending_now')::int = 10 and (r->>'available')::int = 38 and (r->>'balance')::bigint = c0 + 1000, 'info reflects attendance, seats and balance: ' || r::text);
  perform pg_temp.assert(r->>'my_role' = 'member', 'my role');
  perform pg_temp.logout();

  -- register a congregation
  perform pg_temp.login('22222222-2222-2222-2222-222222222222'::uuid);
  r := public.church_register('Living Water Assembly', 'Youth-led fellowship.', gen_random_uuid());
  perform pg_temp.assert(r->>'error' = 'GC_INSUFFICIENT_FUNDS', 'registration fee enforced');
  perform pg_temp.logout();
  perform pg_temp.topup('22222222-2222-2222-2222-222222222222'::uuid, 60000);
  perform pg_temp.login('22222222-2222-2222-2222-222222222222'::uuid);
  k := gen_random_uuid();
  r := public.church_register('Living Water Assembly', 'Youth-led fellowship.', k);
  perform pg_temp.assert((r->>'ok')::boolean, 'church registered: ' || r::text);
  v_slug := r->>'slug';
  perform pg_temp.assert(v_slug = 'living-water-assembly', 'slug derived');
  r := public.church_register('Living Water Assembly', '', k);
  perform pg_temp.assert((r->>'replay')::boolean, 'registration replay');
  r := public.church_leave(v_slug);
  perform pg_temp.assert(r->>'error' = 'GC_PASTOR_CANNOT_LEAVE', 'pastor cannot leave own church');
  r := public.church_salary(v_slug, 'propose', 5000, null);
  perform pg_temp.assert(r->>'status' = 'proposed', 'salary proposed');
  begin
    r := public.church_salary(v_slug, 'approve', null, null);
    perform pg_temp.assert(false, 'pastor must not approve own salary');
  exception when others then perform pg_temp.assert(sqlerrm = 'GC_NOT_AUTHORISED', 'self-approval refused: ' || sqlerrm); end;
  perform pg_temp.logout();
  perform pg_temp.assert(pg_temp.acct('church:' || v_slug) = 0, 'new church starts at zero');
  perform pg_temp.login('11111111-1111-1111-1111-111111111111'::uuid);
  r := public.church_join(v_slug);
  perform pg_temp.assert((r->>'ok')::boolean, 'ada moved congregation');
  r := public.church_offer(v_slug, 20000, gen_random_uuid());
  perform pg_temp.assert((r->>'ok')::boolean, 'offering to new church');
  r := public.church_salary(v_slug, 'approve', null, null);
  perform pg_temp.assert(r->>'status' = 'approved', 'member approved salary');
  perform pg_temp.logout();
  perform pg_temp.assert((select count(*) from public.church_members where user_id = '11111111-1111-1111-1111-111111111111'::uuid) = 1, 'one congregation at a time');
  perform pg_temp.login('22222222-2222-2222-2222-222222222222'::uuid);
  w0 := pg_temp.wallet('22222222-2222-2222-2222-222222222222'::uuid);
  r := public.church_salary(v_slug, 'claim', null, gen_random_uuid());
  perform pg_temp.assert((r->>'ok')::boolean, 'salary claimed: ' || r::text);
  r := public.church_salary(v_slug, 'claim', null, gen_random_uuid());
  perform pg_temp.assert(r->>'error' = 'GC_COOLDOWN', 'salary once per period');
  r := public.church_pay(v_slug, 'ada_lagos', 2500, 'Sound equipment', gen_random_uuid());
  perform pg_temp.assert((r->>'ok')::boolean, 'authorised expense paid');
  r := public.church_pay(v_slug, 'ada_lagos', 1, '', gen_random_uuid());
  perform pg_temp.assert(r->>'error' = 'GC_REASON_REQUIRED', 'expenses need a reason');
  perform pg_temp.logout();
  perform pg_temp.assert(pg_temp.wallet('22222222-2222-2222-2222-222222222222'::uuid) = w0 + 5000, 'pastor received 5,000 G');
  perform pg_temp.assert(pg_temp.acct('church:' || v_slug) = 20000 - 5000 - 2500, 'church account reconciles');
  perform pg_temp.login('11111111-1111-1111-1111-111111111111'::uuid);
  begin
    r := public.church_pay(v_slug, 'bayo', 100, 'theft', gen_random_uuid());
    perform pg_temp.assert(false, 'members cannot spend church money');
  exception when others then perform pg_temp.assert(sqlerrm = 'GC_NOT_AUTHORISED', 'member spend refused'); end;
  perform pg_temp.logout();
end $$;

-- --------------------------------------------------------------- me() & audit
do $$
declare r jsonb;
begin
  perform pg_temp.login('11111111-1111-1111-1111-111111111111'::uuid);
  r := public.me();
  perform pg_temp.assert(r->'certificates' ? 'drivers-licence', 'me() lists certificates');
  perform pg_temp.assert(r->'employment'->>'title' = 'Road Safety Marshal', 'me() lists employment');
  perform pg_temp.assert(r->'church'->>'slug' = 'living-water-assembly', 'me() lists church');
  r := public.city_stats();
  perform pg_temp.assert((r->>'vehicles')::int = 1 and (r->>'gov_employees')::int = 1, 'city stats');
  perform pg_temp.logout();
  r := public.economy_audit();
  perform pg_temp.assert((r->>'ok')::boolean, 'supply still balances: ' || r::text);
end $$;

select 'PASS: all GistCity society tests passed' as result;
