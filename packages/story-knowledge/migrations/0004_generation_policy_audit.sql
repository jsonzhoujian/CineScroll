create table if not exists generation_policy_audit (
  id bigint generated always as identity primary key,
  workspace_id text not null,
  project_id text not null,
  chapter_id text,
  source_version_id text,
  target text not null check (target in ('project','source')),
  operation text not null check (operation in ('INSERT','UPDATE','DELETE')),
  old_state text,
  new_state text,
  session_actor text not null,
  effective_actor text not null,
  occurred_at timestamptz not null default clock_timestamp(),
  transaction_id bigint not null default txid_current(),
  check ((target='project' and chapter_id is null and source_version_id is null)
    or (target='source' and chapter_id is not null and source_version_id is not null)),
  check ((operation='INSERT' and old_state is null and new_state is not null)
    or (operation='UPDATE' and old_state is not null and new_state is not null and old_state<>new_state)
    or (operation='DELETE' and old_state is not null and new_state is null))
);
-- Deliberately no FK: project/source cascade deletion must not delete its audit evidence.
create index if not exists generation_policy_audit_scope_idx on generation_policy_audit(workspace_id,project_id,id);
alter table generation_policy_audit enable row level security;
alter table generation_policy_audit force row level security;
drop policy if exists generation_policy_audit_read on generation_policy_audit;
create policy generation_policy_audit_read on generation_policy_audit for select to novel_app
  using (workspace_id=current_app_workspace_id() and can_access_project(project_id));
revoke all on generation_policy_audit from public,novel_app;
revoke all on sequence generation_policy_audit_id_seq from public,novel_app;
grant select on generation_policy_audit to novel_app;

-- SECURITY INVOKER preserves the real effective database role and fails closed
-- unless the trusted maintainer also has audit INSERT/sequence privileges.
create or replace function audit_generation_policy_change() returns trigger
language plpgsql set search_path=pg_catalog as $$
declare snapshot jsonb; before_state text; after_state text; kind text;
begin
  kind := case when TG_TABLE_NAME='project_generation_policy' then 'project' else 'source' end;
  if TG_OP='UPDATE' then
    if NEW.workspace_id is distinct from OLD.workspace_id or NEW.project_id is distinct from OLD.project_id
      or (kind='source' and (to_jsonb(NEW)->>'chapter_id' is distinct from to_jsonb(OLD)->>'chapter_id'
        or to_jsonb(NEW)->>'source_version_id' is distinct from to_jsonb(OLD)->>'source_version_id')) then
      raise exception 'policy identity is immutable' using errcode='23514';
    end if;
    if NEW.state is not distinct from OLD.state then return NEW; end if;
  end if;
  if TG_OP='DELETE' then snapshot:=to_jsonb(OLD); else snapshot:=to_jsonb(NEW); end if;
  if TG_OP<>'INSERT' then before_state:=OLD.state; end if;
  if TG_OP<>'DELETE' then after_state:=NEW.state; end if;
  insert into public.generation_policy_audit
    (workspace_id,project_id,chapter_id,source_version_id,target,operation,old_state,new_state,session_actor,effective_actor)
    values(snapshot->>'workspace_id',snapshot->>'project_id',snapshot->>'chapter_id',snapshot->>'source_version_id',
      kind,TG_OP,before_state,after_state,session_user,current_user);
  return null;
end $$;
revoke all on function audit_generation_policy_change() from public,novel_app;
drop trigger if exists generation_policy_audit on project_generation_policy;
create trigger generation_policy_audit after insert or update or delete on project_generation_policy
  for each row execute function audit_generation_policy_change();
drop trigger if exists generation_policy_audit on source_generation_policy;
create trigger generation_policy_audit after insert or update or delete on source_generation_policy
  for each row execute function audit_generation_policy_change();

create or replace function reject_generation_audit_mutation() returns trigger
language plpgsql set search_path=pg_catalog as $$
begin raise exception 'generation policy audit is append-only' using errcode='42501'; end $$;
revoke all on function reject_generation_audit_mutation() from public,novel_app;
drop trigger if exists generation_audit_immutable on generation_policy_audit;
create trigger generation_audit_immutable before update or delete on generation_policy_audit
  for each row execute function reject_generation_audit_mutation();
drop trigger if exists generation_audit_no_truncate on generation_policy_audit;
create trigger generation_audit_no_truncate before truncate on generation_policy_audit
  for each statement execute function reject_generation_audit_mutation();
drop trigger if exists generation_policy_no_truncate on project_generation_policy;
create trigger generation_policy_no_truncate before truncate on project_generation_policy
  for each statement execute function reject_generation_audit_mutation();
drop trigger if exists generation_policy_no_truncate on source_generation_policy;
create trigger generation_policy_no_truncate before truncate on source_generation_policy
  for each statement execute function reject_generation_audit_mutation();
