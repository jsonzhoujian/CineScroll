# 开源动态漫工作流借鉴

调研日期为 2026-11-20。结合本仓库 T07 技术验收、T08 版本协作以及 T10 导出规格整理，供后续排期查阅。

## MVP 内可用

| 借鉴 | 落点 | 验证办法 |
| --- | --- | --- |
| 分镜切点与剧本对账 | 从正式分镜的排序和时长派生逐集时间轴，核对对白、动作和剧本要素覆盖。生成段及单镜时长限制放在具体工具的导出适配层。 [shuohao-skills](https://github.com/eternityspring/shuohao-skills/blob/main/skills/novel-storyboard/README.en.md) | 每镜时间可复算，指定对白可定位到剧本、原文或已批准改编。 |
| 引用设定、人工确认、局部重做 | 沿用 T07/T08 的正式发布、资产 ID、锁定和受影响项。分镜校验目前允许资产列表为空，试制时记录确需设定却未引用的镜头。 [Toonflow](https://github.com/HBAI-Ltd/Toonflow-app) · [ArcReel](https://github.com/ArcReel/ArcReel/blob/main/README.en.md) | 改一项设定后能找到受影响镜头，旧发布仍可复查和复导。 |
| 同一发布派生多种交付格式 | 按 T10 规格先取同一正式快照，生成版本化 JSON，再从同一输入生成 DOCX、XLSX。 [本地导出规格](../PRODUCT_SPEC.md#10-导出契约) | 重导同一发布，结构化内容一致。抽样核对三种格式的镜头、设定和可追溯信息。 |
| 以制作反馈检验镜头语言 | 让制作人员按现有景别、视角、画面、动作和运镜字段试做一小段。记录构图、站位、视线、动作衔接的缺失。 [漫画叙事论文](https://ceur-ws.org/Vol-3810/paper8.pdf) · [CineGen](https://github.com/UllrAI/CineGen-ShortDrama) | 选含两名角色、对白、道具的一集，用 3–5 镜记录返查、猜测和返工。 |

## 试制后再评估

- **参考图和关键帧。** 先测角色锚点图在相邻镜头中的一致性，复杂动作再加可选尾帧。文字设定、参考图版本及生成结果分别追踪。比较人工通过率和单镜重试次数。 [CineGen](https://github.com/UllrAI/CineGen-ShortDrama) · [ToonCrafter](https://github.com/Doubiiu/ToonCrafter)
- **粗剪与动效。** 用已有或占位图、静图推拉、临时对白和字幕做最小试制。记录普通镜头、需分层镜头和需插值镜头的耗时及质量。 [最小生成流程](https://github.com/cleversnail/AI-Comic-Video-Generator) · [AniClipart](https://aniclipart.github.io/)
- **全流程和模型接入。** 等试制确认重复工作后，再评估生产任务调度、Provider 能力、外部剪辑草稿。现有候选、确认和任务边界可作为接入基础。 [ArcReel](https://github.com/ArcReel/ArcReel/blob/main/README.en.md)

## 证据边界

Toonflow 当前仓库声明 MIT，历史版本适用各自许可。ArcReel 声明 AGPL-3.0 并另附 NOTICE，CineGen 使用 AniKuku Community License。若复用代码，以拟使用版本的 LICENSE、NOTICE 和素材条款为准。定位到的 Koma 仓库是短剧工作台，原说法中的 Python 2.5D 功能清单未获核实。节省 30% 和成本降至几十分之一等说法缺少本项目对照实测。 [Toonflow](https://github.com/HBAI-Ltd/Toonflow-app) · [ArcReel](https://github.com/ArcReel/ArcReel/blob/main/README.en.md) · [CineGen](https://github.com/UllrAI/CineGen-ShortDrama) · [Koma](https://github.com/M-JYuan/Koma)
