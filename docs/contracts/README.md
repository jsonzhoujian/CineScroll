# T02 契约索引

## 产物

- [`DOMAIN_MODEL.md`](./DOMAIN_MODEL.md)：聚合、实体、版本、出处、AI 边界、工作模式隔离和导出映射。
- [`STATE_TRANSITIONS.md`](./STATE_TRANSITIONS.md)：阶段门禁、内容版本、锁定、建议、影响、AI 任务和 UI 状态转换。
- [`json/project.schema.json`](./json/project.schema.json)：完整 JSON 导出的 canonical project Schema。
- [`json/ai/request.schema.json`](./json/ai/request.schema.json)：四阶段共用的 AI 请求信封。
- `json/ai/{story-knowledge,script,settings,storyboard}.schema.json`：各阶段逐项成功/失败响应。
- `fixtures/valid/` 与 `fixtures/invalid/`：玄幻、都市、悬疑的合法/非法项目样本。
- `fixtures/ai/`：四阶段合法响应和无出处分镜非法响应。

## Schema 与业务校验的边界

JSON Schema 校验字段、枚举、联合类型、必填项及基本状态条件。以下跨对象不变量由 T03 选择的应用层校验器负责，并必须形成契约测试：

1. `activeVersionId`、`confirmedVersionId` 和所有引用 ID 必须存在且类型匹配。
2. 四个 `stageResults` 必须各出现一次，不能只靠数组长度判断。
3. `approved_addition` 只能引用状态为 `approved` 的新增。
4. `confirmedVersionId` 必须指向 `confirmed` 版本；阶段门禁必须遵守直接上游确认关系。
5. `partially_succeeded` 必须同时包含成功和失败项；`succeeded` 不得含失败项。
6. 镜头总时长与目标时长偏差不得超过 10%。
7. ID 引用必须归属同一项目；锁定条目不得被重生成范围覆盖。

## 可重复验证

使用 `check-jsonschema` Draft 2020-12 校验：

```bash
uvx check-jsonschema --check-metaschema docs/contracts/json/project.schema.json docs/contracts/json/ai/*.schema.json
uvx check-jsonschema --schemafile docs/contracts/json/project.schema.json docs/contracts/fixtures/valid/*-project.json
uvx check-jsonschema --schemafile docs/contracts/json/ai/story-knowledge.schema.json docs/contracts/fixtures/ai/valid-story-knowledge.json
uvx check-jsonschema --schemafile docs/contracts/json/ai/script.schema.json docs/contracts/fixtures/ai/valid-script.json
uvx check-jsonschema --schemafile docs/contracts/json/ai/settings.schema.json docs/contracts/fixtures/ai/valid-settings.json
uvx check-jsonschema --schemafile docs/contracts/json/ai/storyboard.schema.json docs/contracts/fixtures/ai/valid-storyboard.json
```

`fixtures/invalid/` 和 `fixtures/ai/invalid-*` 必须校验失败。

## T03 必须继承的决定

- 采用 canonical project write model；三种工作模式为读模型/投影。
- 用户工作模式和工作游标使用独立存储边界，不进入内容版本。
- 原文与内容版本不可变；编辑、建议接受和重生成均派生新候选版本。
- Schema 校验后必须执行上述跨对象业务校验。
- AI 编排必须支持条目级部分成功、失败范围重试和幂等 `jobId + scopeKey`。
