create table if not exists projects (
  id text primary key,
  workspace_id text not null,
  owner_user_id text not null,
  title text not null check (length(btrim(title)) > 0),
  aspect_ratio text not null check (aspect_ratio in ('9:16', '16:9')),
  target_duration_seconds integer not null check (target_duration_seconds in (60, 180, 300)),
  narrative_mode text not null check (narrative_mode in ('narration', 'dialogue')),
  data_region text not null default 'CN' check (data_region = 'CN'),
  created_at timestamptz not null,
  unique (id, workspace_id)
);

create table if not exists project_members (
  project_id text not null,
  workspace_id text not null,
  user_id text not null,
  role text not null check (role in ('owner', 'editor', 'reviewer')),
  primary key (project_id, user_id),
  foreign key (project_id, workspace_id) references projects(id, workspace_id) on delete cascade
);

create index if not exists project_members_workspace_user_project_idx
  on project_members (workspace_id, user_id, project_id);

create table if not exists chapters (
  id text primary key,
  project_id text not null references projects(id) on delete cascade,
  title text not null check (length(btrim(title)) > 0),
  active_source_version_id text,
  unique (project_id, id)
);

create index if not exists chapters_project_id_idx on chapters (project_id);

create table if not exists source_versions (
  id text primary key,
  project_id text not null references projects(id) on delete cascade,
  chapter_id text not null,
  ordinal integer not null check (ordinal > 0),
  created_at timestamptz not null,
  created_by text not null,
  character_count integer not null check (character_count between 1 and 20000),
  source_text text not null,
  unique (chapter_id, ordinal),
  unique (project_id, chapter_id, id),
  foreign key (project_id, chapter_id) references chapters(project_id, id) on delete cascade
);

create index if not exists source_versions_project_chapter_idx
  on source_versions (project_id, chapter_id, ordinal);
create index if not exists source_versions_chapter_id_idx on source_versions (chapter_id);

alter table chapters drop constraint if exists chapters_active_source_version_id_fkey;
alter table chapters add constraint chapters_active_source_version_id_fkey
  foreign key (project_id, id, active_source_version_id)
  references source_versions(project_id, chapter_id, id) deferrable initially deferred;

create index if not exists chapters_active_source_version_id_idx on chapters (active_source_version_id);

create table if not exists source_fragments (
  id text primary key,
  project_id text not null references projects(id) on delete cascade,
  chapter_id text not null,
  text_content text not null,
  content_hash text not null,
  unique (chapter_id, id),
  unique (project_id, chapter_id, id),
  foreign key (project_id, chapter_id) references chapters(project_id, id) on delete cascade
);

create index if not exists source_fragments_project_chapter_idx
  on source_fragments (project_id, chapter_id);
create index if not exists source_fragments_chapter_id_idx on source_fragments (chapter_id);

create table if not exists source_version_fragments (
  source_version_id text not null,
  fragment_id text not null,
  project_id text not null references projects(id) on delete cascade,
  chapter_id text not null,
  ordinal integer not null check (ordinal > 0),
  start_offset integer not null check (start_offset >= 0),
  end_offset integer not null check (end_offset > start_offset),
  primary key (source_version_id, fragment_id),
  unique (source_version_id, ordinal),
  foreign key (project_id, chapter_id, source_version_id)
    references source_versions(project_id, chapter_id, id) on delete cascade,
  foreign key (project_id, chapter_id, fragment_id)
    references source_fragments(project_id, chapter_id, id) on delete restrict
);

create index if not exists source_version_fragments_project_id_idx
  on source_version_fragments (project_id);
create index if not exists source_version_fragments_fragment_id_idx
  on source_version_fragments (fragment_id);

create or replace function current_app_user_id() returns text
language sql stable
as $$ select nullif(current_setting('app.current_user_id', true), '') $$;

create or replace function current_app_workspace_id() returns text
language sql stable
as $$ select nullif(current_setting('app.current_workspace_id', true), '') $$;

create or replace function can_access_project(target_project_id text) returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from project_members
    where project_id = target_project_id
      and workspace_id = current_app_workspace_id()
      and user_id = current_app_user_id()
  )
$$;

create or replace function can_write_project(target_project_id text) returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from project_members
    where project_id = target_project_id
      and workspace_id = current_app_workspace_id()
      and user_id = current_app_user_id()
      and role in ('owner', 'editor')
  )
$$;

create or replace function can_manage_project(target_project_id text) returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from project_members
    where project_id = target_project_id
      and workspace_id = current_app_workspace_id()
      and user_id = current_app_user_id()
      and role = 'owner'
  )
$$;

create or replace function can_bootstrap_project_owner(target_project_id text, target_workspace_id text) returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from projects
    where id = target_project_id
      and workspace_id = target_workspace_id
      and owner_user_id = current_app_user_id()
      and workspace_id = current_app_workspace_id()
  )
