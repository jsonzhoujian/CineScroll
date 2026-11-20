-- Apply after the submission outbox migration.
begin;
do $$ begin
  if not exists(select 1 from pg_roles where rolname='novel_episode_outbox_consumer') then
    create role novel_episode_outbox_consumer nologin nosuperuser nocreatedb nocreaterole nobypassrls;
  end if;
end $$;

alter table public.episode_submission_outbox
  add column if not exists lease_token uuid,
  add column if not exists lease_until timestamptz,
  add column if not exists dispatched_at timestamptz;
alter table public.episode_submission_outbox drop constraint if exists episode_outbox_lease_state;
alter table public.episode_submission_outbox add constraint episode_outbox_lease_state check (
  (lease_token is null)=(lease_until is null) and (dispatched_at is null or lease_token is null)
);
create index if not exists episode_outbox_pending on public.episode_submission_outbox(workspace_id,created_at,task_id)
  where dispatched_at is null;

drop policy if exists episode_outbox_consumer_read on public.episode_submission_outbox;
create policy episode_outbox_consumer_read on public.episode_submission_outbox for select to novel_episode_outbox_consumer
  using (workspace_id=nullif(current_setting('app.episode_outbox_workspace_id',true),''));
drop policy if exists episode_outbox_consumer_update on public.episode_submission_outbox;
create policy episode_outbox_consumer_update on public.episode_submission_outbox for update to novel_episode_outbox_consumer
  using (workspace_id=nullif(current_setting('app.episode_outbox_workspace_id',true),'') and dispatched_at is null)
  with check (workspace_id=nullif(current_setting('app.episode_outbox_workspace_id',true),''));

grant usage on schema public to novel_episode_outbox_consumer;
grant select(workspace_id,task_id,created_at,lease_token,lease_until,dispatched_at),
  update(lease_token,lease_until,dispatched_at) on public.episode_submission_outbox to novel_episode_outbox_consumer;
commit;
