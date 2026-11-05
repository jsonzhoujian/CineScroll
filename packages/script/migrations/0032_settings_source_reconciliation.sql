alter table settings_review_versions drop constraint settings_review_versions_check;
alter table settings_review_versions add constraint settings_review_versions_check check ((jsonb_typeof(version_json->'id')='string' and jsonb_typeof(version_json->'parentVersionId')='string' and jsonb_typeof(version_json->'createdBy')='string' and version_json->>'id'=id and version_json->>'projectId'=project_id and version_json->>'chapterId'=chapter_id
  and version_json->>'createdBy'=created_by and version_json->>'parentVersionId'=coalesce(parent_review_id,origin_version_id)
  and version_json->>'status' in ('candidate','confirmed') and jsonb_typeof(version_json->'createdAt')='string' and length(version_json->>'createdAt') between 1 and 64
  and jsonb_typeof(version_json->'operation')='object' and version_json->'operation' ?& array['requestId','fingerprint','kind','targetId','reason']
  and (version_json->'operation')-array['requestId','fingerprint','kind','targetId','reason']='{}'::jsonb
  and jsonb_typeof(version_json->'operation'->'requestId')='string' and jsonb_typeof(version_json->'operation'->'fingerprint')='string'
  and jsonb_typeof(version_json->'operation'->'kind')='string' and jsonb_typeof(version_json->'operation'->'targetId')='string' and jsonb_typeof(version_json->'operation'->'reason')='string'
  and length(version_json->'operation'->>'requestId') between 1 and 256
  and version_json->'operation'->>'requestId' !~ E'[\r\n]'
  and version_json->'operation'->>'fingerprint' ~ '^[a-f0-9]{64}$'
  and version_json->'operation'->>'kind' in ('edit','suggest','decide','confirm','lock','unlock','regenerate','reconcile','retain','reconcileUnlock','reconcileRepair')
  and length(version_json->'operation'->>'targetId') between 1 and 256
  and length(version_json->'operation'->>'reason') between 1 and 2000 and length(btrim(version_json->'operation'->>'reason'))>0
  and jsonb_typeof(version_json->'suggestions')='array' and jsonb_typeof(version_json->'locks')='object') is true);
drop trigger settings_review_transition on settings_review_versions;
create trigger settings_review_transition before insert on settings_review_versions for each row
 when (new.version_json->'operation'->>'kind' not in ('regenerate','reconcile','retain','reconcileUnlock','reconcileRepair')) execute function guard_settings_review_version();

create or replace function guard_settings_reconciliation_version() returns trigger language plpgsql as $$
declare previous jsonb;expected jsonb;active text;parent_origin text;origin jsonb;source_id text;script_id text;plan_id text;knowledge_id text;plan jsonb;authority jsonb;
 kind text;target text;asset jsonb;pending jsonb;replacement jsonb;
