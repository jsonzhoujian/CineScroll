create table storyboard_review_submissions (
  workspace_id text not null, project_id text not null, chapter_id text not null, job_id text not null,
  id uuid not null default gen_random_uuid(),
  submitted_by text not null default current_app_user_id(),
  submitted_at timestamptz not null default clock_timestamp(),
  primary key (workspace_id, project_id, chapter_id, id),
  unique (workspace_id, project_id, chapter_id, job_id),
  foreign key (workspace_id, project_id, chapter_id, job_id)
    references storyboard_candidate_versions(workspace_id, project_id, chapter_id, job_id)
);
alter table storyboard_review_submissions enable row level security;
alter table storyboard_review_submissions force row level security;
create policy storyboard_review_read on storyboard_review_submissions for select using (
 workspace_id=current_app_workspace_id() and can_access_project(project_id)
);
create policy storyboard_review_submit on storyboard_review_submissions for insert with check (
 workspace_id=current_app_workspace_id() and submitted_by=current_app_user_id() and can_access_project(project_id)
);
revoke all on storyboard_review_submissions from public,novel_app;
grant select on storyboard_review_submissions to novel_app;
grant insert(workspace_id,project_id,chapter_id,job_id) on storyboard_review_submissions to novel_app;
create trigger storyboard_review_submission_immutable before update or delete on storyboard_review_submissions
 for each row execute function reject_immutable_change();

create policy storyboard_candidate_review_read on storyboard_candidate_versions for select using (
 workspace_id=current_app_workspace_id() and can_access_project(project_id) and exists (
  select 1 from storyboard_review_submissions r where (r.workspace_id,r.project_id,r.chapter_id,r.job_id)=
    (storyboard_candidate_versions.workspace_id,storyboard_candidate_versions.project_id,storyboard_candidate_versions.chapter_id,storyboard_candidate_versions.job_id)
 )
);

create function guard_storyboard_review_submission() returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
 if not exists (
  select 1 from storyboard_candidate_versions v join model_tasks t on (t.workspace_id,t.id)=(v.workspace_id,v.job_id)
  where (v.workspace_id,v.project_id,v.chapter_id,v.job_id)=(new.workspace_id,new.project_id,new.chapter_id,new.job_id)
   and v.created_by=new.submitted_by and t.payload->>'createdBy'=new.submitted_by
   and t.payload->>'projectId'=new.project_id and t.payload->>'chapterId'=new.chapter_id
   and t.payload->'input'->>'stage'='storyboard' and t.payload->'input'->>'resultType'='storyboardContent'
   and t.payload->'input'->>'sourceVersionId'=v.version_json->>'sourceVersionId'
   and t.payload->'input'->'upstreamConfirmedVersionIds'=v.version_json->'upstreamConfirmedVersionIds'
   and t.state='succeeded' and t.result_json->>'candidateVersionId'=v.job_id
   and t.result_json->>'extractionStatus'=v.version_json->>'generationStatus'
 ) then raise exception 'storyboard review submission denied' using errcode='42501'; end if;
 return new;
end $$;
create trigger storyboard_review_submission_guard before insert on storyboard_review_submissions
 for each row execute function guard_storyboard_review_submission();
