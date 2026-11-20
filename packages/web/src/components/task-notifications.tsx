"use client";

import { useCallback, useEffect, useState } from "react";
import { ApiClientError, type ApiClient, type TaskNotification, type EpisodePlanView, type EpisodeTask, type ScriptContentTask } from "../lib/api";

type NotificationPage = Awaited<ReturnType<ApiClient["listTaskNotifications"]>>;

export function TaskNotifications({ api }: { api: ApiClient }) {
  return <>
    <Notifications api={api} kind="episodePlan" />
    <Notifications api={api} kind="scriptContent" />
  </>;
}

function Notifications({ api, kind }: { api: ApiClient; kind: "episodePlan" | "scriptContent" }) {
  const label = kind === "episodePlan" ? "拆集" : "剧本";
  const [page,setPage] = useState<NotificationPage | null>(null);
  const [busy,setBusy] = useState(true);
  const [error,setError] = useState("");
  const [task,setTask] = useState<EpisodeTask | ScriptContentTask | null>(null);
  const [candidate,setCandidate] = useState<EpisodePlanView["plan"] | null>(null);

  const fetchPage = useCallback(async (cursor?: string) => {
    try {
      return await api.listTaskNotifications(kind,cursor);
    } catch (error) {
      if (error instanceof ApiClientError && error.status === 404 && kind === "scriptContent") {
        return { notifications: [],nextCursor: null };
      }
      throw error;
    }
  },[api,kind]);

  useEffect(() => {
    let active = true;
    fetchPage().then(
      result => { if (active) setPage(result); },
      () => { if (active) setError(`读取${label}通知失败，请刷新。`); },
    ).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  },[fetchPage,label]);

  async function perform(action: () => Promise<void>, failure: string) {
    setBusy(true);
    setError("");
    try { await action(); }
    catch { setError(failure); }
    finally { setBusy(false); }
  }

  async function readPage(cursor?: string) {
    setTask(null);
    setCandidate(null);
    if (!cursor) setPage(null);
    await perform(async () => {
      const result = await fetchPage(cursor);
      setPage(previous => ({
        ...result,
        notifications: cursor && previous
          ? [...new Map([...previous.notifications,...result.notifications].map(item => [item.taskId,item])).values()]
          : result.notifications,
      }));
    },`读取${label}通知失败，请刷新。`);
  }

  async function openTask(notification: TaskNotification) {
    setTask(null);
    setCandidate(null);
    await perform(async () => {
      const result = kind === "episodePlan"
        ? await api.getEpisodeTask(notification.taskId)
        : await api.getScriptContentTask(notification.taskId);
      if (result.id !== notification.taskId || result.projectId !== notification.projectId
        || result.chapterId !== notification.chapterId || result.input.resultType !== kind) throw new Error("Invalid task");
      setTask(result);
    },"无法打开原任务，请刷新通知或联系项目负责人。");
  }

  async function loadCandidate(selectedTask: EpisodeTask | ScriptContentTask) {
    setCandidate(null);
    await perform(async () => {
      const { plan, current } = await api.getEpisodePlan(selectedTask.projectId,selectedTask.chapterId);
      if (!current || plan.id !== selectedTask.result?.candidateVersionId || plan.generationJobId !== selectedTask.id
        || plan.projectId !== selectedTask.projectId || plan.chapterId !== selectedTask.chapterId
        || plan.sourceVersionId !== selectedTask.input.sourceVersionId
        || plan.storyBibleVersionId !== selectedTask.input.upstreamConfirmedVersionIds[0]) throw new Error("Invalid candidate");
      setCandidate(plan);
    },"原候选当前不可载入，请在章节工作台核对。");
  }

  return <section className="mobile-pane episode-notifications" aria-label={`${label}通知`}>
    <h3>{label}通知</h3>
    <button className="text-button" type="button" disabled={busy} onClick={() => void readPage()}>刷新通知</button>
    {busy && <p role="status">正在读取…</p>}
    {error && <p role="alert">{error}</p>}
    {page && page.notifications.length === 0 && !page.nextCursor && <p>暂无{label}通知</p>}
    {page && page.notifications.length > 0 && <ul>{page.notifications.map(item => <li key={item.taskId}>
      <button className="text-button" type="button" disabled={busy} onClick={() => void openTask(item)}>
        {label}{item.outcome === "succeeded" ? "候选已生成" : "执行结果未知"} · {item.taskId}
      </button>
    </li>)}</ul>}
    {page?.nextCursor && <button className="text-button" type="button" disabled={busy} onClick={() => void readPage(page.nextCursor!)}>更多通知</button>}
    {task && <section aria-label={`原${label}任务`}>
      <h4>任务 {task.id}</h4>
      {task.reason === "EXECUTION_UNCERTAIN" && <p>待人工处理。执行结果未知，禁止重投，请联系负责人对账。</p>}
      {task.state === "succeeded" && task.result && task.input.resultType === "scriptContent" && <p>剧本候选已生成 · 版本 {task.result.candidateVersionId}</p>}
      {task.state === "succeeded" && task.result && task.input.resultType === "episodePlan" && <button className="text-button" type="button" disabled={busy} onClick={() => void loadCandidate(task)}>载入拆集候选</button>}
      {candidate && <ol aria-label="拆集候选">{candidate.episodes.map(episode => <li key={episode.id}>{episode.title}</li>)}</ol>}
    </section>}
  </section>;
}
