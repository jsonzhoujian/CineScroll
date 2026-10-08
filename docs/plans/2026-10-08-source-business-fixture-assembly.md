# D1b 目录门禁与管理员只读材料装配（方案 A）

用户批准每次读取前重验目录、绑定同一隔离实例；门禁失败不进入材料读取。只实现 test/support，不开放来源登记、生产入口或运行角色权限。

## 装配 seam

`createIsolatedSourceBusinessAssembly(config)` 返回 read(input)/close()。config 精确四字段：connectionString（管理员）、inspectorLogin、workspaceId、allowedProducerServiceIds。调用方不能传入两个 Pool、不同读取地址、SQL 或回调；两个内部 Pool 均由**同一个不可变 URI 的 socket/port/database**构造，仅用户名与 inspector 固定角色不同。Pool 不从返回值暴露，不通过应用包 exports 导出。

配置在构造时进行描述符/普通对象/无额外字段校验，不执行普通 getter。工作室与 producer ID 沿现有规则且拒绝 PostgreSQL 不可表示文本；producer 非空、最多 100、不可重复/稀疏。URI 仅 postgresql://、localhost、无 URI port/password/hash、管理员简单角色名、随机 d1b 库、精确 /private/tmp/source-d1b.XXXXXX socket 目录、有效端口；查询参数只能单项 host/port。禁止 TCP host、生产库、额外 options 或重复参数，错误固定 INVALID_CONFIG 不带连接串。

所有配置深拷贝。严格读取引用快照 helper 从已有 reader 提取并共享，无协议改动；在任何 await 门禁前冻结三项引用，防止等待时外部切版本。公开接口不接受 prepared 对象或自报材料。

## 读取顺序

1. 拒绝已关闭装配，严格准备引用。
2. 受限 inspector 在同地址重验固定完整目录（每次，不缓存成功）。
3. 门禁失败只返回 NOT_READY，不调用材料 reader；检查关闭状态。
4. 现有管理员 reader 检验实际临时实例/管理员会话，READ ONLY REPEATABLE READ 精确取得资料并复验完整性。

保持 INVALID_COMMAND 与 reader 的 FORBIDDEN/NOT_FOUND/INTEGRITY_CONFLICT/UNAVAILABLE 约定；门禁内部诊断统一 NOT_READY。配置错误在连接前拒绝。新 read 不能在关闭后开始；已进入材料读取的任务可按已有语义结束。close 复用同一 Promise，独立结束两个自有池，任一失败净化 UNAVAILABLE。不结束调用者的数据库池。

## 安全边界

这是地址级同实例绑定，不是跨两个独立连接的原子 DDL 锁，也不是集群 system identifier 或数据库 incarnation 证明。检查提交后、读取前若管理员修改 DDL/重建数据库，仍存在检查与使用的间隙；不声称防恶意管理员或替换 socket 后端。原管理员路径检查和 REPEATABLE READ 材料验证仍保留。没有自动修复、学习摘要、降级绕过或重试，不能用于生产装配。

原始门禁、资料读取 helper 仍可单独用于隔离测试；新 wrapper 的强制顺序只约束此装配入口，不冒称整个仓库禁止管理员直读。原 SQL、授权、两个冻结摘要不修改。

## TDD / 验收

装配入口缺失先失败，再验证同装配成功→关闭 quote guard 后 NOT_READY→恢复成功→close 后 CLOSED。配置和命令在外部修改后不改变装配与已开始的读；新请求仍按修改后的引用报 NOT_FOUND。包含第二个读取 URI 的对象在构造时 INVALID_CONFIG，无独立连接被接受。

无数据库连接的边界用例拒绝密码/非随机库/TCP/额外连接 options/重复 port/空或重复 producer/非法文本/稀疏数组和 getter，关闭两个懒连接池后 CLOSED。未增加任意 SQL 故障钩子；尚未注入 close 失败或恶意管理员检查后换库，不计作已验证。

## 后续

此只读装配为下一切片的来源初始化材料核验提供基础。下一步先确定初始化事务接口与运行服务授权边界，不能直接把管理员取得的测试材料当生产或收费权威。

## 完成记录

实库专项 66 项通过，配置/关闭边界两项通过；最终全仓 418 项，399 通过、19 项其他数据库环境跳过、0 失败。全仓 typecheck 通过；最后新增 inspector 类型检查后 billing typecheck 再次通过，diff 检查通过。Standards / Spec 均无阻断。

独立查询随机测试数据库和角色数量均为 0，pg_ctl 停止成功。装配的自有两池由各测试 finally close，没有改变或结束外层管理员/inspector 池；临时集群目录及日志保留，未递归删除其他用户文件。
