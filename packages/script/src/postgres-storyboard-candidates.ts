import type { Actor } from "./index.ts";
import type { ModelSettingsClient, ModelSettingsPool } from "./postgres-model-settings.ts";
import { validateStoryboardShot, type StoryboardResponseIdentity } from "./storyboard-content.ts";
import { StoryboardUpstreamError, type ConfirmedStoryboardHandoff } from "./storyboard-handoff.ts";
import type { StoryboardCandidate, StoryboardCandidateRepository } from "./storyboard-runner.ts";

export type StoryboardReviewCommand = { requestId: string; expectedRevision: number; reason: string } & (
  { kind: "suggest" | "edit"; shotId: string; value: { visual: string; durationSeconds: number } }
  | { kind: "lock" | "unlock"; shotId: string }
  | { kind: "confirm"; expectedPublicationId: string | null }
  | { kind: "decide"; suggestionRevision: number; decision: "accepted" | "rejected" }
);
type ReviewOperation = { revision: number; shotId: string; actorId: string; command: StoryboardReviewCommand;
  change: { visual: string; durationSeconds: number } | null };

export class StoryboardStorageError extends Error {
  constructor(code: "FORBIDDEN" | "INVALID_CANDIDATE" | "POLICY_RESTRICTED" | "STATE_CONFLICT" | "TASK_NOT_FOUND" | "REVIEW_INCOMPLETE" | "DURATION_OUT_OF_RANGE" | "STORAGE_UNAVAILABLE") {
    super(code);
    this.code = code;
  }
  readonly code: "FORBIDDEN" | "INVALID_CANDIDATE" | "POLICY_RESTRICTED" | "STATE_CONFLICT" | "TASK_NOT_FOUND" | "REVIEW_INCOMPLETE" | "DURATION_OUT_OF_RANGE" | "STORAGE_UNAVAILABLE";
}

export class PostgresStoryboardCandidateRepository implements StoryboardCandidateRepository {
  private readonly pool: ModelSettingsPool;
  private readonly handoff: Pick<ConfirmedStoryboardHandoff, "read">;

  constructor(pool: ModelSettingsPool, handoff: Pick<ConfirmedStoryboardHandoff, "read">) {
    this.pool = pool;
    this.handoff = handoff;
  }

  findGeneration(actor: Actor, identity: StoryboardResponseIdentity) {
    return this.transaction(actor, client => this.find(client, actor, identity));
  }

  private async find(client: ModelSettingsClient, actor: Actor, identity: StoryboardResponseIdentity) {
    const row = (await client.query(`select version_json from storyboard_candidate_versions
      where workspace_id=$1 and project_id=$2 and chapter_id=$3 and job_id=$4 and created_by=$5
        and version_json->>'sourceVersionId'=$6 and version_json->'upstreamConfirmedVersionIds'=$7::jsonb`,
    [actor.workspaceId, identity.projectId, identity.chapterId, identity.jobId, actor.userId,
      identity.sourceVersionId, JSON.stringify(identity.upstreamConfirmedVersionIds)])).rows[0];
    return row ? structuredClone(row.version_json) as StoryboardCandidate : null;
  }

  submitReview(actor: Actor, projectId: string, chapterId: string, jobId: string) {
    return this.transaction(actor, async client => {
      const key = [actor.workspaceId,projectId,chapterId,jobId];
      const inserted = (await client.query(`insert into storyboard_review_submissions(workspace_id,project_id,chapter_id,job_id)
        values($1,$2,$3,$4) on conflict(workspace_id,project_id,chapter_id,job_id) do nothing returning id`,key)).rows[0];
      const row = inserted ?? (await client.query(`select id from storyboard_review_submissions
        where (workspace_id,project_id,chapter_id,job_id)=($1,$2,$3,$4) and submitted_by=$5`,[...key,actor.userId])).rows[0];
      if (!row) throw new StoryboardStorageError("FORBIDDEN");
      return { id: row.id as string };
    });
  }

  listReviews(actor: Actor, projectId: string, chapterId: string, cursor: string | null) {
    return this.transaction(actor, async client => {
      const rows = (await client.query(`select id,submitted_at::text from storyboard_review_submissions
        where (workspace_id,project_id,chapter_id)=($1,$2,$3) and ($4::uuid is null or id>$4) order by id limit 21`,
      [actor.workspaceId,projectId,chapterId,cursor])).rows;
      const reviews = rows.slice(0,20).map(row => ({ id: row.id as string, submittedAt: row.submitted_at as string }));
      return { reviews, nextCursor: rows.length > 20 ? reviews.at(-1)!.id : null };
    });
  }

