# 不可变证据内存仓储

用户批准的公开测试边界：append、get与EvidenceMaterialSource.read；验证工作室隔离、同ID同内容幂等/冲突、复制隔离、补证追加及保存→验证→投影链路。仅内存规则夹具，无数据库/HTTP/真实任务/收费。

EvidenceMaterialRepository为可信服务器低层仓储接口，不提供成员认证。append(workspaceId,material,predecessorId=null)先复制并复用既有只读适配器的结构/判定核验，再保存不可变资料与SHA256规范化内容指纹。对象键顺序忽略，数组顺序保留，补证关系参与指纹。同工作室/ID同内容返回原记录；不同内容拒绝。并发验证后，检查/写入同步完成。

前序证据必须已存在于同工作室，不能自引用；绑定、固定计费快照和执行ID必须相同。前序仍可读取，追加不代表允许改写账本终态。read仅返回material供现有适配器使用，get返回material/fingerprint/predecessorId副本。真实性、跨记录原始结果唯一性、价格质量规则批准、写权限、持久化、分页和容量策略仍未交付，禁止公开或生产装配。

先红后绿，回归/双轴审查后本地提交，不推送。
