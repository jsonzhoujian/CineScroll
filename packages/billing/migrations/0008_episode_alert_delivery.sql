begin;
do $$ begin
  if not exists(select 1 from pg_roles where rolname='novel_episode_alert_delivery') then
    create role novel_episode_alert_delivery nologin nosuperuser nocreatedb nocreaterole nobypassrls;
  end if;
end $$;

create table if not exists public.episode_alert_deliveries (
  workspace_id text not null,
  task_id text not null,
  code text not null,
  channel text not null check(channel='feishu'),
  status text not null check(status in ('unknown','delivered','retryable','rejected','exhausted')),
  attempts integer not null check(attempts between 1 and 5),
  attempted_at timestamptz not null default clock_timestamp(),
  retry_at timestamptz,
  primary key(workspace_id,task_id,code,channel),
  foreign key(workspace_id,task_id,code) references public.episode_reconciliation_alerts(workspace_id,task_id,code),
  check((status='retryable')=(retry_at is not null))
);
alter table public.episode_alert_deliveries enable row level security;
alter table public.episode_alert_deliveries force row level security;
drop policy if exists alert_delivery_workspace on public.episode_alert_deliveries;
create policy alert_delivery_workspace on public.episode_alert_deliveries to novel_episode_alert_delivery
  using(workspace_id=nullif(current_setting('app.episode_alert_delivery_workspace_id',true),''))
  with check(workspace_id=nullif(current_setting('app.episode_alert_delivery_workspace_id',true),''));
drop policy if exists alert_delivery_source on public.episode_reconciliation_alerts;
create policy alert_delivery_source on public.episode_reconciliation_alerts for select to novel_episode_alert_delivery
  using(workspace_id=nullif(current_setting('app.episode_alert_delivery_workspace_id',true),''));
revoke all on public.episode_alert_deliveries from public;
grant usage on schema public to novel_episode_alert_delivery;
grant select(workspace_id,task_id,code,created_at) on public.episode_reconciliation_alerts to novel_episode_alert_delivery;
grant select on public.episode_alert_deliveries to novel_episode_alert_delivery;
grant insert(workspace_id,task_id,code,channel,status,attempts),
  update(status,attempts,attempted_at,retry_at) on public.episode_alert_deliveries to novel_episode_alert_delivery;
commit;
