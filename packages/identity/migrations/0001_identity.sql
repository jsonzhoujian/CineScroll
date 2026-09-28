create table if not exists identity_accounts (
  user_id text primary key,
  workspace_id text not null unique,
  phone text unique,
  wechat_open_id text unique,
  wechat_union_id text unique,
  check (phone is not null or wechat_open_id is not null)
);
create unique index if not exists identity_accounts_actor_idx on identity_accounts (user_id, workspace_id);

create table if not exists login_challenges (
  id text primary key,
  kind text not null check (kind in ('phone', 'wechat')),
  phone text,
  redirect_uri text,
  bind_user_id text,
  bind_workspace_id text,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  failed_attempts integer not null default 0 check (failed_attempts between 0 and 5),
  check (
    (kind = 'phone' and phone is not null and redirect_uri is null and bind_user_id is null and bind_workspace_id is null)
    or
    (kind = 'wechat' and phone is null and redirect_uri is not null
      and ((bind_user_id is null and bind_workspace_id is null) or (bind_user_id is not null and bind_workspace_id is not null)))
  ),
  foreign key (bind_user_id, bind_workspace_id) references identity_accounts(user_id, workspace_id)
);
create index if not exists login_challenges_expires_idx on login_challenges (expires_at);

create table if not exists login_rate_limits (
  action text not null check (action in ('send', 'verify')),
  dimension text not null check (dimension in ('phone', 'ip', 'device')),
  key_hash text not null,
  window_started_at timestamptz not null,
  request_count integer not null check (request_count > 0),
  primary key (action, dimension, key_hash)
);

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'novel_app') then
    create role novel_app nologin;
  end if;
end $$;

grant usage on schema public to novel_app;
grant select, insert, update on identity_accounts, login_challenges, login_rate_limits to novel_app;
