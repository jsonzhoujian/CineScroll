"use client";
import { useEffect, useRef, useState } from "react";
import { ApiClientError, type ApiClient, type EpisodePlanView } from "../lib/api";
import { EpisodePlanTaskPanel } from "./episode-plan-task";

export function EpisodePlanWorkbench({ api, projectId, chapterId, sourceVersionId, knowledgeVersionId }: { api: ApiClient; projectId: string; chapterId: string; sourceVersionId: string; knowledgeVersionId: string }) {
  const [view, setView] = useState<EpisodePlanView | null>(null), [selected, setSelected] = useState("");
  const [reasons, setReasons] = useState<Record<string,string>>({}), [ownBusy, setBusy] = useState(false), [taskBusy,setTaskBusy] = useState(false), [notice, setNotice] = useState("故事知识已确认，可读取后台保存的拆集方案；不会自动生成或确认。");
  const busy = ownBusy || taskBusy;
  const alive = useRef(true), locked = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  async function read() {
    const next = await api.getEpisodePlan(projectId,chapterId);
    if (next.plan.projectId !== projectId || next.plan.chapterId !== chapterId) throw new Error("wrong context");
    if (alive.current) { setView(next); setSelected(old => next.plan.episodes.some(e => e.id === old) ? old : next.plan.episodes[0]?.id ?? ""); setReasons({}); }
  }
  async function act(operation?: () => Promise<unknown>) {
    if (locked.current) return;
    locked.current = true; setBusy(true);
    try { if (operation) await operation(); await read(); if (alive.current) setNotice("已读取当前拆集方案，所有正式确认均需明确操作。"); }
    catch (error) {
      if (alive.current) {
        setView(null);
        setNotice(error instanceof ApiClientError ? error.status === 404 ? "尚无拆集候选或服务未启用；等待后台生成，不会用示例替代。" : error.status === 409 ? "原文、知识或方案已变化，请重新读取；不会自动确认。" : error.status === 403 ? "无权裁决或确认，请联系负责人。" : error.status === 401 ? "登录已失效，请重新登录。" : "读取或操作失败，请重新核对。" : "操作结果可能未知，请重新读取核对；不会自动重试。");
      }
    } finally { if (alive.current) { locked.current = false; setBusy(false); } }
  }
  const plan = view?.plan, episode = plan?.episodes.find(e => e.id === selected);
  const current = view?.current && plan?.sourceVersionId === sourceVersionId && plan?.storyBibleVersionId === knowledgeVersionId;
  const canReview = !!current && !!view?.canReview && plan?.status === "candidate";
  return <section className="episode-plan-panel task-panel" aria-label="拆集方案审核">
    <header><div><span className="eyebrow">剧本前置 · 拆集方案</span><h2>先定每集，再落笔成戏</h2></div><button type="button" className="button secondary" disabled={busy} onClick={() => void act()}>读取拆集方案</button></header>
    <p role="status">{notice}</p>
    <EpisodePlanTaskPanel api={api} projectId={projectId} chapterId={chapterId} sourceVersionId={sourceVersionId} knowledgeVersionId={knowledgeVersionId} disabled={ownBusy} hasPlan={!!plan}
      onBusy={next => { locked.current = next; setTaskBusy(next); }} onLoaded={next => { setView(next); setSelected(next.plan.episodes[0]?.id ?? ""); setReasons({}); }} />
    {plan && <>
      <p>{plan.targetDurationSeconds / 60} 分钟 / 集</p><small>方案 {plan.id} · 原文 {plan.sourceVersionId} · 知识 {plan.storyBibleVersionId}</small>
      {!current && <p className="task-notice">上游或活动方案已变化，本方案只读，不能裁决或确认。</p>}
      <p>{plan.recommendationRationale}</p>
      <nav aria-label="拆集目录">{plan.episodes.map(e => <button type="button" className="button secondary" key={e.id} aria-pressed={selected === e.id} onClick={() => setSelected(e.id)}>第{e.ordinal}集 · {e.title}</button>)}</nav>
      {episode && <div className="episode-plan-evidence"><section><h3>本集原文范围</h3>{episode.sourceFragmentIds.map(id => <article key={id}><small>{id}</small><p>{view!.sourceFragments.find(f => f.id === id)?.text ?? "原文证据不可用"}</p></article>)}</section><section><h3>本集核心事件</h3>{episode.coreEventFactIds.map(id => <p key={id}>{view!.coreEvents.find(f => f.id === id)?.statement ?? id}</p>)}</section></div>}
      <h3>重大改编建议 · {plan.majorAdaptationProposals.length}</h3>
      {plan.majorAdaptationProposals.map(p => <article className="episode-proposal" key={p.id}><b>{p.summary}</b><p>{p.rationale}</p><small>涉及事实 {p.affectedFactIds.join("、")}</small>
        {p.decision ? <p>{p.decision.outcome === "approved" ? "已批准" : "已拒绝"} · {p.decision.reason}</p> : <>
          <label>裁决理由 {p.id}<input aria-label={`裁决理由 ${p.id}`} value={reasons[p.id] ?? ""} maxLength={2000} disabled={busy || !canReview} onChange={event => setReasons(old => ({ ...old, [p.id]: event.target.value }))} /></label>
          {(["approved","rejected"] as const).map(decision => <button type="button" className="button secondary" key={decision} disabled={busy || !canReview || !reasons[p.id]?.trim()} onClick={() => void act(() => api.decideEpisodeAdaptation(projectId,chapterId,p.id,{ expectedActiveVersionId: plan.id, decision, reason: reasons[p.id]!.trim() }))}>{decision === "approved" ? "批准" : "拒绝"} {p.id}</button>)}
        </>}
      </article>)}
      {plan.status === "confirmed" ? <p>拆集方案已确认，尚未生成剧本正文。</p> : <button type="button" className="button primary" disabled={busy || !canReview || plan.majorAdaptationProposals.some(p => !p.decision)} onClick={() => void act(() => api.confirmEpisodePlan(projectId,chapterId,plan.id))}>确认拆集方案</button>}
      {!view?.canReview && plan.status !== "confirmed" && <small>仅当前方案的负责人或审核人可以裁决并正式确认。</small>}
    </>}
  </section>;
}
