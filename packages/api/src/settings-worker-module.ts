import { Module,type DynamicModule } from "@nestjs/common";
import type { StoryKnowledgeTaskWorker } from "./story-knowledge-task-worker.ts";
export const SETTINGS_WORKER = Symbol("SETTINGS_WORKER");
export class SettingsWorkerModule {
  static forWorker(worker: StoryKnowledgeTaskWorker): DynamicModule {
    return { module: SettingsWorkerModule,providers: [
      { provide: SETTINGS_WORKER,useValue: worker },
      { provide: "SETTINGS_WORKER_LIFECYCLE",useValue: {
        onApplicationBootstrap() { void worker.start().catch(() => {}); },
        async onApplicationShutdown() { await worker.stop(); },
      } },
    ],exports: [SETTINGS_WORKER] };
  }
}
Module({})(SettingsWorkerModule);
