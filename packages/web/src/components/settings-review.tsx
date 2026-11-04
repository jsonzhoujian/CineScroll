"use client";
import { useEffect,useRef,useState } from "react";
import { ApiClientError,type ApiClient,type SettingsView,type SettingsReviewCommand } from "../lib/api";
type Asset = SettingsView["version"]["assets"][number];
export function SettingsReview({ api,projectId,chapterId,context,view,selectedId,disabled,readDisabled = disabled,run,onChanged,onBlockedChange }: {
  api: ApiClient;projectId: string;chapterId: string;context: string;view: SettingsView;selectedId: string;disabled: boolean;readDisabled?: boolean;run(f: () => Promise<void>): Promise<void>;onChanged(): Promise<void>;onBlockedChange?(v: boolean): void;
}) {
  const [draft,setDraft] = useState<Asset | null>(null),[reason,setReason] = useState("");
  const [pending,setPending] = useState<SettingsReviewCommand | null>(null),[restoreBlocked,setRestoreBlocked] = useState(true);
  const [formal,setFormal] = useState<SettingsView["version"] | null>(null),[notice,setNotice] = useState("候选需明确确认；正式修改通过建议派生候选。");
  const alive = useRef(false),storageKey = JSON.stringify(["settings-review",context]);
  useEffect(() => {
    alive.current = true;
    try {
      const raw = sessionStorage.getItem(storageKey);
      if (raw) {
        const command = JSON.parse(raw);
        if (!validPending(command)) throw new Error("INVALID_SAVED_COMMAND");
        setPending(command);setNotice("有待核对的设定操作，请先核对原操作。");
      }
      setRestoreBlocked(false);
    } catch { setNotice("无法读取已保存的操作身份，请先人工核对，暂停新的审核操作。"); }
    return () => { alive.current = false; };
  },[storageKey]);
  useEffect(() => { onBlockedChange?.(restoreBlocked || !!pending); },[restoreBlocked,pending,onBlockedChange]);
  useEffect(() => { setDraft(structuredClone(view.version.assets.find(a => a.id === selectedId) ?? null));setReason(""); },[view.version,selectedId]);
  const eligible = view.current && view.active === true,blocked = disabled || restoreBlocked || !!pending || !eligible;
  const locked = !!selectedId && Object.hasOwn(view.version.locks ?? {},selectedId),isFormal = view.version.status === "confirmed";
  function validVersion(v: SettingsView["version"]) {
    if (v.projectId !== projectId || v.chapterId !== chapterId || v.sourceVersionId !== view.version.sourceVersionId || v.scriptVersionId !== view.version.scriptVersionId || v.upstreamConfirmedVersionIds.length !== view.version.upstreamConfirmedVersionIds.length || v.upstreamConfirmedVersionIds.some((id,i) => id !== view.version.upstreamConfirmedVersionIds[i])) throw new Error("WRONG_VERSION");
  }
  function validateOperation(v: SettingsView["version"],command: SettingsReviewCommand) {
    validVersion(v);
    const target = "assetId" in command ? command.assetId : command.kind === "decide" ? command.suggestionId : command.expectedActiveVersionId;
    if (v.operation?.requestId !== command.requestId || v.operation.kind !== command.kind || v.parentVersionId !== command.expectedActiveVersionId || v.operation.targetId !== target || v.operation.reason !== command.reason.trim()) throw new Error("WRONG_OPERATION");
  }
  async function completed(v: SettingsView["version"],command: SettingsReviewCommand,note: string) {
    validateOperation(v,command);
    await onChanged();
    if (alive.current) { sessionStorage.removeItem(storageKey);setPending(null);setReason("");setFormal(null);setNotice(note); }
  }
  async function submit(kind: SettingsReviewCommand["kind"],suggestionId?: string,decision?: "accepted" | "rejected",replay = false) {
    if (!replay && blocked) return;
    const shared = { requestId: crypto.randomUUID(),expectedActiveVersionId: view.version.id,reason };
    const command: SettingsReviewCommand = replay ? pending! : kind === "confirm" ? { ...shared,kind }
      : kind === "decide" ? { ...shared,kind,suggestionId: suggestionId!,decision: decision! }
      : kind === "edit" || kind === "suggest" ? { ...shared,kind,assetId: selectedId,value: structuredClone(draft!) }
      : { ...shared,kind,assetId: selectedId };
    if (!command) return;
    try { sessionStorage.setItem(storageKey,JSON.stringify(command)); } catch { setRestoreBlocked(true);setNotice("无法保存操作身份，尚未提交审核。");return; }
    setPending(command);
    let acknowledged = false;
    try { const saved = await api.reviewSettings(projectId,chapterId,command);validateOperation(saved,command);acknowledged = true;await completed(saved,command,"设定操作已保存，请核对当前版本。"); }
    catch (error) {
      if (!alive.current) return;
      if (!acknowledged && !replay && error instanceof ApiClientError && [400,403,404,409].includes(error.status)) {
        sessionStorage.removeItem(storageKey);setPending(null);setNotice("操作被拒绝，请读取当前设定后核对版本或权限。");
      } else setNotice(acknowledged ? "操作已保存，但当前设定读取未完成，请核对原操作。" : "操作结果未知，请核对原操作；不会自动重复提交。刷新后仍可核对。");
    }
  }
  async function reconcile() {
    if (!pending) return;
    try { const saved = await api.getSettingsOperation(projectId,chapterId,pending.requestId);await completed(saved.version,pending,"原操作已核对，已读取当前设定。"); }
    catch (error) { if (alive.current) setNotice(error instanceof ApiClientError && error.status === 401 ? "登录已失效，请重新登录后核对原操作。" : "原操作尚未核对成功，保留原请求；不会发起新操作。"); }
  }
  return <section aria-label="文字设定审核"><h3>文字设定审核</h3><p>设定状态：{isFormal ? "正式" : "候选"}</p><p role="status">{notice}</p>
    {!eligible && <p>当前内容仅供追溯，请读取当前设定后再审核。</p>}
    <button type="button" disabled={readDisabled} onClick={() => void run(async () => { const result = await api.getSettingsVersion(projectId,chapterId,"confirmed");validVersion(result.version);if (result.version.status !== "confirmed") throw new Error("NOT_FORMAL");if (alive.current) setFormal(result.version); })}>读取保留正式设定</button>
    {formal && <article aria-label="保留正式设定"><p>正式版本 {formal.id}</p>{formal.assets.map(a => <p key={a.id}>{a.name}</p>)}</article>}
    <div className="desktop-task-action">
      <label>设定操作理由<input aria-label="设定操作理由" value={reason} maxLength={2000} disabled={blocked} onChange={e => setReason(e.target.value)} /></label>
      {draft && <fieldset disabled={blocked || locked}><legend>当前设定内容</legend>
        <label>设定名称<input aria-label="设定名称" value={draft.name} maxLength={20000} onChange={e => setDraft({ ...draft,name: e.target.value })} /></label>
        <DefinitionFields label="可见特征" value={draft.visibleDefinition} onChange={value => setDraft({ ...draft,visibleDefinition: value as Record<string,unknown> })} />
        <label>当前状态<input value={draft.state} onChange={e => setDraft({ ...draft,state: e.target.value })} /></label>
        <label>状态变化（每行一项）<textarea value={draft.stateChanges.join("\n")} onChange={e => setDraft({ ...draft,stateChanges: e.target.value ? e.target.value.split("\n") : [] })} /></label>
        <label>使用限制（每行一项）<textarea value={draft.restrictions.join("\n")} onChange={e => setDraft({ ...draft,restrictions: e.target.value ? e.target.value.split("\n") : [] })} /></label>
      </fieldset>}
      {draft && view.permissions?.canEdit && !isFormal && <button type="button" disabled={blocked || locked || !reason.trim() || !draft.name.trim()} onClick={() => void run(() => submit("edit"))}>保存设定修改</button>}
      {draft && view.permissions?.canSuggest && <button type="button" disabled={blocked || locked || !reason.trim() || !draft.name.trim()} onClick={() => void run(() => submit("suggest"))}>提交设定建议</button>}
      {view.permissions?.canConfirm && !isFormal && <button type="button" disabled={blocked || !reason.trim() || view.version.generationStatus !== "succeeded" || !!view.version.failures.length || !view.version.assets.length || !!view.version.suggestions?.some(s => s.status === "pending")} onClick={() => void run(() => submit("confirm"))}>确认文字设定</button>}
      {draft && isFormal && view.permissions?.canLock && <button type="button" disabled={blocked || !reason.trim()} onClick={() => void run(() => submit(locked ? "unlock" : "lock"))}>{locked ? "明确解锁当前设定" : "锁定当前设定"}</button>}
      {view.version.suggestions?.map(s => <article key={s.id}><p>{s.value.name}</p><small>{s.reason} · {s.status} · {s.submittedBy}</small>
        <details><summary>查看建议内容 {s.id}</summary><dl>{Object.entries(s.value.visibleDefinition).map(([key,value]) => <div key={key}><dt>{key}</dt><dd>{typeof value === "string" ? value : JSON.stringify(value)}</dd></div>)}</dl>
          <p>当前状态：{s.value.state}</p><p>状态变化：{s.value.stateChanges.join("；") || "无"}</p><p>使用限制：{s.value.restrictions.join("；") || "无"}</p>
          <p>原文依据：{s.value.provenance.map(p => p.type === "source_fragment" ? view.sourceFragments.find(f => f.id === p.fragmentId)?.text ?? "原文不可用" : p.additionId).join("；")}</p>
        </details>
        {s.status === "pending" && view.permissions?.canDecide && <><button type="button" disabled={blocked || !reason.trim() || Object.hasOwn(view.version.locks ?? {},s.assetId)} onClick={() => void run(() => submit("decide",s.id,"accepted"))}>接受设定建议 {s.id}</button><button type="button" disabled={blocked || !reason.trim()} onClick={() => void run(() => submit("decide",s.id,"rejected"))}>拒绝设定建议 {s.id}</button></>}
      </article>)}
      {pending && <><button type="button" disabled={readDisabled || restoreBlocked} onClick={() => void run(reconcile)}>核对设定原操作</button><button type="button" disabled={disabled || restoreBlocked} onClick={() => void run(() => submit(pending.kind,undefined,undefined,true))}>重新发送设定原操作</button></>}
    </div>
  </section>;
}
function validPending(v: unknown): v is SettingsReviewCommand {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const b = v as Record<string,unknown>,id = (x: unknown) => typeof x === "string" && !!x.trim() && x.length <= 256 && !/[\r\n]/.test(x);
  const fields = b.kind === "edit" || b.kind === "suggest" ? ["assetId","value"] : b.kind === "decide" ? ["suggestionId","decision"] : b.kind === "lock" || b.kind === "unlock" ? ["assetId"] : b.kind === "confirm" ? [] : null;
  return !!fields && id(b.requestId) && id(b.expectedActiveVersionId) && typeof b.reason === "string" && !!b.reason.trim() && b.reason.length <= 2000
    && Object.keys(b).every(k => ["kind","requestId","expectedActiveVersionId","reason",...fields].includes(k))
    && (b.kind === "confirm" || b.kind === "decide" ? b.kind === "confirm" || id(b.suggestionId) && ["accepted","rejected"].includes(String(b.decision)) : id(b.assetId))
    && (!(b.kind === "edit" || b.kind === "suggest") || !!b.value && typeof b.value === "object" && !Array.isArray(b.value));
}
function DefinitionFields({ label,value,onChange }: { label: string;value: unknown;onChange(v: unknown): void }) {
  if (Array.isArray(value)) return <fieldset><legend>{label}</legend>{value.map((v,i) => <DefinitionFields key={i} label={`${label} ${i+1}`} value={v} onChange={next => onChange(value.map((old,n) => n === i ? next : old))} />)}</fieldset>;
  if (value && typeof value === "object") return <fieldset><legend>{label}</legend>{Object.entries(value).map(([key,v]) => <DefinitionFields key={key} label={`${label} ${key}`} value={v} onChange={next => onChange({ ...value,[key]: next })} />)}</fieldset>;
  if (typeof value === "boolean") return <label>{label}<input type="checkbox" checked={value} onChange={e => onChange(e.target.checked)} /></label>;
  if (typeof value === "number") return <label>{label}<input type="number" value={value} onChange={e => { const n = Number(e.target.value);if (Number.isFinite(n)) onChange(n); }} /></label>;
  return <label>{label}<textarea value={value === null ? "" : String(value)} onChange={e => onChange(e.target.value)} /></label>;
}
