create function list_project_membership_audit(project text,before_id bigint)
returns table(id text,"actorId" text,"subjectId" text,action text,"previousRole" text,"newRole" text,"recordedAt" timestamptz)
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if not exists (select 1 from project_members m where m.project_id=project and m.workspace_id=current_app_workspace_id()
    and m.user_id=current_app_user_id() and m.role in ('owner','reviewer')) then
    raise exception 'membership audit forbidden' using errcode='42501';
  end if;
  return query select a.id::text,a.actor_id,a.subject_id,a.action,a.previous_role,a.new_role,a.recorded_at
    from project_membership_audit a where a.project_id=project and a.workspace_id=current_app_workspace_id() 
      and (before_id is null or a.id<before_id) order by a.id desc limit 51;
end $$;
revoke all on function list_project_membership_audit(text,bigint) from public;
grant execute on function list_project_membership_audit(text,bigint) to novel_app;
