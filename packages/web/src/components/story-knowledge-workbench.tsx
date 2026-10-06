"use client";

import { useEffect, useMemo, useState } from "react";

import { ApiClientError, type ApiClient, type Chapter, type StoryKnowledgeVersion } from "../lib/api";
import { StoryKnowledgeRetry } from "./story-knowledge-retry";
import { EpisodePlanWorkbench } from "./episode-plan-workbench";
import { availableFactActions, buildReviewRows, canConfirmStoryKnowledge, resolutionGroupCandidates, selectFactEvidence, selectVisibleFact, storyFactTypeLabel, type FactAction, type ReviewFilter } from "../lib/story-knowledge-review";

const filters: ReadonlyArray<{ id: ReviewFilter; label: string }> = [
  { id: "all", label: "全部" }, { id: "pending", label: "待裁决" },
  { id: "explicit", label: "原文明示" }, { id: "inferred", label: "AI 推断" },
];

const conflictLabels = {
  setting_change: "设定发生变化", character_misunderstanding: "人物认知偏差",
  author_contradiction: "原著前后矛盾", other: "其他",
} as const;

export function StoryKnowledgeWorkbench({ api, project, chapter, canManageStage, onNotice, onConfirmationChange, cursor, onCursorChange, expectedVersionId }: {
  api: ApiClient;
  project: { id: string; title: string };
  chapter: Chapter;
  canManageStage: boolean;
  expectedVersionId?: string;
  onNotice(message: string): void;
  onConfirmationChange(confirmed: boolean): void;
  cursor: { filter: ReviewFilter; selectedId: string | null };
  onCursorChange(cursor: { filter: ReviewFilter; selectedId: string | null }): void;
}) {
  const [version, setVersion] = useState<StoryKnowledgeVersion | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { filter, selectedId } = cursor;
  const [statement, setStatement] = useState("");
  const [reason, setReason] = useState("");
  const [conflictClassification, setConflictClassification] = useState<keyof typeof conflictLabels>("setting_change");

  const loadVersion = () => {
    let active = true;
    setLoading(true); setLoadError(null);
    const read = async () => {
      const result = await api.getStoryKnowledge(project.id, chapter.id);
      if (expectedVersionId) {
        const current = await api.getChapter(project.id, chapter.id);
        if (result.id !== expectedVersionId || result.projectId !== project.id || result.chapterId !== chapter.id ||
          result.sourceVersionId !== chapter.activeSourceVersionId || current.id !== chapter.id || current.activeSourceVersionId !== chapter.activeSourceVersionId) {
          throw new Error("原文或活动候选已变化，停止审核；请返回任务面板查看历史结果。");
        }
      }
      return result;
    };
    void read()
      .then((result) => { if (active) { setVersion(result); onCursorChange({ filter, selectedId: selectedId && result.facts.some(({ id }) => id === selectedId) ? selectedId : result.facts[0]?.id ?? null }); onConfirmationChange(result.status === "confirmed"); } })
      .catch((error: unknown) => {
        if (!active) return;
        if (error instanceof ApiClientError && error.status === 404 && error.code === "STAGE_RESULT_NOT_FOUND") {
          setVersion(null);
          onConfirmationChange(false);
          return;
        }
        setLoadError(error instanceof Error ? error.message : "故事知识读取失败");
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  };

  useEffect(() => {
    return loadVersion();
    // api and identity callbacks are stable for the lifetime of this project view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, chapter.id, onNotice, project.id, expectedVersionId]);

  const rows = useMemo(() => version ? buildReviewRows(version, filter) : [], [filter, version]);
  const selected = selectVisibleFact(rows, selectedId);
  const evidence = version && selected ? selectFactEvidence(version, chapter, selected.id) : [];
  const resolutionCandidates = version && selected ? resolutionGroupCandidates(version, chapter, selected.id) : [];
  const actions = selected && version ? availableFactActions(selected, version.status)
    .filter((action) => canManageStage || (action !== "lock" && action !== "unlock")) : [];

  useEffect(() => {
    if (!selected) return;
    setStatement(selected.statement);
    setReason("");
  }, [selected?.id, selected?.statement]);

  const mutate = async (operation: () => Promise<StoryKnowledgeVersion>, success: string) => {
    setBusy(true);
    try {
      const next = await operation();
      setVersion(next);
      onConfirmationChange(next.status === "confirmed");
      onCursorChange({ filter, selectedId: selected?.id ?? next.facts[0]?.id ?? null });
      onNotice(success);
    } catch (error) {
      if (error instanceof ApiClientError && error.code === "VERSION_CONFLICT") {
        loadVersion();
        onNotice("内容已被其他成员更新，已刷新到最新版本");
        return;
      }
      onNotice(error instanceof Error ? error.message : "操作失败，请重试");
    } finally { setBusy(false); }
  };

  const execute = (action: FactAction) => {
    if (!version || !selected) return;
    const base = { expectedActiveVersionId: version.id, reason: reason.trim() };
    if (!base.reason) { onNotice("请填写本次判断或修改理由"); return; }
    if (action === "edit") void mutate(() => api.editStoryFact(project.id, chapter.id, selected.id, { ...base, statement: statement.trim() }), "事实已修改，并创建新版本");
    if (action === "accept" || action === "reject") void mutate(() => api.reviewStoryFact(project.id, chapter.id, selected.id, { ...base, outcome: action === "accept" ? "accepted" : "rejected" }), action === "accept" ? "已接受该事实" : "已拒绝该事实");
    if (action === "resolve") {
      const alternativeFactIds = version.facts.filter((fact) => fact.resolutionGroupId === selected.resolutionGroupId && fact.id !== selected.id && fact.resolutionStatus !== "resolved").map(({ id }) => id);
      void mutate(() => api.resolveStoryFact(project.id, chapter.id, selected.id, {
        ...base, statement: statement.trim(), alternativeFactIds,
        ...(selected.resolutionStatus === "conflicting" ? { conflictClassification } : {}),
      }), "不确定事实已裁决");
    }
    if (action === "lock" || action === "unlock") void mutate(() => api.setStoryFactLock(project.id, chapter.id, selected.id, { ...base, action }), action === "lock" ? "事实已锁定" : "事实已解锁");
  };

  const confirm = async () => {
    if (!version) return;
    if (!reason.trim()) { onNotice("请填写阶段确认理由"); return; }
    setBusy(true);
    try {
      const result = await api.confirmStoryKnowledge(project.id, chapter.id, { expectedActiveVersionId: version.id, reason: reason.trim() });
      setVersion(result.version); onConfirmationChange(true); onNotice("故事知识已确认，下游剧本阶段可以开始");
    } catch (error) {
      if (error instanceof ApiClientError && error.code === "VERSION_CONFLICT") {
        loadVersion(); onNotice("内容已被其他成员更新，已刷新到最新版本");
      } else onNotice(error instanceof Error ? error.message : "确认失败，请重试");
    }
    finally { setBusy(false); }
  };

  if (loading) return <ReviewEmpty mark="阅" title="正在展开故事知识" note="正在读取人物、事件、关系与原文证据……" />;
  if (loadError) return <div className="review-empty"><span>断</span><div><h2>故事知识读取失败</h2><p>{loadError}</p><button type="button" className="button secondary" onClick={loadVersion}>重新读取</button></div></div>;
  if (!version) return <ReviewEmpty mark="候" title="尚无故事知识候选版本" note="原文已就绪；等待后台提取任务完成后，即可在这里逐项审核。" />;

  const confirmation = canConfirmStoryKnowledge(version);

  return <div className="knowledge-workbench">
    <header className="knowledge-head">
      <div><span className="eyebrow">故事知识 · 版本 {version.id}</span><h2>逐条核证，再让故事进入剧本</h2><p>{chapter.title} · {version.facts.length} 条事实 · {version.failures.length} 项局部失败</p></div>
      <div className={`knowledge-state state-${version.status}`}><b>{version.status === "confirmed" ? "已确认" : version.status === "needs_resolution" ? "待裁决" : "待审核"}</b><small>{version.extractionStatus === "partially_succeeded" ? "部分提取成功" : version.extractionStatus === "failed" ? "提取失败" : "提取完成"}</small></div>
    </header>
    <nav className="knowledge-filters" aria-label="故事事实筛选">{filters.map((item) => <button type="button" key={item.id} aria-pressed={filter === item.id} className={filter === item.id ? "active" : ""} onClick={() => onCursorChange({ filter: item.id, selectedId })}>{item.label}<span>{buildReviewRows(version, item.id).length}</span></button>)}</nav>
    {version.status !== "confirmed" && version.failures.length > 0 && <StoryKnowledgeRetry key={version.id} api={api} version={version} disabled={busy} onLoaded={next => { setVersion(next); onConfirmationChange(false); onCursorChange({ filter, selectedId: next.facts[0]?.id ?? null }); onNotice("重试候选已载入，请继续逐项审核；不会自动确认。"); }} />}
    {version.status === "confirmed" && <EpisodePlanWorkbench key={`${project.id}:${chapter.id}:${version.id}`} api={api} projectId={project.id} chapterId={chapter.id} sourceVersionId={chapter.activeSourceVersionId} knowledgeVersionId={version.id} />}
    <div className="knowledge-grid">
      <aside className="fact-ledger" aria-label="故事事实目录">
        {rows.map((row, index) => <button type="button" key={row.id} aria-current={selected?.id === row.id} className={selected?.id === row.id ? "selected" : ""} onClick={() => onCursorChange({ filter, selectedId: row.id })}>
          <span className="ledger-no">{String(index + 1).padStart(2, "0")}</span><span><small>{row.typeLabel} · {row.provenance}</small><b>{row.statement}</b><em>{row.state}</em></span>
        </button>)}
        {rows.length === 0 && <p className="ledger-empty">当前筛选下没有故事事实。</p>}
        {version.failures.map((failure) => <div className="failure-row" key={failure.scopeKey}><small>局部失败 · {failure.scopeKey}</small><b>{failure.message}</b><span>{failure.retryable ? "可在任务中心局部重试" : "不可自动重试"}</span></div>)}
      </aside>
      {selected ? <section className="fact-inspector">
        <div className="fact-meta"><span>{storyFactTypeLabel(selected.factType)}</span><i className={`provenance-${selected.assertionKind}`}>{selected.assertionKind === "explicit" ? "原文明示" : selected.assertionKind === "inferred" ? "AI 推断" : "用户确认"}</i>{selected.locked && <strong>已锁定</strong>}</div>
        {resolutionCandidates.length > 0 && <div className="candidate-group"><span>同组候选与全部证据</span>{resolutionCandidates.map((candidate) => <article key={candidate.id} className={candidate.id === selected.id ? "selected" : ""}><b>{candidate.statement}</b>{candidate.evidence.map((fragment) => <p key={fragment.id}>{fragment.text}</p>)}</article>)}</div>}
        <label><span>事实陈述</span><textarea value={statement} disabled={!actions.includes("edit") && !actions.includes("resolve")} onChange={(event) => setStatement(event.target.value)} /></label>
        {selected.resolutionStatus === "conflicting" && <label><span>冲突分类</span><select value={conflictClassification} onChange={(event) => setConflictClassification(event.target.value as keyof typeof conflictLabels)}>{Object.entries(conflictLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>}
        <label><span>本次判断理由</span><textarea className="reason-input" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="说明为何修改、接受、拒绝、裁决或锁定" /></label>
        <div className="fact-actions">{actions.map((action) => <button type="button" disabled={busy} className={`action-${action} ${action === "accept" || action === "resolve" || action === "lock" ? "primary" : ""}`} key={action} onClick={() => execute(action)}>{actionLabel(action)}</button>)}</div>
        {selected.decision && <div className={`decision-note ${selected.decision.outcome}`}><b>{selected.decision.outcome === "accepted" ? "已接受" : "已拒绝"}</b><p>{selected.decision.reason}</p></div>}
      </section> : <section className="fact-inspector empty">请选择一条故事事实。</section>}
      <aside className="evidence-column"><span className="eyebrow">原文证据</span><h3>每个判断都有出处</h3>{evidence.map((fragment) => <article key={fragment.id}><small>片段 {String(fragment.ordinal + 1).padStart(2, "0")}</small><p>{fragment.text}</p></article>)}{evidence.length === 0 && <p className="no-evidence">当前事实没有可显示的原文证据。</p>}</aside>
    </div>
    <footer className="knowledge-footer"><p>{canManageStage ? confirmation.reason ?? "确认后生成故事圣经；后续修改会创建新版本，不覆盖当前记录。" : "仅负责人或审核人可以确认阶段与锁定事实。"}</p>{canManageStage && version.status !== "confirmed" && <button type="button" className="button primary" disabled={busy || !confirmation.allowed} onClick={confirm}>确认故事知识阶段</button>}</footer>
  </div>;
}

function ReviewEmpty({ mark, title, note }: { mark: string; title: string; note: string }) {
  return <div className="review-empty"><span>{mark}</span><div><h2>{title}</h2><p>{note}</p></div></div>;
}

function actionLabel(action: FactAction) {
  return ({ edit: "保存修改", accept: "接受", reject: "拒绝", resolve: "确认裁决", lock: "锁定", unlock: "解锁" } as const)[action];
}
