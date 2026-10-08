# D1b 隔离测试业务资料原子装载（方案 A）

用户确认独立测试装载器：本轮完成合成业务行持久化，不接登记仓储、HTTP、生产装配或计费。

## 入口与信任边界

测试 seam 为 `createIsolatedSourceBusinessLoader(pool, config).load(input)`。代码只在 `packages/billing/test/support`，不通过包 exports 暴露；pool 为可信临时实例管理员，config 固定 workspaceId/allowedProducerServiceIds 并克隆，load 不接受 prepared、指纹、SQL、连接或回调。每次重新运行严格四类资料校验并自行生成文档/规范字节/指纹。

连接后先开始 READ COMMITTED 事务，核验 session_user 为超级管理员、current_user 未切角色、PG16/UTF8、无 TCP 监听、`/private/tmp/source-d1b.XXXXXX/data`、随机 `d1b_<32hex>` 测试数据库，再 SET LOCAL ROLE 到 NOLOGIN/非超级用户/无 BYPASSRLS 的业务 fixture 角色执行 DML。路径/库名防误装配，不防恶意超级管理员；本工具绝不能用于应用日常查询。

独立 SQL 扩展只开启四类业务表和 workspace_budget 的定向 RLS。业务角色仅 SELECT/INSERT，预算只额外 UPDATE business_count/business_bytes；无成员授权、表/函数/schema 所有权或 CREATE/DELETE/TRUNCATE。ALWAYS row guard 仅允许该角色且真实 session_user 为管理员的 INSERT；业务 UPDATE/DELETE 即使是管理员也拒绝，预算只能从全零插入并单调增加业务计数，其余计数不动；所有 TRUNCATE guards 保持封闭。源登记、关联、回执表不开放。

完整 JSON、规范字节/摘要与 SQL 列投影由可信 TypeScript 工具产生。数据库已有 valid_document/FK/CHECK 验证部分结构，不独立复现整个 TypeScript 跨资料规则；可信管理员直接 SET ROLE 后编写任意 INSERT 属于信任范围之外，不能宣称数据库能防恶意管理员伪造测试资料。生产者许可由固定 config 检查，不把测试 producer ID 当生产来源权威。

## 事务与冲突

原始资料先校验，再在同连接事务中创建/锁定 workspace_budget；不存在行用唯一键 INSERT ON CONFLICT 竞争，存在行 FOR UPDATE。预算是工作室串行点，随后按 task 链→snapshot→execution→quote 处理，循环 FK 在 COMMIT 校验。

各行完整文档、规范 bytes、摘要及全部 SQL 投影列逐一与数据库比较，不仅比较摘要。同键同内容重放，不增加预算；异内容 UNIQUE 冲突整项拒绝。固定 snapshot/execution/quote 只允许该工作室内实体的已有版本重放，也禁止在同 unit 换实体；任务同 unit 不换实体，后续版本必须从首版完整链通过校验且保留先前行。历史短链重放不会删除已存后续版本。

所有新行与预算一起提交。预算上限继承 4096 行/16MiB，只累计新增完整规范文档字节；超限回滚，不删除历史释放容量。输入、行和批次上界继承纯校验。statement_timeout 5s、lock_timeout 1s，连接池测试配置 2s；这些是逐查询/锁等待限制，不是整个批次耗时 SLA。

错误净化为 FORBIDDEN/CONFLICT/CAPACITY_EXCEEDED/UNAVAILABLE（纯校验错误仍 INVALID_BUSINESS_FIXTURE）。失败尝试 rollback，所有完成/失败连接均销毁，不自动重投。COMMIT 响应丢失时仅返回 UNAVAILABLE；调用者以相同原始完整资料再装载可按已有规范内容收敛，未故障注入证明未知提交恢复，不能把此行为当登记回执协议。

## 验收

先观察装载入口缺失失败，再实现四行成功及重放。固定报价跨新组换版本测试实际先出现错误成功，再补固定实体冲突检查。

真实 PG 回归覆盖：四行成功/重放不重复预算、同键异内容、新固定版本、插入部分新行后报价冲突整项回滚、运行登录装载/读/角色切换拒绝、固定 config 不受外部数组修改影响、业务 UPDATE/DELETE/TRUNCATE 拒绝、两个独立池同工作室并发收敛、完整任务链追加仅新增一行。

独立连接通过临时 advisory-lock 触发器暂停快照 INSERT；确认真实锁等待，在任务已执行 INSERT 的事务中仍看不到四行或预算，释放后一起可见。闸门只由测试管理员安装并清理，装载器没有回调或故障 SQL 参数。容量用例由测试管理员将合成预算计数置满，验证失败后业务行全无；不声称装载了 4096 条真实业务资料。

原封闭 SQL、固定目录摘要和预检实现不修改。封闭预检在扩展后依旧拒绝。新扩展本身未建立冻结目录摘要，不作为生产启动许可；只信任本测试进程安装的 SQL。完成后删除随机测试库/角色，停止临时实例。

## 后续

下一步先为扩展 profile 建立受限目录验收和持久化完整性读取，再接来源集合初始化；D2 生产业务来源、执行关闭证据与收费仍未开放。

## 完成记录

真实 PG 专项 45 项通过，配合纯校验八项最终 53 项全部通过。全仓回归 392 项，373 通过、19 项其他数据库环境跳过、0 失败；全仓 typecheck 通过，最后修改后 billing typecheck 再次通过。原封闭 SQL/目录摘要/预检无变更。

Spec 无阻断，按建议将容量用例拆为计数满与字节满两个独立预算。Standards 的观察者失败清理问题已修正并复审关闭：连接获取在 try 内，各闸门清理独立尝试并汇总，finally 保证连接销毁和池关闭；容量分类限定到两个已知预算 CHECK。最后仅复验受影响专项，不重复无关回归。

临时实例独立查询本轮测试库和角色数量均为 0，pg_ctl 停止成功。保留临时集群目录和日志，未递归删除其他文件。
