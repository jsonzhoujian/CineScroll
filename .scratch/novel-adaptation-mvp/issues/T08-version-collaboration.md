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
- 工作台可提交局部重生。Worker 按任务快照限制请求及响应范围，数据库复核任务、基准发布、上游、锁定和既有处置。任务结果作为绑定核对候选的独立结果保存。
- 任务创建者可逐镜采用局部重生结果。数据库复验任务身份、镜头范围、基准发布、上游和锁定。同一镜头只能有一种核对处置，重开候选可查看采用结果。
- 已接完整候选确认。逐镜处置齐备后重建分镜、复验引用、集场覆盖和时长，并在同一事务内写入审核记录与正式发布。原样保留的锁定镜头继承锁定，旧发布可按编号读取。
- 工作台已接章节分镜审计。成员可查看审核提交、建议与决定、编辑、锁定、逐镜核对处置及正式发布，发布事件可打开对应历史版本。
- 项目分镜审计汇总各章节的同类不可变记录，按时间分页，显示所属章节和发布编号。
- 项目分镜审计中的发布记录可跨章节打开历史分镜，刷新时继续按该发布编号读取。
- 分镜建议详情显示建议人、裁决人和裁决理由。历史读取按发布修订还原裁决。
