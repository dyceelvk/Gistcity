-- GIST · game persistence
-- Drop this file into Crushly's supabase/migrations/ (the db-migrations.yml
-- workflow pushes it) or paste it into the Supabase SQL editor. Re-runnable.
--
-- One row per auth user: the saved character, inventory and progress live in
-- `state` (JSON, validated client-side on load); a few columns are
-- denormalised for the leaderboard. Anonymous sign-ins are supported, so
-- enable "Allow anonymous sign-ins" under Authentication → Providers if you
-- want progress to sync before the player gives an email.

create table if not exists public.gist_players (
  id            uuid primary key references auth.users(id) on delete cascade,
  display_name  text not null default 'New GistCitizen' check (char_length(display_name) between 1 and 22),
  appearance    jsonb not null default '{}'::jsonb,
  state         jsonb not null default '{}'::jsonb,
  cash          integer not null default 5000 check (cash >= 0),
  popularity    integer not null default 0 check (popularity >= 0),
  level         integer not null default 1 check (level >= 1),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists gist_players_popularity_idx on public.gist_players (popularity desc, level desc);

alter table public.gist_players enable row level security;

drop policy if exists "gist: read own" on public.gist_players;
create policy "gist: read own" on public.gist_players
  for select to authenticated using (id = auth.uid());

drop policy if exists "gist: insert own" on public.gist_players;
create policy "gist: insert own" on public.gist_players
  for insert to authenticated with check (id = auth.uid());

drop policy if exists "gist: update own" on public.gist_players;
create policy "gist: update own" on public.gist_players
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- Keep `state` from growing without bound (a full save is ~2 KB).
create or replace function public.gist_players_guard()
returns trigger language plpgsql as $$
begin
  if pg_column_size(new.state) > 32768 then
    raise exception 'gist state too large';
  end if;
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists gist_players_guard on public.gist_players;
create trigger gist_players_guard before insert or update on public.gist_players
  for each row execute function public.gist_players_guard();

-- Public leaderboard: only the columns everyone may see.
-- (A view without security_invoker runs as its owner, so it can read across
-- rows while the table itself stays locked down to "own row".)
create or replace view public.gist_leaderboard as
  select id, display_name, popularity, level, cash
  from public.gist_players
  order by popularity desc, level desc, cash desc
  limit 100;

grant select on public.gist_leaderboard to anon, authenticated;
grant select, insert, update on public.gist_players to authenticated;

-- Realtime presence/broadcast for the city uses channel "gist:city"; nothing
-- is persisted, so no table is needed. Make sure Realtime is enabled on the
-- project (it is by default).
