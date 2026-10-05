import assert from "node:assert/strict";
import test from "node:test";
import { taskPresentation } from "../src/lib/task-status.ts";

test("任务展示区分部分成功、全条目失败与待人工，未知执行不可重提", () => {
  assert.equal(taskPresentation({ state: "succeeded", reason: null, result: { candidateVersionId: "v", extractionStatus: "partially_succeeded" } }).label, "部分成功");
  assert.equal(taskPresentation({ state: "succeeded", reason: null, result: { candidateVersionId: "v", extractionStatus: "failed" } }).label, "全部条目失败");
  assert.equal(taskPresentation({ state: "paused", reason: "EXECUTION_UNCERTAIN", result: null }).canResubmit, false);
  assert.equal(taskPresentation({ state: "paused", reason: "EXECUTION_UNCERTAIN", result: null }).label, "待人工处理");
  assert.equal(taskPresentation({ state: "paused", reason: "VERSION_CONFLICT", result: null }).canResubmit, true);
  assert.equal(taskPresentation({ state: "paused", reason: "UPSTREAM_CHANGED", result: null }).canResubmit, false);
});
