"use client";
import { useEffect, useRef, useState } from "react";
import { ApiClientError, type ApiClient, type ModelConfiguration, type StoryKnowledgeTask, type StoryKnowledgeVersion } from "../lib/api";
import { useTaskAvailability } from "../lib/use-task-availability";
import { taskPresentation } from "../lib/task-status";

/** Keyed by candidate: old asynchronous responses cannot affect a new review. */
export function StoryKnowledgeRetry({ api, version, disabled, onLoaded }: { api: ApiClient; version: StoryKnowledgeVersion; disabled: boolean; onLoaded(version: StoryKnowledgeVersion): void }) {
  const [scopes, setScopes] = useState<string[]>([]), [config, setConfig] = useState<ModelConfiguration | null>(null), [model, setModel] = useState("");
  const [busy, setBusy] = useState(false), [task, setTask] = useState<StoryKnowledgeTask | null>(null), [uncertain, setUncertain] = useState(false);
  const [notice, setNotice] = useState("只重试选中失败范围，保留成功内容。不同来源任务须分批处理。");
  const alive = useRef(true), locked = useRef(false), pending = useRef<Parameters<ApiClient["submitStoryKnowledgeRetry"]>[2] | null>(null);
  const availability = useTaskAvailability(api, version.projectId, version.chapterId, config?.id, model);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!task || !["queued", "running"].includes(task.state)) return;
    let active = true;
    const timer = setTimeout(() => { void api.getStoryKnowledgeTask(task.id).then(next => {
      if (active && alive.current && next.id === task.id && next.projectId === version.projectId && next.chapterId === version.chapterId) setTask(next);
    }).catch(() => { if (active && alive.current) setNotice("进度读取失败，请在任务面板刷新核对；不会重新提交。"); }); }, 1000);
    return () => { active = false; clearTimeout(timer); };
  }, [api, task, version.projectId, version.chapterId]);
  async function readModels() {
    if (locked.current || disabled || uncertain || task) return;
    locked.current = true; setBusy(true);
    try {
      const current = (await api.modelConfiguration()).configuration;
      if (alive.current) { setConfig(current?.tested && current.processingRegion === "mainland" ? current : null); setModel(""); }
    } catch (error) { if (alive.current) setNotice(failure(error)); }
    finally { if (alive.current) { locked.current = false; setBusy(false); } }
  }
  async function submit() {
    if (locked.current || disabled || task) return;
    if (!pending.current) {
      if (!availability.available || !config || !config.availableModelIds.includes(model) || !scopes.length) return;
      pending.current = { expectedActiveVersionId: version.id, scopeKeys: [...scopes], configurationVersionId: config.id, modelId: model, requestId: crypto.randomUUID() };
    }
    locked.current = true; setBusy(true);
    try {
      const next = await api.submitStoryKnowledgeRetry(version.projectId, version.chapterId, pending.current);
      if (!alive.current) return;
      if (!next.id?.trim() || next.id.length > 256 || /[\r\n]/.test(next.id) || next.projectId !== version.projectId || next.chapterId !== version.chapterId || next.input.sourceVersionId !== version.sourceVersionId || next.input.stage !== "story_knowledge") throw new Error("wrong task");
      setTask(next); setUncertain(false); setNotice("重试任务已创建，完成后需手动载入候选并继续审核。");
      const url = new URL(window.location.href); url.searchParams.set("task", next.id); url.searchParams.set("taskProject", version.projectId); url.searchParams.set("taskChapter", version.chapterId); window.history.replaceState(null, "", url);
    } catch (error) {
      if (alive.current) {
        if (error instanceof ApiClientError && error.status >= 400 && error.status < 500) { pending.current = null; setUncertain(false); } else setUncertain(true);
        setNotice(failure(error));
      }
    } finally { if (alive.current) { locked.current = false; setBusy(false); } }
  }
  async function loadResult() {
    if (locked.current || disabled || !task?.result) return;
    locked.current = true; setBusy(true);
    try {
      const [candidate, current, chapter] = await Promise.all([api.getStoryKnowledgeVersion(version.projectId, version.chapterId, task.result.candidateVersionId), api.getStoryKnowledge(version.projectId, version.chapterId), api.getChapter(version.projectId, version.chapterId)]);
      if (!alive.current) return;
      if (candidate.id !== task.result.candidateVersionId || candidate.id !== current.id || candidate.projectId !== version.projectId || candidate.chapterId !== version.chapterId || candidate.extractionJobId !== task.id || candidate.sourceVersionId !== version.sourceVersionId || chapter.activeSourceVersionId !== version.sourceVersionId) {
        setNotice("原文或活动候选已变化，重试结果仅可在任务面板只读查看。"); return;
      }
      onLoaded(candidate);
    } catch (error) { if (alive.current) setNotice(failure(error)); }
    finally { if (alive.current) { locked.current = false; setBusy(false); } }
  }
  async function refreshTask() {
    if (locked.current || disabled || !task) return;
    locked.current = true; setBusy(true);
    try {
      const next = await api.getStoryKnowledgeTask(task.id);
      if (alive.current && next.id === task.id && next.projectId === version.projectId && next.chapterId === version.chapterId) { setTask(next); setNotice("任务状态已刷新，不会重新提交。"); }
    } catch { if (alive.current) setNotice("进度读取失败，请在任务面板核对；不会重新提交。"); }
    finally { if (alive.current) { locked.current = false; setBusy(false); } }
  }
  const origin = version.failures.find(f => scopes.includes(f.scopeKey))?.originJobId;
  const frozen = busy || disabled || uncertain || !!task;
  return <section className="task-resubmit desktop-task-action" aria-label="局部失败重试">
    <h3>局部失败重试</h3>
    {version.failures.map(f => <label key={f.scopeKey}><input type="checkbox" aria-label={f.scopeKey} checked={scopes.includes(f.scopeKey)} disabled={frozen || !f.retryable || !!origin && origin !== f.originJobId} onChange={event => setScopes(old => event.target.checked ? [...old, f.scopeKey] : old.filter(scope => scope !== f.scopeKey))} />{f.scopeKey} · {f.retryable ? "可重试" : "不可重试"} · 来源 {f.originJobId}</label>)}
    <button type="button" className="text-button" disabled={frozen} onClick={() => void readModels()}>读取重试模型</button>
    <label>局部重试模型<select value={model} disabled={frozen || !config} onChange={event => setModel(event.target.value)}><option value="">请明确选择模型</option>{config?.availableModelIds.map(id => <option key={id}>{id}</option>)}</select></label>
    <small>候选基准 {version.id} · 配置 {config?.id ?? "未读取"} · 范围 {scopes.join("、") || "未选择"}</small>
    <p>{availability.note}</p>
    <button type="button" className="button secondary" disabled={busy || disabled || !!task || !uncertain && (!scopes.length || !model || !availability.available)} onClick={() => void submit()}>{uncertain ? "核对原提交" : "提交所选范围重试"}</button>
    {task && <p>任务 {task.id} · {taskPresentation(task).label}</p>}
    {task && <button type="button" className="text-button" disabled={busy || disabled} onClick={() => void refreshTask()}>刷新重试状态</button>}
    {task?.result && <button type="button" className="button primary" disabled={busy || disabled} onClick={() => void loadResult()}>载入重试候选</button>}
    <p role="status">{notice}</p>
  </section>;
}
function failure(error: unknown) {
  if (error instanceof ApiClientError) {
    if (error.status === 409) return "原文、候选或配置已变化，请刷新核对；不会自动重试。";
    if (error.status === 401) return "登录已失效，请重新登录。";
    if (error.status === 403) return "生成受限或权限已变化，请联系负责人。";
    if (error.status === 400) return "所选范围不可重试或属于不同来源任务，请核对。";
    if (error.status === 429) return "排队任务已达上限，请稍后核对。";
    if (error.status === 404) return "章节不存在、无权访问或局部重试尚未启用。";
  }
  return "提交结果可能未知，请先核对原提交或任务列表；不会自动创建另一任务。";
}
