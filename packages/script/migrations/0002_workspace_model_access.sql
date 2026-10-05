-- Manual administration only: novel_app cannot create membership or grant subscriptions.
create table if not exists workspace_model_members (
  workspace_id text not null,
  user_id text not null,
  role text not null check (role in ('owner','editor','reviewer')),
  active boolean not null default true,
  primary key (workspace_id,user_id)
);
create unique index if not exists workspace_model_single_owner_idx on workspace_model_members(workspace_id)
  where role='owner' and active;
create table if not exists workspace_model_entitlements (
  workspace_id text primary key,
  plan text not null check (plan in ('studio','advanced')),
  enabled boolean not null default false,
  starts_at timestamptz not null,
  expires_at timestamptz not null,
  check (expires_at>starts_at)
);
alter table workspace_model_members enable row level security;
alter table workspace_model_members force row level security;
alter table workspace_model_entitlements enable row level security;
alter table workspace_model_entitlements force row level security;
drop policy if exists workspace_model_members_read on workspace_model_members;
create policy workspace_model_members_read on workspace_model_members for select using (
  workspace_id=nullif(current_setting('app.model_workspace_id',true),'')
  and user_id=nullif(current_setting('app.model_user_id',true),'') and active
);
drop policy if exists workspace_model_entitlements_read on workspace_model_entitlements;
create policy workspace_model_entitlements_read on workspace_model_entitlements for select using (
  workspace_id=nullif(current_setting('app.model_workspace_id',true),'') and exists (
    select 1 from workspace_model_members m where m.workspace_id=workspace_model_entitlements.workspace_id
      and m.user_id=nullif(current_setting('app.model_user_id',true),'') and m.active
  )
);
grant select on workspace_model_members,workspace_model_entitlements to novel_app;
