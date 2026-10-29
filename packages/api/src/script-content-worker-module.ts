import { Module, type DynamicModule } from "@nestjs/common";
import type { StoryKnowledgeTaskWorker } from "./story-knowledge-task-worker.ts";

export const SCRIPT_CONTENT_WORKER = Symbol("SCRIPT_CONTENT_WORKER");
/** Separate registration token permits both stage workers in the same application. */
export class ScriptContentWorkerModule {
  static forWorker(worker: StoryKnowledgeTaskWorker): DynamicModule {
    return { module: ScriptContentWorkerModule, providers: [
      { provide: SCRIPT_CONTENT_WORKER, useValue: worker },
      { provide: "SCRIPT_CONTENT_WORKER_LIFECYCLE", useValue: {
        onApplicationBootstrap() { void worker.start().catch(() => {}); },
        async onApplicationShutdown() { await worker.stop(); },
      } },
    ], exports: [SCRIPT_CONTENT_WORKER] };
  }
}
Module({})(ScriptContentWorkerModule);
