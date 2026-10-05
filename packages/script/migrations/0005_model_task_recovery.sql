-- No automatic re-execution. Legacy running rows without a lease require reconciliation.
alter table model_tasks add column if not exists lease_expires_at timestamptz;
alter table model_tasks drop constraint if exists model_task_reason_valid;
alter table model_tasks add constraint model_task_reason_valid check (
  (state in ('queued','running','succeeded') and reason is null)
  or (state='paused' and reason is not null and reason in ('VERSION_CONFLICT','FORBIDDEN','NOT_READY','UPSTREAM_CHANGED','EXECUTION_UNCERTAIN'))
  or (state='failed' and reason is not null and reason in ('PROVIDER_UNAVAILABLE','INVALID_RESPONSE','CANDIDATE_EXISTS')));
create or replace function guard_model_task_transition() returns trigger language plpgsql as $$
begin
  if new.payload is distinct from old.payload or new.workspace_id<>old.workspace_id or new.id<>old.id
    or new.parent_task_id is distinct from old.parent_task_id or new.revision<>old.revision+1
    or not ((old.state='queued' and new.state='running' and new.lease_expires_at is not null)
      or (old.state='running' and new.state in ('paused','failed','succeeded') and new.lease_expires_at is null)
      or (old.state='paused' and old.reason='EXECUTION_UNCERTAIN' and new.state='succeeded' and new.result_json is not null and new.lease_expires_at is null)) then
    raise exception 'invalid task transition';
  end if;
  return new;
end $$;
grant update(lease_expires_at) on model_tasks to novel_app;
