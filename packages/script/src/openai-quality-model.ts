import type { ScriptQualityModelPort } from "./script-quality.ts";
import { QUALITY_REVIEW_INSTRUCTIONS, ScriptQualityProviderError } from "./http-quality-model.ts";
import { readBoundedJson } from "./bounded-json.ts";

/** Server-only direct Responses adapter; callers authorize the pinned workspace credential first. */
export class OpenAIQualityModel implements ScriptQualityModelPort {
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
      const body = JSON.stringify({ model: this.#model, instructions: QUALITY_REVIEW_INSTRUCTIONS,
        input: [{ role: "user", content: JSON.stringify(input) }], store: false, stream: false, background: false,
        max_output_tokens: 4096, text: { format: { type: "json_object" } } });
      if (new TextEncoder().encode(body).length > 2_000_000) throw new ScriptQualityProviderError();
      const response = await this.#fetch("https://api.openai.com/v1/responses", { method: "POST", redirect: "error",
        headers: { authorization: `Bearer ${this.#apiKey}`, "content-type": "application/json" }, body, signal: AbortSignal.timeout(this.#timeoutMs) });
      const result = await readBoundedJson(response, 1_000_000);
      if (!record(result) || result.object !== "response" || result.model !== this.#model || result.status !== "completed"
        || result.error != null || result.incomplete_details != null || !Array.isArray(result.output)) throw new ScriptQualityProviderError();
      let text = ""; let messages = 0;
      for (const item of result.output) {
        if (!record(item)) throw new ScriptQualityProviderError();
        // Reasoning is metadata, never assessment text; tools/refusals remain forbidden.
        if (item.type === "reasoning") continue;
        if (item.type !== "message" || item.role !== "assistant" || item.status !== "completed"
          || !Array.isArray(item.content) || !item.content.length || ++messages > 1) throw new ScriptQualityProviderError();
        for (const part of item.content) {
          if (!record(part) || part.type !== "output_text" || typeof part.text !== "string") throw new ScriptQualityProviderError();
          text += part.text;
        }
      }
      if (messages !== 1) throw new ScriptQualityProviderError();
      const assessment: unknown = JSON.parse(text);
      if (!record(assessment) || assessment.versionId !== versionId) throw new ScriptQualityProviderError();
      return assessment; // Full verdict/reference validation remains in the rule evaluator.
    } catch { throw new ScriptQualityProviderError(); }
  }
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
