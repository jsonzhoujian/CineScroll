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
- 剧本影响记录可打开同章节的共享分镜审核候选，并定位受影响镜头及其原文、剧本证据。历史上游仍按只读规则展示。
- 分镜跨上游核对以章节当前指向的旧正式发布为基准。负责人或审核人可预览当前正式上游、镜头锁定和引用有效性。引用可定位后仍需人工核对；锁定镜头先解锁才能替换。
- 已接创建核对候选。负责人或审核人从预览发起，数据库在章节锁内验证正式发布编号与当前正式上游。同一基准和上游重复创建返回同一编号。候选初始待逐镜核对，镜头与正式指针没有写入操作。
- 负责人或审核人可逐镜确认原样保留。服务端用新正式上游复验引用，数据库写入时复验基准发布与上游。已保留镜头可在重新打开候选时恢复，锁定镜头可原样保留。
- 已接逐镜修订。负责人或审核人可在引用通过复验后修订画面与时长，并填写原因。锁定镜头须先解锁，保存记录可在重开候选时恢复。
- 已接局部重生范围检查。以旧正式发布的镜头 ID 作为 scopeKey，绑定核对候选与当前正式上游。锁定、已保留或已修订的镜头不可纳入。
- 局部重生仍需接任务提交、Worker 严格范围校验及结果写入。核对候选须重新确认后生效。
