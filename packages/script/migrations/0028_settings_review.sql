-- Trusted-owner migration. Generation rows remain unchanged and independently recoverable.
create table settings_review_versions (
 workspace_id text not null,project_id text not null,chapter_id text not null,id text not null,
 origin_version_id text not null,parent_review_id text,created_by text not null,version_json jsonb not null,
 primary key(workspace_id,project_id,chapter_id,id),
 foreign key(workspace_id,project_id,chapter_id,origin_version_id) references settings_candidate_versions(workspace_id,project_id,chapter_id,id),
 foreign key(workspace_id,project_id,chapter_id,parent_review_id) references settings_review_versions(workspace_id,project_id,chapter_id,id),
 check ((jsonb_typeof(version_json->'id')='string' and jsonb_typeof(version_json->'parentVersionId')='string' and jsonb_typeof(version_json->'createdBy')='string' and version_json->>'id'=id and version_json->>'projectId'=project_id and version_json->>'chapterId'=chapter_id
  and version_json->>'createdBy'=created_by and version_json->>'parentVersionId'=coalesce(parent_review_id,origin_version_id)
  and version_json->>'status' in ('candidate','confirmed') and jsonb_typeof(version_json->'createdAt')='string' and length(version_json->>'createdAt') between 1 and 64
  and jsonb_typeof(version_json->'operation')='object' and version_json->'operation' ?& array['requestId','fingerprint','kind','targetId','reason']
  and (version_json->'operation')-array['requestId','fingerprint','kind','targetId','reason']='{}'::jsonb
  and jsonb_typeof(version_json->'operation'->'requestId')='string' and jsonb_typeof(version_json->'operation'->'fingerprint')='string'
  and jsonb_typeof(version_json->'operation'->'kind')='string' and jsonb_typeof(version_json->'operation'->'targetId')='string' and jsonb_typeof(version_json->'operation'->'reason')='string'
  and length(version_json->'operation'->>'requestId') between 1 and 256
  and version_json->'operation'->>'requestId' !~ E'[\r\n]'
  and version_json->'operation'->>'fingerprint' ~ '^[a-f0-9]{64}$'
  and version_json->'operation'->>'kind' in ('edit','suggest','decide','confirm','lock','unlock')
  and length(version_json->'operation'->>'targetId') between 1 and 256
  and length(version_json->'operation'->>'reason') between 1 and 2000 and length(btrim(version_json->'operation'->>'reason'))>0
  and jsonb_typeof(version_json->'suggestions')='array' and jsonb_typeof(version_json->'locks')='object') is true)
);
create unique index settings_review_request_idx on settings_review_versions(workspace_id,project_id,chapter_id,created_by,(version_json->'operation'->>'requestId'));
create table settings_review_heads (
 workspace_id text not null,project_id text not null,chapter_id text not null,active_version_id text not null,confirmed_version_id text,
 primary key(workspace_id,project_id,chapter_id),
 foreign key(workspace_id,project_id,chapter_id,active_version_id) references settings_review_versions(workspace_id,project_id,chapter_id,id),
 foreign key(workspace_id,project_id,chapter_id,confirmed_version_id) references settings_review_versions(workspace_id,project_id,chapter_id,id)
);
alter table settings_review_versions enable row level security;
alter table settings_review_versions force row level security;
alter table settings_review_heads enable row level security;
alter table settings_review_heads force row level security;
create policy settings_review_read on settings_review_versions for select using(workspace_id=current_app_workspace_id() and can_access_project(project_id));
create policy settings_review_insert on settings_review_versions for insert with check(workspace_id=current_app_workspace_id() and can_access_project(project_id) and created_by=current_app_user_id() and (version_json->'operation'->>'kind'='suggest' or can_review_project(project_id)));
create policy settings_review_heads_read on settings_review_heads for select using(workspace_id=current_app_workspace_id() and can_access_project(project_id));
create policy settings_review_heads_insert on settings_review_heads for insert with check(workspace_id=current_app_workspace_id() and can_access_project(project_id));
create policy settings_review_heads_update on settings_review_heads for update using(workspace_id=current_app_workspace_id() and can_access_project(project_id)) with check(workspace_id=current_app_workspace_id() and can_access_project(project_id));
create trigger settings_review_immutable before update or delete on settings_review_versions for each row execute function reject_immutable_change();
revoke all on settings_review_versions,settings_review_heads from public,novel_app;
grant select,insert on settings_review_versions,settings_review_heads to novel_app;
grant update(active_version_id) on settings_review_heads to novel_app;

create function valid_settings_review_asset(a jsonb,p text,c text,s text) returns boolean language plpgsql stable as $$
begin
 if (jsonb_typeof(a)='object' and a ?& array['id','assetType','name','visibleDefinition','state','stateChanges','restrictions','provenance']
  and a - array['id','assetType','name','visibleDefinition','state','stateChanges','restrictions','provenance']='{}'::jsonb
  and jsonb_typeof(a->'id')='string' and length(btrim(a->>'id')) between 1 and 256 and a->>'id' !~ E'[\r\n]'
  and a->>'assetType' in ('character','location','prop','visualStyle') and jsonb_typeof(a->'name')='string' and length(btrim(a->>'name')) between 1 and 20000
  and jsonb_typeof(a->'visibleDefinition')='object' and a->'visibleDefinition'<>'{}'::jsonb and jsonb_typeof(a->'state')='string'
  and jsonb_typeof(a->'stateChanges')='array' and jsonb_typeof(a->'restrictions')='array' and jsonb_typeof(a->'provenance')='array') is not true then return false; end if;
 if jsonb_array_length(a->'provenance')=0
  or exists(select 1 from jsonb_array_elements((a->'stateChanges')||(a->'restrictions')) x where jsonb_typeof(x)<>'string')
  or exists(select 1 from jsonb_array_elements(a->'provenance') x where
   (jsonb_typeof(x->'sourceVersionId')='string' and jsonb_typeof(x->'fragmentId')='string' and x->>'type'='source_fragment' and x->>'sourceVersionId'=s and x ?& array['type','sourceVersionId','fragmentId','transformation']
    and x-array['type','sourceVersionId','fragmentId','transformation']='{}'::jsonb
    and x->>'transformation' in ('retained','compressed','merged','visualized','actionized','narrated','sonified')
    and exists(select 1 from source_version_fragments f where f.project_id=p and f.chapter_id=c and f.source_version_id=s and f.fragment_id=x->>'fragmentId')) is not true)
 then return false; end if;
 return true;
