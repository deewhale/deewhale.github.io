---
layout: default
title: Pi：Harness、Durable 与 MCP
permalink: /topics/pi-mcp/
description: 以 Pi 1.0 为起点，深入理解编码 harness、Pi Durable 的持久执行，以及原生 MCP 与 Code Mode 的工具编排。
---

<article class="page prose" markdown="1">

# Pi：Harness、Durable 与 MCP

2026 年 10 月 1 日发布的 Pi 1.0，把原生 MCP、Code Mode、延迟工具加载和对话中的系统消息变化放进了稳定的编码 Agent。同日发布的 Pi Durable 则继续探索另一类需求：任务持续运行、进程中断后恢复，以及多个界面共同观察和引导会话。Durable 仍是实验包，两条产品路径需要分别理解。

这个专题围绕三个工程问题展开：模型之外的 harness 怎样组织上下文与执行；进程死后，哪些工作能够继续；工具越来越多时，怎样安排发现、编排和结果回流。

## Harness 与持久执行

[Pi Harness 与 Pi Durable：会话控制、持久执行与恢复设计](/posts/pi-agent-runtime/)从编码 Agent 的状态与控制权进入，追踪会话、工具、扩展和上下文装配，再深入 Durable 的持久任务、提交、重放与副作用处理。

阅读时可以带着一个具体判断：工具已经完成外部写入、却没来得及保存返回值，重启以后应该重跑、报告中断，还是先查询实际状态？正文通过真正杀死进程后的恢复对照，解释默认策略、可重放声明和业务幂等分别改变什么。

## Pi 1.0、原生 MCP 与 Code Mode

[Pi 1.0：原生 MCP 与 Code Mode 的工具编排设计](/posts/pi-mcp-tool-exposure/)从官方改变 MCP 接入方式的原因展开，比较直接工具调用、延迟发现和脚本编排。同一个任务经过三条路径后，工具定义、中间数据和决策分别留在哪里，才是判断采用方式的依据。

Code Mode 在 harness 一侧协调工具；工具本身仍通过各自的执行环境访问文件、进程或外部服务。正文中的固定版本示例用于检查真实发现和调用链，并把脚本成功、工具成功与结果可信分开观察。

两篇文章以 1.0 公告解释设计动机，以 v1.3.0 固定实现核查后续行为，资料核查截至 2026 年 10 月 20 日。示意过程与实测结果分别标明。

## 继续检查采用条件

- [长运行 Coding Agent：中断接管与完成证明](/posts/long-running-agent-harness/)提供长任务设计的整体视角，可与 Pi 的具体实现互相对照。
- [Agent 配置供应链：指令、Skills、Hooks 与 MCP 的安装边界](/posts/agent-configuration-supply-chain/)解释配置来源、加载代码和执行权限之间的关系。
- [Agent 上下文压缩：缓存、重试与任务总成本](/posts/agent-compression-total-cost/)帮助检查延迟工具发现、脚本过滤与压缩各自减少了什么，以及怎样回到整次任务的质量和费用。

[返回全部主题](/topics/)

</article>
