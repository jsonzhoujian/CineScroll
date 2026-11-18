"use client";

import { useRef, useState } from "react";
import { ApiClientError, type ApiClient } from "../lib/api";

export function ProjectInvitationPanel({ api, ownerProjectId, accountId }: {
  api: ApiClient;
  ownerProjectId: string | null;
  accountId: string | null;
}) {
  const [issued,setIssued] = useState<Awaited<ReturnType<ApiClient["issueProjectInvitation"]>> | null>(null);
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
      },"生成邀请失败，请核对同工作室账号 ID 或现有成员关系。");
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
        setNotice(`已加入项目 ${membership.projectId}，角色为${membership.role === "editor" ? "编辑" : "审核人"}。`);
      },"无法接受邀请，请核对登录账号、邀请编号和有效期。");
    }}>
      <label>待接受的邀请编号 <input name="invitationId" required maxLength={64} disabled={busy} /></label>
      <button type="submit" disabled={busy}>接受邀请</button>
    </form>
    {notice && <p role="status">{notice}</p>}
  </section>;
}
