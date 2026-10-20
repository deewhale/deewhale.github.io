---
layout: default
title: Pi 与 MCP
permalink: /topics/pi-mcp/
description: 从 Pi 的核心循环与会话，读到 MCP 工具发现、Codemode、配置来源及上下文成本。
---

<article class="page prose" markdown="1">

# Pi 与 MCP

接入一个工具服务，需要同时理解两条路径：Agent 怎样把模型输出交给工具执行，以及服务中的工具怎样进入模型可以使用的范围。这个专题先拆开 Pi 的运行时，再沿 MCP 的连接、发现和调用过程，把配置、结果与成本放回各自的位置。

## 从运行时进入

[Pi Coding Agent：核心循环、会话与扩展机制](/posts/pi-agent-runtime/)沿一次配置修改，解释模型提供方、Agent loop、AgentSession 与 SessionManager 的分工。适合判断哪些能力由核心提供，哪些需要扩展，以及切换会话分支会改变什么。

## 再看工具如何接入

[Pi MCP：工具发现、Codemode 与调用链路](/posts/pi-mcp-tool-exposure/)比较 direct、deferred、codemode 与 hidden，追踪配置、连接、工具调用和结果检查。适合已有 MCP 服务、需要安排工具发现入口或组合多次调用的读者。

两篇 Pi 专文以 v1.3.0 正式版本为基线，核验日期为 2026 年 10 月 20 日；上游内置实现与社区扩展分别说明。

## 把采用判断补完整

- [Agent 配置供应链：指令、Skills、Hooks 与 MCP 的安装边界](/posts/agent-configuration-supply-chain/)讨论配置来源、版本和执行权限。新增 Pi 例子帮助区分项目配置被信任、工具被展示与操作被允许。
- [Agent 上下文压缩：缓存、重试与任务总成本](/posts/agent-compression-total-cost/)讨论输出过滤与整次任务计费。新增工具发现的比较，区分减少工具定义进入上下文与压缩已经产生的工具结果。

工具更容易被发现之后，仍要核对实际调用是否符合权限、结果是否成功，以及完整任务的费用与质量。专题中的几篇文章分别提供这些判断需要的对象与观察依据。

[返回全部主题](/topics/)

</article>