  beginReconciliation(actor: Actor,p: string,c: string,publicationId: string,sourceVersionId: string,upstreamIds: readonly string[]) {
    return this.transaction(actor, async client => {
      const key = [actor.workspaceId,p,c,publicationId,sourceVersionId,upstreamIds];
      const inserted = (await client.query(`insert into storyboard_reconciliations
        (workspace_id,project_id,chapter_id,base_publication_id,source_version_id,upstream_ids)
        values($1,$2,$3,$4,$5,$6) on conflict(workspace_id,project_id,chapter_id,base_publication_id,source_version_id,upstream_ids)
        do nothing returning id`,key)).rows[0];
      const row = inserted ?? (await client.query(`select id from storyboard_reconciliations
        where (workspace_id,project_id,chapter_id,base_publication_id,source_version_id,upstream_ids)=($1,$2,$3,$4,$5,$6)`,key)).rows[0];
      if (!row) throw new StoryboardStorageError("STORAGE_UNAVAILABLE");
      const retained = (await client.query(`select shot_id,revision_value,regenerated_shot from storyboard_reconciliation_retains
        where (workspace_id,project_id,chapter_id,reconciliation_id)=($1,$2,$3,$4) order by shot_id`,
      [actor.workspaceId,p,c,row.id])).rows;
      return { id: row.id as string,publicationId,sourceVersionId,upstreamConfirmedVersionIds: upstreamIds,
        retainedShotIds: retained.filter(entry => !entry.revision_value && !entry.regenerated_shot).map(entry => entry.shot_id as string),
        regeneratedShots: retained.flatMap(entry => entry.regenerated_shot ? [entry.regenerated_shot as StoryboardCandidate["shots"][number]] : []),
        revisedShots: retained.flatMap(entry => entry.revision_value ? [{ shotId: entry.shot_id as string, value: entry.revision_value as NonNullable<ReviewOperation["change"]> }] : []) };
    });
  }

  async retainReconciliationShot(actor: Actor,p: string,c: string,publicationId: string,draftId: string,shotId: string,revision?: { value: NonNullable<ReviewOperation["change"]>; reason: string }) {
    const baseline = await this.findReview(actor,p,c,null,publicationId);
    const shot = baseline?.candidate.shots.find(item => item.id === shotId);
    if (!shot) throw new StoryboardStorageError("TASK_NOT_FOUND");
    const upstream = await this.handoff.read(actor,p,c);

    return this.transaction(actor, async client => {
      const key = [actor.workspaceId,p,c,draftId,publicationId];
      const draft = (await client.query(`select source_version_id,upstream_ids from storyboard_reconciliations
        where (workspace_id,project_id,chapter_id,id,base_publication_id)=($1,$2,$3,$4,$5)`,key)).rows[0];
      if (!draft) throw new StoryboardStorageError("TASK_NOT_FOUND");
      if (draft.source_version_id !== upstream.sourceVersionId
        || JSON.stringify(draft.upstream_ids) !== JSON.stringify(upstream.upstreamConfirmedVersionIds)) {
        throw new StoryboardUpstreamError();
      }
      if (!validateStoryboardShot({ ...shot,...revision?.value },upstream.context)) throw new StoryboardStorageError("INVALID_CANDIDATE");
      const shotKey = [actor.workspaceId,p,c,draftId,shotId];
      const value = revision ? JSON.stringify(revision.value) : null, reason = revision?.reason ?? null;
      const inserted = (await client.query(`insert into storyboard_reconciliation_retains
        (workspace_id,project_id,chapter_id,reconciliation_id,shot_id,revision_value,revision_reason)
        values($1,$2,$3,$4,$5,$6,$7) on conflict do nothing returning shot_id`,[...shotKey,value,reason])).rows[0];
      if (!inserted && !(await client.query(`select 1 from storyboard_reconciliation_retains
        where (workspace_id,project_id,chapter_id,reconciliation_id,shot_id)=($1,$2,$3,$4,$5)
          and regeneration_job_id is null and revision_value is not distinct from $6::jsonb and revision_reason is not distinct from $7::text`,
      [...shotKey,value,reason])).rows[0]) throw new StoryboardStorageError("STATE_CONFLICT");
      return { shotId };
    });
  }

