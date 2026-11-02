"use client";
import { useState } from "react";
import { ApiClientError,type ApiClient,type ScriptContentView,type ScriptRevisionCommand } from "../lib/api";
export function ScriptRevision({ api,projectId,chapterId,view,selectedId,disabled,run,onChanged }: { api: ApiClient;projectId: string;chapterId: string;view: ScriptContentView;selectedId: string;disabled: boolean;run(f: () => Promise<void>): Promise<void>;onChanged(): Promise<void> }) {
  const [text,setText] = useState(""),[reason,setReason] = useState(""),[pending,setPending] = useState<ScriptRevisionCommand | null>(null);
  const [formal,setFormal] = useState<ScriptContentView["version"] | null>(null),[notice,setNotice] = useState("正式修改将派生候选，重新确认前保留原正式版。");
  const selected = view.version.elements.find(e => e.id === selectedId),isFormal = view.version.status === "confirmed",blocked = disabled || !!pending;
  async function submit(kind: "suggest" | "unlock" | "decide",suggestionId?: string,decision?: "accepted" | "rejected") {
    const command: ScriptRevisionCommand = pending ?? (kind === "suggest" ? { kind,requestId: crypto.randomUUID(),expectedActiveVersionId: view.version.id,elementId: selectedId,text,reason } : kind === "unlock" ? { kind,requestId: crypto.randomUUID(),expectedActiveVersionId: view.version.id,elementId: selectedId,reason } : { kind,requestId: crypto.randomUUID(),expectedActiveVersionId: view.version.id,suggestionId: suggestionId!,decision: decision!,reason });
    const reconciling = !!pending;setPending(command);
    try { await api.reviseScriptContent(projectId,chapterId,command);await onChanged();setPending(null);setText("");setReason("");setFormal(null);setNotice("修订操作已保存，请核对当前版本；候选需重新评估确认。"); }
    catch (error) {
      if (!reconciling && error instanceof ApiClientError && [400,403,404,409].includes(error.status)) { setPending(null);setNotice("操作被拒绝，请读取当前剧本后核对版本或权限。"); }
      else setNotice("操作结果未知，请核对原操作，不会自动重复提交。刷新前请先完成核对。");
    }
  }
  return <section aria-label="正式剧本修订"><h3>正式剧本修订</h3><p role="status">{notice}</p>
    <button type="button" disabled={disabled} onClick={() => void run(async () => { const result = await api.getScriptVersion(projectId,chapterId,"confirmed");if (result.version.projectId !== projectId || result.version.chapterId !== chapterId || result.version.status !== "confirmed") throw new Error();setFormal(result.version); })}>读取保留正式版</button>
    {formal && <article aria-label="保留正式剧本"><p>正式版本 {formal.id}</p>{formal.elements.map(e => <p key={e.id}>{e.text}</p>)}</article>}
    {isFormal && <div className="desktop-task-action">
      <label>正式修订理由<input value={reason} maxLength={2000} disabled={blocked} onChange={e => setReason(e.target.value)} /></label>
      {selected && view.permissions?.canSuggest && <><label>正式修订建议<textarea value={text} maxLength={20000} disabled={blocked} onChange={e => setText(e.target.value)} /></label><button type="button" disabled={blocked || !reason.trim() || !text.trim() || !!selected.lockedAt} onClick={() => void run(() => submit("suggest"))}>提交正式修订建议</button></>}
      {selected?.lockedAt && view.permissions?.canDecide && <button type="button" disabled={blocked || !reason.trim()} onClick={() => void run(() => submit("unlock"))}>明确解锁当前元素</button>}
      {view.permissions?.canDecide && view.version.suggestions?.filter(s => s.status === "pending").map(s => <article key={s.id}><p>{s.text}</p><button type="button" disabled={blocked || !reason.trim()} onClick={() => void run(() => submit("decide",s.id,"accepted"))}>接受正式建议 {s.id}</button><button type="button" disabled={blocked || !reason.trim()} onClick={() => void run(() => submit("decide",s.id,"rejected"))}>拒绝正式建议 {s.id}</button></article>)}
    </div>}
    {pending && <div className="desktop-task-action"><button type="button" disabled={disabled} onClick={() => void run(() => submit(pending.kind))}>核对正式修订原操作</button></div>}
  </section>;
}
