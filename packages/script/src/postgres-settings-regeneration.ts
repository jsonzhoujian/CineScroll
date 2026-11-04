import type { Actor } from "./index.ts";
import type { ModelSettingsPool } from "./postgres-model-settings.ts";
import type { ConfirmedScriptHandoff } from "./script-handoff.ts";
import { PostgresSettingsReviewRepository } from "./postgres-settings-review.ts";
import { SettingsReviewError,type SettingsVersion } from "./settings-review.ts";
import { settingsRegenerationOperationId,type SettingsRegenerationRepository } from "./settings-regeneration.ts";
/** Shares the review transaction; SQL validates the running task, selection and exact merge. */
export class PostgresSettingsRegenerationRepository implements SettingsRegenerationRepository {
  private readonly reviews: PostgresSettingsReviewRepository;
  constructor(pool: ModelSettingsPool,handoff: Pick<ConfirmedScriptHandoff,"read">) { this.reviews = new PostgresSettingsReviewRepository(pool,handoff); }
  findActive(a: Actor,p: string,c: string) { return this.reviews.findActive(a,p,c); }
  async findGeneration(a: Actor,p: string,c: string,jobId: string) {
    const v = await this.reviews.findOperation(a,p,c,settingsRegenerationOperationId(jobId));
    if (v && (v.operation?.kind !== "regenerate" || v.regeneration?.jobId !== jobId)) throw new SettingsReviewError("VERSION_CONFLICT");
    return v;
  }
  saveGeneration(a: Actor,v: SettingsVersion,expected: string) {
    if (!v.regeneration || v.operation?.kind !== "regenerate" || v.operation.requestId !== settingsRegenerationOperationId(v.regeneration.jobId)) throw new SettingsReviewError("INVALID_COMMAND");
    return this.reviews.save(a,v,expected);
  }
}
