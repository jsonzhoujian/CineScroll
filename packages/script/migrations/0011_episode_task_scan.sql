create index if not exists model_tasks_episode_queued_scan_idx
on model_tasks(workspace_id,id collate "C")
where payload->'input'->>'stage'='script'
  and payload->'input'->>'resultType'='episodePlan' and state='queued';

create index if not exists model_tasks_episode_recovery_scan_idx
on model_tasks(workspace_id,id collate "C")
where payload->'input'->>'stage'='script'
  and payload->'input'->>'resultType'='episodePlan'
  and (state='running' or (state='paused' and reason='EXECUTION_UNCERTAIN'));
