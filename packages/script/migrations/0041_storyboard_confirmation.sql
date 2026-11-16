alter table storyboard_review_operations add column publication_id bigint;
create sequence storyboard_publication_id_seq;
revoke all on sequence storyboard_publication_id_seq from public,novel_app;
grant usage on sequence storyboard_publication_id_seq to novel_app;
create unique index storyboard_publication_id_idx on storyboard_review_operations(publication_id) where publication_id is not null;
create index storyboard_formal_chapter_idx on storyboard_review_operations(workspace_id,project_id,chapter_id,publication_id desc)
 where publication_id is not null;

create or replace function guard_storyboard_review_operation() returns trigger language plpgsql set search_path=public,pg_temp as $$
declare cmd jsonb:=new.command; kind text:=cmd->>'kind'; v jsonb; authority jsonb; settings_id text;
 previous storyboard_review_operations; suggestion storyboard_review_operations; latest integer;
 formal storyboard_review_operations; plan jsonb; script jsonb; target numeric; locked boolean;
begin
 if new.workspace_id is distinct from current_app_workspace_id() or new.actor_id is distinct from current_app_user_id()
  or not can_access_project(new.project_id) then raise exception 'review denied' using errcode='42501'; end if;
 if (kind in ('edit','suggest','decide','lock','unlock','confirm') and jsonb_typeof(cmd->'requestId')='string'
  and length(cmd->>'requestId') between 1 and 256 and btrim(cmd->>'requestId')<>'' and cmd->>'requestId' !~ E'[\r\n]'
  and jsonb_typeof(cmd->'reason')='string' and length(cmd->>'reason') between 1 and 2000 and btrim(cmd->>'reason')<>''
  and jsonb_typeof(cmd->'expectedRevision')='number') is not true then raise exception 'invalid review command' using errcode='P7002'; end if;
 authority := lock_settings_review_authority(new.workspace_id,new.project_id,new.chapter_id);
 if kind<>'suggest' and not can_review_project(new.project_id) then raise exception 'review denied' using errcode='42501'; end if;
 select c.version_json into v from storyboard_review_submissions r
  join storyboard_candidate_versions c using(workspace_id,project_id,chapter_id,job_id)
  where (r.workspace_id,r.project_id,r.chapter_id,r.id)=(new.workspace_id,new.project_id,new.chapter_id,new.review_id);
 if v is null then raise exception 'review missing' using errcode='P7005'; end if;

 select * into previous from storyboard_review_operations o
  where (o.workspace_id,o.project_id,o.chapter_id,o.review_id,o.actor_id)=(new.workspace_id,new.project_id,new.chapter_id,new.review_id,new.actor_id)
    and o.command->>'requestId'=cmd->>'requestId';
 if found then
  if previous.command=cmd then return null; end if;
  raise exception 'review request conflict' using errcode='P7004';
 end if;

 if kind in ('confirm','lock','unlock') then
  select * into formal from storyboard_review_operations o
   where (o.workspace_id,o.project_id,o.chapter_id)=(new.workspace_id,new.project_id,new.chapter_id)
     and o.publication_id is not null order by o.publication_id desc limit 1;
 end if;

 select confirmed_version_id into settings_id from settings_review_heads
  where (workspace_id,project_id,chapter_id)=(new.workspace_id,new.project_id,new.chapter_id) for share;
 if kind<>'unlock' and (authority->>'sourceId' is distinct from v->>'sourceVersionId' or settings_id is null
  or v->'upstreamConfirmedVersionIds' is distinct from jsonb_build_array(authority->>'scriptId',settings_id,authority->>'planId',authority->>'knowledgeId')
  or not exists(select 1 from episode_plan_versions p where (p.workspace_id,p.project_id,p.chapter_id,p.id)=(new.workspace_id,new.project_id,new.chapter_id,authority->>'planId')
    and p.version_json->'targetDurationSeconds'=authority->'targetDurationSeconds'
    and p.version_json->'aspectRatio'=authority->'aspectRatio' and p.version_json->'narrativeMode'=authority->'narrativeMode'))
 then raise exception 'review upstream changed' using errcode='P7001'; end if;

 select coalesce(max(o.revision),0) into latest from storyboard_review_operations o
  where (o.workspace_id,o.project_id,o.chapter_id,o.review_id)=(new.workspace_id,new.project_id,new.chapter_id,new.review_id);
 if cmd->'expectedRevision' is distinct from to_jsonb(latest) then raise exception 'review revision conflict' using errcode='P7004'; end if;
 new.revision:=latest+1;

 if kind='confirm' then
  if (cmd-array['kind','requestId','reason','expectedRevision','expectedPublicationId']='{}'::jsonb
    and jsonb_typeof(cmd->'expectedPublicationId') in ('null','string')) is not true
  then raise exception 'invalid confirmation command' using errcode='P7002'; end if;
  if cmd->>'expectedPublicationId' is distinct from formal.publication_id::text
  then raise exception 'formal storyboard changed' using errcode='P7004'; end if;
  if formal.review_id<>new.review_id and exists(
   select 1 from (select distinct on (o.shot_id) o.command->>'kind' as operation
    from storyboard_review_operations o
    where (o.workspace_id,o.project_id,o.chapter_id,o.review_id)=(new.workspace_id,new.project_id,new.chapter_id,formal.review_id)
      and o.command->>'kind' in ('lock','unlock') order by o.shot_id,o.revision desc) locks
   where operation='lock')
  then raise exception 'formal storyboard has locked shots' using errcode='P7004'; end if;
  if (v->>'generationStatus'='succeeded' and jsonb_array_length(v->'shots')>0 and jsonb_array_length(v->'failures')=0) is not true
   or exists(select 1 from storyboard_review_operations o
     where (o.workspace_id,o.project_id,o.chapter_id,o.review_id)=(new.workspace_id,new.project_id,new.chapter_id,new.review_id)
      and o.command->>'kind'='suggest' and not exists(select 1 from storyboard_review_operations d
       where (d.workspace_id,d.project_id,d.chapter_id,d.review_id)=(o.workspace_id,o.project_id,o.chapter_id,o.review_id)
        and d.command->>'kind'='decide' and d.command->'suggestionRevision'=to_jsonb(o.revision)))
  then raise exception 'storyboard review incomplete' using errcode='P7006'; end if;
  if formal.review_id=new.review_id and not exists(select 1 from storyboard_review_operations o
   where (o.workspace_id,o.project_id,o.chapter_id,o.review_id)=(new.workspace_id,new.project_id,new.chapter_id,new.review_id)
    and o.revision>formal.revision and o.change is not null)
  then raise exception 'storyboard already confirmed' using errcode='P7004'; end if;
  select version_json into plan from episode_plan_versions
   where (workspace_id,project_id,chapter_id,id)=(new.workspace_id,new.project_id,new.chapter_id,authority->>'planId');
  select version_json into script from script_content_versions
   where (workspace_id,project_id,chapter_id,id)=(new.workspace_id,new.project_id,new.chapter_id,authority->>'scriptId');
  target:=(authority->>'targetDurationSeconds')::numeric;
  if coalesce(jsonb_array_length(plan->'episodes'),0)=0 or coalesce(jsonb_array_length(script->'scenes'),0)=0
   or exists(select 1 from jsonb_array_elements(plan->'episodes') e
     where not exists(select 1 from jsonb_array_elements(v->'shots') s where s->>'episodeId'=e->>'id'))
   or exists(select 1 from jsonb_array_elements(script->'scenes') sc
     where not exists(select 1 from jsonb_array_elements(v->'shots') s where s->>'sceneId'=sc->>'id'))
  then raise exception 'storyboard coverage incomplete' using errcode='P7006'; end if;
  if exists(
   with totals as (
    select s->>'episodeId' as episode_id,sum(coalesce((change.value->>'durationSeconds')::numeric,(s->>'durationSeconds')::numeric)) as seconds
    from jsonb_array_elements(v->'shots') s
    left join lateral (
     select o.change as value from storyboard_review_operations o
     where (o.workspace_id,o.project_id,o.chapter_id,o.review_id)=(new.workspace_id,new.project_id,new.chapter_id,new.review_id)
       and o.shot_id=s->>'id' and o.change is not null order by o.revision desc limit 1
    ) change on true group by s->>'episodeId'
   )
   select 1 from jsonb_array_elements(plan->'episodes') e left join totals on episode_id=e->>'id'
    where seconds is null or abs(seconds-target)*10>target
  ) then raise exception 'episode duration outside tolerance' using errcode='P7007'; end if;
  new.shot_id:='';
  new.publication_id:=nextval('public.storyboard_publication_id_seq');
  return new;
 end if;

 if kind in ('lock','unlock') then
  if (jsonb_typeof(cmd->'shotId')='string' and cmd-array['kind','requestId','reason','expectedRevision','shotId']='{}'::jsonb
    and exists(select 1 from jsonb_array_elements(v->'shots') s where s->>'id'=cmd->>'shotId')) is not true
  then raise exception 'invalid lock command' using errcode='P7002'; end if;
  if formal.review_id is distinct from new.review_id or (kind='lock' and exists(select 1 from storyboard_review_operations o
    where (o.workspace_id,o.project_id,o.chapter_id,o.review_id)=(new.workspace_id,new.project_id,new.chapter_id,new.review_id)
    and o.revision>formal.revision and o.change is not null))
  then raise exception 'lock requires current published content' using errcode='P7004'; end if;
  new.shot_id:=cmd->>'shotId';
 elsif kind='decide' then
  if (cmd->>'decision' in ('accepted','rejected') and jsonb_typeof(cmd->'suggestionRevision')='number'
    and cmd-array['kind','requestId','reason','expectedRevision','decision','suggestionRevision']='{}'::jsonb) is not true
  then raise exception 'invalid review decision' using errcode='P7002'; end if;
  select * into suggestion from storyboard_review_operations o
   where (o.workspace_id,o.project_id,o.chapter_id,o.review_id)=(new.workspace_id,new.project_id,new.chapter_id,new.review_id)
    and o.command->>'kind'='suggest' and to_jsonb(o.revision)=cmd->'suggestionRevision';
  if suggestion.revision is null or exists(select 1 from storyboard_review_operations o
   where (o.workspace_id,o.project_id,o.chapter_id,o.review_id)=(new.workspace_id,new.project_id,new.chapter_id,new.review_id)
    and o.command->>'kind'='decide' and o.command->'suggestionRevision'=cmd->'suggestionRevision')
  then raise exception 'suggestion is not pending' using errcode='P7004'; end if;
  new.shot_id:=suggestion.shot_id;
  if cmd->>'decision'='accepted' then
   if exists(select 1 from storyboard_review_operations o
    where (o.workspace_id,o.project_id,o.chapter_id,o.review_id)=(new.workspace_id,new.project_id,new.chapter_id,new.review_id)
     and o.shot_id=new.shot_id and o.revision>suggestion.revision and o.change is not null)
   then raise exception 'suggested shot changed' using errcode='P7004'; end if;
   new.change:=suggestion.command->'value';
  end if;
 else
  if (jsonb_typeof(cmd->'shotId')='string' and jsonb_typeof(cmd->'value')='object'
    and cmd-array['kind','requestId','reason','expectedRevision','shotId','value']='{}'::jsonb
    and (cmd->'value')-array['visual','durationSeconds']='{}'::jsonb
    and jsonb_typeof(cmd->'value'->'visual')='string' and length(cmd->'value'->>'visual') between 1 and 20000
    and btrim(cmd->'value'->>'visual')<>''
    and jsonb_typeof(cmd->'value'->'durationSeconds')='number') is not true
  then raise exception 'invalid shot change' using errcode='P7002'; end if;
  if (cmd->'value'->>'durationSeconds')::numeric<5e-324
   or (cmd->'value'->>'durationSeconds')::numeric>1.7976931348623157e308
   or not exists(select 1 from jsonb_array_elements(v->'shots') s where s->>'id'=cmd->>'shotId')
  then raise exception 'invalid shot change' using errcode='P7002'; end if;
  new.shot_id:=cmd->>'shotId';
  if kind='edit' then new.change:=cmd->'value'; end if;
 end if;
 if kind in ('lock','unlock','edit','suggest') or (kind='decide' and new.change is not null) then
  select o.command->>'kind'='lock' into locked from storyboard_review_operations o
   where (o.workspace_id,o.project_id,o.chapter_id,o.review_id)=(new.workspace_id,new.project_id,new.chapter_id,new.review_id)
    and o.shot_id=new.shot_id and o.command->>'kind' in ('lock','unlock') order by o.revision desc limit 1;
  if (kind='unlock' and not coalesce(locked,false)) or (kind<>'unlock' and coalesce(locked,false))
  then raise exception 'storyboard lock conflict' using errcode='P7004'; end if;
 end if;
 return new;
end $$;
