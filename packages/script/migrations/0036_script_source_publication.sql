-- Trusted owner. Allow a current new-source generation to advance the old active head.
create function guard_script_source_publication() returns trigger language plpgsql
 set search_path = public, pg_temp set app.model_workspace_id = '' as $$
declare previous jsonb; report jsonb; kind text; op jsonb; expected jsonb; target jsonb; suggestion jsonb; decided jsonb; added jsonb;
begin
  select version_json into previous from script_content_versions where workspace_id=new.workspace_id and project_id=new.project_id and chapter_id=new.chapter_id and id=new.parent_version_id;
  if previous is not null and previous->>'sourceVersionId' is distinct from new.source_version_id then
    if (new.version_json->>'status'='candidate' and new.created_by=current_app_user_id()
      and new.version_json->>'jobId'=new.job_id
      and new.version_json-array['id','parentVersionId','projectId','chapterId','sourceVersionId','planVersionId','jobId','status','generationStatus','createdBy','createdAt','elements','failures','scenes']='{}'::jsonb) is not true then
      raise exception 'invalid new-source script candidate' using errcode='42501';
    end if;
    perform set_config('app.model_workspace_id',new.workspace_id,true);
    perform 1 from projects pr join chapters c on c.project_id=pr.id
      join story_knowledge_heads k on k.project_id=c.project_id and k.chapter_id=c.id and k.workspace_id=new.workspace_id
      join episode_plan_heads h on h.workspace_id=k.workspace_id and h.project_id=k.project_id and h.chapter_id=k.chapter_id
      join episode_plan_versions p on p.workspace_id=h.workspace_id and p.project_id=h.project_id and p.chapter_id=h.chapter_id and p.id=h.confirmed_version_id
      join model_tasks t on t.workspace_id=h.workspace_id and t.id=new.job_id
      where pr.workspace_id=new.workspace_id and c.project_id=new.project_id and c.id=new.chapter_id and c.active_source_version_id=new.source_version_id
        and p.version_json->'targetDurationSeconds'=to_jsonb(pr.target_duration_seconds)
        and p.version_json->>'aspectRatio'=pr.aspect_ratio and p.version_json->>'narrativeMode'=pr.narrative_mode
        and p.id=new.plan_version_id and p.source_version_id=new.source_version_id and p.story_bible_version_id=k.confirmed_version_id
        and t.state='running' and t.payload->>'createdBy'=new.created_by and t.payload->>'projectId'=new.project_id and t.payload->>'chapterId'=new.chapter_id
        and t.payload->'input'->>'stage'='script' and t.payload->'input'->>'resultType'='scriptContent' and not (t.payload->'input' ? 'retry')
        and t.payload->'input'->>'sourceVersionId'=new.source_version_id
        and t.payload->'input'->'upstreamConfirmedVersionIds'=jsonb_build_array(p.id,k.confirmed_version_id)
        and t.payload->'input'->'generationParameters'=jsonb_build_object('targetDurationSeconds',p.version_json->'targetDurationSeconds',
          'aspectRatio',p.version_json->'aspectRatio','narrativeMode',p.version_json->'narrativeMode')
      for share of pr,c,k,h,t;
    if not found then raise exception 'new source requires a running script task' using errcode='42501'; end if;
    return new;
  end if;
  if new.version_json ? 'revisionOperation' then
    op := new.version_json->'revisionOperation';
    if previous is null or previous->>'status'<>'confirmed' or new.version_json ?| array['publicationOperation','reviewOperation']
      or (op->>'kind'<>'suggest' and not can_review_project(new.project_id)) then
      raise exception 'invalid revision authority' using errcode='42501';
    end if;
    expected := previous - array['publicationOperation','reviewOperation','revisionOperation'];
    if op->>'kind' in ('suggest','unlock') then
      select e into target from jsonb_array_elements(previous->'elements') e where e->>'id'=op->>'targetId';
      if target is null then raise exception 'missing revision target' using errcode='42501'; end if;
      if op->>'kind'='unlock' then
        expected := jsonb_set(expected,'{elements}',(select jsonb_agg(case when e->>'id'=op->>'targetId' then e-array['lockedBy','lockedAt'] else e end order by n) from jsonb_array_elements(previous->'elements') with ordinality x(e,n)));
      else
        added := (new.version_json->'suggestions')->(jsonb_array_length(coalesce(previous->'suggestions','[]'::jsonb)));
        if target ? 'lockedAt' or added is null or added->>'baseVersionId' is distinct from new.parent_version_id
          or added->>'elementId' is distinct from target->>'id' or added->>'baseText' is distinct from target->>'text'
          or added->>'submittedBy' is distinct from new.created_by or added->>'submittedAt' is distinct from new.version_json->>'createdAt'
          or added->>'status' is distinct from 'pending' or added->>'reason' is distinct from op->>'reason'
          or coalesce(length(added->>'text'),0) not between 1 and 20000 or coalesce(length(added->>'id'),0)=0 then
          raise exception 'invalid formal suggestion' using errcode='42501';
        end if;
        expected := jsonb_set(expected,'{suggestions}',coalesce(previous->'suggestions','[]'::jsonb)||jsonb_build_array(added));
      end if;
    else
      select s into suggestion from jsonb_array_elements(previous->'suggestions') s where s->>'id'=op->>'targetId';
      select e into target from jsonb_array_elements(previous->'elements') e where e->>'id'=suggestion->>'elementId';
      select s into decided from jsonb_array_elements(new.version_json->'suggestions') s where s->>'id'=op->>'targetId';
      if suggestion is null or target is null or decided is null or suggestion->>'status'<>'pending' or (decided->>'status'='accepted' and (target ? 'lockedAt' or target->>'text' is distinct from suggestion->>'baseText')) or suggestion->>'baseVersionId' is null
        or decided->>'status' not in ('accepted','rejected') or decided->>'status' is null
        or (decided-array['status','decidedBy','decidedAt']) is distinct from suggestion-'status'
        or decided->>'decidedBy' is distinct from new.created_by or decided->>'decidedAt' is distinct from new.version_json->>'createdAt' then
        raise exception 'invalid formal decision' using errcode='42501';
      end if;
      expected := jsonb_set(expected,'{suggestions}',(select jsonb_agg(case when s->>'id'=op->>'targetId' then decided else s end order by n) from jsonb_array_elements(previous->'suggestions') with ordinality x(s,n)));
      if decided->>'status'='accepted' then
        expected := expected - array['confirmedBy','confirmedAt','confirmationCandidateVersionId','qualityReportId','qualityBinding'];
        expected := expected || jsonb_build_object('status','candidate','revisionOfVersionId',new.parent_version_id,'revisionChanges',jsonb_build_object('fromVersionId',new.parent_version_id,'acceptedSuggestionId',suggestion->>'id','elementIds',jsonb_build_array(target->>'id'),'sceneIds',jsonb_build_array(target->>'sceneId'),'episodeIds',(select coalesce(jsonb_agg(scene->>'episodeId'),'[]'::jsonb) from jsonb_array_elements(previous->'scenes') scene where scene->>'id'=target->>'sceneId')));
        expected := jsonb_set(expected,'{elements}',(select jsonb_agg(case when e->>'id'=target->>'id' then e||jsonb_build_object('text',suggestion->>'text','lastEdit',jsonb_build_object('editedBy',new.created_by,'editedAt',new.version_json->>'createdAt','reason',op->>'reason')) else e end order by n) from jsonb_array_elements(previous->'elements') with ordinality x(e,n)));
      end if;
    end if;
    if (new.version_json - array['id','parentVersionId','createdBy','createdAt','revisionOperation']) is distinct from (expected - array['id','parentVersionId','createdBy','createdAt']) then
      raise exception 'revision changed unrelated content' using errcode='42501';
    end if;
    return new;
  end if;
  kind := new.version_json->'publicationOperation'->>'kind';
  if new.version_json->>'status'='confirmed' then
    if not can_review_project(new.project_id) or previous is null or kind not in ('confirm','lock') or kind is null then
      raise exception 'formal script requires reviewer operation' using errcode='42501';
    end if;
    if kind='confirm' then
      select report_json into report from script_quality_reports where workspace_id=new.workspace_id and project_id=new.project_id and chapter_id=new.chapter_id and id=new.version_json->>'qualityReportId';
      if previous->>'status'<>'candidate' or report is null or report->'passed'<>'true'::jsonb
        or report->>'candidateVersionId'<>new.parent_version_id or report->>'ruleVersion'<>'script-quality/1'
        or report->>'sourceVersionId'<>new.source_version_id or report->>'planVersionId'<>new.plan_version_id
        or report->>'knowledgeVersionId' is distinct from (select confirmed_version_id from story_knowledge_heads where workspace_id=new.workspace_id and project_id=new.project_id and chapter_id=new.chapter_id)
        or (new.version_json->'qualityBinding') is distinct from (report - array['id','projectId','chapterId','createdBy','createdAt','versionId','passed','coverage','reasons','assessment'])
        or new.version_json->>'confirmedBy' is distinct from new.created_by or new.version_json->>'confirmationCandidateVersionId' is distinct from new.parent_version_id
        or previous->>'generationStatus'<>'succeeded' or jsonb_array_length(previous->'failures')<>0
        or exists(select 1 from jsonb_array_elements(coalesce(previous->'suggestions','[]'::jsonb)) s where s->>'status'='pending')
        or (new.version_json - array['id','parentVersionId','createdBy','createdAt','status','confirmedBy','confirmedAt','confirmationCandidateVersionId','qualityReportId','qualityBinding','publicationOperation','reviewOperation','revisionOperation'])
          is distinct from (previous - array['id','parentVersionId','createdBy','createdAt','status','confirmedBy','confirmedAt','confirmationCandidateVersionId','qualityReportId','qualityBinding','publicationOperation','reviewOperation','revisionOperation']) then
        raise exception 'invalid script confirmation' using errcode='42501';
      end if;
    else
      if previous->>'status'<>'confirmed'
        or (new.version_json - array['id','parentVersionId','createdBy','createdAt','elements','publicationOperation','revisionOperation']) is distinct from (previous - array['id','parentVersionId','createdBy','createdAt','elements','publicationOperation','revisionOperation'])
        or (select jsonb_agg(e - array['lockedBy','lockedAt'] order by n) from jsonb_array_elements(new.version_json->'elements') with ordinality x(e,n))
          is distinct from (select jsonb_agg(e - array['lockedBy','lockedAt'] order by n) from jsonb_array_elements(previous->'elements') with ordinality x(e,n))
        or exists(select 1 from jsonb_array_elements(previous->'elements') p join jsonb_array_elements(new.version_json->'elements') e on e->>'id'=p->>'id'
          where p ? 'lockedAt' and (p->'lockedAt' is distinct from e->'lockedAt' or p->'lockedBy' is distinct from e->'lockedBy')) then
        raise exception 'invalid script lock' using errcode='42501';
      end if;
    end if;
  elsif previous->>'status'='confirmed' then
    raise exception 'formal revision not enabled' using errcode='42501';
  end if;
  return new;
