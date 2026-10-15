-- GISTCITY · Society migration (Phases 4–8 foundations)
-- ---------------------------------------------------------------------------
-- Adds the civic systems that make the city a society:
--   • Education: courses, enrollments, classes, exams, server-issued certificates
--   • Vehicles: dealership models/stock, ownership, keys (access), parking
--   • Government: departments, positions, the 10-step employment workflow with a
--     FIFO queue, interviews, offers, onboarding, salaried shifts paid from the
--     Government Payroll account, full audit log
--   • Churches: registration, membership, scheduled services with seat
--     reservations, offerings into the church account, pastor-authorised
--     expenses and salary agreements
--   • Hospital: paid treatment, pharmacy items
-- Every function is SECURITY DEFINER, checks auth.uid(), never trusts client
-- prices/balances/permissions, and money only moves through post_transaction()
-- (atomic, idempotent, no negative balances). Idempotent: safe to re-run.

-- ================================================================ accounts
alter table public.accounts drop constraint if exists accounts_kind_check;
alter table public.accounts add constraint accounts_kind_check
  check (kind in ('player','treasury','payroll','development','community','starter_pool','business','church','sink','institution'));

insert into public.accounts (kind, code, name) values
  ('institution', 'inst:school',     'Unity College (tuition)'),
  ('institution', 'inst:hospital',   'GistCity General Hospital'),
  ('institution', 'inst:dealership', 'Odogwu Motors'),
  ('institution', 'inst:government', 'Government Secretariat (service fees)'),
  ('business',    'biz:iron_temple', 'Iron Temple Gym')
on conflict (code) do nothing;

alter table public.catalog_items drop constraint if exists catalog_items_category_check;
alter table public.catalog_items add constraint catalog_items_category_check
  check (category in ('top','bottom','accessory','furniture','food','drink','service','medicine'));
insert into public.catalog_items (id, category, name, price, merchant, consumable, effects) values
  ('med-paracetamol', 'medicine', 'Paracetamol (pack)',      800, 'inst:hospital', true, '{"health":20}'),
  ('med-vitamin-c',   'medicine', 'Vitamin C & multivitamin', 1200, 'inst:hospital', true, '{"health":10,"energy":10}'),
  ('svc-treatment',   'service',  'Doctor consultation & treatment', 2500, 'inst:hospital', true, '{"health":60,"energy":10,"xp":5}'),
  ('food-moimoi',     'food',     'Hospital canteen moi-moi & pap', 450, 'inst:hospital', true, '{"hunger":30,"thirst":15}'),
  ('svc-gym',         'service',  'Iron Temple gym session', 300, 'biz:iron_temple', true, '{"health":8,"energy":-10,"thirst":-10,"reputation":1,"xp":8}')
on conflict (id) do update set name = excluded.name, price = excluded.price, merchant = excluded.merchant, consumable = excluded.consumable, effects = excluded.effects, category = excluded.category;

-- Small helper used by every function below.
create or replace function public.gc_require_active()
returns uuid language plpgsql stable security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_status text;
begin
  if v_uid is null then raise exception 'GC_NOT_SIGNED_IN'; end if;
  select status into v_status from profiles where id = v_uid;
  if v_status is distinct from 'active' then raise exception 'GC_ACCOUNT_RESTRICTED'; end if;
  return v_uid;
end $$;
revoke all on function public.gc_require_active() from public, anon;
grant execute on function public.gc_require_active() to authenticated;

-- ================================================================ education
create table if not exists public.courses (
  id                text primary key,
  title             text not null,
  institution       text not null default 'Unity College',
  fee               bigint not null check (fee >= 0),
  classes_required  int not null check (classes_required between 1 and 20),
  pass_mark         int not null default 60 check (pass_mark between 1 and 100),
  class_cooldown_s  int not null default 30,
  certificate_title text not null,
  description       text not null default '',
  sort              int not null default 0,
  active            boolean not null default true
);
insert into public.courses (id, title, fee, classes_required, pass_mark, class_cooldown_s, certificate_title, description, sort) values
  ('drivers-licence',   'Driving School & Licence Test',   3000, 2, 60, 20, 'GistCity Driver''s Licence',           'Road signs, parking and the highway code. Odogwu Motors will not sell a vehicle to anyone without this licence.', 1),
  ('computer-studies',  'Basic Computer Studies',           5000, 3, 60, 25, 'Certificate in Computer Studies',      'Typing, spreadsheets and e-mail. Opens IT support positions in government.', 2),
  ('public-admin',      'Diploma in Public Administration', 12000, 4, 60, 30, 'Diploma in Public Administration',   'How the Secretariat works. Required for registry and revenue positions.', 3),
  ('nursing-assistant', 'Nursing Assistant Course',         15000, 4, 65, 30, 'Nursing Assistant Certificate',      'First aid, patient care and hygiene. Required for community health positions.', 4),
  ('business-basics',   'Small Business Management',        8000, 3, 60, 25, 'Certificate in Business Management', 'Book-keeping, pricing and staff. Will be required to register a business.', 5)
on conflict (id) do update set title = excluded.title, fee = excluded.fee, classes_required = excluded.classes_required, pass_mark = excluded.pass_mark, class_cooldown_s = excluded.class_cooldown_s, certificate_title = excluded.certificate_title, description = excluded.description, sort = excluded.sort;
alter table public.courses enable row level security;
drop policy if exists "courses: public read" on public.courses;
create policy "courses: public read" on public.courses for select to anon, authenticated using (active);
grant select on public.courses to anon, authenticated;

create table if not exists public.enrollments (
  id               bigint generated always as identity primary key,
  user_id          uuid not null references auth.users(id) on delete cascade,
  course_id        text not null references public.courses(id),
  classes_attended int not null default 0,
  status           text not null default 'enrolled' check (status in ('enrolled','passed')),
  attempts         int not null default 0,
  last_class_at    timestamptz,
  enrolled_at      timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (user_id, course_id)
);
alter table public.enrollments enable row level security;
drop policy if exists "enrollments: read own" on public.enrollments;
create policy "enrollments: read own" on public.enrollments for select to authenticated using (user_id = auth.uid());
grant select on public.enrollments to authenticated;

create table if not exists public.certificates (
  id        uuid primary key default gen_random_uuid(),
  user_id   uuid not null references auth.users(id) on delete cascade,
  course_id text not null references public.courses(id),
  title     text not null,
  grade     text not null,
  score     int not null,
  serial    text not null unique,
  issued_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index if not exists certificates_user_idx on public.certificates (user_id);
alter table public.certificates enable row level security;
drop policy if exists "certificates: read own" on public.certificates;
create policy "certificates: read own" on public.certificates for select to authenticated using (user_id = auth.uid());
grant select on public.certificates to authenticated;

create table if not exists public.exam_log (
  key       uuid primary key,
  user_id   uuid not null,
  course_id text not null,
  score     int not null,
  passed    boolean not null,
  at        timestamptz not null default now()
);

create or replace function public.has_certificate(p_user uuid, p_course text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.certificates where user_id = p_user and course_id = p_course and revoked_at is null);
$$;
revoke all on function public.has_certificate(uuid, text) from public, anon;
grant execute on function public.has_certificate(uuid, text) to authenticated;

create or replace function public.my_education()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'courses', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', c.id, 'title', c.title, 'fee', c.fee, 'classes_required', c.classes_required, 'pass_mark', c.pass_mark,
        'certificate_title', c.certificate_title, 'description', c.description, 'class_cooldown_s', c.class_cooldown_s,
        'status', e.status, 'classes_attended', coalesce(e.classes_attended, 0), 'attempts', coalesce(e.attempts, 0),
        'next_class_in', case when e.last_class_at is null then 0 else greatest(0, ceil(extract(epoch from (e.last_class_at + make_interval(secs => c.class_cooldown_s) - now())))::int) end
      ) order by c.sort), '[]'::jsonb)
      from public.courses c left join public.enrollments e on e.course_id = c.id and e.user_id = auth.uid() where c.active),
    'certificates', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'course_id', course_id, 'title', title, 'grade', grade, 'score', score, 'serial', serial, 'issued_at', issued_at) order by issued_at desc), '[]'::jsonb)
      from public.certificates where user_id = auth.uid() and revoked_at is null));
$$;
grant execute on function public.my_education() to authenticated;

