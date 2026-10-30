"use client";
import { useEffect, useRef, useState } from "react";
import { ApiClientError, type ApiClient, type ModelConfiguration, type ScriptContentTask, type ScriptContentView } from "../lib/api";

type Pending = { requestId: string;configurationVersionId: string;modelId: string;expectedActiveVersionId: string;scopeKeys: string[] };
/** Only opaque task identifiers/scopes survive navigation; no manuscript or credentials in URL. */
export function ScriptContentRetry({ api,projectId,chapterId,context,view,disabled,run,onSubmitted }: {
  api: ApiClient;projectId: string;chapterId: string;context: string;view: ScriptContentView;disabled: boolean;
  run(operation: () => Promise<void>): Promise<void>;onSubmitted(task: ScriptContentTask): void;
}) {
  const [config,setConfig] = useState<ModelConfiguration | null>(null),[model,setModel] = useState("");
  const [selected,setSelected] = useState<string[]>([]),[unknown,setUnknown] = useState(false),[notice,setNotice] = useState("仅重试明确选中的失败范围，已成功内容会保留。");
  const alive = useRef(true),pending = useRef<Pending | null>(null);
  useEffect(() => {
    alive.current = true;
    const q = new URL(window.location.href).searchParams;
    if (q.get("scriptRetryContext") === context && q.get("scriptRetryPending")) {
      try {
        const saved = JSON.parse(q.get("scriptRetryPending")!);
        if (!saved || typeof saved !== "object" || ![saved.requestId,saved.configurationVersionId,saved.modelId,saved.expectedActiveVersionId].every(v => typeof v === "string" && v.trim().length > 0 && v.length <= 256)
          || !Array.isArray(saved.scopeKeys) || !saved.scopeKeys.length || saved.scopeKeys.length > 100 || saved.scopeKeys.some((s: unknown) => typeof s !== "string" || !s.trim() || s.length > 256)) throw new Error();
        pending.current = { requestId: saved.requestId,configurationVersionId: saved.configurationVersionId,modelId: saved.modelId,expectedActiveVersionId: saved.expectedActiveVersionId,scopeKeys: saved.scopeKeys };
        setSelected(saved.scopeKeys); setUnknown(true); setNotice("上次重试提交待核对，请沿用原请求。");
      } catch { setUnknown(true); setNotice("保存的重试请求无法识别，请联系负责人核对，暂不创建新任务。"); }
    }
    return () => { alive.current = false; };
  },[context]);
  useEffect(() => { if (!pending.current) setSelected([]); },[view.version.id]);
  function remember(value: Pending | null) {
    const url = new URL(window.location.href); url.searchParams.set("scriptRetryContext",context);
    if (value) url.searchParams.set("scriptRetryPending",JSON.stringify(value)); else url.searchParams.delete("scriptRetryPending");
    window.history.replaceState(null,"",url);
  }
  async function submit() {
    const reconciling = !!pending.current;
    if (!pending.current) {
      if (unknown || !config || !config.availableModelIds.includes(model) || !selected.length
        || selected.some(s => !view.version.failures.some(f => f.scopeKey === s && f.retryable))) return;
      pending.current = { requestId: crypto.randomUUID(),configurationVersionId: config.id,modelId: model,expectedActiveVersionId: view.version.id,scopeKeys: [...selected].sort() };
    }
    remember(pending.current);
    try {
      const chosen = pending.current!,task = await api.submitScriptContentRetry(projectId,chapterId,chosen),retry = task.input.retry;
      if (task.projectId !== projectId || task.chapterId !== chapterId || task.input.stage !== "script" || task.input.resultType !== "scriptContent" || !retry
        || retry.expectedActiveVersionId !== chosen.expectedActiveVersionId || retry.scopeKeys.length !== chosen.scopeKeys.length || retry.scopeKeys.some(s => !chosen.scopeKeys.includes(s))) throw new Error("wrong retry task");
      if (alive.current) {
        pending.current = null; remember(null); setUnknown(false); setSelected([]); onSubmitted(task);
        setNotice("失败范围重试已提交，完成后请明确载入结果。技术失败不代表积分已退款。");
      }
    } catch (error) {
      if (alive.current) {
        if (!reconciling && error instanceof ApiClientError && [400,403,404,409,429].includes(error.status)) { pending.current = null; remember(null); setUnknown(false); }
        else setUnknown(true);
        setNotice(error instanceof ApiClientError && error.status === 409 ? "候选已变化，请读取当前剧本；未知提交仍须核对原请求。" : "重试提交未获明确结果。未知时只能核对原请求，不会自动重投。");
      }
    }
  }
  return <section className="desktop-task-action" aria-label="剧本失败范围重试">
    <h3>局部重试</h3><p role="status">{notice}</p>
    {view.version.failures.map(f => <label key={f.scopeKey}><input type="checkbox" aria-label={`重试范围 ${f.scopeKey}`} checked={selected.includes(f.scopeKey)} disabled={disabled || unknown || !f.retryable}
      onChange={e => setSelected(old => e.target.checked ? [...old,f.scopeKey] : old.filter(s => s !== f.scopeKey))} />{f.scopeKey} · {f.retryable ? "可重试" : "需要人工处理"}</label>)}
    <button type="button" disabled={disabled || unknown} onClick={() => void run(async () => {
      const next = (await api.modelConfiguration()).configuration;
      if (alive.current) { setConfig(next?.tested && next.processingRegion === "mainland" ? next : null); setModel(""); }
    })}>读取剧本重试模型</button>
    <label>剧本重试模型<select value={model} disabled={disabled || unknown} onChange={e => setModel(e.target.value)}><option value="">请选择模型</option>{config?.availableModelIds.map(id => <option key={id}>{id}</option>)}</select></label>
    <button type="button" disabled={disabled || (!unknown && (!selected.length || !model)) || (unknown && !pending.current)} onClick={() => void run(submit)}>{unknown ? "核对剧本重试原提交" : "仅重试选中失败项"}</button>
  </section>;
}
