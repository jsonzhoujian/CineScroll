"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ApiClientError, type ApiClient, type ModelConfiguration, type StoryboardReviewCommand, type StoryboardRevisedShot, type StoryboardPublication, type StoryboardAuditCursor, type StoryboardAuditEvent, type StoryboardReconciliationPreview, type StoryboardRetry, type StoryboardSubmission, type StoryboardTask, type StoryboardView } from "../lib/api";
import { StoryboardShotReview } from "./storyboard-shot-review";
import { readStoryboardShot, writeStoryboardCursor } from "../lib/storyboard-cursor";
import type { StoryboardImpactTarget } from "../lib/storyboard-impact-navigation";
import { taskPresentation } from "../lib/task-status";

type Pending = StoryboardSubmission & Partial<StoryboardRetry>;

function readPending(key: string): Pending | null {
  const saved = sessionStorage.getItem(key);
  if (saved === null) return null;
  const value = JSON.parse(saved) as Pending;
  const validId = (id: unknown) => typeof id === "string" && !!id.trim() && id.length <= 256 && !/[\r\n]/.test(id);
  if (!value || ![value.configurationVersionId,value.modelId,value.requestId].every(validId)
    || ((value.scopeKeys !== undefined || value.expectedActiveVersionId !== undefined)
      && (!validId(value.expectedActiveVersionId) || !Array.isArray(value.scopeKeys) || !value.scopeKeys.length
        || value.scopeKeys.length > 100 || new Set(value.scopeKeys).size !== value.scopeKeys.length || !value.scopeKeys.every(validId)))) throw new Error("INVALID_SAVED_SUBMISSION");
  return value;
}

const auditLabels = new Map([
  ["submit","提交审核"],["suggest","提出建议"],["edit","编辑镜头"],["decide","处理建议"],
  ["lock","锁定镜头"],["unlock","解锁镜头"],["confirm","确认发布"],["retain","原样保留"],
  ["revise","核对修订"],["adopt","采用重生"],
]);

