create index if not exists model_tasks_story_queued_scan_idx
on model_tasks(workspace_id,id collate "C")
where payload->'input'->>'stage'='story_knowledge' and state='queued';

create index if not exists model_tasks_story_recovery_scan_idx
on model_tasks(workspace_id,id collate "C")
where payload->'input'->>'stage'='story_knowledge'
  and (state='running' or (state='paused' and reason='EXECUTION_UNCERTAIN'));
