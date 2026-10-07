import { CreditLedgerService, type GrantCommand, type ReserveCommand, type SettleCommand, type SettlementEvidenceReader } from "./index.ts";
import { createCheckedCreditLedgerRepository } from "./database-readiness.ts";
import { createInternalBillingAccess, type InternalBillingPolicy } from "./internal-access.ts";
import type { LedgerDatabasePool } from "./postgres-ledger.ts";

/** Trusted host only. Pool lifetime remains with host; no HTTP or production charging. */
export async function createServerCreditLedger(options: {
  pool: LedgerDatabasePool; policy: InternalBillingPolicy; clock: () => Date; evidenceReader?: SettlementEvidenceReader;
}) {
  // Snapshot identity before asynchronous readiness; never accept identity from a call.
  let policy: InternalBillingPolicy;
  try { policy = structuredClone(options.policy); }
  catch { throw new Error("BILLING_ACCESS_CONFIG_INVALID"); }
  const access = createInternalBillingAccess(policy);
  const { pool, clock, evidenceReader } = options;
  if (!pool || typeof pool.connect !== "function" || typeof clock !== "function"
    || (evidenceReader !== undefined && (!evidenceReader || typeof evidenceReader.read !== "function"))) {
    throw new Error("BILLING_SERVER_CONFIG_INVALID");
  }
  const boundPool: LedgerDatabasePool = { connect: pool.connect.bind(pool) };
  const boundEvidence = evidenceReader ? { read: evidenceReader.read.bind(evidenceReader) } : undefined;
  const repository = await createCheckedCreditLedgerRepository(boundPool);
  const service = new CreditLedgerService({ repository, access, clock, ...(boundEvidence ? { evidenceReader: boundEvidence } : {}) });
  const actor = (workspaceId: string) => ({ workspaceId, serviceId: policy.serviceId });
  return Object.freeze({
    grant: (workspaceId: string, command: GrantCommand) => service.grant(actor(workspaceId), command),
    reserve: (workspaceId: string, command: ReserveCommand) => service.reserve(actor(workspaceId), command),
    settle: (workspaceId: string, command: SettleCommand) => service.settle(actor(workspaceId), command),
    balance: (workspaceId: string) => service.balance(actor(workspaceId)),
    entries: (workspaceId: string) => service.entries(actor(workspaceId)),
    task: (workspaceId: string, taskId: string) => service.task(actor(workspaceId), taskId),
  });
}
