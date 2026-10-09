# D1b 组合目录验收与同事务核验推进

用户批准新增独立组合边界，不放宽原两个配置。实现 `packages/billing/test/support/source-combined-readiness.ts` 的 `assertIsolatedCombinedSourceDatabase(pool)`，仅test/support导出，返回void，无writer/连接/任意SQL接口。

## 组合规则与实库证据

同一受限业务inspector连接、单个REPEATABLE READ READ ONLY事务：原业务角色/扩展角色检查→codec有效权限拒绝→原业务固定目录→codec固定目录。只允许随机d1b库、PG16/UTF8/无TCP；检查两角色均无codec CREATE/EXECUTE。两目录SQL/静态指纹直接复用，不按当前目录学习、不重新冻结、也不修改独立codec的postgres库限定。

实库在新无TCP `/private/tmp/source-d1b.Zj1SbV`、初始管理员codec_admin中，由已有测试创建随机d1b库/角色。原封闭、授权、业务装载/reader/装配回归及组合共67项通过。组合验证同库健康、原业务单配置仍健康、独立codec配置仍拒绝随机d1b库；codec volatility和业务SELECT权限分别漂移后组合拒绝，测试显式恢复后重验通过。新增2项单元验证单连接/两目录/只读快照及任一失败回滚销毁。

只组合元数据，不在inspector事务读取业务行；REPEATABLE READ是检查期间目录快照，不锁管理员DDL、不证明下一次调用无漂移。Pool仍为受控实验配置，组合函数不验证地址/incarnation或创建连接，不能生产装配。旧两个目录hash、纯SQL函数和表权限没有变化；业务扩展角色查询仅从私有const改为测试支持导出，行为不变。

## 同事务业务核验候选（未实施）

下一实现边界是已设计initialize_runtime内部的精确四类业务核验，不是把两个独立仓储依次调用：同一普通LOGIN事务，先真实session_user映射并锁principal→grant，然后在受控入口的授权范围读取task/snapshot/execution及快照精确quote。不存在/越界不回退latest，task必须初始revision1/无前序；四类producer都需授权。当前inspector没有业务读取权，不因组合成功授予它SELECT。

必须从同连接已存行取得全部定位、完整业务JSON、canonical/指纹及SQL列，独立重算codec字节/SHA256，比较所有投影、binding/有序上游、固定双向引用/执行身份/报价/责任/金额、统一ruleVersion与quote规则。codec的形状与有限投影检查不代替完整业务核验；禁止客户端records/hash、管理员reader副本、GUC或任意回调提供权威。私有核验函数不单独授予LOGIN，入口取得的锁定授权只在内部使用，不开放自报authContext参数。

核验成功仅构造待写的两来源及关联：producer/recordedAt来自业务，verifiedBy来自真实服务，Execution不生成第三来源。之后初始化来源/回执/预算仍须同事务共同提交；本轮没有新授权、核验SQL、写入、COMMIT未知恢复或生产资料接线。历史回执原键重放仍不依赖当前活动业务，沿既有初始化契约。

未来验收V01～V05：精确定位缺失/范围外拒绝；完整canonical/hash/SQL投影损坏拒绝；双向引用/统一报价规则冲突拒绝；外部副本/伪身份不能绕过；同连接在途变更/失败无半组写入。上述尚未实现，不把目录67项等同业务核验通过。下一步建议先交付核验字段/错误及完整比较清单，再申请私有核验SQL与运行权限profile，不提前授予initialize EXECUTE。

## 本轮收尾

新增组合单元2项通过；全仓375项（354通过、21数据库条件跳过），全仓类型检查通过。先缺helper红灯，再实现和校正目录查询识别的测试断言后绿灯；没有将普通回归条件跳过算为实库成功。

Standards与Spec分别审查均无阻断；相对引用和diff检查通过。现有PG测试finally删除随机测试库及所有创建的fixture/codec inspector角色，独立查询test_databases=0、test_roles=0，再停止本轮实例；数据目录/server.log保留，未递归删除。没有模型或生产连接、业务核验SQL/运行授权。
