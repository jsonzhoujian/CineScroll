"use client";
import { SettingsReview } from "./settings-review";
import { useEffect,useRef,useState } from "react";
import { ApiClientError,type ApiClient,type ModelConfiguration,type SettingsTask,type SettingsView } from "../lib/api";
type Pending = { requestId: string;configurationVersionId: string;modelId: string };
export function SettingsWorkbench({ api,projectId,chapterId,sourceVersionId,scriptVersionId,planVersionId,knowledgeVersionId }: {
  api: ApiClient;projectId: string;chapterId: string;sourceVersionId: string;scriptVersionId: string;planVersionId: string;knowledgeVersionId: string;
}) {
  const [config,setConfig] = useState<ModelConfiguration | null>(null),[model,setModel] = useState("");
  const [task,setTask] = useState<SettingsTask | null>(null),[history,setHistory] = useState<SettingsTask[]>([]),[cursor,setCursor] = useState<string | null>(null);
  const [view,setView] = useState<SettingsView | null>(null),[assetId,setAssetId] = useState("");
  const [busy,setBusy] = useState(false),[uncertain,setUncertain] = useState(false),[notice,setNotice] = useState("正式剧本已确认，可生成文字设定候选。");
  const alive = useRef(false),locked = useRef(false),pending = useRef<Pending | null>(null);
  const context = JSON.stringify([projectId,chapterId,sourceVersionId,scriptVersionId,planVersionId,knowledgeVersionId]);
  useEffect(() => {
    alive.current = true;
    const url = new URL(window.location.href);
    if (url.searchParams.get("settingsContext") === context) {
      const values = ["settingsRequest","settingsConfig","settingsModel"].map(k => url.searchParams.get(k));
      if (values.every(Boolean)) { pending.current = { requestId: values[0]!,configurationVersionId: values[1]!,modelId: values[2]! };setUncertain(true); }
    }
    if (url.searchParams.get("settingsReviewContext") === context) void act(readCurrent);
    return () => { alive.current = false; };
  },[context]);
  function remember(value: Pending | null,id?: string) {
    const url = new URL(window.location.href);url.searchParams.set("settingsContext",context);
    for (const [key,v] of [["settingsRequest",value?.requestId],["settingsConfig",value?.configurationVersionId],["settingsModel",value?.modelId]] as const) {
      if (v) url.searchParams.set(key,v);else url.searchParams.delete(key);
    }
    if (id) url.searchParams.set("settingsTask",id);
    window.history.replaceState(null,"",url);
  }
  function valid(t: SettingsTask) {
    if (t.projectId !== projectId || t.chapterId !== chapterId || t.input.stage !== "settings" || t.input.resultType !== "settingsContent") throw new Error("WRONG_TASK");
    return t;
  }
  async function act(operation: () => Promise<void>) {
    if (locked.current) return;locked.current = true;setBusy(true);
    try { await operation(); }
    catch (error) { if (alive.current) setNotice(error instanceof ApiClientError && error.status === 401 ? "登录已失效，请重新登录后核对。" : "操作失败，请刷新核对；不会自动重新生成。"); }
    finally { if (alive.current) { locked.current = false;setBusy(false); } }
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
        const availability = await api.settingsAvailability(projectId,chapterId,{ configurationVersionId: pending.current.configurationVersionId,modelId: pending.current.modelId });
        if (!availability.available) { pending.current = null;remember(null);setNotice("设定生成服务或所选模型尚未开放。");return; }
      }
      const next = valid(await api.submitSettingsTask(projectId,chapterId,pending.current));
      if (alive.current) { setTask(next);pending.current = null;remember(null,next.id);setUncertain(false);setNotice("已提交。完成后请明确载入设定候选。"); }
    } catch (error) {
      if (alive.current) {
        if (!reconciling && error instanceof ApiClientError && [400,403,404,409,429].includes(error.status)) { pending.current = null;remember(null); }
        else setUncertain(true);
        setNotice("提交尚未确认，请核对原提交；不会创建另一笔任务。");
      }
    }
  }
  async function refresh(more = false) {
    const url = new URL(window.location.href),id = task?.id ?? (url.searchParams.get("settingsContext") === context ? url.searchParams.get("settingsTask") : null);
    if (id && !more) { const next = valid(await api.getSettingsTask(id));if (next.id !== id) throw new Error("WRONG_TASK");if (alive.current) setTask(next); }
    const page = await api.listSettingsTasks(projectId,chapterId,more ? cursor : null);page.tasks.forEach(valid);
    if (alive.current) { setHistory(old => more ? [...old,...page.tasks.filter(t => !old.some(o => o.id === t.id))] : page.tasks);setCursor(page.nextCursor); }
  }
  async function load() {
    if (task?.state !== "succeeded" || !task.result) return;
    const next = await api.getSettingsGeneration(projectId,chapterId,task.id),v = next.version,ids = task.input.upstreamConfirmedVersionIds;
    if (v.id !== task.result.candidateVersionId || v.jobId !== task.id || v.projectId !== projectId || v.chapterId !== chapterId || v.sourceVersionId !== task.input.sourceVersionId
      || v.scriptVersionId !== ids[0] || v.upstreamConfirmedVersionIds.length !== ids.length || v.upstreamConfirmedVersionIds.some((id,i) => id !== ids[i])
      || next.scriptVersion.id !== v.scriptVersionId || next.scriptVersion.status !== "confirmed" || next.scriptVersion.sourceVersionId !== v.sourceVersionId) {
      if (alive.current) { setView(null);setNotice("结果身份不一致，请重新核对。"); }return;
    }
    if (alive.current) { setView(next);setAssetId("");setNotice(next.current ? "已载入文字设定候选，尚未审核确认。" : "上游已变化，此候选仅供历史追溯。"); }
  }
  async function readCurrent() {
    const next = await api.getSettings(projectId,chapterId),v = next.version;
    if (v.projectId !== projectId || v.chapterId !== chapterId || v.sourceVersionId !== sourceVersionId || v.scriptVersionId !== scriptVersionId
      || v.upstreamConfirmedVersionIds.length !== 3 || v.upstreamConfirmedVersionIds.some((id,i) => id !== [scriptVersionId,planVersionId,knowledgeVersionId][i])
      || next.scriptVersion.id !== v.scriptVersionId || next.scriptVersion.status !== "confirmed" || next.scriptVersion.sourceVersionId !== v.sourceVersionId) throw new Error("WRONG_CONTEXT");
    if (alive.current) {
      setView(next);setAssetId(old => v.assets.some(a => a.id === old) ? old : "");
      const url = new URL(window.location.href);url.searchParams.set("settingsReviewContext",context);window.history.replaceState(null,"",url);
    }
  }
  const selected = view?.version.assets.find(a => a.id === assetId);
  const fragments = selected?.provenance.filter(p => p.type === "source_fragment" && p.sourceVersionId === view?.version.sourceVersionId).map(p => p.fragmentId) ?? [];
  const elements = view?.scriptVersion.elements.filter(e => e.provenance.some(p => p.type === "source_fragment" && fragments.includes(p.fragmentId))) ?? [];
  return <section className="task-panel" aria-label="设定候选生成与追溯">
    <h2>生成文字设定</h2><p role="status">{notice}</p>
    <div className="desktop-task-action">
      <button type="button" disabled={busy || uncertain || !!task || !!view} onClick={() => void act(async () => { const next = (await api.modelConfiguration()).configuration;if (alive.current) { setConfig(next?.tested && next.processingRegion === "mainland" ? next : null);setModel(""); } })}>读取设定模型</button>
      <label>设定模型<select aria-label="设定模型" disabled={busy || uncertain || !!task || !!view} value={model} onChange={e => setModel(e.target.value)}><option value="">选择模型</option>{config?.availableModelIds.map(id => <option key={id}>{id}</option>)}</select></label>
      <button type="button" disabled={busy || (!uncertain && (!model || !!task || !!view))} onClick={() => void act(submit)}>{uncertain ? "核对设定原提交" : "生成文字设定"}</button>
    </div>
    <button type="button" disabled={busy} onClick={() => void act(() => refresh())}>刷新设定任务</button>
    {history.map(t => <button type="button" key={t.id} disabled={busy || uncertain} onClick={() => { setTask(t);setView(null);remember(null,t.id); }}>{t.id} · {t.state}</button>)}
    {cursor && <button type="button" disabled={busy} onClick={() => void act(() => refresh(true))}>更多设定任务</button>}
    {task && <p>设定任务：{task.state} {task.reason} {task.result?.extractionStatus}{task.reason === "EXECUTION_UNCERTAIN" ? " · 结果待后台核对，请勿重复生成。" : ""}</p>}
    <button type="button" disabled={busy || uncertain || task?.state !== "succeeded" || !task.result} onClick={() => void act(load)}>载入设定候选</button>
    <button type="button" disabled={busy} onClick={() => void act(readCurrent)}>读取当前设定</button>
    {view && <><p>设定版本 {view.version.id} · {view.version.generationStatus}</p>{view.version.failures.map(f => <p key={f.scopeKey}>失败范围 {f.scopeKey} · {f.code}</p>)}
      <SettingsReview api={api} projectId={projectId} chapterId={chapterId} context={context} view={view} selectedId={assetId} disabled={busy || uncertain} run={act} onChanged={readCurrent} />
      {view.version.assets.map(a => <button type="button" key={a.id} aria-pressed={a.id === assetId} onClick={() => setAssetId(a.id)}>{a.name}</button>)}
      {selected && <><article aria-label="文字设定内容"><h3>{selected.name}</h3><dl>{Object.entries(selected.visibleDefinition).map(([key,value]) => <div key={key}><dt>{key}</dt><dd>{typeof value === "string" ? value : JSON.stringify(value)}</dd></div>)}</dl><p>{selected.state}</p><p>状态变化：{selected.stateChanges.join("；") || "无"}</p><p>限制：{selected.restrictions.join("；") || "无"}</p></article>
        <aside aria-label="设定原文依据"><h3>原文依据</h3>{fragments.map((id,i) => <p key={i}>{view.sourceFragments.find(f => f.id === id)?.text ?? "原文不可用"}</p>)}</aside>
        <aside aria-label="设定剧本依据"><h3>正式剧本依据 · {view.scriptVersion.id}</h3>{elements.length ? elements.map(e => <p key={e.id}>{e.text}</p>) : <p>没有共享原文片段的剧本元素。</p>}</aside></>}
    </>}
  </section>;
}
