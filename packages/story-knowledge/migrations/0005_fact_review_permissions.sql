create or replace function can_perform_story_write(target_project_id text, target_operation text) returns boolean
language sql stable
as $$
  select case target_operation
    when 'candidate' then can_write_project(target_project_id)
    when 'retry' then can_write_project(target_project_id)
    when 'review' then can_review_project(target_project_id)
    when 'confirm' then can_review_project(target_project_id)
    else false
  end
$$;

drop policy if exists story_knowledge_versions_insert on story_knowledge_versions;
create policy story_knowledge_versions_insert on story_knowledge_versions for insert with check (
  workspace_id = current_app_workspace_id()
  and can_perform_story_write(project_id, current_story_knowledge_operation())
  and (
    (current_story_knowledge_operation() in ('candidate', 'retry', 'review') and status in ('candidate', 'needs_resolution'))
    or (current_story_knowledge_operation() = 'confirm' and status = 'confirmed')
  )
);
