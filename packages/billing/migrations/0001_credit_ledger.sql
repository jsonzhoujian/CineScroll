-- Trusted migration administrator only; no automatic runtime migrations.
do $$ begin
  if not exists(select 1 from pg_roles where rolname='novel_billing') then
    create role novel_billing nologin nosuperuser nocreatedb nocreaterole nobypassrls;
  end if;
end $$;
grant usage on schema public to novel_billing;
create table if not exists public.credit_ledger_heads (
  workspace_id text primary key check(length(workspace_id) between 1 and 256),
  active_revision bigint check(active_revision between 1 and 9007199254740991)
);
create table if not exists public.credit_ledger_versions (
  workspace_id text not null references public.credit_ledger_heads(workspace_id),
  revision bigint not null check(revision between 1 and 9007199254740991),
  state_json jsonb not null,
  primary key(workspace_id,revision),
  check ((jsonb_typeof(state_json)='object'
    and state_json ?& array['revision','entries','tasks','events','evidence']
    and (state_json->>'revision')::numeric=revision
    and jsonb_typeof(state_json->'entries')='array' and jsonb_typeof(state_json->'tasks')='array'
    and jsonb_typeof(state_json->'events')='array' and jsonb_typeof(state_json->'evidence')='array') is true)
);
alter table public.credit_ledger_heads enable row level security;
alter table public.credit_ledger_heads force row level security;
alter table public.credit_ledger_versions enable row level security;
alter table public.credit_ledger_versions force row level security;
drop policy if exists credit_ledger_heads_scope on public.credit_ledger_heads;
drop policy if exists credit_ledger_versions_scope on public.credit_ledger_versions;
create policy credit_ledger_heads_scope on public.credit_ledger_heads to novel_billing
  using(workspace_id=current_setting('app.billing_workspace_id',true))
  with check(workspace_id=current_setting('app.billing_workspace_id',true));
create policy credit_ledger_versions_scope on public.credit_ledger_versions to novel_billing
  using(workspace_id=current_setting('app.billing_workspace_id',true))
  with check(workspace_id=current_setting('app.billing_workspace_id',true));
revoke all on public.credit_ledger_heads,public.credit_ledger_versions from public,novel_billing;
grant select,insert on public.credit_ledger_heads,public.credit_ledger_versions to novel_billing;
grant update(active_revision) on public.credit_ledger_heads to novel_billing;

create or replace function public.reject_credit_ledger_change() returns trigger language plpgsql as $$
begin raise exception 'immutable ledger version' using errcode='42501'; end $$;
drop trigger if exists credit_ledger_versions_immutable on public.credit_ledger_versions;
create trigger credit_ledger_versions_immutable before update or delete on public.credit_ledger_versions
  for each row execute function public.reject_credit_ledger_change();

create or replace function public.guard_credit_ledger_head() returns trigger language plpgsql as $$
declare
  previous jsonb;
  candidate jsonb;
  field text;
  old_task jsonb;
  new_task jsonb;
  old_unit jsonb;
  new_unit jsonb;
  n integer;
  m integer;
  entry jsonb;
  granted numeric := 0;
  reserved numeric := 0;
  consumed numeric := 0;
  released numeric := 0;
  amount numeric;
  quoted jsonb;
  unit_reserved numeric;
  unit_consumed numeric;
  unit_released numeric;
  task_id text;
  unit_id text;
  liability text;