  adoptReconciliationShot(actor: Actor,p: string,c: string,draftId: string,jobId: string,shotId: string) {
    return this.transaction(actor, async client => {
      const key = [actor.workspaceId,p,c,draftId,shotId,jobId];
      const saved = (await client.query(`insert into storyboard_reconciliation_retains
        (workspace_id,project_id,chapter_id,reconciliation_id,shot_id,regeneration_job_id)
        values($1,$2,$3,$4,$5,$6) on conflict do nothing returning regenerated_shot`,key)).rows[0];
      const row = saved ?? (await client.query(`select regenerated_shot from storyboard_reconciliation_retains
        where (workspace_id,project_id,chapter_id,reconciliation_id,shot_id,regeneration_job_id)=($1,$2,$3,$4,$5,$6)`,key)).rows[0];
      if (!row) throw new StoryboardStorageError("STATE_CONFLICT");
      return row.regenerated_shot as StoryboardCandidate["shots"][number];
    });
  }

  previewReconciliationRegeneration(actor: Actor,p: string,c: string,publicationId: string,draftId: string,shotIds: readonly string[]) {
    return this.transaction(actor, async client => {
      const key = [actor.workspaceId,p,c,draftId,publicationId];
      const draft = (await client.query(`select d.source_version_id, d.upstream_ids, assert_storyboard_reconciliation(d) as shots
        from storyboard_reconciliations d
        where (d.workspace_id,d.project_id,d.chapter_id,d.id,d.base_publication_id)=($1,$2,$3,$4,$5)`,key)).rows[0];
      if (!draft) throw new StoryboardStorageError("TASK_NOT_FOUND");
      const targets = (draft.shots as StoryboardCandidate["shots"]).filter(shot => shotIds.includes(shot.id));
      if (targets.length !== shotIds.length) throw new StoryboardStorageError("TASK_NOT_FOUND");
      const blocked = (await client.query(`select 1 from storyboard_reconciliation_retains
        where (workspace_id,project_id,chapter_id,reconciliation_id)=($1,$2,$3,$4) and shot_id=any($6::text[])
        union all
        select 1 from (
          select distinct on (op.shot_id) op.command->>'kind' as kind
          from storyboard_review_operations publication
          join storyboard_review_operations op using(workspace_id,project_id,chapter_id,review_id)
          where (publication.workspace_id,publication.project_id,publication.chapter_id,publication.publication_id)=($1,$2,$3,$5)
            and op.shot_id=any($6::text[]) and op.command->>'kind' in ('lock','unlock')
          order by op.shot_id,op.revision desc
        ) locks where kind='lock' limit 1`,[...key,shotIds])).rows[0];
      if (blocked) throw new StoryboardStorageError("STATE_CONFLICT");
      return {
        reconciliationId: draftId,publicationId,sourceVersionId: draft.source_version_id as string,
        upstreamConfirmedVersionIds: draft.upstream_ids as string[],
        targets: targets.map(({ id,episodeId,sceneId,ordinal }) => ({ scopeKey: id,shotId: id,episodeId,sceneId,ordinal })),
      };
    });
  }

