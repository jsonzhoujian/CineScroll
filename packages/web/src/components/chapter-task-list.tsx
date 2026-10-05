"use client";
import { useEffect, useRef, useState } from "react";
import { ApiClientError, type ApiClient, type StoryKnowledgeTask } from "../lib/api";
import { taskPresentation } from "../lib/task-status";
export type TaskChapterContext = { projectId: string; chapterId: string };
/** Parent keys this view by project/chapter so old rows cannot survive a context switch. */
export function ChapterTaskList({ api, context, onSelect }: { api: ApiClient; context: TaskChapterContext; onSelect(id: string): void }) {
  const [rows, setRows] = useState<StoryKnowledgeTask[]>([]), [nextCursor, setNextCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(true), [notice, setNotice] = useState("读取章节任务…");
  const epoch = useRef(0);
  async function load(cursor: string | null, stamp: number) {
    setBusy(true);
    try {
      const page = await api.listStoryKnowledgeTasks(context.projectId, context.chapterId, cursor);
      if (stamp !== epoch.current) return;
      if (!Array.isArray(page.tasks) || page.tasks.some(task => task.projectId !== context.projectId || task.chapterId !== context.chapterId || task.input.stage !== "story_knowledge")) throw new Error("wrong context");
      setRows(previous => cursor === null ? page.tasks : [...previous, ...page.tasks.filter(task => !previous.some(row => row.id === task.id))]);
      setNextCursor(page.nextCursor); setNotice(page.tasks.length || cursor !== null ? "按任务编号排序，不代表创建时间。" : "本章节暂无任务；本版不提供首次生成入口。");
    } catch (error) {
      if (stamp === epoch.current) setNotice(error instanceof ApiClientError && error.status === 401 ? "登录已失效，请重新登录。" : error instanceof ApiClientError && error.status === 404 ? "章节不存在、无权访问，或任务服务尚未启用。" : "列表读取失败，请刷新后重试。");
    } finally { if (stamp === epoch.current) setBusy(false); }
  }
  useEffect(() => {
    const stamp = ++epoch.current; void load(null, stamp);
    return () => { epoch.current++; };
    // This view is remounted whenever its context changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, context.projectId, context.chapterId]);
  return <section className="chapter-task-list" aria-label="章节任务列表">
    <header><div><h3>本章任务</h3><small>项目 {context.projectId} · 章节 {context.chapterId}</small></div>
      <button className="text-button" disabled={busy} onClick={() => { setRows([]); setNextCursor(null); void load(null, ++epoch.current); }}>刷新列表</button></header>
    <p role="status">{notice}</p>
    <ul>{rows.map(task => <li key={task.id}><span><b>{task.id}</b><small>{taskPresentation(task).label}</small></span><button className="text-button" aria-label={`查看任务 ${task.id}`} onClick={() => onSelect(task.id)}>查看任务 →</button></li>)}</ul>
    {nextCursor && <button className="button secondary" disabled={busy} onClick={() => void load(nextCursor, epoch.current)}>加载更多任务</button>}
  </section>;
}
