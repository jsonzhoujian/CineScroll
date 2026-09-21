# 统一领域模型

状态：T02 契约基线 v0.1  
日期：2026-09-21

## 1. 不变量

1. `Project` 是一部作品的聚合根；所有权威内容均可由 `projectId` 归属。
2. 原文版本不可被 AI 静默覆盖；重新导入产生新的 `SourceVersion`。
3. 所有 AI 输出先形成候选 `ContentVersion`，只有负责人或审核人确认后才可成为下游依据。
4. `StoryFact`、`ScriptElement`、`SettingAsset`、`Shot` 必须至少拥有一个有效的 `ProvenanceRef`：指向稳定原文片段，或指向已批准的改编新增。
5. 锁定内容不能被生成或局部重生成覆盖；上游变化只创建 `ImpactLink`，不自动重做下游。
6. 追溯、审核、分镜是同一权威项目状态的投影。`WorkspacePreference` 和 `WorkCursor` 属于用户界面状态，不进入内容版本、确认哈希或导出业务内容。
7. AI 任务允许条目级部分成功。通过 Schema 和业务校验的结果可保留，失败项由稳定 `scopeKey` 标识并单独重试。

## 2. 聚合与所有权

```text
Workspace
└── Project (aggregate root)
    ├── ProjectMember
    ├── SourceDocument
    │   └── Chapter
    │       └── SourceVersion
    │           └── SourceFragment
    ├── AdaptationPlan
    │   └── EpisodePlan
    ├── StageResult: storyKnowledge
    │   └── StoryFact
    ├── StageResult: script
    │   └── Scene
    │       └── ScriptElement
    ├── StageResult: settings
    │   └── SettingAsset
    ├── StageResult: storyboard
    │   └── Storyboard
    │       └── Shot
    ├── AdaptationAddition
    ├── ProvenanceRef / AdaptationMapping
    ├── ChangeSuggestion
    ├── ImpactLink
    ├── AiJob / AiItemResult
    └── AuditEvent

UserProjectViewState (separate persistence boundary)
├── WorkspacePreference
└── WorkCursor
```

`UserProjectViewState` 可以被独立保存，但不得嵌入 `ContentVersion.payload`，不得改变导出内容，也不得参与确认状态判断。

## 3. 标识符

所有标识符在项目范围外也必须唯一，使用带类型前缀的字符串。Schema 使用以下稳定形式：

| 对象 | 示例 |
| --- | --- |
| 项目 | `prj_01J...` |
| 章节 | `chp_01J...` |
| 原文版本 | `srcv_01J...` |
| 原文片段 | `frag_01J...` |
| 内容版本 | `cv_01J...` |
| 故事事实 | `fact_01J...` |
| 场次/剧本元素 | `scene_01J...` / `se_01J...` |
| 设定资产 | `asset_01J...` |
| 分镜/镜头 | `board_01J...` / `shot_01J...` |
| 改编新增 | `add_01J...` |
| 建议/影响 | `sug_01J...` / `impact_01J...` |
| AI 任务 | `job_01J...` |

稳定 ID 不携带顺序语义。排序由 `ordinal` 表示，重新排序不改变实体 ID。

## 4. 权威内容与版本

`StageResult` 是阶段容器，包含：

- `stage`：`storyKnowledge | script | settings | storyboard`。
- `activeVersionId`：当前展示的内容版本。
- `confirmedVersionId`：当前可供下游依赖的已确认版本，可为空。
- `versions[]`：不可变内容版本；每个版本记录父版本、创建方式、操作者、时间和状态。

`ContentVersion.status`：

- `candidate`：可编辑候选。
- `needs_resolution`：存在必须人工判断的不确定或冲突项。
- `confirmed`：由负责人或审核人确认。
- `superseded`：已有后继版本，但仍可追溯。
- `restricted`：因合规或版权原因不可继续用于 AI 任务。

