import type { StoryboardView } from "./api.ts";

export function storyboardScriptContext(view: StoryboardView) {
  const { projectId,chapterId,sourceVersionId,upstreamConfirmedVersionIds: ids } = view.version;
  return JSON.stringify([projectId,chapterId,sourceVersionId,ids[2],ids[3]]);
}

export function readStoryboardShot(view: StoryboardView, query: URLSearchParams, selectedId: string) {
  if (!view.current || query.get("scriptReviewContext") !== storyboardScriptContext(view)
    || query.get("scriptCursorVersion") !== view.version.upstreamConfirmedVersionIds[0]) return undefined;
  const elementId = query.get("scriptElement"), sceneId = query.get("scriptScene");
  if (!elementId || !sceneId) return undefined;
  const matches = view.version.shots.filter(shot => shot.sceneId === sceneId && shot.scriptElementIds.includes(elementId));
  return matches.find(shot => shot.id === selectedId)?.id ?? matches[0]?.id;
}

export function writeStoryboardCursor(query: URLSearchParams, view: StoryboardView, shotId: string, selectedFragmentId?: string) {
  const shot = view.version.shots.find(candidate => candidate.id === shotId);
  if (!view.current || !shot) return;
  const element = view.scriptElements.find(item => item.sceneId === shot.sceneId && shot.scriptElementIds.includes(item.id));
  if (!element) return;
  const fragments = shot.provenance.filter(item => item.type === "source_fragment" && item.sourceVersionId === view.version.sourceVersionId)
    .map(item => item.fragmentId).filter((id): id is string => !!id && view.sourceFragments.some(fragment => fragment.id === id));
  const fragmentId = fragments.find(id => id === selectedFragmentId) ?? fragments[0];
  query.set("scriptReviewContext",storyboardScriptContext(view));
  query.set("scriptReviewLoaded","1");
  query.set("scriptCursorFromStoryboard","1");
  query.set("scriptCursorVersion",view.version.upstreamConfirmedVersionIds[0]!);
  query.set("scriptElement",element.id);
  query.set("scriptScene",shot.sceneId);
  if (fragmentId) query.set("scriptFragment",fragmentId);
  else query.delete("scriptFragment");
}
