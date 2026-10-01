import { ModelSettingsError, type ModelConnectionProbe, type ModelConfiguration } from "./model-settings.ts";

/** Native model-directory access only; generation capability is not inferred from listing. */
export class NativeModelDirectoryProbe implements ModelConnectionProbe {
  readonly #routes: Readonly<Record<string, ModelConfiguration["processingRegion"]>>;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutMs: number;
  constructor(options: { routes: Readonly<Record<string, ModelConfiguration["processingRegion"]>>; fetch?: typeof globalThis.fetch; timeoutMs?: number }) {
    const timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000
      || Object.entries(options.routes).some(([provider, route]) => provider !== "deepseek" || !["mainland", "overseas", "unknown"].includes(route))) {
      throw new ModelSettingsError("INVALID_CONFIGURATION");
    }
    this.#routes = Object.freeze({ ...options.routes }); this.#timeoutMs = timeoutMs; this.#fetch = options.fetch ?? globalThis.fetch;
  }
  processingRegion(providerId: string): ModelConfiguration["processingRegion"] { return providerId === "deepseek" ? this.#routes.deepseek ?? "unknown" : "unknown"; }
  async test(input: { providerId: string; apiKey: string }) {
    if (input.providerId !== "deepseek" || this.processingRegion(input.providerId) === "unknown"
      || typeof input.apiKey !== "string" || !input.apiKey.trim() || input.apiKey.length > 8192 || /[\r\n]/.test(input.apiKey)) throw new ModelSettingsError("PROVIDER_UNAVAILABLE");
    try {
      const response = await this.#fetch("https://api.deepseek.com/models", {
        method: "GET", redirect: "error", signal: AbortSignal.timeout(this.#timeoutMs), headers: { authorization: `Bearer ${input.apiKey}` },
      });
      if (!response.ok || response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json" || !response.body) {
        await response.body?.cancel().catch(() => {}); throw new ModelSettingsError("PROVIDER_UNAVAILABLE");
      }
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          total += value.length; if (total > 512_000) throw new ModelSettingsError("PROVIDER_UNAVAILABLE"); chunks.push(value);
        }
      } catch (error) { await reader.cancel().catch(() => {}); throw error; }
      finally { reader.releaseLock(); }
      const bytes = new Uint8Array(total); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      const result: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (!record(result) || result.object !== "list" || !Array.isArray(result.data) || !result.data.length || result.data.length > 1000) throw new ModelSettingsError("PROVIDER_UNAVAILABLE");
      const modelIds: string[] = [];
      for (const item of result.data) {
        if (!record(item) || item.object !== "model" || typeof item.id !== "string" || !item.id.trim() || item.id.length > 256 || modelIds.includes(item.id)) throw new ModelSettingsError("PROVIDER_UNAVAILABLE");
        modelIds.push(item.id);
      }
      return { modelIds, processingRegion: this.processingRegion(input.providerId) };
    } catch { throw new ModelSettingsError("PROVIDER_UNAVAILABLE"); }
  }
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
