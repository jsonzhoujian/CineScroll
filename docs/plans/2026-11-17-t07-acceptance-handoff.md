# T07-05 验收与交接记录

技术验收通过。T07 与 T07-05 已完成，解除 T08/T09 的前置依赖。真实语义、上线和结算走各自门禁。

| 验证层 | 已覆盖 |
| --- | --- |
| 合成样本 | 玄幻、都市、悬疑各跑 60、180、300 秒。从正式剧本交接到四类设定，完成建议、裁决与锁定。分镜按失败范围恢复并保留成功镜头。剧本重确认后拒绝使用旧上游生成。 |
| 隔离 PostgreSQL | 三类 60 秒样本各用独立数据库。原候选部分失败，先恢复一项，再用实际 Runner 恢复最后一项。同一恢复候选送审，接受建议、确认、锁定、解锁并验证上游影响。公开影响使用审核编号，底层审计按任务及镜头定位。 |
| TLS 与 Chromium | TLS 独立样本覆盖 Session API、正式分镜、私有重试与正式审计。复用 T07-04 的四条 Chromium 回归，覆盖三模式定位、正式剧本与活动草稿区分、移动端只读。 |
| Standards / Spec | 两路独立复核均确认恢复候选贯通正式发布，未发现技术验收阻断。 |
| 真实语义与发布 | 待独立验收。剧本、设定和分镜输出使用固定夹具。 |

## 复验

合成样本使用 `node --test packages/script/test/t06-acceptance.test.ts`。实库用例在每次执行时安装迁移，分别以 `TEST_T07_GENRE=玄幻`、`都市`、`悬疑` 和各自独立的空测试库 `TEST_DATABASE_URL` 运行 `node --test packages/script/test/postgres-script-content.test.ts`。未提供题材时默认悬疑。TLS 用例使用 `TEST_TLS_DATABASE_URL` 和 `TEST_TLS_CA_PATH` 运行 `node --test packages/api/test/production-tls.test.ts`。

## T08 版本与影响

确认操作的 `publication_id` 对应 `storyboard_review_operations` 的审核编号与确认修订。正式快照以确认修订为上限重建。审核提交的 `job_id` 对应不可变生成候选及 `script_downstream_dependencies.target_version_id`，`target_item_id` 为镜头编号。公开剧本影响接口使用审核编号并过滤未提交审核的分镜。后续版本功能需要精确发布快照时应携带发布编号，避免用审核编号指代某次确认。

## T09 任务与结算

任务结果的 `candidateVersionId` 是不可变私有候选编号。重试关联基准候选、来源任务和所选范围。共享审核、正式确认与生成任务是独立操作，确认审计可用于复查阶段状态。真实收费、结算证据完整性和 T09 整体验收仍按各自工单执行。
