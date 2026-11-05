-- Trusted owner only. Keep the running-task binding and verify the pending-target merge.
create function guard_settings_pending_regeneration_version() returns trigger language plpgsql as $$
declare previous jsonb;expected jsonb;active text;parent_origin text;origin jsonb;source_id text;script_id text;plan_id text;knowledge_id text;plan jsonb;authority jsonb;
 task model_tasks;s jsonb;m jsonb;op jsonb;fingerprint text;compact text;key text;scope text;failure_key text;asset_id text;
 asset jsonb;replacement jsonb;failure jsonb;entry jsonb;targets jsonb := '[]';scopes text[] := '{}';ids text[] := '{}';
 assets jsonb;failures jsonb;pending jsonb;selectable jsonb;reconciling boolean;new_failure jsonb;nonce integer;successes integer := 0;outcome text;
begin
 if exists(select 1 from settings_candidate_versions where workspace_id=new.workspace_id and project_id=new.project_id and chapter_id=new.chapter_id and id=new.id) then raise exception 'settings version id exists' using errcode='23505'; end if;
 select version_json into origin from settings_candidate_versions where workspace_id=new.workspace_id and project_id=new.project_id and chapter_id=new.chapter_id and id=new.origin_version_id;
 if new.version_json ? 'reconciliation' then origin := new.version_json; end if;
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

 pending := previous->'reconciliation';
 reconciling := coalesce(jsonb_array_length(pending->'pendingAssets'),0)>0 or coalesce(jsonb_array_length(pending->'pendingFailureScopeKeys'),0)>0;
 selectable := case when reconciling then pending->'pendingAssets' else previous->'assets' end;
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
   select x into asset from jsonb_array_elements(selectable) x where x->>'id'=asset_id;
   select x into failure from jsonb_array_elements(previous->'failures') x where x->>'assetId'=asset_id limit 1;
   if asset is null then raise exception 'missing regeneration asset' using errcode='42501'; end if;
   failure_key := case when reconciling then null else failure->>'scopeKey' end;
  else
   select x into failure from jsonb_array_elements(previous->'failures') x where x->>'scopeKey'=failure_key;
   if failure is null or (failure->'retryable'='true'::jsonb) is not true or (reconciling and not (pending->'pendingFailureScopeKeys' ? failure_key)) then raise exception 'invalid regeneration failure' using errcode='42501'; end if;
   asset_id := failure->>'assetId';
   if asset_id is not null then
    select x into asset from jsonb_array_elements(selectable||(case when reconciling then previous->'assets' else '[]'::jsonb end)) x where x->>'id'=asset_id;
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
  -- Failed pending targets keep the original snapshot and failure state.
  if reconciling and ((failure_key is not null and new_failure is not null)
    or (failure_key is null and not exists(select 1 from jsonb_array_elements(new.version_json->'assets') x where x->>'id'=asset_id))) then
   continue;
  end if;
  if not reconciling and new_failure is not null then
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
    replacement := new.version_json->'assets'->jsonb_array_length(assets);
    if exists(select 1 from jsonb_array_elements(assets||coalesce(pending->'pendingAssets','[]'::jsonb)) x where x->>'id'=replacement->>'id') then raise exception 'regeneration asset collision' using errcode='42501'; end if;
   end if;
   if valid_settings_regeneration_asset(replacement,new.project_id,new.chapter_id,source_id) is not true then raise exception 'invalid regeneration asset' using errcode='42501'; end if;
   if asset is null or not exists(select 1 from jsonb_array_elements(assets) x where x->>'id'=asset_id) then assets := assets||jsonb_build_array(replacement);
   elsif not reconciling then select jsonb_agg(case when x->>'id'=asset_id then replacement else x end order by n) into assets from jsonb_array_elements(assets) with ordinality a(x,n); end if;
   select coalesce(jsonb_agg(x order by n),'[]'::jsonb) into failures from jsonb_array_elements(failures) with ordinality a(x,n) where (x->>'scopeKey' is distinct from failure_key) and (reconciling or asset_id is null or x->>'assetId' is distinct from asset_id);
   if pending is not null then
    pending := jsonb_set(pending,'{pendingAssets}',(select coalesce(jsonb_agg(x order by n),'[]'::jsonb) from jsonb_array_elements(pending->'pendingAssets') with ordinality a(x,n) where x->>'id'<>replacement->>'id'));
    pending := jsonb_set(pending,'{pendingFailureScopeKeys}',(select coalesce(jsonb_agg(x order by n),'[]'::jsonb) from jsonb_array_elements(pending->'pendingFailureScopeKeys') with ordinality a(x,n)
     where exists(select 1 from jsonb_array_elements(failures) f where f->'scopeKey'=x)));
   end if;
   successes := successes+1;
  end if;
 end loop;
 outcome := case when successes=jsonb_array_length(targets) then 'succeeded' when successes>0 then 'partially_succeeded' else 'failed' end;
 if m->>'outcome' is distinct from outcome then raise exception 'invalid regeneration outcome' using errcode='42501'; end if;
 expected := (previous-array['confirmedBy','confirmedAt'])||jsonb_build_object('status','candidate','assets',assets,'failures',failures,'regeneration',m,'generationStatus',case when jsonb_array_length(failures)=0 then 'succeeded' when jsonb_array_length(assets)>0 then 'partially_succeeded' else 'failed' end);
 if pending is not null then expected := jsonb_set(expected,'{reconciliation}',pending); end if;
 if previous->>'status'='confirmed' then expected := expected||jsonb_build_object('revisionOfVersionId',previous->>'id'); end if;
 if (new.version_json-array['id','parentVersionId','createdBy','createdAt','operation']) is distinct from (expected-array['id','parentVersionId','createdBy','createdAt','operation']) then raise exception 'regeneration scope changed' using errcode='42501'; end if;
 return new;