  async confirmReconciliation(actor: Actor,p: string,c: string,publicationId: string,draftId: string,requestId: string,reason: string) {
    const upstream = await this.handoff.read(actor,p,c);
    return this.transaction(actor, async client => {
      const scope = [actor.workspaceId,p,c];
      await client.query("select lock_settings_review_authority($1,$2,$3)",scope);
      const prior = (await client.query(`select o.publication_id::text as id,o.command->>'reason' as reason
        from storyboard_review_operations o join storyboard_review_submissions r using(workspace_id,project_id,chapter_id)
        join storyboard_reconciliations d using(workspace_id,project_id,chapter_id)
        where (o.workspace_id,o.project_id,o.chapter_id,d.id,d.base_publication_id)=($1,$2,$3,$4,$5)
          and o.review_id=r.id and r.job_id='reconciliation_'||d.id::text and o.actor_id=$6
          and o.command->>'requestId'=$7 and o.publication_id is not null`,[...scope,draftId,publicationId,actor.userId,requestId])).rows[0];
      if (prior) {
        if (prior.reason !== reason) throw new StoryboardStorageError("STATE_CONFLICT");
        return { publicationId: prior.id as string };
      }
      const row = (await client.query(`select assemble_storyboard_reconciliation(workspace_id,project_id,chapter_id,id) as candidate
        from storyboard_reconciliations where (workspace_id,project_id,chapter_id,id,base_publication_id)=($1,$2,$3,$4,$5)`,
      [...scope,draftId,publicationId])).rows[0];
      if (!row) throw new StoryboardStorageError("TASK_NOT_FOUND");
      const candidate = row.candidate as StoryboardCandidate;
      if (candidate.sourceVersionId !== upstream.sourceVersionId ||
        JSON.stringify(candidate.upstreamConfirmedVersionIds) !== JSON.stringify(upstream.upstreamConfirmedVersionIds)) throw new StoryboardUpstreamError();
      if (candidate.shots.some(shot => !validateStoryboardShot(shot,upstream.context))) throw new StoryboardStorageError("INVALID_CANDIDATE");

      await client.query(`insert into storyboard_candidate_versions(workspace_id,project_id,chapter_id,job_id,created_by,version_json)
        values($1,$2,$3,$4,$5,$6)`,[...scope,candidate.jobId,actor.userId,JSON.stringify(candidate)]);
      const review = (await client.query(`insert into storyboard_review_submissions(workspace_id,project_id,chapter_id,job_id)
        values($1,$2,$3,$4) returning id`,[...scope,candidate.jobId])).rows[0]!;
      const locks = (await client.query(`select shot_id from (
        select distinct on (o.shot_id) o.shot_id,o.command->>'kind' as kind
        from storyboard_review_operations o join storyboard_review_operations published
          using(workspace_id,project_id,chapter_id,review_id)
        where (o.workspace_id,o.project_id,o.chapter_id,published.publication_id)=($1,$2,$3,$4)
          and o.command->>'kind' in ('lock','unlock') order by o.shot_id,o.revision desc
      ) latest where kind='lock' order by shot_id`,[...scope,publicationId])).rows;
      let revision = 0;
      for (const lock of locks) {
        await client.query(`insert into storyboard_review_operations(workspace_id,project_id,chapter_id,review_id,command)
          values($1,$2,$3,$4,$5)`,[...scope,review.id,JSON.stringify({
          kind: "lock",shotId: lock.shot_id,expectedRevision: revision,requestId: `inherited-${revision}-${review.id}`,reason: "沿用正式发布的镜头锁定",
        })]);
        revision++;
      }
      const published = (await client.query(`insert into storyboard_review_operations(workspace_id,project_id,chapter_id,review_id,command)
        values($1,$2,$3,$4,$5) returning publication_id::text as id`,[...scope,review.id,JSON.stringify({
        kind: "confirm",expectedRevision: revision,expectedPublicationId: publicationId,requestId,reason,
      })])).rows[0];
      if (!published) throw new StoryboardStorageError("STATE_CONFLICT");
      return { publicationId: published.id as string };
    });
  }

