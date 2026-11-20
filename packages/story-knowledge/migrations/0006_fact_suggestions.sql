create table if not exists story_knowledge_fact_suggestions (
  id text not null,
  workspace_id text not null,
  project_id text not null,
  chapter_id text not null,
  version_id text not null,
  fact_id text not null,
  statement text not null check (length(btrim(statement)) between 1 and 20000),
  reason text not null check (length(btrim(reason)) between 1 and 20000),
  created_by text not null,
  created_at timestamptz not null,
  primary key (workspace_id, project_id, chapter_id, version_id, fact_id, id),
  foreign key (workspace_id, project_id, chapter_id, version_id)
    references story_knowledge_versions(workspace_id, project_id, chapter_id, id)
);

create index if not exists story_fact_suggestions_fact_idx
  on story_knowledge_fact_suggestions (workspace_id, project_id, chapter_id, fact_id, created_at, id);

alter table story_knowledge_fact_suggestions enable row level security;
alter table story_knowledge_fact_suggestions force row level security;
drop policy if exists story_fact_suggestions_select on story_knowledge_fact_suggestions;
create policy story_fact_suggestions_select on story_knowledge_fact_suggestions for select
  using (workspace_id = current_app_workspace_id() and can_access_project(project_id));
drop policy if exists story_fact_suggestions_insert on story_knowledge_fact_suggestions;
create policy story_fact_suggestions_insert on story_knowledge_fact_suggestions for insert with check (
  workspace_id = current_app_workspace_id()
  and created_by = current_app_user_id()
  and can_access_project(project_id)
  and exists (
    select 1
    from story_knowledge_heads h
    join story_knowledge_versions v on (v.workspace_id, v.project_id, v.chapter_id, v.id)
      = (h.workspace_id, h.project_id, h.chapter_id, h.active_version_id)
    cross join lateral jsonb_array_elements(v.version_json->'facts') as item(fact)
    where (h.workspace_id, h.project_id, h.chapter_id, h.active_version_id)
      = (story_knowledge_fact_suggestions.workspace_id, story_knowledge_fact_suggestions.project_id,
        story_knowledge_fact_suggestions.chapter_id, story_knowledge_fact_suggestions.version_id)
      and item.fact->>'id' = story_knowledge_fact_suggestions.fact_id
      and ((v.status <> 'confirmed' and item.fact->>'decision' is null)
        or (v.status = 'confirmed' and item.fact->'decision'->>'outcome' = 'accepted'))
      and coalesce(item.fact->>'locked', 'false') = 'false'
  )
);
grant select, insert on story_knowledge_fact_suggestions to novel_app;

create table if not exists story_knowledge_fact_suggestion_decisions (
  workspace_id text not null,
  project_id text not null,
  chapter_id text not null,
  version_id text not null,
  fact_id text not null,
  suggestion_id text not null,
  outcome text not null check (outcome in ('accepted', 'rejected')),
  reason text not null check (length(btrim(reason)) between 1 and 20000),
  decided_by text not null,
  decided_at timestamptz not null,
  result_version_id text,
  check ((outcome = 'accepted') = (result_version_id is not null)),
  foreign key (workspace_id, project_id, chapter_id, result_version_id)
    references story_knowledge_versions(workspace_id, project_id, chapter_id, id)
    deferrable initially deferred,
  primary key (workspace_id, project_id, chapter_id, version_id, fact_id, suggestion_id),
  foreign key (workspace_id, project_id, chapter_id, version_id, fact_id, suggestion_id)
    references story_knowledge_fact_suggestions(workspace_id, project_id, chapter_id, version_id, fact_id, id)
);

alter table story_knowledge_fact_suggestion_decisions enable row level security;
alter table story_knowledge_fact_suggestion_decisions force row level security;
drop policy if exists story_fact_decisions_select on story_knowledge_fact_suggestion_decisions;
create policy story_fact_decisions_select on story_knowledge_fact_suggestion_decisions for select
  using (workspace_id = current_app_workspace_id() and can_access_project(project_id));
drop policy if exists story_fact_decisions_insert on story_knowledge_fact_suggestion_decisions;
create policy story_fact_decisions_insert on story_knowledge_fact_suggestion_decisions for insert with check (
  workspace_id = current_app_workspace_id()
  and decided_by = current_app_user_id()
  and can_review_project(project_id)
);
grant select, insert on story_knowledge_fact_suggestion_decisions to novel_app;
