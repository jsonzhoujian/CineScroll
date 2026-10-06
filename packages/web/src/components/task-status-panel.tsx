"use client";
import { useEffect, useRef, useState } from "react";
import { ApiClientError, type ApiClient, type ModelConfiguration, type StoryKnowledgeTask, type StoryKnowledgeVersion } from "../lib/api";
import { taskPresentation } from "../lib/task-status";
import { ChapterTaskList, type TaskChapterContext } from "./chapter-task-list";
import { InitialStoryTask } from "./initial-story-task";

export function TaskStatusPanel({ api, context, activeProjectId }: { api: ApiClient; context?: TaskChapterContext; activeProjectId?: string }) {
  const [listContext, setListContext] = useState<TaskChapterContext | null>(null);
  const [listRevision, setListRevision] = useState(0);
  const [input, setInput] = useState(""), [id, setId] = useState("");
  const [task, setTask] = useState<StoryKnowledgeTask | null>(null);
  const [candidate, setCandidate] = useState<StoryKnowledgeVersion | null>(null);
  const [configuration, setConfiguration] = useState<ModelConfiguration | null>(null), [modelId, setModelId] = useState("");
  const [notice, setNotice] = useState("输入任务编号，读取后台状态。"), [busy, setBusy] = useState(false), [refresh, setRefresh] = useState(0);
  const epoch = useRef(0);
  useEffect(() => {
    const url = new URL(window.location.href);
    const project = url.searchParams.get("taskProject") ?? "", chapter = url.searchParams.get("taskChapter") ?? "";
    let saved = url.searchParams.get("task") ?? "";
    if (context) {
      setListContext(context);
      if (project !== context.projectId || chapter !== context.chapterId) { saved = ""; url.searchParams.delete("task"); }
      url.searchParams.set("taskProject", context.projectId); url.searchParams.set("taskChapter", context.chapterId);
      window.history.replaceState(null, "", url);
    } else if (activeProjectId) {
      saved = "";
      for (const parameter of ["task", "taskProject", "taskChapter"]) url.searchParams.delete(parameter);
      window.history.replaceState(null, "", url);
    } else if (validId(project) && validId(chapter)) setListContext({ projectId: project, chapterId: chapter });
    if (validId(saved)) { setInput(saved); setId(saved); }
    // ImportWorkbench remounts this panel when the selected project/chapter changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  function selectTask(next: string) {
    if (!validId(next)) { setNotice("任务编号须为1～256个字符，不能包含换行。"); return; }
    epoch.current++; setBusy(false); setId(next); setInput(next); setRefresh(value => value + 1);
    const url = new URL(window.location.href); url.searchParams.set("task", next);
    window.history.replaceState(null, "", url);
  }
  useEffect(() => {
    const stamp = ++epoch.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setTask(null); setCandidate(null); setConfiguration(null); setModelId("");
    if (!id) return;
    const load = async () => {
      try {
        const next = await api.getStoryKnowledgeTask(id);
        if (stamp !== epoch.current) return;
        if (next.id !== id || next.input.stage !== "story_knowledge") throw new Error("wrong task");
        setTask(next); setNotice("状态来自服务器；页面不会启动或恢复模型执行。");
        if (taskPresentation(next).canResubmit) {
          const config = (await api.modelConfiguration()).configuration;
          if (stamp !== epoch.current) return;
          const usable = config?.tested && config.processingRegion === "mainland" ? config : null;
          setConfiguration(usable); setModelId(usable?.availableModelIds[0] ?? "");
          if (!usable) setNotice("需要当前已测试的大陆模型配置，请联系工作室负责人。");
        }
        if (["queued", "running"].includes(next.state)) timer = setTimeout(() => void load(), 5000);
      } catch (error) {
        if (stamp === epoch.current) { setNotice(describe(error)); setConfiguration(null); }
      }
    };
    void load();
    return () => { epoch.current++; if (timer) clearTimeout(timer); };
  }, [api, id, refresh]);
  async function viewCandidate() {
    if (!task?.result) return;
    const stamp = epoch.current; setBusy(true); setCandidate(null);
    try {
      const version = await api.getStoryKnowledgeVersion(task.projectId, task.chapterId, task.result.candidateVersionId);
      if (stamp !== epoch.current) return;
      if (version.id !== task.result.candidateVersionId || version.projectId !== task.projectId || version.chapterId !== task.chapterId
        || version.sourceVersionId !== task.input.sourceVersionId || version.extractionJobId !== task.id) throw new Error("wrong result");
      setCandidate(version);
    } catch (error) { if (stamp === epoch.current) setNotice(describe(error)); }
    finally { if (stamp === epoch.current) setBusy(false); }
  }
  async function resubmit() {
    if (!task || !taskPresentation(task).canResubmit || !configuration || !configuration.availableModelIds.includes(modelId)) return;
    const stamp = epoch.current; setBusy(true);
    try {
      const next = await api.resubmitStoryKnowledgeTask(task.id, { configurationVersionId: configuration.id, modelId });
      if (stamp === epoch.current) selectTask(next.id);
    } catch (error) { if (stamp === epoch.current) { setNotice(describe(error)); setConfiguration(null); } }
    finally { if (stamp === epoch.current) setBusy(false); }
  }
  const presentation = task ? taskPresentation(task) : null;
  return <section className="task-panel" aria-label="故事知识任务">
    <header><div><span className="eyebrow">后台任务 · 单任务查看</span><h2>故事知识任务</h2></div><span className="task-stamp">待审之卷</span></header>
    {context && <InitialStoryTask api={api} context={context} onCreated={next => { selectTask(next); setListRevision(value => value + 1); }} />}
    {listContext && <ChapterTaskList key={`${listContext.projectId}:${listContext.chapterId}:${listRevision}`} api={api} context={listContext} onSelect={selectTask} />}
    <form onSubmit={event => { event.preventDefault(); selectTask(input.trim()); }}>
      <label>任务编号<input value={input} maxLength={256} onChange={event => setInput(event.target.value)} placeholder="输入已有任务编号" /></label>
      <button className="button secondary" type="submit">读取任务</button>
      {id && <button className="text-button" type="button" disabled={busy} onClick={() => setRefresh(value => value + 1)}>刷新状态</button>}
    </form>
    <p role="status" className="task-notice">{notice}</p>
    {task && presentation && <article className="task-summary">
      <div><span className={`task-state state-${task.state}`}>{presentation.label}</span><p>{presentation.note}</p><small>任务 {task.id} · 原文 {task.input.sourceVersionId}<br />项目 {task.projectId} · 章节 {task.chapterId}（不跟随当前工作台选择）</small></div>
      {task.result && <button className="button secondary" disabled={busy} onClick={() => void viewCandidate()}>查看候选版本</button>}
      {presentation.canResubmit && <div className="task-resubmit desktop-task-action">
        <label>当前已测试模型<select value={modelId} disabled={busy || !configuration} onChange={event => setModelId(event.target.value)}><option value="">选择模型</option>{configuration?.availableModelIds.map(model => <option key={model}>{model}</option>)}</select></label>
        <small>配置版本 {configuration?.id ?? "不可用"} · 此操作创建新任务，不覆盖旧记录。</small>
        <button className="button primary" disabled={busy || !configuration || !modelId} onClick={() => void resubmit()}>使用所选模型重新提交</button>
      </div>}
    </article>}
    {candidate && <section className="task-candidate" aria-label="任务候选版本">
      <header><h3>候选版本 {candidate.id}</h3><button className="text-button" onClick={() => setCandidate(null)}>收起候选</button></header>
      <p>精确版本只读预览 · 不改变当前阶段确认状态</p>
      <ul>{candidate.facts.map(fact => <li key={fact.id}>{fact.statement}</li>)}</ul>
      <h4>未完成条目：{candidate.failures.length}</h4><ul>{candidate.failures.map(failure => <li key={failure.scopeKey}>{failure.scopeKey}：{failure.message}</li>)}</ul>
    </section>}
    <footer>URL仅记录任务编号，不保存会话、Key或原文。刷新后需重新登录；编号不授予访问权限。移动端仅查看，重新提交请在桌面端操作。</footer>
  </section>;
}
function validId(value: string) { return !!value.trim() && value.length <= 256 && !/[\r\n]/.test(value); }
function describe(error: unknown) {
  if (error instanceof ApiClientError) {
    if (error.status === 401) return "登录已失效，请重新登录。";
    if (error.status === 403) return "无权操作或订阅已失效，请联系负责人。";
    if (error.status === 429 && error.code === "TASK_QUEUE_FULL") return "工作室排队任务已达上限，请先处理已有任务后再重新提交。";
    if (error.status === 404) return "任务或候选不存在、无权访问，或当前服务尚未启用任务模块。";
    if (error.status === 409) return "任务、原文或模型配置已变化，请刷新状态后再操作；不会自动重提。";
  }
  return "读取或操作未完成，请刷新状态后重试。";
}
