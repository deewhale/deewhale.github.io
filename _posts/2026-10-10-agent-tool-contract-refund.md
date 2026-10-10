---
layout: post
title: "Agent 退款工具契约的逐步改写"
description: "从一个只有 success 布尔值的退款工具开始，逐步补上身份绑定、授权、幂等、异步状态与结果查询。"
image: /assets/images/posts/agent-tool-contract-refund.jpg
image_alt: "支付终端、纸质票据与现金放在同一张桌面上"
date: 2026-10-10 13:00:00 +0800
categories: [AI, Engineering]
tags: [AI Agent, Tool Calling, MCP, API Design]
---

![支付终端、纸质票据与现金放在同一张桌面上](/assets/images/posts/agent-tool-contract-refund.jpg)

*摄影来源：Hook Tell / Pexels；图片 EXIF 标注 Emil Gallík；压缩处理。*

```text
refund(order_id, amount) -> { success: boolean }
```

这是一个很容易交给 Agent 的工具：名字直接，参数很少，返回值也不会让模型费解。假设客户说自己被重复扣款，Agent 调用它，拿到 `success: true`。客服界面现在能否显示“退款成功”？

不能。这个布尔值可能表示参数通过校验、本方服务收到了命令、支付渠道已经受理，也可能只表示 HTTP 请求没有报错。即使渠道返回了自己的成功状态，它是否代表商户账务已经对应、客户银行已经入账，仍取决于支付方式和业务对“完成”的定义。

工具契约首先要解决的不是模型会不会调用，而是调用之后，返回值能否让系统决定下一步合法动作。只要 `success: true` 同时容纳几个不同世界，Agent 就只能猜。

## `success: true` 藏住了哪些世界

先不谈 MCP 或 function calling，把退款结果拆开。

| 状态 | 已经建立的事实 | 允许的下一步 | 可以对客户说什么 |
|---|---|---|---|
| `rejected` | 某个明确主体拒绝了请求 | 根据原因修正、重新审批或转人工 | 退款未提交或未被受理 |
| `accepted` | 本方编排服务或支付渠道接下了请求 | 保存操作 ID，进入查询 | 退款申请已受理 |
| `pending` | 权威提供方仍在处理 | 等待并按操作 ID 查询 | 退款处理中 |
| `settled` | 满足事先定义的权威完成条件 | 记录完成，触发后续通知 | 只能在该条件覆盖的范围内说已退款 |
| `unknown` | 请求是否生效尚不能确定 | 先查询或转人工，不盲目重试 | 当前无法确认结果 |

`accepted` 必须写清是谁接受。写入本方队列、支付渠道受理和账务系统入账是三个不同事实。HTTP 202 的标准语义也是“已接受处理，但处理尚未完成”，并建议响应描述当前状态，同时提供或嵌入状态监视入口。把它翻译成“已完成”，不是用户体验优化，而是改写了协议事实。

这里的状态名是本文为假设系统设计的领域语言，不是 MCP 或 OpenAI 的标准字段。真实系统可以换名字，但不能丢掉差异。

## 第一次改写：拿走模型不该重填的身份

坏接口让模型同时填写 `order_id` 和 `amount`。可是在客服会话里，应用通常已经知道当前租户、客户、订单和支付记录。OpenAI 的 function calling 指南甚至直接用退款举例：应用已经知道订单 ID 时，应由代码绑定它，而不是让模型再填一遍。

这不只是少一次抄写错误。订单归属、可退余额、币种、当前支付状态和操作人权限，都有各自的权威来源。模型可以提出“这两笔看起来重复”，但不能把外观相似直接升级成资金操作。

先把第一个工具改成只做评估：

```text
evaluate_refund()
  -> refund_intent_id
  -> eligibility: eligible | ineligible | review_required
  -> amount_minor, currency
  -> observed_payment_version
  -> approval_required, reasons
```

这里没有 `order_id` 参数，是因为应用在工具实现中绑定了当前客户与支付上下文。金额使用最小货币单位，避免浮点和格式歧义。`observed_payment_version` 记录评估依据的业务版本；稍后提交时，服务端要重新检查这份判断是否已经过期。

输入 Schema 在这一步仍有价值：它可以禁止模型传入额外参数。这里的金额、币种和 `eligibility` 是服务端返回值，应另行定义结果 Schema，并由应用校验；OpenAI function calling 的 strict 不会自动保证这些返回值合规。无论输入还是输出形状正确，都不能证明这笔钱该退，也不能替代订单级授权。

## 第二次改写：让一次退款意图跨过多次传输

退款请求可能超时。调用方没有收到响应，不代表渠道没有执行；若 Agent 把同一参数再调一次，系统就面临重复退款。

模型调用的 `call_id` 只负责把一次调用和一次返回关联起来。它不是资金操作的业务身份。更稳妥的做法是让 `refund_intent_id` 表示“同一笔退款意图”，再由应用从它派生或绑定幂等键：

