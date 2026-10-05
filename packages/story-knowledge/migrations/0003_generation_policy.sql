-- Explicit current verdicts only: no automatic legacy backfill to allowed.
create table if not exists project_generation_policy (
  workspace_id text not null,
  project_id text primary key,
  state text not null check (state in ('allowed','complaint_suspended','content_blocked')),
  updated_at timestamptz not null default clock_timestamp(),
  foreign key (project_id,workspace_id) references projects(id,workspace_id) on delete cascade
);
create table if not exists source_generation_policy (
  workspace_id text not null,
  project_id text not null,
  chapter_id text not null,
  source_version_id text primary key,
  state text not null check (state in ('allowed','pending','blocked')),
  updated_at timestamptz not null default clock_timestamp(),
  foreign key (project_id,workspace_id) references projects(id,workspace_id) on delete cascade,
  foreign key (project_id,chapter_id,source_version_id) references source_versions(project_id,chapter_id,id) on delete cascade
);
alter table project_generation_policy enable row level security;
alter table project_generation_policy force row level security;
alter table source_generation_policy enable row level security;
alter table source_generation_policy force row level security;
drop policy if exists project_generation_policy_read on project_generation_policy;
create policy project_generation_policy_read on project_generation_policy for select to novel_app
  using (workspace_id=current_app_workspace_id() and can_access_project(project_id));
drop policy if exists source_generation_policy_read on source_generation_policy;
create policy source_generation_policy_read on source_generation_policy for select to novel_app
  using (workspace_id=current_app_workspace_id() and can_access_project(project_id));
revoke all on project_generation_policy,source_generation_policy from public,novel_app;
grant select on project_generation_policy,source_generation_policy to novel_app;

-- Owned by a trusted migration role with RLS bypass, not the application role.
-- App may lock/read through this function but never change verdicts.
create or replace function generation_allowed_locked(w text,p text,c text,s text) returns boolean
language plpgsql security definer set search_path=pg_catalog as $$
declare project_state text; source_state text;
begin
  if w is distinct from public.current_app_workspace_id() or not public.can_access_project(p) then return false; end if;
  select state into project_state from public.project_generation_policy
    where workspace_id=w and project_id=p for share;
  if project_state is distinct from 'allowed' then return false; end if;
  select state into source_state from public.source_generation_policy
    where workspace_id=w and project_id=p and chapter_id=c and source_version_id=s for share;
  return source_state is not distinct from 'allowed';
end $$;
revoke all on function generation_allowed_locked(text,text,text,text) from public;
grant execute on function generation_allowed_locked(text,text,text,text) to novel_app;
