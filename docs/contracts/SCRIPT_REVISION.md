# 正式剧本修订与影响记录

T06-05。成员只能对正式内容提交绑定版本、目标、替换正文及理由的建议；负责人/审核人解锁、接受或拒绝。接受派生候选并移除旧质量确认身份，重新通过 T06-04 后才推进独立正式指针。活动候选和正式内容分别读取，历史快照不可变。

Session API（相对 projects/:projectId/chapters/:chapterId/script-content）：

- POST revision：requestId、expectedActiveVersionId、reason 和 kind；suggest 需要 elementId/text，unlock 需要 elementId，decide 需要 suggestionId/decision。
- GET versions/confirmed：读取保留的正式快照。不是对旧上游的生成授权；T06-06/T07 仍须核对当前上游。
- GET versions/:id：成员读取精确历史快照。
- GET versions/:id/impacts：仅正式版本，返回已登记依赖的 unreviewed 影响项。读取错误不冒充空记录。

锁定目标先明确解锁。候选继承的其他元素锁同样禁止直接编辑或接受替换建议。拒绝建议只记录决定，即使目标后来锁定也不改正文。所有操作使用请求指纹、CAS、操作者、时间和理由，重放返回原请求快照。页面把未知原命令保存在同标签页 sessionStorage，刷新/登录后核对；正文理由不进入URL，存储失败关闭新写入。

接受时 revisionChanges 保存来源正式版本、建议及元素/场次/集范围。重新确认事务中的触发器比较实际注册依赖的新旧元素，剔除锁与编辑审计差异后，生成不可变 script_impact_links；不自动重做、不解除下游锁。现有 T07 内容写入器尚未实现，script_downstream_dependencies 只允许可信登记；T07 必须在保存下游内容的事务中登记精确正式版本和元素，不能把未登记等同于无影响。T08 负责影响处置界面和状态演进。

迁移0017～0024依次由可信管理员应用；应用启动只预检正式指针、修订约束/索引、影响表RLS及触发器，不执行迁移。本轮仅在新建隔离实例验证。完整父项 T06 的三类型夹具演示、真实语义证据和 T07 交接仍由 T06-06 收敛，不宣称已完成 MVP 或生产发布。
