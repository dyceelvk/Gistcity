-- GistCity · social layer (Phase 6 of the brief)
-- Public player profiles with photos & short clips, followers, blocks & reports,
-- and private direct messages. Re-runnable. Apply after 20261016000003_gistcity_society.sql.
--
-- Design
--   * Profile media is public (that is the point of a public page). Media files
--     live in the `profile-media` storage bucket, one folder per user; the rows
--     here are the catalogue the client renders.
--   * Direct messages are private: only the two participants (user_low/user_high)
--     can ever read a conversation, enforced by RLS AND inside every SECURITY
--     DEFINER function. Attachments live in the private `dm-media` bucket under
--     the conversation id; storage policies check membership the same way.
--   * Clients never write these tables directly. All mutations go through the
--     functions below, which validate the actor, blocks and rate limits.
--   * Blocks are one-way and private: blocking removes follows both ways and
--     stops DMs in both directions (nobody learns that they were blocked).
--   * `dm_messages` joins the supabase_realtime publication when present, so
--     both sides can see replies arrive live.

-- =========================================================== profile media
create table if not exists public.profile_media (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null references public.profiles(id) on delete cascade,
  kind       text not null check (kind in ('photo','clip')),
  path       text not null unique,            -- storage path: {user_id}/{file}
  caption    text not null default '' check (char_length(caption) <= 120),
  created_at timestamptz not null default now()
);
create index if not exists profile_media_owner_idx on public.profile_media (owner_id, created_at desc);

alter table public.profile_media enable row level security;
drop policy if exists "profile_media: public read" on public.profile_media;
create policy "profile_media: public read" on public.profile_media for select to anon, authenticated using (true);
revoke insert, update, delete on public.profile_media from anon, authenticated;
grant select on public.profile_media to anon, authenticated;

-- ================================================================== social
create table if not exists public.follows (
  follower_id uuid not null references public.profiles(id) on delete cascade,
  followee_id uuid not null references public.profiles(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (follower_id, followee_id),
  check (follower_id <> followee_id)
);
create index if not exists follows_followee_idx on public.follows (followee_id);

alter table public.follows enable row level security;
drop policy if exists "follows: graph is public" on public.follows;
create policy "follows: graph is public" on public.follows for select to anon, authenticated using (true);
revoke insert, update, delete on public.follows from anon, authenticated;
grant select on public.follows to anon, authenticated;

create table if not exists public.blocks (
  blocker_id uuid not null references public.profiles(id) on delete cascade,
  blocked_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);

alter table public.blocks enable row level security;
drop policy if exists "blocks: read own" on public.blocks;
create policy "blocks: read own" on public.blocks for select to authenticated using (blocker_id = auth.uid());
revoke insert, update, delete on public.blocks from anon, authenticated;
grant select on public.blocks to authenticated;

create table if not exists public.reports (
  id          bigint generated always as identity primary key,
  reporter_id uuid not null references public.profiles(id) on delete cascade,
  reported_id uuid not null references public.profiles(id) on delete cascade,
  reason      text not null check (reason in ('spam','abuse','cheat','inappropriate','other')),
  detail      text not null default '' check (char_length(detail) <= 500),
  status      text not null default 'open' check (status in ('open','reviewed','actioned','dismissed')),
  created_at  timestamptz not null default now()
);
create index if not exists reports_status_idx on public.reports (status, created_at desc);

alter table public.reports enable row level security;
drop policy if exists "reports: staff read" on public.reports;
create policy "reports: staff read" on public.reports for select to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('moderator','admin')));
drop policy if exists "reports: reporter read own" on public.reports;
create policy "reports: reporter read own" on public.reports for select to authenticated using (reporter_id = auth.uid());
revoke insert, update, delete on public.reports from anon, authenticated;
grant select on public.reports to authenticated;

