create table if not exists model_tasks (
  workspace_id text not null, id text not null, parent_task_id text,
  payload jsonb not null, state text not null check(state in ('queued','running','paused','failed','succeeded')),
  revision integer not null check(revision>=0), reason text,
  primary key(workspace_id,id),
  foreign key(workspace_id,parent_task_id) references model_tasks(workspace_id,id),
  unique(workspace_id,parent_task_id),
  check(jsonb_typeof(payload)='object'),
  check(payload ?& array['workspaceId','id','createdBy','projectId','chapterId','parentTaskId','input','model']),
  check((payload->>'workspaceId') is not distinct from workspace_id and (payload->>'id') is not distinct from id),
  check((payload->>'parentTaskId') is not distinct from parent_task_id)
);
alter table model_tasks drop constraint if exists model_task_reason_valid;
alter table model_tasks add constraint model_task_reason_valid check (
  (state in ('queued','running','succeeded') and reason is null)
  or (state='paused' and reason is not null and reason in ('VERSION_CONFLICT','FORBIDDEN','NOT_READY','UPSTREAM_CHANGED'))
  or (state='failed' and reason is not null and reason='PROVIDER_UNAVAILABLE'));
alter table model_tasks enable row level security;
alter table model_tasks force row level security;
drop policy if exists model_tasks_workspace on model_tasks;
create policy model_tasks_workspace on model_tasks
  using(workspace_id=nullif(current_setting('app.model_workspace_id',true),''))
  with check(workspace_id=nullif(current_setting('app.model_workspace_id',true),''));
create or replace function guard_model_task_transition() returns trigger language plpgsql as $$
begin
  if new.payload is distinct from old.payload or new.workspace_id<>old.workspace_id or new.id<>old.id
    or new.parent_task_id is distinct from old.parent_task_id or new.revision<>old.revision+1
    or not ((old.state='queued' and new.state='running') or (old.state='running' and new.state in ('paused','failed','succeeded'))) then
    raise exception 'invalid task transition';
  end if;
  return new;
end $$;
drop trigger if exists model_task_transition on model_tasks;
create trigger model_task_transition before update on model_tasks for each row execute function guard_model_task_transition();
grant select,insert on model_tasks to novel_app;
grant update(state,revision,reason) on model_tasks to novel_app;
