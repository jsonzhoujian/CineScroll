-- Trusted-owner migration only; application startup never runs migrations.
alter table script_content_versions drop constraint script_content_versions_check;
alter table script_content_versions add constraint script_content_version_metadata_valid check ((
  jsonb_typeof(version_json)='object' and version_json->>'status' in ('candidate','confirmed')
  and (version_json->>'id') is not distinct from id and (version_json->>'projectId') is not distinct from project_id
  and (version_json->>'chapterId') is not distinct from chapter_id and (version_json->>'parentVersionId') is not distinct from parent_version_id
  and (version_json->>'sourceVersionId') is not distinct from source_version_id and (version_json->>'planVersionId') is not distinct from plan_version_id
  and (version_json->>'jobId') is not distinct from job_id and (version_json->>'createdBy') is not distinct from created_by
) is true);
create table script_quality_reports (
  workspace_id text not null,project_id text not null,chapter_id text not null,id text not null,candidate_version_id text not null,
  report_json jsonb not null,
  primary key(workspace_id,project_id,chapter_id,id),
  foreign key(workspace_id,project_id,chapter_id,candidate_version_id) references script_content_versions(workspace_id,project_id,chapter_id,id),
  check ((jsonb_typeof(report_json)='object' and report_json->>'id'=id and report_json->>'projectId'=project_id
    and report_json->>'chapterId'=chapter_id and report_json->>'candidateVersionId'=candidate_version_id
    and report_json->>'versionId'=candidate_version_id and jsonb_typeof(report_json->'passed')='boolean'
    and report_json->>'contextHash' ~ '^[a-f0-9]{64}$' and length(report_json->>'ruleVersion') between 1 and 256) is true)
);
alter table script_quality_reports enable row level security;
alter table script_quality_reports force row level security;
create policy script_quality_reports_read on script_quality_reports for select using(workspace_id=current_app_workspace_id() and can_access_project(project_id));
create policy script_quality_reports_insert on script_quality_reports for insert with check(workspace_id=current_app_workspace_id() and can_review_project(project_id) and report_json->>'createdBy'=current_app_user_id());
create trigger script_quality_reports_immutable before update or delete on script_quality_reports for each row execute function reject_immutable_change();
revoke all on script_quality_reports from public,novel_app;
grant select,insert on script_quality_reports to novel_app;
create unique index script_publication_request_idx on script_content_versions(workspace_id,project_id,chapter_id,created_by,(version_json->'publicationOperation'->>'requestId')) where version_json ? 'publicationOperation';
alter table script_content_versions add constraint script_publication_operation_valid check ((not (version_json ? 'publicationOperation') or (
  jsonb_typeof(version_json->'publicationOperation')='object'
  and jsonb_typeof(version_json->'publicationOperation'->'requestId')='string'
  and length(version_json->'publicationOperation'->>'requestId') between 1 and 256
  and version_json->'publicationOperation'->>'fingerprint' ~ '^[a-f0-9]{64}$'
  and version_json->'publicationOperation'->>'kind' in ('confirm','lock')
  and jsonb_typeof(version_json->'publicationOperation'->'reason')='string' and length(version_json->'publicationOperation'->>'reason') between 1 and 2000
)) is true);
create function guard_script_publication() returns trigger language plpgsql as $$
declare previous jsonb; report jsonb; kind text;
begin
  select version_json into previous from script_content_versions where workspace_id=new.workspace_id and project_id=new.project_id and chapter_id=new.chapter_id and id=new.parent_version_id;
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
        or (new.version_json - array['id','parentVersionId','createdBy','createdAt','status','confirmedBy','confirmedAt','confirmationCandidateVersionId','qualityReportId','qualityBinding','publicationOperation','reviewOperation'])
          is distinct from (previous - array['id','parentVersionId','createdBy','createdAt','status','confirmedBy','confirmedAt','confirmationCandidateVersionId','qualityReportId','qualityBinding','publicationOperation','reviewOperation']) then
        raise exception 'invalid script confirmation' using errcode='42501';
      end if;
    else
      if previous->>'status'<>'confirmed'
        or (new.version_json - array['id','parentVersionId','createdBy','createdAt','elements','publicationOperation']) is distinct from (previous - array['id','parentVersionId','createdBy','createdAt','elements','publicationOperation'])
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
create trigger script_publication_guard before insert on script_content_versions for each row execute function guard_script_publication();
drop policy script_content_versions_insert on script_content_versions;
create policy script_content_versions_insert on script_content_versions for insert with check (
  workspace_id=current_app_workspace_id() and can_access_project(project_id) and created_by=current_app_user_id()
  and (version_json->>'status'<>'confirmed' or can_review_project(project_id))
  and (not (version_json ? 'publicationOperation') or can_review_project(project_id))
  and (not (version_json ? 'reviewOperation') or version_json->'reviewOperation'->>'kind'='suggest' or can_review_project(project_id))
);
create unique index model_tasks_script_quality_active_idx on model_tasks(workspace_id,(payload->>'projectId'),(payload->>'chapterId'),(payload->'input'->'qualityTarget'->>'candidateVersionId'))
  where payload->'input'->>'resultType'='scriptQuality' and (state in ('queued','running') or state='paused' and reason='EXECUTION_UNCERTAIN');
create index model_tasks_script_quality_scan_idx on model_tasks(workspace_id,(id collate "C")) where payload->'input'->>'resultType'='scriptQuality';
