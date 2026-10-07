"use client";
import { useEffect, useRef, useState } from "react";
import { ApiClientError, type ApiClient, type EpisodeTask, type EpisodePlanView, type ModelConfiguration } from "../lib/api";
import { taskPresentation } from "../lib/task-status";

type Pending = { configurationVersionId: string; modelId: string; requestId: string };
export function EpisodePlanTaskPanel({ api,projectId,chapterId,sourceVersionId,knowledgeVersionId,disabled,hasPlan,onBusy,onLoaded }: {
  api: ApiClient; projectId: string; chapterId: string; sourceVersionId: string; knowledgeVersionId: string; disabled: boolean; hasPlan: boolean;
  onBusy(busy: boolean): void; onLoaded(view: EpisodePlanView): void;
}) {
  const [config,setConfig] = useState<ModelConfiguration | null>(null),[model,setModel] = useState(""),[available,setAvailable] = useState(false);
  const [busy,setBusy] = useState(false),[uncertain,setUncertain] = useState(false),[task,setTask] = useState<EpisodeTask | null>(null);
  const [history,setHistory] = useState<EpisodeTask[]>([]),[cursor,setCursor] = useState<string | null>(null);
  const [notice,setNotice] = useState("明确选择模型后提交；候选生成不等于正式确认。可手动刷新后台状态。");
  const alive = useRef(true),locked = useRef(false),pending = useRef<Pending | null>(null);
  const context = JSON.stringify([projectId,chapterId,sourceVersionId,knowledgeVersionId]);
  useEffect(() => {
    alive.current = true;
    const q = new URL(window.location.href).searchParams;
    if (q.get("episodeContext") === context && q.get("episodeRequest") && q.get("episodeConfig") && q.get("episodeModel")) {
      pending.current = { requestId: q.get("episodeRequest")!,configurationVersionId: q.get("episodeConfig")!,modelId: q.get("episodeModel")! };
      setUncertain(true); setNotice("上次提交结果待核对，请使用原请求核对，不要创建新请求。");
    }
    return () => { alive.current = false; };
  },[context]);
  function remember(next: Pending | null,taskId?: string) {
    const url = new URL(window.location.href); url.searchParams.set("episodeContext",context);
    for (const [key,value] of [["episodeRequest",next?.requestId],["episodeConfig",next?.configurationVersionId],["episodeModel",next?.modelId]] as const) {
      if (value) url.searchParams.set(key,value); else url.searchParams.delete(key);
    }
    if (taskId) url.searchParams.set("episodeTask",taskId);
    window.history.replaceState(null,"",url);
  }
  function valid(next: EpisodeTask) {
    if (!next.id?.trim() || next.id.length > 256 || /[\r\n]/.test(next.id) || next.projectId !== projectId || next.chapterId !== chapterId || next.input?.stage !== "script" || next.input.resultType !== "episodePlan"
      || !Array.isArray(next.input.upstreamConfirmedVersionIds) || next.input.upstreamConfirmedVersionIds.length !== 1 || !next.input.upstreamConfirmedVersionIds[0]?.trim()) throw new Error("wrong task");
    return next;
  }
  async function action(operation: () => Promise<void>) {
    if (locked.current || disabled) return;
    locked.current = true; setBusy(true); onBusy(true);
    try { await operation(); }
    catch (error) { if (alive.current) setNotice(error instanceof ApiClientError && error.status === 401 ? "登录已失效，请重新登录。" : "读取或操作失败，请核对；不会自动重试或确认。"); }
    finally { if (alive.current) { locked.current = false; setBusy(false); onBusy(false); } }
  }
  async function choose(id: string) {
    if (locked.current || disabled || uncertain || task || hasPlan) return;
    setModel(id); setAvailable(false);
    if (!config || !config.availableModelIds.includes(id)) return;
    await action(async () => {
      const status = await api.episodeAvailability(projectId,chapterId,{ configurationVersionId: config.id,modelId: id });
      if (alive.current) { setAvailable(status.available); setNotice(status.available ? "模型准入通过，可明确提交拆集候选。" : "拆集服务或所选厂商未开放，请联系负责人。"); }
    });
  }
  async function submit() {
    if (task || hasPlan && !pending.current) return;
    if (!pending.current) {
      if (!config || !available || !config.availableModelIds.includes(model)) return;
      pending.current = { configurationVersionId: config.id,modelId: model,requestId: crypto.randomUUID() };
    }
    await action(async () => {
      remember(pending.current);
      try {
        const next = valid(await api.submitEpisodeTask(projectId,chapterId,pending.current!));
        if (next.input.sourceVersionId !== sourceVersionId || next.input.upstreamConfirmedVersionIds.length !== 1 || next.input.upstreamConfirmedVersionIds[0] !== knowledgeVersionId) throw new Error("wrong snapshot");
        if (alive.current) { setTask(next); setUncertain(false); pending.current = null; remember(null,next.id); setNotice("任务已提交；请刷新状态，完成后明确载入候选。不会自动确认。"); }
      } catch (error) {
        if (alive.current) {
          if (!uncertain && error instanceof ApiClientError && [400,403,404,409,429].includes(error.status)) { pending.current = null; remember(null); setUncertain(false); }
          else setUncertain(true);
          setNotice(error instanceof ApiClientError && error.status === 401 ? "登录已失效；原请求标识已保留，重新登录后核对原提交。" : "提交未获明确成功。结果未知时只能核对原提交；不会自动重投。");
        }
      }
    });
  }
  async function readTasks(more = false) {
    await action(async () => {
      const q = new URL(window.location.href).searchParams;
      if (!more && q.get("episodeContext") === context && q.get("episodeTask")) {
        const next = valid(await api.getEpisodeTask(q.get("episodeTask")!)); if (alive.current) setTask(next);
      }
      const page = await api.listEpisodeTasks(projectId,chapterId,more ? cursor : null);
      page.tasks.forEach(valid);
      if (alive.current) { setHistory(old => more ? [...old,...page.tasks.filter(t => !old.some(o => o.id === t.id))] : page.tasks); setCursor(page.nextCursor); setNotice("已读取任务记录，选择后可刷新状态；不会重新提交。"); }
    });
  }
  async function load() {
    if (!task?.result || task.state !== "succeeded") return;
    await action(async () => {
      const view = await api.getEpisodePlan(projectId,chapterId),plan = view.plan;
      if (!alive.current) return;
      if (!view.current || plan.id !== task.result!.candidateVersionId || plan.generationJobId !== task.id || plan.projectId !== projectId || plan.chapterId !== chapterId
        || plan.sourceVersionId !== sourceVersionId || plan.storyBibleVersionId !== knowledgeVersionId || task.input.sourceVersionId !== sourceVersionId || task.input.upstreamConfirmedVersionIds[0] !== knowledgeVersionId) {
        setNotice("原文、知识或活动方案已变化，不会用旧任务结果替换当前审核内容。"); return;
      }
      onLoaded(view); setNotice("候选已载入，请继续审核并明确确认。");
    });
  }
  const frozen = busy || disabled || uncertain || !!task || hasPlan;
  return <section className="episode-task" aria-label="拆集生成任务">
    <h3>拆集生成 · 先候选，后审核</h3>
    <div className="desktop-task-action">
      <button type="button" className="text-button" disabled={frozen} onClick={() => void action(async () => {
        const next = (await api.modelConfiguration()).configuration;
        if (alive.current) { setConfig(next?.tested && next.processingRegion === "mainland" ? next : null); setModel(""); setAvailable(false); setNotice(next?.tested && next.processingRegion === "mainland" ? "请选择已测试模型。" : "请由负责人配置并测试大陆模型。"); }
      })}>读取拆集模型</button>
      <label>拆集模型<select value={model} disabled={frozen || !config} onChange={e => void choose(e.target.value)}><option value="">请明确选择模型</option>{config?.availableModelIds.map(id => <option key={id}>{id}</option>)}</select></label>
      {config && <small>厂商 {config.providerId} · 配置 {config.id} · 大陆处理 · 不在浏览器读取 Key</small>}
      <button type="button" className="button secondary" disabled={busy || disabled || !!task || hasPlan && !uncertain || !uncertain && !available} onClick={() => void submit()}>{uncertain ? "核对拆集原提交" : "生成拆集候选"}</button>
    </div>
    <button type="button" className="text-button" disabled={busy || disabled || uncertain} onClick={() => void readTasks()}>读取拆集任务</button>
    {history.map(t => <button type="button" className="text-button" key={t.id} disabled={busy || disabled || uncertain} onClick={() => { setTask(t); remember(null,t.id); }}>任务 {t.id}</button>)}
    {cursor && <button type="button" className="text-button" disabled={busy || disabled || uncertain} onClick={() => void readTasks(true)}>更多拆集任务</button>}
    {task && <><p>任务 {task.id} · {taskPresentation(task).label}</p><small>{task.reason === "EXECUTION_UNCERTAIN" ? "执行结果未知，禁止重投，请联系负责人对账。" : "状态不代表正式验收；不会自动重投或确认。"}</small>
      <button type="button" className="text-button" disabled={busy || disabled} onClick={() => void action(async () => { const next = valid(await api.getEpisodeTask(task.id)); if (next.id !== task.id) throw new Error("wrong id"); if (alive.current) setTask(next); })}>刷新拆集状态</button>
      {task.state === "succeeded" && task.result && <button type="button" className="button primary" disabled={busy || disabled} onClick={() => void load()}>载入拆集候选</button>}</>}
    <p role="status">{notice}</p>
  </section>;
}
