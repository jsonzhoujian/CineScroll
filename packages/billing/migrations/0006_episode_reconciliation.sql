-- Durable progress and internal alerts for the episode reconciliation worker.
begin;
do $$ begin
  if not exists(select 1 from pg_roles where rolname='novel_episode_reconciliation') then
    create role novel_episode_reconciliation nologin nosuperuser nocreatedb nocreaterole nobypassrls;
  end if;
end $$;

create table if not exists public.episode_reconciliation_checkpoints (
  workspace_id text primary key check(length(btrim(workspace_id)) between 1 and 256),
  cursor text check(cursor is null or length(btrim(cursor)) between 1 and 256)
);
create table if not exists public.episode_reconciliation_alerts (
  workspace_id text not null references public.episode_reconciliation_checkpoints(workspace_id),
  task_id text not null check(length(btrim(task_id)) between 1 and 256),
  code text not null check(code in ('PLATFORM_SUCCESS_DISABLED','EXECUTION_UNKNOWN','INVALID_EVIDENCE','RECONCILIATION_UNAVAILABLE')),
  created_at timestamptz not null default clock_timestamp(),
  primary key(workspace_id,task_id,code)
);
alter table public.episode_reconciliation_checkpoints enable row level security;
alter table public.episode_reconciliation_checkpoints force row level security;
alter table public.episode_reconciliation_alerts enable row level security;
alter table public.episode_reconciliation_alerts force row level security;

drop policy if exists episode_reconciliation_workspace on public.episode_reconciliation_checkpoints;
create policy episode_reconciliation_workspace on public.episode_reconciliation_checkpoints to novel_episode_reconciliation
  using (workspace_id=nullif(current_setting('app.episode_reconciliation_workspace_id',true),''))
  with check (workspace_id=nullif(current_setting('app.episode_reconciliation_workspace_id',true),''));
drop policy if exists episode_reconciliation_workspace on public.episode_reconciliation_alerts;
create policy episode_reconciliation_workspace on public.episode_reconciliation_alerts to novel_episode_reconciliation
  using (workspace_id=nullif(current_setting('app.episode_reconciliation_workspace_id',true),''))
  with check (workspace_id=nullif(current_setting('app.episode_reconciliation_workspace_id',true),''));

revoke all on public.episode_reconciliation_checkpoints,public.episode_reconciliation_alerts from public;
grant usage on schema public to novel_episode_reconciliation;
grant select(workspace_id,cursor),insert(workspace_id),update(cursor)
  on public.episode_reconciliation_checkpoints to novel_episode_reconciliation;
grant select(workspace_id,task_id,code),insert(workspace_id,task_id,code)
  on public.episode_reconciliation_alerts to novel_episode_reconciliation;
commit;
