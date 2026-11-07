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
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const shot = input as Record<string, unknown>;
  if (Object.keys(shot).length !== fields.length || !fields.every(field => Object.hasOwn(shot, field))) return null;
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
