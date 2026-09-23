export type Actor = Readonly<{ userId: string; workspaceId: string }>;

export interface PhoneVerificationProvider {
  sendCode(phone: string): Promise<{ providerRequestId?: string }>;
  verifyCode(phone: string, code: string): Promise<boolean>;
}

export interface WechatLoginProvider {
  authorizationUrl(input: { state: string; redirectUri: string }): string;
  exchangeCode(input: { code: string; redirectUri: string }): Promise<{ openId: string; unionId?: string }>;
}

export interface SessionIssuer {
  issue(userId: string, workspaceId: string): Promise<string>;
}

export interface IdentityAccount {
  userId: string;
  workspaceId: string;
  phone?: string;
  wechatOpenId?: string;
  wechatUnionId?: string;
}

export interface IdentityRepository {
  findOrCreateByPhone(phone: string, create: () => IdentityAccount): Promise<IdentityAccount>;
  findOrCreateByWechat(identity: { openId: string; unionId?: string }, create: () => IdentityAccount): Promise<IdentityAccount>;
}

interface PhoneChallenge {
  kind: "phone";
  id: string;
  phone: string;
  expiresAt: string;
  consumed: boolean;
  failedAttempts: number;
}

interface WechatChallenge {
  kind: "wechat";
  id: string;
  redirectUri: string;
  expiresAt: string;
  consumed: boolean;
}

type LoginChallenge = PhoneChallenge | WechatChallenge;

export interface LoginChallengeStore {
  save(challenge: LoginChallenge): Promise<void>;
  find(id: string): Promise<LoginChallenge | null>;
  consume(id: string): Promise<LoginChallenge | null>;
  recordFailedAttempt(id: string, maximumAttempts: number): Promise<void>;
}

export interface LoginRateLimiter {
  consume(input: {
    phone: string;
    ipAddress: string;
    deviceId: string;
    action: "send" | "verify";
    now: Date;
  }): Promise<{ allowed: boolean; retryAfterSeconds?: number }>;
}

interface LoginRateLimitOptions {
  phoneLimit: number;
  ipLimit: number;
  deviceLimit: number;
  windowMs: number;
}

export class InMemoryLoginRateLimiter implements LoginRateLimiter {
  readonly #limits: LoginRateLimitOptions;
  readonly #buckets = new Map<string, { count: number; resetAt: number }>();

