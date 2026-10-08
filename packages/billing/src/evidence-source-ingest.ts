import { createHash } from "node:crypto";
import { canonicalEvidenceValue } from "./evidence-material-repository.ts";

export type SourceIngestReference = { id: string; version: string };
type CommonCommand = { protocolVersion: "source-ingest-v1"; workspaceId: string; unitId: string; ingestId: string };
export type InitializeSourceCommand = CommonCommand & {
  taskReference: SourceIngestReference; snapshotReference: SourceIngestReference; executionReference: SourceIngestReference;
};
export type RegisterSourceCommand = CommonCommand & {
  expectedHeadRevision: number; businessReference: SourceIngestReference & { kind: "task" | "snapshot" };
};
export type SourceIngestIdentity = (InitializeSourceCommand & { operation: "initialize" }
  | RegisterSourceCommand & { operation: "register" }) & { serviceId: string };
export type PreparedSourceIngestIdentity = {
  identity: SourceIngestIdentity; commandFingerprint: string; ingestKey: { workspaceId: string; ingestId: string };
};
export class SourceIngestProtocolError extends Error {
  readonly code = "INVALID_COMMAND";
  constructor() { super("INVALID_COMMAND"); }
}
const validId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256
  && value.trim() === value && !/[\r\n]/.test(value) && !value.includes("://") && !/[\*?]/.test(value);
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).length === keys.length && keys.every(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable === true && Object.hasOwn(descriptor, "value");
    });
}
function reference(value: unknown, business = false): boolean {
  return exact(value, business ? ["kind", "id", "version"] : ["id", "version"])
    && validId(value.id) && validId(value.version) && (!business || value.kind === "task" || value.kind === "snapshot");
}

/** Pure protocol preparation; no authentication, key reservation, business proof or database writes. */
export function prepareSourceIngestIdentity(serviceId: string, operation: "initialize" | "register", command: unknown): PreparedSourceIngestIdentity {
  try {
    const keys = ["protocolVersion", "workspaceId", "unitId", "ingestId"];
    if (!validId(serviceId) || (operation !== "initialize" && operation !== "register")
      || !exact(command, [...keys, ...(operation === "initialize" ? ["taskReference", "snapshotReference", "executionReference"]
        : ["expectedHeadRevision", "businessReference"])])
      || command.protocolVersion !== "source-ingest-v1" || ![command.workspaceId, command.unitId, command.ingestId].every(validId)
      || (operation === "initialize" ? ![command.taskReference, command.snapshotReference, command.executionReference].every(value => reference(value))
        : !Number.isSafeInteger(command.expectedHeadRevision) || Number(command.expectedHeadRevision) <= 0 || !reference(command.businessReference, true)))
      throw new SourceIngestProtocolError();
    const identity = { ...structuredClone(command), serviceId, operation } as SourceIngestIdentity;
    return { identity, commandFingerprint: createHash("sha256").update(canonicalEvidenceValue(identity), "utf8").digest("hex"),
      ingestKey: { workspaceId: identity.workspaceId, ingestId: identity.ingestId } };
  } catch { throw new SourceIngestProtocolError(); }
}
