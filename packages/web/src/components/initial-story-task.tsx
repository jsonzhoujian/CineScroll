"use client";
import { useEffect, useRef, useState } from "react";
import { ApiClientError, type ApiClient, type ModelConfiguration } from "../lib/api";
import type { TaskChapterContext } from "./chapter-task-list";

/** Parent remounts on chapter/source changes. URL-only contexts must not mount this entry. */
export function InitialStoryTask({ api, context, onCreated }: { api: ApiClient; context: TaskChapterContext; onCreated(id: string): void }) {
  const [configuration, setConfiguration] = useState<ModelConfiguration | null>(null);
  const [modelId, setModelId] = useState(""), [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("先读取可用模型，再明确选择。本操作仅创建排队任务，不启动模型执行。");
  const alive = useRef(true), locked = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  async function readModels() {
    if (locked.current) return;
    locked.current = true; setBusy(true); setConfiguration(null); setModelId("");
    try {
      const config = (await api.modelConfiguration()).configuration;
      if (!alive.current) return;
      const usable = config?.tested && config.processingRegion === "mainland" && config.availableModelIds.length ? config : null;
      setConfiguration(usable);
      setNotice(usable ? "请选择模型后创建任务；不会自动确认故事知识。" : "没有已测试的大陆模型，请联系工作室负责人配置。");
    } catch (error) { if (alive.current) setNotice(failure(error)); }
    finally { if (alive.current) { locked.current = false; setBusy(false); } }
  }
  async function submit() {
    if (locked.current || !configuration || !configuration.availableModelIds.includes(modelId)) return;
    locked.current = true; setBusy(true);
    try {
      const task = await api.submitStoryKnowledgeTask(context.projectId, context.chapterId, { configurationVersionId: configuration.id, modelId });
      if (!alive.current) return;
      if (!task.id?.trim() || task.id.length > 256 || /[\r\n]/.test(task.id) || task.projectId !== context.projectId || task.chapterId !== context.chapterId || task.input.stage !== "story_knowledge") throw new Error("wrong task context");
      setConfiguration(null); setModelId(""); setNotice("任务已创建。仅排队，尚未接入自动执行。");
      onCreated(task.id);
    } catch (error) {
      if (alive.current) { setNotice(failure(error)); setConfiguration(null); setModelId(""); }
    } finally { if (alive.current) { locked.current = false; setBusy(false); } }
  }
  return <section className="task-resubmit desktop-task-action" aria-label="创建故事知识任务">
    <h3>从原文提取故事知识</h3>
    <button className="text-button" disabled={busy} onClick={() => void readModels()}>读取可用模型</button>
    <label>首次生成模型<select value={modelId} disabled={busy || !configuration} onChange={event => setModelId(event.target.value)}><option value="">请明确选择模型</option>{configuration?.availableModelIds.map(model => <option key={model}>{model}</option>)}</select></label>
    <small>配置版本 {configuration?.id ?? "未读取"} · 当前已导入章节</small>
    <button className="button primary" disabled={busy || !configuration || !modelId} onClick={() => void submit()}>创建故事知识任务</button>
    <p role="status">{notice}</p>
  </section>;
}
function failure(error: unknown) {
  if (error instanceof ApiClientError) {
    if (error.status === 401) return "登录已失效，请重新登录。";
    if (error.status === 403) return "无权创建任务或订阅已失效，请联系负责人。";
    if (error.status === 404) return "章节无权访问、不存在，或任务模块尚未启用。";
    if (error.status === 409) return "原文、候选或模型配置已变化，请刷新核对后操作。";
    if (error.status === 429) return "请求过于频繁，请稍后再核对任务列表。";
  }
  return "操作未完成，提交结果可能未知。请先刷新任务列表核对，不会自动重试。";
}
