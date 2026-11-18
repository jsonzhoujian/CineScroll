-- Earlier drafts have no recorded creation timestamp.
alter table storyboard_reconciliations add column created_at timestamptz;
alter table storyboard_reconciliations alter column created_at set default clock_timestamp();
