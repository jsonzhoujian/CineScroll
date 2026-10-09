# D1b 纯计算草稿隔离 PG16 验证

用户批准仅无TCP临时PG16验证。对应[纯计算草稿](../sql-drafts/evidence-source-d1b-codec.sql)及[交付边界](2026-10-09-source-initialize-sql-codec-draft.md)。本轮新增条件测试 `packages/billing/test/source-codec-postgres.test.ts`，运行代码/SQL草稿及旧profile均未改。

## 环境与复验

创建全新 `/private/tmp/source-codec.wrYj3W`，PG16、UTF8、C locale，listen_addresses为空，仅Unix socket端口55439。管理员codec_admin只用于该专属临时实例，普通codec_probe登录仅测试权限拒绝，随后删除。未加载业务表或任何writer，schema只有8个纯函数。

复验需另批新建无TCP实例并安装草稿；条件测试只调用已安装函数，不自动安装或迁移。执行示例：`TEST_CODEC_SOCKET=/private/tmp/source-codec.XXXXXX node --test packages/billing/test/source-codec-postgres.test.ts`（替换为真实新路径）。测试连接前要求路径格式，连接后检查PG16/UTF8/无TCP/专属data_directory/管理员身份，不接受生产URL或备用连接。安装/清理/停止由实验流程显式完成，不由测试包装器擅自修改schema。

## 结果

初次35项通过，补充拒绝/权限后38项（含父测试）全部通过：

- 17份固定规范字节、字节数和SQL内建SHA256与黄金文件相同；原initialize/register两命令指纹不变。
- 四类完整业务JSON规范编码一致；两payload投影一致，错误统一规则拒绝；预算4321/4085和新键重复回执4113一致。
- 额外字段、浮点/越界整数/零revision、错误scope数组拒绝；1.0代字段解析值1正常规范化。
- 微秒精度拒绝，两个会话时区输出UTC一致；中文/非BMP/引号/反斜杠/控制字符转义一致。
- PRIVATE walk深度9和耗尽剩余节点拒绝，超2MiB输入拒绝；PUBLIC无schema/function ACL，普通LOGIN实际调用42501，无数据表。

不是完整容量证明：未验证恰8层/50,000节点/2MiB/16MiB全部等值边界、最大输出性能、全部时间及字段拒绝组合、DateStyle、目录漂移profile、原子写入或失败回滚。测试管理员可执行worker不等于运行授权；没有授权initializer/普通LOGIN，仍不形成可信业务写入口。S01～S08及C01～C08只获得本样例的局部证据，不整体打勾。

## 清理

测试后明确删除该临时实例中的codec schema及8函数，独立查询确认剩余schema=0、codec_probe角色=0，然后pg_ctl fast停止实例。临时数据目录和server.log保留用于诊断，不递归删除；实验对象可通过仓库草稿/测试重建。无常驻服务、无生产库操作。

## 回归与审查

全仓类型检查通过；普通全仓回归368项（347通过、21数据库条件跳过），其中本轮数据库条件测试未设socket时跳过，不与单独实库38项混算。Standards/Spec均无阻断；Standards建议未来清空连接options/核对current_user以减小PGOPTIONS影响，作为后续fixture强化项，不宣称本轮已实施。diff与文档相对引用检查通过。
