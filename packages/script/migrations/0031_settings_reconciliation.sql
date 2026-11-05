create or replace function lock_settings_review_authority(w text,p text,c text) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare project projects;source_id text;knowledge_id text;plan_id text;script_id text;
begin
 if w is distinct from current_app_workspace_id() or not can_access_project(p) then raise exception 'settings access denied' using errcode='42501'; end if;
 select * into project from projects where workspace_id=w and id=p for share;
 if project.id is null then raise exception 'settings project missing' using errcode='42501'; end if;
 perform 1 from project_members where workspace_id=w and project_id=p and user_id=current_app_user_id() for share;
 if not found then raise exception 'settings membership missing' using errcode='42501'; end if;
 select active_source_version_id into source_id from chapters where project_id=p and id=c for update;
 select confirmed_version_id into knowledge_id from story_knowledge_heads where workspace_id=w and project_id=p and chapter_id=c for share;
 select confirmed_version_id into plan_id from episode_plan_heads where workspace_id=w and project_id=p and chapter_id=c for share;
 select confirmed_version_id into script_id from script_content_heads where workspace_id=w and project_id=p and chapter_id=c for share;
 return jsonb_build_object('sourceId',source_id,'knowledgeId',knowledge_id,'planId',plan_id,'scriptId',script_id,'targetDurationSeconds',project.target_duration_seconds,'aspectRatio',project.aspect_ratio,'narrativeMode',project.narrative_mode);
end $$;
-- Trusted-owner migration. Cross-upstream changes use an explicit transition; old operations retain exact reconstruction.
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
  and version_json->'operation'->>'kind' in ('edit','suggest','decide','confirm','lock','unlock','regenerate','reconcile','retain')
  and length(version_json->'operation'->>'targetId') between 1 and 256
  and length(version_json->'operation'->>'reason') between 1 and 2000 and length(btrim(version_json->'operation'->>'reason'))>0
  and jsonb_typeof(version_json->'suggestions')='array' and jsonb_typeof(version_json->'locks')='object') is true);
