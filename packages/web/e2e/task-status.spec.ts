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
for (const mode of ["owner", "editor", "stale", "empty", "old-source"]) test(`已确认知识后拆集审核：${mode}`, async ({ page }) => {
  await setup(page);
  const headers = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization,content-type", "access-control-allow-methods": "GET,POST,OPTIONS" };
  const chapter = { id: "c", title: "雨落", activeSourceVersionId: "s", versions: [{ id: "s", ordinal: 1, text: "雨落", fragments: [{ id: "f", ordinal: 1, text: "雨落" }] }] };
  await page.route(`${origin}/projects/p/chapters/c/context`, route => route.fulfill({ headers, json: { project: { id: "p", title: "作品", role: mode === "editor" ? "editor" : "owner", aspectRatio: "9:16", targetDurationSeconds: 180, narrativeMode: "dialogue" }, chapter } }));
  await page.route(`${origin}/projects/p/chapters/c`, route => route.fulfill({ headers, json: chapter }));
  await page.route(`${origin}/projects/p/chapters/c/story-knowledge`, route => route.fulfill({ headers, json: { id: "candidate", extractionJobId: "task", projectId: "p", chapterId: "c", sourceVersionId: "s", status: "confirmed", extractionStatus: "succeeded", facts: [], failures: [] } }));
  let plan = { id: "plan-1", projectId: "p", chapterId: "c", sourceVersionId: mode === "old-source" ? "old" : "s", storyBibleVersionId: "candidate", status: "candidate", targetDurationSeconds: 180, recommendationRationale: "围绕落雨事件安排一集", episodes: [{ id: "e", ordinal: 1, title: "风雨将至", sourceFragmentIds: ["f"], coreEventFactIds: ["event"] }],
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
    return route.fulfill({ headers, json: { plan, current: mode !== "stale" && mode !== "old-source", canReview: mode === "owner" && plan.status === "candidate", sourceFragments: [{ id: "f", text: "雨落" }], coreEvents: [{ id: "event", statement: "开始下雨" }] } });
  });
  await page.getByRole("button", { name: "进入审核", exact: true }).click();
  const desk = page.getByRole("region", { name: "拆集方案审核" });
  await desk.getByRole("button", { name: "读取拆集方案" }).click();
  if (mode === "empty") { await expect(desk.getByText(/尚无拆集候选/)).toBeVisible(); await expect(desk.getByRole("button", { name: "确认拆集方案", exact: true })).toHaveCount(0); return; }
  await expect(desk.getByText("3 分钟 / 集", { exact: true })).toBeVisible();
  await expect(desk.getByRole("button", { name: "确认拆集方案", exact: true })).toBeDisabled();
  const modelButton = desk.getByRole("button",{name:"读取拆集模型"});
  if (mode === "old-source") await expect(modelButton).toBeEnabled();
  if (mode === "stale") await expect(modelButton).toBeDisabled();
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
async function setup(page: Page, reason: string | null = null, chapterContext = false, sourceVersionId = "s") {
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
        await route.fulfill({ headers, contentType: "application/json", body: JSON.stringify({ tasks: [{ id: "task", projectId: "p", chapterId: "c", input: { stage: "story_knowledge", sourceVersionId }, state: "succeeded", reason: null, result: { candidateVersionId: "candidate", extractionStatus: "partially_succeeded" } }], nextCursor: null }) });
        return;
      }
      if (path.endsWith("/resubmit")) { posts++; expect(request.postDataJSON()).toEqual({ configurationVersionId: "config", modelId: "model" }); }
      if (path.includes("/story-knowledge-tasks/")) body = { id: path.endsWith("/resubmit") ? "new-task" : path.split("/").at(-1), projectId: "p", chapterId: "c", input: { stage: "story_knowledge", sourceVersionId }, state: path.endsWith("/resubmit") || !reason ? "succeeded" : "paused", reason: path.endsWith("/resubmit") ? null : reason, result: reason && !path.endsWith("/resubmit") ? null : { candidateVersionId: "candidate", extractionStatus: "partially_succeeded" } };
      else if (path === "/workspace/model-settings") body = { configuration: { id: "config", tested: true, providerId: "deepseek", processingRegion: "mainland", availableModelIds: ["model"] } };
      else if (path.endsWith("/versions/candidate")) body = { id: "candidate", extractionJobId: posts ? "new-task" : "task", projectId: "p", chapterId: "c", sourceVersionId, status: "candidate", extractionStatus: "partially_succeeded", facts: [{ id: "rain", statement: "雨落", evidence: [] }], failures: [{ scopeKey: "identity", message: "待确认" }] };
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

for (const mode of ["success","uncertain","stale","mobile","old-source"]) test(`确认拆集后剧本生成与原文追溯：${mode}`,async ({ page }) => {
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
  await page.route(`${origin}/projects/p/chapters/c/script-content`,r => r.fulfill({ headers,json: { current: mode !== "stale" && !(mode === "old-source" && posts === 0),sourceFragments: [{ id: "f",text: "雨落" }],version: {
    id: "script",jobId: task.id,projectId: "p",chapterId: "c",sourceVersionId: mode === "old-source" && posts === 0 ? "old" : "s",status: mode === "old-source" && posts === 0 ? "confirmed" : "candidate",planVersionId: "plan",generationStatus: "partially_succeeded",
    scenes: [{ id: "scene",title: mode === "old-source" && posts === 0 ? "旧剧本庭院" : "雨中庭院" }],elements: [{ id: "action",sceneId: "scene",text: "雨点打湿庭院",elementType: "action",provenance: [{ type: "source_fragment",fragmentId: "f",transformation: "visualized" }] }],failures: [{ scopeKey: "dialogue",code: "INVALID_ELEMENT",retryable: true }]
  } } }));
  await page.getByRole("button",{ name: "进入审核",exact: true }).click();
  await page.getByRole("button",{ name: "读取拆集方案",exact: true }).click();
  const panel = page.getByRole("region",{ name: "剧本候选生成与追溯" });
  if (mode === "old-source") {
    await panel.getByRole("button",{name:"读取当前剧本",exact:true}).click();
    await expect(panel.getByText("历史正式剧本仅供追溯，写入已关闭。")).toBeVisible();
  }
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
  const savedVersion = version.id,savedSuggestionState = version.suggestions.map(s => s.status),savedPosts = posts;
  const before = new URL(page.url()).searchParams;
  const cursor = ["scriptElement","scriptScene","scriptFragment","scriptReviewContext"].map(k => before.get(k));
  await page.getByRole("button",{ name: "分镜",exact: true }).click();
  await expect(page.getByText("正式内容尚未解锁",{ exact: true })).toBeVisible();
  expect(["scriptElement","scriptScene","scriptFragment","scriptReviewContext"].map(k => new URL(page.url()).searchParams.get(k))).toEqual(cursor);
  await page.getByRole("button",{ name: "追溯",exact: true }).click();await page.getByRole("button",{ name: "审核",exact: true }).click();
  await expect(panel.getByRole("button",{ name: expected,exact: true })).toHaveAttribute("aria-pressed","true");
  expect(version.id).toBe(savedVersion);expect(version.suggestions.map(s => s.status)).toEqual(savedSuggestionState);expect(posts).toBe(savedPosts);
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

for (const mode of ["success","editor","failed","stale","unknown-submit","unknown-confirm","conflict","mobile"]) test(`剧本质量确认与锁定：${mode}`,async ({ page }) => {
  await setup(page);
  const headers = { "access-control-allow-origin": "*","access-control-allow-headers": "authorization,content-type","access-control-allow-methods": "GET,POST,OPTIONS" };
  const chapter = { id: "c",title: "雨落",activeSourceVersionId: "s",versions: [{ id: "s",ordinal: 1,text: "雨落",fragments: [{ id: "f",ordinal: 1,text: "雨落" }] }] };
  await page.route(`${origin}/projects/p/chapters/c/context`,r => r.fulfill({ headers,json: { project: { id: "p",title: "作品",role: mode === "editor" ? "editor" : "owner" },chapter } }));
  await page.route(`${origin}/projects/p/chapters/c`,r => r.fulfill({ headers,json: chapter }));
  await page.route(`${origin}/projects/p/chapters/c/story-knowledge`,r => r.fulfill({ headers,json: { id: "candidate",extractionJobId: "task",projectId: "p",chapterId: "c",sourceVersionId: "s",status: "confirmed",extractionStatus: "succeeded",facts: [],failures: [] } }));
  await page.route(`${origin}/projects/p/chapters/c/episode-plan`,r => r.fulfill({ headers,json: { current: true,canReview: false,sourceFragments: [],coreEvents: [],plan: { id: "plan",projectId: "p",chapterId: "c",sourceVersionId: "s",storyBibleVersionId: "candidate",status: "confirmed",targetDurationSeconds: 60,episodes: [],majorAdaptationProposals: [] } } }));
  const base = `${origin}/projects/p/chapters/c/script-content`;
  let version = { id: "script",status: "candidate",jobId: "generation",projectId: "p",chapterId: "c",sourceVersionId: "s",planVersionId: "plan",generationStatus: "succeeded",scenes: [{ id: "scene",episodeId: "e",ordinal: 1,title: "庭院" }],elements: [{ id: "action",sceneId: "scene",elementType: "action",ordinal: 1,text: "雨打庭院",lockedAt: undefined as string | undefined,provenance: [{ type: "source_fragment",fragmentId: "f",transformation: "retained" }] }],failures: [] };
  let qualityPosts = 0,publishPosts = 0,qualityRequest = "",publicationRequest = "";
  const task = { id: "quality-task",state: "queued",reason: null,projectId: "p",chapterId: "c",input: { resultType: "scriptQuality",qualityTarget: { candidateVersionId: "script" } } };
  const report = { id: task.id,candidateVersionId: "script",ruleVersion: "script-quality/1",passed: mode !== "failed",coverage: mode === "failed" ? 0.8 : 1,reasons: mode === "failed" ? ["LOW_EVENT_COVERAGE"] : [],assessment: { episodes: [{ episodeId: "e",estimatedSeconds: 60 }] } };
  await page.route(base,r => r.fulfill({ headers,json: { current: true,permissions: { canEdit: mode !== "editor",canSuggest: true,canDecide: mode !== "editor" },sourceFragments: [{ id: "f",text: "雨落" }],version } }));
  await page.route(`${base}/quality`,r => {
    if (r.request().method() === "OPTIONS") return r.fulfill({ headers,status: 204 });
    const input = r.request().postDataJSON();qualityPosts++;expect(Object.keys(input).sort()).toEqual(["configurationVersionId","expectedActiveVersionId","modelId","requestId"]);
    expect(input.expectedActiveVersionId).toBe("script");if (qualityRequest) expect(input.requestId).toBe(qualityRequest);else qualityRequest = input.requestId;
    if (mode === "unknown-submit" && qualityPosts === 1) return r.fulfill({ headers,status: 503,json: { code: "STORAGE_UNAVAILABLE" } });return r.fulfill({ headers,json: task });
  });
  await page.route(`${base}/quality/quality-task`,r => { if (mode === "stale") version = { ...version,id: "newer-script" };return r.fulfill({ headers,json: { task: { ...task,state: "succeeded" },report } }); });
  await page.route(`${base}/versions/*/impacts`,r => r.fulfill({ headers,json: { versionId: version.id,impacts: [{ confirmed_version_id: version.id,source_element_id: "action",target_stage: "storyboard",target_item_id: "shot-1",status: "unreviewed" }] } }));
  await page.route(`${base}/publication`,r => {
    if (r.request().method() === "OPTIONS") return r.fulfill({ headers,status: 204 });
    publishPosts++;const input = r.request().postDataJSON();expect(input.reason).toBe("已核对质量与原文");
    if (input.kind === "confirm") {
      if (publicationRequest) expect(input.requestId).toBe(publicationRequest);else publicationRequest = input.requestId;
      if (mode === "conflict") { version = { ...version,id: "newer-script" };return r.fulfill({ headers,status: 409,json: { code: "VERSION_CONFLICT" } }); }
      version = { ...version,id: "formal",status: "confirmed" };if (mode === "unknown-confirm" && publishPosts === 1) return r.fulfill({ headers,status: 503,json: { code: "STORAGE_UNAVAILABLE" } });
    } else { expect(input.elementIds).toEqual(["action"]);version = { ...version,id: "locked",elements: version.elements.map(e => ({ ...e,lockedAt: "2026-11-02" })) }; }return r.fulfill({ headers,json: version });
  });
  await page.getByRole("button",{ name: "进入审核",exact: true }).click();await page.getByRole("button",{ name: "读取拆集方案",exact: true }).click();
  const panel = page.getByRole("region",{ name: "剧本候选生成与追溯" }),quality = page.getByRole("region",{ name: "剧本质量与确认" });await panel.getByRole("button",{ name: "读取当前剧本",exact: true }).click();
  if (mode === "editor") { await expect(quality.getByRole("button",{ name: "确认正式剧本" })).toHaveCount(0);await expect(quality.getByRole("button",{ name: "评估当前剧本" })).toHaveCount(0);return; }
  await quality.getByRole("button",{ name: "读取质量模型" }).click();await quality.getByRole("combobox",{ name: "质量评估模型" }).selectOption("model");await quality.getByRole("button",{ name: "评估当前剧本" }).click();
  async function reloadReview() { await page.reload();await login(page);const story = page.getByRole("region",{ name: "故事知识任务" });await story.getByLabel("任务编号").fill("task");await story.getByRole("button",{ name: "读取任务",exact: true }).click();await page.getByRole("button",{ name: "进入审核",exact: true }).click(); }
  if (mode === "unknown-submit") { await reloadReview();await quality.getByRole("button",{ name: "核对质量原提交" }).click(); }
  await quality.getByRole("button",{ name: "读取质量报告" }).click();await quality.getByLabel("正式操作理由").fill("已核对质量与原文");
  if (mode === "failed") { await expect(quality.getByText("阻断原因：核心事件覆盖率低于 90%")).toBeVisible();await expect(quality.getByRole("button",{ name: "确认正式剧本" })).toBeDisabled();expect(publishPosts).toBe(0);return; }
  if (mode === "stale") { await panel.getByRole("button",{ name: "读取当前剧本",exact: true }).click();await expect(quality.getByText("报告已过期，请评估当前候选。")).toBeVisible();await expect(quality.getByRole("button",{ name: "确认正式剧本" })).toBeDisabled();return; }
  await quality.getByRole("button",{ name: "确认正式剧本" }).click();
  if (mode === "conflict") { await expect(quality.getByText("正式操作被拒绝，请读取当前剧本后重新核对。")).toBeVisible();await panel.getByRole("button",{ name: "读取当前剧本",exact: true }).click();await expect(quality.getByRole("button",{ name: "读取质量模型" })).toBeEnabled();await expect(quality.getByRole("button",{ name: "核对正式原操作" })).toHaveCount(0);return; }
  if (mode === "unknown-confirm") { expect(decodeURIComponent(page.url())).not.toContain("已核对质量与原文");await reloadReview();await quality.getByRole("button",{ name: "核对正式原操作" }).click(); }
  if (mode === "success") {
    const writesBeforeSwitch = publishPosts;
    await page.getByRole("button",{ name: "分镜",exact: true }).click();await page.getByRole("button",{ name: "追溯",exact: true }).click();await page.getByRole("button",{ name: "审核",exact: true }).click();
    await expect(quality.getByText("剧本状态：正式",{ exact: true })).toBeVisible();expect(publishPosts).toBe(writesBeforeSwitch);
  }
  await expect(quality.getByText("剧本状态：正式",{ exact: true })).toBeVisible();await expect(panel.getByRole("button",{ name: "保存候选修改" })).toHaveCount(0);
  await panel.getByRole("button",{ name: "雨打庭院",exact: true }).click();await quality.getByLabel("正式操作理由").fill("已核对质量与原文");await quality.getByRole("button",{ name: "锁定当前元素" }).click();
  await expect(panel.getByRole("button",{ name: "雨打庭院 · 已锁定",exact: true })).toBeVisible();await panel.getByRole("button",{ name: "读取修订影响范围" }).click();await expect(panel.getByLabel("修订受影响项").getByText(/shot-1/)).toBeVisible();await reloadReview();await expect(panel.getByRole("button",{ name: "雨打庭院 · 已锁定",exact: true })).toBeVisible();await panel.getByRole("button",{ name: "雨打庭院 · 已锁定",exact: true }).click();await expect(panel.getByLabel("剧本原文依据").getByText("雨落",{ exact: true })).toBeVisible();
  if (mode === "mobile") { await page.setViewportSize({ width: 390,height: 844 });await expect(quality.getByRole("button",{ name: "锁定当前元素" })).toBeHidden(); }
  expect(qualityPosts).toBe(mode === "unknown-submit" ? 2 : 1);expect(publishPosts).toBe(mode === "unknown-confirm" ? 3 : 2);
});

for (const mode of ["success","unknown"]) test(`正式修订浏览器闭环：${mode}`,async ({ page }) => {
  await setup(page);
  const headers = { "access-control-allow-origin": "*","access-control-allow-headers": "authorization,content-type","access-control-allow-methods": "GET,POST,OPTIONS" };
  const chapter = { id: "c",title: "雨落",activeSourceVersionId: "s",versions: [{ id: "s",ordinal: 1,text: "雨落",fragments: [{ id: "f",ordinal: 1,text: "雨落" }] }] };
  await page.route(`${origin}/projects/p/chapters/c/context`,r => r.fulfill({ headers,json: { project: { id: "p",title: "作品",role: mode === "editor" ? "editor" : "owner" },chapter } }));
  await page.route(`${origin}/projects/p/chapters/c`,r => r.fulfill({ headers,json: chapter }));
  await page.route(`${origin}/projects/p/chapters/c/story-knowledge`,r => r.fulfill({ headers,json: { id: "candidate",extractionJobId: "task",projectId: "p",chapterId: "c",sourceVersionId: "s",status: "confirmed",extractionStatus: "succeeded",facts: [],failures: [] } }));
  await page.route(`${origin}/projects/p/chapters/c/episode-plan`,r => r.fulfill({ headers,json: { current: true,canReview: false,sourceFragments: [],coreEvents: [],plan: { id: "plan",projectId: "p",chapterId: "c",sourceVersionId: "s",storyBibleVersionId: "candidate",status: "confirmed",targetDurationSeconds: 60,episodes: [],majorAdaptationProposals: [] } } }));

  const base = `${origin}/projects/p/chapters/c/script-content`;
  let version = { id: "formal",status: "confirmed",projectId: "p",chapterId: "c",sourceVersionId: "s",planVersionId: "plan",jobId: "generation",generationStatus: "succeeded",scenes: [{ id: "scene",title: "庭院" }],elements: [{ id: "action",sceneId: "scene",text: "雨打庭院",elementType: "action",lockedAt: "2026-11-02" as string | undefined,provenance: [{ type: "source_fragment",fragmentId: "f" }] }],suggestions: [] as Array<{ id: string;text: string;reason: string;status: string;submittedBy: string }>,failures: [] };
  let formal = version,posts = 0,unknownRequest = "";
  await page.route(base,r => r.fulfill({ headers,json: { current: true,permissions: { canEdit: true,canSuggest: true,canDecide: true },sourceFragments: [{ id: "f",text: "雨落" }],version } }));
  await page.route(`${base}/versions/confirmed`,r => r.fulfill({ headers,json: { version: formal } }));
  await page.route(`${base}/revision`,r => {
    if (r.request().method() === "OPTIONS") return r.fulfill({ headers,status: 204 });
    const input = r.request().postDataJSON();posts++;
    if (input.kind === "unlock") { version = { ...version,id: "unlocked",elements: version.elements.map(e => ({ ...e,lockedAt: undefined })) };formal = version; }
    if (input.kind === "suggest") {
      if (unknownRequest) expect(input.requestId).toBe(unknownRequest);else unknownRequest = input.requestId;
      version = { ...version,id: "proposed",suggestions: [{ id: "suggestion",text: input.text,reason: input.reason,status: "pending",submittedBy: "owner" }] };formal = version;
      if (mode === "unknown" && posts === 2) return r.fulfill({ headers,status: 503,json: { code: "STORAGE_UNAVAILABLE" } });
    }
    if (input.kind === "decide") version = { ...version,id: "revision-candidate",status: "candidate",elements: version.elements.map(e => ({ ...e,text: "修订后的雨落" })),suggestions: version.suggestions.map(s => ({ ...s,status: "accepted" })) };
    return r.fulfill({ headers,json: version });
  });
  await page.getByRole("button",{ name: "进入审核",exact: true }).click();await page.getByRole("button",{ name: "读取拆集方案",exact: true }).click();
  const panel = page.getByRole("region",{ name: "剧本候选生成与追溯" }),revision = page.getByRole("region",{ name: "正式剧本修订" });
  await panel.getByRole("button",{ name: "读取当前剧本",exact: true }).click();await panel.getByRole("button",{ name: "雨打庭院 · 已锁定",exact: true }).click();
  await revision.getByLabel("正式修订理由").fill("动作节奏");await revision.getByRole("button",{ name: "明确解锁当前元素" }).click();
  await revision.getByLabel("正式修订理由").fill("动作节奏");await revision.getByLabel("正式修订建议",{ exact: true }).fill("修订后的雨落");await revision.getByRole("button",{ name: "提交正式修订建议" }).click();
  if (mode === "unknown") {
    expect(decodeURIComponent(page.url())).not.toContain("修订后的雨落");await page.reload();await login(page);
    const story = page.getByRole("region",{ name: "故事知识任务" });await story.getByLabel("任务编号").fill("task");await story.getByRole("button",{ name: "读取任务",exact: true }).click();await page.getByRole("button",{ name: "进入审核",exact: true }).click();
    await revision.getByRole("button",{ name: "核对正式修订原操作" }).click();
  }
  await revision.getByLabel("正式修订理由").fill("符合原文");await revision.getByRole("button",{ name: "接受正式建议 suggestion" }).click();
  await expect(panel.getByRole("button",{ name: "修订后的雨落",exact: true })).toBeVisible();await revision.getByRole("button",{ name: "读取保留正式版" }).click();
  await expect(revision.getByRole("article",{ name: "保留正式剧本" }).getByText("雨打庭院",{ exact: true })).toBeVisible();
  expect(posts).toBe(mode === "unknown" ? 4 : 3);
});

for (const mode of ["success","uncertain","stale","mismatch","mobile"]) test(`设定生成显式加载与双向追溯：${mode}`,async ({ page }) => {
  await setup(page);
  if (mode === "mobile") await page.setViewportSize({ width: 390,height: 844 });
  const headers = { "access-control-allow-origin": "*","access-control-allow-headers": "authorization,content-type","access-control-allow-methods": "GET,POST,OPTIONS" };
  const chapter = { id: "c",title: "雨落",activeSourceVersionId: "s",versions: [{ id: "s",ordinal: 1,text: "雨落",fragments: [{ id: "f",ordinal: 1,text: "雨落" }] }] };
  await page.route(`${origin}/projects/p/chapters/c/context`,r => r.fulfill({ headers,json: { project: { id: "p",title: "作品",role: "owner" },chapter } }));
  await page.route(`${origin}/projects/p/chapters/c`,r => r.fulfill({ headers,json: chapter }));
  await page.route(`${origin}/projects/p/chapters/c/story-knowledge`,r => r.fulfill({ headers,json: { id: "candidate",extractionJobId: "task",projectId: "p",chapterId: "c",sourceVersionId: "s",status: "confirmed",extractionStatus: "succeeded",facts: [],failures: [] } }));
  await page.route(`${origin}/projects/p/chapters/c/episode-plan`,r => r.fulfill({ headers,json: { current: true,canReview: false,sourceFragments: [],coreEvents: [],plan: { id: "plan",projectId: "p",chapterId: "c",sourceVersionId: "s",storyBibleVersionId: "candidate",status: "confirmed",targetDurationSeconds: 60,episodes: [],majorAdaptationProposals: [] } } }));
  const script = { id: "formal",jobId: "script-task",projectId: "p",chapterId: "c",sourceVersionId: "s",planVersionId: "plan",status: "confirmed",generationStatus: "succeeded",scenes: [],elements: [{ id: "action",sceneId: "scene",elementType: "action",text: "雨点打湿庭院",provenance: [{ type: "source_fragment",sourceVersionId: "s",fragmentId: "f",transformation: "visualized" }] }],failures: [] };
  await page.route(`${origin}/projects/p/chapters/c/script-content`,r => r.fulfill({ headers,json: { current: true,version: script,sourceFragments: [{ id: "f",text: "雨落" }] } }));
  const task = { id: "settings-task",projectId: "p",chapterId: "c",input: { stage: "settings",resultType: "settingsContent",sourceVersionId: "s",upstreamConfirmedVersionIds: ["formal","plan","candidate"] },state: "succeeded",reason: null,result: { candidateVersionId: "setting",extractionStatus: "partially_succeeded" } };
  let posts = 0,requestId = "",loads = 0;
  await page.route(`${origin}/projects/p/chapters/c/settings-tasks**`,r => {
    if (r.request().method() === "OPTIONS") return r.fulfill({ headers,status: 204 });
    if (r.request().method() === "POST") {
      posts++;const body = r.request().postDataJSON();expect(Object.keys(body).sort()).toEqual(["configurationVersionId","modelId","requestId"]);
      if (requestId) expect(body.requestId).toBe(requestId);else requestId = body.requestId;
      if (mode === "uncertain" && posts === 1) return r.fulfill({ headers,status: 503,json: { code: "STORAGE_UNAVAILABLE" } });
      return r.fulfill({ headers,json: task });
    }
    return r.fulfill({ headers,json: r.request().url().includes("availability") ? { available: true,reason: null } : { tasks: [task],nextCursor: null } });
  });
  await page.route(`${origin}/settings-tasks/settings-task`,r => r.fulfill({ headers,json: task }));
  await page.route(`${origin}/projects/p/chapters/c/settings/generations/settings-task`,r => {
    loads++;return r.fulfill({ headers,json: { current: mode !== "stale",sourceFragments: [{ id: "f",text: "雨落" }],scriptVersion: script,version: { id: mode === "mismatch" ? "wrong-setting" : "setting",jobId: task.id,projectId: "p",chapterId: "c",sourceVersionId: "s",scriptVersionId: "formal",upstreamConfirmedVersionIds: task.input.upstreamConfirmedVersionIds,status: "candidate",generationStatus: "partially_succeeded",assets: [{ id: "location",assetType: "location",name: "雨中庭院设定",visibleDefinition: { weather: "细雨" },state: "雨中",stateChanges: ["地面湿润"],restrictions: ["保留庭院"],provenance: [{ type: "source_fragment",sourceVersionId: "s",fragmentId: "f",transformation: "visualized" }] }],failures: [{ scopeKey: "character",code: "INVALID_ASSET",retryable: true }] } } });
  });
  async function enter() {
    await page.getByRole("button",{ name: "进入审核",exact: true }).click();
    await page.getByRole("button",{ name: "读取拆集方案",exact: true }).click();
    await page.getByRole("button",{ name: "读取当前剧本",exact: true }).click();
  }
  await enter();const panel = page.getByRole("region",{ name: "设定候选生成与追溯" });
  await expect(panel).toBeVisible();
  if (mode === "mobile") {
    await expect(panel.getByRole("button",{ name: "生成文字设定",exact: true })).not.toBeVisible();
    await panel.getByRole("button",{ name: "刷新设定任务",exact: true }).click();
    await panel.getByRole("button",{ name: "settings-task · succeeded",exact: true }).click();
  } else {
    await panel.getByRole("button",{ name: "读取设定模型",exact: true }).click();await panel.getByLabel("设定模型",{ exact: true }).selectOption("model");
    await panel.getByRole("button",{ name: "生成文字设定",exact: true }).click();
  }
  if (mode === "uncertain") {
    await expect(panel.getByRole("status")).toContainText("提交尚未确认");
    await expect(panel.getByLabel("设定模型",{ exact: true })).toBeDisabled();
    await page.reload();await login(page);
    const story = page.getByRole("region",{ name: "故事知识任务" });await story.getByLabel("任务编号").fill("task");await story.getByRole("button",{ name: "读取任务",exact: true }).click();
    await enter();await panel.getByRole("button",{ name: "核对设定原提交",exact: true }).click();
  }
  await expect(panel.getByRole("button",{ name: "载入设定候选",exact: true })).toBeEnabled();expect(loads).toBe(0);
  await panel.getByRole("button",{ name: "载入设定候选",exact: true }).click();
  if (mode === "mismatch") { await expect(panel.getByText("结果身份不一致，请重新核对。",{ exact: true })).toBeVisible();await expect(panel.getByRole("button",{ name: "雨中庭院设定",exact: true })).toHaveCount(0);return; }
  await panel.getByRole("button",{ name: "雨中庭院设定",exact: true }).click();
  await expect(panel.getByLabel("设定原文依据")).toContainText("雨落");await expect(panel.getByLabel("设定剧本依据")).toContainText("雨点打湿庭院");
  await expect(panel.getByText("失败范围 character · INVALID_ASSET",{ exact: true })).toBeVisible();
  if (mode === "stale") await expect(panel.getByText("上游已变化，此候选仅供历史追溯。",{ exact: true })).toBeVisible();
  expect(posts).toBe(mode === "mobile" ? 0 : mode === "uncertain" ? 2 : 1);
});

for (const mode of ["owner","editor","reviewer","unknown","conflict","stale","mobile","read-failure","definition","impact","impact-parent"]) test(`文字设定单项审核与正式修订：${mode}`,async ({ page }) => {
  const impacted = mode === "impact" || mode === "impact-parent";
  await setup(page, null, false, mode === "cross-source" ? "new-source" : "s");if (mode === "mobile") await page.setViewportSize({ width: 390,height: 844 });
  const headers = { "access-control-allow-origin": "*","access-control-allow-headers": "authorization,content-type","access-control-allow-methods": "GET,POST,OPTIONS" };
  const chapter = { id: "c",title: "雨落",activeSourceVersionId: "s",versions: [{ id: "s",ordinal: 1,text: "雨落",fragments: [{ id: "f",ordinal: 1,text: "雨落" }] }] };
  await page.route(`${origin}/projects/p/chapters/c/context`,r => r.fulfill({ headers,json: { project: { id: "p",title: "作品",role: mode === "editor" ? "editor" : "owner" },chapter } }));
  await page.route(`${origin}/projects/p/chapters/c`,r => r.fulfill({ headers,json: chapter }));
  await page.route(`${origin}/projects/p/chapters/c/story-knowledge`,r => r.fulfill({ headers,json: { id: "candidate",extractionJobId: "task",projectId: "p",chapterId: "c",sourceVersionId: "s",status: "confirmed",extractionStatus: "succeeded",facts: [],failures: [] } }));
  await page.route(`${origin}/projects/p/chapters/c/episode-plan`,r => r.fulfill({ headers,json: { current: true,canReview: false,sourceFragments: [],coreEvents: [],plan: { id: "plan",projectId: "p",chapterId: "c",sourceVersionId: "s",storyBibleVersionId: "candidate",status: "confirmed",targetDurationSeconds: 60,episodes: [],majorAdaptationProposals: [] } } }));
  const script = { id: "formal",jobId: "script-task",projectId: "p",chapterId: "c",sourceVersionId: "s",planVersionId: "plan",status: "confirmed",generationStatus: "succeeded",scenes: [],elements: [{ id: "action",sceneId: "scene",elementType: "action",text: "雨点打湿庭院",provenance: [{ type: "source_fragment",sourceVersionId: "s",fragmentId: "f",transformation: "visualized" }] }],failures: [] };
  await page.route(`${origin}/projects/p/chapters/c/script-content`,r => r.fulfill({ headers,json: { current: mode !== "impact-parent",version: mode === "impact" ? { ...script,id: "new-formal" } : script,sourceFragments: [{ id: "f",text: "雨落" }] } }));
  type Version = import("../src/lib/api").SettingsView["version"];
  let version: Version = { id: "setting",jobId: "settings-task",projectId: "p",chapterId: "c",sourceVersionId: "s",scriptVersionId: "formal",upstreamConfirmedVersionIds: ["formal","plan","candidate"],status: "candidate",generationStatus: "succeeded",assets: [{ id: "location",assetType: "location",name: "庭院",visibleDefinition: { weather: "细雨" },state: "雨中",stateChanges: [],restrictions: [],provenance: [{ type: "source_fragment",sourceVersionId: "s",fragmentId: "f",transformation: "visualized" }] }],failures: [],suggestions: [],locks: {} };
  if (impacted) { version.status = "confirmed";version.locks = { location: { lockedBy: "owner",lockedAt: "2026-11-04" } }; }
  let formal: Version | null = null,posts = 0,readFailed = false;
  const operations = new Map<string,Version>(),base = `${origin}/projects/p/chapters/c/settings`;
  await page.route(base,r => {
    if (mode === "read-failure" && posts === 1 && !readFailed) { readFailed = true;return r.fulfill({ headers,status: 403,json: { code: "FORBIDDEN" } }); }
    return r.fulfill({ headers,json: { current: mode !== "stale" && !impacted,active: true,impacts: impacted ? [{ confirmed_version_id: "new-formal",source_version_id: "formal",source_element_id: "action",target_stage: "settings",target_version_id: "setting",target_item_id: "location",status: "unreviewed" }] : null,permissions: { canEdit: mode !== "editor" && version.status === "candidate",canSuggest: true,canDecide: mode !== "editor",canConfirm: mode !== "editor" && version.status === "candidate",canLock: mode !== "editor" && version.status === "confirmed" },version,scriptVersion: script,sourceFragments: [{ id: "f",text: "雨落" }] } }); });
  await page.route(`${base}/versions/confirmed`,r => r.fulfill({ headers,status: formal ? 200 : 404,json: formal ? { version: formal } : { code: "NOT_FOUND" } }));
  await page.route(`${base}/operations/*`,r => { const saved = operations.get(decodeURIComponent(new URL(r.request().url()).pathname.split("/").at(-1)!));return r.fulfill({ headers,status: saved ? 200 : 404,json: saved ? { version: saved } : { code: "NOT_FOUND" } }); });
  await page.route(`${base}/review`,r => {
    if (r.request().method() === "OPTIONS") return r.fulfill({ headers,status: 204 });
    const command = r.request().postDataJSON();posts++;
    if (mode === "conflict") return r.fulfill({ headers,status: 409,json: { code: "VERSION_CONFLICT" } });
    expect(command.expectedActiveVersionId).toBe(version.id);expect(command.reason).toBeTruthy();
    const old = version;
    version = structuredClone({ ...version,id: `setting-${posts}`,parentVersionId: old.id,operation: { ...command,targetId: command.assetId ?? command.suggestionId ?? old.id } });
    if (command.kind === "edit") version.assets = [command.value];
    if (command.kind === "suggest") version.suggestions = [...version.suggestions!,{ id: `suggestion-${posts}`,assetId: "location",value: command.value,reason: command.reason,status: "pending",submittedBy: mode === "editor" ? "editor" : "owner" }];
    if (command.kind === "decide") {
      const suggestion = version.suggestions!.find(s => s.id === command.suggestionId)!;
      suggestion.status = command.decision;
      if (command.decision === "accepted") { version.assets = [suggestion.value];version.status = "candidate"; }
    }
    if (command.kind === "confirm") version.status = "confirmed";
    if (command.kind === "lock") version.locks = { location: { lockedBy: "owner",lockedAt: "2026-11-04" } };
    if (command.kind === "unlock") version.locks = {};
    if (version.status === "confirmed") formal = structuredClone(version);
    operations.set(command.requestId,structuredClone(version));
    if (mode === "unknown" && posts === 1) return r.fulfill({ headers,status: 503,json: { code: "STORAGE_UNAVAILABLE" } });
    return r.fulfill({ headers,json: version });
  });
  async function enter() { await page.getByRole("button",{ name: "进入审核",exact: true }).click();await page.getByRole("button",{ name: "读取拆集方案",exact: true }).click();await page.getByRole("button",{ name: "读取当前剧本",exact: true }).click(); }
  await enter();const workbench = page.getByRole("region",{ name: "设定候选生成与追溯" });
  await workbench.getByRole("button",{ name: "读取当前设定",exact: true }).click();await workbench.getByRole("button",{ name: "庭院",exact: true }).click();
  const review = page.getByRole("region",{ name: "文字设定审核" });
  if (impacted) { const impact = workbench.getByLabel("设定上游影响");await expect(impact).toContainText("新确认剧本 new-formal");await expect(impact).toContainText("已锁定，替换前需明确解锁");await expect(workbench.getByLabel("设定剧本依据")).toContainText("正式剧本依据 · formal");await expect(review.getByRole("button",{ name: "明确解锁当前设定",exact: true })).toBeDisabled();await expect(workbench.getByRole("button",{ name: "提交设定局部重生",exact: true })).not.toBeVisible();expect(posts).toBe(0);return; }
  if (["stale","mobile"].includes(mode)) {
    if (mode === "mobile") await expect(review.getByRole("button",{ name: "确认文字设定",exact: true })).not.toBeVisible();
    else await expect(review.getByRole("button",{ name: "确认文字设定",exact: true })).toBeDisabled();
    await expect(workbench.getByLabel("设定原文依据")).toContainText("雨落");expect(posts).toBe(0);return;
  }
  if (mode === "definition") {
    await review.getByLabel("可见特征 weather").fill("雪覆盖地面");await review.getByLabel("设定操作理由",{ exact: true }).fill("核对可见定义");
    await review.getByRole("button",{ name: "提交设定建议",exact: true }).click();
    await review.getByText("查看建议内容 suggestion-1",{ exact: true }).click();await expect(review.getByText("雪覆盖地面",{ exact: true })).toBeVisible();
    await review.getByLabel("设定操作理由",{ exact: true }).fill("核对采纳");await review.getByRole("button",{ name: "接受设定建议 suggestion-1",exact: true }).click();
    await expect(workbench.getByLabel("文字设定内容")).toContainText("雪覆盖地面");expect(posts).toBe(2);return;
  }
  await review.getByLabel("设定名称",{ exact: true }).fill("修改后的庭院");await review.getByLabel("设定操作理由",{ exact: true }).fill("可见特征");
  if (mode === "editor") {
    await expect(review.getByRole("button",{ name: "保存设定修改",exact: true })).toHaveCount(0);
    await review.getByRole("button",{ name: "提交设定建议",exact: true }).click();await expect(review.getByText("pending",{ exact: false })).toBeVisible();expect(posts).toBe(1);return;
  }
  await review.getByRole("button",{ name: "保存设定修改",exact: true }).click();
  if (mode === "conflict") { await expect(review.getByRole("status")).toContainText("操作被拒绝");expect(posts).toBe(1);return; }
  if (mode === "read-failure") {
    await expect(review.getByRole("status")).toContainText("操作已保存");
    await review.getByRole("button",{ name: "核对设定原操作",exact: true }).click();await expect(review.getByRole("status")).toContainText("原操作已核对");expect(posts).toBe(1);
  }
  if (mode === "unknown") {
    await expect(review.getByRole("status")).toContainText("操作结果未知");expect(decodeURIComponent(page.url())).not.toContain("修改后的庭院");
    await expect(page.getByRole("region",{ name: "文字设定局部重生" }).getByRole("button",{ name: "提交设定局部重生",exact: true })).toBeDisabled();
    await page.reload();await login(page);const story = page.getByRole("region",{ name: "故事知识任务" });await story.getByLabel("任务编号").fill("task");await story.getByRole("button",{ name: "读取任务",exact: true }).click();await enter();
    await review.getByRole("button",{ name: "核对设定原操作",exact: true }).click();await expect(review.getByRole("status")).toContainText("原操作已核对");expect(posts).toBe(1);
  }
  await review.getByLabel("设定操作理由",{ exact: true }).fill("核对完成");await review.getByRole("button",{ name: "确认文字设定",exact: true }).click();await expect(review.getByText("设定状态：正式",{ exact: true })).toBeVisible();
  await workbench.getByRole("button",{ name: "修改后的庭院",exact: true }).click();await review.getByLabel("设定操作理由",{ exact: true }).fill("冻结");await review.getByRole("button",{ name: "锁定当前设定",exact: true }).click();
  await expect(review.getByRole("button",{ name: "提交设定建议",exact: true })).toBeDisabled();
  await review.getByLabel("设定操作理由",{ exact: true }).fill("修订");await review.getByRole("button",{ name: "明确解锁当前设定",exact: true }).click();
  await review.getByLabel("设定名称",{ exact: true }).fill("修订候选庭院");await review.getByLabel("设定操作理由",{ exact: true }).fill("修订");await review.getByRole("button",{ name: "提交设定建议",exact: true }).click();
  const suggestionId = version.suggestions!.find(s => s.status === "pending")!.id;
  await review.getByLabel("设定操作理由",{ exact: true }).fill("采纳");await review.getByRole("button",{ name: `接受设定建议 ${suggestionId}`,exact: true }).click();await expect(review.getByText("设定状态：候选",{ exact: true })).toBeVisible();
  await review.getByRole("button",{ name: "读取保留正式设定",exact: true }).click();await expect(review.getByLabel("保留正式设定")).toContainText("修改后的庭院");
  await review.getByLabel("设定操作理由",{ exact: true }).fill("重新核对");await review.getByRole("button",{ name: "确认文字设定",exact: true }).click();await expect(review.getByText("设定状态：正式",{ exact: true })).toBeVisible();
  await review.getByRole("button",{ name: "读取保留正式设定",exact: true }).click();await expect(review.getByLabel("保留正式设定")).toContainText("修订候选庭院");
});

for (const mode of ["success","unknown","missing","mismatch","failure","locked","editor","stale","mobile","storage","execution-unknown","stopped","pending","overlap","dual-pending","corrupt","reconciliation","advanced","advanced-missing"]) test(`文字设定局部重生与提交恢复：${mode}`,async ({ page }) => {
  let advanced = false;
  const reconciliation = mode === "reconciliation";
  await setup(page);if (mode === "mobile") await page.setViewportSize({ width: 390,height: 844 });
  const headers = { "access-control-allow-origin": "*","access-control-allow-headers": "authorization,content-type","access-control-allow-methods": "GET,POST,OPTIONS" };
  const chapter = { id: "c",title: "雨落",activeSourceVersionId: "s",versions: [{ id: "s",ordinal: 1,text: "雨落",fragments: [{ id: "f",ordinal: 1,text: "雨落" }] }] };
  await page.route(`${origin}/projects/p/chapters/c/context`,r => r.fulfill({ headers,json: { project: { id: "p",title: "作品",role: mode === "editor" ? "editor" : "owner" },chapter } }));
  await page.route(`${origin}/projects/p/chapters/c`,r => r.fulfill({ headers,json: chapter }));
  await page.route(`${origin}/projects/p/chapters/c/story-knowledge`,r => r.fulfill({ headers,json: { id: "candidate",extractionJobId: "task",projectId: "p",chapterId: "c",sourceVersionId: "s",status: "confirmed",extractionStatus: "succeeded",facts: [],failures: [] } }));
  await page.route(`${origin}/projects/p/chapters/c/episode-plan`,r => r.fulfill({ headers,json: { current: true,canReview: false,sourceFragments: [],coreEvents: [],plan: { id: "plan",projectId: "p",chapterId: "c",sourceVersionId: "s",storyBibleVersionId: "candidate",status: "confirmed",targetDurationSeconds: 60,episodes: [],majorAdaptationProposals: [] } } }));
  const script = { id: "formal",jobId: "script-task",projectId: "p",chapterId: "c",sourceVersionId: "s",planVersionId: "plan",status: "confirmed",generationStatus: "succeeded",scenes: [],elements: [{ id: "action",sceneId: "scene",elementType: "action",text: "雨点打湿庭院",provenance: [{ type: "source_fragment",sourceVersionId: "s",fragmentId: "f",transformation: "visualized" }] }],failures: [] };
  await page.route(`${origin}/projects/p/chapters/c/script-content`,r => r.fulfill({ headers,json: { current: true,version: advanced ? { ...script,id:"new-formal" } : script,sourceFragments: [{ id: "f",text: "雨落" }] } }));

  type View = import("../src/lib/api").SettingsView;
  const asset = { id: "location",assetType: "location",name: "庭院",visibleDefinition: { weather: "细雨" },state: "雨中",stateChanges: [],restrictions: [],provenance: [{ type: "source_fragment",sourceVersionId: "s",fragmentId: "f",transformation: "visualized" }] };
  const formal: View["version"] = { id: "setting",jobId: "initial",projectId: "p",chapterId: "c",sourceVersionId: "s",scriptVersionId: "formal",upstreamConfirmedVersionIds: ["formal","plan","candidate"],status: mode === "failure" || mode === "overlap" ? "candidate" : "confirmed",generationStatus: mode === "failure" || mode === "overlap" ? "partially_succeeded" : "succeeded",assets: [asset,{ ...asset,id: "untouched",name: "不变道具",assetType: "prop" }],failures: mode === "overlap" ? [{ scopeKey: "replace-location",assetId: "location",code: "PROVIDER_ITEM_FAILED",retryable: true }] : mode === "failure" ? [{ scopeKey: "missing-character",code: "PROVIDER_ITEM_FAILED",retryable: true }] : [],locks: mode === "locked" ? { location: { lockedBy: "owner",lockedAt: "2026-11-04" } } : {},suggestions: mode === "pending" ? [{ id: "suggestion",assetId: "location",value: asset,reason: "pending",status: "pending",submittedBy: "editor" }] : [] };
  const initial = reconciliation ? { ...formal,status:"candidate" as const,assets:[formal.assets[1]!],reconciliation:{ originVersionId:"old-setting",pendingAssets:[asset],pendingFailureScopeKeys:[] } } : formal;
  let version = structuredClone(initial),posts = 0,loads = 0,requestId = "";
  let task: import("../src/lib/api").SettingsRegenerationTask | null = null;
  const base = `${origin}/projects/p/chapters/c/settings`,tasks = `${origin}/projects/p/chapters/c/settings-regeneration-tasks`;
  const response = (v = version): View => ({ version: v,current: mode !== "stale",active: true,permissions: { canEdit: mode !== "editor" && v.status === "candidate",canSuggest: true,canDecide: mode !== "editor",canConfirm: mode !== "editor" && v.status === "candidate",canLock: mode !== "editor" && v.status === "confirmed" },scriptVersion: script,sourceFragments: [{ id: "f",text: "雨落" }] });
  await page.route(base,r => r.fulfill({ headers,json: advanced ? {
    ...response(),version:{ ...formal,id:"new-head",scriptVersionId:"new-formal",upstreamConfirmedVersionIds:["new-formal","plan","candidate"] },
    scriptVersion:{ ...script,id:"new-formal" },
  } : response() }));
  await page.route(`${base}/versions/confirmed`,r => r.fulfill({ headers,json: { version: { ...formal,status: "confirmed",generationStatus: "succeeded",failures: [] } } }));
  await page.route(`${base}/versions/setting`,r => r.fulfill({ headers,json: { version: formal } }));
  await page.route(`${base}/versions/setting/impacts`,r => r.fulfill({ headers,json: { versionId: "setting",impacts: [] } }));
  await page.route(`${tasks}/availability`,r => r.fulfill({ headers,json: { available: true,reason: null } }));
  await page.route(`${tasks}/submissions/*`,r => r.fulfill({ headers,status: task ? 200 : 404,json: task ?? { code: "TASK_NOT_FOUND" } }));
  await page.route(tasks,r => {
    if (r.request().method()==="OPTIONS") return r.fulfill({ headers,status: 204 });
    const body = r.request().postDataJSON();posts++;
    if (requestId) expect(body.requestId).toBe(requestId);else requestId = body.requestId;
    expect(Object.keys(body).sort()).toEqual(["configurationVersionId","modelId","requestId","selection"]);
    expect(body.selection.expectedActiveVersionId).toBe("setting");expect(body.selection.assetIds).toEqual(mode === "failure" ? [] : ["location"]);
    expect(body.selection.failureScopeKeys).toEqual(mode === "failure" ? ["missing-character"] : []);
    if (["missing","advanced-missing"].includes(mode) && posts===1) return r.fulfill({ headers,status: 503,json: { code: "STORAGE_UNAVAILABLE" } });
    version = { ...initial,id: "regenerated",status: "candidate",parentVersionId: formal.id,operation: { requestId: "operation",kind: "regenerate",targetId: formal.id,reason: body.selection.reason },regeneration: { jobId: "regen-task",assetIds: body.selection.assetIds,failureScopeKeys: body.selection.failureScopeKeys,reason: body.selection.reason,outcome: "succeeded" },assets: mode === "failure" ? [...formal.assets,{ ...asset,id: "character",name: "新人物",assetType: "character" }] : reconciliation ? [formal.assets[1]!,{ ...asset,name:"重生庭院" }] : [{ ...asset,name: "重生庭院" },formal.assets[1]!],failures: [] };
    if (reconciliation) version.reconciliation!.pendingAssets = [];
    task = { id: "regen-task",projectId: "p",chapterId: "c",state: "succeeded",reason: null,result: { candidateVersionId: "regenerated",extractionStatus: "succeeded" },input: { stage: "settings",resultType: "settingsRegeneration",sourceVersionId: "s",upstreamConfirmedVersionIds: ["formal","plan","candidate"],regeneration: body.selection } };
    if (["execution-unknown","stopped"].includes(mode)) { version = structuredClone(formal);task.state = mode === "stopped" ? "failed" : "paused";task.reason = mode === "stopped" ? "INVALID_RESPONSE" : "EXECUTION_UNCERTAIN";task.result = null; }
    return r.fulfill({ headers,status: ["unknown","dual-pending","reconciliation","advanced","advanced-missing"].includes(mode) && posts===1 ? 503 : 201,json: ["unknown","dual-pending","reconciliation","advanced","advanced-missing"].includes(mode) && posts===1 ? { code: "STORAGE_UNAVAILABLE" } : task });
  });
  await page.route(`${base}/review`,r => {
    if (r.request().method()==="OPTIONS") return r.fulfill({ headers,status:204 });
    const command = r.request().postDataJSON();
    expect(command.kind).toBe("confirm");
    expect(command.expectedActiveVersionId).toBe("regenerated");
    expect(version.reconciliation?.pendingAssets).toEqual([]);
    version = { ...version,id:"confirmed-regeneration",status:"confirmed",parentVersionId:"regenerated",operation:{ requestId:command.requestId,kind:"confirm",targetId:"regenerated",reason:command.reason } };
    return r.fulfill({ headers,json:version });
  });
  await page.route(`${base}/regenerations/*`,r => { loads++;return r.fulfill({ headers,json: response(mode === "mismatch" ? { ...version,parentVersionId: "wrong-base" } : version) }); });
  async function enter() { await page.getByRole("button",{ name: "进入审核",exact: true }).click();await page.getByRole("button",{ name: "读取拆集方案",exact: true }).click();await page.getByRole("button",{ name: "读取当前剧本",exact: true }).click(); }
  await enter();const workbench = page.getByRole("region",{ name: "设定候选生成与追溯" });
  if (mode === "corrupt") await page.evaluate(() => sessionStorage.setItem(JSON.stringify(["settings-regeneration",JSON.stringify(["p","c","s","formal","plan","candidate"])]),"{invalid"));
  await workbench.getByRole("button",{ name: "读取当前设定",exact: true }).click();
  const panel = page.getByRole("region",{ name: "文字设定局部重生" });
  if (mode === "corrupt") { await expect(panel.getByRole("status")).toContainText("暂停新的重生操作");await expect(panel.getByRole("button",{ name: "提交设定局部重生",exact: true })).not.toBeVisible();expect(posts).toBe(0);return; }
  if (["editor","stale","mobile"].includes(mode)) { await expect(panel.getByRole("button",{ name: "提交设定局部重生",exact: true })).not.toBeVisible();expect(posts).toBe(0);return; }
  if (mode === "locked" || mode === "pending") { await expect(panel.getByLabel("重生资产 庭院",{ exact: true })).toBeDisabled();expect(posts).toBe(0);return; }
  if (mode === "failure") await panel.getByLabel("重试设定失败 missing-character",{ exact: true }).check();else await panel.getByLabel(reconciliation ? "重生待核对资产 庭院" : "重生资产 庭院",{ exact: true }).check();
  if (reconciliation) await expect(panel.getByLabel("重生待核对资产 不变道具",{exact:true})).toHaveCount(0);
  if (mode === "overlap") { await expect(panel.getByLabel("重试设定失败 replace-location",{ exact: true })).toBeDisabled();expect(posts).toBe(0);return; }
  await panel.getByLabel("设定重生原因",{ exact: true }).fill("核对可见细节");
  await panel.getByRole("button",{ name: "读取重生模型",exact: true }).click();await panel.getByLabel("设定重生模型",{ exact: true }).selectOption("model");
  if (mode === "success") await panel.screenshot({ path: "/tmp/t07-settings-regeneration.png" });
  if (mode === "storage") await page.evaluate(() => { Storage.prototype.setItem = () => { throw new Error("storage unavailable"); }; });
  await panel.getByRole("button",{ name: "提交设定局部重生",exact: true }).click();
  if (mode === "storage") { await expect(panel.getByRole("status")).toContainText("尚未发送任务");expect(posts).toBe(0);return; }
  if (["execution-unknown","stopped"].includes(mode)) {
    await panel.getByRole("button",{ name: "核对设定重生原提交",exact: true }).click();
    await expect(panel.getByRole("button",{ name: "载入设定重生结果",exact: true })).toBeDisabled();
    if (mode === "execution-unknown") { await expect(panel.getByRole("status")).toContainText("结果待后台核对");await expect(panel.getByRole("button",{ name: "结束已停止的重生任务",exact: true })).toHaveCount(0); }
    else { await panel.getByRole("button",{ name: "结束已停止的重生任务",exact: true }).click();await expect(panel.getByRole("button",{ name: "提交设定局部重生",exact: true })).toBeEnabled(); }
    expect(posts).toBe(1);return;
  }
  if (["unknown","missing","dual-pending","reconciliation","advanced","advanced-missing"].includes(mode)) {
    await expect(panel.getByRole("status")).toContainText("尚未确认");expect(decodeURIComponent(page.url())).not.toContain("核对可见细节");
    if (mode === "dual-pending") await page.evaluate(() => sessionStorage.setItem(JSON.stringify(["settings-review",JSON.stringify(["p","c","s","formal","plan","candidate"])]),JSON.stringify({ kind: "lock",requestId: "other-operation",expectedActiveVersionId: "setting",assetId: "location",reason: "freeze" })));
    if (mode.startsWith("advanced")) advanced = true;
    await page.reload();await login(page);const story = page.getByRole("region",{ name: "故事知识任务" });await story.getByLabel("任务编号").fill("task");await story.getByRole("button",{ name: "读取任务",exact: true }).click();await enter();
    if (advanced) await workbench.getByRole("button",{name:"读取当前设定",exact:true}).click();
    await expect(panel.getByRole("button",{ name: "核对设定重生原提交",exact: true })).toBeVisible();expect(posts).toBe(1);expect(loads).toBe(0);
    if (mode === "dual-pending") {
      const review = page.getByRole("region",{ name: "文字设定审核" });
      await expect(review.getByRole("button",{ name: "核对设定原操作",exact: true })).toBeEnabled();
      await expect(review.getByRole("button",{ name: "重新发送设定原操作",exact: true })).toBeDisabled();
      await expect(panel.getByRole("button",{ name: "核对设定重生原提交",exact: true })).toBeEnabled();
      await panel.getByRole("button",{ name: "核对设定重生原提交",exact: true }).click();
      await expect(panel.getByRole("button",{ name: "载入设定重生结果",exact: true })).toBeEnabled();
      await review.getByRole("button",{ name: "核对设定原操作",exact: true }).click();
      await expect(review.getByRole("status")).toContainText("保留原请求");expect(posts).toBe(1);return;
    }
    await panel.getByRole("button",{ name: "核对设定重生原提交",exact: true }).click();
    if (mode === "advanced-missing") {
      await panel.getByRole("button",{name:"归档旧上游重生请求",exact:true}).click();
      await expect(panel.getByRole("button",{name:"读取重生模型",exact:true})).toBeEnabled();
      expect(posts).toBe(1);
      expect(await page.evaluate(() => !!sessionStorage.getItem(JSON.stringify(["settings-regeneration",JSON.stringify(["p","c","s","formal","plan","candidate"]),"archived"])))).toBe(true);
      return;
    }
    if (mode === "missing") await panel.getByRole("button",{ name: "重新发送设定重生原提交",exact: true }).click();
  }
  await expect(panel.getByRole("button",{ name: "载入设定重生结果",exact: true })).toBeEnabled();expect(loads).toBe(0);
  await expect(workbench.getByRole("button",{ name: "重生庭院",exact: true })).toHaveCount(0);
  await panel.getByRole("button",{ name: "载入设定重生结果",exact: true }).click();
  if (mode === "mismatch") { await expect(panel.getByRole("status")).toContainText("身份不一致");await expect(workbench.getByRole("button",{ name: "重生庭院",exact: true })).toHaveCount(0);return; }
  await expect(panel.getByRole("status")).toContainText(advanced ? "仅供历史追溯" : "已载入局部重生候选");
  await workbench.getByRole("button",{ name: mode === "failure" ? "新人物" : "重生庭院",exact: true }).click();
  await expect(workbench.getByLabel("设定原文依据")).toContainText("雨落");await expect(workbench.getByLabel("设定剧本依据")).toContainText("雨点打湿庭院");
  await expect(workbench.getByRole("button",{ name: "不变道具",exact: true })).toBeVisible();
  await workbench.getByRole("button",{ name: "读取保留正式设定",exact: true }).click();await expect(workbench.getByLabel("保留正式设定")).toContainText("庭院");
  if (reconciliation) {
    const review = page.getByRole("region",{name:"文字设定审核"});
    await review.getByLabel("设定操作理由",{exact:true}).fill("核对重生依据");
    await review.getByRole("button",{name:"确认文字设定",exact:true}).click();
    await expect(review.getByText("设定状态：正式",{exact:true})).toBeVisible();
  }
  expect(posts).toBe(mode === "missing" ? 2 : 1);
});

for (const mode of ["success","unknown","read-failure","conflict","editor","mobile","cross-source","missing-conflict","replay-read-404","advanced","advanced-read-404"]) test(`同源跨上游分批原样保留：${mode}`,async ({ page }) => {
  await setup(page, null, false, mode === "cross-source" ? "new-source" : "s");if (mode === "mobile") await page.setViewportSize({ width: 390,height: 844 });
  const headers = { "access-control-allow-origin": "*","access-control-allow-headers": "authorization,content-type","access-control-allow-methods": "GET,POST,OPTIONS" };
  let advanced = false,advancedReads = 0;
  const cross = mode === "cross-source";
  const currentSource = cross ? "new-source" : "s";
  const chapter = { id: "c",title: "雨落",activeSourceVersionId: currentSource,versions: [{ id: "s",ordinal: 1,text: "雨落",fragments: [{ id: "f",ordinal: 1,text: "雨落" }] }] };
  if (cross) chapter.versions.push({ id:currentSource,ordinal:2,text:"晴天",fragments:[{ id:"new-fragment",ordinal:1,text:"晴天" }] });
  await page.route(`${origin}/projects/p/chapters/c/context`,r => r.fulfill({ headers,json: { project: { id: "p",title: "作品",role: mode === "editor" ? "editor" : "owner" },chapter } }));
  await page.route(`${origin}/projects/p/chapters/c`,r => r.fulfill({ headers,json: chapter }));
  await page.route(`${origin}/projects/p/chapters/c/story-knowledge`,r => r.fulfill({ headers,json: { id: "candidate",extractionJobId: "task",projectId: "p",chapterId: "c",sourceVersionId: currentSource,status: "confirmed",extractionStatus: "succeeded",facts: [],failures: [] } }));
  await page.route(`${origin}/projects/p/chapters/c/episode-plan`,r => r.fulfill({ headers,json: { current: true,canReview: false,sourceFragments: [],coreEvents: [],plan: { id: "plan",projectId: "p",chapterId: "c",sourceVersionId: currentSource,storyBibleVersionId: "candidate",status: "confirmed",targetDurationSeconds: 60,episodes: [],majorAdaptationProposals: [] } } }));
  const script = { id: "formal",jobId: "script-task",projectId: "p",chapterId: "c",sourceVersionId: currentSource,planVersionId: "plan",status: "confirmed",generationStatus: "succeeded",scenes: [],elements: [{ id: "action",sceneId: "scene",elementType: "action",text: "雨点打湿庭院",provenance: [{ type: "source_fragment",sourceVersionId: currentSource,fragmentId: "f",transformation: "visualized" }] }],failures: [] };
  await page.route(`${origin}/projects/p/chapters/c/script-content`,r => r.fulfill({ headers,json: { current: mode !== "impact-parent",version: { ...script,id: advanced ? "latest-formal" : "new-formal" },sourceFragments: [{ id: "f",text: "雨落" }] } }));

  type Version = import("../src/lib/api").SettingsView["version"];
  const asset = { id: "location",assetType: "location",name: "庭院",visibleDefinition: { rain: true },state: "wet",stateChanges: [],restrictions: [],provenance: [{ type: "source_fragment",sourceVersionId: "s",fragmentId: "f",transformation: "retained" }] };
  const old: Version = { id: "old-setting",jobId: "initial",projectId: "p",chapterId: "c",sourceVersionId: "s",scriptVersionId: "formal",upstreamConfirmedVersionIds: ["formal","plan","candidate"],status: "confirmed",generationStatus: "succeeded",assets: [asset,{ ...asset,id: "prop",name: "道具" }],failures: [],locks: { location: { lockedBy: "owner",lockedAt: "2026-11-04" } },suggestions: [{ id: "old-suggestion",assetId: "prop",value: { ...asset,id: "prop",name: "旧建议" },reason: "old advice",status: "pending",submittedBy: "editor" }] };
  if (mode === "success") old.failures = [{ scopeKey:"unbound",code:"PROVIDER_ITEM_FAILED",retryable:false }];
  let version = structuredClone(old),formal = structuredClone(old),posts = 0,failedRead = false;
  const operations = new Map<string,Version>(),base = `${origin}/projects/p/chapters/c/settings`;
  await page.route(base,r => {
    if (mode === "advanced-read-404" && advanced && ++advancedReads === 2) return r.fulfill({ headers,status:404,json:{code:"NOT_FOUND"} });
    if (mode === "replay-read-404" && posts===2 && !failedRead) { failedRead = true;return r.fulfill({ headers,status: 404,json: { code: "NOT_FOUND" } }); }
    if (mode === "read-failure" && posts===1 && !failedRead) { failedRead = true;return r.fulfill({ headers,status: 503,json: { code: "STORAGE_UNAVAILABLE" } }); }
    const current = version.scriptVersionId === (advanced ? "latest-formal" : "new-formal"),reviewer = mode !== "editor";
    return r.fulfill({ headers,json: { version,current,active: true,impacts: [],permissions: { canEdit: current && reviewer && version.status === "candidate",canSuggest: current,canDecide: current && reviewer,canConfirm: current && reviewer && version.status === "candidate",canLock: current && reviewer && version.status === "confirmed" },scriptVersion: { ...script,id: version.scriptVersionId,sourceVersionId:version.sourceVersionId },sourceFragments: cross && current ? [{ id:"new-fragment",text:"晴天" }] : [{ id: "f",text: "雨落" }] } });
  });
  await page.route(`${base}/versions/confirmed`,r => r.fulfill({ headers,json: { version: formal } }));
  await page.route(`${base}/versions/old-setting`,r => r.fulfill({ headers,json: { version: old } }));
  await page.route(`${base}/versions/old-setting/impacts`,r => r.fulfill({ headers,json:{ versionId:old.id,impacts:[
    { confirmed_version_id:"new-formal",source_version_id:"formal",source_element_id:"action",target_stage:"settings",target_version_id:old.id,target_item_id:"location",status:"unreviewed" },
  ] } }));
  await page.route(`${base}/operations/*`,r => { const v = operations.get(new URL(r.request().url()).pathname.split("/").at(-1)!);return r.fulfill({ headers,status: v ? 200 : 404,json: v ? { version: v } : {} }); });
  await page.route(`${base}/reconciliation`,r => {
    if (r.request().method()==="OPTIONS") return r.fulfill({ headers,status: 204 });
    if (r.request().method()==="GET") return r.fulfill({ headers,json: { baseVersionId: version.id,sourceVersionId: mode === "cross-source" ? "new-source" : "s",upstreamConfirmedVersionIds: ["new-formal","plan","candidate"],sameSource: mode !== "cross-source",requiresReconciliation: version.scriptVersionId !== "new-formal",canBegin: mode !== "editor" && version.scriptVersionId !== "new-formal" } });
    const b = r.request().postDataJSON();posts++;expect(b.expectedUpstreamConfirmedVersionIds).toEqual(["new-formal","plan","candidate"]);expect(b.reason).toBeTruthy();
    if (mode === "missing-conflict") {
      expect(b.expectedActiveVersionId).toBe(old.id);
      if (posts===1) version = { ...old,id: "other-reviewer-head",status: "candidate",scriptVersionId: "new-formal",upstreamConfirmedVersionIds: b.expectedUpstreamConfirmedVersionIds,assets: [],suggestions: [],reconciliation: { originVersionId: old.id,pendingAssets: old.assets,pendingFailureScopeKeys: [] } };
      return r.fulfill({ headers,status: posts===1 ? 503 : 409,json: { code: posts===1 ? "STORAGE_UNAVAILABLE" : "VERSION_CONFLICT" } });
    }
    if (mode === "replay-read-404" && posts===2) return r.fulfill({ headers,status: 403,json: { code: "FORBIDDEN" } });
    expect(b.expectedActiveVersionId).toBe(version.id);
    if (mode === "conflict") return r.fulfill({ headers,status: 409,json: { code: "VERSION_CONFLICT" } });
    const previous = version;version = { ...structuredClone(previous),id: `reconciled-${posts}`,parentVersionId: previous.id,status: "candidate",operation: { requestId: b.requestId,kind: b.kind === "begin" ? "reconcile" : b.kind === "unlock" ? "reconcileUnlock" : b.kind === "repair" ? "reconcileRepair" : b.kind === "resolveFailure" ? "reconcileResolveFailure" : "retain",targetId: b.kind === "begin" ? previous.id : b.failureScopeKey ?? b.assetId,reason: b.reason } };
    if (b.kind === "begin") { version.sourceVersionId = currentSource;version.assets = [];version.suggestions = [];version.scriptVersionId = "new-formal";version.upstreamConfirmedVersionIds = b.expectedUpstreamConfirmedVersionIds;version.reconciliation = { originVersionId: previous.id,pendingAssets: previous.assets,pendingFailureScopeKeys: previous.failures.map(f => f.scopeKey) }; }
    else if (b.kind === "resolveFailure") {
      const failure = previous.failures.find(f => f.scopeKey === b.failureScopeKey)!;
      expect(failure.retryable).toBe(false);
      version.failures = previous.failures.filter(f => f.scopeKey !== b.failureScopeKey);
      version.reconciliation!.pendingFailureScopeKeys = [];
      version.reconciliation!.failureDecisions = [{ failure,requestId:b.requestId,reason:b.reason,actorId:"owner" }];
    }
    else if (b.kind === "unlock") { delete version.locks?.[b.assetId]; }
    else { const a = version.reconciliation!.pendingAssets.find(a => a.id===b.assetId)!;version.assets = [...version.assets,b.kind === "repair" ? b.value : a];version.reconciliation!.pendingAssets = version.reconciliation!.pendingAssets.filter(a => a.id!==b.assetId); }
    operations.set(b.requestId,structuredClone(version));
    return r.fulfill({ headers,status: ["unknown","replay-read-404","advanced","advanced-read-404"].includes(mode) && posts===1 ? 503 : 201,json: ["unknown","replay-read-404","advanced","advanced-read-404"].includes(mode) && posts===1 ? { code: "STORAGE_UNAVAILABLE" } : version });
  });
  await page.route(`${base}/review`,r => {
    if (r.request().method()==="OPTIONS") return r.fulfill({ headers,status: 204 });
    const b = r.request().postDataJSON();expect(b.kind).toBe("confirm");expect(version.reconciliation!.pendingAssets).toEqual([]);expect(b.expectedActiveVersionId).toBe(version.id);
    version = { ...version,id: "reconfirmed",parentVersionId: version.id,status: "confirmed",operation: { requestId: b.requestId,kind: "confirm",targetId: version.id,reason: b.reason } };formal = structuredClone(version);return r.fulfill({ headers,json: version });
  });
  async function enter() { await page.getByRole("button",{ name: "进入审核",exact: true }).click();await page.getByRole("button",{ name: "读取拆集方案",exact: true }).click();await page.getByRole("button",{ name: "读取当前剧本",exact: true }).click(); }
  await enter();const workbench = page.getByRole("region",{ name: "设定候选生成与追溯" });await workbench.getByRole("button",{ name: "读取当前设定",exact: true }).click();
  const panel = page.getByRole("region",{ name: "设定跨上游核对" });await panel.getByRole("button",{ name: "预览设定跨上游处理",exact: true }).click();expect(posts).toBe(0);
  if (["editor","mobile"].includes(mode)) { await expect(panel.getByRole("button",{ name: "明确开始同源核对",exact: true })).not.toBeVisible();expect(posts).toBe(0);return; }
  await panel.getByLabel("跨上游处理理由",{ exact: true }).fill("review new script");await panel.getByRole("button",{ name: cross ? "明确开始跨源核对" : "明确开始同源核对",exact: true }).click();
  if (mode === "conflict") { await expect(panel.getByRole("status")).toContainText("操作被拒绝");expect(posts).toBe(1);return; }
  if (mode === "missing-conflict") {
    await expect(panel.getByRole("status")).toContainText("结果未知");
    await panel.getByRole("button",{ name: "核对跨上游原操作",exact: true }).click();await expect(panel.getByRole("status")).toContainText("保留原身份");
    await panel.getByRole("button",{ name: "重新发送跨上游原操作",exact: true }).click();await expect(panel.getByRole("status")).toContainText("已明确拒绝且未找到已保存结果");
    await panel.getByRole("button",{ name: "结束未保存的跨上游操作核对",exact: true }).click();await expect(panel.getByRole("status")).toContainText("已结束明确未保存");expect(posts).toBe(2);return;
  }
  if (mode === "replay-read-404") {
    await expect(panel.getByRole("status")).toContainText("结果未知");
    await panel.getByRole("button",{ name: "重新发送跨上游原操作",exact: true }).click();
    await expect(panel.getByRole("status")).toContainText("已读取原操作记录");
    await expect(panel.getByRole("button",{ name: "结束未保存的跨上游操作核对",exact: true })).toHaveCount(0);
    await panel.getByRole("button",{ name: "核对跨上游原操作",exact: true }).click();await expect(panel.getByRole("status")).toContainText("核对操作已保存");expect(posts).toBe(2);return;
  }
  if (mode === "unknown" || mode.startsWith("advanced")) { await expect(panel.getByRole("status")).toContainText("结果未知");advanced = mode.startsWith("advanced");await page.reload();await login(page);const story = page.getByRole("region",{ name: "故事知识任务" });await story.getByLabel("任务编号").fill("task");await story.getByRole("button",{ name: "读取任务",exact: true }).click();await enter();if (advanced) await workbench.getByRole("button",{name:"读取当前设定",exact:true}).click();await expect(panel.getByRole("button",{ name: "核对跨上游原操作",exact: true })).toBeVisible();expect(posts).toBe(1);await panel.getByRole("button",{ name: "核对跨上游原操作",exact: true }).click(); }
  if (advanced) {
    await expect(panel.getByRole("status")).toContainText(mode === "advanced-read-404" ? "保留原请求" : "核对操作已保存");
    await expect(panel.getByRole("button",{name:"归档旧上游核对请求",exact:true})).toHaveCount(0);
    expect(posts).toBe(1);return;
  }
  if (mode === "read-failure") { await expect(panel.getByRole("status")).toContainText("操作已保存");await panel.getByRole("button",{ name: "核对跨上游原操作",exact: true }).click();expect(posts).toBe(1); }
  await expect(panel.getByText(/待核对资产 2 项/)).toBeVisible();
  const regeneration = workbench.getByRole("region",{name:"文字设定局部重生"});
  await expect(regeneration.getByLabel("重生待核对资产 庭院",{exact:true})).toBeDisabled();
  await expect(regeneration.getByRole("button",{name:"提交设定局部重生",exact:true})).toBeDisabled();
  if (mode === "success") await panel.screenshot({ path: "/tmp/t07-settings-reconciliation.png" });
  if (cross) {
    await panel.getByLabel("跨上游处理理由").fill("unlock");
    await panel.getByRole("button",{name:"明确解锁待核对资产 庭院"}).click();
    await panel.getByRole("button",{name:"人工修订 庭院"}).click();
    await panel.getByLabel("修订当前状态").fill("dry");
    await panel.getByRole("checkbox",{name:"晴天"}).check();
    await panel.getByLabel("跨上游处理理由").fill("update state");
    await panel.getByRole("button",{name:"保存人工修订"}).click();
    await expect(panel.getByText(/待核对资产 1 项/)).toBeVisible();
    expect(version.assets[0]?.state).toBe("dry");
    expect(version.assets[0]?.provenance[0]).toMatchObject({sourceVersionId:currentSource,fragmentId:"new-fragment"});
    const review = page.getByRole("region",{ name:"文字设定审核" });
    await expect(review.getByRole("button",{name:"确认文字设定",exact:true})).toBeDisabled();
    await panel.getByRole("button",{name:"人工修订 道具"}).click();
    await panel.getByRole("checkbox",{name:"晴天"}).check();
    await panel.getByLabel("跨上游处理理由").fill("trace prop");
    await panel.getByRole("button",{name:"保存人工修订"}).click();
    await expect(panel.getByText(/待核对资产 0 项/)).toBeVisible();
    await panel.getByRole("button",{name:"读取原版本建议历史",exact:true}).click();
    await panel.getByRole("button",{name:"读取历史原文依据",exact:true}).click();
    const history = panel.getByRole("complementary",{name:"原版本依据与锁"});
    await history.getByText("庭院的历史依据",{exact:true}).click();
    await expect(history.locator("details[open]").getByText("雨落",{exact:true})).toBeVisible();
    await expect(history.getByText(/原锁：owner/)).toBeVisible();
    expect(formal.id).toBe(old.id);
    await review.getByLabel("设定操作理由",{exact:true}).fill("confirm current evidence");
    await review.getByRole("button",{name:"确认文字设定",exact:true}).click();
    await expect(review.getByText("设定状态：正式",{exact:true})).toBeVisible();
    return;
  }
  const review = page.getByRole("region",{ name: "文字设定审核" });await expect(review.getByRole("button",{ name: "确认文字设定",exact: true })).toBeDisabled();
  await panel.getByRole("button",{ name: "读取原版本建议历史",exact: true }).click();await expect(panel.getByLabel("原版本建议历史")).toContainText("pending · 未迁移");
  const comparison = panel.getByRole("complementary",{name:"历史影响与本轮处理"});
  await panel.getByRole("button",{name:"对照历史影响与本轮处理",exact:true}).click();
  await expect(comparison).toContainText("待核对");
  await expect(comparison).toContainText("unreviewed");
  await panel.getByLabel("跨上游处理理由",{ exact: true }).fill("retain courtyard");await panel.getByRole("button",{ name: "原样保留 庭院",exact: true }).click();await expect(panel.getByText(/待核对资产 1 项/)).toBeVisible();
  await review.getByLabel("设定操作理由",{ exact: true }).fill("too early");await expect(review.getByRole("button",{ name: "确认文字设定",exact: true })).toBeDisabled();
  await panel.getByLabel("跨上游处理理由",{ exact: true }).fill("retain prop");await panel.getByRole("button",{ name: "原样保留 道具",exact: true }).click();
  await review.getByRole("button",{ name: "读取保留正式设定",exact: true }).click();await expect(review.getByLabel("保留正式设定")).toContainText("old-setting");
  expect(version.locks).toEqual(old.locks);expect(version.suggestions).toEqual([]);
  await workbench.getByRole("button",{ name: "庭院",exact: true }).click();await expect(workbench.getByLabel("设定原文依据")).toContainText("雨落");
  if (mode === "success") {
    await expect(review.getByRole("button",{name:"确认文字设定",exact:true})).toBeDisabled();
    await panel.getByLabel("跨上游处理理由").fill("无需设定");
    await panel.getByRole("button",{name:"裁决无需产出设定 unbound",exact:true}).click();
    await expect(panel.getByText(/已裁决无需产出设定/)).toContainText("PROVIDER_ITEM_FAILED");
  }
  await review.getByLabel("设定操作理由",{ exact: true }).fill("checked all");await review.getByRole("button",{ name: "确认文字设定",exact: true }).click();await expect(review.getByText("设定状态：正式",{ exact: true })).toBeVisible();expect(posts).toBe(mode === "success" ? 4 : 3);
  await expect(comparison).toContainText("已纳入本轮正式设定");
  await expect(comparison).toContainText("unreviewed");
});
