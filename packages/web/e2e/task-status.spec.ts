import { expect, test, type Page } from "@playwright/test";
const origin = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001").replace(/\/$/, "");
for (const mode of ["success","uncertain","stale","expired","mobile","disabled"]) test(`拆集任务生成并明确载入：${mode}`, async ({ page }) => {
  await setup(page);
  const headers = { "access-control-allow-origin": "*","access-control-allow-headers": "authorization,content-type","access-control-allow-methods": "GET,POST,OPTIONS" };
  const chapter = { id: "c",title: "雨落",activeSourceVersionId: "s",versions: [{ id: "s",ordinal: 1,text: "雨落",fragments: [{ id: "f",ordinal: 1,text: "雨落" }] }] };
  await page.route(`${origin}/projects/p/chapters/c/context`,r => r.fulfill({ headers,json: { project: { id: "p",title: "作品",role: "owner" },chapter } }));
  await page.route(`${origin}/projects/p/chapters/c`,r => r.fulfill({ headers,json: chapter }));
  await page.route(`${origin}/projects/p/chapters/c/story-knowledge`,r => r.fulfill({ headers,json: { id: "candidate",extractionJobId: "task",projectId: "p",chapterId: "c",sourceVersionId: "s",status: "confirmed",extractionStatus: "succeeded",facts: [],failures: [] } }));
  const task = { id: "episode-task",projectId: "p",chapterId: "c",input: { stage: "script",resultType: "episodePlan",sourceVersionId: "s",upstreamConfirmedVersionIds: ["candidate"] },state: "queued",reason: null,result: null as unknown };
  let posts = 0, requestId = "";
  await page.route(`${origin}/projects/p/chapters/c/episode-plan-tasks**`,r => {
    if (r.request().method() === "OPTIONS") return r.fulfill({ headers,status: 204 });
    if (r.request().method() === "POST") {
      posts++; const b = r.request().postDataJSON(); expect(Object.keys(b).sort()).toEqual(["configurationVersionId","modelId","requestId"]);
      expect(b.modelId).toBe("model"); if (requestId) expect(b.requestId).toBe(requestId); else requestId = b.requestId;
      if (["uncertain","expired"].includes(mode) && posts === 1) return r.fulfill({ headers,status: 503,json: { code: "STORAGE_UNAVAILABLE" } });
      if (mode === "expired" && posts === 2) return r.fulfill({ headers,status: 401,json: { code: "UNAUTHORIZED" } });
      return r.fulfill({ headers,json: task });
    }
    return r.fulfill({ headers,json: r.request().url().includes("availability") ? { available: mode !== "disabled",reason: mode === "disabled" ? "WORKSPACE_TASK_DISABLED" : null } : { tasks: [],nextCursor: null } });
  });
  await page.route(`${origin}/episode-plan-tasks/episode-task`,r => r.fulfill({ headers,json: { ...task,state: "succeeded",result: { candidateVersionId: "plan",extractionStatus: "succeeded" } } }));
  const plan = { id: mode === "stale" ? "newer-plan" : "plan",generationJobId: task.id,projectId: "p",chapterId: "c",sourceVersionId: "s",storyBibleVersionId: "candidate",status: "candidate",targetDurationSeconds: 180,episodes: [{ id: "e",ordinal: 1,title: "风雨将至",sourceFragmentIds: ["f"],coreEventFactIds: ["event"] }],majorAdaptationProposals: [] };
  await page.route(`${origin}/projects/p/chapters/c/episode-plan`,r => r.fulfill({ headers,json: { plan,current: true,canReview: true,sourceFragments: [{ id: "f",text: "雨落" }],coreEvents: [{ id: "event",statement: "下雨" }] } }));
  await page.getByRole("button",{ name: "进入审核",exact: true }).click();
  const panel = page.getByRole("region",{ name: "拆集生成任务" }),desk = page.getByRole("region",{ name: "拆集方案审核" });
  await panel.getByRole("button",{ name: "读取拆集模型" }).click(); await panel.getByLabel("拆集模型").selectOption("model");
  if (mode === "disabled") { await expect(panel.getByRole("button",{ name: "生成拆集候选",exact: true })).toBeDisabled(); expect(posts).toBe(0); return; }
  await expect(panel.getByRole("button",{ name: "生成拆集候选",exact: true })).toBeEnabled(); await panel.getByRole("button",{ name: "生成拆集候选",exact: true }).click();
  if (["uncertain","expired"].includes(mode)) { await expect(panel.getByLabel("拆集模型")).toBeDisabled(); await panel.getByRole("button",{ name: "核对拆集原提交" }).click(); }
  if (mode === "expired") {
    await expect(panel.getByRole("button",{ name: "核对拆集原提交" })).toBeEnabled();
    await page.reload(); await login(page);
    const storyTask = page.getByRole("region",{ name: "故事知识任务" });
    await storyTask.getByLabel("任务编号").fill("task"); await storyTask.getByRole("button",{ name: "读取任务",exact: true }).click();
    await page.getByRole("button",{ name: "进入审核",exact: true }).click();
    await panel.getByRole("button",{ name: "核对拆集原提交" }).click();
  }
  await panel.getByRole("button",{ name: "刷新拆集状态" }).click();
  if (mode === "mobile") { await page.setViewportSize({ width: 390,height: 844 }); await expect(panel.getByRole("button",{ name: "生成拆集候选",exact: true })).toBeHidden(); await expect(panel.getByText(/候选已生成/)).toBeVisible(); }
  await expect(panel.getByRole("button",{ name: "载入拆集候选" })).toBeEnabled();
  await expect(desk.getByRole("button",{ name: "确认拆集方案",exact: true })).toHaveCount(0);
  await panel.getByRole("button",{ name: "载入拆集候选" }).click();
  if (mode === "stale") { await expect(panel.getByText(/活动方案已变化/)).toBeVisible(); await expect(desk.getByRole("button",{ name: "确认拆集方案",exact: true })).toHaveCount(0); }
  else await expect(desk.getByRole("button",{ name: "确认拆集方案",exact: true })).toBeEnabled();
  if (mode === "success") { await panel.scrollIntoViewIfNeeded(); await page.screenshot({ path: "/private/tmp/episode-task-panel.png" }); }
  expect(posts).toBe(mode === "expired" ? 3 : mode === "uncertain" ? 2 : 1);
});
for (const mode of ["owner", "editor", "stale", "empty"]) test(`已确认知识后拆集审核：${mode}`, async ({ page }) => {
  await setup(page);
  const headers = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization,content-type", "access-control-allow-methods": "GET,POST,OPTIONS" };
  const chapter = { id: "c", title: "雨落", activeSourceVersionId: "s", versions: [{ id: "s", ordinal: 1, text: "雨落", fragments: [{ id: "f", ordinal: 1, text: "雨落" }] }] };
  await page.route(`${origin}/projects/p/chapters/c/context`, route => route.fulfill({ headers, json: { project: { id: "p", title: "作品", role: mode === "editor" ? "editor" : "owner", aspectRatio: "9:16", targetDurationSeconds: 180, narrativeMode: "dialogue" }, chapter } }));
  await page.route(`${origin}/projects/p/chapters/c`, route => route.fulfill({ headers, json: chapter }));
  await page.route(`${origin}/projects/p/chapters/c/story-knowledge`, route => route.fulfill({ headers, json: { id: "candidate", extractionJobId: "task", projectId: "p", chapterId: "c", sourceVersionId: "s", status: "confirmed", extractionStatus: "succeeded", facts: [], failures: [] } }));
  let plan = { id: "plan-1", projectId: "p", chapterId: "c", sourceVersionId: "s", storyBibleVersionId: "candidate", status: "candidate", targetDurationSeconds: 180, recommendationRationale: "围绕落雨事件安排一集", episodes: [{ id: "e", ordinal: 1, title: "风雨将至", sourceFragmentIds: ["f"], coreEventFactIds: ["event"] }],
    majorAdaptationProposals: [{ id: "proposal", summary: "调整事件顺序", rationale: "节奏", affectedFactIds: ["event"], decision: undefined as unknown }] };
  await page.route(`${origin}/projects/p/chapters/c/episode-plan**`, async route => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ headers, status: 204 });
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON(); expect(body.expectedActiveVersionId).toBe(plan.id);
      if (route.request().url().endsWith("/decision")) { expect(body.decision).toBe("rejected"); plan = { ...plan, id: "plan-2", majorAdaptationProposals: [{ ...plan.majorAdaptationProposals[0]!, decision: { outcome: "rejected" } }] }; }
      else { expect(plan.id).toBe("plan-2"); plan = { ...plan, id: "plan-3", status: "confirmed" }; }
      return route.fulfill({ headers, json: plan });
    }
    if (mode === "empty") return route.fulfill({ headers, status: 404, json: { code: "EPISODE_PLAN_NOT_FOUND" } });
    return route.fulfill({ headers, json: { plan, current: mode !== "stale", canReview: mode === "owner" && plan.status === "candidate", sourceFragments: [{ id: "f", text: "雨落" }], coreEvents: [{ id: "event", statement: "开始下雨" }] } });
  });
  await page.getByRole("button", { name: "进入审核", exact: true }).click();
  const desk = page.getByRole("region", { name: "拆集方案审核" });
  await desk.getByRole("button", { name: "读取拆集方案" }).click();
  if (mode === "empty") { await expect(desk.getByText(/尚无拆集候选/)).toBeVisible(); await expect(desk.getByRole("button", { name: "确认拆集方案", exact: true })).toHaveCount(0); return; }
  await expect(desk.getByText("3 分钟 / 集", { exact: true })).toBeVisible();
  await expect(desk.getByRole("button", { name: "确认拆集方案", exact: true })).toBeDisabled();
  if (mode !== "owner") { await expect(desk.getByRole("button", { name: "拒绝 proposal" })).toBeDisabled(); return; }
  await desk.getByRole("button", { name: "第1集 · 风雨将至" }).click();
  await expect(desk.getByText("雨落", { exact: true })).toBeVisible();
  await expect(desk.getByText("开始下雨", { exact: true }).first()).toBeVisible();
  await desk.scrollIntoViewIfNeeded(); await page.screenshot({ path: "/private/tmp/episode-plan-workbench.png" });
  await desk.getByLabel("裁决理由 proposal").fill("保持原著顺序");
  await desk.getByRole("button", { name: "拒绝 proposal" }).click();
  await expect(desk.getByRole("button", { name: "确认拆集方案", exact: true })).toBeEnabled();
  await desk.getByRole("button", { name: "确认拆集方案", exact: true }).click();
  await expect(desk.getByRole("region", { name: "剧本候选生成与追溯" })).toBeVisible();
});
for (const mode of ["success", "uncertain", "stale", "mobile"]) test(`审核页局部重试与明确载入：${mode}`, async ({ page }) => {
  await setup(page);
  const headers = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization,content-type", "access-control-allow-methods": "GET,POST,OPTIONS" };
  const chapter = { id: "c", title: "雨落", activeSourceVersionId: "s", versions: [{ id: "s", ordinal: 1, text: "雨落", fragments: [{ id: "f", ordinal: 1, text: "雨落" }] }] };
  const candidate = { id: "candidate", extractionJobId: "task", projectId: "p", chapterId: "c", sourceVersionId: "s", status: "candidate", extractionStatus: "partially_succeeded",
    facts: [{ id: "rain", factType: "worldRule", statement: "雨落", assertionKind: "explicit", resolutionStatus: "resolved", resolutionGroupId: null, evidence: [{ sourceVersionId: "s", fragmentId: "f" }] }],
    failures: [{ scopeKey: "identity", originJobId: "task", code: "UNKNOWN", message: "待查", retryable: true }, { scopeKey: "blocked", originJobId: "task", code: "BLOCKED", message: "不可重试", retryable: false }, { scopeKey: "other", originJobId: "earlier-task", code: "UNKNOWN", message: "其他来源", retryable: true }] };
  let submitted = false, posts = 0;
  const next = { ...candidate, id: "retry-candidate", extractionJobId: "retry-task", failures: candidate.failures.slice(1) };
  await page.route(`${origin}/projects/p/chapters/c/context`, route => route.fulfill({ headers, json: { project: { id: "p", title: "作品", role: "owner" }, chapter } }));
  await page.route(`${origin}/projects/p/chapters/c`, route => route.fulfill({ headers, json: chapter }));
  await page.route(`${origin}/projects/p/chapters/c/story-knowledge`, route => route.fulfill({ headers, json: submitted ? { ...next, id: mode === "stale" ? "newer-candidate" : next.id } : candidate }));
  await page.route(`${origin}/projects/p/chapters/c/story-knowledge/versions/retry-candidate`, route => route.fulfill({ headers, json: next }));
  await page.route(`${origin}/story-knowledge-tasks/retry-task`, route => route.fulfill({ headers, json: { id: "retry-task", projectId: "p", chapterId: "c", input: { stage: "story_knowledge", sourceVersionId: "s" }, state: "succeeded", reason: null, result: { candidateVersionId: "retry-candidate", extractionStatus: "partially_succeeded" } } }));
  let requestId: string | undefined;
  await page.route(`${origin}/projects/p/chapters/c/story-knowledge-tasks/retries`, route => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ headers, status: 204 });
    posts++; const input = route.request().postDataJSON();
    expect(input).toMatchObject({ expectedActiveVersionId: "candidate", scopeKeys: ["identity"], configurationVersionId: "config", modelId: "model" });
    expect(input.requestId).toBeTruthy();
    if (requestId) expect(input.requestId).toBe(requestId); else requestId = input.requestId;
    if (mode === "uncertain" && posts === 1) return route.fulfill({ headers, status: 503, json: { code: "STORAGE_UNAVAILABLE" } });
    submitted = true;
    return route.fulfill({ headers, json: { id: "retry-task", projectId: "p", chapterId: "c", input: { stage: "story_knowledge", sourceVersionId: "s" }, state: "queued", reason: null, result: null } });
  });
  await page.getByRole("button", { name: "进入审核", exact: true }).click();
  const retry = page.getByRole("region", { name: "局部失败重试" });
  if (mode === "mobile") { await page.setViewportSize({ width: 390, height: 844 }); await expect(retry).toBeHidden(); expect(posts).toBe(0); return; }
  await expect(retry.getByRole("checkbox", { name: "identity" })).toBeEnabled();
  await expect(retry.getByRole("checkbox", { name: "blocked" })).toBeDisabled();
  await retry.getByRole("checkbox", { name: "identity" }).check();
  await expect(retry.getByRole("checkbox", { name: "other" })).toBeDisabled();
  await retry.getByRole("button", { name: "读取重试模型" }).click();
  await retry.getByLabel("局部重试模型").selectOption("model");
  if (mode === "success") { await retry.scrollIntoViewIfNeeded(); await page.screenshot({ path: "/private/tmp/story-knowledge-retry.png" }); }
  await retry.getByRole("button", { name: "提交所选范围重试" }).click();
  if (mode === "uncertain") {
    await expect(retry.getByRole("button", { name: "核对原提交" })).toBeEnabled();
    await expect(retry.getByLabel("局部重试模型")).toBeDisabled();
    await retry.getByRole("button", { name: "核对原提交" }).click();
  }
  await expect(retry.getByRole("button", { name: "载入重试候选" })).toBeVisible();
  await expect(page.getByRole("button", { name: "确认故事知识阶段" })).toBeDisabled();
  await retry.getByRole("button", { name: "载入重试候选" }).click();
  if (mode === "stale") { await expect(retry.getByText(/原文或活动候选已变化/)).toBeVisible(); await expect(page.getByText("故事知识 · 版本 candidate")).toBeVisible(); }
  else await expect(page.getByText("故事知识 · 版本 retry-candidate")).toBeVisible();
  expect(posts).toBe(mode === "uncertain" ? 2 : 1);
});
test("任务候选可进入对应章节审核，部分成功不自动确认", async ({ page }) => {
  await setup(page);
  const headers = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization,content-type", "access-control-allow-methods": "GET,OPTIONS" };
  const chapter = { id: "c", title: "雨落", activeSourceVersionId: "s", versions: [{ id: "s", ordinal: 1, text: "雨落", fragments: [{ id: "f", ordinal: 1, text: "雨落" }] }] };
  await page.route(`${origin}/projects/p/chapters/c/context`, route => route.fulfill({ headers, json: { project: { id: "p", title: "测试作品", role: "owner", aspectRatio: "16:9", targetDurationSeconds: 60, narrativeMode: "dialogue" }, chapter } }));
  await page.route(`${origin}/projects/p/chapters/c`, route => route.fulfill({ headers, json: chapter }));
  await page.route(`${origin}/projects/p/chapters/c/story-knowledge`, route => route.fulfill({ headers, json: {
    id: "candidate", extractionJobId: "task", projectId: "p", chapterId: "c", sourceVersionId: "s", status: "candidate", extractionStatus: "partially_succeeded",
    facts: [{ id: "rain", factType: "worldRule", statement: "雨落", assertionKind: "explicit", resolutionStatus: "resolved", resolutionGroupId: null, evidence: [{ sourceVersionId: "s", fragmentId: "f" }] }],
    failures: [{ scopeKey: "identity", originJobId: "task", code: "UNKNOWN", message: "待确认", retryable: true }],
  } }));
  await page.getByRole("button", { name: "进入审核", exact: true }).click();
  await expect(page.getByRole("heading", { name: "逐条核证，再让故事进入剧本" })).toBeVisible();
  await expect(page.getByRole("button", { name: "确认故事知识阶段" })).toBeDisabled();
  await expect(page.getByRole("textbox", { name: "事实陈述" })).toHaveValue("雨落");
  await page.getByRole("textbox", { name: "事实陈述" }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: "/private/tmp/task-review-entry.png" });
});
for (const change of ["source", "candidate", "during-load"]) {
  test(`任务审核入口拒绝历史或晚到变化：${change}`, async ({ page }) => {
    await setup(page);
    const headers = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization,content-type", "access-control-allow-methods": "GET,OPTIONS" };
    const chapter = { id: "c", title: "雨落", activeSourceVersionId: change === "source" ? "new-source" : "s", versions: [] };
    await page.route(`${origin}/projects/p/chapters/c/context`, route => route.fulfill({ headers, json: { project: { id: "p", title: "测试作品", role: "editor" }, chapter } }));
    await page.route(`${origin}/projects/p/chapters/c`, route => route.fulfill({ headers, json: chapter }));
    let reads = 0;
    await page.route(`${origin}/projects/p/chapters/c/story-knowledge`, route => {
      if (route.request().method() !== "OPTIONS") reads++;
      return route.fulfill({ headers, json: { id: change === "candidate" || change === "during-load" && reads > 1 ? "new-candidate" : "candidate",
        extractionJobId: "task", projectId: "p", chapterId: "c", sourceVersionId: "s", status: "candidate", extractionStatus: "partially_succeeded", facts: [], failures: [] } });
    });
    await page.getByRole("button", { name: "进入审核", exact: true }).click();
    if (change === "during-load") await expect(page.getByText(/原文或活动候选已变化，停止审核/)).toBeVisible();
    else {
      await expect(page.getByText(/该结果已不是当前原文或活动候选，仅可只读预览/)).toBeVisible();
      await expect(page.getByRole("heading", { name: "逐条核证，再让故事进入剧本" })).toHaveCount(0);
      await page.getByRole("button", { name: "查看候选版本" }).click();
      await expect(page.getByRole("region", { name: "任务候选版本" })).toBeVisible();
    }
    await expect(page.getByRole("button", { name: "确认故事知识阶段" })).toHaveCount(0);
  });
}
test("原文流程请求在途时不能切入任务审核", async ({ page }) => {
  await setup(page);
  const headers = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization,content-type", "access-control-allow-methods": "GET,POST,OPTIONS" };
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  await page.route(`${origin}/projects`, async route => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ headers, status: 204 });
    entered(); await gate;
    await route.fulfill({ headers, json: { id: "new-project", title: "另一个项目" } });
  });
  await page.route(`${origin}/projects/p/chapters/c/context`, route => route.fulfill({ headers, json: { project: { id: "p", title: "测试作品", role: "owner" }, chapter: { id: "c", activeSourceVersionId: "s", versions: [] } } }));
  await page.route(`${origin}/projects/p/chapters/c/story-knowledge`, route => route.fulfill({ headers, json: { id: "candidate", projectId: "p", chapterId: "c", sourceVersionId: "s", extractionJobId: "task" } }));
  try {
    await page.getByLabel("项目名称").fill("另一个项目");
    await page.getByRole("checkbox", { name: /拥有该作品或合法改编权/ }).check();
    await page.getByRole("button", { name: /创建项目/ }).click(); await started;
    await page.getByRole("button", { name: "进入审核", exact: true }).click();
    await expect(page.getByText("请等待当前原文流程操作完成，再进入任务审核。")).toBeVisible();
    await expect(page.getByRole("heading", { name: "逐条核证，再让故事进入剧本" })).toHaveCount(0);
  } finally { release(); }
});
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
      if (path.endsWith("/story-knowledge-tasks/availability")) return route.fulfill({ headers, contentType: "application/json", body: JSON.stringify({ available: true, reason: null }) });
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