  listAudit(actor: Actor,projectId: string,chapterId: string | null,cursor: { recordedAt: string; eventId: string; chapterId?: string } | null) {
    return this.transaction(actor, async client => {
      const rows = (await client.query(`with storyboard_and_source as (
        select chapter_id,'review:'||id::text as event_id,submitted_at as recorded_at,submitted_by as actor_id,
          'submit' as kind,id as review_id,null::uuid as reconciliation_id,null::text as shot_id,
          null::text as publication_id,null::text as reason,null::text as decision,
          null::text as previous_source_id,null::text as source_id
        from storyboard_review_submissions where (workspace_id,project_id)=($1,$2) and ($3::text is null or chapter_id=$3)
        union all
        select chapter_id,'operation:'||review_id::text||':'||revision,recorded_at,actor_id,command->>'kind',review_id,null,
          nullif(shot_id,''),publication_id::text,command->>'reason',command->>'decision',null,null
        from storyboard_review_operations where (workspace_id,project_id)=($1,$2) and ($3::text is null or chapter_id=$3)
        union all
        select chapter_id,'reconciliation:'||reconciliation_id::text||':'||shot_id,retained_at,retained_by,
          case when regenerated_shot is not null then 'adopt' when revision_value is not null then 'revise' else 'retain' end,
          null,reconciliation_id,shot_id,null,revision_reason,null,null,null
        from storyboard_reconciliation_retains where (workspace_id,project_id)=($1,$2) and ($3::text is null or chapter_id=$3)
        union all
        select chapter_id,'reconciliation-begin:'||id::text,created_at,created_by,
          'reconciliation_begin',null,id,null,base_publication_id::text,null,null,null,null
        from storyboard_reconciliations
        where $3::text is null and (workspace_id,project_id)=($1,$2) and created_at is not null
        union all
        select source.chapter_id,'source:'||source.id,source.created_at,source.created_by,
          case when source.ordinal=1 then 'source_import' else 'source_reimport' end,
          null,null,null,null,null,null,previous.id,source.id
        from source_versions source
        join projects p on p.id=source.project_id
        left join lateral (
          select v.id from source_versions v where (v.project_id,v.chapter_id)=(source.project_id,source.chapter_id)
            and v.ordinal<source.ordinal order by v.ordinal desc limit 1
        ) previous on true
        where $3::text is null and (p.workspace_id,p.id)=($1,$2)
      ), events as (
        select *,null::text as previous_version_id,null::text as version_id,null::text as target_id from storyboard_and_source
        union all
        select v.chapter_id,'script:'||v.id,(v.version_json->>'createdAt')::timestamptz,v.created_by,
          'script_'||(operation.value->>'kind'),null,null,null,null,operation.value->>'reason',
          case when operation.value->>'kind'='decide' then (
            select suggestion->>'status' from jsonb_array_elements(coalesce(v.version_json->'suggestions','[]'::jsonb)) suggestion
            where suggestion->>'id'=operation.value->>'targetId' limit 1
          ) end,
          null,null,v.parent_version_id,v.id,operation.value->>'targetId'
        from script_content_versions v
        left join script_content_versions parent
          on (parent.workspace_id,parent.project_id,parent.chapter_id,parent.id)=(v.workspace_id,v.project_id,v.chapter_id,v.parent_version_id)
        cross join lateral (select coalesce(v.version_json->'publicationOperation',v.version_json->'revisionOperation',v.version_json->'reviewOperation') as value) operation
        where $3::text is null and (v.workspace_id,v.project_id)=($1,$2)
          and operation.value->>'kind' in ('suggest','edit','decide','confirm','lock','unlock')
          and operation.value is distinct from coalesce(parent.version_json->'publicationOperation',parent.version_json->'revisionOperation',parent.version_json->'reviewOperation')
        union all
        select v.chapter_id,'settings:'||v.id,(v.version_json->>'createdAt')::timestamptz,v.created_by,
          'settings_'||(operation.value->>'kind'),null,null,null,null,operation.value->>'reason',
          case when operation.value->>'kind'='decide' then (
            select suggestion->>'status' from jsonb_array_elements(coalesce(v.version_json->'suggestions','[]'::jsonb)) suggestion
            where suggestion->>'id'=operation.value->>'targetId' limit 1
          ) end,
          null,null,coalesce(v.parent_review_id,v.origin_version_id),v.id,operation.value->>'targetId'
        from settings_review_versions v
        cross join lateral (select v.version_json->'operation' as value) operation
        where $3::text is null and (v.workspace_id,v.project_id)=($1,$2)
        union all
        select s.chapter_id,'knowledge-suggestion:'||s.version_id||':'||s.fact_id||':'||s.id,s.created_at,s.created_by,
          'knowledge_suggest',null,null,null,null,s.reason,null,null,null,s.version_id,null,s.id
        from story_knowledge_fact_suggestions s
        where $3::text is null and (s.workspace_id,s.project_id)=($1,$2)
        union all
        select d.chapter_id,'knowledge-suggestion-decision:'||d.version_id||':'||d.fact_id||':'||d.suggestion_id,d.decided_at,d.decided_by,
          'knowledge_suggestion_decide',null,null,null,null,d.reason,d.outcome,null,null,d.version_id,d.result_version_id,d.suggestion_id
        from story_knowledge_fact_suggestion_decisions d
        where $3::text is null and (d.workspace_id,d.project_id)=($1,$2)
        union all
        select v.chapter_id,'knowledge-confirm:'||v.id,v.created_at,v.created_by,
          'knowledge_confirm',null,null,null,null,
          case when command.value->>'expectedActiveVersionId'=confirmation.candidate_version_id
            and jsonb_typeof(command.value->'reason')='string' then command.value->>'reason' end,
          null,null,null,confirmation.candidate_version_id,v.id,null
        from story_knowledge_confirmation_results confirmation
        join story_knowledge_versions v on (v.workspace_id,v.project_id,v.chapter_id,v.id)
          = (confirmation.workspace_id,confirmation.project_id,confirmation.chapter_id,confirmation.version_id)
        cross join lateral (select case when confirmation.fingerprint is json object
          then confirmation.fingerprint::jsonb end as value) command
        where $3::text is null and (v.workspace_id,v.project_id)=($1,$2)
        union all
        select v.chapter_id,'knowledge:'||v.id||':'||action.kind||':'||(fact.value->>'id'),v.created_at,v.created_by,
          'knowledge_'||action.kind,null,null,null,null,action.reason,action.outcome,null,null,v.parent_version_id,v.id,fact.value->>'id'
        from story_knowledge_versions v
        join story_knowledge_versions parent on (parent.workspace_id,parent.project_id,parent.chapter_id,parent.id)
          =(v.workspace_id,v.project_id,v.chapter_id,v.parent_version_id)
        cross join lateral jsonb_array_elements(v.version_json->'facts') fact(value)
        join lateral jsonb_array_elements(parent.version_json->'facts') prior(value) on prior.value->>'id'=fact.value->>'id'
        cross join lateral (values
          ('edit',fact.value->'lastEdit',prior.value->'lastEdit',fact.value->'lastEdit'->>'reason',null),
          ('decide',fact.value->'decision',prior.value->'decision',fact.value->'decision'->>'reason',fact.value->'decision'->>'outcome'),
          (fact.value->'lockHistory'->-1->>'action',fact.value->'lockHistory'->-1,prior.value->'lockHistory'->-1,fact.value->'lockHistory'->-1->>'reason',null)
        ) action(kind,metadata,previous,reason,outcome)
        where $3::text is null and (v.workspace_id,v.project_id)=($1,$2)
          and action.metadata is not null and action.metadata is distinct from action.previous
          and not (action.kind='edit' and exists (select 1 from story_knowledge_fact_suggestion_decisions d
            where (d.workspace_id,d.project_id,d.chapter_id,d.result_version_id,d.fact_id)
              =(v.workspace_id,v.project_id,v.chapter_id,v.id,fact.value->>'id')))
          and not exists (select 1 from story_knowledge_confirmation_results confirmation
            where (confirmation.workspace_id,confirmation.project_id,confirmation.chapter_id,confirmation.version_id)
              =(v.workspace_id,v.project_id,v.chapter_id,v.id))
        union all
        select v.chapter_id,'episode-confirm:'||v.id,(v.version_json->>'confirmedAt')::timestamptz,v.created_by,
          'episode_confirm',null,null,null,null,null,null,null,null,v.parent_version_id,v.id,null
        from episode_plan_versions v
        where $3::text is null and (v.workspace_id,v.project_id)=($1,$2) and v.status='confirmed'
        union all
        select v.chapter_id,'episode-decision:'||v.id||':'||(proposal.value->>'id'),
          (decision.value->>'decidedAt')::timestamptz,v.created_by,
          'episode_decide',null,null,null,null,decision.value->>'reason',
          case decision.value->>'outcome' when 'approved' then 'accepted' when 'rejected' then 'rejected' end,
          null,null,v.parent_version_id,v.id,proposal.value->>'id'
        from episode_plan_versions v
        join episode_plan_versions parent on (parent.workspace_id,parent.project_id,parent.chapter_id,parent.id)
          =(v.workspace_id,v.project_id,v.chapter_id,v.parent_version_id)
        cross join lateral jsonb_array_elements(v.version_json->'majorAdaptationProposals') proposal(value)
        join lateral jsonb_array_elements(parent.version_json->'majorAdaptationProposals') prior(value)
          on prior.value->>'id'=proposal.value->>'id'
        cross join lateral (select proposal.value->'decision' as value) decision
        where $3::text is null and (v.workspace_id,v.project_id)=($1,$2) and v.status='candidate'
          and decision.value->>'outcome' in ('approved','rejected')
          and decision.value is distinct from prior.value->'decision'
      )
      select chapter_id as "chapterId",event_id as "eventId",to_char(recorded_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "recordedAt",
        actor_id as "actorId",kind,review_id as "reviewId",reconciliation_id as "reconciliationId",
        shot_id as "shotId",publication_id as "publicationId",reason,decision,
        previous_source_id as "previousSourceVersionId",source_id as "sourceVersionId",
        previous_version_id as "previousVersionId",version_id as "versionId",target_id as "targetId"
      from events where $4::timestamptz is null or (recorded_at,chapter_id,event_id)<($4::timestamptz,$6::text,$5::text)
      order by recorded_at desc,chapter_id desc,event_id desc limit 21`,[actor.workspaceId,projectId,chapterId,cursor?.recordedAt ?? null,cursor?.eventId ?? null,cursor?.chapterId ?? chapterId])).rows;
      const events = rows.slice(0,20);
      const last = events.at(-1);
      return { events,nextCursor: rows.length > 20 && last ? { recordedAt: last.recordedAt as string,eventId: last.eventId as string,chapterId: last.chapterId as string } : null };
    });
  }

