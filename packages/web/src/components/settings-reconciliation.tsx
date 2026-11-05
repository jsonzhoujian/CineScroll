"use client";
import { useEffect,useRef,useState } from "react";
import { ApiClientError,type ApiClient,type SettingsView,type SettingsReconciliationCommand,type SettingsReconciliationPreview } from "../lib/api";
export function SettingsReconciliation({ api,projectId,chapterId,context,view,disabled,readDisabled,run,onChanged,onBlockedChange }: {
  api: ApiClient;projectId: string;chapterId: string;context: string;view: SettingsView;disabled: boolean;readDisabled: boolean;
  run(f: () => Promise<void>): Promise<void>;onChanged(): Promise<void>;onBlockedChange(v: boolean): void;
}) {
  const [preview,setPreview] = useState<SettingsReconciliationPreview | null>(null),[reason,setReason] = useState("");
  const [pending,setPending] = useState<SettingsReconciliationCommand | null>(null),[restoring,setRestoring] = useState(true);
  const [canEnd,setCanEnd] = useState(false);
  const [old,setOld] = useState<SettingsView["version"] | null>(null),[notice,setNotice] = useState("跨上游处理逐项核对，旧正式版保持不变。");
  const alive = useRef(false),key = JSON.stringify(["settings-reconciliation",context]);
  useEffect(() => {
    alive.current = true;
    try { const raw = sessionStorage.getItem(key);if (raw) { const saved = JSON.parse(raw);if (!valid(saved)) throw new Error();setPending(saved);setNotice("有待核对的跨上游操作，刷新不会自动发送。"); }setRestoring(false); }
    catch { setNotice("无法读取操作身份，暂停新的跨上游处理，请人工核对。"); }
    return () => { alive.current = false; };
  },[key]);
  useEffect(() => { onBlockedChange(restoring || !!pending); },[restoring,pending,onBlockedChange]);
  useEffect(() => { setPreview(null);setReason("");setOld(null); },[view.version.id]);
  const blocked = disabled || restoring || !!pending;
  const canRetain = view.current && view.active === true && view.version.status === "candidate" && view.permissions?.canDecide === true;
  function validateResult(v: SettingsView["version"],c: SettingsReconciliationCommand) {
    const ids = c.expectedUpstreamConfirmedVersionIds;
    if (v.projectId !== projectId || v.chapterId !== chapterId || v.sourceVersionId !== view.version.sourceVersionId || !v.reconciliation
      || v.parentVersionId !== c.expectedActiveVersionId || v.scriptVersionId !== ids[0] || v.upstreamConfirmedVersionIds.length!==ids.length || v.upstreamConfirmedVersionIds.some((id,i) => id!==ids[i])
      || v.operation?.requestId !== c.requestId || v.operation.reason !== c.reason || v.operation.kind !== (c.kind === "begin" ? "reconcile" : "retain") || v.operation.targetId !== (c.kind === "begin" ? c.expectedActiveVersionId : c.assetId)) throw new Error("WRONG_RECONCILIATION");
  }
  async function completed(v: SettingsView["version"],c: SettingsReconciliationCommand) {
    validateResult(v,c);await onChanged();
    if (alive.current) { sessionStorage.removeItem(key);setPending(null);setNotice("核对操作已保存；待处理项清零后仍须明确重新确认。"); }
  }
  async function send(kind: "begin" | "retain",assetId?: string,replay = false) {
    if (!replay && blocked) return;
    if (!replay && (kind === "begin" ? !preview?.canBegin || preview.baseVersionId!==view.version.id : !canRetain)) return;
    const command: SettingsReconciliationCommand = replay ? pending! : { kind,requestId: crypto.randomUUID(),expectedActiveVersionId: view.version.id,expectedUpstreamConfirmedVersionIds: [...(kind === "begin" ? preview!.upstreamConfirmedVersionIds : view.version.upstreamConfirmedVersionIds)],reason: reason.trim(),...(kind === "retain" ? { assetId: assetId! } : {}) } as SettingsReconciliationCommand;
    if (!command) return;
    try { sessionStorage.setItem(key,JSON.stringify(command)); } catch { setRestoring(true);setNotice("无法保存操作身份，尚未提交跨上游操作。");return; }
    setPending(command);setCanEnd(false);let acknowledged = false;
    try { const saved = await api.reconcileSettings(projectId,chapterId,command);validateResult(saved,command);acknowledged = true;await completed(saved,command); }
    catch (error) {
      if (!alive.current) return;
      if (!acknowledged && replay && error instanceof ApiClientError && [400,403,404,409].includes(error.status)) {
        let saved: SettingsView["version"] | null = null;
        try { saved = (await api.getSettingsOperation(projectId,chapterId,command.requestId)).version; }
        catch (probe) { if (probe instanceof ApiClientError && probe.status === 404) { setCanEnd(true);setNotice("原请求已明确拒绝且未找到已保存结果，可明确结束核对；不会自动重试。");return; } }
        if (saved) {
          try { await completed(saved,command); }
          catch { setNotice("已读取原操作记录，但身份或当前版本尚未核对，保留原请求。"); }
          return;
        }
      }
      if (!acknowledged && !replay && error instanceof ApiClientError && [400,403,404,409].includes(error.status)) {
        sessionStorage.removeItem(key);setPending(null);setNotice("操作被拒绝，请重新读取当前设定及正式上游。");
      } else setNotice(acknowledged ? "操作已保存，但读取未完成，请核对原操作。" : "操作结果未知，请核对原操作；不会自动重发。");
    }
  }
  async function reconcile() {
    if (!pending) return;
    setCanEnd(false);
    try { await completed((await api.getSettingsOperation(projectId,chapterId,pending.requestId)).version,pending); }
    catch { if (alive.current) setNotice("原操作未核对成功，保留原身份，不会创建新的操作。"); }
  }
  return <section aria-label="设定跨上游核对"><h3>跨上游核对</h3><p role="status">{notice}</p>
    <button type="button" disabled={readDisabled} onClick={() => void run(async () => { const next = await api.previewSettingsReconciliation(projectId,chapterId);if (next.baseVersionId!==view.version.id || next.upstreamConfirmedVersionIds.length!==3) throw new Error("WRONG_PREVIEW");if (alive.current) setPreview(next); })}>预览设定跨上游处理</button>
    {preview && <p>目标正式上游：{preview.upstreamConfirmedVersionIds.join(" / ")}{!preview.sameSource ? " · 原文版本已变化，本入口暂不迁移依据。" : !preview.requiresReconciliation ? " · 当前已匹配正式上游。" : " · 需逐项核对，不会默认保留。"}</p>}
    <div className="desktop-task-action">
      <label>跨上游处理理由<input aria-label="跨上游处理理由" maxLength={2000} value={reason} disabled={blocked} onChange={e => setReason(e.target.value)} /></label>
      {preview?.canBegin && <button type="button" disabled={blocked || !reason.trim() || preview.baseVersionId!==view.version.id} onClick={() => void run(() => send("begin"))}>明确开始同源核对</button>}
    </div>
    {view.version.reconciliation && <>
      <p>待核对资产 {view.version.reconciliation.pendingAssets.length} 项；待处理失败范围 {view.version.reconciliation.pendingFailureScopeKeys.length} 项。待核对内容不是新上游有效资产，不能确认。</p>
      {view.version.reconciliation.pendingAssets.map(a => <article key={a.id}><h4>{a.name} · 待核对{Object.hasOwn(view.version.locks ?? {},a.id) ? " · 沿用锁须内容与依据不变" : ""}</h4>
        <details><summary>查看待核对历史内容 {a.name}</summary><p>{JSON.stringify(a.visibleDefinition)}</p><p>{a.state}</p><p>状态变化：{a.stateChanges.join("；")}</p><p>限制：{a.restrictions.join("；")}</p><p>原文依据：{a.provenance.map(p => p.type === "source_fragment" ? view.sourceFragments.find(f => f.id===p.fragmentId)?.text ?? "原文不可用" : p.additionId).join("；")}</p></details>
        {canRetain && <div className="desktop-task-action"><button type="button" disabled={blocked || !reason.trim()} onClick={() => void run(() => send("retain",a.id))}>原样保留 {a.name}</button></div>}
      </article>)}
      {view.version.reconciliation.pendingFailureScopeKeys.map(id => <p key={id}>待处理失败范围 {id} · 保持未完成，不能确认。</p>)}
      <button type="button" disabled={readDisabled} onClick={() => void run(async () => { const id = view.version.reconciliation!.originVersionId,result = await api.getSettingsVersion(projectId,chapterId,id);if (result.version.id!==id || result.version.projectId!==projectId || result.version.chapterId!==chapterId) throw new Error("WRONG_ORIGIN");if (alive.current) setOld(result.version); })}>读取原版本建议历史</button>
      {old && <aside aria-label="原版本建议历史">{old.suggestions?.length ? old.suggestions.map(s => <p key={s.id}>{s.value.name} · {s.reason} · {s.status} · 未迁移至新上游</p>) : <p>原版本没有建议。</p>}</aside>}
    </>}
    {pending && canEnd && <div className="desktop-task-action"><button type="button" disabled={readDisabled || restoring} onClick={() => void run(async () => { sessionStorage.setItem(key+"-last-rejected",JSON.stringify({ command: pending,closedAt: new Date().toISOString() }));await onChanged();sessionStorage.removeItem(key);if (alive.current) { setPending(null);setCanEnd(false);setNotice("已结束明确未保存的原操作核对，可重新读取上游并明确选择。"); } })}>结束未保存的跨上游操作核对</button></div>}
    {pending && <><button type="button" disabled={readDisabled || restoring} onClick={() => void run(reconcile)}>核对跨上游原操作</button><div className="desktop-task-action"><button type="button" disabled={disabled || restoring} onClick={() => void run(() => send(pending.kind,undefined,true))}>重新发送跨上游原操作</button></div></>}
  </section>;
}
function valid(v: unknown): v is SettingsReconciliationCommand {
  const id = (x: unknown) => typeof x === "string" && !!x.trim() && x.length<=256 && !/[\r\n]/.test(x);
  if (!v || typeof v!=="object" || Array.isArray(v)) return false;
  const b = v as Record<string,unknown>;
  return id(b.requestId) && id(b.expectedActiveVersionId) && typeof b.reason==="string" && !!b.reason.trim() && b.reason.length<=2000 && Array.isArray(b.expectedUpstreamConfirmedVersionIds) && b.expectedUpstreamConfirmedVersionIds.length===3 && b.expectedUpstreamConfirmedVersionIds.every(id)
    && (b.kind === "begin" || b.kind === "retain" && id(b.assetId)) && Object.keys(b).every(k => ["requestId","expectedActiveVersionId","expectedUpstreamConfirmedVersionIds","reason","kind",...(b.kind === "retain" ? ["assetId"] : [])].includes(k));
}
