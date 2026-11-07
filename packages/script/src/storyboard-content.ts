import type { ScriptProvenance } from "./script-content.ts";
import { validateSourceEvidence, type SettingEvidenceContext } from "./settings-content.ts";

const shotSizes = ["extreme_wide", "wide", "full", "medium", "close_up", "extreme_close_up"] as const;
const cameraAngles = ["eye_level", "high", "low", "overhead", "dutch", "pov"] as const;
const splitReasons = ["visual_focus", "action_change", "emotion_change", "information_change"] as const;

export type StoryboardShot = Readonly<{
  id: string;
  episodeId: string;
  sceneId: string;
  ordinal: number;
  visual: string;
  characters: string[];
  action: string;
  speech: string;
  durationSeconds: number;
  shotSize: typeof shotSizes[number];
  cameraAngle: typeof cameraAngles[number];
  cameraMovement: string;
  sound: string;
  emotion: string;
  splitReason: Array<typeof splitReasons[number]>;
  assetIds: string[];
  scriptElementIds: string[];
  provenance: ScriptProvenance[];
}>;

export type StoryboardShotContext = SettingEvidenceContext & {
  scenes: ReadonlyArray<{ id: string; episodeId: string; scriptElementIds: readonly string[] }>;
  assetIds: readonly string[];
};

const textFields = ["id", "episodeId", "sceneId", "visual", "action", "speech", "cameraMovement", "sound", "emotion"] as const;
const fields = [...textFields, "ordinal", "characters", "durationSeconds", "shotSize", "cameraAngle", "splitReason", "assetIds", "scriptElementIds", "provenance"] satisfies Array<keyof StoryboardShot>;

function isAllowed(value: unknown, allowed: readonly string[]): value is string {
  return typeof value === "string" && allowed.includes(value);
}

function uniqueReferences(value: unknown, allowed: readonly string[], minimum = 0): boolean {
  return Array.isArray(value) && value.length >= minimum && new Set(value).size === value.length
    && [...value].every(entry => isAllowed(entry, allowed));
}

/** Validate a canonical shot against inputs read from the current formal versions. */
export function validateStoryboardShot(input: unknown, context: StoryboardShotContext): StoryboardShot | null {
  if (!exactRecord(input, fields)) return null;
  const shot = input;
  if (!textFields.every(field => typeof shot[field] === "string") || shot.visual === ""
    || typeof shot.ordinal !== "number" || !Number.isInteger(shot.ordinal) || shot.ordinal < 1
    || typeof shot.durationSeconds !== "number" || !Number.isFinite(shot.durationSeconds) || shot.durationSeconds <= 0
    || !Array.isArray(shot.characters) || ![...shot.characters].every(character => typeof character === "string")
    || !isAllowed(shot.shotSize, shotSizes) || !isAllowed(shot.cameraAngle, cameraAngles)
    || !uniqueReferences(shot.splitReason, splitReasons, 1)
    || !uniqueReferences(shot.assetIds, context.assetIds)
    || !validateSourceEvidence(shot.provenance, context)) return null;

  const scene = context.scenes.find(scene => scene.id === shot.sceneId && scene.episodeId === shot.episodeId);
  if (!scene || !uniqueReferences(shot.scriptElementIds, scene.scriptElementIds, 1)) return null;
  return structuredClone(shot) as StoryboardShot;
}

export type StoryboardResponseIdentity = {
  jobId: string;
  projectId: string;
  chapterId: string;
  sourceVersionId: string;
  upstreamConfirmedVersionIds: readonly string[];
};

export class StoryboardContentError extends Error {
  readonly code = "INVALID_RESPONSE";
  constructor() { super("INVALID_RESPONSE"); }
}

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

const identityKeys = ["jobId", "projectId", "chapterId", "sourceVersionId"] as const;

/** Reject an unbound envelope before consuming any shot. Quarantine invalid shots by scope. */
export function validateStoryboardResponse(response: unknown, expected: StoryboardResponseIdentity, context: StoryboardShotContext) {
  if (!exactRecord(response, [...identityKeys, "contractVersion", "stage", "upstreamConfirmedVersionIds", "status", "items"])
    || response.contractVersion !== "0.1.0" || response.stage !== "storyboard"
    || identityKeys.some(key => response[key] !== expected[key]) || context.sourceVersionId !== expected.sourceVersionId
    || !Array.isArray(response.upstreamConfirmedVersionIds) || expected.upstreamConfirmedVersionIds.length < 2
    || response.upstreamConfirmedVersionIds.length !== expected.upstreamConfirmedVersionIds.length
    || !expected.upstreamConfirmedVersionIds.every((id, i) => (response.upstreamConfirmedVersionIds as unknown[])[i] === id)
    || !Array.isArray(response.items) || !response.items.length || response.items.length > 1000) throw new StoryboardContentError();

  const shots: StoryboardShot[] = [];
  const failures: Array<{ scopeKey: string; code: "PROVIDER_ITEM_FAILED" | "INVALID_SHOT"; retryable: boolean }> = [];
  const scopes = new Set<string>();
  const shotIds = new Set<string>();
  let providerFailures = 0;
  for (const item of response.items) {
    const success = exactRecord(item, ["scopeKey", "status", "value"]) && item.status === "succeeded";
    const failure = exactRecord(item, ["scopeKey", "status", "error"]) && item.status === "failed";
    if ((!success && !failure) || typeof item.scopeKey !== "string" || !item.scopeKey.trim()
      || item.scopeKey.length > 256 || /[\r\n]/.test(item.scopeKey) || scopes.has(item.scopeKey)) throw new StoryboardContentError();
    scopes.add(item.scopeKey);
    if (failure) {
      const error = item.error;
      if (!exactRecord(error, ["code", "message", "retryable"]) || typeof error.code !== "string"
        || typeof error.message !== "string" || typeof error.retryable !== "boolean") throw new StoryboardContentError();
      providerFailures++;
      failures.push({ scopeKey: item.scopeKey, code: "PROVIDER_ITEM_FAILED", retryable: error.retryable });
      continue;
    }
    const shot = validateStoryboardShot(item.value, context);
    if (!shot || shotIds.has(shot.id)) {
      failures.push({ scopeKey: item.scopeKey, code: "INVALID_SHOT", retryable: true });
      continue;
    }
    shotIds.add(shot.id);
    shots.push(shot);
  }
  const status = providerFailures === 0 ? "succeeded" : providerFailures === response.items.length ? "failed" : "partially_succeeded";
  if (response.status !== status) throw new StoryboardContentError();
  const generationStatus = failures.length === 0 ? "succeeded" : shots.length ? "partially_succeeded" : "failed";
  return { shots, failures, generationStatus } as const;
}
