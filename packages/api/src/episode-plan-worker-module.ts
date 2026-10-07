import { Module, type DynamicModule } from "@nestjs/common";
import type { StoryKnowledgeTaskWorker } from "./story-knowledge-task-worker.ts";

export const EPISODE_PLAN_WORKER = Symbol("EPISODE_PLAN_WORKER");
/** Separate registration token permits both stage workers in the same application. */
export class EpisodePlanWorkerModule {
  static forWorker(worker: StoryKnowledgeTaskWorker): DynamicModule {
    return { module: EpisodePlanWorkerModule, providers: [
      { provide: EPISODE_PLAN_WORKER, useValue: worker },
      { provide: "EPISODE_PLAN_WORKER_LIFECYCLE", useValue: {
        onApplicationBootstrap() { void worker.start().catch(() => {}); },
        async onApplicationShutdown() { await worker.stop(); },
      } },
    ], exports: [EPISODE_PLAN_WORKER] };
  }
}
Module({})(EpisodePlanWorkerModule);