-- Pay tuition once and enrol. Replays (same key) return the existing enrolment.
create or replace function public.school_enroll(p_course text, p_key uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := gc_require_active(); c record; e record; v_wallet uuid; v_school uuid; v_tx bigint;
begin
  if p_key is null then raise exception 'GC_KEY_REQUIRED'; end if;
  select * into c from courses where id = p_course and active;
  if not found then raise exception 'GC_UNKNOWN_COURSE'; end if;
  select id into v_wallet from accounts where owner_id = v_uid and kind = 'player';
  select id into v_school from accounts where code = 'inst:school';
  select * into e from enrollments where user_id = v_uid and course_id = c.id;
  if found then
    if e.status = 'passed' then return jsonb_build_object('ok', false, 'error', 'GC_ALREADY_CERTIFIED', 'balance', (select balance from accounts where id = v_wallet)); end if;
    return jsonb_build_object('ok', true, 'replay', true, 'balance', (select balance from accounts where id = v_wallet));
  end if;
  if c.fee > 0 then
    begin
      v_tx := post_transaction(v_wallet, v_school, c.fee, 'tuition', jsonb_build_object('course', c.id), p_key, v_uid);
    exception when others then
      if sqlerrm = 'GC_INSUFFICIENT_FUNDS' then return jsonb_build_object('ok', false, 'error', 'GC_INSUFFICIENT_FUNDS', 'balance', (select balance from accounts where id = v_wallet)); end if;
      raise;
    end;
  end if;
  insert into enrollments (user_id, course_id) values (v_uid, c.id) on conflict (user_id, course_id) do nothing;
  return jsonb_build_object('ok', true, 'tx', v_tx, 'balance', (select balance from accounts where id = v_wallet));
end $$;
grant execute on function public.school_enroll(text, uuid) to authenticated;

-- One class per cooldown. Up to two extra classes beyond the requirement count as exam preparation.
create or replace function public.school_attend_class(p_course text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := gc_require_active(); c record; e record; v_wait int;
begin
  select * into c from courses where id = p_course and active;
  if not found then raise exception 'GC_UNKNOWN_COURSE'; end if;
  select * into e from enrollments where user_id = v_uid and course_id = c.id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'GC_NOT_ENROLLED'); end if;
  if e.status = 'passed' then return jsonb_build_object('ok', false, 'error', 'GC_ALREADY_CERTIFIED'); end if;
  if e.last_class_at is not null and e.last_class_at > now() - make_interval(secs => c.class_cooldown_s) then
    v_wait := ceil(extract(epoch from (e.last_class_at + make_interval(secs => c.class_cooldown_s) - now())))::int;
    return jsonb_build_object('ok', false, 'error', 'GC_COOLDOWN', 'retry_in', v_wait, 'classes_attended', e.classes_attended, 'classes_required', c.classes_required);
  end if;
  if e.classes_attended >= c.classes_required + 2 then
    return jsonb_build_object('ok', false, 'error', 'GC_READY_FOR_EXAM', 'classes_attended', e.classes_attended, 'classes_required', c.classes_required);
  end if;
  update enrollments set classes_attended = classes_attended + 1, last_class_at = now(), updated_at = now() where id = e.id returning * into e;
  return jsonb_build_object('ok', true, 'classes_attended', e.classes_attended, 'classes_required', c.classes_required, 'ready', e.classes_attended >= c.classes_required);
end $$;
grant execute on function public.school_attend_class(text) to authenticated;

-- The exam is marked on the server. Pass → certificate with a verifiable serial.
create or replace function public.school_take_exam(p_course text, p_key uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := gc_require_active(); c record; e record; v_score int; v_grade text; v_serial text; cert record; prev record;
begin
  if p_key is null then raise exception 'GC_KEY_REQUIRED'; end if;
  select * into prev from exam_log where key = p_key;
  if found then
    select * into cert from certificates where user_id = v_uid and course_id = prev.course_id and revoked_at is null;
    return jsonb_build_object('ok', true, 'replay', true, 'passed', prev.passed, 'score', prev.score, 'certificate', to_jsonb(cert));
  end if;
  select * into c from courses where id = p_course and active;
  if not found then raise exception 'GC_UNKNOWN_COURSE'; end if;
  select * into e from enrollments where user_id = v_uid and course_id = c.id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'GC_NOT_ENROLLED'); end if;
  if e.status = 'passed' then return jsonb_build_object('ok', false, 'error', 'GC_ALREADY_CERTIFIED'); end if;
  if e.classes_attended < c.classes_required then return jsonb_build_object('ok', false, 'error', 'GC_CLASSES_INCOMPLETE', 'classes_attended', e.classes_attended, 'classes_required', c.classes_required); end if;
  -- 50–90 base, +10 per extra class attended (max 2): preparation is rewarded, luck matters a little.
  v_score := least(100, 50 + floor(random() * 41)::int + 10 * least(2, e.classes_attended - c.classes_required));
  insert into exam_log (key, user_id, course_id, score, passed) values (p_key, v_uid, c.id, v_score, v_score >= c.pass_mark);
  if v_score >= c.pass_mark then
    v_grade := case when v_score >= 85 then 'A' when v_score >= 75 then 'B' else 'C' end;
    loop
      v_serial := 'GC-' || upper(substr(encode(gen_random_bytes(6), 'hex'), 1, 10));
      exit when not exists (select 1 from certificates where serial = v_serial);
    end loop;
    insert into certificates (user_id, course_id, title, grade, score, serial) values (v_uid, c.id, c.certificate_title, v_grade, v_score, v_serial) returning * into cert;
    update enrollments set status = 'passed', attempts = attempts + 1, updated_at = now() where id = e.id;
    return jsonb_build_object('ok', true, 'passed', true, 'score', v_score, 'certificate', to_jsonb(cert));
  end if;
  -- failed: one more class before the next attempt
  update enrollments set attempts = attempts + 1, classes_attended = greatest(0, c.classes_required - 1), updated_at = now() where id = e.id;
  return jsonb_build_object('ok', true, 'passed', false, 'score', v_score, 'pass_mark', c.pass_mark);
end $$;
grant execute on function public.school_take_exam(text, uuid) to authenticated;

-- Anyone can verify a certificate by serial (employers, other players). Returns the holder's public name only.
create or replace function public.verify_certificate(p_serial text)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce((select jsonb_build_object('valid', c.revoked_at is null, 'title', c.title, 'grade', c.grade, 'issued_at', c.issued_at, 'holder', p.display_name, 'username', p.username)
    from public.certificates c join public.profiles p on p.id = c.user_id where c.serial = upper(p_serial)), jsonb_build_object('valid', false));
$$;
grant execute on function public.verify_certificate(text) to anon, authenticated;

-- ================================================================= vehicles
create table if not exists public.vehicle_models (
  id              text primary key,
  name            text not null,
  kind            text not null check (kind in ('car','keke','bus')),
  price           bigint not null check (price >= 0),
  colors          text[] not null,
  top_speed       numeric not null,
  stock           int not null check (stock >= 0),
  requires_licence boolean not null default true,
  description     text not null default '',
  sort            int not null default 0,
  active          boolean not null default true
);
insert into public.vehicle_models (id, name, kind, price, colors, top_speed, stock, requires_licence, description, sort) values
  ('keke-napep',   'Keke NAPEP',          'keke', 45000,   '{#f1c40f,#2ecc71,#2e86de}', 9,  60, true, 'Three wheels, zero stress. The city hustler''s first ride.', 1),
  ('toks-corolla', 'Toks Corolla 2012',   'car',  180000,  '{#bdc3c7,#2c3e50,#c0392b,#ecf0f1}', 14, 40, true, 'Clean tokunbo. Reliable, and the AC works.', 2),
  ('venza-x',      'Venza X crossover',   'car',  420000,  '{#1a1a1a,#7f8c8d,#8e44ad,#e67e22}', 16, 25, true, 'The soft-life crossover.', 3),
  ('odogwu-g630',  'Odogwu G-630',        'car',  1500000, '{#0b0e0c,#ecf0f1,#a5ff38}', 19, 6, true, 'Statement car. Everybody will know you have arrived.', 4),
  ('danfo-14',     'Danfo 14-seater',     'bus',  260000,  '{#f1c40f}', 12, 12, true, 'The yellow bus. Commercial routes coming soon.', 5)
on conflict (id) do update set name = excluded.name, kind = excluded.kind, price = excluded.price, colors = excluded.colors, top_speed = excluded.top_speed, requires_licence = excluded.requires_licence, description = excluded.description, sort = excluded.sort;
alter table public.vehicle_models enable row level security;
drop policy if exists "vehicle_models: public read" on public.vehicle_models;
create policy "vehicle_models: public read" on public.vehicle_models for select to anon, authenticated using (active);
grant select on public.vehicle_models to anon, authenticated;

create table if not exists public.vehicles (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references auth.users(id) on delete cascade,
  model_id     text not null references public.vehicle_models(id),
  color        text not null,
  plate        text not null unique,
  condition    int not null default 100 check (condition between 0 and 100),
  x            real not null default 0,
  z            real not null default 0,
  yaw          real not null default 0,
  area         text not null default 'city',
  purchase_key uuid unique,
  purchased_at timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists vehicles_owner_idx on public.vehicles (owner_id);
create table if not exists public.vehicle_access (
  vehicle_id uuid not null references public.vehicles(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  granted_by uuid,
  granted_at timestamptz not null default now(),
  primary key (vehicle_id, user_id)
);
alter table public.vehicles enable row level security;
alter table public.vehicle_access enable row level security;
drop policy if exists "vehicles: citizens see parked cars" on public.vehicles;
create policy "vehicles: citizens see parked cars" on public.vehicles for select to authenticated using (true);
drop policy if exists "vehicle_access: own" on public.vehicle_access;
create policy "vehicle_access: own" on public.vehicle_access for select to authenticated using (user_id = auth.uid() or exists (select 1 from public.vehicles v where v.id = vehicle_id and v.owner_id = auth.uid()));
grant select on public.vehicles, public.vehicle_access to authenticated;

drop view if exists public.vehicles_public;
create view public.vehicles_public as
  select v.id, v.model_id, v.color, v.plate, v.x, v.z, v.yaw, v.area, v.owner_id, p.display_name as owner_name, p.username as owner_username
  from public.vehicles v join public.profiles p on p.id = v.owner_id;
grant select on public.vehicles_public to authenticated;

create or replace function public.vehicle_can_drive(p_user uuid, p_vehicle uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.vehicles where id = p_vehicle and owner_id = p_user)
      or exists (select 1 from public.vehicle_access where vehicle_id = p_vehicle and user_id = p_user);
$$;
grant execute on function public.vehicle_can_drive(uuid, uuid) to authenticated;

create or replace function public.my_vehicles()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', v.id, 'model_id', v.model_id, 'name', m.name, 'kind', m.kind, 'color', v.color, 'plate', v.plate, 'condition', v.condition,
           'x', v.x, 'z', v.z, 'yaw', v.yaw, 'area', v.area, 'top_speed', m.top_speed, 'owner_id', v.owner_id, 'mine', v.owner_id = auth.uid(),
           'keys', (select coalesce(jsonb_agg(p.username), '[]'::jsonb) from public.vehicle_access a join public.profiles p on p.id = a.user_id where a.vehicle_id = v.id)) order by v.purchased_at), '[]'::jsonb)
  from public.vehicles v join public.vehicle_models m on m.id = v.model_id
  where v.owner_id = auth.uid() or exists (select 1 from public.vehicle_access a where a.vehicle_id = v.id and a.user_id = auth.uid());
