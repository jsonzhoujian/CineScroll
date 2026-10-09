# D1b 逐列、逐关联与主函数边界

用户批准补齐既有私有主函数测试，再推进同事务写入。现有两个测试边界不变；本切片未新增生产权限、写函数或运行装配。承接[私有验收](2026-10-09-source-private-verification-acceptance.md)及[初始化事务设计](2026-10-08-source-initialize-runtime-design.md)。

## 1. 覆盖清单

新增 `packages/billing/test/support/source-private-vectors.ts`，接在已批准主函数测试入口，故障注入仍只在临时管理员事务内，随后切换真实session_user调用测试wrapper。每例ROLLBACK恢复DDL与资料，再调用主函数核对原完整结果；不接受外部row作为主函数参数。原SQL和三个已冻结目录摘要均不改。

- 逐列：task 18、snapshot 20、execution 14、quote 19，共71列。固定manifest与固定装载投影、实库pg_attribute分别对齐，新增/漏列不能默默跳过。每列单独变更已存值；选择器/producer隐藏统一NOT_FOUND（quote依赖INTEGRITY_CONFLICT），其他字段INTEGRITY_CONFLICT。
- 逐关联：9条方向引用、每条id/version各一例，共18例。同步document/规范字节/摘要与相关SQL列，并在调用主函数前验证该行自身的完整一致性；不是只改SQL列导致B04提前拒绝。taskAnchor id变更同时更改该行binding.taskId，因此也可能由完整binding一致性拒绝；这些是拒绝向量覆盖，不是逐分支独立命中证明。
- binding：四类记录各7字段共28例，含上游顺序；每行自洽但组间不同。workspace隐藏沿既定错误边界。计价：snapshot/quote各4字段共8例，责任改为byok时同步reserved=0保持行内合法，再验证组间冲突。初始task revision2拒绝；一致BYOK/零预留为正例。
- 表CHECK会先挡住许多人工损坏值，故管理员在同事务临时移除该目标表CHECK及测试guard（不移除FK、domain、RLS），以检验主函数的独立防线；回滚恢复全部约束。该夹具不证明正常账号能损坏业务表，更不赋予生产修改能力。

## 2. 容量边界的可达性

业务封套没有任意长正文/canonical字符串字段。普通字符串最多256 UTF16单位，日期/枚举更短，数组最多100项，固定字段数有限。测试针对SQL固定profiles递归计算保守JSON字节上界：字符串按每UTF16单位最坏6字节转义+双引号；数值17字节；所有数组保守按100项；对象含字段名/标点/空格余量。四个完整业务封套的上界均小于512KiB，累计小于2MiB，因此严格低于单份2MiB、四份16MiB的硬限制。

主函数正例：100个不同的256单位中文ID，共享完整binding的四行同步重编码，核验通过。拒绝例：101项、257单位，以及2MiB/2MiB+1长度的单个畸形字符串，在已存document中注入后主函数返回INTEGRITY_CONFLICT。后两例不是“总输入恰好2MiB”的合法等值测试；其JSON包装实际更大，且字符串本身违反ID上限。不得把它们报告为CAPACITY分支命中。

在当前严格封套下，主函数单份规范字节>2MiB及四份累计>16MiB分支不可达；不放宽封套/阈值来造假阳性。它们保留为未来封套扩展防御；扩展时必须重新推导上界和新增真正等值/+1向量。纯codec通用worker已有独立容量等值测试，但不能替代主函数证明。

## 3. 验证与收尾

隔离PG16完整套件244项通过（原111 + 本轮133），新增manifest单元1项通过。首轮夹具失败来自表CHECK或误检其他workspace的任务v2，已修正故障注入及精确workspace自洽断言后复验通过；未因此改动主函数或冻结SQL。全仓381项：360通过、21数据库条件跳过，无失败；类型检查通过。Standards静态审查无阻断（manifest只读声明为可选判断性建议）；Spec静态审查无阻断。未将主函数无失败扩充覆盖描述成新业务实现的红绿修复。

临时实例 `/private/tmp/source-d1b.Ti7S7r`，无TCP，仅socket端口55439；独立psql核对随机测试库0、测试角色0，实例已停止，目录与日志保留。未删除用户业务数据。

## 4. 同事务写入：待确认的新测试边界

沿用已设计仓储 `initializeSourceCollection(command): Promise<IngestReceipt>`，先实现**仅隔离实验的独立SQL初始化入口**，建议名称 `initialize_source_collection(command JSONB, expected_service_id TEXT, expected_rule_version TEXT)`。后两值仅固定配置断言，真实身份仍session_user；不能提交records/payload/hash/producer作为权威。当前私有核验返回资料不能跨事务缓存。

新增权限差异需要明确确认：新NOLOGIN initializer owner（非超级用户、无BYPASSRLS、无成员链），受限真实服务LOGIN仅入口EXECUTE；owner仅具有授权helper/codec/私有核验调用、四表SELECT、必要新来源/集合/关联/回执INSERT和预算增量/指定头锁列UPDATE；对应FORCE RLS与guard必须逐项验收。不得给普通LOGIN表权限、内部helper调用或owner SET ROLE能力；不得用现有管理员wrapper充当运行写仓储。新profile单独冻结，旧三个目录不放宽。

下一切片顺序：先确定入口/角色/RLS/guard矩阵和新seam；再按单个失败测试→受限实现推进。首个写入切片应覆盖真实LOGIN新初始化、任一步失败整组回滚和独立连接只见共同提交，并建立新的最小权限目录验收。随后同键历史重放、异键already_registered、并发预算、超额拒绝与未知COMMIT恢复分别推进，不能先声称全部闭环。

写入锁序保持principal→grant→历史原键→budget→unit/head→精确业务→collection→source/link→receipt/member→budget；collection先插入满足立即source FK，反向初始来源FK延期。历史重放在新业务核验前，零计数/无当前业务依赖。只实现initialize，不包含register/审核页/收费/封存/生产D2来源。当前没有执行新写入SQL或授予其权限，ADR0008仍Proposed。