  listPublications(actor: Actor, projectId: string, chapterId: string, cursor: string | null) {
    return this.transaction(actor, async client => {
      const rows = (await client.query(`select publication_id::text as id, revision, recorded_at as "confirmedAt"
        from storyboard_review_operations where (workspace_id,project_id,chapter_id)=($1,$2,$3)
          and publication_id is not null and ($4::bigint is null or publication_id<$4)
        order by publication_id desc limit 21`,[actor.workspaceId,projectId,chapterId,cursor])).rows;
      const publications = rows.slice(0,20).map(row => ({
        id: row.id as string, revision: row.revision as number, confirmedAt: (row.confirmedAt as Date).toISOString(),
      }));
      return { publications,nextCursor: rows.length > 20 ? publications.at(-1)!.id : null };
    });
  }

  findReview(actor: Actor, projectId: string, chapterId: string, reviewId: string | null, publicationId: string | null = null) {
    return this.transaction(actor, async client => {
      const scope = [actor.workspaceId,projectId,chapterId];
      const formal = (await client.query(`select publication_id::text as "publicationId",review_id as "reviewId",revision
        from storyboard_review_operations where (workspace_id,project_id,chapter_id)=($1,$2,$3)
          and publication_id is not null and ($4::bigint is null or publication_id=$4)
          order by publication_id desc limit 1`,[...scope,publicationId])).rows[0] as
        { publicationId: string; reviewId: string; revision: number } | undefined;
      const selected = reviewId ?? formal?.reviewId;
      if (!selected) return null;
      const key = [...scope,selected];
      const row = (await client.query(`select v.version_json from storyboard_review_submissions r
        join storyboard_candidate_versions v using(workspace_id,project_id,chapter_id,job_id)
        where (r.workspace_id,r.project_id,r.chapter_id,r.id)=($1,$2,$3,$4)`,key)).rows[0];
      if (!row) return null;
      const candidate = structuredClone(row.version_json) as StoryboardCandidate;
      const log = (await client.query(`select revision, shot_id as "shotId", actor_id as "actorId", command, change
        from storyboard_review_operations where (workspace_id,project_id,chapter_id,review_id)=($1,$2,$3,$4)
        order by revision`,key)).rows as ReviewOperation[];
      const operations = reviewId === null ? log.filter(operation => operation.revision <= formal!.revision) : log;
      const changes = new Map<string,ReviewOperation["change"]>();
      const decisions = new Map<number,{ status: "accepted" | "rejected"; actorId: string; reason: string }>();
      const locks = new Set<string>();
      let lastChange = 0;
      for (const operation of publicationId === null ? log : operations) {
        if (operation.command.kind === "lock") locks.add(operation.shotId);
        if (operation.command.kind === "unlock") locks.delete(operation.shotId);
      }
      for (const operation of operations) {
        if (operation.change) lastChange = operation.revision;
        if (operation.change) changes.set(operation.shotId,operation.change);
        if (operation.command.kind === "decide") decisions.set(operation.command.suggestionRevision,{
          status: operation.command.decision,actorId: operation.actorId,reason: operation.command.reason,
        });
      }
      const suggestions = operations.flatMap(({ command,revision,shotId,actorId }) => command.kind === "suggest" ? [{
        revision,shotId,actorId,value: command.value,reason: command.reason,
        status: decisions.get(revision)?.status ?? "pending" as const,decision: decisions.get(revision) ?? null,
      }] : []);
      const shots = candidate.shots.map(shot => ({ ...shot,...changes.get(shot.id) }));
      const plan = (await client.query(`select version_json from episode_plan_versions
        where (workspace_id,project_id,chapter_id,id)=($1,$2,$3,$4)`,[...scope,candidate.upstreamConfirmedVersionIds[2]])).rows[0]?.version_json as
        { targetDurationSeconds: number; episodes: Array<{ id: string; title: string }> } | undefined;
      const totals = new Map<string,number>();
      for (const shot of shots) totals.set(shot.episodeId,(totals.get(shot.episodeId) ?? 0) + shot.durationSeconds);
      const episodeDurations = plan?.episodes.map(episode => {
        const seconds = totals.get(episode.id) ?? 0;
        return { ...episode,seconds: Number.isFinite(seconds) ? seconds : null,targetSeconds: plan.targetDurationSeconds };
      }) ?? [];
      return { candidate: { ...candidate,shots },episodeDurations,
        revision: operations.at(-1)?.revision ?? 0,suggestions,lockedShotIds: [...locks],
        reviewId: selected,publicationId: formal?.publicationId ?? null,
        isFormalReview: formal?.reviewId === selected,
        confirmed: formal?.reviewId === selected && lastChange <= formal.revision,
      };
    });
  }

