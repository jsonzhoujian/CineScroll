import { createHash } from "node:crypto";
import { canonicalEvidenceValue } from "./evidence-material-repository.ts";
import type { EvidenceSourceReferences } from "./evidence-write-preflight.ts";

export type V2PublicationCommand = {
  protocolVersion: "evidence-publication-v2"; workspaceId: string; requestId: string; unitId: string;
  operation: "publish" | "supplement"; references: EvidenceSourceReferences; expectedSealId: string;
  expectedGeneration: number; expectedManifestFingerprint: string; predecessorId: string | null;
};
export type V2PublicationIdentity = V2PublicationCommand & { serviceId: string };
export type PreparedV2PublicationIdentity = { identity: V2PublicationIdentity; requestFingerprint: string; evidenceId: string; auditId: string };
export class V2PublicationProtocolError extends Error {
  readonly code = "INVALID_PUBLICATION";
  constructor() { super("INVALID_PUBLICATION"); }
}
const digest = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const validId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256
  && value.trim() === value && !/[\r\n]/.test(value) && !value.includes("://") && !/[\*?]/.test(value);
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype && Reflect.ownKeys(value).length === keys.length
    && keys.every(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable === true && Object.hasOwn(descriptor, "value");
    });
}
function validReferences(value: unknown): value is EvidenceSourceReferences {
  const names = ["task", "snapshot", "execution", "result", "validation", "pricing"];
  if (!exact(value, names)) return false;
  return names.every(name => {
    const ref = value[name];
    return ["result", "validation", "pricing"].includes(name) && ref === null
      || exact(ref, ["id", "version"]) && validId(ref.id) && validId(ref.version);
  });
}

/** Protocol preparation only. Does not authorize, authenticate sources, publish or reserve a shared request key. */
export function prepareV2PublicationIdentity(serviceId: string, command: unknown): PreparedV2PublicationIdentity {
  try {
    const candidate = command;
    if (!exact(candidate, ["protocolVersion", "workspaceId", "requestId", "unitId", "operation", "references", "expectedSealId",
      "expectedGeneration", "expectedManifestFingerprint", "predecessorId"]) || !validId(serviceId)
      || candidate.protocolVersion !== "evidence-publication-v2" || !["publish", "supplement"].includes(candidate.operation as string)
      || ![candidate.workspaceId, candidate.requestId, candidate.unitId, candidate.expectedSealId].every(validId)
      || !Number.isSafeInteger(candidate.expectedGeneration) || Number(candidate.expectedGeneration) <= 0
      || typeof candidate.expectedManifestFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(candidate.expectedManifestFingerprint)
      || !validReferences(candidate.references)
      || (candidate.operation === "publish" ? candidate.predecessorId !== null : !validId(candidate.predecessorId))) throw new Error();
    const identity = { ...structuredClone(candidate), serviceId } as V2PublicationIdentity;
    const requestFingerprint = digest(canonicalEvidenceValue(identity));
    const requestIdDigest = digest(JSON.stringify([identity.protocolVersion, identity.workspaceId, identity.requestId]));
    if (identity.predecessorId === `evp2_${requestIdDigest}`) throw new Error();
    return { identity, requestFingerprint, evidenceId: `evp2_${requestIdDigest}`, auditId: `audit2_${requestIdDigest}` };
  } catch { throw new V2PublicationProtocolError(); }
}
