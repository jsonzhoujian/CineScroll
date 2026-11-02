import type { Actor } from "./index.ts";
import { ScriptContentError,type ScriptContentRepository,type ScriptGenerationContextReader } from "./script-content.ts";
/** Generation authority is stricter than historical readability. Never falls back to an active candidate. */
export class ConfirmedScriptHandoff {
  private readonly repository: ScriptContentRepository;private readonly context: ScriptGenerationContextReader;
  constructor(repository: ScriptContentRepository,context: ScriptGenerationContextReader) { this.repository = repository;this.context = context; }
  async read(actor: Actor,p: string,c: string) {
    const context = await this.context.findGenerationContext(actor,p,c);
    if (!context) throw new ScriptContentError("CONTEXT_NOT_FOUND","当前上游尚未确认");
    if (!this.repository.findConfirmed) throw new ScriptContentError("STORAGE_UNAVAILABLE","正式指针未就绪");
    const version = await this.repository.findConfirmed(actor,p,c);
    if (!version || version.status !== "confirmed" || version.sourceVersionId !== context.sourceVersionId || version.planVersionId !== context.planVersionId
      || version.generationStatus !== "succeeded" || version.failures.length || !version.elements.length || !version.scenes.length) throw new ScriptContentError("INVALID_STATE","没有当前有效正式剧本");
    // Return the immutable version and exact evidence; downstream writers must pin these identities.
    return { version,sourceFragments: context.fragments,upstreamConfirmedVersionIds: [context.planVersionId,context.confirmedStoryKnowledge?.versionId].filter((v): v is string => !!v) };
  }
}
