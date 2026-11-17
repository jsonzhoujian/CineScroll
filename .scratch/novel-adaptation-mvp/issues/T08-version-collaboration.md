# T08 — Versions, impact analysis, and collaboration

status: in_progress
prerequisite: T07 completed
unlocks: [T10]

## Goal

Protect confirmed work when upstream content changes and support non-realtime studio collaboration.

## Acceptance criteria

- Confirmed edits create new versions and identify potentially invalid downstream items.
- The system never silently regenerates affected or locked content.
- Users choose which affected items to keep, revise, or regenerate.
- Owners, editors, and reviewers follow the approved permission matrix.
- Suggestions contain replacement content, reason, author, status, and reviewer decision.
- Key operations appear in an immutable project audit view.
- Concurrent edit attempts fail safely without overwriting another member’s work.


## 实施进度

- 已支持按发布编号读取历史正式分镜。镜头、建议和锁定记录按该次确认修订重建，证据仍绑定当时的正式剧本和原文。读取入口遵循章节成员权限。
- 工作台已接正式发布列表，按发布编号倒序分页。选中历史发布后可按原编号刷新并查看证据。
- 下一切片接影响记录到对应镜头的跳转。