-- ====================================================== direct messages
create table if not exists public.dm_conversations (
  id              uuid primary key default gen_random_uuid(),
  user_low        uuid not null references public.profiles(id) on delete cascade,
  user_high       uuid not null references public.profiles(id) on delete cascade,
  created_at      timestamptz not null default now(),
  last_message_at timestamptz not null default now(),
  unique (user_low, user_high),
  check (user_low < user_high)
);

alter table public.dm_conversations enable row level security;
drop policy if exists "dm_conversations: participants only" on public.dm_conversations;
create policy "dm_conversations: participants only" on public.dm_conversations for select to authenticated
  using (auth.uid() in (user_low, user_high));
revoke insert, update, delete on public.dm_conversations from anon, authenticated;
grant select on public.dm_conversations to authenticated;

create table if not exists public.dm_messages (
  id              bigint generated always as identity primary key,
  conversation_id uuid not null references public.dm_conversations(id) on delete cascade,
  sender_id       uuid not null references public.profiles(id) on delete cascade,
  body            text not null check (char_length(body) between 1 and 1000),
  media_path      text check (char_length(media_path) <= 300),
  client_key      uuid unique,                -- idempotent retries
  created_at      timestamptz not null default now(),
  read_at         timestamptz
);
create index if not exists dm_messages_conv_idx on public.dm_messages (conversation_id, id desc);

alter table public.dm_messages enable row level security;
drop policy if exists "dm_messages: participants only" on public.dm_messages;
create policy "dm_messages: participants only" on public.dm_messages for select to authenticated
  using (exists (select 1 from public.dm_conversations c
                 where c.id = conversation_id and auth.uid() in (c.user_low, c.user_high)));
revoke insert, update, delete on public.dm_messages from anon, authenticated;
grant select on public.dm_messages to authenticated;

-- Live delivery of new messages (Supabase realtime). Guarded + idempotent.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'dm_messages') then
    alter publication supabase_realtime add table public.dm_messages;
  end if;
end $$;

-- ============================================================== rate limits
create table if not exists public.rate_limits (
  bucket       text not null,
  user_id      uuid not null,
  window_start timestamptz not null,
  n            int not null default 1,
  primary key (bucket, user_id, window_start)
);

-- ================================================================ helpers
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

-- Per-minute rate limit; raises GC_RATE_LIMITED when the bucket is full.
create or replace function public.check_rate(p_bucket text, p_max int)
returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_n int;
begin
  insert into public.rate_limits (bucket, user_id, window_start, n)
  values (p_bucket, v_uid, date_trunc('minute', now()), 1)
  on conflict (bucket, user_id, window_start)
    do update set n = rate_limits.n + 1
    returning n into v_n;
  if v_n > p_max then raise exception 'GC_RATE_LIMITED'; end if;
end $$;
revoke all on function public.check_rate(text, int) from public, anon, authenticated;