  constructor(options: Partial<LoginRateLimitOptions> = {}) {
    this.#limits = {
      phoneLimit: options.phoneLimit ?? 3,
      ipLimit: options.ipLimit ?? 10,
      deviceLimit: options.deviceLimit ?? 5,
      windowMs: options.windowMs ?? 10 * 60_000,
    };
  }

  async consume(input: { phone: string; ipAddress: string; deviceId: string; action: "send" | "verify"; now: Date }) {
    const keys: Array<[string, number]> = [
      [`${input.action}:phone:${input.phone}`, this.#limits.phoneLimit],
      [`${input.action}:ip:${input.ipAddress}`, this.#limits.ipLimit],
      [`${input.action}:device:${input.deviceId}`, this.#limits.deviceLimit],
    ];
    const now = input.now.getTime();
    for (const [key, limit] of keys) {
      const bucket = this.#buckets.get(key);
      if (bucket && bucket.resetAt > now && bucket.count >= limit) {
        return { allowed: false, retryAfterSeconds: Math.ceil((bucket.resetAt - now) / 1_000) };
      }
    }
    for (const [key] of keys) {
      const bucket = this.#buckets.get(key);
      if (!bucket || bucket.resetAt <= now) {
        this.#buckets.set(key, { count: 1, resetAt: now + this.#limits.windowMs });
      } else {
        bucket.count += 1;
      }
    }
    return { allowed: true };
  }
}

export class InMemoryIdentityRepository implements IdentityRepository {
  readonly #accounts: IdentityAccount[] = [];

  async findOrCreateByPhone(phone: string, create: () => IdentityAccount): Promise<IdentityAccount> {
    let account = this.#accounts.find((candidate) => candidate.phone === phone);
    if (!account) { account = create(); this.#accounts.push(structuredClone(account)); }
    return structuredClone(account);
  }

  async findOrCreateByWechat(identity: { openId: string; unionId?: string }, create: () => IdentityAccount) {
    let account = this.#accounts.find((candidate) => identity.unionId
      ? candidate.wechatUnionId === identity.unionId
      : candidate.wechatOpenId === identity.openId);
    if (!account) { account = create(); this.#accounts.push(structuredClone(account)); }
    return structuredClone(account);
  }
}

export class InMemoryLoginChallengeStore implements LoginChallengeStore {
  readonly #challenges = new Map<string, LoginChallenge>();

  async save(challenge: LoginChallenge): Promise<void> {
    this.#challenges.set(challenge.id, structuredClone(challenge));
  }

  async find(id: string): Promise<LoginChallenge | null> {
    const challenge = this.#challenges.get(id);
    return challenge ? structuredClone(challenge) : null;
  }

  async consume(id: string): Promise<LoginChallenge | null> {
    const challenge = this.#challenges.get(id);
    if (!challenge || challenge.consumed) return null;
    challenge.consumed = true;
    return structuredClone(challenge);
  }

  async recordFailedAttempt(id: string, maximumAttempts: number): Promise<void> {
    const challenge = this.#challenges.get(id);
    if (!challenge || challenge.kind !== "phone" || challenge.consumed) return;
    challenge.failedAttempts += 1;
    if (challenge.failedAttempts >= maximumAttempts) challenge.consumed = true;
  }
}

interface IdentityServiceDependencies {
  repository: IdentityRepository;
  challengeStore: LoginChallengeStore;
  rateLimiter: LoginRateLimiter;
  phoneProvider: PhoneVerificationProvider;
  wechatProvider: WechatLoginProvider;
  sessionIssuer: SessionIssuer;
  idGenerator: (prefix: string) => string;
  clock: () => Date;
}

export class IdentityError extends Error {
  readonly code: "INVALID_PHONE" | "INVALID_OR_EXPIRED_CODE" | "INVALID_OAUTH_STATE" | "RATE_LIMITED";
  readonly retryAfterSeconds: number | undefined;

  constructor(
    code: "INVALID_PHONE" | "INVALID_OR_EXPIRED_CODE" | "INVALID_OAUTH_STATE" | "RATE_LIMITED",
    message: string,
    options?: { retryAfterSeconds?: number },
  ) {
    super(message);
    this.name = "IdentityError";
    this.code = code;
    this.retryAfterSeconds = options?.retryAfterSeconds;
  }
}

export class IdentityService {
  private readonly dependencies: IdentityServiceDependencies;

  constructor(dependencies: IdentityServiceDependencies) {
    this.dependencies = dependencies;
  }

  async requestPhoneCode(input: { phone: string; ipAddress: string; deviceId: string }) {
    const phone = normalizeMainlandPhone(input.phone);
    const rateLimit = await this.dependencies.rateLimiter.consume({
      phone,
      ipAddress: input.ipAddress,
      deviceId: input.deviceId,
      action: "send",
      now: this.dependencies.clock(),
    });
    if (!rateLimit.allowed) {
      throw new IdentityError("RATE_LIMITED", "验证码请求过于频繁，请稍后重试", {
        ...(rateLimit.retryAfterSeconds === undefined
          ? {}
          : { retryAfterSeconds: rateLimit.retryAfterSeconds }),
      });
    }
    const delivery = await this.dependencies.phoneProvider.sendCode(phone);
    const challenge: PhoneChallenge = {
      kind: "phone",
      id: this.dependencies.idGenerator("chlg"),
      phone,
      expiresAt: new Date(this.dependencies.clock().getTime() + 5 * 60_000).toISOString(),
      consumed: false,
      failedAttempts: 0,
    };
    await this.dependencies.challengeStore.save(challenge);
    return {
      challengeId: challenge.id,
      expiresAt: challenge.expiresAt,
      providerRequestId: delivery.providerRequestId,
    };
  }

  async verifyPhoneCode(input: { challengeId: string; phone: string; code: string; ipAddress: string; deviceId: string }) {
    const phone = normalizeMainlandPhone(input.phone);
    const rateLimit = await this.dependencies.rateLimiter.consume({
      phone, ipAddress: input.ipAddress, deviceId: input.deviceId, action: "verify", now: this.dependencies.clock(),
    });
    if (!rateLimit.allowed) throw new IdentityError("RATE_LIMITED", "验证码尝试过于频繁，请稍后重试");
    const challenge = await this.dependencies.challengeStore.find(input.challengeId);
    const expired = !challenge || challenge.kind !== "phone" || challenge.consumed
      || challenge.phone !== phone
      || Date.parse(challenge.expiresAt) <= this.dependencies.clock().getTime();
    if (expired) throw new IdentityError("INVALID_OR_EXPIRED_CODE", "验证码无效或已过期");
    if (!(await this.dependencies.phoneProvider.verifyCode(phone, input.code))) {
      await this.dependencies.challengeStore.recordFailedAttempt(input.challengeId, 5);
      throw new IdentityError("INVALID_OR_EXPIRED_CODE", "验证码无效或已过期");
    }
    const consumed = await this.dependencies.challengeStore.consume(challenge.id);
    if (!consumed) throw new IdentityError("INVALID_OR_EXPIRED_CODE", "验证码无效或已过期");
    const account = await this.dependencies.repository.findOrCreateByPhone(phone, () => ({
        userId: this.dependencies.idGenerator("usr"),
        workspaceId: this.dependencies.idGenerator("wsp"),
        phone,
      }));
    return this.issueLogin(account);
  }

  async beginWechatLogin(input: { redirectUri: string }) {
    const state = this.dependencies.idGenerator("oauth");
    await this.dependencies.challengeStore.save({
      kind: "wechat",
      id: state,
      redirectUri: input.redirectUri,
      expiresAt: new Date(this.dependencies.clock().getTime() + 10 * 60_000).toISOString(),
      consumed: false,
    });
    return {
      state,
      authorizationUrl: this.dependencies.wechatProvider.authorizationUrl({
        state,
        redirectUri: input.redirectUri,
      }),
    };
  }

  async completeWechatLogin(input: { code: string; state: string; redirectUri: string }) {
    const challenge = await this.dependencies.challengeStore.find(input.state);
    const invalid = !challenge || challenge.kind !== "wechat" || challenge.consumed
      || challenge.redirectUri !== input.redirectUri
      || Date.parse(challenge.expiresAt) <= this.dependencies.clock().getTime();
    if (invalid) throw new IdentityError("INVALID_OAUTH_STATE", "微信登录状态无效或已过期");
    const consumed = await this.dependencies.challengeStore.consume(challenge.id);
    if (!consumed) throw new IdentityError("INVALID_OAUTH_STATE", "微信登录状态无效或已过期");
    const identity = await this.dependencies.wechatProvider.exchangeCode({
      code: input.code,
      redirectUri: input.redirectUri,
    });
    const account = await this.dependencies.repository.findOrCreateByWechat(identity, () => ({
        userId: this.dependencies.idGenerator("usr"),
        workspaceId: this.dependencies.idGenerator("wsp"),
        wechatOpenId: identity.openId,
        ...(identity.unionId ? { wechatUnionId: identity.unionId } : {}),
      }));
    return this.issueLogin(account);
  }

  private async issueLogin(account: IdentityAccount) {
    return {
      actor: { userId: account.userId, workspaceId: account.workspaceId },
      sessionToken: await this.dependencies.sessionIssuer.issue(account.userId, account.workspaceId),
    };
  }
}

function normalizeMainlandPhone(value: string): string {
  const digits = value.replace(/[\s-]/g, "").replace(/^\+?86/, "");
  if (!/^1[3-9]\d{9}$/.test(digits)) throw new IdentityError("INVALID_PHONE", "请输入有效的中国大陆手机号");
  return `+86${digits}`;
}
