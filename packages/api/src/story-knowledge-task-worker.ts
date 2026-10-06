import { setTimeout } from "node:timers/promises";
import type { TaskScanMode } from "@novel-adaptation/script/model-tasks";
import type { StoryKnowledgeTaskDispatcher } from "./story-knowledge-task-dispatcher.ts";

type Options = {
  dispatcher: StoryKnowledgeTaskDispatcher;
  enabled?: boolean;
  workspaceIds: readonly string[];
  intervalMs?: number;
  maxBackoffMs?: number;
  wait?: (delayMs: number, signal: AbortSignal) => Promise<void>;
};

/** Server-only coordinator. Construction does not start a process or enable execution. */
export class StoryKnowledgeTaskWorker {
  readonly #options: Options;
  readonly #interval: number;
  readonly #maxBackoff: number;
  #active: Promise<void> | null = null;
  #controller: AbortController | null = null;

  constructor(options: Options) {
    this.#interval = options.intervalMs ?? 1000;
    this.#maxBackoff = options.maxBackoffMs ?? 60000;
    if (!Number.isInteger(this.#interval) || this.#interval < 100 || this.#interval > 60000 ||
        !Number.isInteger(this.#maxBackoff) || this.#maxBackoff < this.#interval || this.#maxBackoff > 300000 ||
        options.workspaceIds.some(id => typeof id !== "string" || !id.trim() || id.length > 256 || /[\r\n]/.test(id)) ||
        new Set(options.workspaceIds).size !== options.workspaceIds.length ||
        (options.enabled === true && options.workspaceIds.length === 0)) throw new Error("INVALID_WORKER_CONFIG");
    this.#options = { ...options, workspaceIds: [...options.workspaceIds] };
  }

  start(): Promise<void> {
    if (this.#active) return Promise.reject(new Error("WORKER_ALREADY_RUNNING"));
    if (this.#options.enabled !== true) return Promise.resolve();
    const controller = new AbortController();
    this.#controller = controller;
    this.#active = this.#loop(controller.signal).finally(() => {
      this.#active = null;
      this.#controller = null;
    });
    return this.#active;
  }

  async stop(): Promise<void> {
    this.#controller?.abort();
    await this.#active;
  }

  async #loop(signal: AbortSignal): Promise<void> {
    const cursors = new Map<string, Partial<Record<TaskScanMode, string | null>>>();
    let delay = this.#interval;
    while (!signal.aborted) {
      let failed = false;
      for (const workspaceId of this.#options.workspaceIds) {
        const cursor = cursors.get(workspaceId) ?? {};
        cursors.set(workspaceId, cursor);
        for (const mode of ["run", "recover"] as const) {
          if (signal.aborted) return;
          try {
            const result = await this.#options.dispatcher.tick(workspaceId, mode, { limit: 20, cursor: cursor[mode] ?? null }, signal);
            cursor[mode] = result.nextCursor;
            failed ||= result.items.some(item => item.outcome === "unavailable" || item.outcome === "limited");
          } catch {
            // Preserve the cursor; executor owns uncertainty and recovery. Never resubmit here.
            failed = true;
          }
        }
      }
      if (signal.aborted) return;
      delay = failed ? Math.min(delay * 2, this.#maxBackoff) : this.#interval;
      const wait = this.#options.wait ?? ((ms: number, abort: AbortSignal) => setTimeout(ms, undefined, { signal: abort }));
      try { await wait(delay, signal); }
      catch { if (!signal.aborted) throw new Error("WORKER_WAIT_FAILED"); }
    }
  }
}
