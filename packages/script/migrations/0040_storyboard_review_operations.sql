create table storyboard_review_operations (
 workspace_id text not null, project_id text not null, chapter_id text not null, review_id uuid not null,
 revision integer not null, actor_id text not null default current_app_user_id(), recorded_at timestamptz not null default clock_timestamp(),
 command jsonb not null, shot_id text not null, change jsonb,
 primary key(workspace_id,project_id,chapter_id,review_id,revision),
 foreign key(workspace_id,project_id,chapter_id,review_id) references storyboard_review_submissions(workspace_id,project_id,chapter_id,id)
);
create unique index storyboard_review_operation_request on storyboard_review_operations
 (workspace_id,project_id,chapter_id,review_id,actor_id,(command->>'requestId'));
alter table storyboard_review_operations enable row level security;
alter table storyboard_review_operations force row level security;
create policy storyboard_review_operation_read on storyboard_review_operations for select using (
 workspace_id=current_app_workspace_id() and can_access_project(project_id)
);
create policy storyboard_review_operation_write on storyboard_review_operations for insert with check (
 workspace_id=current_app_workspace_id() and actor_id=current_app_user_id() and can_access_project(project_id)
);
revoke all on storyboard_review_operations from public,novel_app;
grant select on storyboard_review_operations to novel_app;
grant insert(workspace_id,project_id,chapter_id,review_id,command) on storyboard_review_operations to novel_app;
create trigger storyboard_review_operation_immutable before update or delete on storyboard_review_operations
 for each row execute function reject_immutable_change();

create function guard_storyboard_review_operation() returns trigger language plpgsql set search_path=public,pg_temp as $$
declare cmd jsonb:=new.command; kind text:=cmd->>'kind'; v jsonb; authority jsonb; settings_id text;
 previous storyboard_review_operations; suggestion storyboard_review_operations; latest integer;
begin
 if new.workspace_id is distinct from current_app_workspace_id() or new.actor_id is distinct from current_app_user_id()
  or not can_access_project(new.project_id) then raise exception 'review denied' using errcode='42501'; end if;
 if (kind in ('edit','suggest','decide') and jsonb_typeof(cmd->'requestId')='string'
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

 select confirmed_version_id into settings_id from settings_review_heads
  where (workspace_id,project_id,chapter_id)=(new.workspace_id,new.project_id,new.chapter_id) for share;
 if authority->>'sourceId' is distinct from v->>'sourceVersionId' or settings_id is null
  or v->'upstreamConfirmedVersionIds' is distinct from jsonb_build_array(authority->>'scriptId',settings_id,authority->>'planId',authority->>'knowledgeId')
  or not exists(select 1 from episode_plan_versions p where (p.workspace_id,p.project_id,p.chapter_id,p.id)=(new.workspace_id,new.project_id,new.chapter_id,authority->>'planId')
    and p.version_json->'targetDurationSeconds'=authority->'targetDurationSeconds'
    and p.version_json->'aspectRatio'=authority->'aspectRatio' and p.version_json->'narrativeMode'=authority->'narrativeMode')
 then raise exception 'review upstream changed' using errcode='P7001'; end if;

 select coalesce(max(o.revision),0) into latest from storyboard_review_operations o
  where (o.workspace_id,o.project_id,o.chapter_id,o.review_id)=(new.workspace_id,new.project_id,new.chapter_id,new.review_id);
 if cmd->'expectedRevision' is distinct from to_jsonb(latest) then raise exception 'review revision conflict' using errcode='P7004'; end if;
 new.revision:=latest+1;

 if kind='decide' then
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
 return new;
end $$;
create trigger storyboard_review_operation_guard before insert on storyboard_review_operations
 for each row execute function guard_storyboard_review_operation();
