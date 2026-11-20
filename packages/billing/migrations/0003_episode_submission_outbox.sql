-- Apply after billing/0001 and the script model_tasks migrations.
begin;
do $$ begin
  if not exists(select 1 from pg_roles where rolname='novel_episode_submission') then
    create role novel_episode_submission nologin nosuperuser nocreatedb nocreaterole nobypassrls;
  end if;
end $$;

create table if not exists public.episode_submission_outbox (
  workspace_id text not null,
  task_id text not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key(workspace_id,task_id),
  foreign key(workspace_id,task_id) references public.model_tasks(workspace_id,id)
);
alter table public.episode_submission_outbox enable row level security;
alter table public.episode_submission_outbox force row level security;
drop policy if exists episode_submission_workspace on public.episode_submission_outbox;
create policy episode_submission_workspace on public.episode_submission_outbox for insert to novel_episode_submission
  with check (workspace_id=nullif(current_setting('app.model_workspace_id',true),'')
    and workspace_id=nullif(current_setting('app.billing_workspace_id',true),''));
revoke all on public.episode_submission_outbox from public;
grant usage on schema public to novel_episode_submission;
grant insert(workspace_id,task_id) on public.episode_submission_outbox to novel_episode_submission;
commit;
