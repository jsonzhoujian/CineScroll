import { createHash } from "node:crypto";
import { createVerifiedSettlementEvidenceReader, type EvidenceMaterialSource } from "./verified-evidence.ts";

export type StoredEvidenceMaterial = { material: unknown; fingerprint: string; predecessorId: string | null };
/** Low-level trusted-server seam. No member authorization or origin authentication. */
export interface EvidenceMaterialRepository extends EvidenceMaterialSource {
  append(workspaceId: string, material: unknown, predecessorId?: string | null): Promise<StoredEvidenceMaterial>;
  get(workspaceId: string, evidenceId: string): Promise<StoredEvidenceMaterial | null>;
}
export class EvidenceMaterialRepositoryError extends Error {
  readonly code: "INVALID_MATERIAL" | "CONFLICT" | "PREDECESSOR_NOT_FOUND";
  constructor(code: EvidenceMaterialRepositoryError["code"]) { super(code); this.code = code; }
}
function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) throw new Error();
    return `[${value.map(canonical).join(",")}]`;
  }
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  throw new Error();
}

/** Rule fixture only: no durability, cross-process safety, capacity management or production wiring. */
export class InMemoryEvidenceMaterialRepository implements EvidenceMaterialRepository {
  readonly #workspaces = new Map<string, Map<string, StoredEvidenceMaterial>>();
  async append(workspaceId: string, input: unknown, predecessorId: string | null = null): Promise<StoredEvidenceMaterial> {
    let material: Record<string, unknown>, fingerprint: string;
    try {
      material = structuredClone(input) as Record<string, unknown>;
      if (predecessorId !== null && (typeof predecessorId !== "string" || predecessorId.length === 0 || predecessorId.length > 256
        || predecessorId.trim() !== predecessorId || /[\r\n]/.test(predecessorId))) throw new Error();
      const reader = createVerifiedSettlementEvidenceReader({
        // Schema validation only; this is NOT an authorization or authenticity grant.
        access: { authorize: async () => true }, source: { read: async () => material },
      });
      await reader.read({ workspaceId, serviceId: "repository-schema-validation" }, material.id as string);
      fingerprint = createHash("sha256").update(canonical({ material, predecessorId })).digest("hex");
    } catch { throw new EvidenceMaterialRepositoryError("INVALID_MATERIAL"); }
    const evidenceId = material.id as string;
    const records = this.#workspaces.get(workspaceId) ?? new Map<string, StoredEvidenceMaterial>();
    if (predecessorId === evidenceId) throw new EvidenceMaterialRepositoryError("CONFLICT");
    const existing = records.get(evidenceId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new EvidenceMaterialRepositoryError("CONFLICT");
      return structuredClone(existing);
    }
    if (predecessorId !== null) {
      const predecessor = records.get(predecessorId);
      if (!predecessor) throw new EvidenceMaterialRepositoryError("PREDECESSOR_NOT_FOUND");
      const previous = predecessor.material as Record<string, unknown>;
      if (canonical(previous.binding) !== canonical(material.binding) || canonical(previous.snapshot) !== canonical(material.snapshot)
        || (previous.execution as Record<string, unknown>).id !== (material.execution as Record<string, unknown>).id) {
        throw new EvidenceMaterialRepositoryError("CONFLICT");
      }
    }
    const stored = { material, fingerprint, predecessorId };
    records.set(evidenceId, stored);
    this.#workspaces.set(workspaceId, records);
    return structuredClone(stored);
  }
  async get(workspaceId: string, evidenceId: string): Promise<StoredEvidenceMaterial | null> {
    return structuredClone(this.#workspaces.get(workspaceId)?.get(evidenceId) ?? null);
  }
  async read(workspaceId: string, evidenceId: string): Promise<unknown> {
    return (await this.get(workspaceId, evidenceId))?.material ?? null;
  }
}