$$;
grant execute on function public.my_vehicles() to authenticated;

-- Dealership sale: licence → stock → funds → ownership → stock update → ledger, all in one transaction.
create or replace function public.buy_vehicle(p_model text, p_color text, p_x real, p_z real, p_yaw real, p_key uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := gc_require_active(); m record; v record; v_wallet uuid; v_dealer uuid; v_tx bigint; v_plate text; v_color text;
begin
  if p_key is null then raise exception 'GC_KEY_REQUIRED'; end if;
  select id into v_wallet from accounts where owner_id = v_uid and kind = 'player';
  select id into v_dealer from accounts where code = 'inst:dealership';
  select * into v from vehicles where purchase_key = p_key;
  if found then return jsonb_build_object('ok', true, 'replay', true, 'vehicle', to_jsonb(v), 'balance', (select balance from accounts where id = v_wallet)); end if;
  select * into m from vehicle_models where id = p_model and active for update;
  if not found then raise exception 'GC_UNKNOWN_VEHICLE'; end if;
  if m.requires_licence and not has_certificate(v_uid, 'drivers-licence') then
    return jsonb_build_object('ok', false, 'error', 'GC_LICENCE_REQUIRED', 'balance', (select balance from accounts where id = v_wallet));
  end if;
  if m.stock <= 0 then return jsonb_build_object('ok', false, 'error', 'GC_OUT_OF_STOCK', 'balance', (select balance from accounts where id = v_wallet)); end if;
  v_color := case when p_color = any (m.colors) then p_color else m.colors[1] end;
  if m.price > 0 then
    begin
      v_tx := post_transaction(v_wallet, v_dealer, m.price, 'vehicle_purchase', jsonb_build_object('model', m.id, 'color', v_color), p_key, v_uid);
    exception when others then
      if sqlerrm = 'GC_INSUFFICIENT_FUNDS' then return jsonb_build_object('ok', false, 'error', 'GC_INSUFFICIENT_FUNDS', 'balance', (select balance from accounts where id = v_wallet)); end if;
      raise;
    end;
  end if;
  update vehicle_models set stock = stock - 1 where id = m.id;
  loop
    v_plate := 'GC-' || chr(65 + floor(random() * 26)::int) || chr(65 + floor(random() * 26)::int) || chr(65 + floor(random() * 26)::int) || '-' || lpad(floor(random() * 1000)::text, 3, '0');
    exit when not exists (select 1 from vehicles where plate = v_plate);
  end loop;
  insert into vehicles (owner_id, model_id, color, plate, x, z, yaw, purchase_key)
  values (v_uid, m.id, v_color, v_plate, greatest(-90, least(90, coalesce(p_x, 0))), greatest(-90, least(90, coalesce(p_z, 0))), coalesce(p_yaw, 0), p_key) returning * into v;
  return jsonb_build_object('ok', true, 'tx', v_tx, 'vehicle', to_jsonb(v) || jsonb_build_object('name', m.name, 'kind', m.kind, 'top_speed', m.top_speed, 'mine', true), 'balance', (select balance from accounts where id = v_wallet));
end $$;
grant execute on function public.buy_vehicle(text, text, real, real, real, uuid) to authenticated;

create or replace function public.park_vehicle(p_vehicle uuid, p_x real, p_z real, p_yaw real, p_area text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := gc_require_active();
begin
  if not vehicle_can_drive(v_uid, p_vehicle) then raise exception 'GC_NOT_AUTHORISED'; end if;
  update vehicles set x = greatest(-90, least(90, p_x)), z = greatest(-90, least(90, p_z)), yaw = coalesce(p_yaw, 0), area = coalesce(nullif(p_area, ''), 'city'), updated_at = now() where id = p_vehicle;
  return jsonb_build_object('ok', true);
end $$;
grant execute on function public.park_vehicle(uuid, real, real, real, text) to authenticated;

create or replace function public.vehicle_share(p_vehicle uuid, p_username text, p_grant boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := gc_require_active(); v_to uuid;
begin
  if not exists (select 1 from vehicles where id = p_vehicle and owner_id = v_uid) then raise exception 'GC_NOT_OWNER'; end if;
  select id into v_to from profiles where username = lower(p_username) and status = 'active';
  if v_to is null then return jsonb_build_object('ok', false, 'error', 'GC_UNKNOWN_USER'); end if;
  if v_to = v_uid then return jsonb_build_object('ok', false, 'error', 'GC_SELF'); end if;
  if p_grant then insert into vehicle_access (vehicle_id, user_id, granted_by) values (p_vehicle, v_to, v_uid) on conflict do nothing;
  else delete from vehicle_access where vehicle_id = p_vehicle and user_id = v_to; end if;
  return jsonb_build_object('ok', true);
end $$;
grant execute on function public.vehicle_share(uuid, text, boolean) to authenticated;

-- =============================================================== government
create table if not exists public.gov_config (key text primary key, value jsonb not null);
insert into public.gov_config (key, value) values
  ('step_interval_s', '20'),        -- how long the office takes between automatic steps
  ('shift_cooldown_s', '120'),      -- one paid shift per two minutes of real time
  ('interview_pass', '2'),          -- correct answers (of 3) needed
  ('max_interview_attempts', '3')
on conflict (key) do nothing;

create table if not exists public.gov_departments (code text primary key, name text not null, description text not null default '');
insert into public.gov_departments (code, name, description) values
  ('registry',  'Civil Registry',             'Records of citizens: births, marriages, certificates.'),
  ('revenue',   'Internal Revenue Service',   'Collects taxes and licence fees for the city.'),
  ('works',     'Ministry of Works & Roads',  'Roads, traffic and public infrastructure.'),
  ('health',    'Ministry of Health',         'Hospitals, clinics and public health campaigns.'),
  ('education', 'Ministry of Education',      'Schools and qualifications.')
on conflict (code) do update set name = excluded.name, description = excluded.description;

create table if not exists public.gov_positions (
  id               text primary key,
  dept             text not null references public.gov_departments(code),
  title            text not null,
  grade            int not null,
  salary_per_shift bigint not null check (salary_per_shift > 0),
  required_course  text references public.courses(id),
  slots            int not null check (slots >= 0),
  description      text not null default '',
  sort             int not null default 0,
  active           boolean not null default true
);
insert into public.gov_positions (id, dept, title, grade, salary_per_shift, required_course, slots, description, sort) values
  ('road-marshal',     'works',     'Road Safety Marshal',          3, 15000, 'drivers-licence',   25, 'Keep the roundabout moving. Shifts at the Secretariat traffic desk.', 1),
  ('registry-clerk',   'registry',  'Registry Clerk',               4, 18000, 'public-admin',      20, 'File citizen records and issue certificates.', 2),
  ('it-support',       'works',     'IT Support Officer',           6, 26000, 'computer-studies',  12, 'Keep the Secretariat computers running.', 3),
  ('health-assistant', 'health',    'Community Health Assistant',   6, 28000, 'nursing-assistant', 12, 'Public health outreach from the Secretariat.', 4),
  ('revenue-officer',  'revenue',   'Revenue Officer',              7, 30000, 'public-admin',      8,  'Assess and collect city revenue.', 5)
on conflict (id) do update set dept = excluded.dept, title = excluded.title, grade = excluded.grade, salary_per_shift = excluded.salary_per_shift, required_course = excluded.required_course, slots = excluded.slots, description = excluded.description, sort = excluded.sort;
alter table public.gov_departments enable row level security;
alter table public.gov_positions enable row level security;
drop policy if exists "gov_departments: public read" on public.gov_departments;
create policy "gov_departments: public read" on public.gov_departments for select to anon, authenticated using (true);
drop policy if exists "gov_positions: public read" on public.gov_positions;
create policy "gov_positions: public read" on public.gov_positions for select to anon, authenticated using (active);
grant select on public.gov_departments, public.gov_positions to anon, authenticated;

create table if not exists public.gov_steps (step int primary key, name text not null, actor text not null, description text not null);
insert into public.gov_steps (step, name, actor, description) values
  (1,  'Application submitted',  'applicant', 'Your application is in the system.'),
  (2,  'Documents verified',     'office',    'The Registry checks your certificate against the school records.'),
  (3,  'Eligibility confirmed',  'office',    'Account in good standing, no other government post.'),
  (4,  'Queued',                 'office',    'You are in the queue for this position (first come, first served).'),
  (5,  'Shortlisted',            'office',    'A slot is available and you reached the front of the queue.'),
  (6,  'Interview scheduled',    'office',    'Come to the Secretariat employment desk for your interview.'),
  (7,  'Interview completed',    'applicant', 'Three questions at the employment desk.'),
  (8,  'Offer issued',           'office',    'Congratulations: a formal offer is waiting for you.'),
  (9,  'Offer accepted',         'applicant', 'Accept the offer at the employment desk.'),
  (10, 'Onboarded',              'office',    'Employee number issued. Report for shifts to earn your salary.')
on conflict (step) do update set name = excluded.name, actor = excluded.actor, description = excluded.description;
alter table public.gov_steps enable row level security;
drop policy if exists "gov_steps: public read" on public.gov_steps;
create policy "gov_steps: public read" on public.gov_steps for select to anon, authenticated using (true);
grant select on public.gov_steps to anon, authenticated;

create sequence if not exists public.gov_queue_seq;
create table if not exists public.gov_applications (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  position_id      text not null references public.gov_positions(id),
  step             int not null default 1 check (step between 1 and 10),
  status           text not null default 'in_progress' check (status in ('in_progress','rejected','withdrawn','hired','declined')),
  queue_no         bigint,
  next_step_at     timestamptz not null default now(),
  interview_attempts int not null default 0,
  interview_score  int,
  reason           text,
  history          jsonb not null default '[]'::jsonb,
  submitted_at     timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create unique index if not exists gov_applications_one_open on public.gov_applications (user_id) where status = 'in_progress';
create index if not exists gov_applications_queue_idx on public.gov_applications (position_id, status, step, queue_no);
alter table public.gov_applications enable row level security;
drop policy if exists "gov_applications: read own" on public.gov_applications;
create policy "gov_applications: read own" on public.gov_applications for select to authenticated using (user_id = auth.uid());
grant select on public.gov_applications to authenticated;

create table if not exists public.gov_employees (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  position_id   text not null references public.gov_positions(id),
  employee_no   text not null unique,
  hired_at      timestamptz not null default now(),
  shifts_worked int not null default 0,
  last_shift_at timestamptz,
  active        boolean not null default true,
  ended_at      timestamptz
);
create unique index if not exists gov_employees_one_active on public.gov_employees (user_id) where active;
alter table public.gov_employees enable row level security;
drop policy if exists "gov_employees: read own" on public.gov_employees;
create policy "gov_employees: read own" on public.gov_employees for select to authenticated using (user_id = auth.uid());
grant select on public.gov_employees to authenticated;

create table if not exists public.gov_audit_log (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  actor_id    uuid,
  action      text not null,
  target_type text not null,
  target_id   text,
  details     jsonb not null default '{}'::jsonb
);
create index if not exists gov_audit_log_target_idx on public.gov_audit_log (target_type, target_id, at desc);
alter table public.gov_audit_log enable row level security;
drop policy if exists "gov_audit: officials read" on public.gov_audit_log;
create policy "gov_audit: officials read" on public.gov_audit_log for select to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('official','moderator','admin')));
grant select on public.gov_audit_log to authenticated;

create table if not exists public.gov_interview_questions (
  id       serial primary key,
  question text not null,
  options  text[] not null,
  answer   int not null   -- 0-based index into options; never exposed to clients
);
insert into public.gov_interview_questions (question, options, answer)
select q.question, q.options, q.answer from (values
  ('A citizen at your desk is angry about a long queue. What do you do?', array['Shout back so they respect the office', 'Listen, explain the process and give them a queue number', 'Ignore them until they leave'], 1),
  ('What is the official currency of GistCity?', array['Naira', 'G', 'Cowries'], 1),
  ('Where does a government salary come from?', array['The Government Payroll account', 'The Treasury prints new money every day', 'Your supervisor''s personal wallet'], 0),
  ('A friend asks you to approve their application out of turn. You…', array['Approve it — friends first', 'Explain that applications are processed in queue order', 'Ask for a small gift first'], 1),
  ('Which document proves a citizen completed a Unity College course?', array['A screenshot of the classroom', 'A certificate serial that the Registry can verify', 'A letter from a friend'], 1),
  ('Office hours are over and a form is half-filled. You…', array['Save it and continue in the next shift', 'Throw it away', 'Sign it unread to finish quickly'], 0)
) as q(question, options, answer)
where not exists (select 1 from public.gov_interview_questions);
alter table public.gov_interview_questions enable row level security; -- no policies: clients never read the table

create or replace function public.gov_log(p_actor uuid, p_action text, p_type text, p_id text, p_details jsonb)
returns void language sql security definer set search_path = public as $$
  insert into public.gov_audit_log (actor_id, action, target_type, target_id, details) values (p_actor, p_action, p_type, p_id, coalesce(p_details, '{}'::jsonb));
$$;
revoke all on function public.gov_log(uuid, text, text, text, jsonb) from public, anon, authenticated;

create or replace function public.gov_cfg(p_key text) returns int language sql stable security definer set search_path = public as $$
  select (value)::int from public.gov_config where key = p_key;
$$;
revoke all on function public.gov_cfg(text) from public, anon, authenticated;

create or replace function public.gov_advance(p_app uuid, p_step int, p_note text, p_actor uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update gov_applications set step = p_step, next_step_at = now() + make_interval(secs => gov_cfg('step_interval_s')), updated_at = now(),
    history = history || jsonb_build_object('step', p_step, 'at', now(), 'note', p_note)
  where id = p_app;
  perform gov_log(p_actor, 'application_step', 'application', p_app::text, jsonb_build_object('step', p_step, 'note', p_note));
end $$;
revoke all on function public.gov_advance(uuid, int, text, uuid) from public, anon, authenticated;

create or replace function public.gov_reject(p_app uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
begin
  update gov_applications set status = 'rejected', reason = p_reason, updated_at = now(), history = history || jsonb_build_object('step', step, 'at', now(), 'note', 'Rejected: ' || p_reason) where id = p_app;
  perform gov_log(null, 'application_rejected', 'application', p_app::text, jsonb_build_object('reason', p_reason));
end $$;
revoke all on function public.gov_reject(uuid, text) from public, anon, authenticated;

-- The office clerk: processes every due application one step, in queue order.
-- Called by the player-facing functions, so the queue moves whenever anyone visits.
create or replace function public.gov_process()
returns int language plpgsql security definer set search_path = public as $$
declare a record; p record; v_free int; v_head uuid; n int := 0;
begin
  for a in select * from gov_applications where status = 'in_progress' and step between 1 and 6 and next_step_at <= now() order by submitted_at for update skip locked loop
    select * into p from gov_positions where id = a.position_id;
    if a.step = 1 then
      if p.required_course is null or has_certificate(a.user_id, p.required_course) then perform gov_advance(a.id, 2, 'Certificate verified against Unity College records', null);
      else perform gov_reject(a.id, 'Required certificate not found: ' || p.required_course); end if;
    elsif a.step = 2 then
      if exists (select 1 from gov_employees where user_id = a.user_id and active) then perform gov_reject(a.id, 'Applicant already holds a government post');
      elsif not exists (select 1 from profiles where id = a.user_id and status = 'active') then perform gov_reject(a.id, 'Account not in good standing');
      else perform gov_advance(a.id, 3, 'Eligibility confirmed', null); end if;
    elsif a.step = 3 then
      update gov_applications set queue_no = nextval('gov_queue_seq') where id = a.id;
      perform gov_advance(a.id, 4, 'Queue number ' || (select queue_no from gov_applications where id = a.id), null);
    elsif a.step = 4 then
      v_free := p.slots - (select count(*) from gov_employees where position_id = p.id and active) - (select count(*) from gov_applications where position_id = p.id and status = 'in_progress' and step between 5 and 9);
      select id into v_head from gov_applications where position_id = p.id and status = 'in_progress' and step = 4 order by queue_no limit 1;
      if v_free > 0 and v_head = a.id then perform gov_advance(a.id, 5, 'Shortlisted: slot available', null);
      else update gov_applications set next_step_at = now() + make_interval(secs => gov_cfg('step_interval_s')) where id = a.id; end if;
    elsif a.step = 5 then
      perform gov_advance(a.id, 6, 'Interview scheduled at the employment desk', null);
    elsif a.step = 6 then
      null; -- waiting for the applicant to attend the interview
    end if;
    n := n + 1;
  end loop;
  return n;
end $$;
grant execute on function public.gov_process() to authenticated;

create or replace function public.gov_my_status()
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := gc_require_active(); v jsonb;
begin
  perform gov_process();
  select jsonb_build_object(
    'positions', (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'dept', d.name, 'title', p.title, 'grade', p.grade, 'salary_per_shift', p.salary_per_shift, 'required_course', p.required_course,
        'required_title', (select certificate_title from courses where id = p.required_course), 'has_certificate', p.required_course is null or has_certificate(v_uid, p.required_course),
        'slots', p.slots, 'filled', (select count(*) from gov_employees e where e.position_id = p.id and active), 'queue', (select count(*) from gov_applications q where q.position_id = p.id and q.status = 'in_progress'),
        'description', p.description) order by p.sort), '[]'::jsonb)
      from gov_positions p join gov_departments d on d.code = p.dept where p.active),
    'steps', (select jsonb_agg(to_jsonb(s) order by s.step) from gov_steps s),
    'application', (select to_jsonb(a) || jsonb_build_object('title', p.title, 'queue_ahead', (select count(*) from gov_applications q where q.position_id = a.position_id and q.status = 'in_progress' and q.step = 4 and q.queue_no < a.queue_no),
        'wait_s', greatest(0, ceil(extract(epoch from (a.next_step_at - now())))::int))
      from gov_applications a join gov_positions p on p.id = a.position_id where a.user_id = v_uid order by (a.status = 'in_progress') desc, a.updated_at desc limit 1),
    'employment', (select to_jsonb(e) || jsonb_build_object('title', p.title, 'dept', d.name, 'salary_per_shift', p.salary_per_shift,
        'next_shift_in', case when e.last_shift_at is null then 0 else greatest(0, ceil(extract(epoch from (e.last_shift_at + make_interval(secs => gov_cfg('shift_cooldown_s')) - now())))::int) end)
      from gov_employees e join gov_positions p on p.id = e.position_id join gov_departments d on d.code = p.dept where e.user_id = v_uid and e.active),
    'payroll_balance', (select balance from accounts where code = 'payroll'),
    'config', (select jsonb_object_agg(key, value) from gov_config)
  ) into v;
  return v;
end $$;
grant execute on function public.gov_my_status() to authenticated;

create or replace function public.gov_apply(p_position text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := gc_require_active(); p record; a record;
begin
  select * into p from gov_positions where id = p_position and active;
  if not found then raise exception 'GC_UNKNOWN_POSITION'; end if;
  if exists (select 1 from gov_employees where user_id = v_uid and active) then return jsonb_build_object('ok', false, 'error', 'GC_ALREADY_EMPLOYED'); end if;
  select * into a from gov_applications where user_id = v_uid and status = 'in_progress';
  if found then return jsonb_build_object('ok', false, 'error', 'GC_APPLICATION_OPEN', 'application_id', a.id); end if;
  if p.required_course is not null and not has_certificate(v_uid, p.required_course) then return jsonb_build_object('ok', false, 'error', 'GC_CERTIFICATE_REQUIRED', 'course', p.required_course); end if;
  insert into gov_applications (user_id, position_id, history) values (v_uid, p.id, jsonb_build_array(jsonb_build_object('step', 1, 'at', now(), 'note', 'Submitted at the employment desk'))) returning * into a;
  perform gov_log(v_uid, 'application_submitted', 'application', a.id::text, jsonb_build_object('position', p.id));
  perform gov_process();
  return jsonb_build_object('ok', true, 'application_id', a.id);
end $$;
grant execute on function public.gov_apply(text) to authenticated;

create or replace function public.gov_withdraw()
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := gc_require_active(); a record;
begin
  update gov_applications set status = 'withdrawn', updated_at = now(), history = history || jsonb_build_object('step', step, 'at', now(), 'note', 'Withdrawn by applicant') where user_id = v_uid and status = 'in_progress' returning * into a;
  if not found then return jsonb_build_object('ok', false, 'error', 'GC_NO_APPLICATION'); end if;
  perform gov_log(v_uid, 'application_withdrawn', 'application', a.id::text, '{}'::jsonb);
  return jsonb_build_object('ok', true);
end $$;
grant execute on function public.gov_withdraw() to authenticated;

-- Three questions, answers withheld.
create or replace function public.gov_interview_questions()
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := gc_require_active(); a record;
begin
  perform gov_process();
  select * into a from gov_applications where user_id = v_uid and status = 'in_progress' and step = 6;
  if not found then return jsonb_build_object('ok', false, 'error', 'GC_NO_INTERVIEW'); end if;
  return jsonb_build_object('ok', true, 'application_id', a.id, 'questions', (select jsonb_agg(jsonb_build_object('id', id, 'question', question, 'options', options)) from (select * from gov_interview_questions order by random() limit 3) q));
end $$;
grant execute on function public.gov_interview_questions() to authenticated;

create or replace function public.gov_attend_interview(p_answers jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := gc_require_active(); a record; q record; v_score int := 0; v_total int := 0; k text;
begin
  perform gov_process();
  select * into a from gov_applications where user_id = v_uid and status = 'in_progress' and step = 6 for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'GC_NO_INTERVIEW'); end if;
  if p_answers is null or jsonb_typeof(p_answers) <> 'object' then raise exception 'GC_INVALID_ANSWERS'; end if;
  for k in select jsonb_object_keys(p_answers) loop
    select * into q from gov_interview_questions where id = k::int;
    if found then v_total := v_total + 1; if (p_answers->>k)::int = q.answer then v_score := v_score + 1; end if; end if;
    exit when v_total >= 3;
  end loop;
  if v_score >= gov_cfg('interview_pass') then
    update gov_applications set interview_score = v_score, interview_attempts = interview_attempts + 1 where id = a.id;
    perform gov_advance(a.id, 7, 'Interview passed (' || v_score || '/3)', v_uid);
    perform gov_advance(a.id, 8, 'Offer issued', null);
    return jsonb_build_object('ok', true, 'passed', true, 'score', v_score, 'step', 8);
  end if;
  update gov_applications set interview_score = v_score, interview_attempts = interview_attempts + 1 where id = a.id;
  if a.interview_attempts + 1 >= gov_cfg('max_interview_attempts') then
    perform gov_reject(a.id, 'Interview not passed after ' || (a.interview_attempts + 1) || ' attempts');
    return jsonb_build_object('ok', true, 'passed', false, 'score', v_score, 'rejected', true);
  end if;
  -- back to the queue for another interview later
  update gov_applications set queue_no = nextval('gov_queue_seq') where id = a.id;
  perform gov_advance(a.id, 4, 'Interview not passed (' || v_score || '/3) — re-queued', v_uid);
  return jsonb_build_object('ok', true, 'passed', false, 'score', v_score, 'step', 4);
end $$;
grant execute on function public.gov_attend_interview(jsonb) to authenticated;

create or replace function public.gov_accept_offer(p_accept boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := gc_require_active(); a record; e record; v_no text;
begin
  select * into a from gov_applications where user_id = v_uid and status = 'in_progress' and step = 8 for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'GC_NO_OFFER'); end if;
  if not p_accept then
    update gov_applications set status = 'declined', updated_at = now(), history = history || jsonb_build_object('step', 8, 'at', now(), 'note', 'Offer declined') where id = a.id;
    perform gov_log(v_uid, 'offer_declined', 'application', a.id::text, '{}'::jsonb);
    return jsonb_build_object('ok', true, 'declined', true);
  end if;
  if exists (select 1 from gov_employees where user_id = v_uid and active) then return jsonb_build_object('ok', false, 'error', 'GC_ALREADY_EMPLOYED'); end if;
  perform gov_advance(a.id, 9, 'Offer accepted', v_uid);
  loop
    v_no := 'GOV-' || lpad(floor(random() * 1000000)::text, 6, '0');
    exit when not exists (select 1 from gov_employees where employee_no = v_no);
  end loop;
  insert into gov_employees (user_id, position_id, employee_no) values (v_uid, a.position_id, v_no) returning * into e;
  update gov_applications set step = 10, status = 'hired', updated_at = now(), history = history || jsonb_build_object('step', 10, 'at', now(), 'note', 'Onboarded as ' || v_no) where id = a.id;
  perform gov_log(v_uid, 'employee_onboarded', 'employee', e.id::text, jsonb_build_object('position', a.position_id, 'employee_no', v_no));
  return jsonb_build_object('ok', true, 'employee_no', v_no, 'step', 10);
end $$;
grant execute on function public.gov_accept_offer(boolean) to authenticated;

-- A shift at the office: paid from Government Payroll, one per cooldown, logged.
create or replace function public.gov_work_shift(p_key uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := gc_require_active(); e record; p record; v_wallet uuid; v_payroll uuid; v_tx bigint; v_wait int;
begin
  if p_key is null then raise exception 'GC_KEY_REQUIRED'; end if;
  select id into v_wallet from accounts where owner_id = v_uid and kind = 'player';
  select id into v_tx from transactions where idempotency_key = p_key;
  if found then return jsonb_build_object('ok', true, 'replay', true, 'balance', (select balance from accounts where id = v_wallet)); end if;
  select * into e from gov_employees where user_id = v_uid and active for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'GC_NOT_EMPLOYED'); end if;
  select * into p from gov_positions where id = e.position_id;
  if e.last_shift_at is not null and e.last_shift_at > now() - make_interval(secs => gov_cfg('shift_cooldown_s')) then
    v_wait := ceil(extract(epoch from (e.last_shift_at + make_interval(secs => gov_cfg('shift_cooldown_s')) - now())))::int;
    return jsonb_build_object('ok', false, 'error', 'GC_COOLDOWN', 'retry_in', v_wait);
  end if;
  select id into v_payroll from accounts where code = 'payroll';
  begin
    v_tx := post_transaction(v_payroll, v_wallet, p.salary_per_shift, 'salary', jsonb_build_object('position', p.id, 'employee_no', e.employee_no, 'shift', e.shifts_worked + 1), p_key, v_uid);
  exception when others then
    if sqlerrm = 'GC_INSUFFICIENT_FUNDS' then return jsonb_build_object('ok', false, 'error', 'GC_PAYROLL_EMPTY'); end if;
    raise;
  end;
  update gov_employees set shifts_worked = shifts_worked + 1, last_shift_at = now() where id = e.id;
  perform gov_log(v_uid, 'salary_paid', 'employee', e.id::text, jsonb_build_object('amount', p.salary_per_shift, 'tx', v_tx, 'shift', e.shifts_worked + 1));
  return jsonb_build_object('ok', true, 'paid', p.salary_per_shift, 'tx', v_tx, 'shift', e.shifts_worked + 1, 'balance', (select balance from accounts where id = v_wallet));
end $$;
grant execute on function public.gov_work_shift(uuid) to authenticated;

create or replace function public.gov_resign()
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := gc_require_active(); e record;
begin
  update gov_employees set active = false, ended_at = now() where user_id = v_uid and active returning * into e;
  if not found then return jsonb_build_object('ok', false, 'error', 'GC_NOT_EMPLOYED'); end if;
  perform gov_log(v_uid, 'employee_resigned', 'employee', e.id::text, '{}'::jsonb);
  return jsonb_build_object('ok', true);
end $$;
grant execute on function public.gov_resign() to authenticated;

-- ================================================================== churches
create table if not exists public.churches (
  id           uuid primary key default gen_random_uuid(),
  slug         text not null unique,
  name         text not null check (char_length(name) between 3 and 60),
  description  text not null default '' check (char_length(description) <= 400),
  pastor_id    uuid references auth.users(id) on delete set null,
  pastor_name  text,                         -- for NPC-led congregations
  account_id   uuid not null references public.accounts(id),
  seats        int not null default 40 check (seats between 10 and 500),
  venue        text not null default 'grace-chapel',
  created_by   uuid,
  created_at   timestamptz not null default now()
);
create table if not exists public.church_members (
  church_id uuid not null references public.churches(id) on delete cascade,
  user_id   uuid not null references auth.users(id) on delete cascade,
  role      text not null default 'member' check (role in ('member','staff','pastor')),
  joined_at timestamptz not null default now(),
  primary key (church_id, user_id)
);
create unique index if not exists church_members_one_church on public.church_members (user_id);
create table if not exists public.church_services (
  id           bigint generated always as identity primary key,
  church_id    uuid not null references public.churches(id) on delete cascade,
  title        text not null,
  every_min    int not null check (every_min between 10 and 10080),   -- period
  offset_min   int not null default 0,                                 -- minutes after the epoch-aligned period start
  duration_min int not null check (duration_min between 5 and 240),
  description  text not null default ''
);
create table if not exists public.church_attendance (
  id          bigint generated always as identity primary key,
  service_id  bigint not null references public.church_services(id) on delete cascade,
  occurrence  bigint not null,
  user_id     uuid not null references auth.users(id) on delete cascade,
  seat_no     int not null,
  attended_at timestamptz not null default now(),
  unique (service_id, occurrence, user_id)
);
create table if not exists public.church_expenses (
  id         bigint generated always as identity primary key,
  church_id  uuid not null references public.churches(id) on delete cascade,
  tx         bigint references public.transactions(id),
  amount     bigint not null,
  to_user    uuid,
  reason     text not null,
  authorised_by uuid not null,
  at         timestamptz not null default now()
);
create table if not exists public.church_salary_agreements (
  church_id   uuid primary key references public.churches(id) on delete cascade,
  pastor_id   uuid not null,
  amount      bigint not null check (amount > 0),
  period_s    int not null default 604800,
  proposed_at timestamptz not null default now(),
  approved_by uuid,
  approved_at timestamptz,
  last_paid_at timestamptz
);
alter table public.churches enable row level security;
alter table public.church_members enable row level security;
alter table public.church_services enable row level security;
alter table public.church_attendance enable row level security;
alter table public.church_expenses enable row level security;
alter table public.church_salary_agreements enable row level security;
drop policy if exists "churches: public read" on public.churches;
create policy "churches: public read" on public.churches for select to authenticated using (true);
drop policy if exists "church_members: public read" on public.church_members;
create policy "church_members: public read" on public.church_members for select to authenticated using (true);
drop policy if exists "church_services: public read" on public.church_services;
create policy "church_services: public read" on public.church_services for select to authenticated using (true);
drop policy if exists "church_attendance: read own" on public.church_attendance;
create policy "church_attendance: read own" on public.church_attendance for select to authenticated using (user_id = auth.uid());
drop policy if exists "church_expenses: members read" on public.church_expenses;
create policy "church_expenses: members read" on public.church_expenses for select to authenticated using (exists (select 1 from public.church_members m where m.church_id = church_id and m.user_id = auth.uid()));
drop policy if exists "church_salary: members read" on public.church_salary_agreements;
create policy "church_salary: members read" on public.church_salary_agreements for select to authenticated using (exists (select 1 from public.church_members m where m.church_id = church_id and m.user_id = auth.uid()));
grant select on public.churches, public.church_members, public.church_services, public.church_attendance, public.church_expenses, public.church_salary_agreements to authenticated;

-- Seed: Grace Chapel, led by an NPC pastor until a player congregation grows.
do $$
declare v_acc uuid; v_church uuid;
begin
  if not exists (select 1 from public.churches where slug = 'grace-chapel') then
    insert into public.accounts (kind, code, name) values ('church', 'church:grace-chapel', 'Grace Chapel GistCity') on conflict (code) do nothing;
    select id into v_acc from public.accounts where code = 'church:grace-chapel';
    insert into public.churches (slug, name, description, pastor_name, account_id, seats)
    values ('grace-chapel', 'Grace Chapel GistCity', 'A home for every GistCitizen. Hourly prayer services, Sunday celebration and a community kitchen fund.', 'Pastor Emmanuel Okafor', v_acc, 48)
    returning id into v_church;
    insert into public.church_services (church_id, title, every_min, offset_min, duration_min, description) values
      (v_church, 'Hourly Prayer Service', 60, 0, 15, 'Fifteen minutes of prayer and a short word, every hour on the hour.'),
      (v_church, 'Evening Service', 1440, 17 * 60, 45, 'Daily at 17:00 UTC (18:00 Lagos): worship, sermon and offering.'),
      (v_church, 'Sunday Celebration', 10080, 3 * 1440 + 8 * 60, 90, 'Sundays 08:00 UTC (09:00 Lagos): the big service. Dress well.');
  end if;
end $$;

-- Occurrence maths: the service is live when (minutes since epoch − offset) mod every < duration.
create or replace function public.service_state(p_every int, p_offset int, p_duration int, out live boolean, out occurrence bigint, out starts_in_s int, out ends_in_s int)
language plpgsql immutable as $$
declare m numeric := extract(epoch from now()) / 60.0; rel numeric; pos numeric;
begin
  rel := m - p_offset;
  occurrence := floor(rel / p_every);
  pos := rel - occurrence * p_every;
  live := pos < p_duration;
  starts_in_s := case when live then 0 else ceil((p_every - pos) * 60)::int end;
  ends_in_s := case when live then ceil((p_duration - pos) * 60)::int else 0 end;
end $$;

create or replace function public.church_info(p_slug text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); c record; v jsonb; v_occupied int;
begin
  select * into c from churches where slug = p_slug;
  if not found then raise exception 'GC_UNKNOWN_CHURCH'; end if;
  select count(distinct a.user_id) into v_occupied from church_attendance a join church_services s on s.id = a.service_id, lateral service_state(s.every_min, s.offset_min, s.duration_min) st
    where s.church_id = c.id and st.live and a.occurrence = st.occurrence;
  select jsonb_build_object(
    'id', c.id, 'slug', c.slug, 'name', c.name, 'description', c.description, 'seats', c.seats, 'occupied', v_occupied, 'available', c.seats - v_occupied,
    'pastor', coalesce((select display_name from profiles where id = c.pastor_id), c.pastor_name, 'Vacant'),
    'pastor_is_me', c.pastor_id = v_uid,
    'members', (select count(*) from church_members where church_id = c.id),
    'attending_now', v_occupied,
    'balance', (select balance from accounts where id = c.account_id),
    'my_role', (select role from church_members where church_id = c.id and user_id = v_uid),
    'services', (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'title', s.title, 'description', s.description, 'duration_min', s.duration_min, 'live', st.live, 'starts_in_s', st.starts_in_s, 'ends_in_s', st.ends_in_s,
        'attending', (select count(*) from church_attendance a where a.service_id = s.id and a.occurrence = st.occurrence),
        'my_seat', (select seat_no from church_attendance a where a.service_id = s.id and a.occurrence = st.occurrence and a.user_id = v_uid)) order by st.live desc, st.starts_in_s), '[]'::jsonb)
      from church_services s, lateral service_state(s.every_min, s.offset_min, s.duration_min) st where s.church_id = c.id),
    'recent_offerings', (select coalesce(jsonb_agg(jsonb_build_object('amount', t.amount, 'at', t.created_at, 'from', coalesce(p.display_name, 'Anonymous')) order by t.created_at desc), '[]'::jsonb)
      from (select * from transactions where to_account = c.account_id and reason in ('offering','donation') order by created_at desc limit 8) t left join profiles p on p.id = t.actor_id),
    'expenses', (select coalesce(jsonb_agg(jsonb_build_object('amount', e.amount, 'reason', e.reason, 'at', e.at) order by e.at desc), '[]'::jsonb) from (select * from church_expenses where church_id = c.id order by at desc limit 8) e),
    'salary', (select to_jsonb(s) from church_salary_agreements s where s.church_id = c.id),
    'other_churches', (select coalesce(jsonb_agg(jsonb_build_object('slug', o.slug, 'name', o.name, 'pastor', coalesce((select display_name from profiles where id = o.pastor_id), o.pastor_name), 'members', (select count(*) from church_members where church_id = o.id)) order by o.created_at), '[]'::jsonb) from churches o where o.id <> c.id)
  ) into v;
  return v;