create or replace function guard_settings_review_version() returns trigger language plpgsql as $$
declare previous jsonb;expected jsonb;kind text;target text;asset jsonb;replacement jsonb;suggestion jsonb;changed jsonb;base jsonb;active text;parent_origin text;origin jsonb;source_id text;script_id text;plan_id text;knowledge_id text;plan jsonb;authority jsonb;
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
 kind := new.version_json->'operation'->>'kind';target := new.version_json->'operation'->>'targetId';expected := previous;
 select x into asset from jsonb_array_elements(previous->'assets') x where x->>'id'=target;
 if kind='confirm' then
  if coalesce(jsonb_array_length(previous->'reconciliation'->'pendingAssets'),0)>0 or coalesce(jsonb_array_length(previous->'reconciliation'->'pendingFailureScopeKeys'),0)>0 or previous->>'status'<>'candidate' or previous->>'generationStatus'<>'succeeded' or jsonb_array_length(previous->'assets')=0 or jsonb_array_length(previous->'failures')<>0 or target<>previous->>'id'
   or (select count(*)<>count(distinct a->>'id') from jsonb_array_elements(previous->'assets') a)
   or exists(select 1 from jsonb_array_elements(previous->'assets') a where not valid_settings_review_asset(a,new.project_id,new.chapter_id,previous->>'sourceVersionId'))
   or exists(select 1 from jsonb_array_elements(previous->'suggestions') s where s->>'status'='pending') then raise exception 'invalid settings confirmation' using errcode='42501'; end if;
  expected := expected || jsonb_build_object('status','confirmed','confirmedBy',new.created_by,'confirmedAt',new.version_json->>'createdAt');
 elsif kind in ('lock','unlock') then
  if previous->>'status'<>'confirmed' or asset is null or (kind='lock' and previous->'locks' ? target) or (kind='unlock' and not (previous->'locks' ? target)) then raise exception 'invalid settings lock' using errcode='42501'; end if;
  if kind='lock' then expected := jsonb_set(expected,array['locks'],(previous->'locks')||jsonb_build_object(target,jsonb_build_object('lockedBy',new.created_by,'lockedAt',new.version_json->>'createdAt')));
  else expected := jsonb_set(expected,array['locks'],(previous->'locks')-target); end if;
 elsif kind in ('edit','suggest') then
  if asset is null or previous->'locks' ? target or (kind='edit' and previous->>'status'<>'candidate') then raise exception 'invalid settings target' using errcode='42501'; end if;
  if kind='edit' then
   select x into replacement from jsonb_array_elements(new.version_json->'assets') x where x->>'id'=target;
   expected := jsonb_set(expected,array['assets'],(select jsonb_agg(case when x->>'id'=target then replacement else x end order by n) from jsonb_array_elements(previous->'assets') with ordinality t(x,n)));
  else
   suggestion := new.version_json->'suggestions'->-1;replacement := suggestion->'value';
   if (suggestion - array['id','baseAssetHash','value']) is distinct from jsonb_build_object('assetId',target,'baseVersionId',previous->>'id','reason',new.version_json->'operation'->>'reason','submittedBy',new.created_by,'submittedAt',new.version_json->>'createdAt','status','pending')
    or (jsonb_typeof(suggestion->'id')='string' and length(btrim(suggestion->>'id')) between 1 and 256 and suggestion->>'id' !~ E'[\r\n]' and jsonb_typeof(suggestion->'baseAssetHash')='string' and suggestion->>'baseAssetHash' ~ '^[a-f0-9]{64}$') is not true
    or exists(select 1 from jsonb_array_elements(previous->'suggestions') s where s->>'id'=suggestion->>'id') then raise exception 'invalid settings suggestion' using errcode='42501'; end if;
   expected := jsonb_set(expected,array['suggestions'],(previous->'suggestions')||jsonb_build_array(suggestion));
  end if;
  if not valid_settings_review_asset(replacement,new.project_id,new.chapter_id,previous->>'sourceVersionId') or replacement->>'id' is distinct from target or replacement->>'assetType' is distinct from asset->>'assetType' then raise exception 'invalid settings asset' using errcode='42501'; end if;
 elsif kind='decide' then
  select s into suggestion from jsonb_array_elements(previous->'suggestions') s where s->>'id'=target;
  select s into changed from jsonb_array_elements(new.version_json->'suggestions') s where s->>'id'=target;
  if suggestion is null or suggestion->>'status'<>'pending' or changed is null or (changed->>'status' in ('accepted','rejected')) is not true then raise exception 'invalid settings decision' using errcode='42501'; end if;
  if changed is distinct from (suggestion||jsonb_build_object('status',changed->>'status','decidedBy',new.created_by,'decidedAt',new.version_json->>'createdAt','decisionReason',new.version_json->'operation'->>'reason')) then raise exception 'invalid decision audit' using errcode='42501'; end if;
  if changed->>'status'='accepted' then
   if previous->'locks' ? (suggestion->>'assetId') then raise exception 'settings locked' using errcode='42501'; end if;
   select version_json into base from settings_review_versions where workspace_id=new.workspace_id and project_id=new.project_id and chapter_id=new.chapter_id and id=suggestion->>'baseVersionId';
   if base is null then select version_json into base from settings_candidate_versions where workspace_id=new.workspace_id and project_id=new.project_id and chapter_id=new.chapter_id and id=suggestion->>'baseVersionId'; end if;
   if (select x from jsonb_array_elements(previous->'assets') x where x->>'id'=suggestion->>'assetId') is distinct from (select x from jsonb_array_elements(base->'assets') x where x->>'id'=suggestion->>'assetId') then raise exception 'stale settings suggestion' using errcode='42501'; end if;
   expected := jsonb_set(expected,array['assets'],(select jsonb_agg(case when x->>'id'=suggestion->>'assetId' then suggestion->'value' else x end order by n) from jsonb_array_elements(previous->'assets') with ordinality t(x,n)));
   if previous->>'status'='confirmed' then expected := (expected - array['confirmedBy','confirmedAt'])||jsonb_build_object('status','candidate','revisionOfVersionId',previous->>'id'); end if;
  end if;
  expected := jsonb_set(expected,array['suggestions'],(select jsonb_agg(case when x->>'id'=target then changed else x end order by n) from jsonb_array_elements(previous->'suggestions') with ordinality t(x,n)));
 else raise exception 'invalid settings operation' using errcode='42501'; end if;
 if (new.version_json-array['id','parentVersionId','createdBy','createdAt','operation']) is distinct from (expected-array['id','parentVersionId','createdBy','createdAt','operation']) then raise exception 'settings scope changed' using errcode='42501'; end if;
 return new;
end $$;
create or replace function guard_settings_regeneration_version() returns trigger language plpgsql as $$
declare previous jsonb;expected jsonb;active text;parent_origin text;origin jsonb;source_id text;script_id text;plan_id text;knowledge_id text;plan jsonb;authority jsonb;
 task model_tasks;s jsonb;m jsonb;op jsonb;fingerprint text;compact text;key text;scope text;failure_key text;asset_id text;
 asset jsonb;replacement jsonb;failure jsonb;entry jsonb;targets jsonb := '[]';scopes text[] := '{}';ids text[] := '{}';
 assets jsonb;failures jsonb;new_failure jsonb;nonce integer;successes integer := 0;added integer := 0;outcome text;
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

 if coalesce(jsonb_array_length(previous->'reconciliation'->'pendingAssets'),0)>0 or coalesce(jsonb_array_length(previous->'reconciliation'->'pendingFailureScopeKeys'),0)>0 then raise exception 'pending settings reconciliation' using errcode='42501'; end if;
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

drop trigger settings_review_transition on settings_review_versions;
create trigger settings_review_transition before insert on settings_review_versions for each row
 when (new.version_json->'operation'->>'kind' not in ('regenerate','reconcile','retain')) execute function guard_settings_review_version();

