import type { ScriptQualityModelPort } from "./script-quality.ts";
import { QUALITY_REVIEW_INSTRUCTIONS, ScriptQualityProviderError } from "./http-quality-model.ts";
import { readBoundedJson } from "./bounded-json.ts";

/** Server-only direct Messages adapter; authorize the pinned workspace configuration before construction. */
export class AnthropicQualityModel implements ScriptQualityModelPort {
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
      || options.processingRegion !== "overseas" || options.allowNonMainland !== true) throw new ScriptQualityProviderError();
    this.#apiKey = options.apiKey; this.#model = options.model; this.#timeoutMs = timeoutMs; this.#fetch = options.fetch ?? globalThis.fetch;
  }
  async assess(input: Parameters<ScriptQualityModelPort["assess"]>[0]): Promise<unknown> {
    try {
      const versionId = input.version.id;
      const body = JSON.stringify({ model: this.#model, max_tokens: 4096, stream: false, system: QUALITY_REVIEW_INSTRUCTIONS,
        messages: [{ role: "user", content: JSON.stringify(input) }] });
      if (new TextEncoder().encode(body).length > 2_000_000) throw new ScriptQualityProviderError();
      const response = await this.#fetch("https://api.anthropic.com/v1/messages", { method: "POST", redirect: "error",
        headers: { "x-api-key": this.#apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" }, body, signal: AbortSignal.timeout(this.#timeoutMs) });
      const message = await readBoundedJson(response, 1_000_000);
      if (!record(message) || message.type !== "message" || message.role !== "assistant" || message.model !== this.#model
        || message.stop_reason !== "end_turn" || !Array.isArray(message.content) || !message.content.length) throw new ScriptQualityProviderError();
      let text = "";
      for (const block of message.content) {
        if (!record(block) || block.type !== "text" || typeof block.text !== "string") throw new ScriptQualityProviderError();
        text += block.text;
      }
      const assessment: unknown = JSON.parse(text);
      if (!record(assessment) || assessment.versionId !== versionId) throw new ScriptQualityProviderError();
      return assessment; // The rule evaluator validates exhaustive verdicts and source references.
    } catch { throw new ScriptQualityProviderError(); }
  }
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
