import type { LedgerDatabasePool } from "./postgres-ledger.ts";
import { createInternalBillingAccess, type InternalBillingPolicy } from "./internal-access.ts";
import { createCheckedEvidenceMaterialRepository } from "./evidence-database-readiness.ts";
import { createVerifiedSettlementEvidenceReader } from "./verified-evidence.ts";

/** Trusted host only; read projection, no material/write exposure or remote identity authentication. */
export async function createServerSettlementEvidenceReader(options: { pool: LedgerDatabasePool; policy: InternalBillingPolicy }) {
  let policy: InternalBillingPolicy;
  try { policy = structuredClone(options.policy); }
  catch { throw new Error("BILLING_ACCESS_CONFIG_INVALID"); }
  const access = createInternalBillingAccess(policy);
  const source = await createCheckedEvidenceMaterialRepository(options.pool);
  const reader = createVerifiedSettlementEvidenceReader({ access, source });
  return Object.freeze({
    read: (workspaceId: string, evidenceId: string) => reader.read({ workspaceId, serviceId: policy.serviceId }, evidenceId),
  });
}
