import type { StoryKnowledgeTask } from "./api.ts";
export function taskPresentation(task: Pick<StoryKnowledgeTask, "state" | "reason" | "result">) {
  let label = "状态未识别", note = "请刷新状态，暂不可执行操作。";
  if (task.state === "queued") { label = "排队中"; note = "本版尚未启用自动调度；排队不表示正在生成。"; }
  if (task.state === "running") { label = "执行中"; note = "关闭页面不影响后台任务；超时不代表调用已停止。"; }
  if (task.state === "failed") { label = "任务失败"; note = task.reason === "INVALID_RESPONSE" ? "模型响应未通过校验。" : task.reason === "CANDIDATE_EXISTS" ? "已有候选，请先审核现有结果。" : "服务调用失败；不会自动重复调用。"; }
  if (task.state === "paused") { label = "已暂停"; note = "请选择当前已测试的模型后，明确重新提交。";
    if (task.reason === "UPSTREAM_CHANGED") note = "原文或参数已变化，请重新发起生成，不能沿用旧任务。";
    if (task.reason === "EXECUTION_UNCERTAIN") { label = "待人工处理"; note = "无法确认调用结果，请联系负责人对账。禁止重试以避免重复收费。"; }
  }
  if (task.state === "succeeded") {
    label = task.result?.extractionStatus === "partially_succeeded" ? "部分成功" : task.result?.extractionStatus === "failed" ? "全部条目失败" : task.result ? "候选已生成" : "处理已完成";
    note = "完成不代表通过质量验收，候选仍需人工审核。";
  }
  return { label, note, canResubmit: task.state === "paused" && ["VERSION_CONFLICT", "FORBIDDEN", "NOT_READY"].includes(task.reason ?? "") };
}
