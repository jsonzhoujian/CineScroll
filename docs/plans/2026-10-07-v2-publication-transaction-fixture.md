# v2共享请求与共同提交内存规则夹具

用户确认本轮公开测试边界为publishFromSeal(command)、lookupPublished(command)，实现InMemoryV2PublicationTransactionFixture。依据[v2协议](../contracts/EVIDENCE_PUBLICATION_V2.md)、[可信来源契约](../contracts/EVIDENCE_TRUSTED_SOURCE_TRANSACTION.md)和[来源包夹具](2026-10-07-v2-source-bundle-fixture.md)。不实现readPublishedEvidence、PostgreSQL、真实来源或收费。

## 依赖与信任边界

服务器构造器固定serviceId，绑定access.authorize/source.readCurrentFixture/clock方法；命令仍为v2协议，不接受HTTP提交的资料。服务身份只作测试授权定位，不是认证凭证。授权须严格返回true；发布、查询和历史重放每次检查，来源校验等待后发布再次检查专用权限。授权异常净化FORBIDDEN，源/时钟异常净化UNAVAILABLE，非法包维持净化INVALID_SOURCE_BUNDLE。

readCurrentFixture(workspaceId,unitId)是**同步测试来源端口**，返回当前完整来源包，不是数据库接口或异步网络读取。宿主保证当前头、不可变记录和来源范围声明正确；自行构造hash仍不证明真实性。最终复制完整当前包并与已校验快照比较，此后无await或注入回调直至一次复合Map保存，只证明同进程规则。不可将本算法的点时同步读取推广到异步/跨进程来源，真实适配必须共用数据库连接、头锁及所有Writer屏障。

v1OccupiedRequests只复制预置(workspaceId,requestId)占用到同一Map，禁止相同请求v2写入/查询，另一工作室独立。没有v1资料/回执导入、v1运行时写路径或v1与v2实库竞争；原v1模块保持不变、原独立仓储未接入，因此不能宣称生产跨版防双发已完成。

## 原子提交与历史

流程：规范身份→专用授权→共享键已提交检查→复制来源/完整校验→再次授权/并发胜者检查→前序核验→四对象本地组装→最终当前包比较/历史完整性/容量→一次保存请求、资料、审计、回执。全程不调用模型或读取Key。已提交同指纹直接返回原回执，不读当前来源或重算时间；异指纹/版本CONFLICT。

复合记录保存最终协议material及其指纹、固定来源审计/原seal和完整回执。工作室内已发布sealId不能对应另一个清单指纹；同binding新来源不能倒退已知generation或删除/改写已发布清单成员。只读历史回执不要求该seal仍为当前。不同requestId仍不是计费业务去重，账本单元去重和扣费不在本夹具范围。

supplement必须找回同工作室完整v2前序，重验binding/固定snapshot/executionId；前序清单成员必须保留，不改旧四对象。不存在/跨工作室/v1前序不能自动恢复成v2。fixture没有旧业务行的真实证明或运营终态裁决能力。

failAt为固定测试故障位置request/material/audit/receipt/response。前四项是在本地组装期间失败，Map尚未保存，lookup为空；response在一次保存后抛UNAVAILABLE，lookup/原命令重放找回原回执。不等同于真实SQL逐语句回滚或COMMIT响应丢失。lookup=null只表示当前夹具没看到提交，不作为生产中未提交的证明。

## 容量与验证

每实例共享登记最多128项（含v1占用）；单复合记录规范化文本最多2MiB，超限拒绝且不截断，已提交重放不受满容量影响。来源复制沿用已有有界JSON规则，内部复制函数与测试来源构造器抽为复用模块，避免规则漂移；未改变既有来源校验判据。没有持久化、跨进程并发、生产留存或大规模性能承诺。

公开入口测试覆盖成功发布/查询、同键重放冲突、v1占用、工作室隔离、权限撤销、并发同请求、来源变化/旧seal新请求拒绝、组装故障无残留、响应丢失恢复、补证前序、输入/依赖方法复制和容量。所有C/P/S/V实库验收仍未执行。

同步来源误返Promise时拒绝输入并消费拒绝异常，不等待其结果。该回归先因未处理拒绝失败，再修复通过。本轮16项事务夹具测试通过；全量310项中292通过、18项数据库条件测试跳过、0失败，类型检查通过。Standards与Spec审查无阻断。

下一步单独确认已发布证据读取门禁切片，再设计/批准数据库共同事务与受控来源写路径；不从本夹具直接开生产或扣费。
