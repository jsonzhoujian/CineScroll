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
  const [replacement,setReplacement] = useState(""),[reason,setReason] = useState(""),[reviewUnknown,setReviewUnknown] = useState(false);
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
    if (url.searchParams.get("scriptReviewContext") === context && url.searchParams.get("scriptReviewLoaded") === "1") {
      setElementId(url.searchParams.get("scriptElement") ?? "");
      void act(readCurrent);
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
    if (alive.current) { setView(next); rememberCursor(next); setNotice("已载入剧本候选，尚未正式确认。"); }
  }
  function rememberCursor(next: ScriptContentView,selectedId = elementId) {
    const url = new URL(window.location.href); url.searchParams.set("scriptReviewContext",context); url.searchParams.set("scriptReviewLoaded","1");
    const element = next.version.elements.find(e => e.id === selectedId);
    for (const [key,value] of [["scriptElement",element?.id],["scriptScene",element?.sceneId],["scriptFragment",element?.provenance.find(p => p.type === "source_fragment")?.fragmentId]] as const) {
      if (value) url.searchParams.set(key,value); else url.searchParams.delete(key);
    }
    window.history.replaceState(null,"",url);
  }
  async function readCurrent() {
    const next = await api.getScriptContent(projectId,chapterId);
    if (!next.current || next.version.projectId !== projectId || next.version.chapterId !== chapterId || next.version.sourceVersionId !== sourceVersionId || next.version.planVersionId !== planVersionId) throw new Error("stale context");
    if (alive.current) { setView(next); setReviewUnknown(false); setReplacement(""); setReason(""); rememberCursor(next,new URL(window.location.href).searchParams.get("scriptElement") ?? elementId); }
  }
  async function review(kind: "edit" | "suggest" | "decide",suggestionId?: string,decision?: "accepted" | "rejected") {
    if (!view || reviewUnknown || !reason.trim()) return;
    const command = { kind,requestId: crypto.randomUUID(),expectedActiveVersionId: view.version.id,reason: reason.trim(),
      ...(kind === "decide" ? { suggestionId,decision } : { elementId,text: replacement }) };
    try {
      await api.reviewScriptContent(projectId,chapterId,command);
      await readCurrent();
      if (alive.current) setNotice("修改已保存为新候选版本，原文依据保留。");
    } catch (error) {
      if (alive.current) {
        setReviewUnknown(true);
        setNotice(error instanceof ApiClientError && error.status === 409 ? "版本或目标内容已变化，请读取当前剧本后核对。" : "修改结果待核对，请读取当前剧本；不会自动重复提交。");
      }
    }
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
    <button type="button" disabled={busy} onClick={() => void act(readCurrent)}>读取当前剧本</button>
    {view && <><p>剧本版本 {view.version.id} · {view.version.generationStatus}</p>{view.version.failures.map(f => <p key={f.scopeKey}>失败范围 {f.scopeKey} · {f.code}</p>)}
      {view.version.scenes.map(scene => <section key={scene.id}><h3>{scene.title}</h3>{view.version.elements.filter(e => e.sceneId === scene.id).map(e => <button type="button" key={e.id} aria-pressed={elementId === e.id} onClick={() => { setElementId(e.id); setReplacement(e.text); setReason(""); rememberCursor(view,e.id); }}>{e.text}</button>)}</section>)}
      {selected && <aside aria-label="剧本原文依据"><h3>原文依据</h3>{selected.provenance.map((p,i) => <article key={i}><small>{p.transformation ?? "已批准改编新增"}</small><p>{p.type === "source_fragment" ? view.sourceFragments.find(f => f.id === p.fragmentId)?.text ?? "原文不可用" : p.additionId}</p></article>)}</aside>}
      {selected && <div className="desktop-task-action" aria-label="剧本候选编辑">
        <label>替换内容<textarea value={replacement} maxLength={20000} onChange={e => setReplacement(e.target.value)} disabled={busy || reviewUnknown} /></label>
        <label>修改理由<input value={reason} maxLength={2000} onChange={e => setReason(e.target.value)} disabled={busy || reviewUnknown} /></label>
        {view.permissions?.canEdit && <button type="button" disabled={busy || reviewUnknown || !replacement.trim() || !reason.trim()} onClick={() => void act(() => review("edit"))}>保存候选修改</button>}
        {view.permissions?.canSuggest && <button type="button" disabled={busy || reviewUnknown || !replacement.trim() || !reason.trim()} onClick={() => void act(() => review("suggest"))}>提交剧本建议</button>}
      </div>}
      <section aria-label="剧本修改建议">{view.version.suggestions?.map(s => <article key={s.id}><p>{s.text}</p><small>{s.reason} · {s.status} · {s.submittedBy}</small>
        {s.status === "pending" && view.permissions?.canDecide && <><label>建议裁决理由 {s.id}<input value={reason} maxLength={2000} onChange={e => setReason(e.target.value)} disabled={busy || reviewUnknown} /></label>
          <button type="button" disabled={busy || reviewUnknown || !reason.trim()} onClick={() => void act(() => review("decide",s.id,"accepted"))}>接受剧本建议 {s.id}</button>
          <button type="button" disabled={busy || reviewUnknown || !reason.trim()} onClick={() => void act(() => review("decide",s.id,"rejected"))}>拒绝剧本建议 {s.id}</button></>}
      </article>)}</section>
    </>}
  </section>;
}
