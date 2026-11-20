begin;
do $$ begin
  if not exists(select 1 from pg_roles where rolname='novel_episode_alert_reader') then
    create role novel_episode_alert_reader nologin nosuperuser nocreatedb nocreaterole nobypassrls;
  end if;
end $$;
drop policy if exists episode_reconciliation_alert_reader on public.episode_reconciliation_alerts;
create policy episode_reconciliation_alert_reader on public.episode_reconciliation_alerts
  for select to novel_episode_alert_reader
  using (workspace_id=nullif(current_setting('app.episode_reconciliation_workspace_id',true),''));
grant usage on schema public to novel_episode_alert_reader;
grant select(workspace_id,task_id,code,created_at) on public.episode_reconciliation_alerts to novel_episode_alert_reader;
commit;