```text
submit_refund(refund_intent_id, approval_id)
  -> operation_id
  -> state: accepted | rejected | unknown
  -> reason_code
  -> next_action: query_status | correct_request | manual_review
```

提交前，服务端重新核对租户、原支付、可退余额、评估版本和审批范围。`approval_id` 不是装饰字段；它必须能证明批准的对象与金额覆盖当前意图。幂等键也不应该由模型在每次重试时自由发明，否则相同意图会得到不同身份。

MCP 的 `idempotentHint` 可以提示客户端“相同参数重复调用预期不会增加影响”，但官方规范把 Tool Annotations 定义为提示，并要求对不可信服务器的声明保持警惕。这个布尔值不会替后端持久化去重记录，也不会定义键的保留时间。真正的保证来自工具实现和支付提供方的契约。

操作记录还要在发起外部退款前持久化，并与 `refund_intent_id` 唯一绑定。这样，即使提交响应整个丢失，应用也能凭已保存的意图找回 `operation_id`。若连这条映射也无法恢复，状态就必须保持 `unknown` 并转人工，不能假装已有可查询的操作。

因此，超时后的正确结果不是伪造 `failed`，而是 `unknown`。它把调用方导向查询或人工处置，避免把网络不确定性误写成业务失败，再以“重试失败任务”为名制造第二笔退款。

## 第三次改写：为写调用补上可查询的终点

只提供 `submit_refund`，Agent 迟早会把“工具调用结束”当成“退款结束”。完整契约还需要一个读取权威状态的工具：

```text
get_refund_status(operation_id)
  -> state: pending | settled | failed | unknown
  -> observed_at
  -> provider_reference
  -> settlement_evidence
```

`operation_id` 必须能跨会话查询同一项业务操作。`observed_at` 让调用方知道这份状态有多新。`provider_reference` 用来和外部记录对应。`settlement_evidence` 不必把敏感原始响应全部交给模型，但应让确定性代码验证完成条件。

MCP 的工具结果可以结构正确、`isError` 为假，JSON-RPC 也可以成功返回；这些只说明这次工具交互没有以协议或执行错误结束。把它推导成外部资金已经结算，跨越了规范没有提供的边界。

支付提供方的真实状态也未必只有成功和失败。以 Stripe 当前文档为例，退款对象可以处于 `pending`、`requires_action`、`succeeded`、`failed` 或 `canceled`，并提供后续查询接口。这只能说明某个具体提供方存在异步状态，不能把 Stripe 的字段原样推广给所有渠道。应用仍要定义：提供方 `succeeded` 是否已经足够称为本文的 `settled`，还是还要等商户账务对应；更不能默认它等于客户在所有银行渠道中已经看到资金。

## 用反例验收最终版本

函数调用评测早已不只检查 JSON 能否解析。BFCL 的正式论文覆盖串行、并行、拒绝调用与有状态多步任务，其中 V3 多轮评测会检查环境状态和必要调用路径。但一个通用基准不会替具体业务定义授权、幂等和资金终态。

退款工具自己的评测至少要让这些反例真的发生：客户属于另一个租户；可退余额在评估后发生变化；审批只覆盖部分金额；提交已生效但响应丢失；同一意图换了新的调用 ID；权限在提交前被撤销；提供方长时间停留在处理中。检查对象不只是 Agent 说了什么、调用路径看起来是否合理，还包括环境里是否只出现一笔合法退款，以及越权和不确定状态是否被挡住。

Anthropic 的 Agent 评测方法把 transcript 与 outcome 分开：前者是交互轨迹，后者是试验结束后的环境状态。放到这里，模型回答“已经为您退款”只是 transcript；权威系统存在一笔金额正确、授权有效、没有重复的终态记录，才是 outcome。二者不能互相代替。

最终接口没有消灭退款系统的复杂性。它只是拒绝把复杂性藏在一个成功布尔值里。若系统只能稳定识别原支付和可退余额，就只开放 `evaluate_refund`；若能保存意图、重验授权并执行真实去重，可以再开放 `submit_refund`。只有收到明确的 `accepted`，才能报告对应主体“已受理”；`rejected` 与 `unknown` 必须分别报告拒绝与尚无法确认。只有当 `get_refund_status` 能读到事先定义的权威终态，Agent 才能在那个明确边界内报告“退款完成”。

如果一次退款不能跨重试保持同一个业务身份，或者系统无法说清什么证据代表完成，那么它提供的就只是“提交退款请求”工具。接口名称、描述和返回值都应诚实地停在那里。

## 资料

- OpenAI Function calling
- Model Context Protocol — Tools
- Tool Annotations as Risk Vocabulary: What Hints Can and Can't Do
- RFC 9110: HTTP Semantics
- Stripe Refunds API 与 Idempotent requests
- Writing effective tools for agents — with agents
- Demystifying evals for AI agents
- The Berkeley Function-Calling Leaderboard
