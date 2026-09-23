import type { PhoneVerificationProvider, WechatLoginProvider } from "./index.ts";

type Fetch = typeof globalThis.fetch;

export class IdentityProviderError extends Error {
  readonly code = "IDENTITY_PROVIDER_UNAVAILABLE";

  constructor() {
    super("登录服务暂不可用，请稍后重试");
    this.name = "IdentityProviderError";
  }
}

interface HttpProviderOptions {
  fetch?: Fetch;
  timeoutMs?: number;
}

export class HttpPhoneVerificationProvider implements PhoneVerificationProvider {
  readonly #endpoint: URL;
  readonly #apiKey: string;
  readonly #fetch: Fetch;
  readonly #timeoutMs: number;

  constructor(options: HttpProviderOptions & { endpoint: string; apiKey: string }) {
    this.#endpoint = secureUrl(options.endpoint, "SMS endpoint");
    this.#apiKey = requiredSecret(options.apiKey, "SMS API key");
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = positiveTimeout(options.timeoutMs);
  }

  async sendCode(phone: string) {
    const result = await this.post("send", { phone });
    return typeof result.requestId === "string" ? { providerRequestId: result.requestId } : {};
  }

  async verifyCode(phone: string, code: string): Promise<boolean> {
    const result = await this.post("verify", { phone, code });
    if (typeof result.valid !== "boolean") throw new IdentityProviderError();
    return result.valid;
  }

  private async post(path: string, body: object): Promise<Record<string, unknown>> {
    try {
      const base = this.#endpoint.toString().replace(/\/?$/, "/");
      const response = await this.#fetch(new URL(path, base), {
        method: "POST",
        headers: { authorization: `Bearer ${this.#apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      if (!response.ok) throw new IdentityProviderError();
      const result: unknown = await response.json();
      if (!isRecord(result)) throw new IdentityProviderError();
      return result;
    } catch (error) {
      if (error instanceof IdentityProviderError) throw error;
      throw new IdentityProviderError();
    }
  }
}

export class WechatWebsiteLoginProvider implements WechatLoginProvider {
  readonly #appId: string;
  readonly #appSecret: string;
  readonly #fetch: Fetch;
  readonly #timeoutMs: number;

  constructor(options: HttpProviderOptions & { appId: string; appSecret: string }) {
    this.#appId = requiredSecret(options.appId, "WeChat app ID");
    this.#appSecret = requiredSecret(options.appSecret, "WeChat app secret");
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = positiveTimeout(options.timeoutMs);
  }

  authorizationUrl(input: { state: string; redirectUri: string }): string {
    secureUrl(input.redirectUri, "WeChat redirect URI");
    const url = new URL("https://open.weixin.qq.com/connect/qrconnect");
    url.search = new URLSearchParams({
      appid: this.#appId,
      redirect_uri: input.redirectUri,
      response_type: "code",
      scope: "snsapi_login",
      state: input.state,
    }).toString();
    return `${url.toString()}#wechat_redirect`;
  }

  async exchangeCode(input: { code: string; redirectUri: string }) {
    secureUrl(input.redirectUri, "WeChat redirect URI");
    const url = new URL("https://api.weixin.qq.com/sns/oauth2/access_token");
    url.search = new URLSearchParams({
      appid: this.#appId,
      secret: this.#appSecret,
      code: input.code,
      grant_type: "authorization_code",
    }).toString();
    try {
      const response = await this.#fetch(url, { signal: AbortSignal.timeout(this.#timeoutMs) });
      if (!response.ok) throw new IdentityProviderError();
      const result: unknown = await response.json();
      if (!isRecord(result) || typeof result.openid !== "string") throw new IdentityProviderError();
      return {
        openId: result.openid,
        ...(typeof result.unionid === "string" ? { unionId: result.unionid } : {}),
      };
    } catch (error) {
      if (error instanceof IdentityProviderError) throw error;
      throw new IdentityProviderError();
    }
  }
}

function secureUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid HTTPS URL`);
  }
  if (url.protocol !== "https:") throw new Error(`${label} must use HTTPS`);
  return url;
}

function requiredSecret(value: string, label: string): string {
  if (!value.trim()) throw new Error(`${label} is required`);
  return value;
}

function positiveTimeout(value = 5_000): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error("Provider timeout must be positive");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
