import { Module,type DynamicModule } from "@nestjs/common";
import type { StoryKnowledgeTaskWorker } from "./story-knowledge-task-worker.ts";
export const SETTINGS_WORKER = Symbol("SETTINGS_WORKER");
export const SETTINGS_REGENERATION_WORKER = Symbol("SETTINGS_REGENERATION_WORKER");
export class SettingsWorkerModule {
  static forWorker(worker: StoryKnowledgeTaskWorker,regenerationWorker?: StoryKnowledgeTaskWorker): DynamicModule {
    return { module: SettingsWorkerModule,providers: [
      { provide: SETTINGS_WORKER,useValue: worker },
      ...(regenerationWorker ? [{ provide: SETTINGS_REGENERATION_WORKER,useValue: regenerationWorker }] : []),
      { provide: "SETTINGS_WORKER_LIFECYCLE",useValue: {
        onApplicationBootstrap() { void worker.start().catch(() => {});void regenerationWorker?.start().catch(() => {}); },
        async onApplicationShutdown() { await Promise.allSettled([worker.stop(),regenerationWorker?.stop()]); },
      } },
    ],exports: [SETTINGS_WORKER,...(regenerationWorker ? [SETTINGS_REGENERATION_WORKER] : [])] };
  }
}
Module({})(SettingsWorkerModule);