锁定是条目级 `locked` 与 `lockedBy/lockedAt` 元数据，不是新的内容状态。确认后再修改必须派生新候选版本，旧确认版本不变。

## 5. 出处模型

`ProvenanceRef` 采用二选一联合：

- `source_fragment`：引用 `sourceVersionId + fragmentId`，并记录转换方式。
- `approved_addition`：引用已批准的 `AdaptationAddition`。

转换方式：`retained | compressed | merged | visualized | actionized | narrated | sonified | omitted`。`omitted` 只用于映射记录，不能作为正式内容唯一出处。

`AdaptationAddition` 必须包含新增理由、提出者、批准者和批准时间；未批准新增不得被正式版本引用。

## 6. 核心实体

### StoryFact

故事知识的最小确认单位，类型为人物、关系、事件、场景、道具或世界规则。`assertionKind` 区分原文明示、AI 推断和用户确认；别名/身份候选与冲突事实用 `resolutionStatus` 保持待确认，禁止自动合并。

### Scene 与 ScriptElement

`Scene` 表示连续时间地点内的戏剧行动。`ScriptElement` 类型为环境、动作、对白、旁白或声音；每个元素独立追溯，并记录文学内容的转换方式。

### SettingAsset

类型为角色、场景、道具或全局画风。角色包含可见特征、外显性格、习惯、状态变化和禁止表现；场景、道具字段按产品规格定义。资产可以被镜头稳定引用。

### Shot

连续视听最小单元，归属一个分镜和场次；包含画面、人物、动作、对白/旁白、时长、景别、机位、运镜、声音、情绪、拆分依据、资产引用与出处。

### ChangeSuggestion

已确认内容不能直接覆盖。建议记录目标版本与条目、替换内容、理由、提出者及接受/拒绝结果；接受建议派生新候选版本，不原地修改确认版本。

### ImpactLink

连接发生变化的上游条目与潜在失效的下游条目，状态为 `unreviewed | keep | revise | regenerate | resolved`。锁定目标仍可被标记受影响，但不能自动替换。

## 7. AI 边界

每个阶段 AI 请求都带有：契约版本、项目/章节/源版本、上游确认版本、生成范围和生成参数。响应统一包含：

- `jobId`、`stage`、`contractVersion`；
- `status`: `succeeded | partially_succeeded | failed`；
- `items[]`：逐项 `succeeded | failed`，成功项带结构化值，失败项带机器错误码与可读信息；
- `usage`：模型与成本记录，不进入内容确认语义。

任务状态与阶段内容状态分离。任务成功不会自动确认内容；失败也不会清除同任务已成功且通过校验的条目。

## 8. 工作模式与 UI 状态

工作模式仅允许 `trace | review | storyboard`。工作游标包含可选的章节、集、场次、镜头、原文片段和选中内容 ID。它按 `userId + projectId` 存储；其改变不得：

- 创建内容版本；
- 改变 `activeVersionId` 或 `confirmedVersionId`；
- 改变确认、锁定、建议或影响状态；
- 出现在 DOCX/XLSX 业务字段或 JSON 的 `canonicalContent` 中。

JSON 完整导出可以在独立 `exportMetadata` 中声明生成时所用契约版本，但不导出个人工作游标。

## 9. 导出映射

| 输出 | 权威来源 |
| --- | --- |
| DOCX 项目说明/拆集大纲 | `Project`、`AdaptationPlan` |
| DOCX 剧本 | 已确认 script `ContentVersion` |
| DOCX 设定 | 已确认 settings `ContentVersion` |
| XLSX 每集分镜表 | 已确认 storyboard `ContentVersion`，按 `episodeId` 分表 |
| JSON 完整结构 | `project.schema.json` 中全部 canonical 内容、版本、追溯、影响和审计引用 |

默认只输出已确认版本。候选输出必须在导出元数据与可视文件中明确标记未确认。
