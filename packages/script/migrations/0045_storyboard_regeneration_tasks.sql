create function guard_storyboard_regeneration_result() returns trigger language plpgsql set search_path=public,pg_temp as $$
declare
  binding jsonb := new.version_json->'storyboardRegeneration';
  stored jsonb;
  draft storyboard_reconciliations;
  shots jsonb;
  keys jsonb;
begin
  select payload->'input'->'storyboardRegeneration' into stored from model_tasks
    where workspace_id=new.workspace_id and id=new.job_id;
  if binding is distinct from stored then
    raise exception 'invalid storyboard regeneration task binding' using errcode='42501';
  end if;
  if binding is null then
    if exists(select 1 from storyboard_candidate_versions base
      where (base.workspace_id,base.project_id,base.chapter_id,base.job_id) =
        (new.workspace_id,new.project_id,new.chapter_id,new.version_json->'retry'->>'retryOfJobId')
        and base.version_json ? 'storyboardRegeneration')
    then raise exception 'scoped storyboard requires reconciliation' using errcode='P7004'; end if;
    return new;
  end if;
  if exists(select 1 from storyboard_candidate_versions where workspace_id=new.workspace_id
    and project_id=new.project_id and chapter_id=new.chapter_id and job_id=new.job_id and created_by=new.created_by)
  then return new; end if;
  select * into draft from storyboard_reconciliations
    where (workspace_id,project_id,chapter_id)=(new.workspace_id,new.project_id,new.chapter_id)
      and id::text=binding->>'reconciliationId' and base_publication_id::text=binding->>'publicationId';
  if not found then raise exception 'missing storyboard reconciliation' using errcode='P7005'; end if;
  shots := assert_storyboard_reconciliation(draft);
  if draft.source_version_id is distinct from new.version_json->>'sourceVersionId'
    or to_jsonb(draft.upstream_ids) is distinct from new.version_json->'upstreamConfirmedVersionIds'
    or new.version_json ? 'retry'
  then raise exception 'regeneration upstream changed' using errcode='P7001'; end if;
  keys := binding->'scopeKeys';
  if jsonb_typeof(keys) is distinct from 'array' then
    raise exception 'invalid storyboard regeneration scope' using errcode='P7002';
  end if;
  if jsonb_array_length(keys) not between 1 and 100
    or (select count(distinct shot->>'id') from jsonb_array_elements(shots) shot where keys ? (shot->>'id')) <> jsonb_array_length(keys)
    or exists (
      select 1 from storyboard_reconciliation_retains r
      where (r.workspace_id,r.project_id,r.chapter_id,r.reconciliation_id)=(draft.workspace_id,draft.project_id,draft.chapter_id,draft.id)
        and keys ? r.shot_id
    ) or exists (
      select 1 from (
        select distinct on (op.shot_id) op.command->>'kind' as kind
        from storyboard_review_operations publication
        join storyboard_review_operations op using(workspace_id,project_id,chapter_id,review_id)
        where (publication.workspace_id,publication.project_id,publication.chapter_id,publication.publication_id)
          =(draft.workspace_id,draft.project_id,draft.chapter_id,draft.base_publication_id)
          and keys ? op.shot_id and op.command->>'kind' in ('lock','unlock')
        order by op.shot_id,op.revision desc
      ) locks where kind='lock'
    ) then raise exception 'storyboard regeneration scope changed' using errcode='P7004'; end if;
  if (select array_agg(key order by key) from (
    select shot->>'id' as key from jsonb_array_elements(new.version_json->'shots') shot
    union all
    select failure->>'scopeKey' from jsonb_array_elements(new.version_json->'failures') failure
  ) result) is distinct from (select array_agg(key order by key) from jsonb_array_elements_text(keys) key)
  then raise exception 'invalid storyboard regeneration result' using errcode='P7002'; end if;
  return new;
end $$;
create trigger storyboard_candidate_regeneration before insert on storyboard_candidate_versions
  for each row execute function guard_storyboard_regeneration_result();

create function reject_regeneration_review() returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
  if exists(select 1 from storyboard_candidate_versions
    where (workspace_id,project_id,chapter_id,job_id)=(new.workspace_id,new.project_id,new.chapter_id,new.job_id)
      and version_json ? 'storyboardRegeneration')
  then raise exception 'scoped storyboard result requires reconciliation' using errcode='P7004'; end if;
  return new;
end $$;
create trigger storyboard_regeneration_review_guard before insert on storyboard_review_submissions
  for each row execute function reject_regeneration_review();
