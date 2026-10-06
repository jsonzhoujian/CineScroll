import { Module, type DynamicModule } from "@nestjs/common";
import { StoryKnowledgeTaskWorker, type StoryKnowledgeWorkerOptions } from "./story-knowledge-task-worker.ts";

/** Opt-in server module; no public routes and no production entry-point mounting. */
export class StoryKnowledgeWorkerModule {
  static register(options: StoryKnowledgeWorkerOptions): DynamicModule {
    return this.forWorker(new StoryKnowledgeTaskWorker(options));
  }
  static forWorker(worker: StoryKnowledgeTaskWorker): DynamicModule {
    return { module: StoryKnowledgeWorkerModule, providers: [
      { provide: StoryKnowledgeTaskWorker, useValue: worker },
      { provide: "STORY_KNOWLEDGE_WORKER_LIFECYCLE", useValue: {
        onApplicationBootstrap() {
          // Lifetime must not block bootstrap. Worker records a sanitized failure status.
          void worker.start().catch(() => {});
        },
        async onApplicationShutdown() { await worker.stop(); },
      } },
    ], exports: [StoryKnowledgeTaskWorker] };
  }
}
Module({})(StoryKnowledgeWorkerModule);