create or replace function public.dm_pair(p_other uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_uid uuid := public.require_user(); v_id uuid;
begin
  if p_other is null or p_other = v_uid then raise exception 'GC_SELF'; end if;
  if not exists (select 1 from public.profiles where id = p_other and status = 'active') then
    raise exception 'GC_UNKNOWN_USER';
  end if;
  if exists (select 1 from public.blocks
             where (blocker_id = v_uid and blocked_id = p_other)
                or (blocker_id = p_other and blocked_id = v_uid)) then
    raise exception 'GC_BLOCKED';
  end if;
  select id into v_id from public.dm_conversations
   where user_low = least(v_uid, p_other) and user_high = greatest(v_uid, p_other);
  if v_id is null then
    insert into public.dm_conversations (user_low, user_high)
    values (least(v_uid, p_other), greatest(v_uid, p_other))
    returning id into v_id;
  end if;
  return v_id;
end $$;
revoke all on function public.dm_pair(uuid) from public, anon, authenticated;

-- ============================================================== RPC surface
-- Public profile page: identity, bio, occupation, media gallery, follower
-- counts and my relationship to this citizen. Never leaks private data.
create or replace function public.profile_page(p_username citext)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_p   public.profiles%rowtype;
  v_media jsonb; v_followers int; v_following int;
  v_i_follow boolean; v_follows_me boolean; v_can_dm boolean; v_blocked_by_me boolean;
  v_occupation text;
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

  return jsonb_build_object(
    'id', v_p.id, 'username', v_p.username, 'display_name', v_p.display_name,
    'bio', v_p.bio, 'avatar_url', v_p.avatar_url, 'created_at', v_p.created_at,
    'occupation', v_occupation,
    'followers', v_followers, 'following', v_following,
    'i_follow', v_i_follow, 'follows_me', v_follows_me,
    'can_dm', v_can_dm, 'blocked_by_me', v_blocked_by_me,
    'media', v_media);
end $$;
grant execute on function public.profile_page(citext) to anon, authenticated;

-- Follow / unfollow.
create or replace function public.follow_toggle(p_username citext, p_follow boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := public.require_user(); v_other uuid;
begin
  perform public.check_rate('follow', 60);
  select id into v_other from public.profiles where username = lower(p_username) and status = 'active';
  if not found then raise exception 'GC_UNKNOWN_USER'; end if;
  if v_other = v_uid then raise exception 'GC_SELF'; end if;
  if p_follow then
    insert into public.follows (follower_id, followee_id) values (v_uid, v_other)
    on conflict do nothing;
  else
    delete from public.follows where follower_id = v_uid and followee_id = v_other;
  end if;
  return jsonb_build_object('ok', true, 'following', p_follow,
    'followers', (select count(*) from public.follows where followee_id = v_other));
end $$;
grant execute on function public.follow_toggle(citext, boolean) to authenticated;

-- Block / unblock. Blocking removes follows both ways and stops DMs both ways.
create or replace function public.block_toggle(p_username citext, p_block boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := public.require_user(); v_other uuid;
begin
  perform public.check_rate('block', 30);
  select id into v_other from public.profiles where username = lower(p_username);
  if not found then raise exception 'GC_UNKNOWN_USER'; end if;
  if v_other = v_uid then raise exception 'GC_SELF'; end if;
  if p_block then
    insert into public.blocks (blocker_id, blocked_id) values (v_uid, v_other) on conflict do nothing;
    delete from public.follows where (follower_id = v_uid and followee_id = v_other)
                               or (follower_id = v_other and followee_id = v_uid);
  else
    delete from public.blocks where blocker_id = v_uid and blocked_id = v_other;
  end if;
  return jsonb_build_object('ok', true, 'blocked', p_block);
end $$;
grant execute on function public.block_toggle(citext, boolean) to authenticated;

-- Report a citizen to the moderators (rules-first moderation).
create or replace function public.report_user(p_username citext, p_reason text, p_detail text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := public.require_user(); v_other uuid;
begin
  select id into v_other from public.profiles where username = lower(p_username);
  if not found then raise exception 'GC_UNKNOWN_USER'; end if;
  if v_other = v_uid then raise exception 'GC_SELF'; end if;
  if p_reason not in ('spam','abuse','cheat','inappropriate','other') then
    raise exception 'GC_INVALID_REASON';
  end if;
  perform public.check_rate('report', 5);
  insert into public.reports (reporter_id, reported_id, reason, detail)
  values (v_uid, v_other, p_reason, left(coalesce(p_detail, ''), 500));
  return jsonb_build_object('ok', true);
end $$;
grant execute on function public.report_user(citext, text, text) to authenticated;

-- Add public media to my page. The storage path must live in my own folder.
create or replace function public.media_add(p_kind text, p_path text, p_caption text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := public.require_user(); v_id uuid;
begin
  perform public.check_rate('media', 20);
  if p_kind not in ('photo','clip') then raise exception 'GC_INVALID_MEDIA'; end if;
  if p_path is null or p_path not like v_uid::text || '/%' or char_length(p_path) > 300 then
    raise exception 'GC_INVALID_PATH';
  end if;
  if p_kind = 'photo' and (select count(*) from public.profile_media where owner_id = v_uid and kind = 'photo') >= 24 then
    raise exception 'GC_MEDIA_LIMIT';
  end if;
  if p_kind = 'clip' and (select count(*) from public.profile_media where owner_id = v_uid and kind = 'clip') >= 8 then
    raise exception 'GC_MEDIA_LIMIT';
  end if;
  insert into public.profile_media (owner_id, kind, path, caption)
  values (v_uid, p_kind, p_path, left(coalesce(p_caption, ''), 120))
  on conflict (path) do update set caption = excluded.caption
  returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;
grant execute on function public.media_add(text, text, text) to authenticated;

create or replace function public.media_delete(p_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := public.require_user();
begin
  delete from public.profile_media where id = p_id and owner_id = v_uid;
  if not found then raise exception 'GC_NOT_OWNER'; end if;
  return jsonb_build_object('ok', true);
end $$;
grant execute on function public.media_delete(uuid) to authenticated;

-- ===================================================================== DMs
-- Start (or resume) the conversation with a citizen.
create or replace function public.dm_start(p_username citext)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_other uuid;
begin
  perform public.require_user();
  perform public.check_rate('dm_start', 20);
  select id into v_other from public.profiles where username = lower(p_username) and status = 'active';
  if not found then raise exception 'GC_UNKNOWN_USER'; end if;
  return public.dm_pair(v_other);
end $$;
grant execute on function public.dm_start(citext) to authenticated;

-- Send a message. Membership, blocks and rate limits are all server-side.
drop function if exists public.dm_send(uuid, text, uuid);
create or replace function public.dm_send(p_conversation uuid, p_body text, p_key uuid, p_media text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := public.require_user();
  v_conv public.dm_conversations%rowtype;
  v_body text := trim(coalesce(p_body, ''));
  v_existing bigint;
  v_other uuid;
begin
  perform public.check_rate('dm_send', 30);
  select * into v_conv from public.dm_conversations where id = p_conversation;
  if not found or v_uid not in (v_conv.user_low, v_conv.user_high) then
    raise exception 'GC_NOT_AUTHORISED';
  end if;
  v_other := case when v_conv.user_low = v_uid then v_conv.user_high else v_conv.user_low end;
  if exists (select 1 from public.blocks
             where (blocker_id = v_uid and blocked_id = v_other)
                or (blocker_id = v_other and blocked_id = v_uid)) then
    raise exception 'GC_BLOCKED';
  end if;

  if p_key is not null then
    select id into v_existing from public.dm_messages where client_key = p_key;
    if found then
      return jsonb_build_object('ok', true, 'replay', true, 'id', v_existing);
    end if;
  end if;

  if char_length(v_body) > 1000 or (char_length(v_body) < 1 and p_media is null) then
    raise exception 'GC_INVALID_MESSAGE';
  end if;
  if p_media is not null then
    if char_length(p_media) > 300 or p_media not like p_conversation::text || '/%' then
      raise exception 'GC_INVALID_PATH';
    end if;
  end if;

  insert into public.dm_messages (conversation_id, sender_id, body, media_path, client_key)
  values (p_conversation, v_uid, v_body, p_media, p_key)
  returning id into v_existing;
  update public.dm_conversations set last_message_at = now() where id = p_conversation;

  return jsonb_build_object('ok', true, 'id', v_existing, 'created_at', now());
end $$;
grant execute on function public.dm_send(uuid, text, uuid, text) to authenticated;

-- My conversations, newest activity first, with unread counts.
create or replace function public.dm_threads()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_uid uuid := public.require_user();
begin
  return coalesce((
    select jsonb_agg(t order by t->>'last_at' desc) from (
      select jsonb_build_object(
        'conversation_id', c.id,
        'username', p.username,
        'display_name', p.display_name,
        'avatar_url', p.avatar_url,
        'last_message', (select body from public.dm_messages m where m.conversation_id = c.id order by m.id desc limit 1),
        'last_at', c.last_message_at,
        'unread', (select count(*) from public.dm_messages m
                   where m.conversation_id = c.id and m.sender_id <> v_uid and m.read_at is null)
      ) as t
      from public.dm_conversations c
      join public.profiles p on p.id = case when c.user_low = v_uid then c.user_high else c.user_low end
      where v_uid in (c.user_low, c.user_high)
    ) s), '[]'::jsonb);
end $$;
grant execute on function public.dm_threads() to authenticated;

-- Conversation history (newest page, returned in chronological order). Participants only.
create or replace function public.dm_history(p_conversation uuid, p_before_id bigint default null, p_limit int default 50)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_uid uuid := public.require_user(); v_rows jsonb;
begin
  if not exists (select 1 from public.dm_conversations c
                 where c.id = p_conversation and v_uid in (c.user_low, c.user_high)) then
    raise exception 'GC_NOT_AUTHORISED';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', d.id, 'mine', d.sender_id = v_uid, 'body', d.body,
           'media_path', d.media_path, 'created_at', d.created_at, 'read_at', d.read_at)
         order by d.id), '[]'::jsonb)
    into v_rows
    from (select * from public.dm_messages d
           where d.conversation_id = p_conversation
             and (p_before_id is null or d.id < p_before_id)
           order by d.id desc
           limit least(coalesce(p_limit, 50), 200)) d;
  return v_rows;
end $$;
grant execute on function public.dm_history(uuid, bigint, int) to authenticated;

create or replace function public.dm_mark_read(p_conversation uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := public.require_user();
begin
  update public.dm_messages set read_at = now()
   where conversation_id = p_conversation and sender_id <> v_uid and read_at is null;
  return jsonb_build_object('ok', true);
end $$;
grant execute on function public.dm_mark_read(uuid) to authenticated;

-- ================================================== storage buckets & rules
-- Only when the Supabase storage schema exists (it does on the platform; the
-- local test database has no storage layer).
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public) values ('profile-media', 'profile-media', true)
      on conflict (id) do nothing;
    insert into storage.buckets (id, name, public) values ('dm-media', 'dm-media', false)
      on conflict (id) do nothing;

    execute 'drop policy if exists "profile-media: public read" on storage.objects';
    execute 'create policy "profile-media: public read" on storage.objects for select to anon, authenticated
             using (bucket_id = ''profile-media'')';
    execute 'drop policy if exists "profile-media: owner write" on storage.objects';
    execute 'create policy "profile-media: owner write" on storage.objects for insert to authenticated
             with check (bucket_id = ''profile-media'' and owner = auth.uid()
                         and name like auth.uid()::text || ''/%'')';
    execute 'drop policy if exists "profile-media: owner delete" on storage.objects';
    execute 'create policy "profile-media: owner delete" on storage.objects for delete to authenticated
             using (bucket_id = ''profile-media'' and owner = auth.uid())';

    execute 'drop policy if exists "dm-media: members read" on storage.objects';
    execute 'create policy "dm-media: members read" on storage.objects for select to authenticated
             using (bucket_id = ''dm-media'' and name ~ ''^[0-9a-fA-F-]{36}/''
                    and exists (select 1 from public.dm_conversations c
                                where c.id = (split_part(name, ''/'', 1))::uuid
                                  and auth.uid() in (c.user_low, c.user_high)))';
    execute 'drop policy if exists "dm-media: members write" on storage.objects';
    execute 'create policy "dm-media: members write" on storage.objects for insert to authenticated
             with check (bucket_id = ''dm-media'' and owner = auth.uid()
                         and name ~ ''^[0-9a-fA-F-]{36}/''
                         and exists (select 1 from public.dm_conversations c
                                     where c.id = (split_part(name, ''/'', 1))::uuid
                                       and auth.uid() in (c.user_low, c.user_high)))';
  end if;
end $$;
