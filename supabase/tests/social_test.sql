-- Behavioural tests for the GistCity social migration (profiles, media, follows,
-- blocks, reports, direct messages). Run on a scratch database after the migrations:
--   psql -d gist_test -v ON_ERROR_STOP=1 -f supabase/tests/social_test.sql
-- Every block raises if an expectation fails; the last line prints PASS.

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

-- ------------------------------------------------------------------- users
insert into auth.users (id, email, raw_user_meta_data) values
  ('25111111-1111-1111-1111-111111111111', 'ada@test.dev',  '{"username":"ada_test","display_name":"Ada","tos_accepted":true,"privacy_accepted":true,"age_confirmed":true}'),
  ('25222222-2222-2222-2222-222222222222', 'bola@test.dev', '{"username":"bola_test","display_name":"Bola","tos_accepted":true,"privacy_accepted":true,"age_confirmed":true}'),
  ('25333333-3333-3333-3333-333333333333', 'chidi@test.dev','{"username":"chidi_test","display_name":"Chidi","tos_accepted":true,"privacy_accepted":true,"age_confirmed":true}'),
  ('25444444-4444-4444-4444-444444444444', 'mod@test.dev',  '{"username":"mod_test","display_name":"Mod","tos_accepted":true,"privacy_accepted":true,"age_confirmed":true}');

select pg_temp.assert((select count(*) from profiles where username in ('ada_test','bola_test','chidi_test','mod_test')) = 4, 'four citizens registered');

-- ----------------------------------------------------------- public pages
select pg_temp.assert((profile_page('ada_test')->>'display_name') = 'Ada', 'profile page shows display name');
select pg_temp.assert((profile_page('ada_test')->>'occupation') = 'Citizen', 'default occupation is Citizen');
select pg_temp.assert((profile_page('ada_test')->>'followers')::int = 0, 'fresh profile has no followers');
select pg_temp.assert((profile_page('ada_test')->>'can_dm')::boolean = false, 'anonymous visitor cannot DM');

do $$ begin
  begin
    perform profile_page('nobody_test');
    perform pg_temp.assert(false, 'unknown profile must raise');
  exception when others then
    if sqlerrm not like '%GC_UNKNOWN_USER%' then raise; end if;
  end;
end $$;

-- ------------------------------------------------------------------ media
select pg_temp.login('25111111-1111-1111-1111-111111111111');

do $$ begin
  begin
    perform media_add('photo', '25222222-2222-2222-2222-222222222222/steal.jpg', '');
    perform pg_temp.assert(false, 'uploading into someone else''s folder must raise');
  exception when others then
    if sqlerrm not like '%GC_INVALID_PATH%' then raise; end if;
  end;
  begin
    perform media_add('video', '25111111-1111-1111-1111-111111111111/x.mp4', '');
    perform pg_temp.assert(false, 'invalid media kind must raise');
  exception when others then
    if sqlerrm not like '%GC_INVALID_MEDIA%' then raise; end if;
  end;
end $$;

select pg_temp.assert((media_add('photo', '25111111-1111-1111-1111-111111111111/me.jpg', 'my face')->>'ok')::boolean, 'own photo accepted');
select pg_temp.assert((media_add('clip', '25111111-1111-1111-1111-111111111111/life.mp4', 'my clip')->>'ok')::boolean, 'own clip accepted');
select pg_temp.assert((select count(*) from profile_media where owner_id = '25111111-1111-1111-1111-111111111111') = 2, 'both media rows catalogued');
select pg_temp.assert(jsonb_array_length(profile_page('ada_test')->'media') = 2, 'profile page shows the gallery');

-- non-owner cannot delete; direct writes are denied entirely
select pg_temp.login('25222222-2222-2222-2222-222222222222');
do $$
declare v_id uuid;
begin
  select id into v_id from profile_media where owner_id = '25111111-1111-1111-1111-111111111111' limit 1;
  begin
    perform media_delete(v_id);
    perform pg_temp.assert(false, 'deleting someone else''s media must raise');
  exception when others then
    if sqlerrm not like '%GC_NOT_OWNER%' then raise; end if;
  end;
  begin
    insert into profile_media (owner_id, kind, path) values ('25222222-2222-2222-2222-222222222222', 'photo', 'x');
    perform pg_temp.assert(false, 'direct insert must be denied');
  exception when others then
    if sqlerrm not like '%permission denied%' then raise; end if;
  end;
end $$;

select pg_temp.login('25111111-1111-1111-1111-111111111111');
select pg_temp.assert((select (media_delete(id)->>'ok')::boolean from profile_media where owner_id = auth.uid() and kind = 'clip'), 'owner deletes own media');

