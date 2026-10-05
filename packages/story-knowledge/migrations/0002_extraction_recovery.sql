create index if not exists story_knowledge_initial_job_idx on story_knowledge_versions
  (workspace_id,project_id,chapter_id,extraction_job_id) where parent_version_id is null;
