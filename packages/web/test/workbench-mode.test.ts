import assert from "node:assert/strict";
import test from "node:test";

import { describeWorkbenchMode, switchWorkbenchMode, workbenchModes } from "../src/lib/workbench-mode.ts";

test("三个工作台模式都公开，切换模式时保留当前流程位置", () => {
  assert.deepEqual(workbenchModes.map(({ id }) => id), ["trace", "review", "storyboard"]);
  assert.deepEqual(switchWorkbenchMode({ mode: "trace", step: "chapter" }, "storyboard"), {
    mode: "storyboard",
    step: "chapter",
  });
});

test("切换到审核或分镜不会绕过正式内容的阶段门禁", () => {
  const importedOnly = {
    sourceImported: true,
    storyKnowledgeConfirmed: false,
    scriptConfirmed: false,
    settingsConfirmed: false,
  };

  assert.deepEqual(describeWorkbenchMode("review", importedOnly), {
    generationEnabled: false,
    status: "原文已就绪，等待故事知识生成并确认",
    requiredConfirmation: "故事知识",
  });
  assert.deepEqual(describeWorkbenchMode("storyboard", importedOnly), {
    generationEnabled: false,
    status: "仍需依次确认故事知识、剧本和设定",
    requiredConfirmation: "故事知识",
  });
});

test("分镜仅在故事知识、剧本和设定依次确认后解锁", () => {
  assert.deepEqual(describeWorkbenchMode("storyboard", {
    sourceImported: true,
    storyKnowledgeConfirmed: true,
    scriptConfirmed: true,
    settingsConfirmed: true,
  }), {
    generationEnabled: true,
    status: "前置阶段已确认，可以生成正式分镜",
    requiredConfirmation: null,
  });
});
