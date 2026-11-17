create table storyboard_reconciliations (
  workspace_id text not null, project_id text not null, chapter_id text not null,
  id uuid not null default gen_random_uuid(),
  base_publication_id bigint not null, source_version_id text not null, upstream_ids text[] not null,
  created_by text not null default current_app_user_id(),
  primary key(workspace_id,project_id,chapter_id,id),
  unique(workspace_id,project_id,chapter_id,base_publication_id,source_version_id,upstream_ids),
  check(cardinality(upstream_ids)=4)
);
alter table storyboard_reconciliations enable row level security;
alter table storyboard_reconciliations force row level security;
create policy storyboard_reconciliation_read on storyboard_reconciliations for select using (
  workspace_id=current_app_workspace_id() and can_access_project(project_id)
);
create policy storyboard_reconciliation_insert on storyboard_reconciliations for insert with check (
  workspace_id=current_app_workspace_id() and can_review_project(project_id) and created_by=current_app_user_id()
);
revoke all on storyboard_reconciliations from public,novel_app;
grant select on storyboard_reconciliations to novel_app;
grant insert(workspace_id,project_id,chapter_id,base_publication_id,source_version_id,upstream_ids) on storyboard_reconciliations to novel_app;
create trigger storyboard_reconciliation_immutable before update or delete on storyboard_reconciliations
 for each row execute function reject_immutable_change();

create function guard_storyboard_reconciliation() returns trigger language plpgsql set search_path=public,pg_temp as $$
declare authority jsonb; baseline record; settings_id text; ids text[];
begin
  authority := lock_settings_review_authority(new.workspace_id,new.project_id,new.chapter_id);
  if not can_review_project(new.project_id) then
    raise exception 'storyboard reconciliation forbidden' using errcode='42501';
  end if;

  select o.publication_id,c.version_json into baseline
  from storyboard_review_operations o
  join storyboard_review_submissions r on (r.workspace_id,r.project_id,r.chapter_id,r.id)=(o.workspace_id,o.project_id,o.chapter_id,o.review_id)
  join storyboard_candidate_versions c on (c.workspace_id,c.project_id,c.chapter_id,c.job_id)=(r.workspace_id,r.project_id,r.chapter_id,r.job_id)
  where (o.workspace_id,o.project_id,o.chapter_id)=(new.workspace_id,new.project_id,new.chapter_id)
    and o.publication_id is not null order by o.publication_id desc limit 1;
  if baseline.publication_id is distinct from new.base_publication_id then
    raise exception 'formal storyboard changed' using errcode='P7004';
  end if;

  select confirmed_version_id into settings_id from settings_review_heads
    where (workspace_id,project_id,chapter_id)=(new.workspace_id,new.project_id,new.chapter_id) for share;
  ids := array[authority->>'scriptId',settings_id,authority->>'planId',authority->>'knowledgeId'];
  if array_position(ids,null) is not null or new.upstream_ids is distinct from ids
    or new.source_version_id is distinct from authority->>'sourceId'
    or not exists (
      select 1 from settings_review_versions s
      where (s.workspace_id,s.project_id,s.chapter_id,s.id)=(new.workspace_id,new.project_id,new.chapter_id,settings_id)
        and s.version_json->>'status'='confirmed'
        and s.version_json->>'sourceVersionId'=new.source_version_id
        and s.version_json->'upstreamConfirmedVersionIds'=jsonb_build_array(ids[1],ids[3],ids[4])
    ) or not exists (
      select 1 from episode_plan_versions p
      where (p.workspace_id,p.project_id,p.chapter_id,p.id)=(new.workspace_id,new.project_id,new.chapter_id,ids[3])
        and p.version_json->'targetDurationSeconds'=authority->'targetDurationSeconds'
        and p.version_json->'aspectRatio'=authority->'aspectRatio'
        and p.version_json->'narrativeMode'=authority->'narrativeMode'
    ) then raise exception 'storyboard reconciliation upstream changed' using errcode='P7001'; end if;
  if (baseline.version_json->>'sourceVersionId', baseline.version_json->'upstreamConfirmedVersionIds')
    is not distinct from (new.source_version_id,to_jsonb(ids)) then
    raise exception 'formal upstream unchanged' using errcode='P7004';
  end if;
  return new;
end $$;
create trigger storyboard_reconciliation_guard before insert on storyboard_reconciliations
  for each row execute function guard_storyboard_reconciliation();