export function StoryboardWorkbench({ api, projectId, chapterId, active, impactTarget, onImpactHandled }: { api: ApiClient; projectId: string; chapterId: string; active: boolean; impactTarget: StoryboardImpactTarget | null; onImpactHandled(target: null): void }) {
  const [ready,setReady] = useState(false);
  const [models,setModels] = useState<ModelConfiguration | null>(null);
  const [model,setModel] = useState("");
  const [tasks,setTasks] = useState<StoryboardTask[]>([]);
  const [cursor,setCursor] = useState<string | null>(null);
  const [publications,setPublications] = useState<StoryboardPublication[] | null>(null);
  const [audit,setAudit] = useState<{ scope: string; events: StoryboardAuditEvent[]; nextCursor: StoryboardAuditCursor | null } | null>(null);
  const auditScope = JSON.stringify([projectId,chapterId]);
  const chapterAudit = audit?.scope === auditScope ? audit : null;
  const [publicationCursor,setPublicationCursor] = useState<string | null>(null);
  const [adoptedShots,setAdoptedShots] = useState<Record<string,string[]>>({});
  const regenerationFormId = useId();
  const reconciliationConfirmation = useRef<{ draftId: string; reason: string; requestId: string } | null>(null);
  const regenerationRequest = useRef<{ key: string; requestId: string } | null>(null);
  const [reconciliationDraft,setReconciliationDraft] = useState<{ id: string; retainedShotIds: string[]; revisedShots: StoryboardRevisedShot[]; regeneratedShots: StoryboardView["version"]["shots"] } | null>(null);
  const [reconciliation,setReconciliation] = useState<StoryboardReconciliationPreview | null>(null);
  const [pinnedPublication,setPinnedPublication] = useState<string | null>(null);
  const [reviews,setReviews] = useState<Array<{ id: string; submittedAt: string }>>([]);
  const [reviewCursor,setReviewCursor] = useState<string | null>(null);
  const [submitted,setSubmitted] = useState<Record<string,string>>({});
  const [task,setTask] = useState<StoryboardTask | null>(null);
  const [view,setView] = useState<StoryboardView | null>(null);
  const [confirmationReason,setConfirmationReason] = useState("");
  const shotHeading = useRef<HTMLHeadingElement>(null);
  const impactView = useRef<StoryboardView | null>(null);
  const [shotId,setShotId] = useState("");
  const [scopes,setScopes] = useState<string[]>([]);
  const [busy,setBusy] = useState(false);
  const [notice,setNotice] = useState("");
  const inFlight = useRef(false);
  const pending = useRef<Pending | null>(null);
  const storageKey = useRef<string | null>(null);

  function applyReadiness(result: Awaited<ReturnType<ApiClient["storyboardReadiness"]>>) {
    const key = `storyboard-submission:${JSON.stringify([result.userId,projectId,chapterId])}`;
    if (storageKey.current !== key) {
      try {
        pending.current = readPending(key);
        storageKey.current = key;
        if (pending.current) setNotice("上次提交结果待核对，请沿用原提交。");
      } catch {
        setReady(false);
        setNotice("无法读取上次提交记录，暂不能提交分镜任务。");
        return;
      }
    }
    setReady(result.ready);
  }

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void api.storyboardReadiness(projectId,chapterId).then(result => {
      if (!cancelled) applyReadiness(result);
    }).catch(() => {});
    return () => { cancelled = true; };
  },[api,projectId,chapterId,active]);

  useEffect(() => {
    if (!active || !view) return;
    if (impactView.current === view) {
      impactView.current = null;
      shotHeading.current?.focus();
      return;
    }
    const query = new URL(window.location.href).searchParams;
    setShotId(selected => readStoryboardShot(view,query,selected) ?? selected);
  },[active,view]);

  useEffect(() => {
    if (!active || busy || inFlight.current || !impactTarget
      || impactTarget.projectId !== projectId || impactTarget.chapterId !== chapterId) return;
    onImpactHandled(null);
    void act(() => loadReview(impactTarget.reviewId,false,null,impactTarget.shotId));
  },[active,busy,impactTarget,projectId,chapterId,onImpactHandled]);

  function selectShot(id: string, fragmentId?: string) {
    setShotId(id);
    if (!view) return;
    const url = new URL(window.location.href);
    writeStoryboardCursor(url.searchParams,view,id,fragmentId);
    window.history.replaceState(null,"",url);
  }

  function checkTask(next: StoryboardTask, id = next.id) {
    if (next.id !== id || next.projectId !== projectId || next.chapterId !== chapterId
      || next.input.stage !== "storyboard" || next.input.resultType !== "storyboardContent") throw new Error("WRONG_TASK");
    return next;
  }

  async function act(operation: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try { await operation(); }
    catch (error) {
      const login = error instanceof ApiClientError && error.status === 401;
      setNotice(login ? "登录已失效，请重新登录。" : pending.current ? "提交结果待核对，请沿用原提交。"
        : error instanceof ApiClientError && error.code === "DURATION_OUT_OF_RANGE" ? "每集时长须在目标时长的 ±10% 以内。"
        : error instanceof ApiClientError && error.code === "REVIEW_INCOMPLETE" ? "请补齐缺失镜头并处理失败项和待决建议。"
        : view?.reviewId && error instanceof ApiClientError && error.status === 409 ? "审核版本或上游已变化，请刷新当前审核候选。"
        : "操作失败，请刷新后再试。");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function submit(retry?: StoryboardRetry) {
    const key = storageKey.current;
    if (!key) return;
    const replay = !!pending.current;
    if (!pending.current) {
      if (!ready || !models || !model) return;
      const next = { configurationVersionId: models.id,modelId: model,requestId: crypto.randomUUID(),...retry };
      sessionStorage.setItem(key,JSON.stringify(next));
      pending.current = next;
    }
    try {
      const next = checkTask(await api.submitStoryboard(projectId,chapterId,pending.current));
      sessionStorage.removeItem(key);
      pending.current = null;
      setTask(next);
      setNotice("分镜任务已提交。完成后可载入候选。");
    } catch (error) {
      if (error instanceof ApiClientError && ([400,409].includes(error.status) || !replay && [403,404,429].includes(error.status))) {
        sessionStorage.removeItem(key);
        pending.current = null;
      }
      if (error instanceof ApiClientError && error.code === "UPSTREAM_CHANGED") { setReady(false); setNotice("正式上游或失败范围已变化，请刷新核对。"); return; }
      throw error;
    }
  }

  async function refresh(more = false) {
    const page = await api.listStoryboardTasks(projectId,chapterId,more ? cursor : null);
    page.tasks.forEach(next => checkTask(next));
    setTasks(old => more ? [...old,...page.tasks.filter(next => !old.some(previous => previous.id === next.id))] : page.tasks);
    setCursor(page.nextCursor);
    if (!more) {
      if (task) setTask(checkTask(await api.getStoryboardTask(projectId,chapterId,task.id),task.id));
      setNotice("");
      applyReadiness(await api.storyboardReadiness(projectId,chapterId));
    }
  }

  async function load() {
    if (!task?.result || task.state !== "succeeded") return;
    const next = await api.getStoryboardCandidate(projectId,chapterId,task.id);
    const { version } = next, ids = task.input.upstreamConfirmedVersionIds;
    if (version.jobId !== task.id || version.jobId !== task.result.candidateVersionId || version.projectId !== projectId
      || version.chapterId !== chapterId || version.sourceVersionId !== task.input.sourceVersionId
      || version.upstreamConfirmedVersionIds.length !== ids.length || ids.some((id,i) => id !== version.upstreamConfirmedVersionIds[i])) throw new Error("WRONG_CANDIDATE");
    setView(next);
    setShotId("");
    setScopes([]);
    setNotice("");
  }

  async function readReviews(more = false) {
    const page = await api.listStoryboardReviews(projectId,chapterId,more ? reviewCursor : null);
    setReviews(old => more ? [...old,...page.reviews] : page.reviews);
    setReviewCursor(page.nextCursor);
  }

  async function submitReview(jobId: string) {
    const review = await api.submitStoryboardReview(projectId,chapterId,jobId);
    setSubmitted(old => ({ ...old,[jobId]: review.id }));
    setNotice("已提交审核，项目成员可查看此候选。");
  }

  async function loadReview(id: string | null, preserveShot = false, publicationId: string | null = null, impactShotId?: string) {
    const next = publicationId !== null ? await api.getStoryboardPublication(projectId,chapterId,publicationId) : id === null ? await api.getConfirmedStoryboard(projectId,chapterId) : await api.getStoryboardReview(projectId,chapterId,id);
    if ((publicationId !== null && next.publicationId !== publicationId) || (id === null ? !next.formalRead : next.reviewId !== id) || next.version.projectId !== projectId || next.version.chapterId !== chapterId || next.version.jobId !== undefined) throw new Error("WRONG_REVIEW");
    if (impactShotId !== undefined && !next.version.shots.some(shot => shot.id === impactShotId)) {
      setNotice("该审核候选找不到受影响的镜头。");
      return;
    }
    setReconciliation(null);
    setReconciliationDraft(null);
    setPinnedPublication(publicationId);
    setTask(null);
    setScopes([]);
    if (!preserveShot) setShotId(impactShotId ?? "");
    impactView.current = impactShotId === undefined ? null : next;
    setView(next);
    setNotice("");
  }

  async function readAudit(more = false) {
    const page = await api.listStoryboardAudit(projectId,chapterId,more ? chapterAudit?.nextCursor ?? null : null);
    setAudit({ scope: auditScope,events: more ? [...(chapterAudit?.events ?? []),...page.events] : page.events,nextCursor: page.nextCursor });
  }

  async function readPublications(more = false) {
    const page = await api.listStoryboardPublications(projectId,chapterId,more ? publicationCursor : null);
    setPublications(old => more ? [...(old ?? []),...page.publications] : page.publications);
    setPublicationCursor(page.nextCursor);
  }

  async function saveReview(command: StoryboardReviewCommand) {
    await act(async () => {
      const next = await api.operateStoryboardReview(projectId,chapterId,view!.reviewId!,command);
      if (next.reviewId !== view?.reviewId || next.version.projectId !== projectId || next.version.chapterId !== chapterId
        || next.version.jobId !== undefined || next.revision === undefined || next.revision <= command.expectedRevision) throw new Error("WRONG_REVIEW");
      setView(next);
      setConfirmationReason("");
      setNotice(command.kind === "confirm" ? "分镜已正式确认。" : "分镜审核已保存。");
    });
  }

  const selected = view?.version.shots.find(shot => shot.id === shotId);
  const elements = view?.scriptElements.filter(element => element.sceneId === selected?.sceneId && selected.scriptElementIds.includes(element.id)) ?? [];
  const evidence = selected?.provenance.filter(item => item.type === "source_fragment" && item.sourceVersionId === view?.version.sourceVersionId) ?? [];
  const fragments = view?.sourceFragments.filter(fragment => evidence.some(item => item.fragmentId === fragment.id)) ?? [];
  const status = task && taskPresentation(task);
  const canStartAnother = task && (task.state === "succeeded" || task.state === "failed" || task.state === "paused" && task.reason !== "EXECUTION_UNCERTAIN");
  const retryEnabled = ready && !!view?.current && !!view.version.jobId && task?.id === view.version.jobId && !task.input.storyboardRegeneration && !!model && !pending.current;

  return <section className="mode-workspace storyboard task-panel" aria-label="分镜候选生成与追溯">
    <h2>分镜工作台</h2>
    {!ready && <p>正式内容尚未解锁</p>}
    <p role="status">{notice}</p>
    <div className="desktop-task-action">
      <button type="button" disabled={busy || !ready || !!pending.current} onClick={() => void act(async () => {
        const next = (await api.modelConfiguration()).configuration;
        setModels(next?.tested && next.processingRegion === "mainland" && next.providerId === "deepseek" ? next : null);
        setModel("");
      })}>读取分镜模型</button>
      <label>分镜模型<select value={model} disabled={busy || !models || !!pending.current} onChange={e => setModel(e.target.value)}>
        <option value="">选择模型</option>{models?.availableModelIds.map(id => <option key={id}>{id}</option>)}
      </select></label>
      <button type="button" disabled={busy || (!pending.current && (!ready || !model || !!task || !!view))} onClick={() => void act(() => submit())}>
        {pending.current ? "核对分镜原提交" : "生成分镜候选"}
      </button>
    </div>
    <button type="button" disabled={busy} onClick={() => void act(() => refresh())}>刷新分镜任务</button>
    {tasks.length > 0 && <ul aria-label="分镜任务记录">{tasks.map(item => <li key={item.id}>
      <button type="button" aria-pressed={task?.id === item.id} disabled={busy || !!pending.current} onClick={() => { setTask(item); setView(null); setScopes([]); }}>
        {taskPresentation(item).label} · {item.id}
      </button>
    </li>)}</ul>}
    {cursor && <button type="button" disabled={busy} onClick={() => void act(() => refresh(true))}>更多分镜任务</button>}
    <button type="button" disabled={busy} onClick={() => void act(() => readReviews())}>读取项目审核候选</button>
    <button type="button" disabled={busy} onClick={() => void act(() => loadReview(null))}>读取正式分镜</button>
    <button type="button" disabled={busy} onClick={() => void act(() => readAudit())}>查看分镜审计</button>
    {chapterAudit && <section aria-label="分镜审计">
      {chapterAudit.events.length === 0 ? <p>暂无分镜审核记录。</p> : <ol>
        {chapterAudit.events.map(event => <li key={event.eventId}>
          <time dateTime={event.recordedAt}>{new Date(event.recordedAt).toLocaleString("zh-CN")}</time>
          {" · "}{auditLabels.get(event.kind) ?? event.kind}{" · "}{event.actorId}
          {event.shotId && ` · 镜头 ${event.shotId}`}
          {event.decision && (event.decision === "accepted" ? " · 已采纳" : " · 已驳回")}
          {event.reason && <p>{event.reason}</p>}
          {event.publicationId && <button type="button" disabled={busy}
            onClick={() => void act(() => loadReview(null,false,event.publicationId))}>查看发布 {event.publicationId}</button>}
        </li>)}
      </ol>}
      {chapterAudit.nextCursor && <button type="button" disabled={busy} onClick={() => void act(() => readAudit(true))}>更多审计记录</button>}
    </section>}
    <button type="button" disabled={busy} onClick={() => void act(() => readPublications())}>读取分镜发布历史</button>
    {publications?.length === 0 && <p>暂无正式发布</p>}
    {!!publications?.length && <ul aria-label="分镜发布历史">{publications.map(publication => <li key={publication.id}>
      <button type="button" disabled={busy} aria-pressed={view?.formalRead === true && pinnedPublication === publication.id}
        onClick={() => void act(() => loadReview(null,false,publication.id))}>
        发布 {publication.id} · 修订 {publication.revision} · {new Date(publication.confirmedAt).toLocaleString("zh-CN")}
      </button>
    </li>)}</ul>}
    {publicationCursor && <button type="button" disabled={busy} onClick={() => void act(() => readPublications(true))}>更多分镜发布</button>}
    {reviews.length > 0 && <ul aria-label="项目分镜审核候选">{reviews.map(review => <li key={review.id}>
      <button type="button" disabled={busy} aria-pressed={!!view && !view.formalRead && view.reviewId === review.id} onClick={() => void act(() => loadReview(review.id))}>
        审核候选 · {new Date(review.submittedAt).toLocaleString("zh-CN")} · {review.id.slice(0,8)}
      </button>
    </li>)}</ul>}
    {reviewCursor && <button type="button" disabled={busy} onClick={() => void act(() => readReviews(true))}>更多审核候选</button>}
    {status && <p>{status.label}{task?.state === "queued" ? " · 等待后台执行" : ` · ${status.note}`}</p>}
    {(canStartAnother || view?.reviewId) && <button type="button" disabled={busy || !!pending.current} onClick={() => {
      setTask(null); setView(null); setScopes([]); setShotId(""); setNotice("");
    }}>返回分镜任务列表</button>}
    {task?.state === "succeeded" && task.result && <button type="button" disabled={busy || !!pending.current} onClick={() => void act(load)}>载入分镜候选</button>}
    {view && <div className="storyboard-candidate">
      <h3>{view.formalRead ? (pinnedPublication ? `正式分镜 · 发布 ${pinnedPublication}` : "正式分镜") : view.reviewId ? "项目审核候选" : "分镜候选"}</h3>
      {view.confirmed && !view.formalRead && <p>当前镜头内容已正式确认</p>}
      {!!view.episodeDurations?.length && <ul aria-label="逐集时长">
        {view.episodeDurations.map(episode => <li key={episode.id}>{episode.title} · {episode.seconds === null ? "超出显示范围" : `${Number(episode.seconds.toPrecision(12))} 秒`}
          { ` · 目标 ${episode.targetSeconds} 秒` }</li>)}
      </ul>}
      {view.permissions?.canConfirm && <div className="desktop-task-action">
        <label>分镜确认理由<input maxLength={2000} value={confirmationReason} onChange={event => setConfirmationReason(event.target.value)} /></label>
        <button type="button" disabled={busy || !confirmationReason.trim()} onClick={() => void saveReview({
          kind: "confirm",requestId: crypto.randomUUID(),expectedRevision: view.revision!,
          expectedPublicationId: view.publicationId ?? null,reason: confirmationReason.trim(),
        })}>确认正式分镜</button>
      </div>}
      {view.reviewId && <button type="button" disabled={busy} onClick={() => void act(() => loadReview(view.formalRead ? null : view.reviewId!,true,view.formalRead ? pinnedPublication : null))}>刷新当前审核候选</button>}
      {view.version.jobId && !task?.input.storyboardRegeneration && (submitted[view.version.jobId] ? <p>已提交审核</p> : <button className="desktop-task-action" type="button"
        disabled={busy || !!pending.current} onClick={() => void act(() => submitReview(view.version.jobId!))}>提交分镜审核</button>)}
      {view.canPreviewReconciliation && view.publicationId && <button type="button" disabled={busy} onClick={() => void act(async () => {
        const preview = await api.previewStoryboardReconciliation(projectId,chapterId,view.publicationId!);
        if (preview.publicationId !== view.publicationId) throw new Error("WRONG_PUBLICATION");
        setReconciliationDraft(null);
        setReconciliation(preview);
      })}>预览分镜跨上游核对</button>}
      {view.formalRead && reconciliation && reconciliation.publicationId === view.publicationId && <section aria-label="分镜跨上游核对预览">
        <p>{!reconciliation.currentUpstream ? "当前正式上游尚未齐备。" : reconciliation.upstreamChanged ? "请逐镜核对新上游的依据。" : "正式上游未变化。"}</p>
        <ul>{reconciliation.shots.map(shot => {
          const revised = reconciliationDraft?.revisedShots.find(entry => entry.shotId === shot.id);
          const regenerated = reconciliationDraft?.regeneratedShots.find(entry => entry.id === shot.id);
          const original = view.version.shots.find(entry => entry.id === shot.id);
          return <li key={shot.id}>{shot.visual}
          {shot.locked && " · 替换前须解锁"}
          {shot.referencesMatch === false ? " · 引用须重新核对" : shot.referencesMatch ? " · 引用可定位，待核对内容" : ""}
          {reconciliationDraft?.retainedShotIds.includes(shot.id) ? " · 已保留" :
            reconciliationDraft && !regenerated && !revised && shot.referencesMatch && <button type="button" disabled={busy} onClick={() => void act(async () => {
              const retained = await api.retainStoryboardReconciliationShot(projectId,chapterId,reconciliation.publicationId,reconciliationDraft.id,shot.id);
              if (retained.shotId !== shot.id) throw new Error("WRONG_RECONCILIATION");
              setReconciliationDraft({ ...reconciliationDraft, retainedShotIds: [...reconciliationDraft.retainedShotIds,shot.id] });
            })}>核对无误，原样保留</button>}
          {reconciliationDraft && !regenerated && shot.locked && !revised && view.reviewId &&
            !reconciliationDraft.retainedShotIds.includes(shot.id) && <form onSubmit={event => {
              event.preventDefault();
              const reason = String(new FormData(event.currentTarget).get("reason")).trim();
              void act(async () => {
                const current = await api.getStoryboardReview(projectId,chapterId,view.reviewId!);
                if (current.reviewId !== view.reviewId || current.revision === undefined || !current.permissions?.canUnlock) throw new Error("WRONG_REVIEW");
                await api.operateStoryboardReview(projectId,chapterId,current.reviewId!,{
                  kind: "unlock",shotId: shot.id,reason,requestId: crypto.randomUUID(),expectedRevision: current.revision,
                });
                setReconciliation(await api.previewStoryboardReconciliation(projectId,chapterId,reconciliation.publicationId));
              });
            }}>
              <label>解锁原因<input name="reason" required maxLength={1000} /></label>
              <button disabled={busy}>解锁镜头</button>
            </form>}
          {reconciliationDraft && !regenerated && !shot.locked && !revised && !reconciliationDraft.retainedShotIds.includes(shot.id) &&
            <label><input type="checkbox" form={regenerationFormId} name="shotId" value={shot.id} disabled={busy} />选择重生</label>}
          {regenerated && <p>已采用重生 · {regenerated.visual} · {regenerated.durationSeconds} 秒</p>}
          {revised && <p>已修订 · {revised.value.visual} · {revised.value.durationSeconds} 秒</p>}
          {reconciliationDraft && !regenerated && !revised && !reconciliationDraft.retainedShotIds.includes(shot.id) &&
            !shot.locked && shot.referencesMatch && original && <details>
              <summary>修订镜头</summary>
              <form onSubmit={event => {
                event.preventDefault();
                const fields = new FormData(event.currentTarget);
                const revision = { shotId: shot.id,value: { visual: String(fields.get("visual")).trim(),durationSeconds: Number(fields.get("duration")) } };
                void act(async () => {
                  const saved = await api.reviseStoryboardReconciliationShot(projectId,chapterId,reconciliation.publicationId,reconciliationDraft.id,revision,String(fields.get("reason")));
                  if (saved.shotId !== shot.id) throw new Error("WRONG_RECONCILIATION");
                  setReconciliationDraft({ ...reconciliationDraft,revisedShots: [...reconciliationDraft.revisedShots,revision] });
                });
              }}>
                <label>画面<textarea name="visual" defaultValue={shot.visual} required maxLength={4000} /></label>
                <label>时长（秒）<input name="duration" type="number" step="any" defaultValue={original.durationSeconds} required /></label>
                <label>修订原因<input name="reason" required maxLength={1000} /></label>
                <button disabled={busy}>保存修订</button>
              </form>
            </details>}
          </li>;
        })}</ul>
        {reconciliationDraft && <p>核对候选 {reconciliationDraft.id} · 待逐镜核对</p>}
        {reconciliationDraft && <form id={regenerationFormId} onSubmit={event => {
          event.preventDefault();
          const ids = new FormData(event.currentTarget).getAll("shotId").map(String);
          if (!ids.length) { setNotice("请选择要重生的镜头。"); return; }
          if (ids.length > 100) { setNotice("每次最多选择 100 个镜头。"); return; }
          const submit = (event.nativeEvent as SubmitEvent).submitter?.getAttribute("value") === "submit";
          void act(async () => {
            if (submit && models && model) {
              const key = JSON.stringify([projectId,chapterId,reconciliationDraft.id,ids,models.id,model]);
              if (regenerationRequest.current?.key !== key) regenerationRequest.current = { key,requestId: crypto.randomUUID() };
              const next = checkTask(await api.submitStoryboardRegeneration(projectId,chapterId,reconciliation.publicationId,reconciliationDraft.id,{
                shotIds: ids,configurationVersionId: models.id,modelId: model,requestId: regenerationRequest.current.requestId,
              }));
              if (next.input.storyboardRegeneration?.reconciliationId !== reconciliationDraft.id) throw new Error("WRONG_RECONCILIATION");
              regenerationRequest.current = null;
              setTasks(old => [next,...old.filter(item => item.id !== next.id)]);
              setTask(next);
              setView(null);
              setScopes([]);
              setNotice("局部重生任务已提交。");
              return;
            }
            const result = await api.previewStoryboardRegeneration(projectId,chapterId,reconciliation.publicationId,reconciliationDraft.id,ids);
            if (result.reconciliationId !== reconciliationDraft.id || result.publicationId !== reconciliation.publicationId ||
              result.targets.length !== ids.length || !ids.every(id => result.targets.some(target => target.shotId === id && target.scopeKey === id))) {
              throw new Error("WRONG_RECONCILIATION");
            }
            setNotice(`重生范围检查通过，共 ${ids.length} 个镜头。`);
          });
        }}>
          <button disabled={busy}>检查重生范围</button>
          <button value="submit" disabled={busy || !models || !model || !!pending.current}>提交局部重生</button>
        </form>}
        {reconciliationDraft && reconciliation.shots.length > 0 &&
          reconciliationDraft.retainedShotIds.length + reconciliationDraft.revisedShots.length + reconciliationDraft.regeneratedShots.length === reconciliation.shots.length &&
          <form onSubmit={event => {
            event.preventDefault();
            const reason = String(new FormData(event.currentTarget).get("reason")).trim();
            if (!reason) return;
            const draftId = reconciliationDraft.id;
            if (reconciliationConfirmation.current?.draftId !== draftId || reconciliationConfirmation.current.reason !== reason) {
              reconciliationConfirmation.current = { draftId,reason,requestId: crypto.randomUUID() };
            }
            const { requestId } = reconciliationConfirmation.current;
            void act(async () => {
              const published = await api.confirmStoryboardReconciliation(projectId,chapterId,reconciliation.publicationId,draftId,{ requestId,reason });
              await loadReview(null,false,published.publicationId);
              reconciliationConfirmation.current = null;
              setNotice("核对候选已发布为正式分镜。");
            });
          }}>
            <label>重新确认原因<input name="reason" required maxLength={2000} /></label>
            <button disabled={busy}>确认并发布核对候选</button>
          </form>}
        {reconciliation.upstreamChanged && reconciliation.currentUpstream && !reconciliationDraft && <button type="button"
          className="desktop-task-action" disabled={busy} onClick={() => void act(async () => {
            const draft = await api.beginStoryboardReconciliation(projectId,chapterId,reconciliation.publicationId,reconciliation.currentUpstream!);
            if (draft.publicationId !== reconciliation.publicationId || !draft.id) throw new Error("WRONG_RECONCILIATION");
            setReconciliationDraft(draft);
          })}>创建分镜核对候选</button>}
      </section>}
      {!view.current && <p>正式上游已变化，此候选仅供历史追溯。</p>}
      <div className="mode-sheet">
        <section aria-label="镜头列表">
          <h4>镜头</h4>
          <ol>{view.version.shots.map(shot => <li key={shot.id}>
            <button type="button" aria-pressed={shotId === shot.id} onClick={() => selectShot(shot.id)}>{shot.visual}</button>
          </li>)}</ol>
        </section>
        {selected && <section aria-label="镜头详情">
          <h4 ref={shotHeading} tabIndex={-1}>{selected.visual}</h4>
          {view.current && view.version.jobId === task?.id && task?.input.storyboardRegeneration &&
            (adoptedShots[task.id]?.includes(selected.id) ? <p>已纳入核对候选</p> :
              <button type="button" disabled={busy} onClick={() => void act(async () => {
                const saved = await api.adoptStoryboardRegeneratedShot(projectId,chapterId,task.id,selected.id);
                if (saved.id !== selected.id) throw new Error("WRONG_RECONCILIATION");
                setAdoptedShots(old => ({ ...old,[task.id]: [...(old[task.id] ?? []),saved.id] }));
                setNotice("已将所选镜头纳入核对候选。");
              })}>采用此重生镜头</button>)}

          <p>镜头 {selected.ordinal} · {selected.durationSeconds} 秒 · {selected.shotSize} · {selected.cameraAngle}</p>
          <dl>{[["动作",selected.action],["台词",selected.speech],["运镜",selected.cameraMovement],["声音",selected.sound],["情绪",selected.emotion],["角色",selected.characters.join("、")],["资产",selected.assetIds.join("、")]].filter(([,value]) => value).map(([label,value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
          <h5>剧本元素</h5>
          <ul aria-label="关联剧本元素">{elements.map(element => <li key={element.id}>{element.text}</li>)}</ul>
          <h5>原文依据</h5>
          <ul aria-label="镜头原文依据">{fragments.map(fragment => <li key={fragment.id}><button type="button" onClick={() => selectShot(selected.id,fragment.id)}>{fragment.text}</button></li>)}
            {selected.provenance.filter(item => item.type === "approved_addition").map((item,i) => <li key={i}>获批改编新增 {item.additionId}</li>)}
          </ul>
          {view.reviewId && view.revision !== undefined && <StoryboardShotReview key={JSON.stringify([view.reviewId,view.revision,selected.id])}
            view={view} shot={selected} busy={busy} onSave={saveReview} />}
        </section>}
      </div>
      {view.version.failures.length > 0 && <fieldset>
        <legend>失败范围</legend>
        {view.version.failures.map(failure => <label key={failure.scopeKey}>
          {view.version.jobId && !task?.input.storyboardRegeneration && <input className="desktop-task-action" type="checkbox" checked={scopes.includes(failure.scopeKey)} disabled={busy || !retryEnabled || !failure.retryable || (scopes.length >= 100 && !scopes.includes(failure.scopeKey))}
            onChange={event => setScopes(old => event.target.checked ? [...old,failure.scopeKey] : old.filter(key => key !== failure.scopeKey))} />}
          {failure.scopeKey} · {failure.code}{!failure.retryable && " · 不可重试"}
        </label>)}
        {view.version.jobId && !task?.input.storyboardRegeneration && <button className="desktop-task-action" type="button" disabled={busy || !retryEnabled || !scopes.length}
          onClick={() => void act(() => submit({ expectedActiveVersionId: view.version.jobId!,scopeKeys: scopes }))}>重试所选失败项</button>}
      </fieldset>}
    </div>}
  </section>;
}
