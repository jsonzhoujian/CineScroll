create table project_invitations (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  project_id text not null,
  invited_user_id text not null,
  invited_by text not null,
  role text not null check (role in ('editor','reviewer')),
  expires_at timestamptz not null default (clock_timestamp() + interval '7 days'),
  accepted_at timestamptz,
  foreign key (project_id,workspace_id) references projects(id,workspace_id) on delete cascade
);
revoke all on project_invitations from public,novel_app;

create function issue_project_invitation(project text,recipient text,member_role text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare invitation project_invitations;
begin
  if not exists(select 1 from project_members where project_id=project
    and workspace_id=current_app_workspace_id() and user_id=current_app_user_id() and role='owner' for share) then
    raise exception 'project invitation forbidden' using errcode='42501';
  end if;
  if not exists(select 1 from identity_accounts where user_id=recipient and workspace_id=current_app_workspace_id()) then
    raise exception 'recipient missing' using errcode='P7101';
  end if;
  if exists(select 1 from project_members where project_id=project and user_id=recipient) then
    raise exception 'recipient already a member' using errcode='P7102';
  end if;
  insert into project_invitations(workspace_id,project_id,invited_user_id,invited_by,role)
    values(current_app_workspace_id(),project,recipient,current_app_user_id(),member_role) returning * into invitation;
  return jsonb_build_object('id',invitation.id,'projectId',project,'role',member_role,'expiresAt',invitation.expires_at);
end $$;

create function accept_project_invitation(invitation_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare invitation project_invitations; actual_role text;
begin
  select * into invitation from project_invitations
    where id=invitation_id and workspace_id=current_app_workspace_id() and invited_user_id=current_app_user_id() for update;
  if not found then raise exception 'invitation missing' using errcode='P7101'; end if;
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
  return jsonb_build_object('projectId',invitation.project_id,'role',actual_role);
end $$;

revoke all on function issue_project_invitation(text,text,text),accept_project_invitation(uuid) from public;
grant execute on function issue_project_invitation(text,text,text),accept_project_invitation(uuid) to novel_app;
