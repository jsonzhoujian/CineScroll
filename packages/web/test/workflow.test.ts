import assert from "node:assert/strict";
import test from "node:test";

import { buildDocumentRequest, validateProjectDraft } from "../src/lib/workflow.ts";

test("项目创建必须包含有效选项和改编权声明", () => {
  const valid = {
    title: "人间剑令", rightsDeclared: true,
    aspectRatio: "9:16", targetDurationSeconds: 180, narrativeMode: "narration",
  } as const;
  assert.deepEqual(validateProjectDraft(valid), { ok: true, value: valid });
  assert.deepEqual(validateProjectDraft({ ...valid, rightsDeclared: false }), {
    ok: false, message: "请先确认拥有作品或合法改编权",
  });
});

test("粘贴、TXT 和 DOCX 被转换为 API 文档请求，其他文件被拒绝", async () => {
  assert.deepEqual(await buildDocumentRequest({ kind: "paste", text: "第1章\n正文" }), {
    kind: "paste", fileName: "粘贴文本.txt", text: "第1章\n正文",
  });
  const txt = { name: "story.txt", type: "text/plain", async arrayBuffer() { return new TextEncoder().encode("正文").buffer; } };
  assert.deepEqual(await buildDocumentRequest({ kind: "file", file: txt }), {
    kind: "txt", fileName: "story.txt", contentBase64: "5q2j5paH",
  });
  await assert.rejects(
    () => buildDocumentRequest({ kind: "file", file: { ...txt, name: "story.pdf", type: "application/pdf" } }),
    /仅支持 TXT 或 DOCX/,
  );
});
