"use client";
import { useEffect,useState } from "react";
import { ApiClientError,type ApiClient,type ModelConfiguration,type ScriptContentView,type ScriptQualityView,type ScriptPublicationCommand } from "../lib/api";
const qualityReasons: Record<string,string> = { CONTEXT_MISMATCH: "报告依据与当前原文或拆集不一致",INVALID_CONTEXT: "已确认知识或核心事件不完整",INVALID_TRACEABILITY: "内容存在失败、未决建议或缺失依据",ASSESSOR_UNAVAILABLE: "评估服务未返回可用结果",INVALID_ASSESSMENT: "评估结果格式或引用无效",INCOMPLETE_ASSESSMENT: "评估结果有缺项",UNCERTAIN_EVENT_COVERAGE: "部分核心事件是否覆盖尚不确定",LOW_EVENT_COVERAGE: "核心事件覆盖率低于 90%",FACT_CONFLICT_OR_UNCERTAINTY: "核心事实存在冲突或不确定",UNSUPPORTED_CORE_FACT: "存在未经批准的核心事实新增",DURATION_ESTIMATE_OUT_OF_RANGE: "单集估算时长偏差超过 10%" };
type AssessmentRequest = { requestId: string;configurationVersionId: string;modelId: string;expectedActiveVersionId: string };
export function ScriptPublication({ api,projectId,chapterId,context,view,selectedId,disabled,run,onChanged }: { api: ApiClient;projectId: string;chapterId: string;context: string;view: ScriptContentView;selectedId: string;disabled: boolean;run(operation: () => Promise<void>): Promise<void>;onChanged(): Promise<void> }) {
  const [history,setHistory] = useState<ScriptQualityView["task"][]>([]),[nextCursor,setNextCursor] = useState<string | null>(null);
  const [reason,setReason] = useState("");
  const [configuration,setConfiguration] = useState<ModelConfiguration | null>(null),[model,setModel] = useState("");
  const [pending,setPending] = useState<AssessmentRequest | null>(null),[publication,setPublication] = useState<ScriptPublicationCommand | null>(null);
  const [taskId,setTaskId] = useState(""),[result,setResult] = useState<ScriptQualityView | null>(null),[notice,setNotice] = useState("质量评估通过后，可明确确认正式剧本。"),[invalid,setInvalid] = useState(false);
  const formal = view.version.status === "confirmed",canReview = !!view.permissions?.canDecide;
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get("scriptQualityContext") !== context) { setTaskId(view.version.qualityReportId ?? "");return; }
    setTaskId(url.searchParams.get("scriptQualityTask") ?? "");
    try {
      const q = url.searchParams.get("scriptQualityPending"),p = url.searchParams.get("scriptPublicationPending");
      if (q) { const v = JSON.parse(q); if (!v || Object.keys(v).sort().join() !== "configurationVersionId,expectedActiveVersionId,modelId,requestId" || !Object.values(v).every(x => typeof x === "string" && x.length > 0 && x.length <= 256)) throw new Error(); setPending(v); }
      if (p) { const v = JSON.parse(p);v.reason = sessionStorage.getItem(`script-publication-reason:${v.requestId}`); if (!v || !["confirm","lock"].includes(v.kind) || typeof v.requestId !== "string" || typeof v.expectedActiveVersionId !== "string" || typeof v.reason !== "string" || !v.reason.trim() || (v.kind === "confirm" ? typeof v.reportId !== "string" : !Array.isArray(v.elementIds) || !v.elementIds.every((x: unknown) => typeof x === "string"))) throw new Error(); setPublication(v); }
    } catch { setInvalid(true);setNotice("保存的操作标识无效，请核对历史任务后再操作。"); }
  },[context]);
  function remember(q: AssessmentRequest | null,p: ScriptPublicationCommand | null,id = taskId) {
    const url = new URL(window.location.href);url.searchParams.set("scriptQualityContext",context);
    let publicationIdentity: Omit<ScriptPublicationCommand,"reason"> | null = null;
    if (p) { const { reason: operationReason,...identity } = p;publicationIdentity = identity;sessionStorage.setItem(`script-publication-reason:${p.requestId}`,operationReason); }
    else { const previous = url.searchParams.get("scriptPublicationPending");if (previous) { const identity = JSON.parse(previous);sessionStorage.removeItem(`script-publication-reason:${identity.requestId}`); } }
    for (const [key,value] of [["scriptQualityPending",q ? JSON.stringify(q) : null],["scriptPublicationPending",publicationIdentity ? JSON.stringify(publicationIdentity) : null],["scriptQualityTask",id || null]]) { if (value) url.searchParams.set(key!,value);else url.searchParams.delete(key!); }
    window.history.replaceState(null,"",url);
  }
  async function assess() {
    if (!pending && (!configuration || !model)) return;
    const input = pending ?? { requestId: crypto.randomUUID(),configurationVersionId: configuration!.id,modelId: model,expectedActiveVersionId: view.version.id };
    const reconciling = !!pending;setPending(input);remember(input,publication);
    try {
      const task = await api.submitScriptQuality(projectId,chapterId,input);
      if (task.projectId !== projectId || task.chapterId !== chapterId || task.input.resultType !== "scriptQuality" || task.input.qualityTarget.candidateVersionId !== input.expectedActiveVersionId) throw new Error();
      setTaskId(task.id);setPending(null);setResult({ task,report: null });remember(null,publication,task.id);setNotice("质量评估已提交，请读取质量报告核对结果。");
    } catch (error) {
      if (!reconciling && error instanceof ApiClientError && [400,403,404,409,429].includes(error.status)) { setPending(null);remember(null,publication); }
      setNotice("评估提交结果待核对，不会自动重新评估。");
    }
  }
  async function list(cursor: string | null = null) {
    const page = await api.listScriptQuality(projectId,chapterId,cursor);
    if (page.tasks.some(t => t.projectId !== projectId || t.chapterId !== chapterId || t.input.resultType !== "scriptQuality")) throw new Error();
    setHistory(cursor ? [...history,...page.tasks] : page.tasks);setNextCursor(page.nextCursor);
  }
  async function readReport() {
    const next = await api.getScriptQuality(projectId,chapterId,taskId);
    if (next.task.id !== taskId || next.task.projectId !== projectId || next.task.chapterId !== chapterId || next.task.input.resultType !== "scriptQuality" || next.report && (next.report.id !== taskId || next.report.candidateVersionId !== next.task.input.qualityTarget.candidateVersionId)) throw new Error();
    setResult(next);setNotice(next.task.reason === "EXECUTION_UNCERTAIN" ? "评估结果未知，请等待恢复或人工核对，不要重复评估。" : next.report ? "报告已读取，请核对绑定版本和阻断原因。" : "评估尚未完成。");
  }
  async function publish(kind: "confirm" | "lock") {
    const input: ScriptPublicationCommand = publication ?? (kind === "confirm" ? { kind,reason: reason.trim(),requestId: crypto.randomUUID(),expectedActiveVersionId: view.version.id,reportId: result!.report!.id } : { kind,reason: reason.trim(),requestId: crypto.randomUUID(),expectedActiveVersionId: view.version.id,elementIds: [selectedId] });
    const reconciling = !!publication;
    setPublication(input);remember(pending,input);
    try { await api.publishScriptContent(projectId,chapterId,input);await onChanged();setPublication(null);remember(pending,null);setNotice(input.kind === "confirm" ? "剧本已正式确认。" : "元素已锁定，原文依据仍可读取。"); }
    catch (error) {
      if (!reconciling && error instanceof ApiClientError && [400,403,404,409].includes(error.status)) { setPublication(null);remember(pending,null);setNotice("正式操作被拒绝，请读取当前剧本后重新核对。"); }
      else setNotice("正式操作结果待核对，请核对原操作；不会自动重复提交。");
    }
  }
  const report = result?.report,matching = report?.candidateVersionId === view.version.id;
  const blocked = disabled || invalid || !!publication;
  const unresolved = result?.task.input.qualityTarget.candidateVersionId === view.version.id && (["queued","running"].includes(result.task.state) || result.task.reason === "EXECUTION_UNCERTAIN");
  return <section aria-label="剧本质量与确认"><h3>质量报告与正式确认</h3><p role="status">{notice}</p>
    <p>剧本状态：{formal ? "正式" : "候选"}{view.version.confirmedBy ? ` · 确认人 ${view.version.confirmedBy}` : ""}</p>
    <div className="desktop-task-action">
      {canReview && !formal && <><button type="button" disabled={blocked || !!pending || unresolved} onClick={() => void run(async () => { const config = (await api.modelConfiguration()).configuration;setConfiguration(config?.tested && config.processingRegion === "mainland" ? config : null);setModel(""); })}>读取质量模型</button>
        <label>质量评估模型<select value={model} disabled={blocked || !!pending || unresolved} onChange={e => setModel(e.target.value)}><option value="">选择模型</option>{configuration?.availableModelIds.map(m => <option key={m}>{m}</option>)}</select></label>
        <button type="button" disabled={blocked || (!pending && (!model || unresolved))} onClick={() => void run(assess)}>{pending ? "核对质量原提交" : "评估当前剧本"}</button></>}
      {publication && canReview && <button type="button" disabled={disabled || invalid} onClick={() => void run(() => publish(publication.kind))}>核对正式原操作</button>}
    </div>
    <button type="button" disabled={disabled} onClick={() => void run(() => list())}>查找质量任务</button>
    {history.map(t => <button type="button" key={t.id} disabled={disabled || !!pending || !!publication} onClick={() => { setTaskId(t.id);setResult(null);remember(pending,publication,t.id); }}>{t.id} · {t.state} · {t.input.qualityTarget.candidateVersionId}</button>)}
    {nextCursor && <button type="button" disabled={disabled} onClick={() => void run(() => list(nextCursor))}>更多质量任务</button>}
    {taskId && <button type="button" disabled={disabled} onClick={() => void run(readReport)}>读取质量报告</button>}
    {result && <p>评估任务：{result.task.state} {result.task.reason}</p>}
    {report && <article><p>报告版本 {report.candidateVersionId} · 规则 {report.ruleVersion} · {report.passed ? "通过" : "未通过"} · 核心事件覆盖率 {Math.round(report.coverage * 100)}%</p>
      {report.reasons.map(reason => <p key={reason}>阻断原因：{qualityReasons[reason] ?? "报告尚未通过，请核对评估结果"}</p>)}{report.assessment?.episodes.map(e => <p key={e.episodeId}>集 {e.episodeId}：估算 {e.estimatedSeconds} 秒</p>)}
      {!matching && !formal && <p>报告已过期，请评估当前候选。</p>}</article>}
    <div className="desktop-task-action">{canReview && <label>正式操作理由<input value={reason} maxLength={2000} disabled={blocked} onChange={e => setReason(e.target.value)} /></label>}{canReview && !formal && <button type="button" disabled={blocked || !reason.trim() || !!pending || !matching || !report?.passed || result?.task.state !== "succeeded" || !!view.version.failures.length || view.version.suggestions?.some(s => s.status === "pending")} onClick={() => void run(() => publish("confirm"))}>确认正式剧本</button>}
      {canReview && formal && <button type="button" disabled={blocked || !reason.trim() || !selectedId || !!view.version.elements.find(e => e.id === selectedId)?.lockedAt} onClick={() => void run(() => publish("lock"))}>锁定当前元素</button>}</div>
  </section>;
}