-- ----------------------------------------------------------------- follows
do $$ begin
  begin
    perform follow_toggle('ada_test', true);
    perform pg_temp.assert(false, 'following yourself must raise');
  exception when others then
    if sqlerrm not like '%GC_SELF%' then raise; end if;
  end;
end $$;
select pg_temp.assert((follow_toggle('bola_test', true)->>'following')::boolean, 'ada follows bola');
select pg_temp.assert((profile_page('bola_test')->>'followers')::int = 1, 'follower count updates');
select pg_temp.assert((profile_page('bola_test')->>'i_follow')::boolean = true, 'i_follow is set');

select pg_temp.login('25222222-2222-2222-2222-222222222222');
select pg_temp.assert((follow_toggle('ada_test', true)->>'following')::boolean, 'bola follows ada');
select pg_temp.assert((profile_page('ada_test')->>'follows_me')::boolean = true, 'follows_me is set');

-- ------------------------------------------------------------------- blocks
select pg_temp.login('25111111-1111-1111-1111-111111111111');
select pg_temp.assert((follow_toggle('chidi_test', true)->>'following')::boolean, 'ada follows chidi');
select pg_temp.login('25333333-3333-3333-3333-333333333333');
select pg_temp.assert((follow_toggle('ada_test', true)->>'following')::boolean, 'chidi follows ada');

select pg_temp.login('25111111-1111-1111-1111-111111111111');
select pg_temp.assert((block_toggle('chidi_test', true)->>'blocked')::boolean, 'ada blocks chidi');
select pg_temp.assert((select count(*) from follows where (follower_id, followee_id) in (
  ('25111111-1111-1111-1111-111111111111','25333333-3333-3333-3333-333333333333'),
  ('25333333-3333-3333-3333-333333333333','25111111-1111-1111-1111-111111111111'))) = 0, 'blocking removes follows both ways');
select pg_temp.assert((profile_page('chidi_test')->>'can_dm')::boolean = false, 'blocked citizen cannot be DMd');

do $$ begin
  begin
    perform dm_start('chidi_test');
    perform pg_temp.assert(false, 'DM to a blocked citizen must raise');
  exception when others then
    if sqlerrm not like '%GC_BLOCKED%' then raise; end if;
  end;
end $$;

-- blocks are private: a third player cannot see them
select pg_temp.login('25222222-2222-2222-2222-222222222222');
select pg_temp.assert((select count(*) from blocks) = 0, 'block rows are private to the blocker');

-- ----------------------------------------------------------------- reports
select pg_temp.login('25222222-2222-2222-2222-222222222222');
do $$ begin
  begin
    perform report_user('ada_test', 'nonsense', '');
    perform pg_temp.assert(false, 'invalid report reason must raise');
  exception when others then
    if sqlerrm not like '%GC_INVALID_REASON%' then raise; end if;
  end;
end $$;
select pg_temp.assert((report_user('ada_test', 'spam', 'selling followers')->>'ok')::boolean, 'report filed');
select pg_temp.assert((select status from reports where reported_id = '25111111-1111-1111-1111-111111111111') = 'open', 'report lands open');

-- rate limit: 5 per minute
do $$
declare i int;
begin
  for i in 1..4 loop perform report_user('ada_test', 'other', ''); end loop;
  begin
    perform report_user('ada_test', 'other', '');
    perform pg_temp.assert(false, 'sixth report inside a minute must raise');
  exception when others then
    if sqlerrm not like '%GC_RATE_LIMITED%' then raise; end if;
  end;
end $$;

-- --------------------------------------------------------------------- DMs
select pg_temp.login('25111111-1111-1111-1111-111111111111');
select pg_temp.assert((block_toggle('chidi_test', false)->>'blocked')::boolean = false, 'unblock restores contact');

do $$
declare v_conv uuid; v_again uuid;
begin
  v_conv := dm_start('bola_test');
  v_again := dm_start('bola_test');
  perform pg_temp.assert(v_conv = v_again, 'dm_start resumes the same conversation');
end $$;

