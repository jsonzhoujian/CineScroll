"use client";

import { useRef, useState } from "react";
import { ApiClientError, type ApiClient } from "../lib/api";

export function ProjectInvitationPanel({ api, ownerProjectId, accountId, activeWorkspaceId, onSwitchWorkspace, onOpenChapter }: {
  api: ApiClient;
  ownerProjectId: string | null;
  accountId: string | null;
  activeWorkspaceId: string | null;
  onSwitchWorkspace(workspaceId: string): Promise<void>;
  onOpenChapter(projectId: string,chapterId: string): Promise<void>;
}) {
  const [issued,setIssued] = useState<Awaited<ReturnType<ApiClient["issueProjectInvitation"]>> | null>(null);
  const [joined,setJoined] = useState<Awaited<ReturnType<ApiClient["acceptProjectInvitation"]>> | null>(null);
  const switchRequired = !!joined?.workspaceId && joined.workspaceId !== activeWorkspaceId;
  const [directory,setDirectory] = useState<Awaited<ReturnType<ApiClient["listProjectChapters"]>> | null>(null);
  const [notice,setNotice] = useState("");
  const [busy,setBusy] = useState(false);
  const inFlight = useRef(false);

  async function run(operation: () => Promise<void>, failure: string) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setNotice("");
    try {
      await operation();
    } catch (error) {
      setNotice(error instanceof ApiClientError && error.status === 401 ? "登录已失效，请重新登录。" : failure);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return <section className="panel" aria-label="项目邀请">
    <h2>项目邀请</h2>
    {accountId && <p>我的账号 ID <code>{accountId}</code></p>}
    {ownerProjectId && <form onSubmit={event => {
      event.preventDefault();
      const fields = new FormData(event.currentTarget);
      const recipient = String(fields.get("recipient")).trim();
      const role = fields.get("role");
      if (!recipient || (role !== "editor" && role !== "reviewer")) return;
      void run(async () => {
        setIssued(null);
        setIssued(await api.issueProjectInvitation(ownerProjectId,recipient,role));
      },"生成邀请失败，请核对账号 ID 或现有成员关系。");
    }}>
      <label>受邀账号 ID <input name="recipient" required maxLength={256} disabled={busy} /></label>
      <label>邀请角色 <select name="role" disabled={busy}><option value="editor">编辑</option><option value="reviewer">审核人</option></select></label>
      <button type="submit" disabled={busy}>生成邀请</button>
    </form>}
    {issued && <div>
      <label>生成的邀请编号 <input readOnly value={issued.id} onFocus={event => event.currentTarget.select()} /></label>
      <p>请将编号交给受邀账号。有效期至 <time dateTime={issued.expiresAt}>{new Date(issued.expiresAt).toLocaleString("zh-CN")}</time>。</p>
    </div>}
    <form onSubmit={event => {
      event.preventDefault();
      const invitationId = String(new FormData(event.currentTarget).get("invitationId")).trim();
      if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(invitationId)) {
        setNotice("请输入有效的邀请编号。");
        return;
      }
      void run(async () => {
        const membership = await api.acceptProjectInvitation(invitationId);
        setJoined(membership);
        setDirectory(null);
        setNotice(`已加入项目 ${membership.projectId}，角色为${membership.role === "editor" ? "编辑" : "审核人"}。`);
      },"无法接受邀请，请核对登录账号、邀请编号和有效期。");
    }}>
      <label>待接受的邀请编号 <input name="invitationId" required maxLength={64} disabled={busy} /></label>
      <button type="submit" disabled={busy}>接受邀请</button>
    </form>
    {switchRequired && joined && <button type="button" disabled={busy} onClick={() => void run(
      () => onSwitchWorkspace(joined.workspaceId),"无法切换工作室，请重试。",
    )}>切换到受邀工作室</button>}
    {joined && !switchRequired && <button type="button" disabled={busy} onClick={() => void run(async () => {
      const result = await api.listProjectChapters(joined.projectId);
      if (result.projectId !== joined.projectId) throw new Error("WRONG_PROJECT");
      setDirectory(result);
    },"无法读取项目章节，请重试。")}>查看受邀项目章节</button>}
    {directory && <section aria-label="受邀项目章节">
      {directory.chapters.length ? <ul>{directory.chapters.map(chapter => <li key={chapter.id}>
        <button type="button" disabled={busy} onClick={() => void run(
          () => onOpenChapter(directory.projectId,chapter.id),"无法打开该章节，请重试。",
        )}>{chapter.title}</button>
      </li>)}</ul> : <p>该项目暂无已导入的章节。</p>}
    </section>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
