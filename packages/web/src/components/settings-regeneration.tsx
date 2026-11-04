"use client";
import { useEffect,useRef,useState } from "react";
import { ApiClientError,type ApiClient,type ModelConfiguration,type SettingsRegenerationSubmission,type SettingsRegenerationTask,type SettingsView } from "../lib/api";
export function SettingsRegeneration({ api,projectId,chapterId,context,view,disabled,readDisabled = disabled,run,onLoaded,onBlockedChange }: {
  api: ApiClient;projectId: string;chapterId: string;context: string;view: SettingsView;disabled: boolean;readDisabled?: boolean;
  run(f: () => Promise<void>): Promise<void>;onLoaded(v: SettingsView): void;onBlockedChange(v: boolean): void;
}) {
  const [assets,setAssets] = useState<string[]>([]),[failures,setFailures] = useState<string[]>([]),[reason,setReason] = useState("");
  const [config,setConfig] = useState<ModelConfiguration | null>(null),[model,setModel] = useState("");
  const [pending,setPending] = useState<SettingsRegenerationSubmission | null>(null),[task,setTask] = useState<SettingsRegenerationTask | null>(null);
  const [restoring,setRestoring] = useState(true),[missing,setMissing] = useState(false),[notice,setNotice] = useState("只重生明确选择的未锁定目标，完成后需重新审核确认。");
  const alive = useRef(false),key = JSON.stringify(["settings-regeneration",context]);
  useEffect(() => {
    alive.current = true;
    try {
      const saved = readSettingsRegenerationSubmission(context);
      if (saved) { setPending(saved);setNotice("有待核对的局部重生提交；刷新不会重新发送。"); }
      setRestoring(false);
    } catch { setNotice("无法读取重生提交身份，请人工核对，暂停新的重生操作。"); }
    return () => { alive.current = false; };
  },[key]);
  useEffect(() => { onBlockedChange(restoring || !!pending); },[restoring,pending,onBlockedChange]);
  useEffect(() => { setAssets([]);setFailures([]);setReason(""); },[view.version.id]);
  const eligible = view.current && view.active === true && view.permissions?.canDecide === true;
  const blocked = disabled || restoring || !!pending || !eligible;
  const unavailableAsset = (id: string) => Object.hasOwn(view.version.locks ?? {},id) || !!view.version.suggestions?.some(s => s.assetId === id && s.status === "pending");
  function save(value: SettingsRegenerationSubmission | null) {
    if (value) sessionStorage.setItem(key,JSON.stringify(value));else sessionStorage.removeItem(key);
    if (alive.current) setPending(value);
  }
  function validTask(t: SettingsRegenerationTask,p: SettingsRegenerationSubmission) {
    const v = view.version,ids = v.upstreamConfirmedVersionIds,s = t.input.regeneration;
    if (t.projectId !== projectId || t.chapterId !== chapterId || t.input.stage !== "settings" || t.input.resultType !== "settingsRegeneration" || t.input.sourceVersionId !== v.sourceVersionId
      || t.input.upstreamConfirmedVersionIds.length !== ids.length || t.input.upstreamConfirmedVersionIds.some((id,i) => id !== ids[i])
      || !s || s.expectedActiveVersionId !== p.selection.expectedActiveVersionId || s.reason !== p.selection.reason || !same(s.assetIds,p.selection.assetIds) || !same(s.failureScopeKeys,p.selection.failureScopeKeys)) throw new Error("WRONG_REGENERATION_TASK");
    return t;
  }
  async function send(original?: SettingsRegenerationSubmission) {
    if (!original && (blocked || !config || !model || !reason.trim() || !assets.length && !failures.length)) return;
    const body = original ?? { requestId: crypto.randomUUID(),configurationVersionId: config!.id,modelId: model,selection: { expectedActiveVersionId: view.version.id,assetIds: [...assets].sort(),failureScopeKeys: [...failures].sort(),reason: reason.trim() } };
    let posted = false;
    try {
      if (!original) {
        const availability = await api.settingsRegenerationAvailability(projectId,chapterId,{ configurationVersionId: body.configurationVersionId,modelId: body.modelId,selection: body.selection });
        if (!availability.available) { if (alive.current) setNotice("局部重生服务或所选模型尚未开放。");return; }
        if (!alive.current) return;
        save(body);
      }
      posted = true;
      const t = validTask(await api.submitSettingsRegeneration(projectId,chapterId,body),body);
      if (alive.current) { setTask(t);setMissing(false);setNotice("已提交局部重生。请核对进度，完成后明确载入结果。"); }
    } catch (error) {
      if (!alive.current) return;
      if (!original && posted && error instanceof ApiClientError && [400,403,404,409,429].includes(error.status)) {
        save(null);setNotice("重生提交已拒绝，请读取当前设定并核对权限、锁及目标。");
      } else setNotice(posted ? "重生提交尚未确认，请核对原提交；不会自动重发。" : "重生准入或本地保存失败，尚未发送任务。");
    }
  }
  async function reconcile() {
    if (!pending) return;
    try {
      const t = validTask(await api.getSettingsRegenerationSubmission(projectId,chapterId,pending.requestId),pending);
      if (task && task.id !== t.id) throw new Error("WRONG_TASK");
      if (alive.current) { setTask(t);setMissing(false);setNotice(t.reason === "EXECUTION_UNCERTAIN" ? "执行结果待后台核对，请勿重复生成。" : "已核对原重生任务，完成后请明确载入。"); }
    } catch (error) {
      if (!alive.current) return;
      setMissing(error instanceof ApiClientError && error.status === 404);
      setNotice(error instanceof ApiClientError && error.status === 404 ? "尚未找到原提交，可明确重新发送同一提交；不会创建新的请求身份。" : "核对失败，请稍后继续核对原提交。");
    }
  }
  async function load() {
    if (!pending || task?.state !== "succeeded" || !task.result) return;
    const next = await api.getSettingsRegeneration(projectId,chapterId,task.id),v = next.version,s = pending.selection,m = v.regeneration,ids = task.input.upstreamConfirmedVersionIds;
    if (v.status !== "candidate" || v.id !== task.result.candidateVersionId || v.projectId !== projectId || v.chapterId !== chapterId || v.sourceVersionId !== task.input.sourceVersionId || v.scriptVersionId !== ids[0]
      || !same(v.upstreamConfirmedVersionIds,ids) || v.parentVersionId !== s.expectedActiveVersionId || !m || m.jobId !== task.id || m.reason !== s.reason || !same(m.assetIds,s.assetIds) || !same(m.failureScopeKeys,s.failureScopeKeys) || m.outcome !== task.result.extractionStatus
      || v.operation?.kind !== "regenerate" || v.operation.targetId !== s.expectedActiveVersionId || v.operation.reason !== s.reason || next.scriptVersion.id !== v.scriptVersionId || next.scriptVersion.status !== "confirmed" || next.scriptVersion.sourceVersionId !== v.sourceVersionId) {
      if (alive.current) setNotice("重生结果身份不一致，未载入，请核对原任务。");return;
    }
    if (alive.current) {
      // Keep recovery identity if browser storage cannot acknowledge the explicit load.
      save(null);setTask(null);onLoaded(next);setNotice(next.current ? "已载入局部重生候选，正式版本保留；请重新审核确认。" : "上游已变化，已载入结果仅供历史追溯。");
    }
  }
  const toggle = (values: string[],id: string,checked: boolean) => checked ? [...values,id] : values.filter(v => v !== id);
  return <section className="task-panel settings-regeneration" aria-label="文字设定局部重生">
    <h3>局部重生设定</h3><p role="status">{notice}</p>
    <div className="desktop-task-action">
      {eligible ? <>
        {view.version.assets.map(a => <label className="regeneration-target" key={a.id}><input type="checkbox" aria-label={`重生资产 ${a.name}`} checked={assets.includes(a.id)} disabled={blocked || unavailableAsset(a.id) || failures.some(key => view.version.failures.find(f => f.scopeKey === key)?.assetId === a.id)} onChange={e => setAssets(toggle(assets,a.id,e.target.checked))} />{a.name}{unavailableAsset(a.id) ? " · 已锁定或有待决建议" : ""}</label>)}
        {view.version.failures.map(f => <label className="regeneration-target" key={f.scopeKey}><input type="checkbox" aria-label={`重试设定失败 ${f.scopeKey}`} checked={failures.includes(f.scopeKey)} disabled={blocked || !f.retryable || !!f.assetId && (unavailableAsset(f.assetId) || assets.includes(f.assetId) || failures.some(key => key !== f.scopeKey && view.version.failures.find(other => other.scopeKey === key)?.assetId === f.assetId))} onChange={e => setFailures(toggle(failures,f.scopeKey,e.target.checked))} />失败范围 {f.scopeKey}{!f.retryable ? " · 不可重试" : ""}</label>)}
        <label>重生原因<textarea aria-label="设定重生原因" maxLength={2000} disabled={blocked} value={reason} onChange={e => setReason(e.target.value)} /></label>
        <button type="button" disabled={blocked} onClick={() => void run(async () => { const next = (await api.modelConfiguration()).configuration;if (alive.current) { setConfig(next?.tested && next.processingRegion === "mainland" ? next : null);setModel(""); } })}>读取重生模型</button>
        <label>重生模型<select aria-label="设定重生模型" disabled={blocked} value={model} onChange={e => setModel(e.target.value)}><option value="">选择模型</option>{config?.availableModelIds.map(id => <option key={id}>{id}</option>)}</select></label>
        <button type="button" disabled={blocked || !model || !reason.trim() || assets.length+failures.length<1 || assets.length+failures.length>100} onClick={() => void run(() => send())}>提交设定局部重生</button>
      </> : <p>当前身份或版本仅可读取，不开放局部重生。</p>}
      {pending && missing && <button type="button" disabled={disabled || restoring} onClick={() => void run(() => send(pending))}>重新发送设定重生原提交</button>}
      {task && (task.state === "failed" || task.state === "paused" && task.reason !== "EXECUTION_UNCERTAIN") && <button type="button" disabled={readDisabled || restoring} onClick={() => void run(async () => { save(null);setTask(null);setNotice("已结束停止任务的核对；请读取当前设定后重新选择。"); })}>结束已停止的重生任务</button>}
    </div>
    {pending && <button type="button" disabled={readDisabled || restoring} onClick={() => void run(reconcile)}>核对设定重生原提交</button>}
    {task && <p>局部重生任务：{task.state} {task.reason} {task.result?.extractionStatus}</p>}
    <button type="button" disabled={readDisabled || restoring || task?.state !== "succeeded" || !task.result} onClick={() => void run(load)}>载入设定重生结果</button>
  </section>;
}
function same(a: string[],b: string[]) { return Array.isArray(a) && Array.isArray(b) && a.length===b.length && a.every((v,i) => v===b[i]); }
function validSaved(v: unknown): v is SettingsRegenerationSubmission {
  const id = (x: unknown) => typeof x === "string" && !!x.trim() && x.length<=256 && !/[\r\n]/.test(x);
  if (!v || typeof v!=="object" || Array.isArray(v) || Object.keys(v).length!==4 || !("requestId" in v) || !("configurationVersionId" in v) || !("modelId" in v) || !("selection" in v) || ![v.requestId,v.configurationVersionId,v.modelId].every(id)) return false;
  const s = v.selection;
  return !!s && typeof s==="object" && !Array.isArray(s) && Object.keys(s).length===4 && "expectedActiveVersionId" in s && id(s.expectedActiveVersionId) && "reason" in s && typeof s.reason==="string" && !!s.reason.trim() && s.reason.length<=2000
    && "assetIds" in s && "failureScopeKeys" in s && Array.isArray(s.assetIds) && Array.isArray(s.failureScopeKeys) && s.assetIds.length+s.failureScopeKeys.length>=1 && s.assetIds.length+s.failureScopeKeys.length<=100 && [...s.assetIds,...s.failureScopeKeys].every(id) && new Set(s.assetIds).size===s.assetIds.length && new Set(s.failureScopeKeys).size===s.failureScopeKeys.length;
}

export function readSettingsRegenerationSubmission(context: string): SettingsRegenerationSubmission | null {
  const raw = sessionStorage.getItem(JSON.stringify(["settings-regeneration",context]));
  if (!raw) return null;
  const saved: unknown = JSON.parse(raw);if (!validSaved(saved)) throw new Error("INVALID_SAVED_REGENERATION");return saved;
}
