import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import * as yazl from "yazl";

import { assertSafeDocxEntry, validateDocxArchive } from "../src/docx-security.ts";
import { InMemoryProjectImportRepository, ProjectImportService } from "../src/index.ts";
import { MammothDocxTextExtractor } from "../src/mammoth-docx-extractor.ts";

const actor = { userId: "usr_owner", workspaceId: "wsp_studio" } as const;

function createService(overrides: Record<string, unknown> = {}) {
  return new ProjectImportService({
    repository: new InMemoryProjectImportRepository(),
    idGenerator: (() => {
      let sequence = 0;
      return (prefix: string) => `${prefix}_test-${++sequence}`;
    })(),
    clock: () => new Date("2026-09-22T00:00:00.000Z"),
    complianceScanner: { async scan() { return { allowed: true, providerRequestId: "req_test" }; } },
    ...overrides,
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
  assert.equal(result.complianceProviderRequestId, "req_test");
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
  assert.equal(second.sourceVersion.fragments.at(0)!.id, first.sourceVersion.fragments.at(0)!.id);
  assert.deepEqual(second.diff, { unchanged: ["第一段。"], removed: ["第二段。"], added: ["第二段已修改。", "第三段。"] });
  const history = await service.getChapter(actor, project.id, first.chapter.id);
  assert.deepEqual(history.versions.map(({ ordinal }) => ordinal), [1, 2]);
  assert.equal(history.versions.at(0)!.text, "第一段。\n\n第二段。");
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

test("未授权的文档导入在文件解析前返回项目不存在", async () => {
  let extractionCalls = 0;
  const service = createService({
    documentTextExtractor: {
      async extractDocx() {
        extractionCalls += 1;
        return "正文";
      },
    },
  });
  const project = await service.createProject(actor, validProject);
  await assert.rejects(
    () => service.importDocument(
      { userId: "usr_other", workspaceId: "wsp_other" },
      project.id,
      { kind: "docx", fileName: "secret.docx", bytes: new Uint8Array([80, 75, 3, 4]) },
      0,
    ),
    { code: "PROJECT_NOT_FOUND" },
  );
  assert.equal(extractionCalls, 0);
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

test("导入预检列出多章节，但不会提前创建原文版本", async () => {
  const service = createService();
  const project = await service.createProject(actor, validProject);

  const inspection = await service.inspectDocument(actor, project.id, {
    kind: "paste",
    fileName: "人间剑令.txt",
    text: "第1章 初见\n这里是正文。\n第2章 风起\n风起于城中。",
  });

  assert.deepEqual(inspection.chapters, [
    { index: 0, title: "第1章 初见", characterCount: 6, selectable: true },
    { index: 1, title: "第2章 风起", characterCount: 6, selectable: true },
  ]);
  assert.equal(project.chapters.length, 0);
});

test("TXT 使用指定编码解码，DOCX 通过文件提取端口预检", async () => {
  const extractedFiles: string[] = [];
  const service = createService({
    documentTextExtractor: {
      async extractDocx(fileName: string, _bytes: Uint8Array) {
        extractedFiles.push(fileName);
        return "第1章 文档\nDOCX 正文。";
      },
    },
  });
  const project = await service.createProject(actor, validProject);

  const txt = await service.inspectDocument(actor, project.id, {
    kind: "txt",
    fileName: "章节.txt",
    bytes: new TextEncoder().encode("第1章 文本\nTXT 正文。"),
    encoding: "utf-8",
  });
  const docx = await service.inspectDocument(actor, project.id, {
    kind: "docx",
    fileName: "章节.docx",
    bytes: new Uint8Array([80, 75, 3, 4]),
  });

  assert.equal(txt.chapters.at(0)!.title, "第1章 文本");
  assert.equal(docx.chapters.at(0)!.title, "第1章 文档");
  assert.deepEqual(extractedFiles, ["章节.docx"]);
});

test("TXT 和 DOCX 可以从预检使用的同一文件边界选章并正式导入", async () => {
  const service = createService({
    documentTextExtractor: {
      async extractDocx() {
        return "第1章 文档\n首章。\n第2章 选择\n应被保存的章节。";
      },
    },
  });
  const project = await service.createProject(actor, validProject);
  const result = await service.importDocument(actor, project.id, {
    kind: "docx",
    fileName: "双章.docx",
    bytes: new Uint8Array([80, 75, 3, 4]),
  }, 1);

  assert.equal(result.chapter.title, "第2章 选择");
  assert.equal(result.sourceVersion.text, "应被保存的章节。");
});

test("预检为不支持、损坏和合规受限输入返回不同错误码", async () => {
  const projectInput = validProject;
  const unsupported = createService();
  const project = await unsupported.createProject(actor, projectInput);
  await assert.rejects(
    () => unsupported.inspectDocument(actor, project.id, { kind: "pdf" as "txt", fileName: "小说.pdf", bytes: new Uint8Array() }),
    { code: "UNSUPPORTED_DOCUMENT_TYPE" },
  );

  const malformed = createService({ documentTextExtractor: new MammothDocxTextExtractor() });
  const malformedProject = await malformed.createProject(actor, projectInput);
  await assert.rejects(
    () => malformed.inspectDocument(actor, malformedProject.id, { kind: "docx", fileName: "损坏.docx", bytes: new Uint8Array([1]) }),
    { code: "MALFORMED_DOCUMENT" },
  );

  const restricted = createService({
    complianceScanner: {
      async scan() {
        return { allowed: false, reason: "命中禁止内容规则", providerRequestId: "req_restricted" };
      },
    },
  });
  const restrictedProject = await restricted.createProject(actor, projectInput);
  await assert.rejects(
    () => restricted.inspectDocument(actor, restrictedProject.id, { kind: "paste", fileName: "内容.txt", text: "受限内容" }),
    { code: "COMPLIANCE_RESTRICTED", providerRequestId: "req_restricted" },
  );
  await assert.rejects(
    () => restricted.importText(actor, restrictedProject.id, { fileName: "绕过.txt", text: "受限内容", selectedChapterIndex: 0 }),
    { code: "COMPLIANCE_RESTRICTED" },
  );
});

test("合规供应商故障不会泄漏内部错误并允许用户稍后重试", async () => {
  const service = createService({
    complianceScanner: { async scan() { throw new Error("upstream token and response"); } },
  });
  const project = await service.createProject(actor, validProject);

  await assert.rejects(
    () => service.importText(actor, project.id, {
      fileName: "待检测.txt", text: "正常正文", selectedChapterIndex: 0,
    }),
    {
      code: "COMPLIANCE_UNAVAILABLE",
      message: "内容合规服务暂不可用，请稍后重试",
    },
  );
});

test("运行时拒绝无效的画幅、时长和叙事类型", async () => {
  const service = createService();
  const invalidInputs = [
    { ...validProject, aspectRatio: "4:3" as "9:16" },
    { ...validProject, targetDurationSeconds: 120 as 180 },
    { ...validProject, narrativeMode: "hybrid" as "narration" },
  ];
  for (const input of invalidInputs) {
    await assert.rejects(() => service.createProject(actor, input), { code: "INVALID_PROJECT_OPTIONS" });
  }
});

test("Mammoth 适配器在 Worker 中提取有效 DOCX", async () => {
  const fixture = new URL("../test/test-data/single-paragraph.docx", import.meta.resolve("mammoth"));
  const text = await new MammothDocxTextExtractor().extractDocx("single-paragraph.docx", await readFile(fixture));
  assert.equal(text.trim(), "Walking on imported air");
});

test("DOCX 安全边界拒绝 MIME 伪造、压缩炸弹、外部引用和路径穿越", async () => {
  await assert.rejects(
    () => new MammothDocxTextExtractor().extractDocx("伪造.docx", new TextEncoder().encode("not-a-zip")),
    /ZIP signature/,
  );

  const bomb = await createZip([{ name: "word/document.xml", content: Buffer.alloc(2 * 1024 * 1024) }]);
  await assert.rejects(() => validateDocxArchive(bomb), /compression ratio|resource limits/);

  const external = await createZip([{
    name: "_rels/.rels",
    content: Buffer.from('<Relationships><Relationship TargetMode="External" Target="https://example.com/x"/></Relationships>'),
  }]);
  await assert.rejects(() => validateDocxArchive(external), /external relationship/);

  const oversizedRelationships = await createZip([{
    name: "_rels/.rels",
    content: randomBytes(1024 * 1024 + 1),
  }]);
  await assert.rejects(() => validateDocxArchive(oversizedRelationships), /relationship file exceeds/);

  assert.throws(
    () => assertSafeDocxEntry({ fileName: "../secret.xml", compressedSize: 10, uncompressedSize: 10 }),
    /path-traversal/,
  );
});

function createZip(entries: Array<{ name: string; content: Buffer }>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const chunks: Buffer[] = [];
    zip.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on("error", reject);
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    for (const entry of entries) zip.addBuffer(entry.content, entry.name);
    zip.end();
  });
}
