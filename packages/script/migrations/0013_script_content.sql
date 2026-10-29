-- Trusted-owner migration; never applied by application startup.
create table script_content_versions (
  workspace_id text not null, project_id text not null, chapter_id text not null, id text not null,
  parent_version_id text, source_version_id text not null, plan_version_id text not null, job_id text not null, created_by text not null,
  version_json jsonb not null,
  primary key(workspace_id,project_id,chapter_id,id),
  foreign key(project_id,workspace_id) references projects(id,workspace_id),
  foreign key(project_id,chapter_id,source_version_id) references source_versions(project_id,chapter_id,id),
  foreign key(workspace_id,project_id,chapter_id,plan_version_id) references episode_plan_versions(workspace_id,project_id,chapter_id,id),
  foreign key(workspace_id,project_id,chapter_id,parent_version_id) references script_content_versions(workspace_id,project_id,chapter_id,id),
  check(jsonb_typeof(version_json)='object' and version_json->>'status'='candidate'
    and (version_json->>'id') is not distinct from id and (version_json->>'projectId') is not distinct from project_id
    and (version_json->>'chapterId') is not distinct from chapter_id and (version_json->>'parentVersionId') is not distinct from parent_version_id
    and (version_json->>'sourceVersionId') is not distinct from source_version_id and (version_json->>'planVersionId') is not distinct from plan_version_id
    and (version_json->>'jobId') is not distinct from job_id and (version_json->>'createdBy') is not distinct from created_by)
);
create index script_content_source_idx on script_content_versions(project_id,chapter_id,source_version_id);
create index script_content_plan_idx on script_content_versions(workspace_id,project_id,chapter_id,plan_version_id);
create index script_content_parent_idx on script_content_versions(workspace_id,project_id,chapter_id,parent_version_id);
create table script_content_heads (
  workspace_id text not null, project_id text not null, chapter_id text not null, active_version_id text,
  primary key(workspace_id,project_id,chapter_id),
  foreign key(project_id,workspace_id) references projects(id,workspace_id),
  foreign key(project_id,chapter_id) references chapters(project_id,id),
  foreign key(workspace_id,project_id,chapter_id,active_version_id) references script_content_versions(workspace_id,project_id,chapter_id,id)
);
create table script_content_generations (
  workspace_id text not null, project_id text not null, chapter_id text not null, job_id text not null, version_id text not null,
  primary key(workspace_id,project_id,chapter_id,job_id),
  foreign key(workspace_id,project_id,chapter_id,version_id) references script_content_versions(workspace_id,project_id,chapter_id,id)
);
create index script_content_generation_version_idx on script_content_generations(workspace_id,project_id,chapter_id,version_id);
alter table script_content_versions enable row level security;
alter table script_content_versions force row level security;
alter table script_content_heads enable row level security;
alter table script_content_heads force row level security;
alter table script_content_generations enable row level security;
alter table script_content_generations force row level security;
create policy script_content_versions_read on script_content_versions for select using(workspace_id=current_app_workspace_id() and can_access_project(project_id));
create policy script_content_versions_insert on script_content_versions for insert with check(workspace_id=current_app_workspace_id() and can_access_project(project_id) and created_by=current_app_user_id());
create policy script_content_heads_read on script_content_heads for select using(workspace_id=current_app_workspace_id() and can_access_project(project_id));
create policy script_content_heads_insert on script_content_heads for insert with check(workspace_id=current_app_workspace_id() and can_access_project(project_id));
create policy script_content_heads_update on script_content_heads for update using(workspace_id=current_app_workspace_id() and can_access_project(project_id)) with check(workspace_id=current_app_workspace_id() and can_access_project(project_id));
create policy script_content_generations_read on script_content_generations for select using(workspace_id=current_app_workspace_id() and can_access_project(project_id));
create policy script_content_generations_insert on script_content_generations for insert with check(workspace_id=current_app_workspace_id() and can_access_project(project_id));
create trigger script_content_versions_immutable before update or delete on script_content_versions for each row execute function reject_immutable_change();
create trigger script_content_generations_immutable before update or delete on script_content_generations for each row execute function reject_immutable_change();
create function guard_script_content_head() returns trigger language plpgsql as $$
begin
  if new.active_version_id is not null and not exists (
    select 1 from script_content_versions v where v.workspace_id=new.workspace_id and v.project_id=new.project_id and v.chapter_id=new.chapter_id and v.id=new.active_version_id
      and v.parent_version_id is not distinct from (case when TG_OP='UPDATE' then old.active_version_id else null end)
  ) then raise exception 'invalid script head transition' using errcode='42501'; end if;
  if TG_OP='UPDATE' and old.active_version_id is not null and new.active_version_id is null then
    raise exception 'script head cannot be cleared' using errcode='42501';
  end if;
  return new;
end $$;
create trigger script_content_head_transition before insert or update on script_content_heads for each row execute function guard_script_content_head();
revoke all on script_content_versions,script_content_heads,script_content_generations from public,novel_app;
grant select,insert on script_content_versions,script_content_heads,script_content_generations to novel_app;
grant update(active_version_id) on script_content_heads to novel_app;
create index model_tasks_script_queued_idx on model_tasks(workspace_id,(id collate "C")) where payload->'input'->>'stage'='script' and payload->'input'->>'resultType'='scriptContent' and state='queued';
create index model_tasks_script_recovery_idx on model_tasks(workspace_id,(id collate "C")) where payload->'input'->>'stage'='script' and payload->'input'->>'resultType'='scriptContent' and (state='running' or state='paused' and reason='EXECUTION_UNCERTAIN');
create index model_tasks_script_chapter_idx on model_tasks(workspace_id,(payload->>'projectId'),(payload->>'chapterId'),(id collate "C")) where payload->'input'->>'stage'='script' and payload->'input'->>'resultType'='scriptContent';
