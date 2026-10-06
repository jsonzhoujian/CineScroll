-- Requires project-import 0001 and story-knowledge 0001. Apply as trusted owner only.
create table if not exists episode_plan_versions (
  workspace_id text not null, project_id text not null, chapter_id text not null, id text not null,
  parent_version_id text, source_version_id text not null, story_bible_version_id text not null,
  status text not null check(status in ('candidate','confirmed')), created_by text not null,
  version_json jsonb not null check(jsonb_typeof(version_json)='object'),
  primary key(workspace_id,project_id,chapter_id,id),
  foreign key(project_id,workspace_id) references projects(id,workspace_id),
  foreign key(project_id,chapter_id,source_version_id) references source_versions(project_id,chapter_id,id),
  foreign key(workspace_id,project_id,chapter_id,story_bible_version_id) references story_bibles(workspace_id,project_id,chapter_id,version_id),
  foreign key(workspace_id,project_id,chapter_id,parent_version_id) references episode_plan_versions(workspace_id,project_id,chapter_id,id),
  check ((version_json->>'id') is not distinct from id and (version_json->>'projectId') is not distinct from project_id
    and (version_json->>'chapterId') is not distinct from chapter_id and (version_json->>'sourceVersionId') is not distinct from source_version_id
    and (version_json->>'storyBibleVersionId') is not distinct from story_bible_version_id and (version_json->>'status') is not distinct from status
    and (version_json->>'parentVersionId') is not distinct from parent_version_id and (version_json->>'createdBy') is not distinct from created_by)
);
create index if not exists episode_plan_versions_source_idx on episode_plan_versions(project_id,chapter_id,source_version_id);
create index if not exists episode_plan_versions_bible_idx on episode_plan_versions(workspace_id,project_id,chapter_id,story_bible_version_id);
create index if not exists episode_plan_versions_parent_idx on episode_plan_versions(workspace_id,project_id,chapter_id,parent_version_id);
create table if not exists episode_plan_heads (
  workspace_id text not null, project_id text not null, chapter_id text not null, active_version_id text, confirmed_version_id text,
  primary key(workspace_id,project_id,chapter_id),
  foreign key(project_id,workspace_id) references projects(id,workspace_id),
  foreign key(project_id,chapter_id) references chapters(project_id,id),
  foreign key(workspace_id,project_id,chapter_id,active_version_id) references episode_plan_versions(workspace_id,project_id,chapter_id,id),
  foreign key(workspace_id,project_id,chapter_id,confirmed_version_id) references episode_plan_versions(workspace_id,project_id,chapter_id,id)
);
create table if not exists episode_plan_operations (
  workspace_id text not null, project_id text not null, chapter_id text not null, operation_key text not null, fingerprint text not null, version_id text not null,
  primary key(workspace_id,project_id,chapter_id,operation_key),
  foreign key(workspace_id,project_id,chapter_id,version_id) references episode_plan_versions(workspace_id,project_id,chapter_id,id)
);
create index if not exists episode_plan_operations_version_idx on episode_plan_operations(workspace_id,project_id,chapter_id,version_id);
alter table episode_plan_versions enable row level security;
alter table episode_plan_versions force row level security;
alter table episode_plan_heads enable row level security;
alter table episode_plan_heads force row level security;
alter table episode_plan_operations enable row level security;
alter table episode_plan_operations force row level security;
drop policy if exists episode_plan_versions_read on episode_plan_versions;
drop policy if exists episode_plan_versions_insert on episode_plan_versions;
drop policy if exists episode_plan_heads_read on episode_plan_heads;
drop policy if exists episode_plan_heads_insert on episode_plan_heads;
drop policy if exists episode_plan_heads_update on episode_plan_heads;
drop policy if exists episode_plan_operations_read on episode_plan_operations;
drop policy if exists episode_plan_operations_insert on episode_plan_operations;
drop trigger if exists episode_plan_versions_immutable on episode_plan_versions;
drop trigger if exists episode_plan_operations_immutable on episode_plan_operations;
drop trigger if exists episode_plan_head_transition on episode_plan_heads;
create policy episode_plan_versions_read on episode_plan_versions for select using(workspace_id=current_app_workspace_id() and can_access_project(project_id));
create policy episode_plan_versions_insert on episode_plan_versions for insert with check(workspace_id=current_app_workspace_id() and can_access_project(project_id)
  and created_by=current_app_user_id() and (status='candidate' or can_review_project(project_id)));
create policy episode_plan_heads_read on episode_plan_heads for select using(workspace_id=current_app_workspace_id() and can_access_project(project_id));
create policy episode_plan_heads_insert on episode_plan_heads for insert with check(workspace_id=current_app_workspace_id() and can_access_project(project_id));
create policy episode_plan_heads_update on episode_plan_heads for update using(workspace_id=current_app_workspace_id() and can_access_project(project_id)) with check(workspace_id=current_app_workspace_id() and can_access_project(project_id));
create policy episode_plan_operations_read on episode_plan_operations for select using(workspace_id=current_app_workspace_id() and can_access_project(project_id));
create policy episode_plan_operations_insert on episode_plan_operations for insert with check(workspace_id=current_app_workspace_id() and can_access_project(project_id));
create trigger episode_plan_versions_immutable before update or delete on episode_plan_versions for each row execute function reject_immutable_change();
create trigger episode_plan_operations_immutable before update or delete on episode_plan_operations for each row execute function reject_immutable_change();
create or replace function guard_episode_plan_head() returns trigger language plpgsql as $$
begin
  if TG_OP='UPDATE' and old.confirmed_version_id is not null then
    if new.confirmed_version_id is null or new.active_version_id is distinct from old.active_version_id then
      raise exception 'confirmed episode plan requires revision flow' using errcode='42501';
    end if;
  end if;
  if TG_OP='UPDATE' and new.active_version_id is distinct from old.active_version_id then
    if new.active_version_id is null or not exists (
      select 1 from episode_plan_versions v where v.workspace_id=new.workspace_id and v.project_id=new.project_id and v.chapter_id=new.chapter_id
        and v.id=new.active_version_id and v.parent_version_id is not distinct from old.active_version_id
    ) then raise exception 'episode plan must advance from current head' using errcode='42501'; end if;
  end if;
  if new.confirmed_version_id is not null and (TG_OP='INSERT' or new.confirmed_version_id is distinct from old.confirmed_version_id) then
    if not can_review_project(new.project_id) or new.active_version_id is distinct from new.confirmed_version_id
      or not exists(select 1 from episode_plan_versions v where v.workspace_id=new.workspace_id and v.project_id=new.project_id and v.chapter_id=new.chapter_id and v.id=new.confirmed_version_id and v.status='confirmed') then
      raise exception 'invalid episode confirmation' using errcode='42501';
    end if;
  end if;
  return new;
end $$;
create trigger episode_plan_head_transition before insert or update on episode_plan_heads for each row execute function guard_episode_plan_head();
revoke all on episode_plan_versions,episode_plan_heads,episode_plan_operations from public,novel_app;
grant select,insert on episode_plan_versions,episode_plan_operations to novel_app;
grant select,insert on episode_plan_heads to novel_app;
grant update(active_version_id,confirmed_version_id) on episode_plan_heads to novel_app;
