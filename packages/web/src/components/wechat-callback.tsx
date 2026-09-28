"use client";

import { useEffect, useState } from "react";

import { ApiClient } from "../lib/api";
import { WECHAT_LOGIN_MESSAGE } from "../lib/wechat-flow";

export function WechatCallback({ code, state }: { code?: string; state?: string }) {
  const [status, setStatus] = useState("正在确认微信登录……");

  useEffect(() => {
    if (!code || !state) {
      setStatus("微信回调缺少必要参数，请关闭窗口后重试。");
      return;
    }
    if (!window.opener) {
      setStatus("原登录窗口已关闭，请返回工作台重新发起微信登录。");
      return;
    }
    const api = new ApiClient();
    void api.completeWechatLogin(code, state).then((login) => {
      window.opener.postMessage({
        type: WECHAT_LOGIN_MESSAGE,
        state,
        sessionToken: login.sessionToken,
      }, window.location.origin);
      setStatus("登录成功，正在返回工作台……");
      window.setTimeout(() => window.close(), 250);
    }).catch((error: unknown) => {
      setStatus(error instanceof Error ? error.message : "微信登录失败，请关闭窗口后重试");
    });
  }, [code, state]);

  return <main className="callback-page"><span className="seal">映</span><h1>映卷</h1><p role="status">{status}</p><a href="/">返回工作台</a></main>;
}
