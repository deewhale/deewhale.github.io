---
layout: post
title: "Palantir Ontology 真正值得学的，不是知识图谱"
description: "Ontology 的价值不在于画出更多实体关系，而在于把业务对象、允许的动作、执行逻辑和权限边界变成一份可运行的契约。"
tags: [Palantir, 数据架构, Ontology]
---

很多数据平台并不缺数据，也不缺报表。真正断掉的是报表之后的半程：分析师看见异常，把结果导出到 Excel，发给业务人员；业务人员再登录另一个系统，判断该改价格、催订单，还是给客户补偿。

数据平台负责解释世界，操作系统负责改变世界。Palantir Ontology 想接上的，正是中间这段断路。

把它叫作知识图谱并不算错，却会漏掉最关键的部分。图谱擅长表达“客户 A 关联订单 B”；运营系统还必须回答“谁能把订单 B 标记为优先、触发后会改哪些数据、什么条件下需要审批、结果怎样回到原系统”。关系只是名词之间的连接，业务要继续运转，还需要动词。

## 从数据模型变成业务契约

Palantir 的[官方架构文档](https://www.palantir.com/docs/foundry/object-backend/overview)把 Ontology 定义为组织的 operational layer。它位于数据集和模型之上，把这些数字资产连接到工厂、设备、订单、交易等真实对象；其中既有 object、property、link 这样的语义元素，也有 action、function 和动态安全策略这样的“运动”元素。

传统数仓中的订单通常是一张事实表。表结构告诉你有哪些字段，却不负责说明订单允许发生什么。Ontology 中的 Order 则更接近一个受治理的业务契约：它有哪些属性，与 Customer、Shipment 如何关联，能执行哪些动作，动作由谁提交，又会产生什么副作用。

[Palantir 的类型定义](https://www.palantir.com/docs/foundry/object-link-types/type-reference)把这几类资源分得很清楚：

- Object type 定义现实中的实体或事件，例如机场、订单或一次金融交易；
- Link type 定义两类对象之间的关系；
- Action type 定义一次可以整体提交的对象、属性和关系变更，也可以附带其他副作用。

区别不在“表”换成了“对象”这么简单，而在读模型旁边出现了一组受控的写操作。业务应用不必拿到某张底表的宽泛写权限，只需要调用已经定义好的动作，例如 `prioritizeOrder`。动作的参数、校验、影响范围和权限可以被检查，执行结果也能留下记录。

这与常见的指标语义层不是同一件事。指标层解决“收入到底怎么算”；运营层还要解决“这个人现在能对哪个对象做什么”。

## 概念怎样落到系统里

Ontology 如果只是一张概念图，无法扛住真实业务的查询和写回。Palantir 公布的[后端架构](https://www.palantir.com/docs/foundry/object-backend/overview)里，几组服务承担了不同责任：OMS 保存 object type、link type、action type 等元数据定义；对象数据库存储和索引实例数据；OSS 负责对象查询、搜索与聚合；Object Data Funnel 处理进入对象存储的数据；Actions 与对象函数负责受控变更和逻辑。

这套拆分透露了一个可复用的设计原则：**语义定义、实例数据、查询服务和写入路径必须有清楚边界。**

假设业务要找出“华北地区、金额超过十万元、最近一单延迟超过三天的客户”。数仓可以通过多表关联得到名单。运营层还会把结果保留为一组 Customer/Order/Shipment 对象，让应用继续展示上下文，并允许有权限的人发起催单或补偿动作。动作可能回写 Ontology，也可能通过函数或外部连接触发原业务系统。[官方平台说明](https://www.palantir.com/docs/foundry/platform-overview)将 Action 称为表示这些业务“动词”的原子单位。

这里没有消灭 ETL，也没有绕开源系统。对象能否及时反映业务，仍然取决于数据接入、索引和同步；动作能否闭环，也取决于外部系统是否提供可靠写回接口。Ontology 只是把这些能力组织成统一契约，不会凭空修复陈旧数据和混乱流程。

## AI 不是多了一层聊天框

企业 RAG 通常停在只读路径：找到文档或数据，生成一段回答。把模型接到 Ontology 之后，Agent 可以看到业务对象，也可以使用被授权的 Action。它因此有机会从“解释异常”走到“提出处理方案”。

但这不等于让模型直接修改生产系统。Palantir 描述的常见模式是，Agent 先生成 proposal，操作员再修改、反馈或作出决定。对供应链这类强耦合系统，还可以用 Scenario 在 Ontology 的分支上模拟改变，观察可能的连锁影响，再决定是否执行。Proposal、Scenario 和 Global Branching 有联系，却不是同一个功能。

尤其不能把所有 AI 建议都描述成一次 Git 式 branch/merge。[Ontology Branching 文档](https://www.palantir.com/docs/foundry/ontologies/branching-ontology)主要处理的是 object type、link type、action type 等资源本身的隔离修改：分支需要 rebase、解决冲突、通过检查和评审，之后才合入 main。它治理的是模型和资源变更。普通业务 Action 则是运行期对对象数据发起受控修改。

这个区分很重要。架构设计中至少存在三种不同风险：

1. 改了业务语义模型，可能让下游应用整体失效；
2. 模拟一个决策，需要隔离潜在连锁影响；
3. 执行一次真实动作，需要校验操作者、对象和写回权限。

用一个“分支”比喻概括三者很省事，也容易把治理边界讲错。

## 权限不是一句“继承用户权限”

Action 的吸引力在于它把写操作收窄了，复杂性也随之集中到权限配置。Palantir 的 [Action 权限文档](https://www.palantir.com/docs/foundry/action-types/permissions/)明确提醒：如果对象既允许 Action 修改，又开放表单、API 等直接编辑，执行者可能需要底层 writeback dataset 的 Edit 权限；这个权限可能让用户看到超出操作所需的数据。官方因此建议新对象默认只通过 Actions 编辑。

这说明 Ontology 的安全并不是“接上以后自动正确”。团队仍要逐个回答：谁能看见对象，谁能调用动作，动作能读什么、写什么，副作用以谁的身份执行，失败后如何追溯。把这些问题显式化是价值，维护这些答案则是成本。

## 真正能借鉴的，是一个小闭环

大多数团队没有必要造一个 Palantir。更现实的起点，是选择一个高频、跨系统、今天仍靠 Excel 和聊天推动的决策，把它完整走一遍：

- 定义少量核心业务对象和稳定标识；
- 把真正影响决策的关系和属性接进来；
- 只设计一两个边界明确的 Action；
- 让 AI 提建议，但把审批、权限和审计放在动作入口；
- 记录执行结果，验证建议到底改善了什么。

如果这个闭环跑不通，增加更多对象类型只会得到一张昂贵的企业关系图。如果它跑通了，Ontology 才开始成为运营层：数据不只是被看见，决策也能在同一套语义和权限约束下留下结果。

Palantir 最难复制的从来不是 OMS 或 OSS 的服务名字，而是持续维护业务契约的组织能力。对象归谁定义，动作由谁批准，口径变化谁负责下游，错误决策怎样撤回——这些问题没有现成软件答案。也正因为如此，Ontology 是否有用，最后不取决于图画得多完整，而取决于组织愿不愿意把“如何行动”也当作数据平台的一部分。

延伸阅读：[《Palantir 核心技术架构深度研究》原始研究笔记](https://github.com/atlas555/atlas555.github.io/blob/source/content/cn/2026-04-07-palantir-core-architecture.md)。