begin
 if exists(select 1 from settings_candidate_versions where workspace_id=new.workspace_id and project_id=new.project_id and chapter_id=new.chapter_id and id=new.id) then raise exception 'settings version id exists' using errcode='23505'; end if;
 origin := new.version_json;
 authority := lock_settings_review_authority(new.workspace_id,new.project_id,new.chapter_id);
 source_id := authority->>'sourceId';knowledge_id := authority->>'knowledgeId';plan_id := authority->>'planId';script_id := authority->>'scriptId';
 select version_json into plan from episode_plan_versions where workspace_id=new.workspace_id and project_id=new.project_id and chapter_id=new.chapter_id and id=plan_id;
 if (source_id=origin->>'sourceVersionId' and script_id=origin->>'scriptVersionId' and origin->'upstreamConfirmedVersionIds'=jsonb_build_array(script_id,plan_id,knowledge_id)
   and plan->>'sourceVersionId'=source_id and plan->>'storyBibleVersionId'=knowledge_id and plan->'targetDurationSeconds'=authority->'targetDurationSeconds' and plan->>'aspectRatio'=authority->>'aspectRatio' and plan->>'narrativeMode'=authority->>'narrativeMode'
   and exists(select 1 from script_content_versions current_script where current_script.workspace_id=new.workspace_id and current_script.project_id=new.project_id and current_script.chapter_id=new.chapter_id and current_script.id=script_id and current_script.version_json->>'status'='confirmed' and current_script.version_json->>'sourceVersionId'=source_id and current_script.version_json->>'planVersionId'=plan_id)) is not true then raise exception 'settings upstream changed' using errcode='P7001'; end if;
 select active_version_id into active from settings_review_heads where workspace_id=new.workspace_id and project_id=new.project_id and chapter_id=new.chapter_id for update;
 if new.parent_review_id is null then
  select v.version_json into previous from settings_candidate_versions v join settings_candidate_heads h on h.workspace_id=v.workspace_id and h.project_id=v.project_id and h.chapter_id=v.chapter_id and h.active_version_id=v.id
   where v.workspace_id=new.workspace_id and v.project_id=new.project_id and v.chapter_id=new.chapter_id and v.id=new.origin_version_id;
  if active is not null then raise exception 'stale settings origin' using errcode='42501'; end if;
  previous := previous || '{"parentVersionId":null,"suggestions":[],"locks":{}}'::jsonb;
 else
  select version_json,origin_version_id into previous,parent_origin from settings_review_versions where workspace_id=new.workspace_id and project_id=new.project_id and chapter_id=new.chapter_id and id=new.parent_review_id;
  if active is distinct from new.parent_review_id or parent_origin is distinct from new.origin_version_id then raise exception 'stale settings parent' using errcode='42501'; end if;
 end if;
 if previous is null then raise exception 'settings parent missing' using errcode='42501'; end if;

 if not can_review_project(new.project_id) or new.created_by is distinct from current_app_user_id() then raise exception 'reconciliation denied' using errcode='42501'; end if;
 kind := new.version_json->'operation'->>'kind';target := new.version_json->'operation'->>'targetId';expected := previous;
 if kind='reconcile' then
  if previous->'upstreamConfirmedVersionIds'=new.version_json->'upstreamConfirmedVersionIds' or target is distinct from previous->>'id' then raise exception 'unchanged reconciliation authority' using errcode='42501'; end if;
  pending := (previous->'assets')||coalesce(previous->'reconciliation'->'pendingAssets','[]'::jsonb);
  if (select count(*)<>count(distinct a->>'id') from jsonb_array_elements(pending) a) then raise exception 'duplicate pending asset' using errcode='42501'; end if;
  expected := (expected-array['confirmedBy','confirmedAt','regeneration'])||jsonb_build_object('status','candidate','sourceVersionId',source_id,'assets','[]'::jsonb,'suggestions','[]'::jsonb,'scriptVersionId',script_id,'upstreamConfirmedVersionIds',jsonb_build_array(script_id,plan_id,knowledge_id),
   'reconciliation',jsonb_build_object('originVersionId',previous->>'id','pendingAssets',pending,'pendingFailureScopeKeys',(select coalesce(jsonb_agg(f->'scopeKey' order by n),'[]'::jsonb) from jsonb_array_elements(previous->'failures') with ordinality a(f,n))));
  if previous->>'status'='confirmed' then expected := expected||jsonb_build_object('revisionOfVersionId',previous->>'id'); end if;
 elsif kind in ('retain','reconcileUnlock','reconcileRepair') then
  if previous->>'status'<>'candidate' or previous->'upstreamConfirmedVersionIds' is distinct from new.version_json->'upstreamConfirmedVersionIds' then raise exception 'invalid retain authority' using errcode='42501'; end if;
  select a into asset from jsonb_array_elements(previous->'reconciliation'->'pendingAssets') a where a->>'id'=target;
  if asset is null then raise exception 'pending asset missing' using errcode='42501'; end if;
  if kind='reconcileUnlock' then
   if not (previous->'locks' ? target) then raise exception 'asset not locked' using errcode='42501'; end if;
   expected := jsonb_set(expected,'{locks}',(previous->'locks')-target);
  else
   replacement := asset;
   if kind='reconcileRepair' then
    select a into replacement from jsonb_array_elements(new.version_json->'assets') a where a->>'id'=target;
   elsif exists(select 1 from jsonb_array_elements(asset->'provenance') ref where ref->>'sourceVersionId' is distinct from source_id) then
    -- Both version links must point to the same immutable fragment row, including its full text and hash.
    if exists(select 1 from jsonb_array_elements(asset->'provenance') ref where ref->>'type' is distinct from 'source_fragment' or not exists(
     select 1 from source_version_fragments old_link join source_version_fragments new_link
      using(project_id,chapter_id,fragment_id)
     where old_link.project_id=new.project_id and old_link.chapter_id=new.chapter_id
      and old_link.source_version_id=ref->>'sourceVersionId' and old_link.fragment_id=ref->>'fragmentId'
      and new_link.source_version_id=source_id
    )) then raise exception 'evidence migration denied' using errcode='42501'; end if;
    replacement := jsonb_set(asset,'{provenance}',(select jsonb_agg(jsonb_set(ref,'{sourceVersionId}',to_jsonb(source_id)) order by n)
      from jsonb_array_elements(asset->'provenance') with ordinality t(ref,n)));
   end if;
   if (kind='reconcileRepair' or replacement is distinct from asset) and previous->'locks' ? target then raise exception 'asset locked' using errcode='42501'; end if;
   if replacement->>'assetType' is distinct from asset->>'assetType' or valid_settings_regeneration_asset(replacement,new.project_id,new.chapter_id,source_id) is not true then raise exception 'invalid retained evidence' using errcode='42501'; end if;
   expected := jsonb_set(expected,'{assets}',(previous->'assets')||jsonb_build_array(replacement));
   expected := jsonb_set(expected,'{reconciliation,pendingAssets}',(select coalesce(jsonb_agg(a order by n),'[]'::jsonb) from jsonb_array_elements(previous->'reconciliation'->'pendingAssets') with ordinality t(a,n) where a->>'id'<>target));
  end if;
 else raise exception 'invalid reconciliation transition' using errcode='42501'; end if;
 if (new.version_json-array['id','parentVersionId','createdBy','createdAt','operation']) is distinct from (expected-array['id','parentVersionId','createdBy','createdAt','operation']) then raise exception 'reconciliation scope changed' using errcode='42501'; end if;
 return new;
end $$;
drop trigger settings_reconciliation_transition on settings_review_versions;
create trigger settings_reconciliation_transition before insert on settings_review_versions for each row
 when (new.version_json->'operation'->>'kind' in ('reconcile','retain','reconcileUnlock','reconcileRepair')) execute function guard_settings_reconciliation_version();

