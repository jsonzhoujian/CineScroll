import { PostgresModelRateLimiter } from "../src/model-rate-limit.ts";

/** Simulated persistence boundary for tests unrelated to database rate windows. */
export function availableRateLimiter() {
  return new PostgresModelRateLimiter({ connect: async () => ({
    async query() { return { rows: [{ allowed: true,retry_after: 0 }] }; }, release() {},
  }) });
}
