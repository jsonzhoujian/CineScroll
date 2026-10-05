import { expect, test, type Page } from "@playwright/test";
const apiOrigin = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001").replace(/\/$/, "");

async function setup(page: Page, canManage = true) {
  let configuration: unknown = null;
  await page.route(`${apiOrigin}/**`, async route => {
    const req = route.request(), path = new URL(req.url()).pathname;
    const headers = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization,content-type,x-device-token", "access-control-allow-methods": "GET,POST,OPTIONS" };
    let body: unknown = {};
    if (req.method() === "OPTIONS") { await route.fulfill({ status: 204, headers }); return; }
    if (path === "/auth/device") body = { deviceToken: "device" };
    else if (path === "/auth/phone/challenges") body = { challengeId: "challenge" };
    else if (path === "/auth/phone/verify") body = { sessionToken: "session", actor: { userId: "u", workspaceId: "w" } };
    else {
      expect(req.headers().authorization).toBe("Bearer session");
      if (path.endsWith("/capabilities")) body = { advanced: true, canManage, providers: [
        { id: "openai", name: "OpenAI", kind: "direct", available: true, processingRegion: "overseas" },
        { id: "aliyun", name: "阿里云百炼", kind: "direct", available: false, processingRegion: "unknown" },
      ] };
      else if (path.endsWith("/test")) {
        expect(req.postDataJSON()).toEqual({ expectedVersionId: "v1", allowNonMainland: true });
        configuration = { id: "v2", providerId: "openai", keyMask: "••••••••", tested: true, availableModelIds: ["fixture-model"], processingRegion: "overseas" }; body = configuration;
      } else if (req.method() === "POST") {
        expect(req.postDataJSON()).toEqual({ expectedVersionId: null, providerId: "openai", apiKey: "fixture-key" });
        configuration = { id: "v1", providerId: "openai", keyMask: "••••••••", tested: false, availableModelIds: [], processingRegion: "unknown" }; body = configuration;
      } else body = { configuration };
    }
    await route.fulfill({ headers, contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "获取验证码" }).click();
  await page.getByLabel("验证码").fill("123456");
  await page.getByRole("button", { name: "验证并进入" }).click();
  await page.getByRole("button", { name: "工作室模型设置" }).click();
}

test("负责人保存共享Key后清空输入，境外授权后测试并展示目录", async ({ page }) => {
  await setup(page);
  const dialog = page.getByRole("dialog", { name: "模型设置" });
  await expect(dialog.getByRole("option", { name: "阿里云百炼 · 暂不可用" })).toHaveAttribute("disabled", "");
  await dialog.getByLabel("新的 API Key").fill("fixture-key");
  await dialog.getByRole("button", { name: "加密保存 Key" }).click();
  await expect(dialog.getByLabel("新的 API Key")).toHaveValue("");
  await expect(dialog.getByText(/已加密保存/)).toBeVisible();
  await expect(dialog.getByRole("button", { name: "测试连接并读取模型" })).toBeDisabled();
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "测试连接并读取模型" }).click();
  await expect(dialog.getByText("fixture-model", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain("fixture-key");
  await page.screenshot({ path: "/private/tmp/model-settings-panel.png" });
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole("button", { name: "工作室模型设置" })).toBeFocused();
});

test("保存失败清空Key并提示限流与版本冲突", async ({ page }) => {
  await setup(page);
  let conflict = false;
  await page.route(`${apiOrigin}/workspace/model-settings`, async route => {
    if (route.request().method() !== "POST") { await route.fallback(); return; }
    await route.fulfill({ status: conflict ? 409 : 429, headers: { "access-control-allow-origin": "*" }, contentType: "application/json",
      body: JSON.stringify(conflict ? { code: "VERSION_CONFLICT" } : { code: "RATE_LIMITED", retryAfterSeconds: 42 }) });
  });
  const dialog = page.getByRole("dialog", { name: "模型设置" });
  await dialog.getByLabel("新的 API Key").fill("fixture-key");
  await dialog.getByRole("button", { name: "加密保存 Key" }).click();
  await expect(dialog.getByRole("status")).toContainText("42 秒后重试");
  await expect(dialog.getByLabel("新的 API Key")).toHaveValue("");
  conflict = true;
  await dialog.getByLabel("新的 API Key").fill("fixture-key");
  await dialog.getByRole("button", { name: "加密保存 Key" }).click();
  await expect(dialog.getByRole("status")).toContainText("关闭并重新打开设置");
  await expect(dialog.getByLabel("新的 API Key")).toHaveValue("");
});

test("成员无法看到Key输入或管理操作", async ({ page }) => {
  await setup(page, false);
  const dialog = page.getByRole("dialog", { name: "模型设置" });
  await expect(dialog.getByText(/无权更新或测试/)).toBeVisible();
  await expect(dialog.getByLabel("新的 API Key")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "加密保存 Key" })).toHaveCount(0);
});
