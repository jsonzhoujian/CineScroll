import { ModelSettingsError, type ModelConnectionProbe, type ModelConfiguration } from "./model-settings.ts";
import { readBoundedJson } from "./bounded-json.ts";

/** Native model-directory access only; generation capability is not inferred from listing. */
export class NativeModelDirectoryProbe implements ModelConnectionProbe {
  readonly #routes: Readonly<Record<string, ModelConfiguration["processingRegion"]>>;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutMs: number;
  constructor(options: { routes: Readonly<Record<string, ModelConfiguration["processingRegion"]>>; fetch?: typeof globalThis.fetch; timeoutMs?: number }) {
    const timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000
      || Object.entries(options.routes).some(([provider, route]) => !["deepseek", "anthropic", "google"].includes(provider) || !["mainland", "overseas", "unknown"].includes(route)
        || (["anthropic", "google"].includes(provider) && route === "mainland"))) {
      throw new ModelSettingsError("INVALID_CONFIGURATION");
    }
    this.#routes = Object.freeze({ ...options.routes }); this.#timeoutMs = timeoutMs; this.#fetch = options.fetch ?? globalThis.fetch;
  }
  processingRegion(providerId: string): ModelConfiguration["processingRegion"] { return ["deepseek", "anthropic", "google"].includes(providerId) ? this.#routes[providerId] ?? "unknown" : "unknown"; }
  async test(input: { providerId: string; apiKey: string }) {
    if (!["deepseek", "anthropic", "google"].includes(input.providerId) || this.processingRegion(input.providerId) === "unknown"
      || typeof input.apiKey !== "string" || !input.apiKey.trim() || input.apiKey.length > 8192 || /[\r\n]/.test(input.apiKey)) throw new ModelSettingsError("PROVIDER_UNAVAILABLE");
    try {
      if (input.providerId === "anthropic") return await this.#anthropic(input.apiKey);
      if (input.providerId === "google") return await this.#google(input.apiKey);
      const response = await this.#fetch("https://api.deepseek.com/models", {
        method: "GET", redirect: "error", signal: AbortSignal.timeout(this.#timeoutMs), headers: { authorization: `Bearer ${input.apiKey}` },
      });
      const result = await readBoundedJson(response, 512_000);
      if (!record(result) || result.object !== "list" || !Array.isArray(result.data) || !result.data.length || result.data.length > 1000) throw new ModelSettingsError("PROVIDER_UNAVAILABLE");
      const modelIds: string[] = [];
      for (const item of result.data) {
        if (!record(item) || item.object !== "model" || typeof item.id !== "string" || !item.id.trim() || item.id.length > 256 || modelIds.includes(item.id)) throw new ModelSettingsError("PROVIDER_UNAVAILABLE");
        modelIds.push(item.id);
      }
      return { modelIds, processingRegion: this.processingRegion(input.providerId) };
    } catch { throw new ModelSettingsError("PROVIDER_UNAVAILABLE"); }
  }
  async #anthropic(apiKey: string) {
    const signal = AbortSignal.timeout(this.#timeoutMs); const modelIds: string[] = []; const cursors = new Set<string>(); let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const url = new URL("https://api.anthropic.com/v1/models"); url.searchParams.set("limit", "100");
      if (cursor) url.searchParams.set("after_id", cursor);
      const result = await readBoundedJson(await this.#fetch(url.toString(), { method: "GET", redirect: "error", signal,
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" } }), 512_000);
      if (!record(result) || !Array.isArray(result.data) || result.data.length > 100 || typeof result.has_more !== "boolean") throw new ModelSettingsError("PROVIDER_UNAVAILABLE");
      for (const item of result.data) {
        if (!record(item) || item.type !== "model" || typeof item.id !== "string" || !item.id.trim() || item.id.length > 256 || modelIds.includes(item.id)) throw new ModelSettingsError("PROVIDER_UNAVAILABLE");
        modelIds.push(item.id);
      }
      if (!result.has_more && modelIds.length) return { modelIds, processingRegion: this.processingRegion("anthropic") };
      if (!result.data.length || typeof result.last_id !== "string" || result.last_id !== modelIds.at(-1) || cursors.has(result.last_id)) throw new ModelSettingsError("PROVIDER_UNAVAILABLE");
      cursor = result.last_id; cursors.add(cursor);
    }
    throw new ModelSettingsError("PROVIDER_UNAVAILABLE");
  }
  async #google(apiKey: string) {
    const signal = AbortSignal.timeout(this.#timeoutMs); const modelIds: string[] = []; const names = new Set<string>(); const cursors = new Set<string>(); let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const url = new URL("https://generativelanguage.googleapis.com/v1beta/models"); url.searchParams.set("pageSize", "100");
      if (cursor) url.searchParams.set("pageToken", cursor);
      const result = await readBoundedJson(await this.#fetch(url.toString(), { method: "GET", redirect: "error", signal,
        headers: { "x-goog-api-key": apiKey } }), 512_000);
      if (!record(result) || !Array.isArray(result.models) || result.models.length > 100) throw new ModelSettingsError("PROVIDER_UNAVAILABLE");
      for (const item of result.models) {
        if (!record(item) || typeof item.name !== "string" || item.name.length > 256 || !/^models\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(item.name)
          || names.has(item.name) || !Array.isArray(item.supportedGenerationMethods) || !item.supportedGenerationMethods.every((method) => typeof method === "string")) throw new ModelSettingsError("PROVIDER_UNAVAILABLE");
        names.add(item.name);
        if (item.supportedGenerationMethods.includes("generateContent")) modelIds.push(item.name);
      }
      if (result.nextPageToken === undefined) {
        if (modelIds.length) return { modelIds, processingRegion: this.processingRegion("google") };
        throw new ModelSettingsError("PROVIDER_UNAVAILABLE");
      }
      if (!result.models.length || typeof result.nextPageToken !== "string" || !result.nextPageToken.trim() || result.nextPageToken.length > 4096 || cursors.has(result.nextPageToken)) throw new ModelSettingsError("PROVIDER_UNAVAILABLE");
      cursor = result.nextPageToken; cursors.add(cursor);
    }
    throw new ModelSettingsError("PROVIDER_UNAVAILABLE");
  }
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
