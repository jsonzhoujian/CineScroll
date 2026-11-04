-- Trusted owner only. This admits task snapshots, not regeneration result writes.
create function valid_settings_regeneration_task(v jsonb) returns boolean language plpgsql immutable as $$
declare s jsonb;x jsonb;
begin
 s := v->'regeneration';
 if (jsonb_typeof(v)='object' and v->>'stage'='settings' and v->>'resultType'='settingsRegeneration'
   and not (v ? 'retry') and not (v ? 'qualityTarget')
   and jsonb_typeof(v->'sourceVersionId')='string' and length(v->>'sourceVersionId') between 1 and 256 and length(btrim(v->>'sourceVersionId'))>0 and v->>'sourceVersionId' !~ E'[\r\n]'
   and jsonb_typeof(v->'upstreamConfirmedVersionIds')='array' and jsonb_typeof(v->'generationParameters')='object'
   and jsonb_typeof(v->'generationParameters'->'targetDurationSeconds')='number' and v->'generationParameters'->'targetDurationSeconds' in ('60'::jsonb,'180'::jsonb,'300'::jsonb) and v->'generationParameters'->>'aspectRatio' in ('9:16','16:9') and v->'generationParameters'->>'narrativeMode' in ('narration','dialogue')
   and jsonb_typeof(s)='object' and s ?& array['expectedActiveVersionId','assetIds','failureScopeKeys','reason']
   and s-array['expectedActiveVersionId','assetIds','failureScopeKeys','reason']='{}'::jsonb
   and jsonb_typeof(s->'expectedActiveVersionId')='string' and length(s->>'expectedActiveVersionId') between 1 and 256 and length(btrim(s->>'expectedActiveVersionId'))>0 and s->>'expectedActiveVersionId' !~ E'[\r\n]'
   and jsonb_typeof(s->'reason')='string' and length(s->>'reason') between 1 and 2000 and length(btrim(s->>'reason'))>0
   and jsonb_typeof(s->'assetIds')='array' and jsonb_typeof(s->'failureScopeKeys')='array') is not true then return false; end if;
 if jsonb_array_length(v->'upstreamConfirmedVersionIds')<>3 or jsonb_array_length(s->'assetIds')+jsonb_array_length(s->'failureScopeKeys') not between 1 and 100 then return false; end if;
 for x in select value from jsonb_array_elements((s->'assetIds')||(s->'failureScopeKeys')||(v->'upstreamConfirmedVersionIds')) loop
  if (jsonb_typeof(x)='string' and length(x#>>'{}') between 1 and 256 and length(btrim(x#>>'{}'))>0 and (x#>>'{}') !~ E'[\r\n]') is not true then return false; end if;
 end loop;
 if (select count(*)<>count(distinct value) from jsonb_array_elements(s->'assetIds')) or (select count(*)<>count(distinct value) from jsonb_array_elements(s->'failureScopeKeys')) then return false; end if;
 return true;
end $$;
revoke all on function valid_settings_regeneration_task(jsonb) from public;
grant execute on function valid_settings_regeneration_task(jsonb) to novel_app;
alter table model_tasks add constraint settings_regeneration_task_input_valid check (
 (payload->'input'->>'resultType' is distinct from 'settingsRegeneration') or valid_settings_regeneration_task(payload->'input')
);
create unique index model_tasks_settings_regeneration_active_idx on model_tasks(workspace_id,(payload->>'projectId'),(payload->>'chapterId'),(payload->'input'->'regeneration'->>'expectedActiveVersionId'))
 where payload->'input'->>'stage'='settings' and payload->'input'->>'resultType'='settingsRegeneration' and (state='queued' or state='running' or state='paused' and reason='EXECUTION_UNCERTAIN');
create index model_tasks_settings_regeneration_queued_idx on model_tasks(workspace_id,(id collate "C"))
 where payload->'input'->>'stage'='settings' and payload->'input'->>'resultType'='settingsRegeneration' and state='queued';
create index model_tasks_settings_regeneration_recovery_idx on model_tasks(workspace_id,(id collate "C"))
 where payload->'input'->>'stage'='settings' and payload->'input'->>'resultType'='settingsRegeneration' and (state='running' or state='paused' and reason='EXECUTION_UNCERTAIN');
create index model_tasks_settings_regeneration_chapter_idx on model_tasks(workspace_id,(payload->>'projectId'),(payload->>'chapterId'),(id collate "C"))
 where payload->'input'->>'stage'='settings' and payload->'input'->>'resultType'='settingsRegeneration';