for (const reason of ["WORKSPACE_TASK_DISABLED", "TASK_PROVIDER_UNSUPPORTED"]) {
  test(`生成不可用${reason}时禁止重提交但仍显示已有任务`, async ({ page }) => {
    const posts = await setup(page, "VERSION_CONFLICT");
    await page.route(`${origin}/projects/p/chapters/c/story-knowledge-tasks/availability?*`, route => route.fulfill({
      headers: { "access-control-allow-origin": "*" }, contentType: "application/json", body: JSON.stringify({ available: false, reason }),
    }));
    await page.getByRole("button", { name: "刷新状态" }).click();
    const panel = page.getByRole("region", { name: "故事知识任务" });
    await expect(panel.getByText(reason === "WORKSPACE_TASK_DISABLED" ? /工作室尚未启用故事知识生成/ : /厂商尚未支持故事知识生成/)).toBeVisible();
    await expect(panel.getByRole("button", { name: "使用所选模型重新提交" })).toBeDisabled();
    await expect(panel.getByText(/任务 task · 原文 s/)).toBeVisible();
    expect(posts()).toBe(0);
  });
}
test("恢复章节上下文后通过列表选择任务，刷新后列表仍可找回", async ({ page }) => {
  await setup(page, null, true);
  await expect(page.getByRole("region", { name: "创建故事知识任务" })).toHaveCount(0);
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

for (const mode of ["success","uncertain","stale","mobile"]) test(`确认拆集后剧本生成与原文追溯：${mode}`,async ({ page }) => {
  await setup(page);
  const headers = { "access-control-allow-origin": "*","access-control-allow-headers": "authorization,content-type","access-control-allow-methods": "GET,POST,OPTIONS" };
  const chapter = { id: "c",title: "雨落",activeSourceVersionId: "s",versions: [{ id: "s",ordinal: 1,text: "雨落",fragments: [{ id: "f",ordinal: 1,text: "雨落" }] }] };
  await page.route(`${origin}/projects/p/chapters/c/context`,r => r.fulfill({ headers,json: { project: { id: "p",title: "作品",role: "owner" },chapter } }));
  await page.route(`${origin}/projects/p/chapters/c`,r => r.fulfill({ headers,json: chapter }));
  await page.route(`${origin}/projects/p/chapters/c/story-knowledge`,r => r.fulfill({ headers,json: { id: "candidate",extractionJobId: "task",projectId: "p",chapterId: "c",sourceVersionId: "s",status: "confirmed",extractionStatus: "succeeded",facts: [],failures: [] } }));
  await page.route(`${origin}/projects/p/chapters/c/episode-plan`,r => r.fulfill({ headers,json: { current: true,canReview: false,sourceFragments: [],coreEvents: [],plan: {
    id: "plan",projectId: "p",chapterId: "c",sourceVersionId: "s",storyBibleVersionId: "candidate",status: "confirmed",targetDurationSeconds: 60,episodes: [],majorAdaptationProposals: []
  } } }));
  let posts = 0,requestId = "";
  const task = { id: "script-task",projectId: "p",chapterId: "c",input: { stage: "script",resultType: "scriptContent",sourceVersionId: "s",upstreamConfirmedVersionIds: ["plan","candidate"] },state: "succeeded",reason: null,result: { candidateVersionId: "script",extractionStatus: "partially_succeeded" } };
  await page.route(`${origin}/projects/p/chapters/c/script-content-tasks**`,r => {
    if (r.request().method() === "OPTIONS") return r.fulfill({ headers,status: 204 });
    if (r.request().method() === "POST") {
      posts++; const input = r.request().postDataJSON();
      expect(Object.keys(input).sort()).toEqual(["configurationVersionId","modelId","requestId"]);
      if (requestId) expect(input.requestId).toBe(requestId); else requestId = input.requestId;
      if (mode === "uncertain" && posts === 1) return r.fulfill({ headers,status: 503,json: { code: "STORAGE_UNAVAILABLE" } });
      return r.fulfill({ headers,json: task });
    }
    return r.fulfill({ headers,json: r.request().url().includes("availability") ? { available: true,reason: null } : { tasks: [task],nextCursor: null } });
  });
  await page.route(`${origin}/script-content-tasks/script-task`,r => r.fulfill({ headers,json: task }));
  await page.route(`${origin}/projects/p/chapters/c/script-content`,r => r.fulfill({ headers,json: { current: mode !== "stale",sourceFragments: [{ id: "f",text: "雨落" }],version: {
    id: "script",jobId: task.id,projectId: "p",chapterId: "c",sourceVersionId: "s",planVersionId: "plan",generationStatus: "partially_succeeded",
    scenes: [{ id: "scene",title: "雨中庭院" }],elements: [{ id: "action",sceneId: "scene",text: "雨点打湿庭院",elementType: "action",provenance: [{ type: "source_fragment",fragmentId: "f",transformation: "visualized" }] }],failures: [{ scopeKey: "dialogue",code: "INVALID_ELEMENT",retryable: true }]
  } } }));
  await page.getByRole("button",{ name: "进入审核",exact: true }).click();
  await page.getByRole("button",{ name: "读取拆集方案",exact: true }).click();
  const panel = page.getByRole("region",{ name: "剧本候选生成与追溯" });
  await panel.getByRole("button",{ name: "读取剧本模型",exact: true }).click();
  await panel.getByLabel("剧本模型").selectOption("model");
  await panel.getByRole("button",{ name: "生成剧本候选",exact: true }).click();
  if (mode === "uncertain") {
    await expect(panel.getByLabel("剧本模型")).toBeDisabled();
    await panel.getByRole("button",{ name: "刷新剧本任务",exact: true }).click();
    await expect(panel.getByRole("button",{ name: "script-task · succeeded",exact: true })).toBeDisabled();
    await page.reload(); await login(page);
    const storyTask = page.getByRole("region",{ name: "故事知识任务" });
    await storyTask.getByLabel("任务编号").fill("task"); await storyTask.getByRole("button",{ name: "读取任务",exact: true }).click();
    await page.getByRole("button",{ name: "进入审核",exact: true }).click();
    await page.getByRole("button",{ name: "读取拆集方案",exact: true }).click();
    await panel.getByRole("button",{ name: "核对剧本原提交",exact: true }).click();
  }
  await expect(panel.getByRole("button",{ name: "载入剧本候选",exact: true })).toBeEnabled();
  await expect(panel.getByRole("heading",{ name: "雨中庭院" })).toHaveCount(0);
  await panel.getByRole("button",{ name: "载入剧本候选",exact: true }).click();
  if (mode === "stale") await expect(panel.getByText("结果或上游已变化，请重新核对。")).toBeVisible();
  else {
    await panel.getByRole("button",{ name: "雨点打湿庭院",exact: true }).click();
    await expect(panel.getByLabel("剧本原文依据").getByText("雨落",{ exact: true })).toBeVisible();
    await expect(panel.getByText("失败范围 dialogue · INVALID_ELEMENT")).toBeVisible();
    if (mode === "mobile") {
      await page.setViewportSize({ width: 390,height: 844 });
      await expect(panel.getByRole("button",{ name: "生成剧本候选",exact: true })).toBeHidden();
    }
  }
  expect(posts).toBe(mode === "uncertain" ? 2 : 1);
});

for (const role of ["owner","editor","reviewer"]) test(`剧本候选编辑和建议权限及模式恢复：${role}`,async ({ page }) => {
  await setup(page);
  const headers = { "access-control-allow-origin": "*","access-control-allow-headers": "authorization,content-type","access-control-allow-methods": "GET,POST,OPTIONS" };
  const chapter = { id: "c",title: "雨落",activeSourceVersionId: "s",versions: [{ id: "s",ordinal: 1,text: "雨落",fragments: [{ id: "f",ordinal: 1,text: "雨落" }] }] };
  await page.route(`${origin}/projects/p/chapters/c/context`,r => r.fulfill({ headers,json: { project: { id: "p",title: "作品",role },chapter } }));
  await page.route(`${origin}/projects/p/chapters/c`,r => r.fulfill({ headers,json: chapter }));
  await page.route(`${origin}/projects/p/chapters/c/story-knowledge`,r => r.fulfill({ headers,json: { id: "candidate",extractionJobId: "task",projectId: "p",chapterId: "c",sourceVersionId: "s",status: "confirmed",extractionStatus: "succeeded",facts: [],failures: [] } }));
  await page.route(`${origin}/projects/p/chapters/c/episode-plan`,r => r.fulfill({ headers,json: { current: true,canReview: false,sourceFragments: [],coreEvents: [],plan: { id: "plan",projectId: "p",chapterId: "c",sourceVersionId: "s",storyBibleVersionId: "candidate",status: "confirmed",targetDurationSeconds: 60,episodes: [],majorAdaptationProposals: [] } } }));
  let version = { id: "script",jobId: "script-task",projectId: "p",chapterId: "c",sourceVersionId: "s",planVersionId: "plan",generationStatus: "succeeded",scenes: [{ id: "scene",title: "庭院" }],elements: [{ id: "action",sceneId: "scene",text: "雨落庭院",elementType: "action",provenance: [{ type: "source_fragment",fragmentId: "f",transformation: "visualized" }] }],failures: [],suggestions: [] as Array<{ id: string;elementId: string;text: string;reason: string;status: string;submittedBy: string }> };
  await page.route(`${origin}/projects/p/chapters/c/script-content`,r => r.fulfill({ headers,json: { version,current: true,permissions: { canEdit: role !== "editor",canSuggest: true,canDecide: role !== "editor" },sourceFragments: [{ id: "f",text: "雨落" }] } }));
  let posts = 0;
  await page.route(`${origin}/projects/p/chapters/c/script-content/review`,r => {
    if (r.request().method() === "OPTIONS") return r.fulfill({ headers,status: 204 });
    const cmd = r.request().postDataJSON(); expect(cmd.expectedActiveVersionId).toBe(version.id); expect(cmd.requestId).toBeTruthy(); posts++;
    if (cmd.kind === "edit") { expect(role).not.toBe("editor"); version = { ...version,id: `v${posts}`,elements: [{ ...version.elements[0]!,text: cmd.text }] }; }
    else if (cmd.kind === "suggest") version = { ...version,id: `v${posts}`,suggestions: [{ id: "proposal",elementId: "action",text: cmd.text,reason: cmd.reason,status: "pending",submittedBy: role }] };
    else version = { ...version,id: `v${posts}`,suggestions: [{ ...version.suggestions[0]!,status: cmd.decision }],elements: [{ ...version.elements[0]!,text: version.suggestions[0]!.text }] };
    return r.fulfill({ headers,json: version });
  });
  await page.getByRole("button",{ name: "进入审核",exact: true }).click(); await page.getByRole("button",{ name: "读取拆集方案",exact: true }).click();
  const panel = page.getByRole("region",{ name: "剧本候选生成与追溯" });
  await panel.getByRole("button",{ name: "读取当前剧本",exact: true }).click(); await panel.getByRole("button",{ name: "雨落庭院",exact: true }).click();
  await panel.getByLabel("替换内容").fill("雨打庭院"); await panel.getByLabel("修改理由",{ exact: true }).fill("视觉表达");
  if (role === "editor") { await expect(panel.getByRole("button",{ name: "保存候选修改" })).toHaveCount(0); await panel.getByRole("button",{ name: "提交剧本建议" }).click(); }
  else {
    await panel.getByRole("button",{ name: "保存候选修改" }).click(); await panel.getByRole("button",{ name: "雨打庭院",exact: true }).click();
    await panel.getByLabel("替换内容").fill("雨滴落满庭院"); await panel.getByLabel("修改理由",{ exact: true }).fill("补充可见动作"); await panel.getByRole("button",{ name: "提交剧本建议" }).click();
    await panel.getByLabel("建议裁决理由 proposal").fill("与原文一致"); await panel.getByRole("button",{ name: "接受剧本建议 proposal" }).click();
  }
  const expected = role === "editor" ? "雨落庭院" : "雨滴落满庭院";
  await panel.getByRole("button",{ name: expected,exact: true }).click();
  await page.getByRole("button",{ name: "追溯",exact: true }).click(); await page.getByRole("button",{ name: "审核",exact: true }).click();
  await expect(panel.getByRole("button",{ name: expected,exact: true })).toHaveAttribute("aria-pressed","true"); await expect(panel.getByLabel("剧本原文依据").getByText("雨落",{ exact: true })).toBeVisible();
  if (role === "owner") {
    let release!: () => void,entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    await page.route(`${origin}/projects/p/chapters/c/script-content`,async r => {
      entered(); await gate;
      return r.fulfill({ headers,json: { version,current: true,permissions: { canEdit: true,canSuggest: true,canDecide: true },sourceFragments: [{ id: "f",text: "雨落" }] } });
    });
    try {
      await page.reload(); await login(page);
      const storyTask = page.getByRole("region",{ name: "故事知识任务" });
      await storyTask.getByLabel("任务编号").fill("task"); await storyTask.getByRole("button",{ name: "读取任务",exact: true }).click();
      await page.getByRole("button",{ name: "进入审核",exact: true }).click();
      await started;
      await expect(panel.getByRole("button",{ name: "读取当前剧本",exact: true })).toBeDisabled();
    } finally { release(); }
    await expect(panel.getByRole("button",{ name: expected,exact: true })).toHaveAttribute("aria-pressed","true");
    await expect(panel.getByRole("button",{ name: "读取当前剧本",exact: true })).toBeEnabled();
  }
  expect(posts).toBe(role === "editor" ? 1 : 3);
});

for (const mode of ["success","unknown-submit","stale","unknown-execution","mobile"]) test(`剧本失败范围重试：${mode}`,async ({ page }) => {
  await setup(page);
  const headers = { "access-control-allow-origin": "*","access-control-allow-headers": "authorization,content-type","access-control-allow-methods": "GET,POST,OPTIONS" };
  const chapter = { id: "c",title: "雨落",activeSourceVersionId: "s",versions: [{ id: "s",ordinal: 1,text: "雨落",fragments: [{ id: "f",ordinal: 1,text: "雨落" }] }] };
  await page.route(`${origin}/projects/p/chapters/c/context`,r => r.fulfill({ headers,json: { project: { id: "p",title: "作品",role: "owner" },chapter } }));
  await page.route(`${origin}/projects/p/chapters/c`,r => r.fulfill({ headers,json: chapter }));
  await page.route(`${origin}/projects/p/chapters/c/story-knowledge`,r => r.fulfill({ headers,json: { id: "candidate",extractionJobId: "task",projectId: "p",chapterId: "c",sourceVersionId: "s",status: "confirmed",extractionStatus: "succeeded",facts: [],failures: [] } }));
  await page.route(`${origin}/projects/p/chapters/c/episode-plan`,r => r.fulfill({ headers,json: { current: true,canReview: false,sourceFragments: [],coreEvents: [],plan: { id: "plan",projectId: "p",chapterId: "c",sourceVersionId: "s",storyBibleVersionId: "candidate",status: "confirmed",targetDurationSeconds: 60,episodes: [],majorAdaptationProposals: [] } } }));
  const provenance = [{ type: "source_fragment",fragmentId: "f",transformation: "retained" }];
  const base = { id: "script",jobId: "original-task",projectId: "p",chapterId: "c",sourceVersionId: "s",planVersionId: "plan",generationStatus: "partially_succeeded",scenes: [{ id: "late-scene",episodeId: "e",ordinal: 2,title: "庭院后景" }],elements: [{ id: "saved",sceneId: "late-scene",elementType: "action",ordinal: 2,text: "已成功动作",provenance }],failures: [{ scopeKey: "dialogue",code: "INVALID_ELEMENT",retryable: true },{ scopeKey: "narration",code: "INVALID_ELEMENT",retryable: true },{ scopeKey: "sound",code: "NEEDS_REVIEW",retryable: false }] };
  const retry = { expectedActiveVersionId: "script",retryOfJobId: "original-task",scopeKeys: ["dialogue","narration"] };
  const task = { id: "retry-task",projectId: "p",chapterId: "c",input: { stage: "script",resultType: "scriptContent",sourceVersionId: "s",upstreamConfirmedVersionIds: ["plan","candidate"],retry },state: "queued",reason: null,result: null };
  let posts = 0,requestId = "",done = false;
  await page.route(`${origin}/projects/p/chapters/c/script-content-tasks/retries`,r => {
    if (r.request().method() === "OPTIONS") return r.fulfill({ headers,status: 204 });
    posts++; const input = r.request().postDataJSON(); expect(Object.keys(input).sort()).toEqual(["configurationVersionId","expectedActiveVersionId","modelId","requestId","scopeKeys"]);
    expect(input.expectedActiveVersionId).toBe("script"); expect(input.scopeKeys).toEqual(["dialogue","narration"]);
    if (requestId) expect(input.requestId).toBe(requestId); else requestId = input.requestId;
    if (mode === "unknown-submit" && posts === 1) return r.fulfill({ headers,status: 503,json: { code: "STORAGE_UNAVAILABLE" } });
    return r.fulfill({ headers,json: task });
  });
  await page.route(`${origin}/projects/p/chapters/c/script-content-tasks*`,r => r.fulfill({ headers,json: { tasks: [],nextCursor: null } }));
  await page.route(`${origin}/script-content-tasks/retry-task`,r => {
    if (mode === "unknown-execution") return r.fulfill({ headers,json: { ...task,state: "paused",reason: "EXECUTION_UNCERTAIN" } });
    done = true; return r.fulfill({ headers,json: { ...task,state: "succeeded",result: { candidateVersionId: "retry-result",extractionStatus: "partially_succeeded" } } });
  });
  await page.route(`${origin}/projects/p/chapters/c/script-content`,r => r.fulfill({ headers,json: {
    current: !(done && mode === "stale"),episodes: [{ id: "e",ordinal: 1 }],permissions: { canEdit: true,canSuggest: true,canDecide: true },sourceFragments: [{ id: "f",text: "雨落" }],version: done ? {
      ...base,id: "retry-result",jobId: "retry-task",retry,scenes: [...base.scenes,{ id: "early-scene",episodeId: "e",ordinal: 1,title: "庭院前景" }],
      elements: [...base.elements,{ id: "recovered-dialogue",sceneId: "late-scene",elementType: "dialogue",ordinal: 1,text: "恢复对白",provenance },{ id: "recovered-narration",sceneId: "early-scene",elementType: "narration",ordinal: 1,text: "恢复旁白",provenance }],failures: [base.failures[2]]
    } : base,
  } }));
  await page.getByRole("button",{ name: "进入审核",exact: true }).click(); await page.getByRole("button",{ name: "读取拆集方案",exact: true }).click();
  const panel = page.getByRole("region",{ name: "剧本候选生成与追溯" }),local = page.getByRole("region",{ name: "剧本失败范围重试" });
  await panel.getByRole("button",{ name: "读取当前剧本",exact: true }).click();
  await expect(local.getByRole("checkbox",{ name: "重试范围 sound" })).toBeDisabled();
  await local.getByRole("checkbox",{ name: "重试范围 dialogue" }).check(); await local.getByRole("checkbox",{ name: "重试范围 narration" }).check();
  await local.getByRole("button",{ name: "读取剧本重试模型" }).click(); await local.getByRole("combobox",{ name: "剧本重试模型",exact: true }).selectOption("model");
  await local.getByRole("button",{ name: "仅重试选中失败项" }).click();
  if (mode === "unknown-submit") {
    await expect(local.getByRole("checkbox",{ name: "重试范围 dialogue" })).toBeDisabled();
    await page.reload(); await login(page);
    const story = page.getByRole("region",{ name: "故事知识任务" });
    await story.getByLabel("任务编号").fill("task"); await story.getByRole("button",{ name: "读取任务",exact: true }).click();
    await page.getByRole("button",{ name: "进入审核",exact: true }).click();
    await local.getByRole("button",{ name: "核对剧本重试原提交" }).click();
  }
  await expect(local.getByRole("button",{ name: "仅重试选中失败项" })).toBeDisabled();
  await panel.getByRole("button",{ name: "刷新剧本任务",exact: true }).click();
  if (mode === "unknown-execution") {
    await expect(local.getByRole("button",{ name: "仅重试选中失败项" })).toBeDisabled();
    await expect(panel.getByRole("button",{ name: "载入剧本候选",exact: true })).toBeDisabled();
  } else {
    await expect(panel.getByRole("button",{ name: "恢复对白",exact: true })).toHaveCount(0);
    await panel.getByRole("button",{ name: "载入剧本候选",exact: true }).click();
    if (mode === "stale") await expect(panel.getByText("结果或上游已变化，请重新核对。")).toBeVisible();
    else {
      await expect(panel.getByRole("button",{ name: "已成功动作",exact: true })).toBeVisible();
      await expect(panel.getByText(/本次成功范围：dialogue、narration/)).toBeVisible();
      await expect(panel.getByText(/其余失败范围：sound/)).toBeVisible();
      expect(await panel.locator("h3").allTextContents()).toContain("庭院前景");
      const sceneTitles = await panel.locator("h3").allTextContents(); expect(sceneTitles.indexOf("庭院前景")).toBeLessThan(sceneTitles.indexOf("庭院后景"));
      const texts = await panel.getByRole("button").allTextContents(); expect(texts.indexOf("恢复对白")).toBeLessThan(texts.indexOf("已成功动作"));
      await panel.getByRole("button",{ name: "恢复对白",exact: true }).click(); await expect(panel.getByLabel("剧本原文依据").getByText("雨落",{ exact: true })).toBeVisible();
      if (mode === "mobile") { await page.setViewportSize({ width: 390,height: 844 }); await expect(local).toBeHidden(); }
    }
  }
  expect(posts).toBe(mode === "unknown-submit" ? 2 : 1);
});
