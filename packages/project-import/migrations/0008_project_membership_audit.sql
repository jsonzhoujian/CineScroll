create table project_membership_audit (
  id bigint generated always as identity primary key,
  workspace_id text not null, project_id text not null,
  actor_id text not null, subject_id text not null,
  action text not null,
  previous_role text, new_role text,
  recorded_at timestamptz not null default clock_timestamp()
);
create index project_membership_audit_recent on project_membership_audit(workspace_id,project_id,id desc);
revoke all on project_membership_audit from public,novel_app;

create function record_project_membership_change()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if tg_op='INSERT' then
    insert into project_membership_audit(workspace_id,project_id,actor_id,subject_id,action,new_role)
      values(new.workspace_id,new.project_id,current_app_user_id(),new.user_id,'member_added',new.role);
  elsif tg_op='UPDATE' and old.role is distinct from new.role then
    insert into project_membership_audit(workspace_id,project_id,actor_id,subject_id,action,previous_role,new_role)
      values(new.workspace_id,new.project_id,current_app_user_id(),new.user_id,'role_changed',old.role,new.role);
  elsif tg_op='DELETE' then
    insert into project_membership_audit(workspace_id,project_id,actor_id,subject_id,action,previous_role)
      values(old.workspace_id,old.project_id,current_app_user_id(),old.user_id,'member_removed',old.role);
  end if;
  return null;
end $$;

create function record_project_invitation_change()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare event_action text;
begin
  if tg_op='INSERT' then event_action := 'invitation_issued';
  elsif old.accepted_at is null and new.accepted_at is not null then event_action := 'invitation_accepted';
  elsif old.revoked_at is null and new.revoked_at is not null then event_action := 'invitation_revoked';
  end if;
  if event_action is not null then
    insert into project_membership_audit(workspace_id,project_id,actor_id,subject_id,action,new_role)
      values(new.workspace_id,new.project_id,current_app_user_id(),new.invited_user_id,event_action,new.role);
  end if;
  return null;
end $$;

-- Maintenance runs without an authenticated actor.
create trigger project_membership_change_audit after insert or update or delete on project_members
  for each row when (current_app_user_id() is not null and current_app_user_id()<>'')
  execute function record_project_membership_change();
create trigger project_invitation_change_audit after insert or update on project_invitations
  for each row when (current_app_user_id() is not null and current_app_user_id()<>'')
  execute function record_project_invitation_change();
revoke all on function record_project_membership_change(),record_project_invitation_change() from public;

create function list_project_membership_audit(project text)
returns table(id text,"actorId" text,"subjectId" text,action text,"previousRole" text,"newRole" text,"recordedAt" timestamptz)
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if not exists (select 1 from project_members m where m.project_id=project and m.workspace_id=current_app_workspace_id()
    and m.user_id=current_app_user_id() and m.role in ('owner','reviewer')) then
    raise exception 'membership audit forbidden' using errcode='42501';
  end if;
  return query select a.id::text,a.actor_id,a.subject_id,a.action,a.previous_role,a.new_role,a.recorded_at
    from project_membership_audit a where a.project_id=project and a.workspace_id=current_app_workspace_id() order by a.id desc limit 50;
end $$;
revoke all on function list_project_membership_audit(text) from public;
grant execute on function list_project_membership_audit(text) to novel_app;
