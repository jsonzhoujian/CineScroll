alter table model_tasks drop constraint if exists model_task_reason_valid;
alter table model_tasks add constraint model_task_reason_valid check (
  (state in ('queued','running','succeeded') and reason is null)
  or (state='paused' and reason is not null and reason in ('VERSION_CONFLICT','FORBIDDEN','NOT_READY','UPSTREAM_CHANGED','EXECUTION_UNCERTAIN','POLICY_RESTRICTED'))
  or (state='failed' and reason is not null and reason in ('PROVIDER_UNAVAILABLE','INVALID_RESPONSE','CANDIDATE_EXISTS')));
