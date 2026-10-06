"use client";
import { useEffect, useState } from "react";
import type { ApiClient } from "./api";

/** A selection-specific hint only; submit always rechecks admission on the server. */
export function useTaskAvailability(api: ApiClient, projectId: string | undefined, chapterId: string | undefined,
  configurationVersionId: string | undefined, modelId: string) {
  const key = JSON.stringify([projectId, chapterId, configurationVersionId, modelId]);
  const [result, setResult] = useState<{ key: string; available: boolean; note: string } | null>(null);
  useEffect(() => {
    let active = true;
    if (!projectId || !chapterId || !configurationVersionId || !modelId) return;
    void api.storyTaskAvailability(projectId, chapterId, { configurationVersionId, modelId }).then(status => {
      if (!active) return;
      const available = status.available === true && status.reason === null;
      const note = available ? "当前工作室和厂商可提交；权限、生成许可及配额仍以提交时检查为准。"
        : status.reason === "WORKSPACE_TASK_DISABLED" ? "当前工作室尚未启用故事知识生成，已有任务仍可查看。"
        : status.reason === "TASK_PROVIDER_UNSUPPORTED" ? "当前厂商尚未支持故事知识生成，请联系负责人切换支持的厂商。"
        : "无法确认生成可用性，请重新读取模型或刷新状态。";
      setResult({ key, available, note });
    }).catch(() => { if (active) setResult({ key, available: false, note: "无法确认生成可用性，请重新读取模型或刷新状态。" }); });
    return () => { active = false; };
  }, [api, projectId, chapterId, configurationVersionId, modelId, key]);
  if (!projectId || !chapterId || !configurationVersionId || !modelId) return { available: false, note: "选择模型后检查生成可用性。" };
  return result?.key === key ? result : { available: false, note: "正在检查生成可用性…" };
}
