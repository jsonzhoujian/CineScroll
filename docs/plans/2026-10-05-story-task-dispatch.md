# 故事知识后台调度基础 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 内部按页发现queued任务并交给已有执行器，独立扫描过期/未知任务进行不收费对账。

**Architecture:** 工作室ID来自可信调度调用方，不枚举全局租户、不暴露HTTP入口。仓储按UTF-8/C任务ID分页扫描；执行器以原始提交人Actor重新检查权限、原文与模型，沿用queued→running revision CAS。恢复扫描只读取持久化结果，未知执行不重发。提供单次有界tick供未来Worker调度，不在本轮增加定时器或生产装配。

**Tech Stack:** TypeScript / 现有任务服务及执行器 / PostgreSQL RLS / node:test。

## 批准范围和测试边界

- 扫描任务仓储公共接口、调度tick公共接口与真实任务/知识服务；模型仅模拟。
- 限制每页1～50项，独立run/recover模式及游标；返回简洁状态不含Key、原文、供应商错误。
- 两调度实例竞争依赖CAS，不把扫描当抢占；没有权限则跳过，不提升为负责人。
- 执行前校验已有任务上下文和凭据，保持现有版本变更暂停机制。
- 活租约不恢复；过期无结果转EXECUTION_UNCERTAIN，不允许重发；晚到持久化候选可补终态。
- 无真实AI/计费/合规新门禁/生产挂载/心跳/任务取消。当前合规和投诉许可仍是上线阻断。

## 实施顺序

1. `packages/script/test/model-tasks.test.ts` 添加工作室/阶段/状态筛选分页红灯；实现model-tasks.ts及postgres-model-tasks.ts扫描接口，新增0007扫描索引。
2. `packages/api/test/story-knowledge-task-api.test.ts` 由新调度tick驱动已有完整模型fixture，确认缺少模块红灯；新增src/story-knowledge-task-dispatcher.ts，覆盖竞争/执行与恢复。
3. 补活租约/未知/晚到恢复、无权与跨工作室、不重发和安全报告；运行临时PostgreSQL任务契约，默认回归与API/script类型检查。
4. 相对90358ba未提交差异进行Standards/Spec审查；更新契约和结果，自动本地提交，不推送。

## 完成记录

2026-10-05：仓储缺少scan接口及dispatcher模块的红灯已确认后实现。模拟模型链路验证多调度竞争仅一次调用、原提交人权限隔离、过期无结果未知暂停、晚到候选修复、无效响应和原文变化净化报告；内存/临时PostgreSQL任务套件3/3通过（包含扫描分页、状态/阶段/RLS过滤、租约和并发CAS）。API/script类型检查通过。Standards无阻断，分页末项计算的小量重复为非阻断建议；Spec无阻断。最终默认完整回归145通过、9个显式数据库测试跳过。迁移0007只应用临时数据库，未挂载生产或启动常驻Worker。