end $$;

-- Membership-checked lock helper: reviewers may review without chapter-import UPDATE permission.
create function lock_settings_review_authority(w text,p text,c text) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare project projects;source_id text;knowledge_id text;plan_id text;script_id text;
begin
 if w is distinct from current_app_workspace_id() or not can_access_project(p) then raise exception 'settings access denied' using errcode='42501'; end if;
 select * into project from projects where workspace_id=w and id=p for share;
 if project.id is null then raise exception 'settings project missing' using errcode='42501'; end if;
 select active_source_version_id into source_id from chapters where project_id=p and id=c for update;
 select confirmed_version_id into knowledge_id from story_knowledge_heads where workspace_id=w and project_id=p and chapter_id=c for share;
 select confirmed_version_id into plan_id from episode_plan_heads where workspace_id=w and project_id=p and chapter_id=c for share;
 select confirmed_version_id into script_id from script_content_heads where workspace_id=w and project_id=p and chapter_id=c for share;
 return jsonb_build_object('sourceId',source_id,'knowledgeId',knowledge_id,'planId',plan_id,'scriptId',script_id,'targetDurationSeconds',project.target_duration_seconds,'aspectRatio',project.aspect_ratio,'narrativeMode',project.narrative_mode);
end $$;
revoke all on function lock_settings_review_authority(text,text,text) from public;
grant execute on function lock_settings_review_authority(text,text,text) to novel_app;

create function guard_settings_review_version() returns trigger language plpgsql as $$
declare previous jsonb;expected jsonb;kind text;target text;asset jsonb;replacement jsonb;suggestion jsonb;changed jsonb;base jsonb;active text;parent_origin text;origin jsonb;source_id text;script_id text;plan_id text;knowledge_id text;plan jsonb;authority jsonb;
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
 kind := new.version_json->'operation'->>'kind';target := new.version_json->'operation'->>'targetId';expected := previous;
 select x into asset from jsonb_array_elements(previous->'assets') x where x->>'id'=target;
 if kind='confirm' then
  if previous->>'status'<>'candidate' or previous->>'generationStatus'<>'succeeded' or jsonb_array_length(previous->'assets')=0 or jsonb_array_length(previous->'failures')<>0 or target<>previous->>'id'
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
create trigger settings_review_transition before insert on settings_review_versions for each row execute function guard_settings_review_version();
create function guard_settings_review_head() returns trigger language plpgsql as $$
declare v settings_review_versions;
begin
 select * into v from settings_review_versions where workspace_id=new.workspace_id and project_id=new.project_id and chapter_id=new.chapter_id and id=new.active_version_id;
 if v.id is null or (TG_OP='INSERT' and v.parent_review_id is not null) or (TG_OP='UPDATE' and v.parent_review_id is distinct from old.active_version_id) then raise exception 'invalid settings head' using errcode='42501'; end if;
 new.confirmed_version_id := case when v.version_json->>'status'='confirmed' then v.id when TG_OP='UPDATE' then old.confirmed_version_id else null end;
 return new;
end $$;
create trigger settings_review_head_transition before insert or update on settings_review_heads for each row execute function guard_settings_review_head();
create policy script_settings_review_dependencies_insert on script_downstream_dependencies for insert with check(
 workspace_id=current_app_workspace_id() and can_access_project(project_id) and target_stage='settings'
 and exists(select 1 from settings_review_versions r join settings_candidate_versions s on s.workspace_id=r.workspace_id and s.project_id=r.project_id and s.chapter_id=r.chapter_id and s.id=r.origin_version_id
   join script_content_versions v on v.workspace_id=s.workspace_id and v.project_id=s.project_id and v.chapter_id=s.chapter_id and v.id=s.script_version_id
   cross join lateral jsonb_array_elements(r.version_json->'assets') asset cross join lateral jsonb_array_elements(v.version_json->'elements') element
   cross join lateral jsonb_array_elements(asset->'provenance') ap cross join lateral jsonb_array_elements(element->'provenance') ep
   where r.workspace_id=script_downstream_dependencies.workspace_id and r.project_id=script_downstream_dependencies.project_id and r.chapter_id=script_downstream_dependencies.chapter_id
    and r.id=target_version_id and s.script_version_id=script_downstream_dependencies.script_version_id and r.created_by=current_app_user_id()
    and asset->>'id'=target_item_id and element->>'id'=script_element_id and ap->>'type'='source_fragment' and ep->>'type'='source_fragment'
    and ap->>'sourceVersionId'=ep->>'sourceVersionId' and ap->>'fragmentId'=ep->>'fragmentId')
);
