---
layout: post
title: "Palantir Ontology：一笔缺料订单的受控改期链路"
date: 2026-09-14
description: "从一笔缺料订单的改期开工日出发，解释 Palantir Ontology 怎样把候选、授权、写回、确认和对账接成同一条运营链路。"
image: /assets/images/posts/palantir-ontology-operational-layer.jpg
image_alt: "一名工业现场人员手持平板巡视厂房"
last_modified_at: 2026-10-10 12:00:00 +0800
categories: [技术, 架构]
tags: [Palantir, Ontology, Enterprise Architecture]
---

![一名工业现场人员手持平板巡视厂房](/assets/images/posts/palantir-ontology-operational-layer.jpg)

*摄影：Sergey Sergeev / Pexels；裁切。画面为运营现场示意，并非 Palantir 客户案例。*

生产订单 `PO-DEMO-042` 缺料了。ERP 里的计划开工日是下周一；MES 显示前序工序还没结束；库存台账给出的可用量不足；供应商承诺的到货日又晚了两天。现在真正棘手的问题不是谁发现了红灯，而是：谁有权把开工日改掉？改完以后，又凭什么说这笔订单已经改期成功？

下面的订单、字段、候选编号和伪配置都由我为讨论设计，既不是客户项目，也不是 Palantir 的行业模板。案例假定 ERP 对计划日期保有最终权威；Palantir Ontology 负责把跨系统的业务对象、关系、判断和受控动作接到一起。这个区分很重要：运营层可以提出并提交改期，ERP 的回执和后续读取才回答日期是否真的落地。

```text
ERP / MES / 库存 / 供应商承诺
             │
             ▼
     订单、物料、风险对象 ──→ 改期候选
             │                    │
             └──── 查询与规则 ────┘
                                  ▼
                        RescheduleOrder
                                  │
                              ERP 写入
                                  │
                       回执、重新摄取、对账
```

Palantir 把这类由对象、逻辑、动作和安全组成的业务访问层称为 Ontology。对读者最有用的理解方式不是背 Object、Link、Function 的名词表，而是跟着一次改期看四件事：对象是否指向同一笔订单；候选依据哪批观测；动作是否获准越过生产边界；ERP 结果何时被重新看见。

## 先把“同一笔订单”做成可审查的工件

四套系统有各自的主键和更新节奏。若两个工厂都使用 `042`，或 MES 的工单粒度比 ERP 的生产订单细，后续再漂亮的推理都会落到错误对象上。Object type、属性和 Link 是 Palantir 用来表达这层公共身份与关系的基本构件：数据源列可以映射为对象属性和主键，Link 让订单、物料、供应商和风险的关联能被应用复用。

我会先要求团队交付这样一张小表，而不是先画全企业知识图谱：

| 本例对象 | 稳定身份 | 决策使用的字段 | 发生冲突时的处理 |
|---|---|---|---|
| `ProductionOrder` | `plant_id + order_id` | 计划日期、ERP 版本 | 版本不明，停止提交改期 |
| `Material` | `plant_id + material_id` | 可用量、预留量、批次 | 标为异常，转库存负责人 |
| `SupplierCommitment` | 承诺单号 + 物料 | 到货日、有效期 | 两份有效承诺并存，转采购 |
| `SupplyRisk` | 输入快照 + 订单 | 缺口、计算规则版本 | 新快照到达后重算 |

表里的来源、owner、版本和冲突规则是我的建模建议；平台并不替团队替这些字段裁决真伪。第一项作者判断也在这里：如果只能先做一件事，我会先做身份和冲突工件，而不是先搭 Agent 或排程界面。改错订单的自动化只会更快地产生业务事故。

对象及其 Link 进入 Ontology 后，可以被查询为 Object Set。官方公开的后端说明把对象定义、对象索引、Object Set 查询、Action 等职责分开；具体查询会随数据规模和表达式选择存储下推、内存或 Spark 等路径。对本例而言，这意味着规则应先按订单、工厂和有效期收窄输入，再去找关联物料与承诺。把全厂订单一次性取回再计算，既放大成本，也难以解释候选用了哪一批证据。

