-- Each account keeps one workspace. Project membership grants access within it.
alter table identity_accounts drop constraint if exists identity_accounts_workspace_id_key;
