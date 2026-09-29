create table if not exists story_knowledge_versions (
  id text not null,
  workspace_id text not null,
  project_id text not null,
  chapter_id text not null,
  parent_version_id text,
  source_version_id text not null,
  extraction_job_id text not null,
  created_at timestamptz not null,
  created_by text not null,
  extraction_status text not null check (extraction_status in ('succeeded', 'partially_succeeded', 'failed')),
  status text not null check (status in ('candidate', 'needs_resolution', 'confirmed')),
  version_json jsonb not null check (jsonb_typeof(version_json) = 'object'),
  primary key (workspace_id, project_id, chapter_id, id),
  foreign key (project_id, workspace_id) references projects(id, workspace_id) on delete cascade,
  foreign key (project_id, chapter_id) references chapters(project_id, id) on delete cascade,
  constraint story_knowledge_versions_source_version_fkey
    foreign key (project_id, chapter_id, source_version_id)
    references source_versions(project_id, chapter_id, id),
  constraint story_knowledge_versions_parent_version_fkey
    foreign key (workspace_id, project_id, chapter_id, parent_version_id)
    references story_knowledge_versions(workspace_id, project_id, chapter_id, id)
);

create index if not exists story_knowledge_versions_stage_created_idx
  on story_knowledge_versions (workspace_id, project_id, chapter_id, created_at);
create index if not exists story_knowledge_versions_parent_idx
  on story_knowledge_versions (workspace_id, project_id, chapter_id, parent_version_id);
create index if not exists story_knowledge_versions_project_chapter_idx
  on story_knowledge_versions (project_id, chapter_id);

create table if not exists story_knowledge_heads (
  workspace_id text not null,
  project_id text not null,
  chapter_id text not null,
  active_version_id text,
  confirmed_version_id text,
  primary key (workspace_id, project_id, chapter_id),
  foreign key (project_id, workspace_id) references projects(id, workspace_id) on delete cascade,
  foreign key (project_id, chapter_id) references chapters(project_id, id) on delete cascade,
  foreign key (workspace_id, project_id, chapter_id, active_version_id)
    references story_knowledge_versions(workspace_id, project_id, chapter_id, id),
  foreign key (workspace_id, project_id, chapter_id, confirmed_version_id)
    references story_knowledge_versions(workspace_id, project_id, chapter_id, id)
);

create table if not exists story_bibles (
  id text not null,
  workspace_id text not null,
  project_id text not null,
  chapter_id text not null,
  version_id text not null,
  bible_json jsonb not null check (jsonb_typeof(bible_json) = 'object'),
  primary key (workspace_id, project_id, chapter_id, version_id),
  unique (workspace_id, project_id, chapter_id, id),
  foreign key (workspace_id, project_id, chapter_id, version_id)
    references story_knowledge_versions(workspace_id, project_id, chapter_id, id)
);

create index if not exists story_knowledge_heads_project_chapter_idx
  on story_knowledge_heads (project_id, chapter_id);

create table if not exists story_knowledge_retry_results (
  workspace_id text not null,
  project_id text not null,
  chapter_id text not null,
  idempotency_key text not null,
  fingerprint text not null,
  version_id text not null,
  primary key (workspace_id, project_id, chapter_id, idempotency_key),
  foreign key (workspace_id, project_id, chapter_id, version_id)
    references story_knowledge_versions(workspace_id, project_id, chapter_id, id)
);

create index if not exists story_knowledge_retry_version_idx
  on story_knowledge_retry_results (workspace_id, project_id, chapter_id, version_id);

create table if not exists story_knowledge_confirmation_results (
  workspace_id text not null,
  project_id text not null,
  chapter_id text not null,
  candidate_version_id text not null,
  fingerprint text not null,
  version_id text not null,
  primary key (workspace_id, project_id, chapter_id, candidate_version_id),
  foreign key (workspace_id, project_id, chapter_id, candidate_version_id)
    references story_knowledge_versions(workspace_id, project_id, chapter_id, id),
  foreign key (workspace_id, project_id, chapter_id, version_id)
    references story_knowledge_versions(workspace_id, project_id, chapter_id, id)
);

create index if not exists story_knowledge_confirmation_version_idx
  on story_knowledge_confirmation_results (workspace_id, project_id, chapter_id, version_id);

