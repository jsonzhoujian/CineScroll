# D1b 独立纯计算 SQL 草稿交付

状态：用户批准交付可执行草稿及遍历上界，不批准数据库执行或运行授权。文件：[evidence-source-d1b-codec.sql](../sql-drafts/evidence-source-d1b-codec.sql)。依据[纯计算设计](2026-10-09-source-initialize-sql-codec-design.md)及[黄金材料](../fixtures/source-initialize-vectors-v1.json)；ADR0008仍Proposed。

## 实施边界

独立schema，8个SECURITY INVOKER函数：固定profiles、字符串编码、ID检查、UTC毫秒格式化、有界walk、类型封套encode_document、task/snapshot投影、预算计算。没有新角色、GRANT、业务表查询/DML、SECURITY DEFINER或运行入口；最终撤回全部PUBLIC函数执行权。schema/function由执行草稿的受控DDL管理员拥有，不宣称已转给非超级运行owner；默认ACL/owner实际权限仍须未来隔离验收。

上界：root depth=0，最大深度8；最多50,000个值节点（键名字串不另外算节点）；单输入2MiB；输出16MiB。输入前置工作量限制按UTF8(jsonb::text)计，**不是规范字节**，可能因展示空格在边界更保守；不拿它做摘要/持久化预算。数组最多100项，sourceReferences恰2、scopeKeys恰1、有序ID数组禁止重复。walk使用剩余节点预算，不允许每个子树各拿50,000。数值验证安全整数，键按C排序，字符串逐字符JSON转义，timestamp显式UTC/毫秒；未将这些候选算法声明为实库通过。

profiles来自已审阅合成材料的固定类型树（代码内字面量，不运行时读取黄金文件），另列registerIdentity编码回归、四类业务封套。预算调用全部显式row封套，包含collection后加列并排除两个自引用字段；没有动态SELECT *。

投影检查统一ruleVersion等于quote.pricingRuleVersion，binding相等；task初始revision/前序/scope，snapshot与报价固定责任/金额/引用一致。projectionRuleVersion仍独立link标记，函数不自动改写来源规则。

## 未完成的运行证明

封套是固定形状及字段类型/部分值域验证，**不是完整业务校验器或写guard**。两source/link/member预算函数计算调用者提供的合成资料长度，不证明来源canonical/hash一致、完整binding/四类双向引用、所有row跨行关联或生命周期；这些仍由未来运行同事务入口独立核验。execution/quote只编码，不产生新来源。不把pure结果当已认证producer、真实业务来源、授权或成功回执。

SQL未解析/安装/执行；没有SQL/Node三方对照，时间cast/函数实际ACL/目录漂移/深度与容量边界均待隔离PG16。S01～S08及C01～C08不能整体标记通过。编码已通过OpenSSL的Node黄金材料不能替代本草稿正确性。

下一步：另行批准仅在合成PG16库创建该纯schema，以受控测试管理员调用黄金/拒绝向量；保持运行LOGIN无函数权限、不装配writer、不改旧两profile摘要。先验收纯编码，再接完整运行投影/不可变跨行核验；不要一次开放initialize。

## 本轮静态检查

Standards与Spec分别发现同一数字词法问题，已将generationAtCommit/revision的字符串比较改成numeric值比较；后续必须加入1、1.0及指数等价解析向量，不因JSONB保留小数位而拒绝整数。profiles格式化以便逐字段审阅。美元引号配对、8函数数量、无SECURITY DEFINER/角色/运行GRANT、引用和diff静态检查通过。没有SQL解析器或实库验证，不重跑既有Node测试冒充SQL验证。

修正后Standards/Spec限定复核均无残留静态阻断，仍保留SQL实库验收门禁。
