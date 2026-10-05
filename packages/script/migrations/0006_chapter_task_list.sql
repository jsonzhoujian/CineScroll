create index if not exists model_tasks_story_chapter_idx on model_tasks
  (workspace_id,(payload->>'projectId'),(payload->>'chapterId'),id collate "C")
  where payload->'input'->>'stage'='story_knowledge';