## 风险计算与候选隔离

查询得到 `PO-DEMO-042` 的风险集合后，Function 可以读取对象和关系，产生两个改期方案：保守方案把开工日移到确认到货日之后；另一方案需要拆分订单并改变后续排程。这里最有价值的纪律是把它们保存为候选，而不让计算结果直接写进 ERP。

候选至少应携带订单身份、当前 ERP 版本、输入快照、建议日期、理由和规则版本。这样采购更新承诺或计划员修改日期后，旧候选可以失效并重算；审查者也能判断这次建议是在什么条件下产生的。Palantir 的 Function 本身能够参与对象编辑，但在这条路径里我把它限定在形成候选：生产动作集中到一个可以审查权限、参数和副作用的入口。

这也是第二项作者判断：我不赞成让“预测缺料”直接触发改期。即使模型对风险判断很准，改期仍会消耗产能窗口、采购承诺或客户交期；把建议和生产状态隔开，留下了处理例外和改变业务规则的空间。审批是否需要人，应由变更后果、自动检查覆盖度和可恢复性决定，不该被写成所有 Action 的固定步骤。

## `RescheduleOrder` 把生产写入缩成一个窄契约

Action type 是 Palantir 用来定义对象、属性和 Link 修改集合以及可选副作用的机制。它比一个“更新日期”接口多出了一层业务契约：哪些输入可接受，提交时检查什么，能改哪一个字段，外部请求往哪里去，谁可以使用它。下面的伪配置用来表达这一设计意图：

```yaml
action: RescheduleOrder
target: ProductionOrder
parameters:
  - candidate_id
  - expected_erp_version
  - proposed_start_date
  - reason
submission_criteria:
  - candidate.order_id == target.id
  - candidate.input_snapshot_is_current
  - proposed_start_date >= confirmed_arrival_date
edits:
  - target.planned_start_date = proposed_start_date
external_request:
  system: ERP
  idempotency_key: order_id + candidate_id + proposed_start_date
  precondition: expected_erp_version
evidence_to_keep:
  - action_submission_id
  - external_transaction_id
  - outcome_status
```

这份契约刻意只允许改 `planned_start_date`。ERP 也应使用它自己的版本条件处理请求；否则，候选形成之后别的计划员已经更新订单时，晚到的提交仍可能覆盖新值。平台中的 submission criteria、对象读取权限、编辑策略和外部服务凭据共同构成门禁。给操作者补一份底层数据集的 `Edit` 权限来让按钮可用，是我明确反对的做法：对 dataset-backed 对象，这可能同时扩大他可见的数据范围。先把动作改窄、把数据视图收窄，通常比事后追权限漏洞便宜得多。

## 写回顺序决定先在哪一侧面对失败

Action 可配置两种 webhook。官方文档明确：writeback webhook 在对象变更及其他规则之前执行；外部调用失败时，后续 Ontology 修改不会发生。side-effect webhook 则在对象修改后运行，用户可能已经看到成功提示；多个 side effect 也没有承诺的执行顺序。

| 选择 | 先发生的事 | 本例适合什么 | 留下的故障面 |
|---|---|---|---|
| writeback webhook | 请求 ERP，再进行 Ontology 变更 | ERP 接受改期是入口条件 | ERP 已成功，平台内变更仍可能失败 |
| side-effect webhook | 先变更 Ontology，再发送外部请求 | 通知或多个尽力而为的外部投递 | 页面成功，ERP 可能失败或尚无结果 |

对改期开工日，我会优先选择 writeback，而不会把 side effect 当成生产写入的凭证。它让 ERP 的明确拒绝在用户仍在提交现场时暴露出来；代价是仍要处理“ERP 已完成、平台后续失败”的裂缝。这里没有跨系统的一次性提交，也没有可依赖的自动整体回滚。

超时让这个裂缝变得具体：

