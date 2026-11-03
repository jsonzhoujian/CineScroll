-- T07 initial-generation writer: no generic downstream write permission.
create policy script_settings_dependencies_insert on script_downstream_dependencies for insert with check(
 workspace_id=current_app_workspace_id() and can_access_project(project_id) and target_stage='settings'
 and exists(select 1 from settings_candidate_versions s
   join script_content_versions v on v.workspace_id=s.workspace_id and v.project_id=s.project_id and v.chapter_id=s.chapter_id and v.id=s.script_version_id
   cross join lateral jsonb_array_elements(s.version_json->'assets') asset
   cross join lateral jsonb_array_elements(v.version_json->'elements') element
   cross join lateral jsonb_array_elements(asset->'provenance') ap
   cross join lateral jsonb_array_elements(element->'provenance') ep
   where s.workspace_id=script_downstream_dependencies.workspace_id and s.project_id=script_downstream_dependencies.project_id
     and s.chapter_id=script_downstream_dependencies.chapter_id and s.id=target_version_id and s.script_version_id=script_downstream_dependencies.script_version_id
     and s.created_by=current_app_user_id() and asset->>'id'=target_item_id and element->>'id'=script_element_id
     and ap->>'type'='source_fragment' and ep->>'type'='source_fragment'
     and ap->>'sourceVersionId'=ep->>'sourceVersionId' and ap->>'fragmentId'=ep->>'fragmentId')
);
grant insert on script_downstream_dependencies to novel_app;
