import type { BillingAccess } from "./index.ts";

type Operation = Parameters<BillingAccess["authorize"]>[1];
const operations: readonly string[] = ["read", "grant", "reserve", "settle"];
const validId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value && value !== "*";
function keys(value: unknown, expected: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Reflect.ownKeys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
}
export type InternalBillingPolicy = Readonly<{
  serviceId: string;
  grants: ReadonlyArray<Readonly<{ workspaceId: string; operations: ReadonlyArray<Operation> }>>;
}>;

/** Server-only authorization, not authentication. Bind one adapter per trusted service. */
export function createInternalBillingAccess(policy: InternalBillingPolicy): BillingAccess {
  let snapshot: InternalBillingPolicy;
  try {
    snapshot = structuredClone(policy);
    if (!keys(snapshot, ["serviceId", "grants"]) || !validId(snapshot.serviceId) || !Array.isArray(snapshot.grants)
      || new Set(snapshot.grants.map(grant => grant?.workspaceId)).size !== snapshot.grants.length
      || !snapshot.grants.every(grant => keys(grant, ["workspaceId", "operations"]) && validId(grant.workspaceId)
        && Array.isArray(grant.operations) && grant.operations.length > 0
        && new Set(grant.operations).size === grant.operations.length
        && grant.operations.every(operation => operations.includes(operation)))) throw new Error();
  } catch { throw new Error("BILLING_ACCESS_CONFIG_INVALID"); }
  return {
    async authorize(actor, operation) {
      try {
        const input = structuredClone(actor);
        return keys(input, ["workspaceId", "serviceId"]) && validId(input.workspaceId) && validId(input.serviceId)
          && operations.includes(operation) && input.serviceId === snapshot.serviceId && snapshot.grants.some(grant =>
            grant.workspaceId === input.workspaceId && grant.operations.includes(operation));
      } catch { return false; }
    },
  };
}
