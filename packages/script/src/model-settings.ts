import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Actor } from "./index.ts";

export const MODEL_PROVIDERS = Object.freeze([
  { id: "aliyun", name: "阿里云百炼", kind: "direct" }, { id: "volcano", name: "火山方舟", kind: "direct" },
  { id: "deepseek", name: "DeepSeek", kind: "direct" }, { id: "zhipu", name: "智谱", kind: "direct" },
  { id: "moonshot", name: "Kimi / 月之暗面", kind: "direct" }, { id: "minimax", name: "MiniMax", kind: "direct" },
  { id: "openai", name: "OpenAI", kind: "direct" }, { id: "anthropic", name: "Anthropic", kind: "direct" },
  { id: "google", name: "Google Gemini", kind: "direct" }, { id: "xai", name: "xAI", kind: "direct" },
  { id: "mistral", name: "Mistral AI", kind: "direct" }, { id: "openrouter", name: "OpenRouter", kind: "aggregator" },
].map((provider) => Object.freeze(provider)));

export type ModelConfiguration = Readonly<{
  id: string; parentVersionId: string | null; workspaceId: string; providerId: string;
  ciphertext: string; nonce: string; tag: string; createdBy: string;
  tested: boolean; availableModelIds: string[]; processingRegion: "mainland" | "overseas" | "unknown";
}>;
export type PublicModelConfiguration = Omit<ModelConfiguration, "ciphertext" | "nonce" | "tag"> & { keyMask: string };
export type TaskModelSnapshot = Readonly<{ workspaceId: string; configurationVersionId: string; providerId: string; modelId: string; processingRegion: ModelConfiguration["processingRegion"] }>;
export interface ModelSettingsRepository {
  find(workspaceId: string): Promise<ModelConfiguration | null>;
  save(config: ModelConfiguration, expectedVersionId: string | null): Promise<ModelConfiguration>;
}
export interface ModelConnectionProbe {
  processingRegion(providerId: string): ModelConfiguration["processingRegion"];
  test(input: { providerId: string; apiKey: string }): Promise<{ modelIds: string[]; processingRegion: ModelConfiguration["processingRegion"] }>;
}
export class ModelSettingsError extends Error {
  readonly code: "FORBIDDEN" | "INVALID_CONFIGURATION" | "VERSION_CONFLICT" | "NOT_READY" | "PROVIDER_UNAVAILABLE" | "STORAGE_UNAVAILABLE";
  constructor(code: ModelSettingsError["code"]) { super(code); this.name = "ModelSettingsError"; this.code = code; }
}
export class InMemoryModelSettingsRepository implements ModelSettingsRepository {
  readonly #active = new Map<string, ModelConfiguration>();
  readonly #history = new Map<string, ModelConfiguration>();
  async find(workspaceId: string) { const value = this.#active.get(workspaceId); return value ? structuredClone(value) : null; }
  async save(config: ModelConfiguration, expectedVersionId: string | null) {
    if ((this.#active.get(config.workspaceId)?.id ?? null) !== expectedVersionId
      || this.#history.has(JSON.stringify([config.workspaceId, config.id]))) throw new ModelSettingsError("VERSION_CONFLICT");
    this.#history.set(JSON.stringify([config.workspaceId, config.id]), structuredClone(config));
    this.#active.set(config.workspaceId, structuredClone(config)); return structuredClone(config);
  }
}
export class WorkspaceModelSettings {
  readonly #options: ModelSettingsOptions;
  constructor(options: ModelSettingsOptions) {
    if (options.encryptionKey.length !== 32) throw new ModelSettingsError("INVALID_CONFIGURATION");
    this.#options = { ...options, encryptionKey: new Uint8Array(options.encryptionKey) };
  }
  async testConnection(actor: Actor, expectedVersionId: string, allowNonMainland: boolean = false): Promise<PublicModelConfiguration> {
    await this.#authorize(actor, true);
    const current = await this.#options.repository.find(actor.workspaceId);
    if (!current || current.id !== expectedVersionId) throw new ModelSettingsError("VERSION_CONFLICT");
    if (!this.#options.probe) throw new ModelSettingsError("PROVIDER_UNAVAILABLE");
    try {
      const route = this.#options.probe.processingRegion(current.providerId);
      if (!["mainland", "overseas"].includes(route)) throw new ModelSettingsError("NOT_READY");
      if (route !== "mainland" && allowNonMainland !== true) throw new ModelSettingsError("FORBIDDEN");
      const apiKey = unseal(this.#options.encryptionKey, actor.workspaceId, current);
      const result = await this.#options.probe.test({ providerId: current.providerId, apiKey });
      if (result.processingRegion !== route) throw new ModelSettingsError("PROVIDER_UNAVAILABLE");
      if (!Array.isArray(result.modelIds) || !result.modelIds.length || result.modelIds.some((id) => typeof id !== "string" || !id.trim())
        || new Set(result.modelIds).size !== result.modelIds.length || !["mainland", "overseas", "unknown"].includes(result.processingRegion)) throw new ModelSettingsError("PROVIDER_UNAVAILABLE");
      if (result.processingRegion !== "mainland" && allowNonMainland !== true) throw new ModelSettingsError("FORBIDDEN");
      const id = this.#options.idGenerator();
      return publicConfig(await this.#options.repository.save({ ...current, ...seal(this.#options.encryptionKey, actor.workspaceId, id, current.providerId, apiKey),
        id, parentVersionId: current.id, createdBy: actor.userId, tested: true,
        availableModelIds: [...result.modelIds], processingRegion: result.processingRegion,
      }, current.id));
    } catch (error) {
      if (error instanceof ModelSettingsError) throw error;
      throw new ModelSettingsError("PROVIDER_UNAVAILABLE");
    }
  }
  async selectForTask(actor: Actor, expectedVersionId: string, modelId: string) {
    await this.#authorize(actor, false);
    const current = await this.#options.repository.find(actor.workspaceId);
    if (!current || current.id !== expectedVersionId) throw new ModelSettingsError("VERSION_CONFLICT");
    if (!current.tested || !current.availableModelIds.includes(modelId)) throw new ModelSettingsError("NOT_READY");
    return Object.freeze({ workspaceId: actor.workspaceId, configurationVersionId: current.id, providerId: current.providerId, modelId, processingRegion: current.processingRegion });
  }
  /** Trusted server/worker seam only; never register a member-facing credential endpoint. */
  async executeForTask<T>(actor: Actor, snapshot: TaskModelSnapshot,
    invoke: (input: { apiKey: string; providerId: string; modelId: string; processingRegion: "mainland" }) => Promise<T>): Promise<T> {
    if (snapshot.workspaceId !== actor.workspaceId) throw new ModelSettingsError("FORBIDDEN");
    await this.#authorize(actor, false);
    const current = await this.#options.repository.find(actor.workspaceId);
    if (!current || current.id !== snapshot.configurationVersionId) throw new ModelSettingsError("VERSION_CONFLICT");
    if (!current.tested || current.providerId !== snapshot.providerId || !current.availableModelIds.includes(snapshot.modelId)
      || current.processingRegion !== snapshot.processingRegion) throw new ModelSettingsError("NOT_READY");
    // Connection-test consent does not authorize transferring manuscript content.
    // Overseas tasks stay closed until durable, task-scoped owner consent is implemented.
    if (current.processingRegion !== "mainland" || this.#options.probe?.processingRegion(current.providerId) !== "mainland") throw new ModelSettingsError("NOT_READY");
    try {
      const apiKey = unseal(this.#options.encryptionKey, actor.workspaceId, current);
      return await invoke({ apiKey, providerId: current.providerId, modelId: snapshot.modelId, processingRegion: "mainland" });
    } catch { throw new ModelSettingsError("PROVIDER_UNAVAILABLE"); }
  }
  async #authorize(actor: Actor, owner: boolean) {
    const access = await this.#options.access.read(actor);
    if (!access || !access.advanced || (owner && !access.owner)) throw new ModelSettingsError("FORBIDDEN");
  }
  async get(actor: Actor): Promise<PublicModelConfiguration | null> {
    await this.#authorize(actor, false); const current = await this.#options.repository.find(actor.workspaceId);
    return current ? publicConfig(current) : null;
  }
  async capabilities(actor: Actor) {
    const access = await this.#options.access.read(actor);
    if (!access) throw new ModelSettingsError("FORBIDDEN");
    return { advanced: access.advanced, canManage: access.owner && access.advanced,
      providers: MODEL_PROVIDERS.map(provider => {
        const processingRegion = this.#options.probe?.processingRegion(provider.id) ?? "unknown";
        return { ...provider, processingRegion, available: processingRegion !== "unknown" };
      }) };
  }
  async configure(actor: Actor, input: { expectedVersionId: string | null; providerId: string; apiKey: string }): Promise<PublicModelConfiguration> {
    await this.#authorize(actor, true);
    if (!MODEL_PROVIDERS.some(({ id }) => id === input.providerId) || typeof input.apiKey !== "string"
      || !input.apiKey.trim() || input.apiKey.length > 8192 || /[\r\n]/.test(input.apiKey)) throw new ModelSettingsError("INVALID_CONFIGURATION");
    const id = this.#options.idGenerator();
    return publicConfig(await this.#options.repository.save({ id, parentVersionId: input.expectedVersionId,
      workspaceId: actor.workspaceId, providerId: input.providerId, createdBy: actor.userId,
      ...seal(this.#options.encryptionKey, actor.workspaceId, id, input.providerId, input.apiKey),
      tested: false, availableModelIds: [], processingRegion: "unknown",
    }, input.expectedVersionId));
  }
}
interface ModelSettingsOptions {
  repository: ModelSettingsRepository; encryptionKey: Uint8Array;
  access: { read(actor: Actor): Promise<{ owner: boolean; advanced: boolean } | null> };
  idGenerator: () => string; probe?: ModelConnectionProbe;
}
function seal(key: Uint8Array, workspaceId: string, id: string, providerId: string, apiKey: string) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(JSON.stringify([workspaceId, id, providerId])));
  const ciphertext = Buffer.concat([cipher.update(apiKey, "utf8"), cipher.final()]);
  return { ciphertext: ciphertext.toString("base64"), nonce: nonce.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
}
function publicConfig(config: ModelConfiguration): PublicModelConfiguration {
  const { ciphertext: _ciphertext, nonce: _nonce, tag: _tag, ...visible } = config;
  return { ...visible, keyMask: "••••••••" };
}
function unseal(key: Uint8Array, workspaceId: string, config: ModelConfiguration): string {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(config.nonce, "base64"));
  decipher.setAAD(Buffer.from(JSON.stringify([workspaceId, config.id, config.providerId])));
  decipher.setAuthTag(Buffer.from(config.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(config.ciphertext, "base64")), decipher.final()]).toString("utf8");
}
