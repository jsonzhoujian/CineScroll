"use client";
import { useEffect, useRef, useState } from "react";
import { ApiClientError, type ApiClient, type ScriptContentTask, type ScriptContentView, type ModelConfiguration } from "../lib/api";

type Pending = { requestId: string;configurationVersionId: string;modelId: string };
export function ScriptContentWorkbench({ api,projectId,chapterId,sourceVersionId,planVersionId,knowledgeVersionId }: {
  api: ApiClient;projectId: string;chapterId: string;sourceVersionId: string;planVersionId: string;knowledgeVersionId: string;
}) {
  const [config,setConfig] = useState<ModelConfiguration | null>(null),[model,setModel] = useState("");
  const [task,setTask] = useState<ScriptContentTask | null>(null),[history,setHistory] = useState<ScriptContentTask[]>([]);
  const [view,setView] = useState<ScriptContentView | null>(null),[elementId,setElementId] = useState("");
  const [busy,setBusy] = useState(false),[uncertain,setUncertain] = useState(false),[notice,setNotice] = useState("拆集已确认，可选择模型生成剧本候选。");
  const alive = useRef(true),locked = useRef(false),pending = useRef<Pending | null>(null);
  const context = JSON.stringify([projectId,chapterId,sourceVersionId,planVersionId,knowledgeVersionId]);
  useEffect(() => {
    alive.current = true;
    const url = new URL(window.location.href);
    if (url.searchParams.get("scriptContext") === context) {
      const values = ["scriptRequest","scriptConfig","scriptModel"].map(k => url.searchParams.get(k));
      if (values.every(Boolean)) { pending.current = { requestId: values[0]!,configurationVersionId: values[1]!,modelId: values[2]! }; setUncertain(true); }
    }
    return () => { alive.current = false; };
  },[context]);
  function remember(value: Pending | null,id?: string) {
    const url = new URL(window.location.href); url.searchParams.set("scriptContext",context);
    for (const [key,v] of [["scriptRequest",value?.requestId],["scriptConfig",value?.configurationVersionId],["scriptModel",value?.modelId]] as const) {
      if (v) url.searchParams.set(key,v); else url.searchParams.delete(key);
    }
    if (id) url.searchParams.set("scriptTask",id);
    window.history.replaceState(null,"",url);
  }
  function valid(t: ScriptContentTask) {
    if (t.projectId !== projectId || t.chapterId !== chapterId || t.input.resultType !== "scriptContent" || t.input.stage !== "script") throw new Error("wrong task");
    return t;
  }
  async function act(operation: () => Promise<void>) {
    if (locked.current) return; locked.current = true; setBusy(true);
    try { await operation(); }
    catch (error) { if (alive.current) setNotice(error instanceof ApiClientError && error.status === 401 ? "登录已失效，请重新登录后核对。" : "操作失败，请核对；不会自动重新生成。"); }
    finally { if (alive.current) { locked.current = false; setBusy(false); } }
  }
  async function submit() {
    const reconciling = !!pending.current;
    if (!pending.current) {
      if (!config || !model || task || view) return;
      pending.current = { requestId: crypto.randomUUID(),configurationVersionId: config.id,modelId: model };
    }
    remember(pending.current);
    try {
      if (!reconciling) {
        const availability = await api.scriptContentAvailability(projectId,chapterId,{ configurationVersionId: pending.current!.configurationVersionId,modelId: pending.current!.modelId });
        if (!availability.available) { pending.current = null; remember(null); setNotice("剧本生成服务或所选模型尚未开放。"); return; }
      }
      const next = valid(await api.submitScriptContentTask(projectId,chapterId,pending.current!));
      if (alive.current) { setTask(next); pending.current = null; remember(null,next.id); setUncertain(false); setNotice("已提交。完成后请明确载入候选。"); }
    } catch (error) {
      if (alive.current) {
        if (!reconciling && error instanceof ApiClientError && [400,403,404,409,429].includes(error.status)) { pending.current = null; remember(null); }
        else setUncertain(true);
        setNotice("提交尚未确认。结果未知时请核对原提交。");
      }
    }
  }
  async function refresh() {
    const url = new URL(window.location.href),id = task?.id ?? (url.searchParams.get("scriptContext") === context ? url.searchParams.get("scriptTask") : null);
    if (id) { const next = valid(await api.getScriptContentTask(id)); if (alive.current) setTask(next); }
    const page = await api.listScriptContentTasks(projectId,chapterId); page.tasks.forEach(valid);
    if (alive.current) setHistory(page.tasks);
  }
  async function load() {
    if (!task?.result || task.state !== "succeeded") return;
    const next = await api.getScriptContent(projectId,chapterId),v = next.version;
    if (!next.current || v.projectId !== projectId || v.chapterId !== chapterId || v.jobId !== task.id || v.id !== task.result.candidateVersionId
      || v.sourceVersionId !== sourceVersionId || v.planVersionId !== planVersionId || task.input.upstreamConfirmedVersionIds[1] !== knowledgeVersionId) {
      if (alive.current) { setView(null); setNotice("结果或上游已变化，请重新核对。"); } return;
    }
    if (alive.current) { setView(next); setNotice("已载入剧本候选，尚未正式确认。"); }
  }
  const selected = view?.version.elements.find(e => e.id === elementId);
  return <section className="task-panel" aria-label="剧本候选生成与追溯">
    <h2>生成剧本候选</h2><p role="status">{notice}</p>
    <div className="desktop-task-action">
      <button type="button" disabled={busy || uncertain || !!task || !!view} onClick={() => void act(async () => { const next = (await api.modelConfiguration()).configuration; if (alive.current) { setConfig(next?.tested && next.processingRegion === "mainland" ? next : null); setModel(""); } })}>读取剧本模型</button>
      <label>剧本模型<select disabled={busy || uncertain || !!task || !!view} value={model} onChange={e => setModel(e.target.value)}><option value="">选择模型</option>{config?.availableModelIds.map(id => <option key={id}>{id}</option>)}</select></label>
      <button type="button" disabled={busy || (!uncertain && (!model || !!task || !!view))} onClick={() => void act(submit)}>{uncertain ? "核对剧本原提交" : "生成剧本候选"}</button>
    </div>
    <button type="button" disabled={busy} onClick={() => void act(refresh)}>刷新剧本任务</button>
    {history.map(t => <button type="button" key={t.id} disabled={busy || uncertain} onClick={() => { setTask(t); setView(null); remember(null,t.id); }}>{t.id} · {t.state}</button>)}
    {task && <p>剧本任务：{task.state} {task.reason} {task.result?.extractionStatus}</p>}
    <button type="button" disabled={busy || task?.state !== "succeeded" || !task.result} onClick={() => void act(load)}>载入剧本候选</button>
    {view && <><p>剧本版本 {view.version.id} · {view.version.generationStatus}</p>{view.version.failures.map(f => <p key={f.scopeKey}>失败范围 {f.scopeKey} · {f.code}</p>)}
      {view.version.scenes.map(scene => <section key={scene.id}><h3>{scene.title}</h3>{view.version.elements.filter(e => e.sceneId === scene.id).map(e => <button type="button" key={e.id} aria-pressed={elementId === e.id} onClick={() => setElementId(e.id)}>{e.text}</button>)}</section>)}
      {selected && <aside aria-label="剧本原文依据"><h3>原文依据</h3>{selected.provenance.map((p,i) => <article key={i}><small>{p.transformation ?? "已批准改编新增"}</small><p>{p.type === "source_fragment" ? view.sourceFragments.find(f => f.id === p.fragmentId)?.text ?? "原文不可用" : p.additionId}</p></article>)}</aside>}
    </>}
  </section>;
}
