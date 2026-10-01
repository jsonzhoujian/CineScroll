import type { ScriptQualityModelPort } from "./script-quality.ts";
import { QUALITY_REVIEW_INSTRUCTIONS, ScriptQualityProviderError } from "./http-quality-model.ts";

/** Server-only native assessment adapter; callers must authorize the pinned workspace configuration first. */
export class DeepSeekQualityModel implements ScriptQualityModelPort {
  readonly #apiKey: string;
  readonly #model: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutMs: number;
  constructor(options: { apiKey: string; model: string; processingRegion: "mainland" | "overseas" | "unknown";
    allowNonMainland?: boolean; timeoutMs?: number; fetch?: typeof globalThis.fetch }) {
    const timeoutMs = options.timeoutMs ?? 60_000;
    if (typeof options.apiKey !== "string" || !options.apiKey.trim() || options.apiKey.length > 8192 || /[\r\n]/.test(options.apiKey)
      || typeof options.model !== "string" || !options.model.trim() || options.model.length > 256
      || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000
      || !["mainland", "overseas"].includes(options.processingRegion)
      || (options.processingRegion !== "mainland" && options.allowNonMainland !== true)) throw new ScriptQualityProviderError();
    this.#apiKey = options.apiKey; this.#model = options.model; this.#timeoutMs = timeoutMs; this.#fetch = options.fetch ?? globalThis.fetch;
  }
  async assess(input: Parameters<ScriptQualityModelPort["assess"]>[0]): Promise<unknown> {
    try {
      const versionId = input.version.id;
      const body = JSON.stringify({ model: this.#model, stream: false, response_format: { type: "json_object" },
        messages: [{ role: "system", content: QUALITY_REVIEW_INSTRUCTIONS }, { role: "user", content: JSON.stringify(input) }] });
      if (new TextEncoder().encode(body).length > 2_000_000) throw new ScriptQualityProviderError();
      const response = await this.#fetch("https://api.deepseek.com/chat/completions", { method: "POST", redirect: "error",
        headers: { authorization: `Bearer ${this.#apiKey}`, "content-type": "application/json" }, body, signal: AbortSignal.timeout(this.#timeoutMs) });
      if (!response.ok || response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json" || !response.body) {
        await response.body?.cancel().catch(() => {}); throw new ScriptQualityProviderError();
      }
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          total += value.length; if (total > 1_000_000) throw new ScriptQualityProviderError(); chunks.push(value);
        }
      } catch (error) { await reader.cancel().catch(() => {}); throw error; }
      finally { reader.releaseLock(); }
      const bytes = new Uint8Array(total); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      const completion: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (!record(completion) || completion.object !== "chat.completion" || completion.model !== this.#model
        || !Array.isArray(completion.choices) || completion.choices.length !== 1) throw new ScriptQualityProviderError();
      const choice = completion.choices[0];
      if (!record(choice) || choice.index !== 0 || choice.finish_reason !== "stop" || !record(choice.message)
        || choice.message.role !== "assistant" || typeof choice.message.content !== "string" || !choice.message.content.trim()
        || choice.message.tool_calls !== undefined || choice.message.function_call !== undefined) throw new ScriptQualityProviderError();
      const assessment: unknown = JSON.parse(choice.message.content);
      if (!record(assessment) || assessment.versionId !== versionId) throw new ScriptQualityProviderError();
      return assessment; // Evaluator still validates every verdict/reference before confirmation.
    } catch { throw new ScriptQualityProviderError(); }
  }
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
