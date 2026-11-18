alter table storyboard_reconciliation_retains add column revision_value jsonb, add column revision_reason text;
alter table storyboard_reconciliation_retains add constraint storyboard_reconciliation_revision_valid check (
  (revision_value is null and revision_reason is null) or
  ((jsonb_typeof(revision_value)='object'
    and revision_value = jsonb_build_object('visual',revision_value->'visual','durationSeconds',revision_value->'durationSeconds')
    and jsonb_typeof(revision_value->'visual')='string' and length(btrim(revision_value->>'visual')) between 1 and 4000
    and case when jsonb_typeof(revision_value->'durationSeconds')='number'
      then (revision_value->>'durationSeconds')::numeric > 0 else false end
    and length(btrim(revision_reason)) between 1 and 1000) is true)
);
grant insert(revision_value,revision_reason) on storyboard_reconciliation_retains to novel_app;

create or replace function guard_storyboard_reconciliation_retain() returns trigger language plpgsql set search_path=public,pg_temp as $$
declare draft storyboard_reconciliations; shots jsonb;
begin
  select * into draft from storyboard_reconciliations
    where (workspace_id,project_id,chapter_id,id)=(new.workspace_id,new.project_id,new.chapter_id,new.reconciliation_id);
  if not found then raise exception 'storyboard reconciliation missing' using errcode='P7005'; end if;
  shots := assert_storyboard_reconciliation(draft);
  if not exists (select 1 from jsonb_array_elements(shots) shot where shot->>'id'=new.shot_id) then
    raise exception 'formal shot missing' using errcode='P7005';
  end if;
  if new.revision_value is not null and (
    select lock_op.command->>'kind'='lock'
    from storyboard_review_operations publication
    join storyboard_review_operations lock_op using(workspace_id,project_id,chapter_id,review_id)
    where (publication.workspace_id,publication.project_id,publication.chapter_id,publication.publication_id)
      = (draft.workspace_id,draft.project_id,draft.chapter_id,draft.base_publication_id)
      and lock_op.shot_id=new.shot_id and lock_op.command->>'kind' in ('lock','unlock')
    order by lock_op.revision desc limit 1
  ) then raise exception 'formal shot locked' using errcode='P7004'; end if;
  return new;
end $$;
