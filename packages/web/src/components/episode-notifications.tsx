"use client";

import { useEffect, useState } from "react";
import type { ApiClient, EpisodeNotification, EpisodePlanView, EpisodeTask } from "../lib/api";

type NotificationPage = Awaited<ReturnType<ApiClient["listEpisodeNotifications"]>>;

export function EpisodeNotifications({ api }: { api: ApiClient }) {
  const [page,setPage] = useState<NotificationPage | null>(null);
  const [busy,setBusy] = useState(true);
  const [error,setError] = useState("");
  const [task,setTask] = useState<EpisodeTask | null>(null);
  const [candidate,setCandidate] = useState<EpisodePlanView["plan"] | null>(null);

  useEffect(() => {
    let active = true;
    api.listEpisodeNotifications().then(
      result => { if (active) setPage(result); },
      () => { if (active) setError("读取拆集通知失败，请刷新。"); },
    ).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  },[api]);

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
      const result = await api.listEpisodeNotifications(cursor);
      setPage(previous => ({
        ...result,
        notifications: cursor && previous
          ? [...new Map([...previous.notifications,...result.notifications].map(item => [item.taskId,item])).values()]
          : result.notifications,
      }));
    },"读取拆集通知失败，请刷新。");
  }

  async function openTask(notification: EpisodeNotification) {
    setTask(null);
    setCandidate(null);
    await perform(async () => {
      const result = await api.getEpisodeTask(notification.taskId);
      if (result.id !== notification.taskId || result.projectId !== notification.projectId
        || result.chapterId !== notification.chapterId || result.input.resultType !== "episodePlan") throw new Error("Invalid task");
      setTask(result);
    },"无法打开原任务，请刷新通知或联系项目负责人。");
  }

  async function loadCandidate(selectedTask: EpisodeTask) {
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

  return <section className="mobile-pane episode-notifications" aria-label="拆集通知">
    <h3>拆集通知</h3>
    <button className="text-button" type="button" disabled={busy} onClick={() => void readPage()}>刷新通知</button>
    {busy && <p role="status">正在读取…</p>}
    {error && <p role="alert">{error}</p>}
    {page && page.notifications.length === 0 && !page.nextCursor && <p>暂无拆集通知</p>}
    {page && page.notifications.length > 0 && <ul>{page.notifications.map(item => <li key={item.taskId}>
      <button className="text-button" type="button" disabled={busy} onClick={() => void openTask(item)}>
        {item.outcome === "succeeded" ? "拆集候选已生成" : "拆集执行结果未知"} · {item.taskId}
      </button>
    </li>)}</ul>}
    {page?.nextCursor && <button className="text-button" type="button" disabled={busy} onClick={() => void readPage(page.nextCursor!)}>更多通知</button>}
    {task && <section aria-label="原拆集任务">
      <h4>任务 {task.id}</h4>
      {task.reason === "EXECUTION_UNCERTAIN" && <p>待人工处理。执行结果未知，禁止重投，请联系负责人对账。</p>}
      {task.state === "succeeded" && task.result && <button className="text-button" type="button" disabled={busy} onClick={() => void loadCandidate(task)}>载入拆集候选</button>}
      {candidate && <ol aria-label="拆集候选">{candidate.episodes.map(episode => <li key={episode.id}>{episode.title}</li>)}</ol>}
    </section>}
  </section>;
}
