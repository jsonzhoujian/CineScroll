create table if not exists workspace_task_limits (
  workspace_id text primary key,
  max_queued integer not null check(max_queued>=0),
  max_executing integer not null check(max_executing>=0)
);
alter table workspace_task_limits enable row level security;
alter table workspace_task_limits force row level security;
drop policy if exists workspace_task_limits_read on workspace_task_limits;
create policy workspace_task_limits_read on workspace_task_limits for select to novel_app
  using(workspace_id=nullif(current_setting('app.model_workspace_id',true),''));
revoke all on workspace_task_limits from public,novel_app;
grant select on workspace_task_limits to novel_app;
create index if not exists model_tasks_capacity_idx on model_tasks(workspace_id,state,reason);

-- Trusted migration owner needs RLS bypass; application cannot own/replace this function.
create or replace function enforce_workspace_task_limits() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
declare limits record; occupied bigint;
begin
  if TG_OP='UPDATE' and not (OLD.state='queued' and NEW.state='running') then return NEW; end if;
  if current_setting('transaction_isolation')<>'read committed' then
    raise exception 'task admission requires read committed' using errcode='PZ001';
  end if;
  select max_queued,max_executing into limits from public.workspace_task_limits
    where workspace_id=NEW.workspace_id for update;
  if not found then raise exception 'task limits unavailable' using errcode='PZ001'; end if;
  if NEW.state='queued' then
    select count(*) into occupied from public.model_tasks where workspace_id=NEW.workspace_id and state='queued';
    if occupied>=limits.max_queued then raise exception 'task queue full' using errcode='PZ002'; end if;
  elsif NEW.state='running' or (NEW.state='paused' and NEW.reason='EXECUTION_UNCERTAIN') then
    select count(*) into occupied from public.model_tasks where workspace_id=NEW.workspace_id
      and (state='running' or (state='paused' and reason='EXECUTION_UNCERTAIN'));
    if occupied>=limits.max_executing then raise exception 'task execution full' using errcode='PZ003'; end if;
  end if;
  return NEW;
end $$;
revoke all on function enforce_workspace_task_limits() from public,novel_app;
drop trigger if exists model_task_capacity on model_tasks;
create trigger model_task_capacity before insert or update on model_tasks
  for each row execute function enforce_workspace_task_limits();