```text
t0  操作者提交 candidate C-42，key = PO-042:C-42:2026-10-21
t1  集成服务把请求送达 ERP；ERP 接受并写入新日期
t2  返回给 Action 的响应超时
t3  页面显示失败，操作者准备再次点击
t4  第二次请求若换了 key，ERP 可能把同一业务意图执行两次
```

此刻不能从网络超时推断 ERP 的结果。恢复顺序应是：用稳定幂等键或订单业务键查询 ERP；若找到成功交易，记录交易号并等待回读；若 ERP 明确未受理，才带同一键重试；若仍查不清，将 `outcome_status` 标为 `unknown`，冻结再次提交，交给值守人员对账。幂等键需要由 ERP 或前置集成服务真正持久化，才会抑制重复副作用；只把它写在 Ontology 属性里没有这个效果。

补偿也需要说清楚。ERP 已改期、平台显示旧日期，先修摄取或索引；平台显示新日期、ERP 明确拒绝，按业务规则发起一笔纠正动作。补偿是一项新的业务操作，有独立授权、记录和结果确认，并不把已经发生的副作用倒回原处。订单若已被车间排程或采购消费，强行改回去很可能制造第二个问题。

## ERP 回读与完成判定

Action log 可配置为记录成功的 Action 提交；它不会替你保存失败提交、绕过 Action 的编辑或 ERP 的终态。因此我会为每次改期保留一条可对账的关联链：

```text
candidate_id
  → action_submission_id
  → external_transaction_id
  → outcome_status
  → ERP version / reindexed_at
```

ERP 数据更新后，经已配置的数据源重新索引，`ProductionOrder` 才会带着新的日期回到 Ontology。完成判定应同时满足两件事：ERP 的权威交易结果已确认，重新读取的订单日期与该交易版本相符。两者不一致时，工作项仍是“待对账”，可由它分别暴露 ERP 成功而摄取滞后、平台状态领先、或候选本身已过期这三种不同故障。

第三项作者判断是：比起把 Action 提交数做成漂亮仪表盘，我更愿意先把这条关联链做完整。前者衡量了入口吞吐，后者才让运营团队找到该找谁、该修哪一段、以及是否需要补偿。

## Ontology 与拆分式建设的适用条件

语义层、工作流引擎加内部工具、自建写回都能覆盖这条链的局部；区别不在于谁“更先进”，而在于业务契约由谁持有、被多少消费者复用、失败后的责任落在哪里。

| 路线 | 很适合的条件 | 团队自己仍要承担的部分 |
|---|---|---|
| 只读语义层或知识图谱 | 统一指标、关系检索、辅助人工判断 | 写入入口、外部结果确认、运营对账另建 |
| 工作流引擎 + 内部工具 + 自建写回 | 对象和动作很少，既有 API、授权、审计成熟 | 身份合同、动作权限、幂等、日志关联与补偿的长期维护 |
| Palantir Ontology | 多个应用、操作者或自动化消费者反复使用同一组对象和受控动作，并愿意共同治理 | 来源权威、冲突处理、外部事务、owner 与退出边界仍由组织负责 |

多数企业的第一站会是前两档：先证明一条窄闭环真的有人反复使用，再决定是否把它沉淀成统一的运营层。我会把试点限制在一个后果清楚、结果可观察、失败可处置的动作上，例如仅改期开工日；先只读地跑通身份、版本和冲突，再开放这个 Action。只有当同一套对象和动作被多组人反复拿来协作时，Ontology 的共享契约才值得支付建模和治理成本。

落地前，可以拿这四个问题逐项审查 `PO-DEMO-042`：订单身份是否稳定；ERP 的版本条件和幂等键谁维护；超时后的 `unknown` 由谁值守；回读不一致时谁有权发起补偿。四项都有可回答的 owner，改期链路才具备进入生产的条件。

## 官方资料

- Architecture center — Overview
- Platform overview
- Types reference
- Ontology backend architecture
- Object Set Service limitations
- Action types
- Webhooks
- Action log
- Permissions
