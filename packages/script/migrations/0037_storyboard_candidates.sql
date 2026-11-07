create table storyboard_candidate_versions (
 workspace_id text not null, project_id text not null, chapter_id text not null,
 job_id text not null, created_by text not null, version_json jsonb not null,
 primary key(workspace_id,project_id,chapter_id,job_id)
);
alter table storyboard_candidate_versions enable row level security;
alter table storyboard_candidate_versions force row level security;
create policy storyboard_candidate_read on storyboard_candidate_versions for select using (
 workspace_id=current_app_workspace_id() and created_by=current_app_user_id() and can_access_project(project_id)
);
create policy storyboard_candidate_insert on storyboard_candidate_versions for insert with check (
 workspace_id=current_app_workspace_id() and created_by=current_app_user_id() and can_access_project(project_id)
);
revoke all on storyboard_candidate_versions from public,novel_app;
grant select,insert on storyboard_candidate_versions to novel_app;
create trigger storyboard_candidate_immutable before update or delete on storyboard_candidate_versions
 for each row execute function reject_immutable_change();

create function guard_storyboard_candidate() returns trigger language plpgsql as $$
declare authority jsonb; settings_id text; plan jsonb; v jsonb := new.version_json;
begin
 authority := lock_settings_review_authority(new.workspace_id,new.project_id,new.chapter_id);
 -- The chapter lock is already held. A settings confirmation takes the same lock first.
 select confirmed_version_id into settings_id from settings_review_heads
  where workspace_id=new.workspace_id and project_id=new.project_id and chapter_id=new.chapter_id for share;
 select version_json into plan from episode_plan_versions
  where workspace_id=new.workspace_id and project_id=new.project_id and chapter_id=new.chapter_id and id=authority->>'planId';
 if settings_id is null or authority->>'sourceId' is null or authority->>'scriptId' is null
  or authority->>'knowledgeId' is null or plan is null
  or v->>'sourceVersionId' is distinct from authority->>'sourceId'
  or v->'upstreamConfirmedVersionIds' is distinct from jsonb_build_array(authority->>'scriptId',settings_id,authority->>'planId',authority->>'knowledgeId')
  or plan->'targetDurationSeconds' is distinct from authority->'targetDurationSeconds'
  or plan->'aspectRatio' is distinct from authority->'aspectRatio'
  or plan->'narrativeMode' is distinct from authority->'narrativeMode'
  or not exists (select 1 from settings_review_versions s where s.workspace_id=new.workspace_id and s.project_id=new.project_id
    and s.chapter_id=new.chapter_id and s.id=settings_id and s.version_json->>'status'='confirmed'
    and s.version_json->>'scriptVersionId'=authority->>'scriptId' and s.version_json->>'sourceVersionId'=authority->>'sourceId'
    and s.version_json->'upstreamConfirmedVersionIds'=jsonb_build_array(authority->>'scriptId',authority->>'planId',authority->>'knowledgeId'))
 then raise exception 'storyboard upstream changed' using errcode='P7001'; end if;
 if v->>'jobId' is distinct from new.job_id or v->>'projectId' is distinct from new.project_id
  or v->>'chapterId' is distinct from new.chapter_id or v->>'createdBy' is distinct from new.created_by
 then raise exception 'storyboard identity mismatch' using errcode='42501'; end if;
 return new;
end $$;
create trigger storyboard_candidate_authority before insert on storyboard_candidate_versions
 for each row execute function guard_storyboard_candidate();

grant insert on script_downstream_dependencies to novel_app;
create policy storyboard_dependencies_insert on script_downstream_dependencies for insert with check (
 workspace_id=current_app_workspace_id() and target_stage='storyboard' and exists (
  select 1 from storyboard_candidate_versions s
  join script_content_versions v on v.workspace_id=s.workspace_id and v.project_id=s.project_id
   and v.chapter_id=s.chapter_id and v.id=s.version_json->'upstreamConfirmedVersionIds'->>0
  cross join lateral jsonb_array_elements(s.version_json->'shots') shot
  cross join lateral jsonb_array_elements(v.version_json->'elements') element
  where s.workspace_id=script_downstream_dependencies.workspace_id and s.project_id=script_downstream_dependencies.project_id
   and s.chapter_id=script_downstream_dependencies.chapter_id and s.job_id=target_version_id
   and v.id=script_version_id and shot->>'id'=target_item_id and element->>'id'=script_element_id
   and element->>'sceneId'=shot->>'sceneId' and (shot->'scriptElementIds') ? script_element_id
 )
);

-- Every candidate insert registers references before the statement can succeed.
create function register_storyboard_dependencies() returns trigger language plpgsql as $$
begin
 if jsonb_typeof(new.version_json->'shots') is distinct from 'array' or exists (
  select 1 from jsonb_array_elements(new.version_json->'shots') shot
  where case when jsonb_typeof(shot->'scriptElementIds')='array'
   then jsonb_array_length(shot->'scriptElementIds')=0 else true end
 ) then raise exception 'storyboard shot references missing' using errcode='P7002'; end if;
 insert into script_downstream_dependencies(workspace_id,project_id,chapter_id,target_stage,target_version_id,target_item_id,script_version_id,script_element_id)
 select new.workspace_id,new.project_id,new.chapter_id,'storyboard',new.job_id,shot->>'id',new.version_json->'upstreamConfirmedVersionIds'->>0,element_id
 from jsonb_array_elements(new.version_json->'shots') shot
 cross join lateral jsonb_array_elements_text(shot->'scriptElementIds') as refs(element_id);
 return new;
end $$;
create trigger storyboard_candidate_dependencies after insert on storyboard_candidate_versions
 for each row execute function register_storyboard_dependencies();
