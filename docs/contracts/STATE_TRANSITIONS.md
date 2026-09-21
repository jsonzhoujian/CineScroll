# 状态转换契约

状态：T02 契约基线 v0.1

## 1. 阶段门禁

```text
原文版本已保存
  → 故事知识候选 → 故事知识已确认
  → 拆集方案已确认 → 剧本候选 → 剧本已确认
  → 设定候选 → 设定已确认
  → 分镜候选 → 分镜已确认
  → 导出
```

下一阶段可以被查看，但只有直接上游存在 `confirmedVersionId` 且没有阻断性待确认问题时，才可启动正式生成。

## 2. 内容版本状态机

| 当前 | 事件 | 守卫 | 下一状态 | 副作用 |
| --- | --- | --- | --- | --- |
| — | AI/人工创建 | 输入契约有效 | `candidate` | 创建不可变版本及条目 |
| `candidate` | 检出不确定项 | 存在别名、身份或事实冲突 | `needs_resolution` | 建立待确认问题 |
| `needs_resolution` | 问题全部处理 | 无未解决阻断项 | `candidate` | 记录决策审计 |
| `candidate` | 确认 | 操作者为负责人/审核人；出处有效 | `confirmed` | 设置阶段 `confirmedVersionId` |
| `confirmed` | 编辑/接受建议 | 有修改理由 | `confirmed` | 原版本不变；派生新 `candidate` |
| `confirmed` | 新版本被确认 | 后继版本通过确认 | `superseded` | 阶段指向新确认版本 |
| `candidate/needs_resolution/confirmed` | 合规限制 | 有有效限制决定 | `restricted` | 禁止新 AI 任务和分享 |
| `restricted` | 申诉恢复 | 限制已解除 | 原业务状态 | 记录恢复审计 |

不得从 AI 任务 `succeeded` 直接跳到 `confirmed`。

## 3. 锁定转换

```text
unlocked --lock(owner|reviewer)--> locked
locked --unlock(owner|reviewer)--> unlocked
```

- 锁定只能作用于已确认条目。
- 锁定条目可以被标记为受影响，但生成、重生成和接受建议均不得覆盖它。
- 解锁必须产生审计记录；随后修改仍然派生新版本。

## 4. 修改建议

```text
open → accepted
open → rejected
open → withdrawn
```

`accepted` 要求负责人或审核人，并创建目标阶段的新候选版本；它不把变更直接写入原确认版本。终态不能再次处理。

## 5. 上游影响

上游确认版本发生变化时，计算并创建 `ImpactLink`：

```text
unreviewed → keep → resolved
unreviewed → revise → resolved
unreviewed → regenerate → resolved
```

- `keep` 表示人工确认下游仍有效。
- `revise` 表示人工编辑新候选版本。
- `regenerate` 仅重做用户选择的范围。
- 任一路径不得自动覆盖锁定目标或范围之外的条目。

## 6. AI 任务状态机

```text
queued → running → succeeded
                 ↘ partially_succeeded
                 ↘ failed
queued/running → cancelled
```

结算规则：提交冻结预计积分；成功项按实际规则结算，失败项额度自动退回。`partially_succeeded` 必须同时至少含一个成功项和一个失败项。重试任务通过 `retryOfJobId` 与失败 `scopeKey` 关联，仅覆盖所选失败项。

## 7. 原文重新导入

```text
SourceVersion N --reimport--> SourceVersion N+1
```

旧版本与片段永远保留引用能力。差异产生影响链接，但不得把既有追溯引用静默改指新片段。

## 8. 工作模式与工作游标

```text
trace ↔ review ↔ storyboard
```

模式切换只更新 `UserProjectViewState`。内容版本、阶段状态、锁定、建议、影响、AI 任务和审计业务状态均不发生转换。工作游标尽量保留；目标对象在当前视图不可呈现时允许隐藏显示，但不得删除游标或修改内容。