  saveReviewOperation(actor: Actor, projectId: string, chapterId: string, reviewId: string, command: StoryboardReviewCommand) {
    return this.transaction(actor, async client => {
      await client.query(`insert into storyboard_review_operations(workspace_id,project_id,chapter_id,review_id,command)
        values($1,$2,$3,$4,$5::jsonb)`,[actor.workspaceId,projectId,chapterId,reviewId,JSON.stringify(command)]);
    });
  }

  async saveGeneration(actor: Actor, input: StoryboardCandidate) {
    const candidate = structuredClone(input);
    if (candidate.createdBy !== actor.userId) throw new StoryboardStorageError("FORBIDDEN");
    const upstream = await this.handoff.read(actor, candidate.projectId, candidate.chapterId);
    if (upstream.sourceVersionId !== candidate.sourceVersionId
      || upstream.upstreamConfirmedVersionIds.length !== candidate.upstreamConfirmedVersionIds.length
      || upstream.upstreamConfirmedVersionIds.some((id, i) => id !== candidate.upstreamConfirmedVersionIds[i])) throw new StoryboardUpstreamError();
    if (new Set(candidate.shots.map(shot => shot.id)).size !== candidate.shots.length
      || candidate.shots.some(shot => !validateStoryboardShot(shot, upstream.context))) throw new StoryboardStorageError("INVALID_CANDIDATE");

    return this.transaction(actor, async client => {
      const key = [actor.workspaceId, candidate.projectId, candidate.chapterId, candidate.jobId];
      const inserted = (await client.query(`insert into storyboard_candidate_versions(workspace_id,project_id,chapter_id,job_id,created_by,version_json)
        values($1,$2,$3,$4,$5,$6::jsonb) on conflict do nothing returning job_id`, [...key, actor.userId, JSON.stringify(candidate)])).rows[0];
      if (!inserted) {
        const original = await this.find(client, actor, candidate);
        if (!original) throw new StoryboardStorageError("FORBIDDEN");
        return original;
      }
      return candidate;
    });
  }