end $$;
grant execute on function public.church_info(text) to authenticated;

create or replace function public.church_join(p_slug text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := gc_require_active(); c record;
begin
  select * into c from churches where slug = p_slug;
  if not found then raise exception 'GC_UNKNOWN_CHURCH'; end if;
  if exists (select 1 from church_members where user_id = v_uid and role = 'pastor') then return jsonb_build_object('ok', false, 'error', 'GC_PASTOR_CANNOT_LEAVE'); end if;
  delete from church_members where user_id = v_uid;   -- one congregation at a time
  insert into church_members (church_id, user_id) values (c.id, v_uid) on conflict do nothing;
  return jsonb_build_object('ok', true, 'members', (select count(*) from church_members where church_id = c.id));
end $$;
grant execute on function public.church_join(text) to authenticated;

create or replace function public.church_leave(p_slug text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := gc_require_active(); c record;
begin
  select * into c from churches where slug = p_slug;
  if not found then raise exception 'GC_UNKNOWN_CHURCH'; end if;
  if c.pastor_id = v_uid then return jsonb_build_object('ok', false, 'error', 'GC_PASTOR_CANNOT_LEAVE'); end if;
  delete from church_members where church_id = c.id and user_id = v_uid;
  return jsonb_build_object('ok', true);
end $$;
grant execute on function public.church_leave(text) to authenticated;

-- Reserve a seat in a live service. Seats are counted per occurrence; full is full.
create or replace function public.church_attend(p_service bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := gc_require_active(); s record; c record; st record; v_seat int; v_taken int;
begin
  select * into s from church_services where id = p_service;
  if not found then raise exception 'GC_UNKNOWN_SERVICE'; end if;
  select * into c from churches where id = s.church_id for update;
  select * into st from service_state(s.every_min, s.offset_min, s.duration_min);
  if not st.live then return jsonb_build_object('ok', false, 'error', 'GC_SERVICE_NOT_LIVE', 'starts_in_s', st.starts_in_s); end if;
  select seat_no into v_seat from church_attendance where service_id = s.id and occurrence = st.occurrence and user_id = v_uid;
  if found then return jsonb_build_object('ok', true, 'replay', true, 'seat_no', v_seat); end if;
  select count(*) into v_taken from church_attendance where service_id = s.id and occurrence = st.occurrence;
  if v_taken >= c.seats then return jsonb_build_object('ok', false, 'error', 'GC_NO_SEATS'); end if;
  insert into church_attendance (service_id, occurrence, user_id, seat_no) values (s.id, st.occurrence, v_uid, v_taken + 1) returning seat_no into v_seat;
  return jsonb_build_object('ok', true, 'seat_no', v_seat, 'ends_in_s', st.ends_in_s, 'seats_left', c.seats - v_taken - 1);
end $$;
grant execute on function public.church_attend(bigint) to authenticated;

-- Voluntary offering into the church account (never automatic, never required).
create or replace function public.church_offer(p_slug text, p_amount bigint, p_key uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := gc_require_active(); c record; v_wallet uuid; v_tx bigint;
begin
  if p_key is null then raise exception 'GC_KEY_REQUIRED'; end if;
  select * into c from churches where slug = p_slug;
  if not found then raise exception 'GC_UNKNOWN_CHURCH'; end if;
  select id into v_wallet from accounts where owner_id = v_uid and kind = 'player';
  begin
    v_tx := post_transaction(v_wallet, c.account_id, p_amount, 'offering', jsonb_build_object('church', c.slug), p_key, v_uid);
  exception when others then
    if sqlerrm in ('GC_INSUFFICIENT_FUNDS', 'GC_INVALID_AMOUNT') then return jsonb_build_object('ok', false, 'error', sqlerrm, 'balance', (select balance from accounts where id = v_wallet)); end if;
    raise;
  end;
  return jsonb_build_object('ok', true, 'tx', v_tx, 'balance', (select balance from accounts where id = v_wallet), 'church_balance', (select balance from accounts where id = c.account_id));
end $$;
grant execute on function public.church_offer(text, bigint, uuid) to authenticated;

-- Register a congregation (fee to the Community fund). The founder becomes its pastor.
create or replace function public.church_register(p_name text, p_description text, p_key uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := gc_require_active(); v_slug text; v_acc uuid; v_wallet uuid; v_comm uuid; v_fee bigint := 50000; c record; v_tx bigint;
begin
  if p_key is null then raise exception 'GC_KEY_REQUIRED'; end if;
  select * into c from churches where created_by = v_uid and exists (select 1 from transactions where idempotency_key = p_key);
  if found then return jsonb_build_object('ok', true, 'replay', true, 'slug', c.slug); end if;
  if exists (select 1 from churches where pastor_id = v_uid) then return jsonb_build_object('ok', false, 'error', 'GC_ALREADY_PASTOR'); end if;
  v_slug := regexp_replace(lower(trim(p_name)), '[^a-z0-9]+', '-', 'g');
  v_slug := trim(both '-' from v_slug);
  if char_length(v_slug) < 3 then return jsonb_build_object('ok', false, 'error', 'GC_INVALID_NAME'); end if;
  if exists (select 1 from churches where slug = v_slug) then return jsonb_build_object('ok', false, 'error', 'GC_NAME_TAKEN'); end if;
  select id into v_wallet from accounts where owner_id = v_uid and kind = 'player';
  select id into v_comm from accounts where code = 'community';
  begin
    v_tx := post_transaction(v_wallet, v_comm, v_fee, 'church_registration', jsonb_build_object('slug', v_slug), p_key, v_uid);
  exception when others then
    if sqlerrm = 'GC_INSUFFICIENT_FUNDS' then return jsonb_build_object('ok', false, 'error', 'GC_INSUFFICIENT_FUNDS', 'fee', v_fee, 'balance', (select balance from accounts where id = v_wallet)); end if;
    raise;
  end;
  insert into accounts (kind, code, name, owner_id) values ('church', 'church:' || v_slug, trim(p_name), v_uid) returning id into v_acc;
  insert into churches (slug, name, description, pastor_id, account_id, created_by) values (v_slug, trim(p_name), coalesce(left(p_description, 400), ''), v_uid, v_acc, v_uid) returning * into c;
  insert into church_services (church_id, title, every_min, offset_min, duration_min, description) values (c.id, 'Fellowship Service', 60, 30, 15, 'Every hour at half past, in the Grace Chapel hall.');
  delete from church_members where user_id = v_uid;
  insert into church_members (church_id, user_id, role) values (c.id, v_uid, 'pastor');
  return jsonb_build_object('ok', true, 'slug', c.slug, 'tx', v_tx, 'balance', (select balance from accounts where id = v_wallet));
end $$;
grant execute on function public.church_register(text, text, uuid) to authenticated;

-- Authorised expense: only the pastor, only from the church account, to a named citizen, always logged.
create or replace function public.church_pay(p_slug text, p_to_username text, p_amount bigint, p_reason text, p_key uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := gc_require_active(); c record; v_to uuid; v_to_wallet uuid; v_tx bigint;
begin
  if p_key is null then raise exception 'GC_KEY_REQUIRED'; end if;
  select * into c from churches where slug = p_slug;
  if not found then raise exception 'GC_UNKNOWN_CHURCH'; end if;
  if c.pastor_id is distinct from v_uid then raise exception 'GC_NOT_AUTHORISED'; end if;
  if coalesce(trim(p_reason), '') = '' then return jsonb_build_object('ok', false, 'error', 'GC_REASON_REQUIRED'); end if;
  select id into v_to from profiles where username = lower(p_to_username) and status = 'active';
  if v_to is null then return jsonb_build_object('ok', false, 'error', 'GC_UNKNOWN_USER'); end if;
  select id into v_to_wallet from accounts where owner_id = v_to and kind = 'player';
  begin
    v_tx := post_transaction(c.account_id, v_to_wallet, p_amount, 'church_expense', jsonb_build_object('church', c.slug, 'reason', left(p_reason, 120)), p_key, v_uid);
  exception when others then
    if sqlerrm in ('GC_INSUFFICIENT_FUNDS', 'GC_INVALID_AMOUNT') then return jsonb_build_object('ok', false, 'error', sqlerrm, 'church_balance', (select balance from accounts where id = c.account_id)); end if;
    raise;
  end;
  insert into church_expenses (church_id, tx, amount, to_user, reason, authorised_by) values (c.id, v_tx, p_amount, v_to, left(p_reason, 120), v_uid) on conflict do nothing;
  return jsonb_build_object('ok', true, 'tx', v_tx, 'church_balance', (select balance from accounts where id = c.account_id));
end $$;
grant execute on function public.church_pay(text, text, bigint, text, uuid) to authenticated;

-- Pastor salary: proposed by the pastor, approved by a different member, then claimable once per period from the church account.
create or replace function public.church_salary(p_slug text, p_action text, p_amount bigint, p_key uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := gc_require_active(); c record; s record; v_wallet uuid; v_tx bigint;
begin
  select * into c from churches where slug = p_slug;
  if not found then raise exception 'GC_UNKNOWN_CHURCH'; end if;
  select * into s from church_salary_agreements where church_id = c.id;
  if p_action = 'propose' then
    if c.pastor_id is distinct from v_uid then raise exception 'GC_NOT_AUTHORISED'; end if;
    if p_amount is null or p_amount <= 0 then return jsonb_build_object('ok', false, 'error', 'GC_INVALID_AMOUNT'); end if;
    insert into church_salary_agreements (church_id, pastor_id, amount) values (c.id, v_uid, p_amount)
    on conflict (church_id) do update set pastor_id = v_uid, amount = p_amount, proposed_at = now(), approved_by = null, approved_at = null;
    return jsonb_build_object('ok', true, 'status', 'proposed');
  elsif p_action = 'approve' then
    if s is null then return jsonb_build_object('ok', false, 'error', 'GC_NO_PROPOSAL'); end if;
    if v_uid = s.pastor_id or not exists (select 1 from church_members where church_id = c.id and user_id = v_uid) then raise exception 'GC_NOT_AUTHORISED'; end if;
    update church_salary_agreements set approved_by = v_uid, approved_at = now() where church_id = c.id;
    return jsonb_build_object('ok', true, 'status', 'approved');
  elsif p_action = 'claim' then
    if p_key is null then raise exception 'GC_KEY_REQUIRED'; end if;
    if s is null or s.approved_at is null then return jsonb_build_object('ok', false, 'error', 'GC_NOT_APPROVED'); end if;
    if s.pastor_id <> v_uid then raise exception 'GC_NOT_AUTHORISED'; end if;
    if s.last_paid_at is not null and s.last_paid_at > now() - make_interval(secs => s.period_s) then return jsonb_build_object('ok', false, 'error', 'GC_COOLDOWN', 'retry_in', ceil(extract(epoch from (s.last_paid_at + make_interval(secs => s.period_s) - now())))::int); end if;
    select id into v_wallet from accounts where owner_id = v_uid and kind = 'player';
    begin
      v_tx := post_transaction(c.account_id, v_wallet, s.amount, 'pastor_salary', jsonb_build_object('church', c.slug), p_key, v_uid);
    exception when others then
      if sqlerrm = 'GC_INSUFFICIENT_FUNDS' then return jsonb_build_object('ok', false, 'error', 'GC_CHURCH_FUNDS_LOW', 'church_balance', (select balance from accounts where id = c.account_id)); end if;
      raise;
    end;
    update church_salary_agreements set last_paid_at = now() where church_id = c.id;
    insert into church_expenses (church_id, tx, amount, to_user, reason, authorised_by) values (c.id, v_tx, s.amount, v_uid, 'Pastor salary (agreement approved by member)', s.approved_by);
    return jsonb_build_object('ok', true, 'tx', v_tx, 'balance', (select balance from accounts where id = v_wallet));
  end if;
  raise exception 'GC_INVALID_ACTION';
end $$;
grant execute on function public.church_salary(text, text, bigint, uuid) to authenticated;

-- ============================================================ city overview
-- Registered citizens vs online is answered by presence (realtime); this gives the registered side + civic counters.
create or replace function public.city_stats()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'registered', (select count(*) from public.profiles where status = 'active'),
    'characters_ready', (select count(*) from public.profiles where character_ready),
    'certificates', (select count(*) from public.certificates where revoked_at is null),
    'vehicles', (select count(*) from public.vehicles),
    'gov_employees', (select count(*) from public.gov_employees where active),
    'church_members', (select count(*) from public.church_members),
    'payroll_balance', (select balance from public.accounts where code = 'payroll'));
$$;
grant execute on function public.city_stats() to authenticated;

-- me(): include civic snapshot so the client can boot in one round-trip.
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
    'currency', (select value from public.economy_config where key = 'currency'),
    'certificates', coalesce((select jsonb_agg(course_id) from public.certificates where user_id = auth.uid() and revoked_at is null), '[]'::jsonb),
    'employment', (select jsonb_build_object('position_id', e.position_id, 'title', p.title, 'employee_no', e.employee_no) from public.gov_employees e join public.gov_positions p on p.id = e.position_id where e.user_id = auth.uid() and e.active),
    'church', (select jsonb_build_object('slug', c.slug, 'name', c.name, 'role', m.role) from public.church_members m join public.churches c on c.id = m.church_id where m.user_id = auth.uid())
  ) into v;
  return v;
end $$;
grant execute on function public.me() to authenticated;
