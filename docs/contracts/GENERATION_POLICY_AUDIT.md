# 许可变更事务审计

story-knowledge/0004为许可表增加AFTER触发器：记录INSERT、状态实际改变的UPDATE、DELETE。只存作用域标识、目标类型、前后状态、session_user、current_user、数据库时间及事务编号；不复制原文、Key、投诉或任意客户端说明。数据库身份不是最终业务操作人的证明，后续管理服务需补可信业务身份关联。历史许可不补造审计。

SECURITY INVOKER保留实际维护角色，search_path固定pg_catalog、public限定审计表。可信维护者须具备许可写权限、审计INSERT/序列USAGE及必要RLS权限；缺权限/写失败则许可变更同事务回滚。SET ROLE时session_actor记录登录账号，effective_actor记录维护角色。

novel_app仅SELECT，RLS限定工作室及项目成员，无审计INSERT/UPDATE/DELETE/TRUNCATE/序列权限。触发器进一步禁止审计改删/清空，以及许可TRUNCATE绕过DELETE审计。许可身份不能原地变更，使用删除/新增；同状态updated_at更新不新增事件。

审计无项目/原文FK，避免业务删除销毁证据。项目删除后成员查询不可用，可信管理员仍可读取。记录并非防超级用户的外部不可变存储：超级用户/所有者可禁用触发器或改DDL。上线须补最小运维权限、外部备份和审计到期清理政策；此处不承诺永久保留或覆盖产品删除承诺。

编号和事务ID不代表提交顺序；回滚可产生序列空洞、不会保留对应审计。没有管理UI/查询HTTP/投诉工单或生产装配。

测试仅临时库按0001～0004执行。已有不可变原文夹具需要TRUNCATE重置：辅助先做已审计许可DELETE，再在管理员事务中精确暂停许可TRUNCATE保护、重置夹具并恢复，审计表本身不清空。此辅助不是业务维护入口。

验证：状态/时间/事务、DELETE/no-op、SET ROLE双身份、审计约束与缺权限回滚、应用伪造/改删/TRUNCATE拒绝、工作室读隔离及旧许可锁门禁。