begin
  if TG_OP='INSERT' then
    if new.active_revision is not null then raise exception 'initial head must be empty' using errcode='42501'; end if;
    return new;
  end if;
  if new.workspace_id is distinct from old.workspace_id or new.active_revision is null
    or new.active_revision is distinct from coalesce(old.active_revision,0)+1 then
    raise exception 'ledger revision must advance once' using errcode='42501';
  end if;
  select state_json into candidate from public.credit_ledger_versions where workspace_id=new.workspace_id and revision=new.active_revision;
  if candidate is null then raise exception 'missing ledger version' using errcode='42501'; end if;
  if octet_length(candidate::text)>2000000 then raise exception 'ledger snapshot too large' using errcode='42501'; end if;
  for entry in select value from jsonb_array_elements(candidate->'entries') loop
    if (jsonb_typeof(entry)='object' and entry ?& array['workspaceId','eventId','operation','amount','taskId','unitId','grantId','evidenceId','serviceId','createdAt']
      and jsonb_typeof(entry->'amount')='number' and jsonb_typeof(entry->'eventId')='string'
      and jsonb_typeof(entry->'serviceId')='string' and entry->>'operation' in ('grant','reserve','consume','release')) is not true then
      raise exception 'invalid ledger entry' using errcode='42501';
    end if;
    amount := (entry->>'amount')::numeric;
    if amount<=0 or amount<>trunc(amount) or amount>9007199254740991 then raise exception 'unsafe credit amount' using errcode='42501'; end if;
    case entry->>'operation'
      when 'grant' then granted := granted+amount;
      when 'reserve' then reserved := reserved+amount;
      when 'consume' then consumed := consumed+amount;
      when 'release' then released := released+amount;
    end case;
  end loop;
  if greatest(granted,reserved,consumed,released)>9007199254740991
    or reserved-consumed-released<0 or granted-reserved+released<0 then
    raise exception 'invalid credit balance' using errcode='42501';
  end if;
  if old.active_revision is null then
    previous := '{"entries":[],"events":[],"evidence":[],"tasks":[]}'::jsonb;
  else
    select state_json into previous from public.credit_ledger_versions where workspace_id=old.workspace_id and revision=old.active_revision;
    if previous is null then raise exception 'missing previous version' using errcode='42501'; end if;
  end if;
  foreach field in array array['entries','events','evidence'] loop
    if jsonb_array_length(candidate->field)<jsonb_array_length(previous->field)
      or exists(select 1 from jsonb_array_elements(previous->field) with ordinality p(value,ordinal)
        where p.value is distinct from (candidate->field)->(p.ordinal::integer-1)) then
      raise exception 'ledger history must be append-only' using errcode='42501';
    end if;
  end loop;
  if jsonb_array_length(candidate->'events')<>jsonb_array_length(previous->'events')+1
    or jsonb_array_length(candidate->'tasks')<jsonb_array_length(previous->'tasks') then
    raise exception 'invalid event or task advancement' using errcode='42501';
  end if;
  if (select count(*)<>count(distinct value->>'eventId') from jsonb_array_elements(candidate->'events'))
    or (select count(*)<>count(distinct value->>'id') from jsonb_array_elements(candidate->'evidence'))
    or (select count(*)<>count(distinct value->'snapshot'->>'taskId') from jsonb_array_elements(candidate->'tasks'))
    or (select count(*)<>count(distinct value->>'grantId') from jsonb_array_elements(candidate->'entries') where value->>'operation'='grant')
    or exists(select 1 from jsonb_array_elements(candidate->'entries') e where e->>'workspaceId' is distinct from new.workspace_id) then
    raise exception 'invalid ledger identity' using errcode='42501';
  end if;
  for n in 0..jsonb_array_length(candidate->'tasks')-1 loop
    new_task := (candidate->'tasks')->n;
    if (jsonb_typeof(new_task->'snapshot')='object' and jsonb_typeof(new_task->'units')='array'
      and jsonb_typeof(new_task->'snapshot'->'units')='array'
      and new_task->'snapshot'->>'responsibility' in ('platform','byok')) is not true then
      raise exception 'invalid billing task' using errcode='42501';
    end if;
    task_id := new_task->'snapshot'->>'taskId'; liability := new_task->'snapshot'->>'responsibility';
    if jsonb_array_length(new_task->'units') not between 1 and 100
      or jsonb_array_length(new_task->'units')<>jsonb_array_length(new_task->'snapshot'->'units')
      or (select count(*)<>count(distinct value->>'id') from jsonb_array_elements(new_task->'units')) then
      raise exception 'invalid billing unit identity' using errcode='42501';
    end if;
    for m in 0..jsonb_array_length(new_task->'units')-1 loop
      new_unit := (new_task->'units')->m; quoted := (new_task->'snapshot'->'units')->m;
      if (jsonb_typeof(new_unit->'reserved')='number' and jsonb_typeof(new_unit->'consumed')='number'
        and jsonb_typeof(new_unit->'released')='number'
        and new_unit->>'state' in ('reserved','reconciling','consumed','released','closed','exempt')) is not true
        or new_unit->'id' is distinct from quoted->'id' or new_unit->'reserved' is distinct from quoted->'reserved' then
        raise exception 'invalid billing unit' using errcode='42501';
      end if;
      unit_id := new_unit->>'id';
      unit_reserved := (new_unit->>'reserved')::numeric;
      unit_consumed := (new_unit->>'consumed')::numeric; unit_released := (new_unit->>'released')::numeric;
      if least(unit_reserved,unit_consumed,unit_released)<0 or greatest(unit_reserved,unit_consumed,unit_released)>9007199254740991
        or unit_reserved<>trunc(unit_reserved) or unit_consumed<>trunc(unit_consumed) or unit_released<>trunc(unit_released)
        or unit_consumed+unit_released>unit_reserved
        or (liability='byok' and (unit_reserved<>0 or new_unit->>'state'<>'exempt'))
        or (liability='platform' and (unit_reserved=0 or new_unit->>'state'='exempt'))
        or (n>=jsonb_array_length(previous->'tasks') and (unit_consumed<>0 or unit_released<>0
          or new_unit->>'state'<>case when liability='byok' then 'exempt' else 'reserved' end)) then
        raise exception 'unsafe billing unit amounts' using errcode='42501';
      end if;
      if unit_reserved<>(select coalesce(sum((value->>'amount')::numeric),0) from jsonb_array_elements(candidate->'entries')
          where value->>'taskId'=task_id and value->>'unitId'=unit_id and value->>'operation'='reserve')
        or unit_consumed<>(select coalesce(sum((value->>'amount')::numeric),0) from jsonb_array_elements(candidate->'entries')
          where value->>'taskId'=task_id and value->>'unitId'=unit_id and value->>'operation'='consume')
        or unit_released<>(select coalesce(sum((value->>'amount')::numeric),0) from jsonb_array_elements(candidate->'entries')
          where value->>'taskId'=task_id and value->>'unitId'=unit_id and value->>'operation'='release') then
        raise exception 'unit must match ledger entries' using errcode='42501';
      end if;
    end loop;
  end loop;
  for n in 0..jsonb_array_length(previous->'tasks')-1 loop
    old_task := (previous->'tasks')->n; new_task := (candidate->'tasks')->n;
    if old_task->'snapshot' is distinct from new_task->'snapshot'
      or jsonb_array_length(old_task->'units')<>jsonb_array_length(new_task->'units') then
      raise exception 'immutable billing snapshot' using errcode='42501';
    end if;
    for m in 0..jsonb_array_length(old_task->'units')-1 loop
      old_unit := (old_task->'units')->m; new_unit := (new_task->'units')->m;
      if (jsonb_typeof(new_unit->'consumed')='number' and jsonb_typeof(new_unit->'released')='number'
        and new_unit->>'state' in ('reserved','reconciling','consumed','released','closed','exempt')
        and (new_unit->>'consumed')::numeric>=0 and (new_unit->>'released')::numeric>=0
        and (new_unit->>'consumed')::numeric+(new_unit->>'released')::numeric<=(new_unit->>'reserved')::numeric) is not true
        or old_unit->'id' is distinct from new_unit->'id' or old_unit->'reserved' is distinct from new_unit->'reserved'
        or (new_unit->>'consumed')::numeric<(old_unit->>'consumed')::numeric
        or (new_unit->>'released')::numeric<(old_unit->>'released')::numeric
        or (old_unit->>'state' in ('consumed','released','closed','exempt') and old_unit is distinct from new_unit) then
        raise exception 'invalid settlement transition' using errcode='42501';
      end if;
    end loop;
  end loop;
  return new;
end $$;
drop trigger if exists credit_ledger_head_transition on public.credit_ledger_heads;
create trigger credit_ledger_head_transition before insert or update on public.credit_ledger_heads
  for each row execute function public.guard_credit_ledger_head();
revoke all on function public.reject_credit_ledger_change(),public.guard_credit_ledger_head() from public,novel_billing;
