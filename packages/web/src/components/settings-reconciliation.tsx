"use client";
import { archiveSettingsRecovery,findSettingsRecovery } from "../lib/settings-recovery";
import { DefinitionFields } from "./settings-review";
import { useEffect,useRef,useState } from "react";
import { ApiClientError,type ApiClient,type SettingsView,type SettingsReconciliationCommand,type SettingsReconciliationPreview } from "../lib/api";
export function SettingsReconciliation({ api,projectId,chapterId,context,view,disabled,readDisabled,run,onChanged,onBlockedChange }: {
  api: ApiClient;projectId: string;chapterId: string;context: string;view: SettingsView;disabled: boolean;readDisabled: boolean;
  run(f: () => Promise<void>): Promise<void>;onChanged(): Promise<void>;onBlockedChange(v: boolean): void;
}) {
  const [preview,setPreview] = useState<SettingsReconciliationPreview | null>(null),[reason,setReason] = useState("");
  const [recovery,setRecovery] = useState<ReturnType<typeof readReconciliation>>(null),[restoring,setRestoring] = useState(true);
  const [canEnd,setCanEnd] = useState(false),[canArchive,setCanArchive] = useState(false);
  const [old,setOld] = useState<SettingsView["version"] | null>(null),[notice,setNotice] = useState("跨上游处理逐项核对，旧正式版保持不变。");
  const alive = useRef(false),key = JSON.stringify(["settings-reconciliation",context]);
  const pending = recovery?.command;
  useEffect(() => {
    alive.current = true;
    try { const saved = readReconciliation(context);if (saved) { setRecovery(saved);setNotice("有待核对的跨上游操作，刷新不会自动发送。"); }setRestoring(false); }
    catch { setNotice("无法读取操作身份，暂停新的跨上游处理，请人工核对。"); }
    return () => { alive.current = false; };
  },[context]);
  useEffect(() => { onBlockedChange(restoring || !!pending); },[restoring,pending,onBlockedChange]);
  useEffect(() => { setPreview(null);setReason("");setOld(null); },[view.version.id]);
  const blocked = disabled || restoring || !!pending;
  const [repair,setRepair] = useState<{ asset: SettingsView["version"]["assets"][number];fragments: string[] } | null>(null);
  const [history,setHistory] = useState<Awaited<ReturnType<ApiClient["getChapter"]>> | null>(null);
  useEffect(() => { setRepair(null); },[view.version.id]);
  const canRetain = view.current && view.active === true && view.version.status === "candidate" && view.permissions?.canDecide === true;
  function clearRecovery() {
    sessionStorage.removeItem(recovery?.key ?? key);
    setCanArchive(false);
    try { setRecovery(readReconciliation(context)); }
    catch { setRecovery(null);setRestoring(true); }
  }
  function validateResult(v: SettingsView["version"],c: SettingsReconciliationCommand) {
    const ids = c.expectedUpstreamConfirmedVersionIds;
    if (v.projectId !== projectId || v.chapterId !== chapterId || v.sourceVersionId !== (JSON.parse(recovery?.context ?? context) as string[])[2] || !v.reconciliation
      || v.parentVersionId !== c.expectedActiveVersionId || v.scriptVersionId !== ids[0] || v.upstreamConfirmedVersionIds.length!==ids.length || v.upstreamConfirmedVersionIds.some((id,i) => id!==ids[i])
      || v.operation?.requestId !== c.requestId || v.operation.reason !== c.reason || v.operation.kind !== ({ begin: "reconcile",retain: "retain",unlock: "reconcileUnlock",repair: "reconcileRepair" }[c.kind]) || v.operation.targetId !== (c.kind === "begin" ? c.expectedActiveVersionId : c.assetId)) throw new Error("WRONG_RECONCILIATION");
  }
  async function completed(v: SettingsView["version"],c: SettingsReconciliationCommand) {
    validateResult(v,c);await onChanged();
    if (alive.current) { clearRecovery();setNotice("核对操作已保存；待处理项清零后仍须明确重新确认。"); }
  }
  async function send(kind: SettingsReconciliationCommand["kind"],assetId?: string,replay = false,value?: unknown) {
    if (replay ? recovery?.context !== context : blocked) return;
    if (!replay && (kind === "begin" ? !preview?.canBegin || preview.baseVersionId!==view.version.id : !canRetain)) return;
    const command: SettingsReconciliationCommand = replay ? pending! : { kind,requestId: crypto.randomUUID(),expectedActiveVersionId: view.version.id,expectedUpstreamConfirmedVersionIds: [...(kind === "begin" ? preview!.upstreamConfirmedVersionIds : view.version.upstreamConfirmedVersionIds)],reason: reason.trim(),...(kind !== "begin" ? { assetId } : {}),...(kind === "repair" ? { value } : {}) } as SettingsReconciliationCommand;
    if (!command) return;
    try { sessionStorage.setItem(key,JSON.stringify(command)); } catch { setRestoring(true);setNotice("无法保存操作身份，尚未提交跨上游操作。");return; }
    setRecovery({ key,context,command });setCanEnd(false);let acknowledged = false;
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
        clearRecovery();setNotice("操作被拒绝，请重新读取当前设定及正式上游。");
      } else setNotice(acknowledged ? "操作已保存，但读取未完成，请核对原操作。" : "操作结果未知，请核对原操作；不会自动重发。");
    }
  }
  async function reconcile() {
    if (!pending) return;
    setCanEnd(false);setCanArchive(false);
    let saved: SettingsView["version"];
    try { saved = (await api.getSettingsOperation(projectId,chapterId,pending.requestId)).version; }
    catch (error) {
      if (!alive.current) return;
      const missing = recovery?.context !== context && error instanceof ApiClientError && error.status === 404;
      setCanArchive(missing);
      setNotice(missing ? "旧上游未查到原操作，可归档本地身份。" : "原操作未核对成功，保留原身份，不会创建新的操作。");
      return;
    }
    try { await completed(saved,pending); }
    catch { if (alive.current) setNotice("已读取原操作记录，但身份或当前版本尚未核对，保留原请求。"); }
  }
  return <section aria-label="设定跨上游核对"><h3>跨上游核对</h3><p role="status">{notice}</p>
    <button type="button" disabled={readDisabled} onClick={() => void run(async () => { const next = await api.previewSettingsReconciliation(projectId,chapterId);if (next.baseVersionId!==view.version.id || next.upstreamConfirmedVersionIds.length!==3) throw new Error("WRONG_PREVIEW");const [,,sourceId,...ids] = JSON.parse(context) as string[];if (next.sourceVersionId !== sourceId || next.upstreamConfirmedVersionIds.some((id,i) => id !== ids[i])) throw new Error("STALE_PREVIEW");if (alive.current) setPreview(next); })}>预览设定跨上游处理</button>
    {preview && <p>目标正式上游：{preview.upstreamConfirmedVersionIds.join(" / ")}{!preview.sameSource ? " · 原文版本已变化，须逐项核验或重新选择依据。" : !preview.requiresReconciliation ? " · 当前已匹配正式上游。" : " · 需逐项核对，不会默认保留。"}</p>}
    <div className="desktop-task-action">
      <label>跨上游处理理由<input aria-label="跨上游处理理由" maxLength={2000} value={reason} disabled={blocked} onChange={e => setReason(e.target.value)} /></label>
      {preview?.canBegin && <button type="button" disabled={blocked || !reason.trim() || preview.baseVersionId!==view.version.id} onClick={() => void run(() => send("begin"))}>{preview.sameSource ? "明确开始同源核对" : "明确开始跨源核对"}</button>}
    </div>
    {view.version.reconciliation && <>
      <p>待核对资产 {view.version.reconciliation.pendingAssets.length} 项；待处理失败范围 {view.version.reconciliation.pendingFailureScopeKeys.length} 项。待核对内容不是新上游有效资产，不能确认。</p>
      {view.version.reconciliation.pendingAssets.map(a => <article key={a.id}><h4>{a.name} · 待核对{Object.hasOwn(view.version.locks ?? {},a.id) ? " · 沿用锁须内容与依据不变" : ""}</h4>
        <details><summary>查看待核对历史内容 {a.name}</summary><p>{JSON.stringify(a.visibleDefinition)}</p><p>{a.state}</p><p>状态变化：{a.stateChanges.join("；")}</p><p>限制：{a.restrictions.join("；")}</p><p>原文依据：{a.provenance.map(p => p.type === "source_fragment" ? (p.sourceVersionId === view.version.sourceVersionId ? view.sourceFragments : history?.versions.find(v => v.id === p.sourceVersionId)?.fragments)?.find(f => f.id===p.fragmentId)?.text ?? `${p.sourceVersionId} / ${p.fragmentId}` : p.additionId).join("；")}</p></details>
        {canRetain && <div className="desktop-task-action">
          <button type="button" disabled={blocked || !reason.trim()} onClick={() => void run(() => send("retain",a.id))}>{a.provenance.some(ref => ref.sourceVersionId !== view.version.sourceVersionId) ? "核验并保留" : "原样保留"} {a.name}</button>
          {Object.hasOwn(view.version.locks ?? {},a.id)
            ? <button type="button" disabled={blocked || !reason.trim()} onClick={() => void run(() => send("unlock",a.id))}>明确解锁待核对资产 {a.name}</button>
            : <button type="button" disabled={blocked} onClick={() => setRepair({ asset:a,fragments:[] })}>人工修订 {a.name}</button>}
          {repair?.asset.id === a.id && <fieldset disabled={blocked}>
            <legend>修订 {a.name} 并选择当前原文依据</legend>
            <label>修订名称<input value={repair.asset.name} maxLength={20000} onChange={e => setRepair({ ...repair,asset:{ ...repair.asset,name:e.target.value } })} /></label>
            <DefinitionFields label="修订可见特征" value={repair.asset.visibleDefinition} onChange={value => setRepair({ ...repair,asset:{ ...repair.asset,visibleDefinition:value as Record<string,unknown> } })} />
            <label>修订当前状态<input value={repair.asset.state} onChange={e => setRepair({ ...repair,asset:{ ...repair.asset,state:e.target.value } })} /></label>
            <label>修订状态变化（每行一项）<textarea value={repair.asset.stateChanges.join("\n")} onChange={e => setRepair({ ...repair,asset:{ ...repair.asset,stateChanges:e.target.value ? e.target.value.split("\n") : [] } })} /></label>
            <label>修订使用限制（每行一项）<textarea value={repair.asset.restrictions.join("\n")} onChange={e => setRepair({ ...repair,asset:{ ...repair.asset,restrictions:e.target.value ? e.target.value.split("\n") : [] } })} /></label>
            {view.sourceFragments.map(f => <label key={f.id}><input type="checkbox" checked={repair.fragments.includes(f.id)} onChange={e => setRepair({ ...repair,fragments:e.target.checked ? [...repair.fragments,f.id] : repair.fragments.filter(id => id!==f.id) })} />{f.text}</label>)}
            <button type="button" disabled={!reason.trim() || !repair.asset.name.trim() || !repair.fragments.length} onClick={() => void run(() => send("repair",a.id,false,{ ...repair.asset,provenance:repair.fragments.map(fragmentId => ({ type:"source_fragment",sourceVersionId:view.version.sourceVersionId,fragmentId,transformation:"retained" })) }))}>保存人工修订</button>
          </fieldset>}
        </div>}
      </article>)}
      {view.version.reconciliation.pendingFailureScopeKeys.map(id => <p key={id}>待处理失败范围 {id} · 保持未完成，不能确认。</p>)}
      {(view.version.reconciliation.pendingAssets.some(a => a.provenance.some(ref => ref.sourceVersionId !== view.version.sourceVersionId)) || !!old) && <button type="button" disabled={readDisabled} onClick={() => void run(async () => { const chapter = await api.getChapter(projectId,chapterId);if (alive.current) setHistory(chapter); })}>读取历史原文依据</button>}
      <button type="button" disabled={readDisabled} onClick={() => void run(async () => { const id = view.version.reconciliation!.originVersionId,result = await api.getSettingsVersion(projectId,chapterId,id);if (result.version.id!==id || result.version.projectId!==projectId || result.version.chapterId!==chapterId) throw new Error("WRONG_ORIGIN");if (alive.current) setOld(result.version); })}>读取原版本建议历史</button>
      {old && <aside aria-label="原版本依据与锁">
        {[...old.assets,...(old.reconciliation?.pendingAssets ?? [])].map(asset => <details key={asset.id}>
          <summary>{asset.name}的历史依据</summary>
          {old.locks && Object.hasOwn(old.locks,asset.id) && <p>原锁：{old.locks[asset.id]?.lockedBy} · {old.locks[asset.id]?.lockedAt}</p>}
          {asset.provenance.map((ref,i) => <p key={i}>{ref.type === "source_fragment" ? history?.versions.find(v => v.id===ref.sourceVersionId)?.fragments.find(f => f.id===ref.fragmentId)?.text ?? `${ref.sourceVersionId} / ${ref.fragmentId}` : ref.additionId}</p>)}
        </details>)}
      </aside>}
      {old && <aside aria-label="原版本建议历史">{old.suggestions?.length ? old.suggestions.map(s => <p key={s.id}>{s.value.name} · {s.reason} · {s.status} · 未迁移至新上游</p>) : <p>原版本没有建议。</p>}</aside>}
    </>}
    {recovery && canArchive && <div className="desktop-task-action"><button type="button" disabled={readDisabled || restoring} onClick={() => void run(async () => {
      archiveSettingsRecovery(recovery.key);clearRecovery();setNotice("已归档旧上游的原操作身份。");
    })}>归档旧上游核对请求</button></div>}
    {pending && canEnd && <div className="desktop-task-action"><button type="button" disabled={readDisabled || restoring} onClick={() => void run(async () => { sessionStorage.setItem(key+"-last-rejected",JSON.stringify({ command: pending,closedAt: new Date().toISOString() }));await onChanged();if (alive.current) { clearRecovery();setCanEnd(false);setNotice("已结束明确未保存的原操作核对，可重新读取上游并明确选择。"); } })}>结束未保存的跨上游操作核对</button></div>}
    {pending && <><button type="button" disabled={readDisabled || restoring} onClick={() => void run(reconcile)}>核对跨上游原操作</button>{recovery?.context === context && <div className="desktop-task-action"><button type="button" disabled={disabled || restoring} onClick={() => void run(() => send(pending.kind,undefined,true))}>重新发送跨上游原操作</button></div>}</>}
  </section>;
}
function valid(v: unknown): v is SettingsReconciliationCommand {
  const id = (x: unknown) => typeof x === "string" && !!x.trim() && x.length<=256 && !/[\r\n]/.test(x);
  if (!v || typeof v!=="object" || Array.isArray(v)) return false;
  const b = v as Record<string,unknown>;
  return id(b.requestId) && id(b.expectedActiveVersionId) && typeof b.reason==="string" && !!b.reason.trim() && b.reason.length<=2000 && Array.isArray(b.expectedUpstreamConfirmedVersionIds) && b.expectedUpstreamConfirmedVersionIds.length===3 && b.expectedUpstreamConfirmedVersionIds.every(id)
    && (b.kind === "begin" || ["retain","unlock","repair"].includes(String(b.kind)) && id(b.assetId)) && Object.keys(b).every(k => ["requestId","expectedActiveVersionId","expectedUpstreamConfirmedVersionIds","reason","kind",...(b.kind !== "begin" ? ["assetId"] : []),...(b.kind === "repair" ? ["value"] : [])].includes(k));
}

function readReconciliation(context: string) {
  const saved = findSettingsRecovery("settings-reconciliation",context);
  if (!saved) return null;
  const command: unknown = JSON.parse(saved.raw);
  if (!valid(command)) throw new Error("INVALID_SAVED_RECONCILIATION");
  return { key:saved.key,context:saved.context,command };
}
