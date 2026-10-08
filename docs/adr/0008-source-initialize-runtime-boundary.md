# 运行来源初始化使用受控同连接事务，不拼接管理员读取结果

Status: Proposed（仅本轮文档设计；未批准 SQL、GRANT、数据库执行或生产仓储）。

已完成的管理员 reader 在独立只读事务提交并销毁连接，不能把其 records 交给另一个写事务冒称共同核验。候选运行 initialize 改由普通服务 LOGIN 调用限定 SECURITY DEFINER 入口，在同连接 READ COMMITTED 内以 session_user 映射锁授权、锁预算/头、重读精确业务并共同写来源/关联/回执，外层确认 COMMIT 后才成功；预期服务参数只是与真实映射相等的断言，不选择身份。沿用 ADR0004/0007，不扩展管理员装配为运行 Writer。

代价是 SQL 端严格形状、规范编码/指纹、投影与预算需要独立实现和固定向量验收；尚未完成时默认关闭写入口。继续管理员全权写实验较快但不验证运行授权；给服务表 DML 便于 TypeScript 复用却扩大绕过面，均不选作本运行边界。详见[初始化事务设计](../plans/2026-10-08-source-initialize-runtime-design.md)。
