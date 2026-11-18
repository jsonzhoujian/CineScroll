create function list_received_project_invitations()
returns table(id uuid,"projectId" text,"projectTitle" text,role text,"expiresAt" timestamptz)
language sql security definer set search_path=public,pg_temp as $$
  select i.id,p.id,p.title,i.role,i.expires_at
  from project_invitations i
  join projects p on (p.id,p.workspace_id)=(i.project_id,i.workspace_id)
  join project_members issuer on (issuer.project_id,issuer.workspace_id,issuer.user_id)
    =(i.project_id,i.workspace_id,i.invited_by) and issuer.role='owner'
  where i.invited_user_id=current_app_user_id()
    and i.accepted_at is null and i.revoked_at is null and i.expires_at>clock_timestamp()
  order by i.expires_at desc,i.id
$$;
revoke all on function list_received_project_invitations() from public;
grant execute on function list_received_project_invitations() to novel_app;