do $$
declare v_conv uuid; v_key uuid := gen_random_uuid(); r jsonb;
begin
  v_conv := dm_start('chidi_test');
  -- non-member cannot send
  perform pg_temp.logout();
  perform pg_temp.login('25222222-2222-2222-2222-222222222222');
  begin
    perform dm_send(v_conv, 'hello?', gen_random_uuid());
    perform pg_temp.assert(false, 'sending into someone else''s conversation must raise');
  exception when others then
    if sqlerrm not like '%GC_NOT_AUTHORISED%' then raise; end if;
  end;

  perform pg_temp.logout();
  perform pg_temp.login('25111111-1111-1111-1111-111111111111');
  r := dm_send(v_conv, 'Chidi, how far?', v_key);
  perform pg_temp.assert((r->>'ok')::boolean, 'message sent');
  -- idempotent replay
  r := dm_send(v_conv, 'Chidi, how far?', v_key);
  perform pg_temp.assert((r->>'replay')::boolean, 'same key replays without a second message');
  perform pg_temp.assert((select count(*) from dm_messages where conversation_id = v_conv) = 1, 'exactly one message stored');

  -- member reads via RLS; stranger sees nothing
  perform pg_temp.assert((select count(*) from dm_messages where conversation_id = v_conv) = 1, 'member sees the message');
  perform pg_temp.logout();
  perform pg_temp.login('25222222-2222-2222-2222-222222222222');
  perform pg_temp.assert((select count(*) from dm_messages where conversation_id = v_conv) = 0, 'stranger sees nothing');

  perform pg_temp.logout();
  perform pg_temp.login('25333333-3333-3333-3333-333333333333');
  perform pg_temp.assert((select count(*) from dm_messages where conversation_id = v_conv) = 1, 'recipient sees the message');
  perform pg_temp.assert((jsonb_array_length(dm_threads())) = 1, 'recipient has one thread');
  perform pg_temp.assert((dm_threads()->0->>'unread')::int = 1, 'recipient has one unread');
  perform pg_temp.assert((dm_threads()->0->>'username') = 'ada_test', 'thread shows the sender');
  perform pg_temp.assert((dm_history(v_conv)->0->>'mine')::boolean = false, 'history marks their message');
  perform pg_temp.assert((dm_send(v_conv, 'I dey fine!', gen_random_uuid())->>'ok')::boolean, 'recipient replies');
  perform pg_temp.assert((dm_mark_read(v_conv)->>'ok')::boolean, 'marking read works');
  perform pg_temp.assert((dm_threads()->0->>'unread')::int = 0, 'unread cleared for me');

  perform pg_temp.logout();
  perform pg_temp.login('25111111-1111-1111-1111-111111111111');
  perform pg_temp.assert((jsonb_array_length(dm_history(v_conv))) = 2, 'both messages in history');
  perform pg_temp.assert((select (t->>'unread')::int from jsonb_array_elements(dm_threads()) t where t->>'username' = 'chidi_test') = 1, 'ada sees one unread reply');
  perform pg_temp.assert((select t->>'last_message' from jsonb_array_elements(dm_threads()) t where t->>'username' = 'chidi_test') = 'I dey fine!', 'thread previews the last message');

  -- invalid message body
  begin
    perform dm_send(v_conv, '', gen_random_uuid());
    perform pg_temp.assert(false, 'empty message must raise');
  exception when others then
    if sqlerrm not like '%GC_INVALID_MESSAGE%' then raise; end if;
  end;
  -- attachments must live under the conversation folder
  begin
    perform dm_send(v_conv, '', gen_random_uuid(), 'somewhere-else/evil.jpg');
    perform pg_temp.assert(false, 'attachment outside the conversation must raise');
  exception when others then
    if sqlerrm not like '%GC_INVALID_PATH%' then raise; end if;
  end;
  perform pg_temp.assert((dm_send(v_conv, 'see this', gen_random_uuid(), v_conv::text || '/photo.jpg')->>'ok')::boolean, 'attachment in the conversation folder is accepted');
  perform pg_temp.assert((select media_path from dm_messages where conversation_id = v_conv and body = 'see this') = v_conv::text || '/photo.jpg', 'attachment path stored');
end $$;

-- RLS: nobody writes these tables directly
select pg_temp.login('25111111-1111-1111-1111-111111111111');
do $$ begin
  begin
    insert into dm_messages (conversation_id, sender_id, body)
    select id, auth.uid(), 'sneaky' from dm_conversations limit 1;
    perform pg_temp.assert(false, 'direct message insert must be denied');
  exception when others then
    if sqlerrm not like '%permission denied%' then raise; end if;
  end;
end $$;

-- signed-out callers cannot use the surface
select pg_temp.logout();
do $$ begin
  begin
    perform dm_start('ada_test');
    perform pg_temp.assert(false, 'signed-out dm_start must raise');
  exception when others then
    if sqlerrm not like '%GC_NOT_SIGNED_IN%' then raise; end if;
  end;
end $$;

select 'PASS: all GistCity social tests passed' as result;
