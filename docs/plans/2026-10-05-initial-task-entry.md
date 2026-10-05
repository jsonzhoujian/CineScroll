# 首次故事知识任务入口 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 已导入章节可明确选择已测试模型并创建任务，自动进入已有任务面板。

**Architecture:** 独立提交组件只接受实际工作台章节上下文；URL恢复列表不获得创建能力。调用既有会话认证POST，只发送配置版本和模型。成功刷新列表并选中返回任务；不增加Worker或生产装配。

**Tech Stack:** Next.js / React / TypeScript / Playwright。

## 已批准范围及测试边界

- 当前章节完成原文导入后显示桌面创建入口；移动端只读。
- 显式选择tested/mainland配置中的模型；不自动选择。海外执行仍关闭。
- 提交中禁用操作、同步防重复；失败保留安全反馈，不自动重试。
- 成功验证任务归属并刷新列表、选中任务；上下文切换/重新导入忽略旧请求。
- 浏览器公共界面与HTTP请求边界验证；供应商/真实模型不在范围内。

## 实施顺序

1. 在 `packages/web/e2e/project-import.spec.ts` 添加导入后明确选模型、提交任务、自动选中和列表刷新测试；运行Playwright确认红。
2. 在 `packages/web/src/lib/api.ts` 增加已存在POST的客户端调用；新建 `components/initial-story-task.tsx`，由 `task-status-panel.tsx` 接线。`import-workbench.tsx` 按原文版本重挂载。
3. 同一浏览器边界逐片补失败、重复提交、移动端、URL只读和配置不可用覆盖，红绿验证。
4. 类型检查、完整浏览器/默认测试、截图检查；双轴审查相对 `24b706e` 未提交差异。
5. 同步契约/计划与验证结果；仅提交本轮文件，不推送，不调用真实AI。

## 完成记录

2026-10-05：入口缺失的浏览器红灯确认后实现，导入主流程绿灯通过；补齐409失败清理、忙碌禁用、未测试/境外配置、活动原文变化后的旧响应隔离、手机隐藏及URL恢复只读验证。完整浏览器13/13；默认node测试145通过、9个显式数据库测试跳过；web类型检查及Next生产构建通过。截图人工检查完成。Standards与Spec均无剩余阻断，依据建议采用activeSourceVersionId重挂载。未使用真实Key/模型、未生产装配、未推送。
