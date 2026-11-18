alter table project_invitations add column revoked_at timestamptz;

create function change_project_member(project text,recipient text,expected_role text,new_role text)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare actual_role text;
begin
  perform 1 from projects where id=project and workspace_id=current_app_workspace_id() for update;
  if not can_manage_project(project) then
    raise exception 'project member management forbidden' using errcode='42501';
  end if;
  select role into actual_role from project_members
    where project_id=project and workspace_id=current_app_workspace_id() and user_id=recipient for update;
  if actual_role is null then raise exception 'member missing' using errcode='P7101'; end if;
  if actual_role='owner' or actual_role is distinct from expected_role
    or (new_role is not null and new_role not in ('editor','reviewer')) then
    raise exception 'membership changed or immutable' using errcode='P7102';
  end if;
  if new_role is null then
    update project_invitations set revoked_at=clock_timestamp()
      where project_id=project and workspace_id=current_app_workspace_id() and invited_user_id=recipient and revoked_at is null;
    delete from project_members where project_id=project and workspace_id=current_app_workspace_id() and user_id=recipient;
  else
    update project_members set role=new_role
      where project_id=project and workspace_id=current_app_workspace_id() and user_id=recipient;
  end if;
end $$;
revoke all on function change_project_member(text,text,text,text) from public;
grant execute on function change_project_member(text,text,text,text) to novel_app;

create or replace function issue_project_invitation(project text,recipient text,member_role text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare invitation project_invitations;
begin
  perform 1 from projects where id=project and workspace_id=current_app_workspace_id() for update;
  if not exists(select 1 from project_members where project_id=project
    and workspace_id=current_app_workspace_id() and user_id=current_app_user_id() and role='owner' for share) then
    raise exception 'project invitation forbidden' using errcode='42501';
  end if;
  if not exists(select 1 from identity_accounts where user_id=recipient) then
    raise exception 'recipient missing' using errcode='P7101';
  end if;
  if exists(select 1 from project_members where project_id=project and user_id=recipient) then
    raise exception 'recipient already a member' using errcode='P7102';
  end if;
  insert into project_invitations(workspace_id,project_id,invited_user_id,invited_by,role)
    values(current_app_workspace_id(),project,recipient,current_app_user_id(),member_role) returning * into invitation;
  return jsonb_build_object('id',invitation.id,'projectId',project,'role',member_role,'expiresAt',invitation.expires_at);
end $$;

create or replace function accept_project_invitation(invitation_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare invitation project_invitations; actual_role text;
begin
  perform 1 from projects p join project_invitations i on (i.project_id,i.workspace_id)=(p.id,p.workspace_id)
    where i.id=invitation_id and i.invited_user_id=current_app_user_id() for update of p;
  select * into invitation from project_invitations
    where id=invitation_id and invited_user_id=current_app_user_id() for update;
  if not found then raise exception 'invitation missing' using errcode='P7101'; end if;
  if invitation.revoked_at is not null then raise exception 'invitation revoked' using errcode='P7102'; end if;
  if invitation.accepted_at is null then
    if invitation.expires_at <= clock_timestamp() or not exists (
      select 1 from project_members where project_id=invitation.project_id and workspace_id=invitation.workspace_id
        and user_id=invitation.invited_by and role='owner' for share
    ) then raise exception 'invitation expired or withdrawn' using errcode='P7102'; end if;
    insert into project_members(project_id,workspace_id,user_id,role)
      values(invitation.project_id,invitation.workspace_id,invitation.invited_user_id,invitation.role)
      on conflict(project_id,user_id) do nothing;
  end if;
  select role into actual_role from project_members
    where project_id=invitation.project_id and workspace_id=invitation.workspace_id and user_id=invitation.invited_user_id for share;
  if actual_role is distinct from invitation.role then
    raise exception 'project membership changed' using errcode='P7102';
  end if;
  if invitation.accepted_at is null then
    update project_invitations set accepted_at=clock_timestamp() where id=invitation_id;
  end if;
  return jsonb_build_object('projectId',invitation.project_id,'role',actual_role,'workspaceId',invitation.workspace_id);
end $$;