end $$;

drop trigger script_publication_guard on script_content_versions;
create trigger script_publication_guard before insert on script_content_versions
 for each row execute function guard_script_source_publication();
drop function guard_script_publication();

create or replace function record_script_impacts() returns trigger language plpgsql as $$
begin
 if new.version_json->>'status'='confirmed' and new.version_json->'publicationOperation'->>'kind'='confirm' and
  (new.version_json ? 'revisionOfVersionId' or exists (
   select 1 from script_content_heads h join script_content_versions prior_formal
    on prior_formal.workspace_id=h.workspace_id and prior_formal.project_id=h.project_id and prior_formal.chapter_id=h.chapter_id and prior_formal.id=h.confirmed_version_id
   where h.workspace_id=new.workspace_id and h.project_id=new.project_id and h.chapter_id=new.chapter_id
    and prior_formal.source_version_id is distinct from new.source_version_id
  )) then
  insert into script_impact_links(workspace_id,project_id,chapter_id,confirmed_version_id,source_version_id,source_element_id,target_stage,target_version_id,target_item_id)
  select new.workspace_id,new.project_id,new.chapter_id,new.id,d.script_version_id,d.script_element_id,d.target_stage,d.target_version_id,d.target_item_id
  from script_downstream_dependencies d join script_content_versions v on v.workspace_id=d.workspace_id and v.project_id=d.project_id and v.chapter_id=d.chapter_id and v.id=d.script_version_id
  cross join lateral jsonb_array_elements(v.version_json->'elements') old_element
  where d.workspace_id=new.workspace_id and d.project_id=new.project_id and d.chapter_id=new.chapter_id and old_element->>'id'=d.script_element_id
    and (old_element - array['lockedAt','lockedBy','lastEdit']) is distinct from
      (select e - array['lockedAt','lockedBy','lastEdit'] from jsonb_array_elements(new.version_json->'elements') e where e->>'id'=d.script_element_id)
  on conflict do nothing;
 end if;
 return new;
end $$;
