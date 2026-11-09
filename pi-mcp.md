---
layout: default
title: Pi：Agent Harness、持久任务与工具编排
permalink: /topics/pi-mcp/
description: 从 Pi 的会话与持久任务架构出发，理解原生 MCP 怎样接入工具，Code Mode 怎样组合调用，以及中断后恢复需要保存什么。
---

<article class="page prose" markdown="1">

# Pi：Agent Harness、持久任务与工具编排

Pi 是围绕模型、上下文和工具执行构建的 Agent 工具包。理解它的设计，可以沿两条线展开：一条看 harness 怎样组织会话与持续工作，另一条看工具怎样接入、组合并把结果交回模型。两篇文章分别解释这两层职责，以及它们在持久执行时如何衔接。

## 会话怎样延续，任务怎样从中断处恢复

[Pi 的 Agent Harness 设计：会话管理与持久任务恢复](/posts/pi-agent-runtime/)先区分交互式编码会话与应用持续托管，再追踪 AgentSession、会话树和 Pi Durable 的任务模型。

保存历史使下一轮能够重新构造上下文；保存执行阶段、任务身份与等待关系，才让调度器能够继续推进已有工作。文章以 ToolTask 解释执行意图、检查点、外部动作和结果提交的关系，并进一步分析子任务归属、持久 Code Mode，以及休眠和重新唤醒怎样配合。Pi Durable 的 API 仍处于实验阶段，采用时需要同时考虑存储、宿主调度和外部操作的恢复方式。

## 原生 MCP 怎样接入，Code Mode 怎样组合调用

[Pi 1.0 的工具调用设计：原生 MCP 接入与 Code Mode 编排](/posts/pi-mcp-tool-exposure/)从连接和工具发现进入，说明 direct、deferred 与 Code Mode 分别把工具定义、调用控制和中间数据放在哪里。

官方 Linear 与 Jev 演示提供了具体参照：查询 issue、读取评论、调用决策模型和筛选结果怎样组成一次任务，哪些判断由模型提出，哪些依赖由程序组织。文章还对照当前 MCP 返回结构解释历史脚本需要调整的地方，并区分数据复用、持久执行与权限管理。

## 进一步阅读

- [长运行 Coding Agent 的 Harness 架构：交接、验收与恢复](/posts/long-running-agent-harness/)
- [Agent 配置供应链：指令、Skills、Hooks 与 MCP 的安装边界](/posts/agent-configuration-supply-chain/)
- [Agent 工具输出压缩的成本评估：从 RTK 实验到任务账单](/posts/agent-compression-total-cost/)

[返回全部主题](/topics/)

</article>
