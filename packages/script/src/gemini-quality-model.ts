import type { ScriptQualityModelPort } from "./script-quality.ts";
import { QUALITY_REVIEW_INSTRUCTIONS, ScriptQualityProviderError } from "./http-quality-model.ts";
import { readBoundedJson } from "./bounded-json.ts";

/** Direct Gemini Developer API only; authorize the pinned workspace credential before construction. */
export class GeminiQualityModel implements ScriptQualityModelPort {
  readonly #apiKey: string;
  readonly #model: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutMs: number;
  constructor(options: { apiKey: string; model: string; processingRegion: "mainland" | "overseas" | "unknown";
    allowNonMainland?: boolean; timeoutMs?: number; fetch?: typeof globalThis.fetch }) {
    const timeoutMs = options.timeoutMs ?? 60_000;
    if (typeof options.apiKey !== "string" || !options.apiKey.trim() || options.apiKey.length > 8192 || /[\r\n]/.test(options.apiKey)
      || typeof options.model !== "string" || options.model.length > 256 || !/^models\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(options.model)
      || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000
      || options.processingRegion !== "overseas" || options.allowNonMainland !== true) throw new ScriptQualityProviderError();
    this.#apiKey = options.apiKey; this.#model = options.model; this.#timeoutMs = timeoutMs; this.#fetch = options.fetch ?? globalThis.fetch;
  }
  async assess(input: Parameters<ScriptQualityModelPort["assess"]>[0]): Promise<unknown> {
    try {
      const versionId = input.version.id;
      const body = JSON.stringify({ systemInstruction: { parts: [{ text: QUALITY_REVIEW_INSTRUCTIONS }] },
        contents: [{ role: "user", parts: [{ text: JSON.stringify(input) }] }],
        generationConfig: { responseMimeType: "application/json", candidateCount: 1, maxOutputTokens: 4096 } });
      if (new TextEncoder().encode(body).length > 2_000_000) throw new ScriptQualityProviderError();
      const response = await this.#fetch(`https://generativelanguage.googleapis.com/v1beta/${this.#model}:generateContent`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(this.#timeoutMs),
        headers: { "x-goog-api-key": this.#apiKey, "content-type": "application/json" }, body });
      const result = await readBoundedJson(response, 1_000_000);
      if (!record(result) || result.modelVersion !== this.#model.slice("models/".length)
        || !Array.isArray(result.candidates) || result.candidates.length !== 1
        || (result.promptFeedback !== undefined && (!record(result.promptFeedback) || result.promptFeedback.blockReason !== undefined))) throw new ScriptQualityProviderError();
      const candidate = result.candidates[0];
      if (!record(candidate) || candidate.index !== 0 || candidate.finishReason !== "STOP" || !record(candidate.content)
        || candidate.content.role !== "model" || !Array.isArray(candidate.content.parts) || !candidate.content.parts.length) throw new ScriptQualityProviderError();
      let text = "";
      for (const part of candidate.content.parts) {
        if (!record(part) || typeof part.text !== "string" || part.thought === true
          || Object.keys(part).some((key) => !["text", "thought", "thoughtSignature"].includes(key))) throw new ScriptQualityProviderError();
        text += part.text;
      }
      const assessment: unknown = JSON.parse(text);
      if (!record(assessment) || assessment.versionId !== versionId) throw new ScriptQualityProviderError();
      return assessment; // Full verdict and evidence validation remains in the rule evaluator.
    } catch { throw new ScriptQualityProviderError(); }
  }
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
