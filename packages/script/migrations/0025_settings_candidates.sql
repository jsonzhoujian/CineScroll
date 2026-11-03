-- Trusted-owner migration. Initial generation only; review transitions are added by T07-02.
create table settings_candidate_versions (
 workspace_id text not null,project_id text not null,chapter_id text not null,id text not null,
 source_version_id text not null,script_version_id text not null,job_id text not null,created_by text not null,
 version_json jsonb not null,
 primary key(workspace_id,project_id,chapter_id,id),
 unique(workspace_id,project_id,chapter_id,job_id),
 foreign key(project_id,workspace_id) references projects(id,workspace_id),
 foreign key(project_id,chapter_id,source_version_id) references source_versions(project_id,chapter_id,id),
 foreign key(workspace_id,project_id,chapter_id,script_version_id) references script_content_versions(workspace_id,project_id,chapter_id,id),
 check ((jsonb_typeof(version_json)='object'
  and version_json->>'status'='candidate'
  and version_json->>'id'=id and version_json->>'projectId'=project_id
  and version_json->>'chapterId'=chapter_id and version_json->>'sourceVersionId'=source_version_id
  and version_json->>'scriptVersionId'=script_version_id and version_json->>'jobId'=job_id
  and version_json->>'createdBy'=created_by
  and jsonb_typeof(version_json->'assets')='array'
  and jsonb_typeof(version_json->'failures')='array'
  and jsonb_typeof(version_json->'upstreamConfirmedVersionIds')='array'
  and version_json->'upstreamConfirmedVersionIds'->>0=script_version_id
  and version_json->>'generationStatus' in ('succeeded','partially_succeeded','failed')) is true)
);
create table settings_candidate_heads (
 workspace_id text not null,project_id text not null,chapter_id text not null,active_version_id text not null,
 primary key(workspace_id,project_id,chapter_id),
 foreign key(workspace_id,project_id,chapter_id,active_version_id) references settings_candidate_versions(workspace_id,project_id,chapter_id,id)
);
alter table settings_candidate_versions enable row level security;
alter table settings_candidate_versions force row level security;
alter table settings_candidate_heads enable row level security;
alter table settings_candidate_heads force row level security;
create policy settings_candidates_read on settings_candidate_versions for select using(workspace_id=current_app_workspace_id() and can_access_project(project_id));
create policy settings_candidates_insert on settings_candidate_versions for insert with check(workspace_id=current_app_workspace_id() and can_access_project(project_id) and created_by=current_app_user_id());
create policy settings_heads_read on settings_candidate_heads for select using(workspace_id=current_app_workspace_id() and can_access_project(project_id));
create policy settings_heads_insert on settings_candidate_heads for insert with check(workspace_id=current_app_workspace_id() and can_access_project(project_id));
create trigger settings_candidates_immutable before update or delete on settings_candidate_versions for each row execute function reject_immutable_change();
create trigger settings_heads_immutable before update or delete on settings_candidate_heads for each row execute function reject_immutable_change();
revoke all on settings_candidate_versions,settings_candidate_heads from public,novel_app;
grant select,insert on settings_candidate_versions,settings_candidate_heads to novel_app;
