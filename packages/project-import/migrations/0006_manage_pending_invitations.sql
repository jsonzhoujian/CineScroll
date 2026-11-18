create function list_pending_project_invitations(project text)
returns table(id uuid, "recipientUserId" text,role text,"expiresAt" timestamptz)
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if not can_manage_project(project) then
    raise exception 'project invitation management forbidden' using errcode='42501';
  end if;
  return query select i.id,i.invited_user_id,i.role,i.expires_at
    from project_invitations i where i.project_id=project and i.workspace_id=current_app_workspace_id()
      and i.accepted_at is null and i.revoked_at is null and i.expires_at>clock_timestamp()
    order by i.expires_at desc,i.id;
end $$;

create function revoke_pending_project_invitation(project text,invitation_id uuid)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare invitation project_invitations;
begin
  perform 1 from projects where id=project and workspace_id=current_app_workspace_id() for update;
  if not can_manage_project(project) then
    raise exception 'project invitation management forbidden' using errcode='42501';
  end if;
  select * into invitation from project_invitations
    where id=invitation_id and project_id=project and workspace_id=current_app_workspace_id() for update;
  if not found then raise exception 'invitation missing' using errcode='P7101'; end if;
  if invitation.accepted_at is not null or (invitation.revoked_at is null and invitation.expires_at<=clock_timestamp()) then
    raise exception 'invitation no longer pending' using errcode='P7102';
  end if;
  if invitation.revoked_at is null then
    update project_invitations set revoked_at=clock_timestamp() where id=invitation_id;
  end if;
end $$;

revoke all on function list_pending_project_invitations(text),revoke_pending_project_invitation(text,uuid) from public;
grant execute on function list_pending_project_invitations(text),revoke_pending_project_invitation(text,uuid) to novel_app;
