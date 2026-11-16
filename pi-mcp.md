---
layout: default
title: Pi 的会话架构、任务恢复与工具调用
permalink: /topics/pi-mcp/
description: 两篇关于 Pi 的文章：一篇讲它怎样保存会话、在进程中断后恢复任务，一篇讲它怎样接入 MCP 工具、用 Code Mode 把多次调用写成脚本。
---

<article class="page prose" markdown="1">

# Pi 的会话架构、任务恢复与工具调用

Pi 是一个 Coding Agent 系统，可以在终端里用，也可以通过 SDK 嵌进应用。这个专题有两篇文章：一篇讲它的 harness 怎样保存会话、在进程中断后恢复任务；一篇讲它怎样接入 MCP 工具，以及怎样用 Code Mode 把多次工具调用写成一段脚本。

## 会话管理与持久任务恢复

[Pi Harness 架构与 Durable 任务恢复机制](/posts/pi-agent-runtime/)先区分交互式编码会话与应用持续托管，再追踪 AgentSession、会话树和 Pi Durable 的任务模型。

保存历史使下一轮能够重新构造上下文；保存执行阶段、任务身份与等待关系，才让调度器能够继续推进已有工作。文章以 ToolTask 解释执行意图、检查点、外部动作和结果提交的关系，并进一步分析子任务归属、持久 Code Mode，以及休眠和重新唤醒怎样配合。Pi Durable 的 API 仍处于实验阶段，采用时需要同时考虑存储、宿主调度和外部操作的恢复方式。

## MCP 接入与 Code Mode 调用

[Pi 的 MCP 与 Code Mode：工具接入和程序化调用](/posts/pi-mcp-tool-exposure/)从连接和工具发现进入，说明 direct、deferred 与 Code Mode 分别把工具定义、调用控制和中间数据放在哪里。

官方 Linear 与 Jev 演示提供了具体参照：查询 issue、读取评论、调用决策模型和筛选结果怎样组成一次任务，哪些判断由模型提出，哪些依赖由程序组织。文章还对照当前 MCP 返回结构解释历史脚本需要调整的地方，并区分数据复用、持久执行与权限管理。

## 进一步阅读

- [长运行编程 Agent 的 Harness 设计与故障恢复](/posts/long-running-agent-harness/)
- [Agent 配置的供应链安全：Skills、Hooks 与 MCP](/posts/agent-configuration-supply-chain/)
- [Agent 工具输出压缩能节省多少成本：RTK 实验分析](/posts/agent-compression-total-cost/)

[返回全部主题](/topics/)

</article>
