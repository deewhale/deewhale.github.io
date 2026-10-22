---
layout: default
title: Pi：Harness 架构与工具调用设计
permalink: /topics/pi-mcp/
description: 解析 Pi 的会话管理、Durable 持久任务恢复，以及原生 MCP 与 Code Mode 的工具调用机制。
---

<article class="page prose" markdown="1">

# Pi：Harness 架构与工具调用设计

Pi 1.0 的设计可以从两个问题进入：模型之外的运行时怎样组织会话与执行；工具越来越多时，定义、数据和调用控制应放在哪里。这里的两篇文章分别沿实际实现与官方公布的演示，解释这两条路径。

## 会话管理与持久任务恢复

[Pi 的 Agent Harness 设计：会话管理与持久任务恢复](/posts/pi-agent-runtime/)沿 AgentSession、SessionManager 与 Durable 的任务实现，解释上下文怎样形成、历史怎样保存，以及运行中的工作怎样通过检查点恢复。

文章重点分析 ToolTask 的执行意图、外部动作与结果提交，继而说明 replay、任务归属、后台工作和 Code Mode 日志如何协作。参考对象是对应版本的实际代码与规范；官方演示作为具名设计原型说明其应用方式。

## 原生 MCP 接入与 Code Mode 编排

[Pi 1.0 的工具调用设计：原生 MCP 接入与 Code Mode 编排](/posts/pi-mcp-tool-exposure/)先解释 Pi 将两项能力纳入同一运行时的原因，再拆解官方公开的 Linear 与 Jev 演示：查询 issue、取得评论、分类、筛选和汇总分别由谁完成。

direct、deferred 与 Code Mode 的比较围绕工具定义、执行控制和中间数据的位置展开。历史演示与 v1.3.0 接口分别说明，帮助读者区分设计原理、官方展示结果与实际接入条件。

两篇以 Pi 1.0 公告说明设计背景，以 v1.3.0 固定实现分析机制；本轮资料核查日期为 2026 年 10 月 22 日。Pi Durable 仍属实验 API，与稳定编码 Agent 的发布状态分别说明。

## 进一步阅读

- [长运行 Coding Agent：中断接管与完成证明](/posts/long-running-agent-harness/)
- [Agent 配置供应链：指令、Skills、Hooks 与 MCP 的安装边界](/posts/agent-configuration-supply-chain/)
- [Agent 上下文压缩：缓存、重试与任务总成本](/posts/agent-compression-total-cost/)

[返回全部主题](/topics/)

</article>
