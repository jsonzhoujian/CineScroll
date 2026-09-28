create table if not exists imported_documents (
  id text primary key,
  project_id text not null references projects(id) on delete cascade,
  file_name text not null check (length(btrim(file_name)) > 0),
  imported_at timestamptz not null,
  imported_by text not null,
  unique (project_id, id)
);

create index if not exists imported_documents_project_idx
  on imported_documents (project_id, imported_at);

create table if not exists imported_document_chapters (
  document_id text not null,
  project_id text not null,
  chapter_index integer not null check (chapter_index >= 0),
  title text not null check (length(btrim(title)) > 0),
  source_text text not null,
  character_count integer not null check (character_count >= 0),
  status text not null check (status in ('pending', 'imported')),
  chapter_id text,
  primary key (document_id, chapter_index),
  foreign key (project_id, document_id) references imported_documents(project_id, id) on delete cascade,
  foreign key (project_id, chapter_id) references chapters(project_id, id) on delete restrict,
  check ((status = 'pending' and chapter_id is null) or (status = 'imported' and chapter_id is not null))
);

create index if not exists imported_document_chapters_project_idx
  on imported_document_chapters (project_id, document_id, chapter_index);

alter table imported_documents enable row level security;
alter table imported_documents force row level security;
alter table imported_document_chapters enable row level security;
alter table imported_document_chapters force row level security;

drop policy if exists imported_documents_select on imported_documents;
drop policy if exists imported_documents_insert on imported_documents;
drop policy if exists imported_document_chapters_select on imported_document_chapters;
drop policy if exists imported_document_chapters_insert on imported_document_chapters;
drop policy if exists imported_document_chapters_update on imported_document_chapters;
create policy imported_documents_select on imported_documents
  for select using (can_access_project(project_id));
create policy imported_documents_insert on imported_documents
  for insert with check (can_write_project(project_id));
create policy imported_document_chapters_select on imported_document_chapters
  for select using (can_access_project(project_id));
create policy imported_document_chapters_insert on imported_document_chapters
  for insert with check (can_write_project(project_id));
create policy imported_document_chapters_update on imported_document_chapters
  for update using (can_write_project(project_id)) with check (can_write_project(project_id));

grant select, insert on imported_documents to novel_app;
grant select, insert, update on imported_document_chapters to novel_app;
