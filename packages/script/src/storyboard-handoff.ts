import type { Actor } from "./index.ts";
import type { ConfirmedScriptHandoff } from "./script-handoff.ts";
import type { SettingsReviewRepository } from "./settings-review.ts";
import type { StoryboardShotContext } from "./storyboard-content.ts";

export class StoryboardUpstreamError extends Error {
  readonly code = "UPSTREAM_CHANGED";
  constructor() { super("UPSTREAM_CHANGED"); }
}

export class ConfirmedStoryboardHandoff {
  private readonly script: Pick<ConfirmedScriptHandoff, "read">;
  private readonly settings: Pick<SettingsReviewRepository, "findConfirmed">;

  constructor(script: Pick<ConfirmedScriptHandoff, "read">, settings: Pick<SettingsReviewRepository, "findConfirmed">) {
    this.script = script;
    this.settings = settings;
  }

  async read(actor: Actor, projectId: string, chapterId: string) {
    const script = await this.script.read(actor, projectId, chapterId);
    const settings = await this.settings.findConfirmed(actor, projectId, chapterId);
    const sourceVersionId = script.version.sourceVersionId;
    const settingsUpstream = [script.version.id, ...script.upstreamConfirmedVersionIds];
    if (!settings || settings.status !== "confirmed" || settings.projectId !== projectId || settings.chapterId !== chapterId
      || settings.scriptVersionId !== script.version.id || settings.sourceVersionId !== sourceVersionId
      || settings.upstreamConfirmedVersionIds.length !== settingsUpstream.length
      || !settingsUpstream.every((id, i) => id === settings.upstreamConfirmedVersionIds[i])
      || settings.generationStatus !== "succeeded" || settings.failures.length || !settings.assets.length
      || settings.reconciliation?.pendingAssets.length || settings.reconciliation?.pendingFailureScopeKeys.length
      || settings.suggestions.some(suggestion => suggestion.status === "pending")) throw new StoryboardUpstreamError();

    const context: StoryboardShotContext = {
      sourceVersionId,
      scenes: script.version.scenes.map(scene => ({
        id: scene.id,
        episodeId: scene.episodeId,
        scriptElementIds: script.version.elements.filter(element => element.sceneId === scene.id).map(element => element.id),
      })),
      assetIds: settings.assets.map(asset => asset.id),
      fragmentIds: script.sourceFragments.map(fragment => fragment.id),
      approvedAdditionIds: [...new Set(script.version.elements.flatMap(element =>
        element.provenance.flatMap(evidence => evidence.type === "approved_addition" ? [evidence.additionId] : [])))],
    };
    return structuredClone({
      script, settings, context, sourceVersionId,
      upstreamConfirmedVersionIds: [script.version.id, settings.id, ...script.upstreamConfirmedVersionIds],
    });
  }
}
