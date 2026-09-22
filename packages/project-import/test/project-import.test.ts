import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryProjectImportRepository, ProjectImportService } from "../src/index.ts";

const actor = { userId: "usr_owner", workspaceId: "wsp_studio" } as const;

function createService() {
  return new ProjectImportService({
    repository: new InMemoryProjectImportRepository(),
    idGenerator: (() => {
      let sequence = 0;
      return (prefix: string) => `${prefix}_test-${++sequence}`;
    })(),
    clock: () => new Date("2026-09-22T00:00:00.000Z"),
  });
}

const validProject = {
  title: "人间剑令",
  rightsDeclared: true,
  aspectRatio: "9:16",
  targetDurationSeconds: 180,
  narrativeMode: "narration",
} as const;

test("负责人声明改编权后可创建项目并导入一个可追溯章节", async () => {
  const service = createService();
  const project = await service.createProject(actor, validProject);
  const result = await service.importText(actor, project.id, {
    fileName: "第一章.txt",
    text: "第1章 青萍微澜\n中洲西南，大秦帝都郢城。\n\n丞相府后院，相霜安坐。",
    selectedChapterIndex: 0,
  });

  assert.equal(result.chapter.title, "第1章 青萍微澜");
  assert.equal(result.sourceVersion.ordinal, 1);
  assert.equal(result.sourceVersion.characterCount, 25);
  assert.equal(result.sourceVersion.text, "中洲西南，大秦帝都郢城。\n\n丞相府后院，相霜安坐。");
  assert.deepEqual(result.sourceVersion.fragments.map(({ text }) => text), ["中洲西南，大秦帝都郢城。", "丞相府后院，相霜安坐。"]);
  assert.ok(result.sourceVersion.fragments.every(({ id }) => id.startsWith("frag_")));
});

test("重新导入保留历史、维持未改段落 ID 并返回有序差异", async () => {
  const service = createService();
  const project = await service.createProject(actor, validProject);
  const first = await service.importText(actor, project.id, {
    fileName: "第一章.txt",
    text: "第1章 青萍微澜\n第一段。\n\n第二段。",
    selectedChapterIndex: 0,
  });
  const second = await service.reimportText(actor, project.id, first.chapter.id, {
    fileName: "第一章-修订.txt",
    text: "第1章 青萍微澜\n第一段。\n\n第二段已修改。\n\n第三段。",
    selectedChapterIndex: 0,
  });

  assert.equal(second.sourceVersion.ordinal, 2);
  assert.equal(second.sourceVersion.fragments[0].id, first.sourceVersion.fragments[0].id);
  assert.deepEqual(second.diff, { unchanged: ["第一段。"], removed: ["第二段。"], added: ["第二段已修改。", "第三段。"] });
  const history = await service.getChapter(actor, project.id, first.chapter.id);
  assert.deepEqual(history.versions.map(({ ordinal }) => ordinal), [1, 2]);
  assert.equal(history.versions[0].text, "第一段。\n\n第二段。");
});

test("差异能识别重复段落被删除", async () => {
  const service = createService();
  const project = await service.createProject(actor, validProject);
  const first = await service.importText(actor, project.id, { fileName: "a.txt", text: "重复。\n\n重复。", selectedChapterIndex: 0 });
  const second = await service.reimportText(actor, project.id, first.chapter.id, { fileName: "b.txt", text: "重复。", selectedChapterIndex: 0 });
  assert.deepEqual(second.diff, { unchanged: ["重复。"], removed: ["重复。"], added: [] });
});

test("非项目成员不能读取或重新导入项目章节", async () => {
  const service = createService();
  const project = await service.createProject(actor, validProject);
  const imported = await service.importText(actor, project.id, { fileName: "a.txt", text: "正文", selectedChapterIndex: 0 });
  const outsider = { userId: "usr_other", workspaceId: "wsp_studio" };
  await assert.rejects(() => service.getChapter(outsider, project.id, imported.chapter.id), { code: "PROJECT_NOT_FOUND" });
  await assert.rejects(
    () => service.reimportText(outsider, project.id, imported.chapter.id, { fileName: "b.txt", text: "修改", selectedChapterIndex: 0 }),
    { code: "PROJECT_NOT_FOUND" },
  );
});

test("其他工作室不能判断项目是否存在", async () => {
  const service = createService();
  const project = await service.createProject(actor, validProject);
  await assert.rejects(
    () => service.importText({ userId: "usr_other", workspaceId: "wsp_other" }, project.id, { fileName: "a.txt", text: "正文", selectedChapterIndex: 0 }),
    { code: "PROJECT_NOT_FOUND" },
  );
});

test("拒绝未声明改编权和超过 20,000 字符的章节", async () => {
  const service = createService();
  await assert.rejects(() => service.createProject(actor, { ...validProject, rightsDeclared: false }), { code: "RIGHTS_DECLARATION_REQUIRED" });
  const project = await service.createProject(actor, validProject);
  await assert.rejects(
    () => service.importText(actor, project.id, { fileName: "超长.txt", text: "字".repeat(20_001), selectedChapterIndex: 0 }),
    { code: "CHAPTER_TOO_LARGE" },
  );
});
