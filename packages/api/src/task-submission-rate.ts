import { HttpException, ServiceUnavailableException } from "@nestjs/common";
import type { Actor } from "@novel-adaptation/identity";
import type { ModelRateLimiter } from "./model-rate-limit.ts";

export type TaskSubmissionRequest = { actor: Actor; res: { setHeader(name: string,value: string): unknown } };
/** Authenticated, shape-valid submission attempts share one workspace budget. */
export async function enforceTaskSubmissionRate(limiter: ModelRateLimiter | null, request: TaskSubmissionRequest): Promise<void> {
  let result;
  try {
    if (!limiter) throw new Error();
    result = await limiter.consume(request.actor.workspaceId,"generate");
    if (typeof result.allowed !== "boolean" || !Number.isInteger(result.retryAfterSeconds)
      || result.retryAfterSeconds < 0 || result.retryAfterSeconds > 60 || !result.allowed && result.retryAfterSeconds < 1) throw new Error();
  } catch { throw new ServiceUnavailableException({ code: "STORAGE_UNAVAILABLE",message: "STORAGE_UNAVAILABLE" }); }
  if (!result.allowed) {
    request.res.setHeader("Retry-After",String(result.retryAfterSeconds));
    throw new HttpException({ code: "TASK_RATE_LIMITED",message: "TASK_RATE_LIMITED" },429);
  }
}
