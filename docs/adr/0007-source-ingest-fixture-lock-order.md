# 隔离D1b采用授权共享锁与工作室预算外层串行点

Status: Accepted for isolated draft（用户后续确认该锁序、受控锁定helper及实验容量，用于独立SQL草稿；未批准数据库执行、运行仓储或生产启用）。

## Context

同workspace/ingest跨集合唯一，空回执/空头查询不能锁不存在身份；容量累计也需要同事务保护。权限缓存不能提供撤权与提交的数据库顺序。初始实验不追求工作室内高并发。

## Decision（候选）

稳定principal→workspace grant共享行锁，授权后历史回执可只读重放；新写先锁已存在workspace预算行，再来源头→登记版本→不可变业务。授权管理员按相同前缀取得冲突锁，不进入头/预算。撤权提交在先则新请求拒绝，操作先持许可锁则撤权等待事务结束；不声称即时取消在途。

## Consequences

共享登记键和预算缺行竞争更易验收，代价是同工作室写入串行及稳定授权行的管理成本。此顺序只用于隔离D1b，不提前保证D2/D3发布请求锁组合安全；具体SQL与双连接试验尚未完成。

## Alternatives

每ingest保留行/advisory锁可提高并发但与预算/头锁组合复杂，延期；空FOR UPDATE/每集合map不能证明共享去重，拒绝。保持仅外部权限缓存不能提供撤权屏障，拒绝。

详见[候选存储与权限方案](../plans/2026-10-08-source-ingest-d1b-storage-permissions.md)。
