"use client";

import { useRef, useState } from "react";
import type { StoryboardReviewCommand, StoryboardView } from "../lib/api";

type Action = { kind: "edit" | "suggest" }
  | { kind: "decide"; suggestionRevision: number; decision: "accepted" | "rejected" };

export function StoryboardShotReview({ view, shot, busy, onSave }: {
  view: StoryboardView;
  shot: StoryboardView["version"]["shots"][number];
  busy: boolean;
  onSave(command: StoryboardReviewCommand): Promise<void>;
}) {
  const [visual,setVisual] = useState(shot.visual);
  const [duration,setDuration] = useState(String(shot.durationSeconds));
  const [reason,setReason] = useState("");
  const previous = useRef<{ payload: string; requestId: string } | null>(null);
  const permissions = view.permissions;
  const suggestions = view.suggestions?.filter(item => item.shotId === shot.id) ?? [];
  const validChange = !!visual.trim() && Number.isFinite(Number(duration)) && Number(duration) > 0;
  const canWrite = !busy && !!reason.trim();

  function save(action: Action) {
    if (view.revision === undefined || !canWrite) return;
    const fields = action.kind === "decide" ? action : { kind: action.kind,shotId: shot.id,value: { visual,durationSeconds: Number(duration) } };
    const payload = { ...fields,expectedRevision: view.revision,reason: reason.trim() };
    const serialized = JSON.stringify(payload);
    if (previous.current?.payload !== serialized) previous.current = { payload: serialized, requestId: crypto.randomUUID() };
    void onSave({ ...payload,requestId: previous.current.requestId });
  }

  return <section aria-label="镜头审核">
    <h5>镜头审核</h5>
    {permissions?.canSuggest && <div className="desktop-task-action">
      <label>镜头画面<textarea value={visual} maxLength={20000} disabled={busy} onChange={event => setVisual(event.target.value)} /></label>
      <label>镜头时长（秒）<input type="number" step="any" min="0" value={duration} disabled={busy} onChange={event => setDuration(event.target.value)} /></label>
      <label>审核理由<input value={reason} maxLength={2000} disabled={busy} onChange={event => setReason(event.target.value)} /></label>
      <button type="button" disabled={!canWrite || !validChange} onClick={() => save({ kind: "suggest" })}>提交镜头建议</button>
      {permissions.canEdit && <button type="button" disabled={!canWrite || !validChange} onClick={() => save({ kind: "edit" })}>保存镜头修改</button>}
    </div>}
    {suggestions.length > 0 && <ul aria-label="镜头建议">
      {suggestions.map(suggestion => <li key={suggestion.revision}>
        <p>{suggestion.value.visual} · {suggestion.value.durationSeconds} 秒</p>
        <p>{suggestion.reason} · {suggestion.status === "pending" ? "待裁决" : suggestion.status === "accepted" ? "已接受" : "已拒绝"}</p>
        {permissions?.canDecide && suggestion.status === "pending" && <div className="desktop-task-action">
          <button type="button" disabled={!canWrite} onClick={() => save({ kind: "decide",suggestionRevision: suggestion.revision,decision: "accepted" })}>接受建议 {suggestion.revision}</button>
          <button type="button" disabled={!canWrite} onClick={() => save({ kind: "decide",suggestionRevision: suggestion.revision,decision: "rejected" })}>拒绝建议 {suggestion.revision}</button>
        </div>}
      </li>)}
    </ul>}
  </section>;
}
