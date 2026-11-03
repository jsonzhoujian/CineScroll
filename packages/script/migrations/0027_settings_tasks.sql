-- Trusted-owner migration; opt-in settings worker discovery only.
create index model_tasks_settings_queued_idx on model_tasks(workspace_id,(id collate "C"))
 where payload->'input'->>'stage'='settings' and payload->'input'->>'resultType'='settingsContent' and state='queued';
create index model_tasks_settings_recovery_idx on model_tasks(workspace_id,(id collate "C"))
 where payload->'input'->>'stage'='settings' and payload->'input'->>'resultType'='settingsContent' and (state='running' or state='paused' and reason='EXECUTION_UNCERTAIN');
create index model_tasks_settings_chapter_idx on model_tasks(workspace_id,(payload->>'projectId'),(payload->>'chapterId'),(id collate "C"))
 where payload->'input'->>'stage'='settings' and payload->'input'->>'resultType'='settingsContent';
