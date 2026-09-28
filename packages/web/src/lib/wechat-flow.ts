export const WECHAT_LOGIN_MESSAGE = "novel-adaptation:wechat-login";

export type WechatLoginMessage = {
  type: typeof WECHAT_LOGIN_MESSAGE;
  state: string;
  sessionToken: string;
};

export function isWechatLoginMessage(value: unknown): value is WechatLoginMessage {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.type === WECHAT_LOGIN_MESSAGE
    && typeof candidate.state === "string"
    && candidate.state.length > 0
    && typeof candidate.sessionToken === "string"
    && candidate.sessionToken.length > 0;
}

export function expectedWechatLoginMessage(
  event: { origin: string; source: unknown; data: unknown },
  expectation: { origin: string; source: unknown; state: string | null },
): WechatLoginMessage | null {
  if (event.origin !== expectation.origin || event.source !== expectation.source) return null;
  if (!isWechatLoginMessage(event.data) || event.data.state !== expectation.state) return null;
  return event.data;
}

export function isTrustedWechatAuthorizationUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === "https://open.weixin.qq.com" && url.pathname === "/connect/qrconnect";
  } catch {
    return false;
  }
}
