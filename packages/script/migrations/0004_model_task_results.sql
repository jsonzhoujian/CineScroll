-- Apply after 0003. Existing tasks retain null result; do not invent historical pointers.
alter table model_tasks add column if not exists result_json jsonb;
-- Early development databases used this unnamed reason constraint.
alter table model_tasks drop constraint if exists model_tasks_check2;
alter table model_tasks drop constraint if exists model_task_reason_valid;
alter table model_tasks add constraint model_task_reason_valid check (
  (state in ('queued','running','succeeded') and reason is null)
  or (state='paused' and reason is not null and reason in ('VERSION_CONFLICT','FORBIDDEN','NOT_READY','UPSTREAM_CHANGED'))
  or (state='failed' and reason is not null and reason in ('PROVIDER_UNAVAILABLE','INVALID_RESPONSE','CANDIDATE_EXISTS')));
alter table model_tasks drop constraint if exists model_task_result_valid;
alter table model_tasks add constraint model_task_result_valid check (
  result_json is null or (state='succeeded' and jsonb_typeof(result_json)='object'
    and result_json ?& array['candidateVersionId','extractionStatus']
    and result_json - array['candidateVersionId','extractionStatus'] = '{}'::jsonb
    and jsonb_typeof(result_json->'candidateVersionId')='string'
    and length(btrim(result_json->>'candidateVersionId')) between 1 and 256
    and jsonb_typeof(result_json->'extractionStatus')='string'
    and result_json->>'extractionStatus' in ('succeeded','partially_succeeded','failed')));
grant update(result_json) on model_tasks to novel_app;
