-- Trusted owner: a later lock has its own publication identity.
create or replace function guard_script_publication() returns trigger language plpgsql as $$
declare previous jsonb; report jsonb; kind text; op jsonb; expected jsonb; target jsonb; suggestion jsonb; decided jsonb; added jsonb;
begin
  select version_json into previous from script_content_versions where workspace_id=new.workspace_id and project_id=new.project_id and chapter_id=new.chapter_id and id=new.parent_version_id;
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
      if suggestion is null or target is null or decided is null or suggestion->>'status'<>'pending' or target ? 'lockedAt'
        or target->>'text' is distinct from suggestion->>'baseText' or suggestion->>'baseVersionId' is null
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
