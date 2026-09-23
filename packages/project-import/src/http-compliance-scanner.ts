import type { ComplianceScanner } from "./index.ts";

type Fetch = typeof globalThis.fetch;

export interface HttpComplianceScannerOptions {
  endpoint: string;
  apiKey: string;
  timeoutMs?: number;
  fetch?: Fetch;
}

export class ComplianceProviderError extends Error {
  readonly code = "PROVIDER_UNAVAILABLE";

  constructor() {
    super("内容合规服务暂不可用");
    this.name = "ComplianceProviderError";
  }
}

export class HttpComplianceScanner implements ComplianceScanner {
  readonly #endpoint: string;
  readonly #apiKey: string;
  readonly #timeoutMs: number;
  readonly #fetch: Fetch;

  constructor(options: HttpComplianceScannerOptions) {
    let endpoint: URL;
    try {
      endpoint = new URL(options.endpoint);
    } catch {
      throw new Error("Compliance endpoint must be a valid HTTPS URL");
    }
    if (endpoint.protocol !== "https:") {
      throw new Error("Compliance endpoint must use HTTPS");
    }
    if (!options.apiKey.trim()) throw new Error("Compliance API key is required");
    if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
      throw new Error("Compliance timeout must be a positive number");
    }
    this.#endpoint = options.endpoint;
    this.#apiKey = options.apiKey;
    this.#timeoutMs = options.timeoutMs ?? 5_000;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async scan(text: string) {
    try {
      const response = await this.#fetch(this.#endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${this.#apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      if (!response.ok) throw new ComplianceProviderError();
      const result = await response.json() as { allowed: unknown; reason?: unknown; requestId?: unknown };
      if (typeof result.allowed !== "boolean") throw new ComplianceProviderError();
      return {
        allowed: result.allowed,
        ...(typeof result.reason === "string" && result.reason ? { reason: result.reason } : {}),
        ...(typeof result.requestId === "string" && result.requestId
          ? { providerRequestId: result.requestId }
          : {}),
      };
    } catch (error) {
      if (error instanceof ComplianceProviderError) throw error;
      throw new ComplianceProviderError();
    }
  }
}