create function guard_settings_reconciliation_version() returns trigger language plpgsql as $$
declare previous jsonb;expected jsonb;active text;parent_origin text;origin jsonb;source_id text;script_id text;plan_id text;knowledge_id text;plan jsonb;authority jsonb;
 kind text;target text;asset jsonb;pending jsonb;
begin
 if exists(select 1 from settings_candidate_versions where workspace_id=new.workspace_id and project_id=new.project_id and chapter_id=new.chapter_id and id=new.id) then raise exception 'settings version id exists' using errcode='23505'; end if;
 select version_json into origin from settings_candidate_versions where workspace_id=new.workspace_id and project_id=new.project_id and chapter_id=new.chapter_id and id=new.origin_version_id;
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
 if previous->>'sourceVersionId' is distinct from source_id then raise exception 'source reconciliation not allowed' using errcode='P7001'; end if;
 if kind='reconcile' then
  if previous->'upstreamConfirmedVersionIds'=new.version_json->'upstreamConfirmedVersionIds' or target is distinct from previous->>'id' then raise exception 'unchanged reconciliation authority' using errcode='42501'; end if;
  pending := (previous->'assets')||coalesce(previous->'reconciliation'->'pendingAssets','[]'::jsonb);
  if (select count(*)<>count(distinct a->>'id') from jsonb_array_elements(pending) a) then raise exception 'duplicate pending asset' using errcode='42501'; end if;
  expected := (expected-array['confirmedBy','confirmedAt','regeneration'])||jsonb_build_object('status','candidate','assets','[]'::jsonb,'suggestions','[]'::jsonb,'scriptVersionId',script_id,'upstreamConfirmedVersionIds',jsonb_build_array(script_id,plan_id,knowledge_id),
   'reconciliation',jsonb_build_object('originVersionId',previous->>'id','pendingAssets',pending,'pendingFailureScopeKeys',(select coalesce(jsonb_agg(f->'scopeKey' order by n),'[]'::jsonb) from jsonb_array_elements(previous->'failures') with ordinality a(f,n))));
  if previous->>'status'='confirmed' then expected := expected||jsonb_build_object('revisionOfVersionId',previous->>'id'); end if;
 elsif kind='retain' then
  if previous->>'status'<>'candidate' or previous->'upstreamConfirmedVersionIds' is distinct from new.version_json->'upstreamConfirmedVersionIds' then raise exception 'invalid retain authority' using errcode='42501'; end if;
  select a into asset from jsonb_array_elements(previous->'reconciliation'->'pendingAssets') a where a->>'id'=target;
  if asset is null or valid_settings_regeneration_asset(asset,new.project_id,new.chapter_id,source_id) is not true then raise exception 'invalid retained evidence' using errcode='42501'; end if;
  expected := jsonb_set(expected,'{assets}',(previous->'assets')||jsonb_build_array(asset));
  expected := jsonb_set(expected,'{reconciliation,pendingAssets}',(select coalesce(jsonb_agg(a order by n),'[]'::jsonb) from jsonb_array_elements(previous->'reconciliation'->'pendingAssets') with ordinality t(a,n) where a->>'id'<>target));
 else raise exception 'invalid reconciliation transition' using errcode='42501'; end if;
 if (new.version_json-array['id','parentVersionId','createdBy','createdAt','operation']) is distinct from (expected-array['id','parentVersionId','createdBy','createdAt','operation']) then raise exception 'reconciliation scope changed' using errcode='42501'; end if;
 return new;
end $$;
create trigger settings_reconciliation_transition before insert on settings_review_versions for each row
 when (new.version_json->'operation'->>'kind' in ('reconcile','retain')) execute function guard_settings_reconciliation_version();

create policy script_settings_reconciliation_dependencies_insert on script_downstream_dependencies for insert with check(
 workspace_id=current_app_workspace_id() and can_access_project(project_id) and target_stage='settings'
 and exists(select 1 from settings_review_versions r join script_content_versions v on v.workspace_id=r.workspace_id and v.project_id=r.project_id and v.chapter_id=r.chapter_id and v.id=r.version_json->>'scriptVersionId'
  cross join lateral jsonb_array_elements(r.version_json->'assets') asset cross join lateral jsonb_array_elements(v.version_json->'elements') element
  cross join lateral jsonb_array_elements(asset->'provenance') ap cross join lateral jsonb_array_elements(element->'provenance') ep
  where r.workspace_id=script_downstream_dependencies.workspace_id and r.project_id=script_downstream_dependencies.project_id and r.chapter_id=script_downstream_dependencies.chapter_id
   and r.id=target_version_id and r.version_json ? 'reconciliation' and r.version_json->>'scriptVersionId'=script_downstream_dependencies.script_version_id and r.created_by=current_app_user_id()
   and asset->>'id'=target_item_id and element->>'id'=script_element_id and ap->>'type'='source_fragment' and ep->>'type'='source_fragment'
   and ap->>'sourceVersionId'=ep->>'sourceVersionId' and ap->>'fragmentId'=ep->>'fragmentId')
);
