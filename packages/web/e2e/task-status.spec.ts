import { expect, test, type Page } from "@playwright/test";
const origin = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001").replace(/\/$/, "");
async function login(page: Page) {
  await page.getByRole("button", { name: "获取验证码" }).click();
  await page.getByLabel("验证码").fill("123456");
  await page.getByRole("button", { name: "验证并进入" }).click();
}
async function setup(page: Page, reason: string | null = null, chapterContext = false) {
  let posts = 0;
  await page.route(`${origin}/**`, async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const headers = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization,content-type,x-device-token", "access-control-allow-methods": "GET,POST,OPTIONS" };
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    let body: unknown;
    if (path === "/auth/device") body = { deviceToken: "device" };
    else if (path === "/auth/phone/challenges") body = { challengeId: "challenge" };
    else if (path === "/auth/phone/verify") body = { sessionToken: "session", actor: { userId: "u", workspaceId: "w" } };
    else {
      expect(request.headers().authorization).toBe("Bearer session");
      if (path === "/projects/p/chapters/c/story-knowledge-tasks") {
        await route.fulfill({ headers, contentType: "application/json", body: JSON.stringify({ tasks: [{ id: "task", projectId: "p", chapterId: "c", input: { stage: "story_knowledge", sourceVersionId: "s" }, state: "succeeded", reason: null, result: { candidateVersionId: "candidate", extractionStatus: "partially_succeeded" } }], nextCursor: null }) });
        return;
      }
      if (path.endsWith("/resubmit")) { posts++; expect(request.postDataJSON()).toEqual({ configurationVersionId: "config", modelId: "model" }); }
      if (path.includes("/story-knowledge-tasks/")) body = { id: path.endsWith("/resubmit") ? "new-task" : path.split("/").at(-1), projectId: "p", chapterId: "c", input: { stage: "story_knowledge", sourceVersionId: "s" }, state: path.endsWith("/resubmit") || !reason ? "succeeded" : "paused", reason: path.endsWith("/resubmit") ? null : reason, result: reason && !path.endsWith("/resubmit") ? null : { candidateVersionId: "candidate", extractionStatus: "partially_succeeded" } };
      else if (path === "/workspace/model-settings") body = { configuration: { id: "config", tested: true, providerId: "deepseek", processingRegion: "mainland", availableModelIds: ["model"] } };
      else if (path.endsWith("/versions/candidate")) body = { id: "candidate", extractionJobId: posts ? "new-task" : "task", projectId: "p", chapterId: "c", sourceVersionId: "s", status: "candidate", extractionStatus: "partially_succeeded", facts: [{ id: "rain", statement: "雨落", evidence: [] }], failures: [{ scopeKey: "identity", message: "待确认" }] };
      else return route.fulfill({ status: 404, headers, contentType: "application/json", body: JSON.stringify({ code: "TASK_NOT_FOUND" }) });
    }
    await route.fulfill({ headers, contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.goto(chapterContext ? "/?taskProject=p&taskChapter=c" : "/?task=task"); await login(page);
  return () => posts;
}
test("部分成功跳转准确候选，刷新后重新登录恢复任务", async ({ page }) => {
  await setup(page);
  const panel = page.getByRole("region", { name: "故事知识任务" });
  await expect(panel.getByText("部分成功", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "查看候选版本" }).click();
  await expect(panel.getByText("雨落", { exact: true })).toBeVisible();
  await page.screenshot({ path: "/private/tmp/task-status-panel.png" });
  await page.reload(); await login(page);
  await expect(panel.getByText("部分成功", { exact: true })).toBeVisible();
});
test("恢复章节上下文后通过列表选择任务，刷新后列表仍可找回", async ({ page }) => {
  await setup(page, null, true);
  const list = page.getByRole("region", { name: "章节任务列表" });
  await list.getByRole("button", { name: "查看任务 task" }).click();
  await expect(page.getByRole("region", { name: "故事知识任务" }).getByRole("article").getByText("部分成功", { exact: true })).toBeVisible();
  await page.screenshot({ path: "/private/tmp/chapter-task-list.png" });
  await page.reload(); await login(page);
  await expect(list.getByRole("button", { name: "查看任务 task" })).toBeVisible();
});
test("恢复旧章节后进入新项目但未选章时清除旧列表与任务", async ({ page }) => {
  await setup(page, null, true);
  await expect(page.getByRole("region", { name: "章节任务列表" }).getByRole("button", { name: "查看任务 task" })).toBeVisible();
  await page.route(`${origin}/projects`, route => route.fulfill({ headers: { "access-control-allow-origin": "*" }, contentType: "application/json", body: JSON.stringify({ id: "new-project", title: "新作品" }) }));
  await page.getByLabel("项目名称").fill("新作品");
  await page.getByRole("checkbox", { name: /拥有该作品或合法改编权/ }).check();
  await page.getByRole("button", { name: /创建项目/ }).click();
  await expect(page.getByRole("region", { name: "章节任务列表" })).toHaveCount(0);
  await expect(page).not.toHaveURL(/taskProject=p/);
});
test("章节列表按游标加载下一页且不重复已有任务", async ({ page }) => {
  await setup(page, null, true);
  await page.route(`${origin}/projects/p/chapters/c/story-knowledge-tasks?*`, async route => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    const row = (id: string) => ({ id, projectId: "p", chapterId: "c", input: { stage: "story_knowledge", sourceVersionId: "s" }, state: "queued", reason: null, result: null });
    await route.fulfill({ headers: { "access-control-allow-origin": "*" }, contentType: "application/json", body: JSON.stringify({ tasks: cursor ? [row("task"), row("task-b")] : [row("task")], nextCursor: cursor ? null : "task" }) });
  });
  const list = page.getByRole("region", { name: "章节任务列表" });
  await list.getByRole("button", { name: "刷新列表" }).click();
  await list.getByRole("button", { name: "加载更多任务" }).click();
  await expect(list.getByRole("button", { name: "查看任务 task", exact: true })).toHaveCount(1);
  await expect(list.getByRole("button", { name: "查看任务 task-b", exact: true })).toBeVisible();
  await expect(list.getByRole("button", { name: "加载更多任务" })).toHaveCount(0);
});
test("未知执行禁止重提，普通暂停由用户明确选择模型重提", async ({ page }) => {
  const posts = await setup(page, "EXECUTION_UNCERTAIN");
  const panel = page.getByRole("region", { name: "故事知识任务" });
  await expect(panel.getByText("待人工处理", { exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "使用所选模型重新提交" })).toHaveCount(0);
  expect(posts()).toBe(0);
});
test("模型版本确认后重提，并将新任务编号写入URL", async ({ page }) => {
  const posts = await setup(page, "VERSION_CONFLICT");
  const panel = page.getByRole("region", { name: "故事知识任务" });
  await panel.getByRole("button", { name: "使用所选模型重新提交" }).click();
  await expect(page).toHaveURL(/task=new-task/);
  expect(posts()).toBe(1);
});
test("移动端只查看任务；过期会话和冲突使用安全反馈", async ({ page }) => {
  await setup(page, "VERSION_CONFLICT");
  const panel = page.getByRole("region", { name: "故事知识任务" });
  await expect(panel.getByRole("button", { name: "使用所选模型重新提交" })).toBeEnabled();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(panel.getByText("已暂停", { exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "使用所选模型重新提交" })).toBeHidden();
  await page.screenshot({ path: "/private/tmp/task-status-mobile.png" });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.route(`${origin}/story-knowledge-tasks/task/resubmit`, route => route.fulfill({ status: 409, headers: { "access-control-allow-origin": "*" }, contentType: "application/json", body: JSON.stringify({ code: "VERSION_CONFLICT", message: "private-model-message" }) }));
  await panel.getByRole("button", { name: "使用所选模型重新提交" }).click();
  await expect(panel.getByRole("status")).toContainText("不会自动重提");
  await expect(panel.getByRole("button", { name: "使用所选模型重新提交" })).toBeDisabled();
  await page.route(`${origin}/story-knowledge-tasks/task`, route => route.fulfill({ status: 401, headers: { "access-control-allow-origin": "*" }, contentType: "application/json", body: JSON.stringify({ message: "private-model-message" }) }));
  await panel.getByRole("button", { name: "刷新状态" }).click();
  await expect(panel.getByRole("status")).toContainText("登录已失效");
  await expect(panel).not.toContainText("private-model-message");
});
test("无效任务编号不能解除正在重提的忙碌状态", async ({ page }) => {
  await setup(page, "VERSION_CONFLICT");
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const requestStarted = new Promise<void>(resolve => { started = resolve; });
  await page.route(`${origin}/story-knowledge-tasks/task/resubmit`, async route => {
    started(); await gate;
    await route.fulfill({ status: 409, headers: { "access-control-allow-origin": "*" }, contentType: "application/json", body: JSON.stringify({ code: "STATE_CONFLICT" }) });
  });
  const panel = page.getByRole("region", { name: "故事知识任务" });
  await panel.getByRole("button", { name: "使用所选模型重新提交" }).click(); await requestStarted;
  try {
    await panel.getByLabel("任务编号").fill("");
    await panel.getByRole("button", { name: "读取任务" }).click();
    await expect(panel.getByRole("button", { name: "使用所选模型重新提交" })).toBeDisabled();
  } finally { release(); }
});
test("切换任务后忽略晚到的旧候选响应", async ({ page }) => {
  await setup(page);
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const requestStarted = new Promise<void>(resolve => { started = resolve; });
  await page.route(`${origin}/projects/p/chapters/c/story-knowledge/versions/candidate`, async route => {
    started(); await gate;
    await route.fulfill({ headers: { "access-control-allow-origin": "*" }, contentType: "application/json", body: JSON.stringify({ id: "candidate", projectId: "p", chapterId: "c", sourceVersionId: "s", extractionJobId: "task", facts: [{ id: "old", statement: "旧候选不应显示" }], failures: [] }) });
  });
  const panel = page.getByRole("region", { name: "故事知识任务" });
  await panel.getByRole("button", { name: "查看候选版本" }).click(); await requestStarted;
  await panel.getByLabel("任务编号").fill("next-task");
  await panel.getByRole("button", { name: "读取任务" }).click();
  await expect(panel.getByText(/任务 next-task/)).toBeVisible();
  const oldResponse = page.waitForResponse(response => response.url().endsWith("/versions/candidate"));
  release();
  await (await oldResponse).finished();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
  await expect(panel.getByRole("region", { name: "任务候选版本" })).toHaveCount(0);
  await expect(panel).not.toContainText("旧候选不应显示");
});
