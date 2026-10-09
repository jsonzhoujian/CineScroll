# D1b Offline Golden Vectors Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 为用户批准的方案A交付可复验的离线合成黄金向量，不开放运行写入。

**Architecture:** 测试专用构造器使用现有四类资料纯校验及统一ruleVersion；projectionRuleVersion独立记录。固定JSON保存规范字节、长度及摘要，测试通过离线向量边界复验，不接受数据库连接。

**Tech Stack:** Node原生测试、TypeScript、OpenSSL SHA256。

---

用户已确认A及离线验证范围。沿用当前干净工作区，不创建额外工作树；引用的superpowers包装技能未安装，按已读取的本地TDD/审查流程执行，不安装工具或扩大范围。

### Task 1: 来源与回执向量

- Create: `packages/billing/test/source-initialize-vectors.test.ts`
- Create: `packages/billing/test/support/source-initialize-vectors.ts`
- Create: `docs/fixtures/source-initialize-vectors-v1.json`
- 先写读取固定向量并比较的测试，运行 `node --test packages/billing/test/source-initialize-vectors.test.ts` 确认缺资料失败；再实现合成构造器及静态字节材料。
- 固定时间、collection UUID、producer、引用与两来源；统一ruleVersion=`rule-v1`，投影版本=`source-projection-v1`均仅测试候选，不冒称生产已冻结。

### Task 2: 预算与列完整性

- 逐表列投影包含ALTER TABLE追加列，移除自引用计数，验证三种预算增量。
- 固定结果以完整规范字节人工审阅、手写task/snapshot字节及独立OpenSSL摘要校验；不用每次测试重新生成预期。
- 运行专项测试、billing回归及类型检查；SQL三方对照未执行，C01～C08不能整体标记通过。

### Task 3: 审查与本地提交

- Standards与Spec分别审查相对`b62e035`变更，修正阻断。
- 更新本文件及T09真实结果，精确暂存本轮文件并本地提交，不推送。

## 离线交付与证据边界

17份固定规范字节及长度/SHA256保存在[JSON资料](../fixtures/source-initialize-vectors-v1.json)。构造器只在test/support，无运行导出/数据库连接。预期文件首次由合成构造器输出并固定，**不是全部手写的独立协议实现**；两payload另有手写字段字节对照，其余完整row已逐列审核。OpenSSL独立验证摘要算法，不能独立证明全部投影语义；静态列检查不是SQL解析器或目录验收。后续SQL实现必须以本固定文件对照，不在测试运行时重生预期。

统一ruleVersion=`rule-v1`与既有合成报价一致；projectionRuleVersion=`source-projection-v1`只用于link，不替换来源/报价/发布的统一规则。业务fixture没有统一ruleVersion字段，构造器使用显式固定值，不声称从业务记录已验证完整生产规则归属。具体生产规则仍需D2受控来源证明。

固定样例字节：collectionBase=1028，taskSource=1067，snapshotSource=1216，taskLink=427，snapshotLink=583，总packageBytes=4321；receiptBase=3587，成员=245+253，总receiptCost=4085。新键重复登记duplicateBase=3615，成员=245+253，总4113；来源增量0。原键重放四计数零增量。hex副本按既定候选保守计费，不是实际磁盘体积。

列检查包含collection后加的initial_task_kind/initial_snapshot_kind；预算不包含自身package_bytes/accounted_bytes。13键回执、两有序成员、原命令完整服务身份及初始化/新键重复登记两种回执均在固定材料内。Unicode/转义/整数另有明确字节测试；输入验证的NUL/孤立代理项沿现有纯校验测试，不向通用canonicalEvidenceValue赋予业务合法性判断。

执行记录：先运行缺构造器的专项测试失败，再补材料后5项通过；17份OpenSSL摘要对照通过。全仓类型检查通过；billing回归150项（140通过、10数据库条件跳过），全仓367项（347通过、20条件跳过）。首次未净化环境的pnpm启动器因环境编码异常退出，使用env -i PATH后正常完成，不把该退出算业务测试失败。没有连接数据库、调用模型或使用真实Key。

C01～C08仍未整体验收：本轮覆盖Node/字节/字段及样例预算，SQL编码/投影对照、运行严格回执验证、容量边界事务与故障原子性尚未执行。下一步先审核这些黄金材料并批准独立SQL编码/投影草稿，不提前给运行入口EXECUTE。

Standards审查无硬性阻断：重复编码/读取的小样本开销不需泛化抽象，测试环境需可执行OpenSSL。Spec审查本轮离线范围内无阻断，保留拒绝/容量/SQL对照未验收标记。相对引用及diff检查通过；双轴结论不替代未来实库验收。
