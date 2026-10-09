# D1b SQL 编码与投影纯计算边界

状态：文档设计候选。承接[离线黄金向量](2026-10-09-source-initialize-golden-vectors.md)、[编码预算](2026-10-08-source-initialize-encoding-budget.md)与Proposed ADR0008。本轮不交付可执行SQL、不执行数据库、不创建角色/GRANT或修改旧profile；写入口仍不存在。

## 1. 独立交付形状

后续建议新增独立 `docs/sql-drafts/evidence-source-d1b-codec.sql`，不覆写D1b表草稿。文件仅包含纯编码、严格字段验证、task/snapshot投影及固定预算行投影函数；不包含来源初始化入口、业务读取、表写入、授权helper调用、预算UPDATE、COMMIT、动态SQL或通用查询参数。

候选全部SECURITY INVOKER、固定search_path=pg_catalog,pg_temp、显式限定依赖；没有SECURITY DEFINER或新运行角色。依赖仅批准的内建JSON/字符串/数值/UTF8/SHA256能力，不自动安装扩展。函数声明的IMMUTABLE/PARALLEL属性须按实际依赖核验，不凭“纯函数”名称推断。创建后PUBLIC默认EXECUTE必须撤回；这是未来隔离草稿的显式ACL封闭要求，不是本轮授权操作。普通LOGIN及initializer均不提前获得执行权。

采用独立候选schema `source_ingest_d1b_codec_v1`，无对既有表的依赖，无继承旧schema默认权限的假设。旧冻结目录门禁是否拒绝新schema取决于其既有投影范围，不能宣称必然拒绝；新codec要有独立冻结函数/ACL验收，旧两个profile内容和摘要不变。后续运行profile必须同时纳入codec，纯函数通过不等于writer许可。

## 2. 函数分层与输入范围

| 层 | 候选职责 | 不承担 |
| --- | --- | --- |
| 私有字符串/整数编码 | 逐字符JSON转义、合法Unicode/安全整数检查 | ID/业务权限、任意浮点协议 |
| 有界编码遍历 | 固定ASCII键排序、数组原序、JSON字面量，输出规范UTF8 bytea | 自定义对象键或通用JCS认证 |
| 类型封套校验 | 按固定协议种类核对精确键集合、字段类型/深度/长度，再调用遍历 | 用jsonb::text或调用者hash替代编码 |
| task/snapshot投影 | 从已验证完整业务JSON构造批准payload及指纹 | 证明输入来自真实不可变业务行 |
| 固定row投影/预算 | 显式列名、UTC毫秒时间、bytea转小写hex，算package/receipt字节 | 动态SELECT *、物理磁盘估算、改变计数 |

候选封套白名单覆盖完整initialize/register身份（register仅编码回归，不实施登记）、两payload、13键initialize回执、collectionBase、两source/two link、receiptBase及两成员。完整四类业务JSON的规范核验也需要独立类型封套，不能因为17份向量未覆盖它们就忽略运行事务的业务字节证明；新增业务向量沿现有prepareSourceBusinessFixture资料及指纹对照。

低层遍历是内部有限组件，不能把一个任意JSON函数当严格公开协议入口。封套外未知键、少键、类型错、深度/节点/字节越界均先拒绝；具体遍历上界需在可执行草稿前固定，不能无限递归。JSONB已经丢失原输入重复键、数字词法与对象属性描述符；本层只能验证解析后结构，Node发送前严格输入检查仍保留，不声称SQL还原原始字节。

## 3. 编码算法候选

字符串从合法text逐字符遍历：引号/反斜线转义，退格/换页/换行/回车/tab短转义，其余U+0001～001F输出单个反斜杠、字母u及四位小写hex；斜杠和合法非ASCII直接UTF8，不归一化。NUL/孤立代理项无法进入合法PG text，驱动发送前拒绝；实库还需验证JSONB解析失败脱敏。

固定键只有ASCII，用显式C排序重建，而不是数据库默认collation或jsonb展示排序。数组WITH ORDINALITY按序编码，空数组/对象使用固定括号；不得用无ORDER BY的聚合。数值按numeric值验证为安全整数再输出整数十进制；零输出0，拒绝超安全范围及非整数，允许的正/非负值仍由类型封套收紧。

对UTC timestamp先检查有限值、固定年份范围及毫秒精度，再显式UTC格式化，不截断微秒、不使用会话TimeZone/DateStyle或locale。对原业务JSON时间字符串要求现有纯校验的严格UTC格式。bytea预算字段通过encode(...,'hex')输出不带前缀的小写hex；SHA256沿内建bytea算法，不用文本默认编码或客户端摘要。

SQL投影统一ruleVersion，不把source-projection-v1写入source.rule_version；该候选投影标记只在link，并显式要求统一配置值等于完整quote.pricingRuleVersion。业务fixture本身无统一规则字段，所以传入规则只能是未来受控调用层的配置断言，不是客户端权威；上述相等检查也不能称本纯层已证明生产规则归属。

## 4. 字段、预算与拒绝结果

所有row键按现有SQL全部列显式列出，包括collection追加initial_task_kind/initial_snapshot_kind。collectionBase只排package_bytes、receiptBase只排accounted_bytes。预算沿批准候选：新集合4321/回执4085、新键already_registered回执4113、原键零增量，均为固定合成样例而非通用常数；真实值必须重新编码计算。

函数错误候选只返回固定错误代码，不包含原文、连接或SQL细节。语法非法与已存完整性错误的映射由未来运行入口按调用情境区分；纯函数不自称FORBIDDEN/COMMIT成功。不能catch全部异常后返回false/空JSON/零成本把故障当正常输入。

## 5. 后续隔离验收与门禁

| ID | 后续场景（本轮未执行） |
| --- | --- |
| S01 | 原两条命令指纹与17份固定向量逐字节、长度、SHA256三方一致 |
| S02 | 完整四类业务规范内容/所有投影对照，规则版本分离不破统一不变量 |
| S03 | 全控制字符、中文/非BMP、组合Unicode、数组顺序及安全整数边界 |
| S04 | 少/多键、错误类型、非法ID、浮点/越界数、深度/节点/大小拒绝 |
| S05 | 业务JSON时间字符串非严格UTC拒绝；typed timestamptz微秒精度/非有限值拒绝，统一UTC输出；原偏移已丢失不声称可拒绝，变TimeZone/DateStyle结果不变 |
| S06 | 类型封套不能绕过，PUBLIC/普通LOGIN不能执行内部函数；无表ACL扩张 |
| S07 | 函数正文/owner/search_path/default ACL漂移拒绝；新codec独立profile冻结 |
| S08 | 修改成员顺序/任一row列会改变预算/摘要；自引用字段不进入封套 |

先批准可执行纯SQL草稿及遍历上界，静态审查后再另批PG16隔离执行；执行仅合成库函数计算，不装配writer。SQL/Node一致性未验证、S01～S08未执行；不要把前轮OpenSSL对照等同本轮SQL通过。下一步建议交付这一独立封闭纯计算草稿，仍不提供initialize EXECUTE。

## 6. 本轮检查

Standards无硬性阻断，按建议消除控制字符转义描述歧义；Spec指出时间原偏移与统一报价规则断言需明确，修正后复核无残留阻断。相对引用、S01～S08唯一编号及diff检查通过。本轮只有文档，未重跑代码或数据库测试。