alter table story_knowledge_versions enable row level security;
alter table story_knowledge_versions force row level security;
alter table story_knowledge_heads enable row level security;
alter table story_knowledge_heads force row level security;
alter table story_bibles enable row level security;
alter table story_bibles force row level security;
alter table story_knowledge_retry_results enable row level security;
alter table story_knowledge_retry_results force row level security;
alter table story_knowledge_confirmation_results enable row level security;
alter table story_knowledge_confirmation_results force row level security;

create or replace function current_story_knowledge_operation() returns text
language sql stable
as $$ select nullif(current_setting('app.story_knowledge_operation', true), '') $$;

create or replace function can_review_project(target_project_id text) returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from project_members
    where project_id = target_project_id
      and workspace_id = current_app_workspace_id()
      and user_id = current_app_user_id()
      and role in ('owner', 'reviewer')
  )
$$;

create or replace function can_perform_story_write(target_project_id text, target_operation text) returns boolean
language sql stable
as $$
  select case target_operation
    when 'candidate' then can_write_project(target_project_id)
    when 'retry' then can_write_project(target_project_id)
    when 'confirm' then can_review_project(target_project_id)
    else false
  end
$$;

drop policy if exists story_knowledge_versions_access on story_knowledge_versions;
drop policy if exists story_knowledge_versions_select on story_knowledge_versions;
drop policy if exists story_knowledge_versions_insert on story_knowledge_versions;
create policy story_knowledge_versions_select on story_knowledge_versions for select
  using (workspace_id = current_app_workspace_id() and can_access_project(project_id));
create policy story_knowledge_versions_insert on story_knowledge_versions for insert with check (
  workspace_id = current_app_workspace_id()
  and can_perform_story_write(project_id, current_story_knowledge_operation())
  and (
    (current_story_knowledge_operation() in ('candidate', 'retry') and status in ('candidate', 'needs_resolution'))
    or (current_story_knowledge_operation() = 'confirm' and status = 'confirmed')
  )
);
drop policy if exists story_knowledge_heads_access on story_knowledge_heads;
drop policy if exists story_knowledge_heads_select on story_knowledge_heads;
drop policy if exists story_knowledge_heads_insert on story_knowledge_heads;
drop policy if exists story_knowledge_heads_update on story_knowledge_heads;
create policy story_knowledge_heads_select on story_knowledge_heads for select
  using (workspace_id = current_app_workspace_id() and can_access_project(project_id));
create policy story_knowledge_heads_insert on story_knowledge_heads for insert with check (
  workspace_id = current_app_workspace_id()
  and can_perform_story_write(project_id, current_story_knowledge_operation())
);
create policy story_knowledge_heads_update on story_knowledge_heads for update
  using (workspace_id = current_app_workspace_id() and can_perform_story_write(project_id, current_story_knowledge_operation()))
  with check (workspace_id = current_app_workspace_id() and can_perform_story_write(project_id, current_story_knowledge_operation()));
drop policy if exists story_bibles_access on story_bibles;
drop policy if exists story_bibles_select on story_bibles;
drop policy if exists story_bibles_insert on story_bibles;
create policy story_bibles_select on story_bibles for select
  using (workspace_id = current_app_workspace_id() and can_access_project(project_id));
create policy story_bibles_insert on story_bibles for insert with check (
  workspace_id = current_app_workspace_id()
  and current_story_knowledge_operation() = 'confirm'
  and can_review_project(project_id)
);
drop policy if exists story_knowledge_retry_results_access on story_knowledge_retry_results;
drop policy if exists story_knowledge_retry_results_select on story_knowledge_retry_results;
drop policy if exists story_knowledge_retry_results_insert on story_knowledge_retry_results;
create policy story_knowledge_retry_results_select on story_knowledge_retry_results for select
  using (workspace_id = current_app_workspace_id() and can_access_project(project_id));
