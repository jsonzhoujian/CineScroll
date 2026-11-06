-- Trusted owner migration. Preserve the formal pointer while a new source is reviewed.
create function guard_episode_plan_source_head() returns trigger language plpgsql
 set search_path = public, pg_temp set app.model_workspace_id = '' as $$
declare next_plan episode_plan_versions; formal_source text; previous_plan episode_plan_versions;
begin
  if TG_OP='UPDATE' and new.active_version_id is distinct from old.active_version_id then
    select * into next_plan from episode_plan_versions v where v.workspace_id=new.workspace_id
      and v.project_id=new.project_id and v.chapter_id=new.chapter_id and v.id=new.active_version_id;
    if next_plan.id is null or next_plan.parent_version_id is distinct from old.active_version_id then
      raise exception 'episode plan must advance from current head' using errcode='42501';
    end if;
    if old.confirmed_version_id is not null then
      select v.source_version_id into formal_source from episode_plan_versions v where v.workspace_id=new.workspace_id
        and v.project_id=new.project_id and v.chapter_id=new.chapter_id and v.id=old.confirmed_version_id;
      if next_plan.source_version_id is not distinct from formal_source
        or (old.active_version_id=old.confirmed_version_id and
          (next_plan.status<>'candidate' or nullif(next_plan.version_json->>'generationJobId','') is null))
        then raise exception 'confirmed episode plan requires a current new source' using errcode='42501'; end if;
      perform 1 from chapters c join story_knowledge_heads h on h.project_id=c.project_id and h.chapter_id=c.id
        join story_knowledge_versions k on k.workspace_id=h.workspace_id and k.project_id=h.project_id
          and k.chapter_id=h.chapter_id and k.id=h.confirmed_version_id
        where c.project_id=new.project_id and c.id=new.chapter_id and h.workspace_id=new.workspace_id
          and c.active_source_version_id=next_plan.source_version_id and k.source_version_id=next_plan.source_version_id
          and k.id=next_plan.story_bible_version_id and k.status='confirmed'
        for share of c,h;
      if not found then raise exception 'episode plan upstream changed' using errcode='42501'; end if;
      select * into previous_plan from episode_plan_versions v where v.workspace_id=new.workspace_id
        and v.project_id=new.project_id and v.chapter_id=new.chapter_id and v.id=old.active_version_id;
      if next_plan.source_version_id is distinct from previous_plan.source_version_id then
        perform set_config('app.model_workspace_id',new.workspace_id,true);
        perform 1 from model_tasks t where t.workspace_id=new.workspace_id and t.id=next_plan.version_json->>'generationJobId'
            and t.state='running' and t.payload->>'createdBy'=next_plan.created_by
            and t.payload->>'projectId'=new.project_id and t.payload->>'chapterId'=new.chapter_id
            and t.payload->'input'->>'stage'='script' and t.payload->'input'->>'resultType'='episodePlan'
            and t.payload->'input'->>'sourceVersionId'=next_plan.source_version_id
            and t.payload->'input'->'upstreamConfirmedVersionIds'=jsonb_build_array(next_plan.story_bible_version_id)
            and t.payload->'input'->'generationParameters'=jsonb_build_object(
              'targetDurationSeconds',next_plan.version_json->'targetDurationSeconds',
              'aspectRatio',next_plan.version_json->'aspectRatio','narrativeMode',next_plan.version_json->'narrativeMode')
          for share of t;
        if not found or next_plan.status <> 'candidate' or next_plan.created_by is distinct from current_app_user_id() then
          raise exception 'new source requires a running episode plan task' using errcode='42501';
        end if;
      end if;
      if next_plan.status='candidate' then
        if new.confirmed_version_id is distinct from old.confirmed_version_id then
          raise exception 'candidate cannot change formal episode plan' using errcode='42501';
        end if;
      else
        if new.confirmed_version_id is distinct from new.active_version_id or previous_plan.status is distinct from 'candidate'
          or previous_plan.source_version_id is distinct from next_plan.source_version_id
          or previous_plan.story_bible_version_id is distinct from next_plan.story_bible_version_id then
          raise exception 'confirmation requires the current new-source candidate' using errcode='42501';
        end if;
      end if;
    end if;
  end if;
  if TG_OP='UPDATE' and old.confirmed_version_id is not null and new.confirmed_version_id is null then
    raise exception 'confirmed episode plan cannot be cleared' using errcode='42501';
  end if;
  if new.confirmed_version_id is not null and (TG_OP='INSERT' or new.confirmed_version_id is distinct from old.confirmed_version_id) then
    if not can_review_project(new.project_id) or new.active_version_id is distinct from new.confirmed_version_id
      or not exists(select 1 from episode_plan_versions v where v.workspace_id=new.workspace_id and v.project_id=new.project_id
        and v.chapter_id=new.chapter_id and v.id=new.confirmed_version_id and v.status='confirmed') then
      raise exception 'invalid episode confirmation' using errcode='42501';
    end if;
  end if;
  return new;
end $$;
drop trigger episode_plan_head_transition on episode_plan_heads;
create trigger episode_plan_head_transition before insert or update on episode_plan_heads
  for each row execute function guard_episode_plan_source_head();
drop function guard_episode_plan_head();
