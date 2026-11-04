-- Trusted-owner migration. Existing review transitions retain their original guard.
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
  and version_json->'operation'->>'kind' in ('edit','suggest','decide','confirm','lock','unlock','regenerate')
  and length(version_json->'operation'->>'targetId') between 1 and 256
  and length(version_json->'operation'->>'reason') between 1 and 2000 and length(btrim(version_json->'operation'->>'reason'))>0
  and jsonb_typeof(version_json->'suggestions')='array' and jsonb_typeof(version_json->'locks')='object') is true);
drop trigger settings_review_transition on settings_review_versions;
create trigger settings_review_transition before insert on settings_review_versions for each row
 when (new.version_json->'operation'->>'kind' is distinct from 'regenerate') execute function guard_settings_review_version();
create unique index settings_regeneration_job_idx on settings_review_versions(workspace_id,project_id,chapter_id,(version_json->'regeneration'->>'jobId'))
 where version_json->'operation'->>'kind'='regenerate';

-- Match the runtime validator's untrimmed UTF-16 lengths and JSON depth limit.
create function valid_settings_regeneration_asset(a jsonb,p text,c text,s text) returns boolean language plpgsql stable as $$
begin
 if valid_settings_review_asset(a,p,c,s) is not true then return false; end if;
 if length(btrim(a->>'id',U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'))=0
  or length(btrim(a->>'name',U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'))=0
  or length(regexp_replace(a->>'id',U&'[\+010000-\+10FFFF]','xx','g'))>256
  or length(regexp_replace(a->>'name',U&'[\+010000-\+10FFFF]','xx','g'))>20000 then return false; end if;
 return not exists (
  with recursive nodes(value,depth) as (
   select a->'visibleDefinition',0
   union all
   select child.value,n.depth+1 from nodes n cross join lateral (
    select value from jsonb_each(case when jsonb_typeof(n.value)='object' then n.value else '{}'::jsonb end)
    union all select value from jsonb_array_elements(case when jsonb_typeof(n.value)='array' then n.value else '[]'::jsonb end)
   ) child where n.depth<=20
  ) select 1 from nodes where depth>20 or case when jsonb_typeof(value)='number' then abs((value#>>'{}')::numeric)>1.7976931348623157e308::numeric else false end
 );
end $$;
revoke all on function valid_settings_regeneration_asset(jsonb,text,text,text) from public;
grant execute on function valid_settings_regeneration_asset(jsonb,text,text,text) to novel_app;

create function guard_settings_regeneration_version() returns trigger language plpgsql as $$
declare previous jsonb;expected jsonb;active text;parent_origin text;origin jsonb;source_id text;script_id text;plan_id text;knowledge_id text;plan jsonb;authority jsonb;
 task model_tasks;s jsonb;m jsonb;op jsonb;fingerprint text;compact text;key text;scope text;failure_key text;asset_id text;
 asset jsonb;replacement jsonb;failure jsonb;entry jsonb;targets jsonb := '[]';scopes text[] := '{}';ids text[] := '{}';
 assets jsonb;failures jsonb;new_failure jsonb;nonce integer;successes integer := 0;added integer := 0;outcome text;
begin
 if exists(select 1 from settings_candidate_versions where workspace_id=new.workspace_id and project_id=new.project_id and chapter_id=new.chapter_id and id=new.id) then raise exception 'settings version id exists' using errcode='23505'; end if;
 select version_json into origin from settings_candidate_versions where workspace_id=new.workspace_id and project_id=new.project_id and chapter_id=new.chapter_id and id=new.origin_version_id;
 authority := lock_settings_review_authority(new.workspace_id,new.project_id,new.chapter_id);
 source_id := authority->>'sourceId';knowledge_id := authority->>'knowledgeId';plan_id := authority->>'planId';script_id := authority->>'scriptId';
 select version_json into plan from episode_plan_versions where workspace_id=new.workspace_id and project_id=new.project_id and chapter_id=new.chapter_id and id=plan_id;
 if (source_id=origin->>'sourceVersionId' and script_id=origin->>'scriptVersionId' and origin->'upstreamConfirmedVersionIds'=jsonb_build_array(script_id,plan_id,knowledge_id)
   and plan->>'sourceVersionId'=source_id and plan->>'storyBibleVersionId'=knowledge_id and plan->'targetDurationSeconds'=authority->'targetDurationSeconds' and plan->>'aspectRatio'=authority->>'aspectRatio' and plan->>'narrativeMode'=authority->>'narrativeMode') is not true then raise exception 'settings upstream changed' using errcode='P7001'; end if;
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

 if not can_review_project(new.project_id) or new.created_by is distinct from current_app_user_id() then raise exception 'settings regeneration denied' using errcode='42501'; end if;
 m := new.version_json->'regeneration';op := new.version_json->'operation';
 select * into task from model_tasks where workspace_id=new.workspace_id and id=m->>'jobId' for share;
 s := task.payload->'input'->'regeneration';
 if (task.state='running' and task.payload->>'createdBy'=new.created_by and task.payload->>'projectId'=new.project_id and task.payload->>'chapterId'=new.chapter_id
  and valid_settings_regeneration_task(task.payload->'input') and s->>'expectedActiveVersionId'=previous->>'id'
  and task.payload->'input'->>'sourceVersionId'=source_id and task.payload->'input'->'upstreamConfirmedVersionIds'=origin->'upstreamConfirmedVersionIds'
  and task.payload->'input'->'generationParameters'=jsonb_build_object('targetDurationSeconds',authority->'targetDurationSeconds','aspectRatio',authority->'aspectRatio','narrativeMode',authority->'narrativeMode')) is not true then raise exception 'invalid regeneration task binding' using errcode='42501'; end if;
 -- Construct the compact JSON used by the immutable task fingerprint (no database JSON whitespace).
 compact := '{"expectedActiveVersionId":'||(s->'expectedActiveVersionId')::text||',"assetIds":['||coalesce((select string_agg(value::text,',' order by n) from jsonb_array_elements(s->'assetIds') with ordinality a(value,n)),'')||'],"failureScopeKeys":['||coalesce((select string_agg(value::text,',' order by n) from jsonb_array_elements(s->'failureScopeKeys') with ordinality a(value,n)),'')||'],"reason":'||(s->'reason')::text||'}';
 fingerprint := encode(sha256(convert_to(compact,'UTF8')),'hex');
 if (op=jsonb_build_object('requestId','regenerate_'||encode(sha256(convert_to(task.id,'UTF8')),'hex'),'fingerprint',fingerprint,'kind','regenerate','targetId',previous->>'id','reason',s->>'reason')
  and m=jsonb_build_object('jobId',task.id,'fingerprint',fingerprint,'assetIds',s->'assetIds','failureScopeKeys',s->'failureScopeKeys','reason',s->>'reason','outcome',m->>'outcome')
  and m->>'outcome' in ('succeeded','partially_succeeded','failed') and jsonb_typeof(new.version_json->'assets')='array' and jsonb_typeof(new.version_json->'failures')='array') is not true then raise exception 'invalid regeneration metadata' using errcode='42501'; end if;
 -- Resolve only the selected assets/retryable failures, with the same collision-safe response scopes as the runner.
 for entry in select target from (select 0 as group_order,n,jsonb_build_object('assetId',value) as target from jsonb_array_elements(s->'assetIds') with ordinality a(value,n) union all select 1,n,jsonb_build_object('failureScopeKey',value) from jsonb_array_elements(s->'failureScopeKeys') with ordinality a(value,n)) ordered_targets order by group_order,n loop
  asset := null;failure := null;asset_id := entry->>'assetId';failure_key := entry->>'failureScopeKey';
  if asset_id is not null then
   select x into asset from jsonb_array_elements(previous->'assets') x where x->>'id'=asset_id;
   select x into failure from jsonb_array_elements(previous->'failures') x where x->>'assetId'=asset_id limit 1;
   if asset is null then raise exception 'missing regeneration asset' using errcode='42501'; end if;
   failure_key := failure->>'scopeKey';
  else
   select x into failure from jsonb_array_elements(previous->'failures') x where x->>'scopeKey'=failure_key;
   if failure is null or (failure->'retryable'='true'::jsonb) is not true then raise exception 'invalid regeneration failure' using errcode='42501'; end if;
   asset_id := failure->>'assetId';
   if asset_id is not null then
    select x into asset from jsonb_array_elements(previous->'assets') x where x->>'id'=asset_id;
    if asset is null then raise exception 'missing failure asset' using errcode='42501'; end if;
   end if;
  end if;
  if asset_id is not null then
   if asset_id=any(ids) or previous->'locks' ? asset_id or exists(select 1 from jsonb_array_elements(previous->'suggestions') x where x->>'assetId'=asset_id and x->>'status'='pending') then raise exception 'locked or overlapping regeneration target' using errcode='42501'; end if;
   ids := array_append(ids,asset_id);
  end if;
  key := coalesce(failure_key,asset_id);nonce := 0;
  scope := case when failure_key is null then 'asset_' else 'failure_' end||encode(sha256(convert_to(to_jsonb(key)::text,'UTF8')),'hex');
  while scope=any(scopes) or exists(select 1 from jsonb_array_elements(previous->'failures') x where x->>'scopeKey'=scope) loop
   nonce := nonce+1;
   scope := case when failure_key is null then 'asset_' else 'failure_' end||encode(sha256(convert_to('['||to_jsonb(key)::text||','||nonce::text||']','UTF8')),'hex');
  end loop;
  scopes := array_append(scopes,scope);
  targets := targets||jsonb_build_array(jsonb_build_object('asset',asset,'failureScopeKey',failure_key,'scopeKey',scope));
 end loop;
 assets := previous->'assets';failures := previous->'failures';
 for entry in select value from jsonb_array_elements(targets) loop
  asset := nullif(entry->'asset','null'::jsonb);asset_id := asset->>'id';failure_key := entry->>'failureScopeKey';scope := coalesce(failure_key,entry->>'scopeKey');
  select x into new_failure from jsonb_array_elements(new.version_json->'failures') x where x->>'scopeKey'=scope;
  if new_failure is not null then
   if (new_failure->>'code' in ('PROVIDER_ITEM_FAILED','INVALID_ASSET','INVALID_REGENERATION_TARGET') and jsonb_typeof(new_failure->'retryable')='boolean'
     and new_failure=jsonb_build_object('scopeKey',scope,'code',new_failure->>'code','retryable',new_failure->'retryable')||case when asset is null then '{}'::jsonb else jsonb_build_object('assetId',asset_id) end
     and (new_failure->>'code'='PROVIDER_ITEM_FAILED' or new_failure->'retryable'='true'::jsonb)) is not true then raise exception 'invalid regeneration failure result' using errcode='42501'; end if;
   if exists(select 1 from jsonb_array_elements(failures) x where x->>'scopeKey'=scope) then
    select jsonb_agg(case when x->>'scopeKey'=scope then new_failure else x end order by n) into failures from jsonb_array_elements(failures) with ordinality a(x,n);
   else failures := failures||jsonb_build_array(new_failure); end if;
  else
   if asset is not null then
    select x into replacement from jsonb_array_elements(new.version_json->'assets') x where x->>'id'=asset_id;
    if replacement->>'assetType' is distinct from asset->>'assetType' then raise exception 'regeneration asset type changed' using errcode='42501'; end if;
   else
    replacement := new.version_json->'assets'->(jsonb_array_length(previous->'assets')+added);added := added+1;
    if exists(select 1 from jsonb_array_elements(assets) x where x->>'id'=replacement->>'id') then raise exception 'regeneration asset collision' using errcode='42501'; end if;
   end if;
   if valid_settings_regeneration_asset(replacement,new.project_id,new.chapter_id,source_id) is not true then raise exception 'invalid regeneration asset' using errcode='42501'; end if;
   if asset is null then assets := assets||jsonb_build_array(replacement);
   else select jsonb_agg(case when x->>'id'=asset_id then replacement else x end order by n) into assets from jsonb_array_elements(assets) with ordinality a(x,n); end if;
   select coalesce(jsonb_agg(x order by n),'[]'::jsonb) into failures from jsonb_array_elements(failures) with ordinality a(x,n) where (x->>'scopeKey' is distinct from failure_key) and (asset_id is null or x->>'assetId' is distinct from asset_id);
   successes := successes+1;
  end if;
 end loop;
 outcome := case when successes=jsonb_array_length(targets) then 'succeeded' when successes>0 then 'partially_succeeded' else 'failed' end;
 if m->>'outcome' is distinct from outcome then raise exception 'invalid regeneration outcome' using errcode='42501'; end if;
 expected := (previous-array['confirmedBy','confirmedAt'])||jsonb_build_object('status','candidate','assets',assets,'failures',failures,'regeneration',m,'generationStatus',case when jsonb_array_length(failures)=0 then 'succeeded' when jsonb_array_length(assets)>0 then 'partially_succeeded' else 'failed' end);
 if previous->>'status'='confirmed' then expected := expected||jsonb_build_object('revisionOfVersionId',previous->>'id'); end if;
 if (new.version_json-array['id','parentVersionId','createdBy','createdAt','operation']) is distinct from (expected-array['id','parentVersionId','createdBy','createdAt','operation']) then raise exception 'regeneration scope changed' using errcode='42501'; end if;
 return new;
end $$;
create trigger settings_regeneration_transition before insert on settings_review_versions for each row
 when (new.version_json->'operation'->>'kind'='regenerate') execute function guard_settings_regeneration_version();
