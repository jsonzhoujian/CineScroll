-- Apply as trusted migration owner. Preserve configure/test counters and privileges.
alter table public.model_rate_limits drop constraint if exists model_rate_limits_action_check;
alter table public.model_rate_limits add constraint model_rate_limits_action_check
  check(action in ('configure','test','generate'));
create or replace function public.consume_model_rate(workspace text, operation text)
returns table(allowed boolean,retry_after integer)
language plpgsql security definer set search_path=pg_catalog as $$
declare
  maximum integer;
  instant timestamptz;
  counter public.model_rate_limits%rowtype;
begin
  if workspace is null or length(workspace)=0 or operation not in ('configure','test','generate') or operation is null then
    raise exception 'invalid rate input';
  end if;
  maximum := case when operation='test' then 5 else 10 end;
  perform pg_advisory_xact_lock(hashtextextended(workspace || ':' || operation,0));
  instant := clock_timestamp();
  select * into counter from public.model_rate_limits where workspace_id=workspace and action=operation for update;
  if found and counter.window_started_at+interval '60 seconds'>instant and counter.request_count>=maximum then
    return query select false,greatest(1,ceil(extract(epoch from counter.window_started_at+interval '60 seconds'-instant))::integer);
    return;
  end if;
  insert into public.model_rate_limits values(workspace,operation,instant,1)
  on conflict(workspace_id,action) do update set
    window_started_at=case when model_rate_limits.window_started_at+interval '60 seconds'<=instant then instant else model_rate_limits.window_started_at end,
    request_count=case when model_rate_limits.window_started_at+interval '60 seconds'<=instant then 1 else model_rate_limits.request_count+1 end;
  return query select true,0;
end $$;
revoke all on public.model_rate_limits from public,novel_app;
revoke all on function public.consume_model_rate(text,text) from public;
grant execute on function public.consume_model_rate(text,text) to novel_app;
