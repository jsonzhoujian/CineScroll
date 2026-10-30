-- Trusted owner only. One retry per candidate may be unresolved at a time;
-- concurrent disjoint retries would still compete for the same immutable head.
create unique index model_tasks_script_retry_active_idx on model_tasks
  (workspace_id,(payload->>'projectId'),(payload->>'chapterId'),(payload->'input'->'retry'->>'expectedActiveVersionId'))
  where payload->'input'->>'stage'='script' and payload->'input'->>'resultType'='scriptContent'
    and payload->'input' ? 'retry'
    and (state in ('queued','running') or state='paused' and reason='EXECUTION_UNCERTAIN');
alter table script_content_versions add constraint script_content_retry_valid check ((
  not (version_json ? 'retry') or (
    jsonb_typeof(version_json->'retry')='object'
    and version_json->'retry' ?& array['expectedActiveVersionId','retryOfJobId','scopeKeys']
    and jsonb_typeof(version_json->'retry'->'expectedActiveVersionId')='string'
    and length(version_json->'retry'->>'expectedActiveVersionId') between 1 and 256
    and jsonb_typeof(version_json->'retry'->'retryOfJobId')='string'
    and length(version_json->'retry'->>'retryOfJobId') between 1 and 256
    and version_json->'retry'->>'retryOfJobId' <> job_id
    and case when jsonb_typeof(version_json->'retry'->'scopeKeys')='array' then jsonb_array_length(version_json->'retry'->'scopeKeys') between 1 and 100 else false end
  )
) is true);
