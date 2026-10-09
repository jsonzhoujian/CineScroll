# D1b 完整业务核验清单与私有 SQL

状态：用户批准清单与私有SQL文件实施；未批准安装/执行新SQL、新GRANT、RLS/owner变更、运行装配或writer。承接[组合验收](2026-10-09-source-combined-readiness-verification.md)、[初始化事务](2026-10-08-source-initialize-runtime-design.md)。ADR0008仍Proposed。

## 1. 实施顺序和边界

先按本清单逐字段核对现有四表与纯校验，再交付独立 `docs/sql-drafts/evidence-source-d1b-verify.sql`。只新增默认封闭schema/两个INVОKER函数，不覆写现有SQL/目录摘要，不执行数据库。候选内部边界为verify_initialize_business(command JSONB, expected_service_id TEXT, expected_rule_version TEXT)，调用者只提供严格initialize命令；两个expected值来自未来固定配置断言，不能选择真正服务或篡改业务规则。

函数由同连接initialize内部调用，不自行BEGIN/COMMIT；要求READ COMMITTED，用既有locker锁真实principal→grant，再读取四类精确业务。FOR SHARE要求可锁定事务，不接组合inspector的只读事务。既有普通LOGIN/initializer尚无新函数/业务读取/codec调用许可，所以此草稿不是已可运行仓储。安装owner仍是受控DDL管理员，未来受限owner/RLS与EXECUTE必须另批。

## 2. 完整核验清单

| ID | 独立核对 | 拒绝/边界 |
| --- | --- | --- |
| B01 | command精确键、引用/ID/协议，真实session_user映射锁、initialize许可、预期服务相等 | 语法INVALID_COMMAND；授权在任何业务查询前，FORBIDDEN |
| B02 | workspace/id/version和所有四类producer预过滤；quote仅由已存snapshot列精确定位 | 初始三类缺失/隐藏NOT_FOUND，依赖quote缺失/隐藏INTEGRITY_CONFLICT；不区分越界存在 |
| B03 | 每份document严格封套、重新规范UTF8/SHA256，与canonical bytea、business_fingerprint逐一相等 | 不只检JSON和摘要相互对应；不接外部records/hash |
| B04 | 全公共SQL列=id/version/workspace/task/unit/binding/producer/recorded_at/document/canonical/fingerprint | 从document重建全部投影，对实际row全键比较；新/漏列拒绝，不动态信任新增列 |
| B05 | task的revision/前序/scope/snapshot/execution；初始revision1/null、id=taskId、scope=[unit] | 本切片不读v2或历史任务链，不按version字符串推断修订 |
| B06 | snapshot的锚点/执行/quote-record/quoteId/priceVersion/责任/预留 | SQL列和document双重比较 |
| B07 | execution的task_anchor_version/snapshot与quote的task-anchor/execution/计价/规则 | execution只是身份，不能产生执行来源/结论 |
| B08 | 四binding完全相等，含上游数组顺序；workspace/unit与command一致 | 不以task覆盖其他binding，不能跨作品/原文/上游 |
| B09 | task→snapshot/execution；snapshot→quote/execution；execution→snapshot；三者→task初始锚点；quote→execution | 每项精确id/version；不能仅依赖FK |
| B10 | snapshot/quote责任、quoteId、priceVersion、reserved一致；platform正安全整数/byok零 | expected_rule_version必须等于quote.pricingRuleVersion，不改变统一规则 |
| B11 | 输出两payload规范字节/指纹、完整业务/执行/quote指纹；producer与recordedAt沿业务，verifiedBy沿真实授权 | 不输出成功回执/发布证据/费用，不生成第三来源 |
| B12 | 单份2MiB工作量/规范字节、四份累计16MiB；既有codec深度/节点/ID/日期规则 | 不截断/补默认；仅初始化四记录，不宣称任意任务链已支持 |

全列投影采用实际typed row转JSON（bytea按PG JSON的反斜杠x+hex表示），独立显式重建预期，时间单独以utc_millis标准化；不是SELECT *就信任列值。对timestamp不能截断业务微秒，所有比较用IS DISTINCT FROM防NULL旁路。数组/数值按解析值，不按JSONB数字词法判等。

## 3. 私有SQL实现与未冻结项

verify_business_row只是内部完整行核对组件，不认证其JSON参数来源；只有主函数直接从四表获取row并调用它才有已存资料语境。外部不得传row或producer allowlist。主函数重新取得锁定授权范围，不接caller authContext/GUC；rule/service只为相等断言。权限/编码函数异常均净化，未知故障UNAVAILABLE；授权helper原错误保留固定代码，不返回SQL/原文/连接诊断。

主函数不查回执/预算/活动头、也不写来源。未来initialize必须先历史原键分支，再进入新业务核验（不可将此函数挪到历史重放前）；新命令预算锁/集合头与业务核验仍按既有顺序，同连接直到共同提交。私有结果不能跨事务缓存充当授权，也不能代共同写入。

原两目录及组合门禁只检查已冻结schema，**不会因此验收新verify schema**。部署前需新私有函数目录/ACL/owner验收，以及受限初始化角色的业务RLS/codec EXECUTE/locker EXECUTE权限设计。当前SQL从未安装/解析/执行，不宣称B01～B12或V01～V05通过。

## 4. 后续实库验收

按B01～B12分别加入正例、每公共/专属列损坏、非规范但自报匹配hash、任一producer隐藏、跨workspace/unit/binding、每条双向引用、报价/byok/统一规则、初始task v2、NULL/少键/额外键/Unicode及容量拒绝。两连接验证许可锁与撤权顺序、无current head依赖；新函数不自行提交。确认RETURN结果不能成为对外回执，测试wrapper/admin不冒称运行权限。

本轮仅SQL文件静态审查与引用/范围检查；数据库执行及新受限验收profile留下一切片批准。

Standards与Spec分别发现同一确定性问题：实际bytea经to_jsonb展示会受到会话bytea_output影响。已从四个typed row的实际canonical字节显式encode为小写hex，避免合法行误报；后续实库须覆盖bytea_output=escape与hex结果一致。两个轴修复后复审，无其余静态阻断；这不代表SQL解析或业务测试通过。
