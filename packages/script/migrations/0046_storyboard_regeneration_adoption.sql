alter table storyboard_reconciliation_retains
  add column regeneration_job_id text,
  add column regenerated_shot jsonb,
  add constraint storyboard_regeneration_adoption_valid check (
    (regeneration_job_id is null and regenerated_shot is null)
    or (regeneration_job_id is not null and regenerated_shot is not null and revision_value is null)
  );
grant insert(regeneration_job_id) on storyboard_reconciliation_retains to novel_app;

create or replace function guard_storyboard_reconciliation_retain() returns trigger language plpgsql set search_path=public,pg_temp as $$
declare draft storyboard_reconciliations; shots jsonb;
begin
  select * into draft from storyboard_reconciliations
    where (workspace_id,project_id,chapter_id,id)=(new.workspace_id,new.project_id,new.chapter_id,new.reconciliation_id);
  if not found then raise exception 'storyboard reconciliation missing' using errcode='P7005'; end if;
  shots := assert_storyboard_reconciliation(draft);
  if not exists (select 1 from jsonb_array_elements(shots) shot where shot->>'id'=new.shot_id) then
    raise exception 'formal shot missing' using errcode='P7005';
  end if;
  if (new.revision_value is not null or new.regeneration_job_id is not null) and (
    select lock_op.command->>'kind'='lock'
    from storyboard_review_operations publication
    join storyboard_review_operations lock_op using(workspace_id,project_id,chapter_id,review_id)
    where (publication.workspace_id,publication.project_id,publication.chapter_id,publication.publication_id)
      = (draft.workspace_id,draft.project_id,draft.chapter_id,draft.base_publication_id)
      and lock_op.shot_id=new.shot_id and lock_op.command->>'kind' in ('lock','unlock')
    order by lock_op.revision desc limit 1
  ) then raise exception 'formal shot locked' using errcode='P7004'; end if;
  if new.regeneration_job_id is not null then
    select shot into new.regenerated_shot
    from storyboard_candidate_versions candidate
    join model_tasks task on task.workspace_id=candidate.workspace_id and task.id=candidate.job_id
    cross join lateral jsonb_array_elements(candidate.version_json->'shots') shot
    where (candidate.workspace_id,candidate.project_id,candidate.chapter_id,candidate.job_id)
      =(draft.workspace_id,draft.project_id,draft.chapter_id,new.regeneration_job_id)
      and candidate.created_by=current_app_user_id()
      and task.state='succeeded' and task.result_json->>'candidateVersionId'=candidate.job_id
      and candidate.version_json->'storyboardRegeneration' = task.payload->'input'->'storyboardRegeneration'
      and candidate.version_json->'storyboardRegeneration'->>'reconciliationId'=draft.id::text
      and candidate.version_json->'storyboardRegeneration'->>'publicationId'=draft.base_publication_id::text
      and candidate.version_json->>'sourceVersionId'=draft.source_version_id
      and candidate.version_json->'upstreamConfirmedVersionIds'=to_jsonb(draft.upstream_ids)
      and shot->>'id'=new.shot_id;
    if not found then raise exception 'regenerated shot missing' using errcode='P7005'; end if;
  end if;
  return new;
end $$;
