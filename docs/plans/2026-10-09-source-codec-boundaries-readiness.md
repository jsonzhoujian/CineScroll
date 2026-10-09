# D1b 纯编码容量边界与冻结目录验收

用户批准先补等值/拒绝向量，再冻结纯计算目录配置。本轮沿现有SQL纯计算及test/support边界实施，不引入生产预检或writer，不改旧D1b两个profile摘要。依据[前轮实库记录](2026-10-09-source-codec-postgres-validation.md)、[编码设计](2026-10-09-source-initialize-sql-codec-design.md)。

## 1. 边界证据与等价优化

新增实库等值/+1用例：depth=8与9；值节点50,000与50,001（1根+5分支+500数组+49,494标量）；UTF8(jsonb::text)输入工作量2MiB与2MiB+1；私有walk规范输出16MiB与16MiB+1；packageBytes=2MiB与+1、receiptCost=16KiB与+1。ID边界含256 UTF16 ASCII/128个非BMP字符及超一单元。

深度/节点/16MiB使用测试管理员直接调用私有worker，是计算层边界证明，不意味着公开封套能接任意树或运行角色可调用。预算边界扩充合成hex字段，不证明其与真实业务payload匹配；完整跨行guard尚未实现。普通封套输入2MiB上限与私有worker16MiB输出上限是不同层，不能把大worker向量当生产可接输入。

首个16MiB用例10秒超时，定位原quote_string逐字符重复拼接/取子串的大值开销。改成先原生replace反斜线/引号，再固定31个控制字符扫描替换，不二次转义新增反斜线。同一样例约0.3秒通过，17份原黄金字节/指纹不变；只是本机实验数据，不是吞吐承诺或生产SLA。SQL定义变化已纳入新codec基线，不更新旧两个profile。

拒绝向量补少/多键、类型错、协议错、倒序来源、非法hex/指纹、非法日期/非UTC字符串、非法ID、超整数及重复scope，31控制字符、Unicode不归一化、DateStyle、NUL/孤立代理项PG解析拒绝和非有限时间。PG JSON解析错误保留在测试边界；未来对外仓储需净化，不能直接暴露这些SQL错误。

## 2. 冻结目录配置

`packages/billing/test/support/source-codec-readiness.ts`只读接口 `assertIsolatedCodecDatabase(pool)` 返回void，不返回SQL函数/连接/writer，不被应用根包导出。固定受限codec_inspector，禁止SUPERUSER/创建库/角色/BYPASS/复制/角色成员链/纯函数EXECUTE，普通数据库配置需PG16/UTF8/无TCP。它没有独立地址/实例incarnation验证，不是生产或管理员业务读取装配。

元数据快照及静态指纹见[目录资料](../fixtures/source-codec-catalog-v1.json)：`2b3f7fed921c271874fa0c5b6404e7f2133d9fbd40f4b3cf4f027c788829ffb4`。在已批准合成实例独立诊断采集后审阅并固定；门禁运行时只比静态常量，不采纳当前目录作为预期，也不修复。元数据JSONB文本的UTF8 SHA256是独立PG16目录算法，不替代来源canonicalEvidenceValue指纹。

投影无OID，覆盖schema owner/ACL、全部函数签名/定义摘要/owner/语言/安全模式/strict/并行/volatility/search_path/成本/返回类型、角色flags/成员链/角色设置、owner与inspector的全局及本schema默认ACL、额外relation/type/operator/collation/conversion计数、函数extension归属。ACL函数identity显式text，避免UNION把长签名转成name而截断；固定资料包含超过63字符的完整签名。

owner为本隔离实例codec_admin超级管理员，配置明确保留此实验身份，不声明已获得受限非登录运行owner。inspector只有系统目录读取能力，不给codec schema USAGE/函数执行。元数据门禁在READ ONLY事务，5秒语句限时，search_path=pg_catalog,pg_temp，严格单行boolean true；出错rollback/销毁连接并净化。目录检查不锁管理员DDL，也不保证随后纯函数调用间隙无漂移，更不提供写授权。

## 3. 门禁回归

未冻结占位摘要时健康门禁红灯，固定静态配置后绿灯。13类实库漂移：PUBLIC EXECUTE、inspector schema USAGE、函数owner、volatility、search_path、正文/语言、inspector SUPERUSER、成员链、schema/global default ACL、空global default ACL、额外关系和函数。空ACL回归先红，补默认ACL行头投影（不能仅aclexplode条目）后冻结新静态摘要。每项commit漂移→独立inspector拒绝→测试管理员明确恢复→健康；预检不自动修复。

三个纯接口单元测试覆盖只读/固定指纹、不返回authority、非boolean/异常及释放失败拒绝。管理员连接核对session_user=current_user；所有实验Pool使用非空固定options与ssl=false，覆盖驱动对空options回退PGOPTIONS的行为。错误PGOPTIONS指定不存在role的完整复验仍通过；不通过修改系统环境/共享配置修复。

## 4. 尚未证明

拒绝向量为批准切片的代表集合，不是全部组合穷举；单元释放故障不等于网络故障、整体事务截止证明。未测实际并发管理员DDL、跨版本PG、其它schema全局安全、执行权限被调用后业务真实性、容量累计写事务/恢复/收费。S01～S08/C01～C08不能因纯函数层通过就整体打勾。下一切片建议把纯codec与已有隔离业务目录作为两个独立配置组合验收，再设计同事务业务核验；仍不开放initialize。

## 5. 验证和清理记录

本轮新建无TCP `/private/tmp/source-codec.a0alzU`，不复用前轮已停实例；只安装纯schema及受限目录检查登录，没有业务表/运行角色。最终68项PG测试（含父项）全通过，3项门禁单元全通过；全仓372项，351通过/21条件跳过，类型检查通过。实库专项与普通回归分开记录，不把条件跳过计为实库成功。

Standards与Spec分别审查均无阻断；追加空default ACL行头修正后两轴限定复核通过。引用/diff及静态配置一致性检查通过。清理纯schema/8函数/inspector后，独立查询剩余schema=0、测试角色=0、codec_admin default ACL行=0，再停止实例；目录/server.log留存，可重建实验资料，不递归删除。

复验需先在另批的无TCPPG16实例安装草稿，另创建固定受限codec_inspector登录（无schema/函数权限），再提供TEST_CODEC_SOCKET执行测试；测试不自动安装schema/创建inspector或放宽权限。本轮freeze只针对独立纯schema，旧业务两配置未做同库组合复验，留下一切片。