  private async transaction<T>(actor: Actor, action: (client: ModelSettingsClient) => Promise<T>) {
    let client: ModelSettingsClient | undefined;
    try {
      client = await this.pool.connect();
      await client.query("begin");
      await client.query("set local statement_timeout='5s'");
      await client.query("select set_config('app.current_user_id',$1,true),set_config('app.current_workspace_id',$2,true),set_config('app.model_workspace_id',$2,true)", [actor.userId, actor.workspaceId]);
      const result = await action(client);
      await client.query("commit");
      return result;
    } catch (error) {
      try { await client?.query("rollback"); } catch { /* Preserve the original error. */ }
      if (error instanceof StoryboardStorageError || error instanceof StoryboardUpstreamError) throw error;
      const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
      if (code === "P7001") throw new StoryboardUpstreamError();
      throw new StoryboardStorageError(code === "42501" ? "FORBIDDEN" : code === "P7002" ? "INVALID_CANDIDATE" : code === "P7003" ? "POLICY_RESTRICTED" : code === "P7004" ? "STATE_CONFLICT" : code === "P7005" ? "TASK_NOT_FOUND" : code === "P7006" ? "REVIEW_INCOMPLETE" : code === "P7007" ? "DURATION_OUT_OF_RANGE" : "STORAGE_UNAVAILABLE");
    } finally {
      client?.release();
    }
  }
}
