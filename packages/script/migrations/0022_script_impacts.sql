-- Trusted owner only. T07 writers register dependencies in the transaction that saves downstream content.
create table script_downstream_dependencies (
 workspace_id text not null,project_id text not null,chapter_id text not null,
 target_stage text not null check(target_stage in ('settings','storyboard')),target_version_id text not null,target_item_id text not null,
 script_version_id text not null,script_element_id text not null,
 primary key(workspace_id,project_id,chapter_id,target_stage,target_version_id,target_item_id,script_version_id,script_element_id),
 foreign key(workspace_id,project_id,chapter_id,script_version_id) references script_content_versions(workspace_id,project_id,chapter_id,id)
);
create table script_impact_links (
 workspace_id text not null,project_id text not null,chapter_id text not null,
 confirmed_version_id text not null,source_version_id text not null,source_element_id text not null,
 target_stage text not null,target_version_id text not null,target_item_id text not null,
 status text not null default 'unreviewed' check(status='unreviewed'),
 primary key(workspace_id,project_id,chapter_id,confirmed_version_id,source_version_id,source_element_id,target_stage,target_version_id,target_item_id),
 foreign key(workspace_id,project_id,chapter_id,confirmed_version_id) references script_content_versions(workspace_id,project_id,chapter_id,id),
 foreign key(workspace_id,project_id,chapter_id,source_version_id) references script_content_versions(workspace_id,project_id,chapter_id,id)
);
alter table script_downstream_dependencies enable row level security;
alter table script_downstream_dependencies force row level security;
alter table script_impact_links enable row level security;
alter table script_impact_links force row level security;
create policy script_dependencies_read on script_downstream_dependencies for select using(workspace_id=current_app_workspace_id() and can_access_project(project_id));
create policy script_impacts_read on script_impact_links for select using(workspace_id=current_app_workspace_id() and can_access_project(project_id));
create policy script_impacts_insert on script_impact_links for insert with check(workspace_id=current_app_workspace_id() and can_review_project(project_id));
create trigger script_dependencies_immutable before update or delete on script_downstream_dependencies for each row execute function reject_immutable_change();
create trigger script_impacts_immutable before update or delete on script_impact_links for each row execute function reject_immutable_change();
revoke all on script_downstream_dependencies,script_impact_links from public,novel_app;
grant select on script_downstream_dependencies to novel_app;
grant select,insert on script_impact_links to novel_app;
create function record_script_impacts() returns trigger language plpgsql as $$
begin
 if new.version_json->>'status'='confirmed' and new.version_json->'publicationOperation'->>'kind'='confirm' and new.version_json ? 'revisionOfVersionId' then
  insert into script_impact_links(workspace_id,project_id,chapter_id,confirmed_version_id,source_version_id,source_element_id,target_stage,target_version_id,target_item_id)
  select new.workspace_id,new.project_id,new.chapter_id,new.id,d.script_version_id,d.script_element_id,d.target_stage,d.target_version_id,d.target_item_id
  from script_downstream_dependencies d join script_content_versions v on v.workspace_id=d.workspace_id and v.project_id=d.project_id and v.chapter_id=d.chapter_id and v.id=d.script_version_id
  cross join lateral jsonb_array_elements(v.version_json->'elements') old_element
  where d.workspace_id=new.workspace_id and d.project_id=new.project_id and d.chapter_id=new.chapter_id and old_element->>'id'=d.script_element_id
    and (old_element - array['lockedAt','lockedBy','lastEdit']) is distinct from
      (select e - array['lockedAt','lockedBy','lastEdit'] from jsonb_array_elements(new.version_json->'elements') e where e->>'id'=d.script_element_id)
  on conflict do nothing;
 end if;
 return new;
end $$;
create trigger script_impacts_on_confirmation after insert on script_content_versions for each row execute function record_script_impacts();
