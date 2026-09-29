import { expect, test } from "@playwright/test";

const appOrigin = `http://127.0.0.1:${process.env.E2E_PORT ?? "4175"}`;
const apiOrigin = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001").replace(/\/$/, "");

test("用户从手机号登录完成多章节导入并查看重新导入差异", async ({ page }) => {
  await mockProjectImportApi(page);
  await page.goto("/");

  await page.getByRole("button", { name: "获取验证码" }).click();
  await expect(page.getByRole("status")).toContainText("验证码已发送");
  await page.getByLabel("验证码").fill("123456");
  await page.getByRole("button", { name: "验证并进入" }).click();

  await page.getByLabel("项目名称").fill("人间剑令");
  await page.getByRole("checkbox", { name: /拥有该作品或合法改编权/ }).check();
  await page.getByRole("button", { name: /创建项目/ }).click();

  await page.getByPlaceholder(/第1章 青芽微澜/).fill("第1章 青芽微澜\n雨落。\n第2章 风起\n剑鸣。");
  await page.getByRole("button", { name: "预检章节" }).click();
  await expect(page.getByRole("heading", { name: "识别到 2 个章节" })).toBeVisible();
  await page.getByRole("button", { name: /第2章 风起/ }).click();
  await page.getByRole("button", { name: /确认并创建原文版本/ }).click();

  await expect(page.getByRole("heading", { name: "第2章 风起" })).toBeVisible();
  await expect(page.getByLabel("当前原文版本状态")).toHaveText("已入卷 · 3 字");
  const directory = page.getByRole("region", { name: "已保存章节目录" });
  await expect(directory.getByText("第1章 青芽微澜")).toBeVisible();
  await expect(directory.getByText("待后续处理 · 3 字")).toBeVisible();

  await page.getByRole("textbox", { name: "新版本正文" }).fill("剑啸。");
  await page.getByRole("button", { name: "生成差异" }).click();
  await expect(page.getByText("新增 · 1")).toBeVisible();
  await expect(page.getByRole("group", { name: "新增内容" }).getByText("剑啸。", { exact: true })).toBeVisible();
  await expect(page.getByText("删除 · 1")).toBeVisible();
  await expect(page.getByRole("group", { name: "删除内容" }).getByText("剑鸣。", { exact: true })).toBeVisible();
});

async function mockProjectImportApi(page: import("@playwright/test").Page) {
  await page.route(`${apiOrigin}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const headers = {
      "access-control-allow-origin": appOrigin,
      "access-control-allow-headers": "authorization,content-type,x-device-token",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "content-type": "application/json",
    };
    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers, body: "" });
      return;
    }

    const key = `${request.method()} ${url.pathname}`;
    const session = () => expect(request.headers().authorization).toBe("Bearer session-token");
    const device = () => expect(request.headers()["x-device-token"]).toBe("device-token");
    if (key === "POST /auth/phone/challenges") {
      device();
      expect(request.postDataJSON()).toEqual({ phone: "13800138000" });
    } else if (key === "POST /auth/phone/verify") {
      device();
      expect(request.postDataJSON()).toEqual({ challengeId: "challenge-1", phone: "13800138000", code: "123456" });
    } else if (key === "POST /projects") {
      session();
      expect(request.postDataJSON()).toEqual({ title: "人间剑令", rightsDeclared: true, aspectRatio: "9:16", targetDurationSeconds: 180, narrativeMode: "narration" });
    } else if (key === "POST /projects/project-1/imports/inspect") {
      session();
      expect(request.postDataJSON()).toEqual({ kind: "paste", fileName: "粘贴文本.txt", text: "第1章 青芽微澜\n雨落。\n第2章 风起\n剑鸣。" });
    } else if (key === "POST /projects/project-1/chapters/import") {
      session();
      expect(request.postDataJSON()).toEqual({
        document: { kind: "paste", fileName: "粘贴文本.txt", text: "第1章 青芽微澜\n雨落。\n第2章 风起\n剑鸣。" },
        selectedChapterIndex: 1,
      });
    } else if (key === "POST /projects/project-1/chapters/chapter-2/reimport") {
      session();
      expect(request.postDataJSON()).toEqual({ fileName: "重新导入.txt", text: "剑啸。", selectedChapterIndex: 0 });
    }

    const responses: Record<string, object> = {
      "POST /auth/device": { deviceToken: "device-token" },
      "POST /auth/phone/challenges": { challengeId: "challenge-1", expiresAt: "2026-09-29T08:00:00.000Z" },
      "POST /auth/phone/verify": { actor: { userId: "user-1", workspaceId: "studio-1" }, sessionToken: "session-token" },
      "POST /projects": { id: "project-1", title: "人间剑令" },
      "POST /projects/project-1/imports/inspect": {
        fileName: "粘贴文本.txt",
        chapters: [
          { index: 0, title: "第1章 青芽微澜", characterCount: 3, selectable: true },
          { index: 1, title: "第2章 风起", characterCount: 3, selectable: true },
        ],
      },
      "POST /projects/project-1/chapters/import": importedChapter(),
      "POST /projects/project-1/chapters/chapter-2/reimport": {
        sourceVersion: {
          id: "version-2", ordinal: 2, createdAt: "2026-09-29T07:00:00.000Z",
          characterCount: 3, text: "剑啸。", fragments: [{ id: "fragment-2", ordinal: 0, text: "剑啸。" }],
        },
        diff: { unchanged: [], removed: ["剑鸣。"], added: ["剑啸。"] },
      },
    };
    const body = responses[key];
    if (!body) throw new Error(`Unexpected API request: ${request.method()} ${url.pathname}`);
    await route.fulfill({ status: 201, headers, json: body });
  });
}

function importedChapter() {
  return {
    chapter: {
      id: "chapter-2", title: "第2章 风起", activeSourceVersionId: "version-1",
      versions: [{
        id: "version-1", ordinal: 1, createdAt: "2026-09-29T06:00:00.000Z",
        characterCount: 3, text: "剑鸣。", fragments: [{ id: "fragment-1", ordinal: 0, text: "剑鸣。" }],
      }],
    },
    document: {
      id: "document-1", fileName: "粘贴文本.txt",
      chapters: [
        { index: 0, title: "第1章 青芽微澜", characterCount: 3, status: "pending" },
        { index: 1, title: "第2章 风起", characterCount: 3, status: "imported", chapterId: "chapter-2" },
      ],
    },
  };
}
