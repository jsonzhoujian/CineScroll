import type { ScriptContentVersion, ScriptGenerationContext } from "./script-content.ts";

export interface ScriptQualityModelPort {
  assess(input: { version: ScriptContentVersion; context: ScriptGenerationContext }): Promise<unknown>;
}
export type ScriptQualityReport = Readonly<{
  versionId: string; passed: boolean; coverage: number; reasons: string[];
}>;

/** Semantic verdicts require an external assessor; citations alone never prove coverage. */
export class ScriptQualityEvaluator {
  readonly #context: ScriptGenerationContext;
  readonly #model: ScriptQualityModelPort;
  constructor(options: { context: ScriptGenerationContext; model: ScriptQualityModelPort }) {
    this.#context = structuredClone(options.context); this.#model = options.model;
  }
  async validate(version: ScriptContentVersion): Promise<boolean> { return (await this.evaluate(version)).passed; }
  async evaluate(version: ScriptContentVersion): Promise<ScriptQualityReport> {
    const snapshot = structuredClone(version);
    const context = structuredClone(this.#context);
    const fail = (reason: string): ScriptQualityReport => ({ versionId: snapshot.id, passed: false, coverage: 0, reasons: [reason] });
    const plan = context.confirmedPlan;
    const knowledge = context.confirmedStoryKnowledge;
    if (!plan || plan.status !== "confirmed" || !knowledge || knowledge.versionId !== plan.storyBibleVersionId
      || plan.id !== snapshot.planVersionId || context.planVersionId !== plan.id
      || plan.sourceVersionId !== snapshot.sourceVersionId || context.sourceVersionId !== snapshot.sourceVersionId
      || plan.projectId !== snapshot.projectId || plan.chapterId !== snapshot.chapterId) return fail("CONTEXT_MISMATCH");
    const requiredEvents = [...new Set(plan.episodes.flatMap(({ coreEventFactIds }) => coreEventFactIds))];
    const requiredFacts = knowledge.facts.map(({ id }) => id);
    if (!requiredEvents.length || !requiredFacts.length || new Set(requiredFacts).size !== requiredFacts.length
      || requiredEvents.some((id) => !requiredFacts.includes(id))) return fail("INVALID_CONTEXT");
    const elements = new Set(snapshot.elements.map(({ id }) => id));
    if (!elements.size || elements.size !== snapshot.elements.length || !snapshot.scenes.length
      || new Set(snapshot.scenes.map(({ id }) => id)).size !== snapshot.scenes.length
      || snapshot.scenes.some((scene) => !plan.episodes.some(({ id }) => id === scene.episodeId))
      || plan.episodes.some((episode) => !snapshot.elements.some((element) => snapshot.scenes.some((scene) => scene.id === element.sceneId && scene.episodeId === episode.id)))
      || snapshot.generationStatus !== "succeeded" || snapshot.failures.length
      || snapshot.suggestions?.some(({ status }) => status === "pending")
      || snapshot.elements.some((element) => !element.text.trim() || !snapshot.scenes.some(({ id }) => id === element.sceneId)
        || !element.provenance.length || element.provenance.some((evidence) => evidence.type === "source_fragment"
          ? evidence.sourceVersionId !== context.sourceVersionId || !context.fragments.some(({ id }) => id === evidence.fragmentId)
          : !context.approvedAdditionIds.includes(evidence.additionId)))) return fail("INVALID_TRACEABILITY");
    let response: unknown;
    try { response = await this.#model.assess({ version: structuredClone(snapshot), context: structuredClone(context) }); }
    catch { return fail("ASSESSOR_UNAVAILABLE"); }
    if (!record(response) || !keys(response, ["versionId", "events", "facts", "episodes", "unsupportedCoreFactElementIds"]) || response.versionId !== snapshot.id
      || !Array.isArray(response.events) || !Array.isArray(response.facts) || !Array.isArray(response.episodes)) return fail("INVALID_ASSESSMENT");
    if (!Array.isArray(response.unsupportedCoreFactElementIds)
      || response.unsupportedCoreFactElementIds.some((id) => typeof id !== "string" || !elements.has(id))
      || new Set(response.unsupportedCoreFactElementIds).size !== response.unsupportedCoreFactElementIds.length) return fail("INVALID_ASSESSMENT");
    const seenEvents = new Set<string>();
    let covered = 0;
    for (const event of response.events) {
      if (!record(event) || !keys(event, ["factId", "elementIds", "verdict"]) || typeof event.factId !== "string"
        || !requiredEvents.includes(event.factId) || seenEvents.has(event.factId) || !Array.isArray(event.elementIds)
        || event.elementIds.some((id) => typeof id !== "string" || !elements.has(id))
        || new Set(event.elementIds).size !== event.elementIds.length
        || typeof event.verdict !== "string" || !["covered", "missing", "uncertain"].includes(event.verdict)
        || (event.verdict === "covered" && !event.elementIds.length)) return fail("INVALID_ASSESSMENT");
      seenEvents.add(event.factId); if (event.verdict === "covered") covered++;
    }
    const seenFacts = new Set<string>();
    let consistent = true;
    for (const fact of response.facts) {
      if (!record(fact) || !keys(fact, ["factId", "verdict"]) || typeof fact.factId !== "string"
        || !requiredFacts.includes(fact.factId) || seenFacts.has(fact.factId)
        || typeof fact.verdict !== "string" || !["consistent", "contradicted", "uncertain"].includes(fact.verdict)) return fail("INVALID_ASSESSMENT");
      seenFacts.add(fact.factId); if (fact.verdict !== "consistent") consistent = false;
    }
    const seenEpisodes = new Set<string>();
    let durationValid = true;
    for (const episode of response.episodes) {
      if (!record(episode) || !keys(episode, ["episodeId", "estimatedSeconds"]) || typeof episode.episodeId !== "string"
        || !plan.episodes.some(({ id }) => id === episode.episodeId) || seenEpisodes.has(episode.episodeId)
        || typeof episode.estimatedSeconds !== "number" || !Number.isFinite(episode.estimatedSeconds) || episode.estimatedSeconds <= 0) return fail("INVALID_ASSESSMENT");
      seenEpisodes.add(episode.episodeId);
      if (Math.abs(episode.estimatedSeconds - plan.targetDurationSeconds) / plan.targetDurationSeconds > 0.1) durationValid = false;
    }
    if (seenEvents.size !== requiredEvents.length || seenFacts.size !== requiredFacts.length || seenEpisodes.size !== plan.episodes.length) return fail("INCOMPLETE_ASSESSMENT");
    const coverage = covered / requiredEvents.length;
    const reasons = [coverage < 0.9 ? "LOW_EVENT_COVERAGE" : null, !consistent ? "FACT_CONFLICT_OR_UNCERTAINTY" : null,
      response.unsupportedCoreFactElementIds.length ? "UNSUPPORTED_CORE_FACT" : null,
      !durationValid ? "DURATION_ESTIMATE_OUT_OF_RANGE" : null].filter((reason): reason is string => reason !== null);
    return { versionId: snapshot.id, passed: !reasons.length, coverage, reasons };
  }
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function keys(value: Record<string, unknown>, allowed: string[]): boolean { return Object.keys(value).every((key) => allowed.includes(key)); }