create policy story_knowledge_retry_results_insert on story_knowledge_retry_results for insert with check (
  workspace_id = current_app_workspace_id()
  and current_story_knowledge_operation() = 'retry'
  and can_write_project(project_id)
);
drop policy if exists story_knowledge_confirmation_results_access on story_knowledge_confirmation_results;
drop policy if exists story_knowledge_confirmation_results_select on story_knowledge_confirmation_results;
drop policy if exists story_knowledge_confirmation_results_insert on story_knowledge_confirmation_results;
create policy story_knowledge_confirmation_results_select on story_knowledge_confirmation_results for select
  using (workspace_id = current_app_workspace_id() and can_access_project(project_id));
create policy story_knowledge_confirmation_results_insert on story_knowledge_confirmation_results for insert with check (
  workspace_id = current_app_workspace_id()
  and current_story_knowledge_operation() = 'confirm'
  and can_review_project(project_id)
);

create or replace function enforce_story_knowledge_head_transition() returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' and new.confirmed_version_id is not null
    and current_story_knowledge_operation() <> 'confirm' then
    raise exception 'only confirmation may establish the confirmed story-knowledge head';
  end if;
  if tg_op = 'UPDATE' and current_story_knowledge_operation() <> 'confirm'
    and new.confirmed_version_id is distinct from old.confirmed_version_id then
    raise exception 'only confirmation may change the confirmed story-knowledge head';
  end if;
  if (tg_op = 'UPDATE' and current_story_knowledge_operation() = 'confirm')
    or (tg_op = 'INSERT' and new.confirmed_version_id is not null) then
    if new.active_version_id is distinct from new.confirmed_version_id then
      raise exception 'confirmation must align active and confirmed story-knowledge heads';
    end if;
    if not exists (
      select 1 from story_knowledge_versions v
      join story_bibles b on b.workspace_id = v.workspace_id and b.project_id = v.project_id
        and b.chapter_id = v.chapter_id and b.version_id = v.id
      where v.workspace_id = new.workspace_id and v.project_id = new.project_id
        and v.chapter_id = new.chapter_id and v.id = new.confirmed_version_id and v.status = 'confirmed'
    ) then
      raise exception 'confirmed story-knowledge head requires a confirmed version and story bible';
    end if;
  end if;
  return new;
end
$$;

drop trigger if exists story_knowledge_heads_transition on story_knowledge_heads;
create trigger story_knowledge_heads_transition before insert or update on story_knowledge_heads
  for each row execute function enforce_story_knowledge_head_transition();

drop trigger if exists story_knowledge_versions_immutable_update on story_knowledge_versions;
create trigger story_knowledge_versions_immutable_update before update on story_knowledge_versions
  for each row execute function reject_immutable_change();
drop trigger if exists story_knowledge_versions_immutable_delete on story_knowledge_versions;
create trigger story_knowledge_versions_immutable_delete before delete on story_knowledge_versions
  for each row execute function reject_immutable_change();
drop trigger if exists story_bibles_immutable_update on story_bibles;
create trigger story_bibles_immutable_update before update on story_bibles
  for each row execute function reject_immutable_change();
drop trigger if exists story_bibles_immutable_delete on story_bibles;
create trigger story_bibles_immutable_delete before delete on story_bibles
  for each row execute function reject_immutable_change();
drop trigger if exists story_knowledge_retry_results_immutable_update on story_knowledge_retry_results;
create trigger story_knowledge_retry_results_immutable_update before update on story_knowledge_retry_results
  for each row execute function reject_immutable_change();
drop trigger if exists story_knowledge_retry_results_immutable_delete on story_knowledge_retry_results;
create trigger story_knowledge_retry_results_immutable_delete before delete on story_knowledge_retry_results
  for each row execute function reject_immutable_change();
drop trigger if exists story_knowledge_confirmation_results_immutable_update on story_knowledge_confirmation_results;
create trigger story_knowledge_confirmation_results_immutable_update before update on story_knowledge_confirmation_results
  for each row execute function reject_immutable_change();
drop trigger if exists story_knowledge_confirmation_results_immutable_delete on story_knowledge_confirmation_results;
create trigger story_knowledge_confirmation_results_immutable_delete before delete on story_knowledge_confirmation_results
  for each row execute function reject_immutable_change();

grant select, insert on story_knowledge_versions, story_bibles,
  story_knowledge_retry_results, story_knowledge_confirmation_results to novel_app;
grant select, insert, update on story_knowledge_heads to novel_app;
