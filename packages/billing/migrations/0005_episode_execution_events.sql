-- Append-only provenance for the trusted episode worker.
begin;
create table if not exists public.episode_execution_events (
  workspace_id text not null,
  task_id text not null,
  kind text not null check(kind in ('dispatch_started','not_sent','invalid_response','unknown','completed')),
  candidate_id text check(candidate_id is null or length(btrim(candidate_id)) between 1 and 256),
  recorded_at timestamptz not null default clock_timestamp(),
  primary key(workspace_id,task_id,kind),
  foreign key(workspace_id,task_id) references public.model_tasks(workspace_id,id),
  check((kind='completed')=(candidate_id is not null))
);
alter table public.episode_execution_events enable row level security;
alter table public.episode_execution_events force row level security;
drop policy if exists episode_execution_workspace on public.episode_execution_events;
create policy episode_execution_workspace on public.episode_execution_events to novel_episode_outbox_consumer
  using (workspace_id=nullif(current_setting('app.model_workspace_id',true),''))
  with check (workspace_id=nullif(current_setting('app.model_workspace_id',true),''));
revoke all on public.episode_execution_events from public;
grant select on public.episode_execution_events to novel_episode_outbox_consumer;
grant insert(workspace_id,task_id,kind,candidate_id) on public.episode_execution_events to novel_episode_outbox_consumer;
commit;
