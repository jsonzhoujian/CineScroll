-- Trusted migration administrator only; never run automatically at runtime.
do $$ begin
  if not exists(select 1 from pg_roles where rolname='novel_evidence') then
    create role novel_evidence nologin nosuperuser nocreatedb nocreaterole nobypassrls;
  end if;
end $$;
grant usage on schema public to novel_evidence;
revoke create on schema public from novel_evidence;

create table if not exists public.evidence_material (
  workspace_id text not null check(length(workspace_id) between 1 and 256),
  evidence_id text not null check(length(evidence_id) between 1 and 256),
  material jsonb not null,
  fingerprint text not null check(fingerprint ~ '^[a-f0-9]{64}$'),
  predecessor_id text,
  primary key(workspace_id,evidence_id),
  foreign key(workspace_id,predecessor_id) references public.evidence_material(workspace_id,evidence_id),
  check(predecessor_id is distinct from evidence_id),
  check((jsonb_typeof(material)='object' and material->>'id'=evidence_id
    and material->'binding'->>'workspaceId'=workspace_id and octet_length(material::text)<=2000000) is true)
);
alter table public.evidence_material enable row level security;
alter table public.evidence_material force row level security;
drop policy if exists evidence_material_scope on public.evidence_material;
create policy evidence_material_scope on public.evidence_material to novel_evidence
  using(workspace_id=current_setting('app.evidence_workspace_id',true))
  with check(workspace_id=current_setting('app.evidence_workspace_id',true));
revoke all on public.evidence_material from public,novel_evidence;
grant select,insert on public.evidence_material to novel_evidence;

create or replace function public.guard_evidence_material() returns trigger language plpgsql
set search_path=pg_catalog as $$
declare previous jsonb;
begin
  if tg_op <> 'INSERT' then raise exception 'immutable evidence' using errcode='P0001'; end if;
  if new.predecessor_id is not null then
    select material into previous from public.evidence_material where workspace_id=new.workspace_id and evidence_id=new.predecessor_id;
    if not found then raise exception 'missing predecessor' using errcode='P0002'; end if;
    if (previous->'binding'=new.material->'binding' and previous->'snapshot'=new.material->'snapshot'
      and previous->'execution'->>'id'=new.material->'execution'->>'id') is not true then
      raise exception 'conflicting predecessor' using errcode='P0001';
    end if;
  end if;
  return new;
end $$;
revoke all on function public.guard_evidence_material() from public,novel_evidence;
drop trigger if exists evidence_material_guard on public.evidence_material;
create trigger evidence_material_guard before insert or update or delete on public.evidence_material
  for each row execute function public.guard_evidence_material();