end $$;

drop trigger settings_regeneration_transition on settings_review_versions;
create trigger settings_regeneration_transition before insert on settings_review_versions for each row
 when (new.version_json->'operation'->>'kind'='regenerate') execute function guard_settings_pending_regeneration_version();
drop function guard_settings_regeneration_version();

-- Confirmation sees unresolved jobs on the current reconciliation chain across sessions.
create function guard_settings_reconciliation_confirmation() returns trigger language plpgsql
 set search_path = public, pg_temp set app.model_workspace_id = '' as $$
begin
 if new.version_json->'operation'->>'kind' is distinct from 'confirm' or not (new.version_json ? 'reconciliation') then return new; end if;
 perform set_config('app.model_workspace_id',new.workspace_id,true);
 if exists (
  select 1 from model_tasks t
  join settings_review_versions v on v.workspace_id=t.workspace_id
   and v.project_id=t.payload->>'projectId' and v.chapter_id=t.payload->>'chapterId'
   and v.id=t.payload->'input'->'regeneration'->>'expectedActiveVersionId'
  where t.workspace_id=new.workspace_id and v.project_id=new.project_id and v.chapter_id=new.chapter_id
   and t.payload->>'projectId'=new.project_id and t.payload->>'chapterId'=new.chapter_id
   and t.payload->'input'->>'stage'='settings' and t.payload->'input'->>'resultType'='settingsRegeneration'
   and (t.state in ('queued','running') or t.state='paused' and t.reason='EXECUTION_UNCERTAIN')
   and v.version_json->'reconciliation'->>'originVersionId'=new.version_json->'reconciliation'->>'originVersionId'
 ) then raise exception 'settings regeneration still unresolved' using errcode='P7002'; end if;
 return new;
end $$;
create trigger settings_review_unknown_regeneration before insert on settings_review_versions for each row
 execute function guard_settings_reconciliation_confirmation();

-- Use the same chapter lock as confirmation, then recheck the pending baseline.
create function guard_settings_reconciliation_enqueue() returns trigger language plpgsql
 set search_path = public, pg_temp set app.current_user_id = '' set app.current_workspace_id = '' as $$
declare p text;c text;base_id text;reconciliation jsonb;active text;
begin
 if new.payload->'input'->>'resultType' is distinct from 'settingsRegeneration' then return new; end if;
 p := new.payload->>'projectId';c := new.payload->>'chapterId';
 base_id := new.payload->'input'->'regeneration'->>'expectedActiveVersionId';
 perform set_config('app.current_user_id',new.payload->>'createdBy',true);
 perform set_config('app.current_workspace_id',new.workspace_id,true);
 select version_json->'reconciliation' into reconciliation from settings_review_versions
 where workspace_id=new.workspace_id and project_id=p and chapter_id=c and id=base_id;
 if reconciliation is null then return new; end if;
 perform lock_settings_review_authority(new.workspace_id,p,c);
 select active_version_id into active from settings_review_heads where workspace_id=new.workspace_id and project_id=p and chapter_id=c;
 if active is distinct from base_id or not can_review_project(p) then raise exception 'settings regeneration baseline changed'; end if;
 return new;
end $$;
create trigger model_00_settings_reconciliation_enqueue before insert on model_tasks for each row execute function guard_settings_reconciliation_enqueue();
