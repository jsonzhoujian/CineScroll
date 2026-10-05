-- Requires the existing novel_app server role. Not a browser-accessible credential store.
create table if not exists model_settings_versions (
  workspace_id text not null,
  id text not null,
  parent_version_id text,
  configuration jsonb not null,
  created_at timestamptz not null default now(),
  primary key (workspace_id,id),
  foreign key (workspace_id,parent_version_id) references model_settings_versions(workspace_id,id),
  check (jsonb_typeof(configuration)='object'),
  check (configuration ?& array['workspaceId','id','parentVersionId','ciphertext','nonce','tag','createdBy']),
  check (jsonb_typeof(configuration->'workspaceId')='string' and configuration->>'workspaceId' is not null),
  check (jsonb_typeof(configuration->'id')='string' and configuration->>'id' is not null),
  check (jsonb_typeof(configuration->'ciphertext')='string' and configuration->>'ciphertext' is not null),
  check (jsonb_typeof(configuration->'nonce')='string' and configuration->>'nonce' is not null),
  check (jsonb_typeof(configuration->'tag')='string' and configuration->>'tag' is not null),
  check (jsonb_typeof(configuration->'createdBy')='string' and configuration->>'createdBy' is not null),
  check (configuration->>'workspaceId'=workspace_id and configuration->>'id'=id),
  check ((configuration->>'parentVersionId') is not distinct from parent_version_id)
);
create index if not exists model_settings_versions_parent_idx on model_settings_versions(workspace_id,parent_version_id);
create table if not exists model_settings_heads (
  workspace_id text primary key,
  active_version_id text,
  foreign key (workspace_id,active_version_id) references model_settings_versions(workspace_id,id)
);
create table if not exists model_settings_audit (
  workspace_id text not null,
  version_id text not null,
  actor_id text not null,
  operation text not null check (operation in ('configured','connection_tested')),
  created_at timestamptz not null default now(),
  primary key (workspace_id,version_id),
  foreign key (workspace_id,version_id) references model_settings_versions(workspace_id,id)
);
alter table model_settings_versions enable row level security;
alter table model_settings_versions force row level security;
alter table model_settings_heads enable row level security;
alter table model_settings_heads force row level security;
alter table model_settings_audit enable row level security;
alter table model_settings_audit force row level security;
drop policy if exists model_settings_versions_access on model_settings_versions;
create policy model_settings_versions_access on model_settings_versions
  using (workspace_id=nullif(current_setting('app.model_workspace_id',true),''))
  with check (workspace_id=nullif(current_setting('app.model_workspace_id',true),''));
drop policy if exists model_settings_heads_access on model_settings_heads;
create policy model_settings_heads_access on model_settings_heads
  using (workspace_id=nullif(current_setting('app.model_workspace_id',true),''))
  with check (workspace_id=nullif(current_setting('app.model_workspace_id',true),''));
drop policy if exists model_settings_audit_access on model_settings_audit;
create policy model_settings_audit_access on model_settings_audit
  using (workspace_id=nullif(current_setting('app.model_workspace_id',true),''))
  with check (workspace_id=nullif(current_setting('app.model_workspace_id',true),''));
create or replace function reject_model_settings_mutation() returns trigger language plpgsql as $$
begin raise exception 'model configuration history and audit are append-only'; end
$$;
drop trigger if exists model_settings_versions_immutable on model_settings_versions;
create trigger model_settings_versions_immutable before update or delete on model_settings_versions
  for each row execute function reject_model_settings_mutation();
drop trigger if exists model_settings_audit_immutable on model_settings_audit;
create trigger model_settings_audit_immutable before update or delete on model_settings_audit
  for each row execute function reject_model_settings_mutation();
grant select,insert on model_settings_versions,model_settings_audit to novel_app;
grant select,insert,update on model_settings_heads to novel_app;
