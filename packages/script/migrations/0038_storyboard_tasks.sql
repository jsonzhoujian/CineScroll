create index model_tasks_storyboard_queued_idx on model_tasks(workspace_id,(id collate "C"))
 where payload->'input'->>'stage'='storyboard' and payload->'input'->>'resultType'='storyboardContent' and state='queued';
create index model_tasks_storyboard_recovery_idx on model_tasks(workspace_id,(id collate "C"))
 where payload->'input'->>'stage'='storyboard' and payload->'input'->>'resultType'='storyboardContent'
 and (state='running' or state='paused' and reason='EXECUTION_UNCERTAIN');

create function guard_storyboard_task_write() returns trigger language plpgsql set search_path=public,pg_temp as $$
declare task model_tasks; input jsonb; plan jsonb; base jsonb; scopes jsonb; retry jsonb; v jsonb := new.version_json;
begin
 -- The authority trigger runs first and holds the project, membership and upstream locks.
 -- Let a replay retrieve the immutable result even after the claim has ended.
 if exists (select 1 from storyboard_candidate_versions
   where workspace_id=new.workspace_id and project_id=new.project_id and chapter_id=new.chapter_id
     and job_id=new.job_id and created_by=new.created_by) then return new; end if;
 select * into task from model_tasks where workspace_id=new.workspace_id and id=new.job_id for share;
 input := task.payload->'input';
 select version_json into plan from episode_plan_versions
  where workspace_id=new.workspace_id and project_id=new.project_id and chapter_id=new.chapter_id and id=v->'upstreamConfirmedVersionIds'->>2;
 if (task.state='running' and task.lease_expires_at>clock_timestamp() and task.parent_task_id is null
   and task.payload->>'createdBy'=new.created_by and task.payload->>'projectId'=new.project_id and task.payload->>'chapterId'=new.chapter_id
   and task.payload->'model'->>'workspaceId'=new.workspace_id
   and task.payload->'model'->>'providerId'='deepseek' and task.payload->'model'->>'processingRegion'='mainland'
   and input->>'stage'='storyboard' and input->>'resultType'='storyboardContent'
   and input->>'sourceVersionId'=v->>'sourceVersionId' and input->'upstreamConfirmedVersionIds'=v->'upstreamConfirmedVersionIds'
   and input->'generationParameters'=jsonb_build_object('targetDurationSeconds',plan->'targetDurationSeconds','aspectRatio',plan->'aspectRatio','narrativeMode',plan->'narrativeMode')
   and input->'retry' is not distinct from v->'retry') is not true
 then raise exception 'invalid storyboard task binding' using errcode='42501'; end if;
 if not generation_allowed_locked(new.workspace_id,new.project_id,new.chapter_id,v->>'sourceVersionId')
 then raise exception 'storyboard generation restricted' using errcode='P7003'; end if;

 if jsonb_typeof(v->'shots') is distinct from 'array' or jsonb_typeof(v->'failures') is distinct from 'array'
 then raise exception 'invalid storyboard result' using errcode='P7002'; end if;
 if v->>'generationStatus' is distinct from (case when jsonb_array_length(v->'failures')=0 then 'succeeded'
   when jsonb_array_length(v->'shots')=0 then 'failed' else 'partially_succeeded' end)
   or (select count(distinct shot->>'id') from jsonb_array_elements(v->'shots') shot) <> jsonb_array_length(v->'shots')
   or (select count(distinct f->>'scopeKey') from jsonb_array_elements(v->'failures') f) <> jsonb_array_length(v->'failures')
 then raise exception 'invalid storyboard result' using errcode='P7002'; end if;
 retry := input->'retry';
 if retry is null then return new; end if;
 scopes := retry->'scopeKeys';
 if jsonb_typeof(scopes) is distinct from 'array' or retry->>'expectedActiveVersionId' is distinct from retry->>'retryOfJobId'
 then raise exception 'invalid storyboard retry' using errcode='42501'; end if;
 select version_json into base from storyboard_candidate_versions
  where workspace_id=new.workspace_id and project_id=new.project_id and chapter_id=new.chapter_id
   and job_id=retry->>'retryOfJobId' and created_by=new.created_by;
 if base is null or base->>'sourceVersionId' is distinct from v->>'sourceVersionId'
  or base->'upstreamConfirmedVersionIds' is distinct from v->'upstreamConfirmedVersionIds'
  or jsonb_array_length(scopes) not between 1 and 100
  or (select count(distinct k) from jsonb_array_elements(scopes) as selected(k)
     where jsonb_typeof(k)='string' and exists (
      select 1 from jsonb_array_elements(base->'failures') as original(f) where f->'scopeKey'=k and f->'retryable'='true'::jsonb
     )) <> jsonb_array_length(scopes)
  or exists (select 1 from jsonb_array_elements(base->'shots') as original(shot)
    where not exists (select 1 from jsonb_array_elements(v->'shots') as merged(shot) where merged.shot=original.shot))
  or exists (select 1 from jsonb_array_elements(base->'failures') as original(f) where not (scopes ? (original.f->>'scopeKey'))
    and not exists (select 1 from jsonb_array_elements(v->'failures') as merged(f) where merged.f=original.f))
  or exists (select 1 from jsonb_array_elements(v->'failures') as merged(f) where not (scopes ? (merged.f->>'scopeKey'))
    and not exists (select 1 from jsonb_array_elements(base->'failures') as original(f) where original.f=merged.f))
  or jsonb_array_length(v->'shots')-jsonb_array_length(base->'shots')
     +(select count(*) from jsonb_array_elements(v->'failures') f where scopes ? (f->>'scopeKey')) <> jsonb_array_length(scopes)
 then raise exception 'invalid storyboard retry result' using errcode='42501'; end if;
 return new;
end $$;
create trigger storyboard_candidate_task before insert on storyboard_candidate_versions
 for each row execute function guard_storyboard_task_write();
