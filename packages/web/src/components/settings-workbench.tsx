"use client";
import { SettingsReconciliation } from "./settings-reconciliation";
import { SettingsRegeneration,readSettingsRegenerationSubmission } from "./settings-regeneration";
import { SettingsReview } from "./settings-review";
import { useEffect,useRef,useState } from "react";
import { ApiClientError,type ApiClient,type ModelConfiguration,type SettingsTask,type SettingsView } from "../lib/api";
type Pending = { requestId: string;configurationVersionId: string;modelId: string };
export function SettingsWorkbench({ api,projectId,chapterId,sourceVersionId,scriptVersionId,planVersionId,knowledgeVersionId,readOnly = false }: {
  api: ApiClient;projectId: string;chapterId: string;sourceVersionId: string;scriptVersionId: string;planVersionId: string;knowledgeVersionId: string;readOnly?: boolean;
}) {
  const [config,setConfig] = useState<ModelConfiguration | null>(null),[model,setModel] = useState("");
  const [task,setTask] = useState<SettingsTask | null>(null),[history,setHistory] = useState<SettingsTask[]>([]),[cursor,setCursor] = useState<string | null>(null);
  const [view,setView] = useState<SettingsView | null>(null),[assetId,setAssetId] = useState("");
  const [busy,setBusy] = useState(false),[uncertain,setUncertain] = useState(false),[notice,setNotice] = useState(readOnly ? "上游已变化，可读取历史设定及影响记录。" : "正式剧本已确认，可生成文字设定候选。");
  const [reconciliationBlocked,setReconciliationBlocked] = useState(false);
  const [reviewBlocked,setReviewBlocked] = useState(false),[regenerationBlocked,setRegenerationBlocked] = useState(false);
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
    if (readOnly) return;
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
    const next = await api.getSettings(projectId,chapterId);
    let saved: ReturnType<typeof readSettingsRegenerationSubmission> = null;
    try { saved = readSettingsRegenerationSubmission(context); } catch { next.active = false; }
    if (saved?.context === context && next.version.sourceVersionId === sourceVersionId
      && next.version.scriptVersionId === scriptVersionId && next.version.id !== saved.submission.selection.expectedActiveVersionId) {
      const baseline = (await api.getSettingsVersion(projectId,chapterId,saved.submission.selection.expectedActiveVersionId)).version;
      if (baseline.id !== saved.submission.selection.expectedActiveVersionId) throw new Error("WRONG_REGENERATION_BASELINE");
      if (baseline.sourceVersionId !== next.version.sourceVersionId || baseline.scriptVersionId !== next.version.scriptVersionId
        || baseline.upstreamConfirmedVersionIds.length !== next.version.upstreamConfirmedVersionIds.length
        || baseline.upstreamConfirmedVersionIds.some((id,i) => id !== next.version.upstreamConfirmedVersionIds[i])) throw new Error("WRONG_REGENERATION_BASELINE");
      next.version = baseline;
      const impactView = await api.getSettingsImpacts(projectId,chapterId,baseline.id);
      if (impactView.versionId !== baseline.id) throw new Error("WRONG_IMPACT_VERSION");
      next.impacts = impactView.impacts;
      next.active = false;
    }
    const v = next.version;
    if (v.projectId !== projectId || v.chapterId !== chapterId || v.upstreamConfirmedVersionIds.length !== 3 || v.upstreamConfirmedVersionIds[0] !== v.scriptVersionId
      || next.current && (v.sourceVersionId !== sourceVersionId || v.scriptVersionId !== scriptVersionId || v.upstreamConfirmedVersionIds.some((id,i) => id !== [scriptVersionId,planVersionId,knowledgeVersionId][i]))
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
      <button type="button" disabled={readOnly || busy || uncertain || !!task || !!view} onClick={() => void act(async () => { const next = (await api.modelConfiguration()).configuration;if (alive.current) { setConfig(next?.tested && next.processingRegion === "mainland" ? next : null);setModel(""); } })}>读取设定模型</button>
      <label>设定模型<select aria-label="设定模型" disabled={readOnly || busy || uncertain || !!task || !!view} value={model} onChange={e => setModel(e.target.value)}><option value="">选择模型</option>{config?.availableModelIds.map(id => <option key={id}>{id}</option>)}</select></label>
      <button type="button" disabled={readOnly || busy || (!uncertain && (!model || !!task || !!view))} onClick={() => void act(submit)}>{uncertain ? "核对设定原提交" : "生成文字设定"}</button>
    </div>
    <button type="button" disabled={busy} onClick={() => void act(() => refresh())}>刷新设定任务</button>
    {history.map(t => <button type="button" key={t.id} disabled={busy || uncertain || regenerationBlocked || reviewBlocked || reconciliationBlocked} onClick={() => { setTask(t);setView(null);remember(null,t.id); }}>{t.id} · {t.state}</button>)}
    {cursor && <button type="button" disabled={busy} onClick={() => void act(() => refresh(true))}>更多设定任务</button>}
    {task && <p>设定任务：{task.state} {task.reason} {task.result?.extractionStatus}{task.reason === "EXECUTION_UNCERTAIN" ? " · 结果待后台核对，请勿重复生成。" : ""}</p>}
    <button type="button" disabled={busy || uncertain || task?.state !== "succeeded" || !task.result} onClick={() => void act(load)}>载入设定候选</button>
    <button type="button" disabled={busy} onClick={() => void act(readCurrent)}>读取当前设定</button>
    {view && <><p>设定版本 {view.version.id} · {view.version.generationStatus}</p>{view.version.failures.map(f => <p key={f.scopeKey}>失败范围 {f.scopeKey} · {f.code}</p>)}
      <aside aria-label="设定上游影响"><h3>上游影响核对</h3>
        {!view.current && <p>原文或确认上游已变化，当前设定仅供追溯；不会自动覆盖或重做。</p>}
        {view.impacts == null ? <p>影响记录尚未读取，不能据此判定无影响。</p> : view.impacts.length ? <><p>以下设定待核对，内容及锁保持不变。</p>{view.impacts.map((i,n) => <p key={n}>{view.version.assets.find(a => a.id === i.target_item_id)?.name ?? i.target_item_id} · 来源剧本 {i.source_version_id} / {i.source_element_id} → 新确认剧本 {i.confirmed_version_id} · 待核对{Object.hasOwn(view.version.locks ?? {},i.target_item_id) ? " · 已锁定，替换前需明确解锁" : ""}</p>)}</> : <p>尚无已记录的剧本影响；原文与其他上游变化仍以上方状态为准。</p>}
      </aside>
      <SettingsReconciliation api={api} projectId={projectId} chapterId={chapterId} context={context} view={view} disabled={readOnly || busy || uncertain || reviewBlocked || regenerationBlocked} readDisabled={busy} run={act} onChanged={readCurrent} onBlockedChange={setReconciliationBlocked} />
      <SettingsReview api={api} projectId={projectId} chapterId={chapterId} context={context} view={view} selectedId={assetId} disabled={readOnly || busy || uncertain || regenerationBlocked || reconciliationBlocked} readDisabled={busy} run={act} onChanged={readCurrent} onBlockedChange={setReviewBlocked} />
      <SettingsRegeneration api={api} projectId={projectId} chapterId={chapterId} context={context} view={view} disabled={readOnly || busy || uncertain || reviewBlocked || reconciliationBlocked} readDisabled={busy} run={act} onBlockedChange={setRegenerationBlocked} onLoaded={next => { setView(next);setAssetId(old => next.version.assets.some(a => a.id === old) ? old : ""); }} />
      {view.version.assets.map(a => <button type="button" key={a.id} aria-pressed={a.id === assetId} onClick={() => setAssetId(a.id)}>{a.name}</button>)}
      {selected && <><article aria-label="文字设定内容"><h3>{selected.name}</h3><dl>{Object.entries(selected.visibleDefinition).map(([key,value]) => <div key={key}><dt>{key}</dt><dd>{typeof value === "string" ? value : JSON.stringify(value)}</dd></div>)}</dl><p>{selected.state}</p><p>状态变化：{selected.stateChanges.join("；") || "无"}</p><p>限制：{selected.restrictions.join("；") || "无"}</p></article>
        <aside aria-label="设定原文依据"><h3>原文依据</h3>{fragments.map((id,i) => <p key={i}>{view.sourceFragments.find(f => f.id === id)?.text ?? "原文不可用"}</p>)}</aside>
        <aside aria-label="设定剧本依据"><h3>正式剧本依据 · {view.scriptVersion.id}</h3>{elements.length ? elements.map(e => <p key={e.id}>{e.text}</p>) : <p>没有共享原文片段的剧本元素。</p>}</aside></>}
    </>}
  </section>;
}
