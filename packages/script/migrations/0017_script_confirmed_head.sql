-- Trusted-owner migration only. Formal content remains independently addressable.
alter table script_content_heads add column confirmed_version_id text;
alter table script_content_heads add constraint script_content_confirmed_version_fk
  foreign key(workspace_id,project_id,chapter_id,confirmed_version_id)
  references script_content_versions(workspace_id,project_id,chapter_id,id);
-- Disable only the transition trigger while backfilling an unchanged active head.
alter table script_content_heads disable trigger script_content_head_transition;
update script_content_heads h set confirmed_version_id=v.id from script_content_versions v
where v.workspace_id=h.workspace_id and v.project_id=h.project_id and v.chapter_id=h.chapter_id
  and v.id=h.active_version_id and v.version_json->>'status'='confirmed';
alter table script_content_heads enable trigger script_content_head_transition;
create or replace function guard_script_content_head() returns trigger language plpgsql as $$
declare target jsonb;
begin
  if new.active_version_id is not null then
    select version_json into target from script_content_versions v
      where v.workspace_id=new.workspace_id and v.project_id=new.project_id and v.chapter_id=new.chapter_id and v.id=new.active_version_id
        and v.parent_version_id is not distinct from (case when TG_OP='UPDATE' then old.active_version_id else null end);
    if target is null then raise exception 'invalid script head transition' using errcode='42501'; end if;
  end if;
  if TG_OP='UPDATE' and old.active_version_id is not null and new.active_version_id is null then
    raise exception 'script head cannot be cleared' using errcode='42501';
  end if;
  if target->>'status'='confirmed' then
    new.confirmed_version_id := new.active_version_id;
  else
    new.confirmed_version_id := case when TG_OP='UPDATE' then old.confirmed_version_id else null end;
  end if;
  return new;
end $$;
-- confirmed_version_id intentionally has no application UPDATE grant.
