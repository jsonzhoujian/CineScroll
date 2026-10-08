# D1b 四类业务资料严格校验（方案 A 第一切片）

**Goal:** 先校验隔离测试资料的严格内容与固定关联，后续独立接数据库原子装载。

**Architecture:** `prepareSourceBusinessFixture(input: unknown)` 是纯函数测试 seam，经 billing 根入口导出；不接 Pool、角色或运行时登记。输入为 tasks（按 revision 从 1 排序的完整版本链）、snapshot、execution、quote。输出 records（任务链在前，其后固定快照、执行、报价），每条含 kind/workspaceId/id/version/document/canonical/businessFingerprint/byteLength。

**Tech Stack:** TypeScript、Node test、既有 canonicalEvidenceValue、UTF8 SHA256；无新依赖。

## 本轮字段与规则

沿用 `2026-10-08-source-ingest-fixture-design.md` 的四类资料字段；不新增 state/usage/closed 等事实。所有对象为精确可枚举自有数据字段，禁止未知字段、getter、symbol、隐藏字段、稀疏数组、循环、非普通对象和非 JSON 值。先检查数据描述符再克隆，不调用 getter/toJSON。错误统一 `INVALID_BUSINESS_FIXTURE`，不附原始输入或 cause。

ID 沿现有 256 UTF16 单元、禁止前后空白/CR/LF/*/?/://；额外拒绝 PostgreSQL 无法保存的 NUL 和未配对代理项，不修改原登记协议。时间必须四位年份、毫秒精度 UTC 且日历有效。ID 数组最多 100 项且顺序保留、不重复。

所有资料完整 binding 相同（包括上游顺序）。task.id 等于 binding.taskId，scopeKeys 固定 [unitId]。任务全部引用同固定 snapshot/execution；快照/执行双向关联，快照引用精确报价；三类固定资料均锚定任务首版。报价与快照的 quoteId/priceVersion/responsibility/reserved 必须逐项一致；platform 正安全整数，BYOK 为零。生产者字段在本轮仅校验格式，生产者许可及登录映射由未来受控装载入口核验，纯函数不认证其权威。

链从 revision=1/predecessor=null 开始；相同 task 实体、binding、scope、固定引用和 producer；后续 revision 连续、predecessor 精确指前版，version 唯一，recordedAt 不倒退。只允许设计中的 version/revision/predecessorVersion/recordedAt 变化。本函数验证准备资料，不开放运行登记白名单，不判定数据库已有版本。

canonical 是既有规范 JSON 的完整业务文档，按 UTF8 计算字节数和 SHA256；类型与 workspace/id/version 为独立精确定位字段。所有输出文档与输入及其他记录均无对象共享。输出可编辑副本不是认证凭据，未来装载必须重新验证并在服务端自行计算指纹。

## 有界处理

最多 4093 个任务版本 + 三类固定资料，匹配每 workspace 4096 业务行容量上界，但不保证所有此规模资料可一次处理。输入检查还受深度 8、访问节点 50,000、累计字符串 UTF8 16MiB 上限；拒绝过大对象/数组。规范化后单条最多 2MiB、整组最多 16MiB。节点等安全限制可先触发；未检查数据库已占容量，不截断输入，不释放历史。

## 实施与验收

按垂直 TDD：有效四类资料 → 严格形状 → 交叉关联 → 任务链；每步先观察失败，再实现。补齐输出互不影响、BYOK、对象键序与安全输入回归。通过公开纯函数测试，不以模拟数据库宣称原子性。

后续数据库切片负责同键同内容重放、异内容冲突、固定实体新版本拒绝、生产者范围、预算累计、事务共同提交与不可更新/删除。本轮不包含这些持久化保证，不修改原封闭 SQL/目录摘要，也不触碰模型、Key、小说正文、生产库或收费。

## 验证结果与审查

专项八项通过，包含多种非法变体。固定 execution 文档 UTF8 391 字节，SHA256 为 `b8caea6b437005e18d0566157eeeb48723a372fae527de1b4236884a5950b9da`；仅固定完整业务文档编码，不修改 source-ingest-v1。测试通过 billing 根入口覆盖 100/101 个上游 ID、空链、超过任务数量及合法形状但超过访问节点的完整链。深度和字节保护未各建立独立边界用例，不声称所有资源边界已实测。

Standards / Spec 无阻断。按 Spec 建议补上根入口、固定编码/指纹向量和容量用例；Standards 建议后续将 kind/document 改为判别联合，使数据库消费方可按 kind 缩窄。目前运行时配对由本函数固定构造；没有消费方接受外部 PreparedFixtureRecord 为权威。全仓类型检查通过，补充用例后 billing 类型检查再次通过。

最终全仓回归 348 项，328 通过、20 项需要独立数据库环境的测试跳过、0 失败。本轮没有启动 PostgreSQL，因此不沿用上轮数据库用例的通过数量。git diff 检查通过。