$$;

alter table projects enable row level security;
alter table project_members enable row level security;
alter table chapters enable row level security;
alter table chapters force row level security;
alter table source_versions enable row level security;
alter table source_versions force row level security;
alter table source_fragments enable row level security;
alter table source_fragments force row level security;
alter table source_version_fragments enable row level security;
alter table source_version_fragments force row level security;

drop policy if exists projects_select_update_delete on projects;
drop policy if exists projects_insert on projects;
drop policy if exists projects_select on projects;
drop policy if exists projects_update on projects;
drop policy if exists projects_delete on projects;
create policy projects_insert on projects for insert
  with check (workspace_id = current_app_workspace_id() and owner_user_id = current_app_user_id());
create policy projects_select on projects for select using (can_access_project(id));
create policy projects_update on projects for update
  using (can_write_project(id)) with check (can_write_project(id));
create policy projects_delete on projects for delete using (can_manage_project(id));

drop policy if exists project_members_access on project_members;
drop policy if exists project_members_select on project_members;
drop policy if exists project_members_insert on project_members;
drop policy if exists project_members_update on project_members;
drop policy if exists project_members_delete on project_members;
create policy project_members_select on project_members for select using (can_access_project(project_id));
create policy project_members_insert on project_members for insert with check (
  workspace_id = current_app_workspace_id()
  and (
    can_manage_project(project_id)
    or (user_id = current_app_user_id() and role = 'owner' and can_bootstrap_project_owner(project_id, workspace_id))
  )
);
create policy project_members_update on project_members for update
  using (can_manage_project(project_id)) with check (can_manage_project(project_id));
create policy project_members_delete on project_members for delete using (can_manage_project(project_id));

drop policy if exists chapters_member_access on chapters;
drop policy if exists chapters_select on chapters;
drop policy if exists chapters_insert on chapters;
drop policy if exists chapters_update on chapters;
create policy chapters_select on chapters for select using (can_access_project(project_id));
create policy chapters_insert on chapters for insert with check (can_write_project(project_id));
create policy chapters_update on chapters for update
  using (can_write_project(project_id)) with check (can_write_project(project_id));
drop policy if exists source_versions_member_access on source_versions;
drop policy if exists source_versions_select on source_versions;
drop policy if exists source_versions_insert on source_versions;
create policy source_versions_select on source_versions for select using (can_access_project(project_id));
create policy source_versions_insert on source_versions for insert with check (can_write_project(project_id));
drop policy if exists source_fragments_member_access on source_fragments;
drop policy if exists source_fragments_select on source_fragments;
drop policy if exists source_fragments_insert on source_fragments;
create policy source_fragments_select on source_fragments for select using (can_access_project(project_id));
create policy source_fragments_insert on source_fragments for insert with check (can_write_project(project_id));
drop policy if exists source_version_fragments_member_access on source_version_fragments;
drop policy if exists source_version_fragments_select on source_version_fragments;
drop policy if exists source_version_fragments_insert on source_version_fragments;
create policy source_version_fragments_select on source_version_fragments for select using (can_access_project(project_id));
create policy source_version_fragments_insert on source_version_fragments for insert with check (can_write_project(project_id));

create or replace function reject_immutable_change() returns trigger
language plpgsql as $$
begin
  raise exception 'immutable source records cannot be updated or deleted';
end
$$;

drop trigger if exists source_versions_immutable_update on source_versions;
create trigger source_versions_immutable_update before update on source_versions
  for each row execute function reject_immutable_change();
drop trigger if exists source_versions_immutable_delete on source_versions;
create trigger source_versions_immutable_delete before delete on source_versions
  for each row execute function reject_immutable_change();
drop trigger if exists source_fragments_immutable_update on source_fragments;
create trigger source_fragments_immutable_update before update on source_fragments
  for each row execute function reject_immutable_change();
drop trigger if exists source_fragments_immutable_delete on source_fragments;
create trigger source_fragments_immutable_delete before delete on source_fragments
  for each row execute function reject_immutable_change();
drop trigger if exists source_version_fragments_immutable_update on source_version_fragments;
create trigger source_version_fragments_immutable_update before update on source_version_fragments
  for each row execute function reject_immutable_change();
drop trigger if exists source_version_fragments_immutable_delete on source_version_fragments;
create trigger source_version_fragments_immutable_delete before delete on source_version_fragments
  for each row execute function reject_immutable_change();

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'novel_app') then
    create role novel_app nologin;
  end if;
end $$;

grant usage on schema public to novel_app;
grant select, insert, update on projects, project_members, chapters to novel_app;
grant select, insert on source_versions, source_fragments, source_version_fragments to novel_app;
