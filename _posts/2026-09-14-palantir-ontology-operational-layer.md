---
layout: post
title: "Palantir Ontology 核心架构研究"
description: "从整体架构、Ontology Language 与 Engine 出发，拆解 Palantir 的对象查询、Action 写回、AIP 工具面、权限和版本治理。"
tags: [Palantir, 数据架构, Ontology]
---

Palantir 对 Ontology 的定义比常见“语义层”更宽：它是建立在组织数字资产之上的 operational layer，把数据、逻辑、动作和安全策略放进同一套业务表示中。[Architecture Center 的概览](https://www.palantir.com/docs/foundry/architecture-center/overview)用供应链说明这套思路——订单、产线是业务名词，更新采购单、调整分销策略则是作用于这些名词的动词。

因此，理解 Palantir Ontology 不能只看 object 和 link。对象如何被索引和查询，候选决策怎样成为受控 Action，外部系统的结果如何返回，Agent 能调用哪些业务工具，都属于这套架构的一部分。它的吸引力与成本来自同一件事：语义模型被推进了生产运行时。

## 1. Ontology 在 Palantir 中的位置

许多数据系统已经有业务语义。数仓会定义事实、维度和指标，知识图谱会定义实体与关系，应用服务也会暴露订单、客户之类的领域对象。Ontology 的位置更靠近业务执行：除了告诉应用“这里有什么”，它还描述“允许对它做什么”，并把权限、逻辑和动作挂到同一个对象空间。

这并不要求 Ontology 取代 ERP、MES 或 CRM。Palantir 把它放在既有数字资产之上，源系统仍可掌握某项状态的最终权威。例如订单的计划日期由 ERP 确认，现场开工状态由 MES 负责，预测风险来自模型输出；Ontology 负责把这些状态组织成稳定的对象接口，并为应用和操作者提供共享的关系与动作。

一旦动作进入模型，Ontology 的维护方式就要接近业务 API。改一个属性类型，可能影响查询和应用；改一个 Action 的提交条件，可能改变生产流程；扩大一个权限范围，可能让原本局部的数据进入更广的输出。它已不再是只供检索的元数据目录。

从架构职责看，这是一种横跨数据面和应用面的契约。向下，它要容纳来自不同系统、不同更新频率的数据；向上，它要让分析页面、运营应用、自动化流程和 Agent 看到相同的对象身份与业务能力。对象模型一旦稳定，下游不需要知道订单究竟来自哪张表；Action 一旦稳定，上游模型也不需要知道 ERP 的通用写入协议。中间层吸收了两侧变化，同时承担接口兼容和运行治理。

这种位置解释了 Palantir 为什么把安全也纳入 Ontology。权限并非最后套在页面上的角色判断：对象能否读取、Function 能处理什么、Action 可以写出什么，都会改变一次业务操作的含义。语义、逻辑、动作和安全共享资源标识，才可能让同一个能力在不同应用间复用。

## 2. 从平台到运行时：一张整体架构图

[Palantir 的平台架构](https://www.palantir.com/docs/foundry/architecture-center/platforms)把职责分给 Foundry、AIP 和 Apollo。Foundry 承载数据管理、逻辑、Ontology 和业务工作流；AIP 提供模型接入、Agent、自动化及评估；Apollo 负责这些平台服务在不同环境中的持续交付和运行。

在 Foundry 内部，可以再从三个观察面理解 Ontology：Language 定义业务类型和能力，Engine 让定义变成可查询、可修改的运行状态，tooling surface 则把这些能力交给开发工具、应用、API/SDK 和 AIP Agent。

    业务使用面
    应用 / 工作流 / API 与 SDK / AIP Agent 与自动化
                             │
                  Ontology tooling surface
                             │
    ┌────────────────────────────────────────────┐
    │ Ontology Language                         │
    │ object · property · link · interface       │
    │ function · action · security               │
    ├────────────────────────────────────────────┤
    │ Ontology Engine                           │
    │ OMS · object database · OSS · Actions      │
    │ Object Data Funnel · Functions             │
    └────────────────────────────────────────────┘
                             │
    Foundry 数据资产 / 流数据 / 模型输出 / 外部业务系统

    Apollo：承载 Foundry 与 AIP 服务的部署和持续交付

这张图不是 Palantir 未公开内部拓扑的复原，而是按官方公开职责整理的阅读框架。Language、Engine 和工具面之间的连接，才是 Ontology 区别于普通概念模型的地方：同一份业务定义会被查询服务、应用、Action 和 Agent 共同使用。

读请求和写请求穿过这张图的方式不同。读请求从工具面进入 OSS，按 OMS 中的类型定义查询 object database，并把 Object Set 返回给应用或 Function。写请求从 Action 进入，先检查参数、条件和权限，再修改 Ontology 状态或调用外部系统。源数据和用户编辑随后经 Funnel 更新对象索引。两条路径最终汇合在同一对象空间，但各自有独立的执行和失败语义。

工具面还有一项容易被架构图忽略的工作：把模型变更交给开发流程。Object、link、Function 与 Action 不只是运行时资源，也需要创建、测试、评审和发布。后面的 Global Branching 处理资源版本，Scenario 处理运行数据的假设变化；二者都位于工具面，却不能替代运行时 Action。

## 3. Ontology Language：把名词、关系和动词写进模型

Ontology Language 的基础构件并不神秘。[类型参考](https://www.palantir.com/docs/foundry/object-link-types/type-reference)从 object type、property、link type 和 action type 开始；Interface 为多个 object types 提供共同的属性、关系或动作能力。

| 构件 | 表达的内容 | 示例 |
|---|---|---|
| Object type | 一类业务实体或事件 | ProductionOrder、Material、SupplyRisk |
| Property | 对象的业务状态 | 计划日期、库存、风险分数 |
| Link type | 对象之间可复用的关系 | 风险影响订单、订单消耗物料 |
| Interface | 跨类型共享的形状或能力 | Schedulable |
| Action type | 可提交的业务动作 | RescheduleOrder |

Object type 定义 schema，object instance 才是某个具体实例。[创建 object type](https://www.palantir.com/docs/foundry/object-link-types/create-object-type/index.html)时，数据源列映射为 properties，其中一列成为唯一 primary key。主键让不同应用可以稳定引用同一个对象；跨系统标识怎样对齐，仍由实际数据设计决定。

假设 ERP 和 MES 都包含生产订单，Ontology 中的 ProductionOrder 不宜简单复制任一张表。团队需要先确定对象身份，再为每个关键属性指定来源：plannedDate 取 ERP，现场状态取 MES，风险分数来自某个带版本的模型输出。Ontology 可以统一访问这些属性，源系统的状态权威仍要保留。否则，一个整洁的 object type 只会把冲突藏到统一名称后面。

[Link type 的映射](https://www.palantir.com/docs/foundry/object-link-types/create-link-type)把关系也变成公共接口。一对多关系可以由一侧 foreign key 指向另一侧 primary key，多对多关系可以使用包含双方主键的数据源。应用从 SupplyRisk 沿 link 找到 ProductionOrder，再找到物料和供应商，不必各自维护字段拼接规则。

Interface 处理跨类型复用。比如生产订单和维护窗口都可以实现 Schedulable，各自把本地字段映射到共同的开始时间、结束时间和排程能力。[Interface 文档](https://www.palantir.com/docs/foundry/interfaces/create-interface)允许声明必填属性，以及 link 和 action capability constraints。它把公共能力放在类型系统中，具体 object type 再映射到自己的字段、关系和 Action。

Action type 让“动词”与对象定义相连。它可以接收参数，检查 submission criteria，修改对象、属性或 link，并触发提交时的副作用。至于谁能提交、怎样写回外部系统，属于运行时机制；在 Language 层，重要的是业务动作已经有了稳定名称和输入边界。

把这几个构件放进一份最小订单模型，可以看到它们如何配合。ProductionOrder 以订单号为身份，具有计划日期、优先级和工厂属性；它通过 consumes 关系连接 Material。Material 再通过 suppliedBy 连接 Supplier。模型每次运行生成一个 SupplyRisk，记录预测窗口、模型版本和风险分数，并通过 affects 指向订单。RescheduleOrder 只接受订单、新日期和原因，不暴露任意属性更新。

这样的模型给不同消费者一份共同约定。风险页面查询 SupplyRisk，排程组件通过 Schedulable 接受不同类型，Function 沿 link 读取约束，Action 用业务动词提交修改。公共契约减少了每个应用自行解释字段的工作，也要求修改者考虑全部消费者。更换 primary key、改变 link 基数或收紧 Action 参数，都应当被当作接口变更，而非普通的数据列调整。

## 4. Ontology Engine：OMS、Funnel、object database 与 OSS

Language 里的定义需要被实例化。[Ontology 后端架构](https://www.palantir.com/docs/foundry/object-backend/overview)公开了几组核心服务：

- Ontology Metadata Service（OMS）保存 object、link、action 等 Ontology resources 的元数据；
- Object Data Funnel 读取 dataset、Restricted View、流数据源和 Action 产生的用户编辑，编排对象索引更新；
- object database 保存索引后的对象数据并支持查询计算；
- Object Set Service（OSS）执行搜索、过滤、聚合、对象加载和沿关系的 Search Around；
- Actions service 负责应用结构化编辑，Function 则在对象和关系上运行逻辑。

元数据和实例数据由此分开。OMS 回答系统定义了哪些类型与能力，Funnel 和 object database 维护可供查询的对象状态，OSS 把对象查询交给应用。Palantir 将 Object Storage v2 称为当前 Ontology 的 canonical data store，并说明新架构把索引与查询子系统解耦。公开资料足以确认这些职责，存储引擎、复制和事务协议并未披露。

Object Set 是读取侧的关键抽象。它可以保存一组固定主键，也可以保存随数据变化而重新计算的动态定义。运营应用能够筛出仍处于 Open 的 SupplyRisk，再通过 Search Around 取得相关订单、物料和供应商；Function 随后读取这组对象，计算改排或加急的候选方案。

固定集合适合表达一次已经选中的对象范围，动态定义适合持续变化的运营队列。比如“今天交给某位计划员处理的十张订单”需要保存具体对象 ID，“所有未来三天高风险且尚未处置的订单”则可以持续重算。二者都通过 Object Set 交给下游，但在审计和复现中的含义不同。实际系统往往同时保存查询定义、当时输入版本和最终选中的对象 ID。

从数据进入到查询返回，Engine 还承担新鲜度交接。Funnel 根据数据源更新索引，OSS 读取的是索引后的对象状态；ERP 刚刚发生的变化，要等对应数据链更新后才会反映到 Object Set。应用若用对象状态决定是否提交高风险动作，就需要知道数据更新边界，并在 Action 的提交条件中重新检查关键状态。

> 实现注记：Object Set 提供稳定的语义接口，不代表查询只有一种物理路径。[OSS 限制文档](https://www.palantir.com/docs/foundry/ontologies/oss-limitations)显示，查询可以在存储下推、内存和 Spark 之间切换；截至 2026-09-15，部分 Search Around、derived property 和 SDK 加载存在以 10 万对象为量级的默认切换或加载边界。数字会随功能和配置变化，架构结论只有一条：高频关系与派生计算必须按实际访问路径评审，必要时提前过滤、分页或有限反规范化。

## 5. 一条 Action 怎样完成读取、写入和反馈

用缺料处置做一个架构样例：ERP 提供订单和物料，MES 提供排产状态，供应商回传交期，模型生成 SupplyRisk。Ontology 中的 ProductionOrder 连接 Material，物料连接供应商，风险对象连接受影响订单。

这条链的入口不是告警本身，而是一个可以被继续处理的业务集合。风险分数只有和订单优先级、现有库存、在途批次、替代料以及供应商承诺放在一起，才构成一次改排判断的输入。Ontology 在这里提供共享对象与关系，算法仍由规则、优化模型、Function 或人来完成。

### 从 Object Set 到候选方案

Funnel 根据这些来源更新对象索引，OSS 查询风险集合并沿 link 补齐上下文。一个 Function 读取订单优先级、库存、替代料与供应商产能，产生“改排订单”“使用替代料”或“请求加急”等候选。候选应保存输入版本和影响范围，因为计算结束以后，库存或交期仍可能变化。

应用可以把风险 Object Set 交给多个处理环节：一个 Function 估算延期代价，另一个校验替代料约束，计划员再比较方案。共享对象 ID 让这些结果能够回到同一订单，而不是靠文本描述重新匹配。Function 也可以生成复杂编辑；这个例子把计算与生产写入分开，是为了让候选方案先保留可审查的边界。

假设操作者选择改排订单，业务动作可以收敛成下面这份契约轮廓：

    RescheduleOrder
    parameters: orderId, proposedDate, reason, candidateId
    submission criteria: 订单可改排，候选仍有效，日期与原因合法
    edits: 记录所选方案和执行状态
    external effect: 将计划日期提交给 ERP

[Action type](https://www.palantir.com/docs/foundry/action-types/overview)提供参数、提交条件、对象编辑和副作用这些构件。上面的字段只是示例，不是平台配置语法。Submission criteria 在提交时重新检查会使候选失效的业务条件，避免几分钟前算出的方案被直接当作当前事实。

Action 的参数表达业务意图，edit rules 表达平台内状态变化，external effect 负责跨到 ERP。三者分开后，应用不需要拿到一个“任意修改订单”的入口。它只能提交已声明的新日期、原因和候选标识；订单已经开工、计划窗口关闭或候选版本过期时，submission criteria 可以拒绝本次提交。

### 写回顺序决定失败形态

ERP 若继续掌握计划日期的最终状态，Action 可以通过 webhook 写回。[Webhook 文档](https://www.palantir.com/docs/foundry/action-types/webhooks)区分两种顺序：

    writeback:   Action → ERP → Ontology changes
    side effect: Action → Ontology changes → 返回成功 ──► ERP

Writeback webhook 先于其他规则执行。外部请求失败会阻止后续 Ontology 修改，外部成功以后，内部修改仍可能失败。Side-effect webhook 在对象修改以后运行，多个 side effect 也没有顺序保证。前者留下“ERP 已改、Ontology 未改”的窗口，后者可能留下“Ontology 已改、ERP 未改”的窗口。

两种方式适合不同的业务后果。ERP 必须先确认计划日期时，writeback 的顺序更贴近权威系统；发送通知、触发非关键下游任务时，side effect 可以让主编辑先完成。选择的依据是失败以后哪一侧状态可以暂时领先，以及操作者在页面上看到“成功”时，系统究竟已经证明了什么。

跨系统原子性是 Action 机制中最影响设计的边界。请求需要稳定幂等键；响应未知时先查询 ERP，再决定是否重试；候选 ID、Action submission 和外部 transaction 需要能够对账。补偿动作应由业务规则显式定义，不能假定平台会自动把两个系统一起回滚。

执行状态最好与这些证据对应。Submitted 表示平台已经接受请求，external-confirmed 表示 ERP 已确认，reconciled 表示对象状态已经和源系统对齐，failed 则要记录失败发生在哪个边界。具体状态名称可以变化，关键是“按钮返回成功”不能提前取代外部业务事实。

### 反馈回到同一对象空间

ERP 的新状态经数据链重新进入 Ontology，Funnel 更新对象索引，应用把执行结果与风险、候选和动作关联。此时才能判断改排是否发生，以及短缺是否解除。读取、计算、动作和结果共用同一组业务 ID，构成了完整的运营链。

反馈还使模型评估从离线准确率进入业务结果。系统可以比较候选是否被采纳、Action 是否完成、订单是否按新计划执行，以及风险是否转移到其他订单。若这些记录没有共同 ID，评估只能看到模型输出或按钮点击，无法判断一次决定造成了什么后果。

[Action log](https://www.palantir.com/docs/foundry/action-types/action-log)是可选配置，只为成功提交生成相应日志对象。它可以记录操作者和提交上下文，不能覆盖失败提交、绕过 Action 的编辑或 ERP 的最终业务结果。反馈需要重新摄取的源状态和单独的结果关联。

## 6. AIP：把 Ontology 作为 Agent 的工具面

AIP 接入以后，Ontology 提供的不只是检索上下文。Agent 可以读取当前调用者可见的对象，沿 link 获取关系，调用版本化 Function 计算方案，再尝试提交已有 Action。[AIP 架构说明](https://www.palantir.com/docs/foundry/architecture-center/aip-architecture)把 Ontology context、Agent 与自动化、生产观察和评估放在同一体系中。

放回缺料流程，Agent 读取 SupplyRisk 和关联订单，调用 Function 比较方案，输出待选建议。最终动作仍通过 RescheduleOrder 的参数、提交条件和权限边界。在这种设计下，模型可以不持有 ERP 的通用写账号，访问范围收敛到具体业务工具。

这里的建议只是工作流中的候选，不需要假定存在一种固定的 Proposal 资源。应用可以让操作者直接选择，也可以先把若干 Action 应用到 Scenario 中比较，再把被选中的编辑带回主状态。重要的是候选、假设数据和生产动作各自有清楚的状态语义，模型生成一段文本不会自动改变订单。

这种工具面也改变了评估对象。团队可以分别观察 Agent 读到了什么、产生了哪些候选、提交了哪个 Action、执行是否成功、最终业务结果如何。语言回答质量只是其中一层；生产评估还要检查动作选择、拒绝行为和 outcome。Ontology 的对象与动作 ID 提供连接点，结果关联规则仍需业务流程明确设计。

类型和权限不会自动保证 Agent 安全。Action 定义过宽、Function 缺陷或受污染输入仍会造成错误。Ontology 的作用，是让测试、拒绝、审批和追踪有具体挂点，而不是替代这些控制。

工具面的质量因此取决于动作粒度。一个接收任意对象类型和任意字段的通用更新 Action，虽然容易接入模型，却重新引入了宽权限和难以评估的副作用。RescheduleOrder 这类窄动作把参数、适用对象和失败条件固定下来，Agent 评估也可以围绕明确的允许与拒绝样本展开。

## 7. Action 的运行时权限

[Action permissions](https://www.palantir.com/docs/foundry/action-types/permissions)分布在多个层次：调用者是否能看到 action type，是否能访问相关 object/link types 与数据源，参数能否通过 submission criteria，以及创建或修改对象、link 和 action log 时是否满足对应权限。按钮不可见、对象集合为空、条件被拒绝和写入失败，通常指向不同的检查点。

新 object type 默认只允许经 Action 编辑。在这种配置下，提交者通常只需对被修改对象拥有 Read，业务写入被收束在动作入口。若同时开放 Forms、Object Explorer 或 API direct edit，dataset-backed 类型会要求用户拥有 writeback dataset 的 Edit；这个权限可能让用户看到整份 dataset。为了让一个编辑入口可用而放宽底层权限，会改变原有的数据暴露范围。

运行时排查也应按这些层次进行。Action 根本不可见，先检查类型与入口权限；对象参数为空，检查数据访问；提交条件失败，查看当前业务状态；编辑或日志创建失败，再进入目标类型和数据源权限。若所有问题都靠增加一个大角色解决，Action 原本提供的最小业务授权很快会被掏空。

读取安全与写出安全也需要分别处理。截至 2026-09-15，[read/write authorizations](https://www.palantir.com/docs/foundry/action-types/read-write-authorizations)仍处于 Beta：read authorization 设定额外读取上界，write authorization 规定输出必须满足的最低安全要求；它们补充用户权限和 submission criteria，本身不授予访问，也不会自动添加 marking。

最需要单独评审的是 declassification。假设 Function 读取受限的供应商成本，Action 把决策解释写入更多人可见的 ScheduleDecision。输出可以是经批准的区间，也可能意外带出合同价格。评审必须沿输入、处理逻辑、输出 marking 和写入对象检查完整数据流，不能只检查调用者角色。

这个例子也说明 submission criteria 与安全授权的分工。前者判断“订单当前是否允许改排”，后者限制“哪些数据可以参与计算、结果可以落到什么安全级别”。业务条件写得再严格，也无法替代对输出敏感度的检查；安全授权同样不会判断改排是否符合生产规则。

## 8. Scenario 与 Global Branching：两套版本治理

运行时数据与 Ontology 定义有不同的变更节奏。Palantir 用 Scenario 隔离假设数据，用 Global Branching 隔离资源开发；Action 则直接作用于生产对象或外部副作用。

| 机制 | 处理的对象 | 进入主状态的方式 |
|---|---|---|
| Ontology Scenario | what-if 的对象数据与假设编辑 | 通过单独受控的 merge action |
| Global Branching | object、link、action、interface 等资源定义 | 检查、review、rebase 后合入 main |
| Action | 生产对象、关系或外部副作用 | 提交并通过运行时条件后执行 |

[Global Branching](https://www.palantir.com/docs/foundry/ontologies/branching-ontology)面向 builder。团队在 branch 上修改 Ontology resources，运行检查、处理 rebase 冲突并发起 review，再合入 main。它治理的是对象模型、动作和应用依赖如何一起演进，不为每次业务操作创建资源分支。

例如团队要给 ProductionOrder 增加新的排程属性，并调整 RescheduleOrder 参数，可以在 Global Branch 上同时修改对象、Action 和相关应用，再通过检查与 review 合入主分支。它解决的是版本兼容和开发协作；某位计划员今天改排一张订单，不应因此创建一条资源开发分支。

[Ontology Scenario](https://www.palantir.com/docs/foundry/ontology/overview-ontology-scenario)面向运行期 what-if 分析。人或 Agent 可以在隔离数据上应用 Action、比较方案，再经单独的 merge action 把选中编辑带回 main；该能力在本文核验时仍处于 Beta。Scenario 文档保证的是 Ontology 对象编辑隔离，并未给外部系统提供回滚语义。流程若还会调用 webhook，工程设计不能据此把外部副作用视为可撤销。

在缺料流程里，Scenario 可以同时尝试“延后订单”和“替换物料”，比较两套假设状态对后续订单的影响。Global Branching 则用于发布新的风险对象或改排 Action 定义。一个管理业务数据的可能结果，一个管理平台资源的版本；把它们混成同一种 branch，会让评审对象和合入后果都失去边界。

## 9. 哪些设计可以借，哪些选择取决于平台

Ontology 最值得借鉴的部分，不依赖 Palantir 产品名称：用稳定业务 ID 连接数据和动作；把关系与业务能力做成公共接口；让每次写入有参数、前置条件和可审计上下文；把外部结果重新关联到原始决定；让 Agent 调用窄业务动作，而非持有整个源系统的写权限。

这些原则可以在现有技术栈中逐步实现。团队可以先用领域 API 暴露稳定对象，用工作流引擎约束业务动作，用策略系统处理授权，再把请求、外部交易和结果写进可对账的记录。实现组件未必统一，接口语义可以先统一。最难的工作通常也不在框架选择，而在对象身份、状态权威、动作边界和结果关联。

完整复制则困难得多。OMS、OSS、Object Data Funnel、Actions、Scenario、Global Branching、开发工具和权限系统共同形成平台能力。自行建设一层对象 API 并不等于拥有同样的查询规划、开发体验和治理面；反过来，采用完整平台也意味着对象、Function、Action 和应用逐渐成为专有资源。

平台价值来自这些能力共同工作：类型定义能直接进入对象查询，Action 复用相同权限和对象，Scenario 复用动作规则，AIP 又把对象与动作当作工具。拆开采购或自建时，每个组件都能找到替代品，跨组件的一致资源模型和开发生命周期却需要团队自己维护。选择 Palantir，实际选择的是这种一体化程度。

几类相邻架构的设计中心可以这样区分：

| 路线 | 主要建模单位 | 主要解决的问题 | 生产动作通常由谁负责 |
|---|---|---|---|
| 指标语义层 | metric、dimension、entity | 指标口径与聚合一致性 | 业务系统或数据管道 |
| 知识图谱 | 节点、边、本体 | 实体解析、关系遍历与推理 | 依具体图平台或外部服务 |
| 典型只读 RAG | 文档块、embedding、metadata | 检索与上下文组装 | 外接工具或业务服务 |
| 对象 API / 轻量运营层 | 业务对象、服务契约 | 面向应用的对象读取和有限动作 | 各领域服务 |
| Palantir Ontology | object、link、Function、Action | 共享对象、逻辑、动作与治理 | Ontology Action 与外部写回 |

这张表比较架构重心，不是产品功能排名。知识图谱可以写入，RAG Agent 可以调用工具，对象 API 也能实现审批和审计。需要选择的是公共层应当承担多少生产责任。

多个应用或 Agent 要复用同一批对象、逻辑和受控动作，跨系统写回需要统一治理，并且组织愿意维护这套运行时契约时，Palantir 路线具备完整的平台条件。

对象和动作数量有限，已有领域 API、工作流、授权与审计基础时，轻量运营层更合适。先实现一个窄 Action、明确 source of truth，并保证失败可对账，就能保留主要架构收益。

需求止于指标统一、关系检索或人工决策支持时，保持只读层即可。此时增加 Action、Scenario 和跨系统写回会引入新的生产责任，却没有对应的业务动作需要承接。

### 官方资料

- [Architecture Center：Ontology 概览](https://www.palantir.com/docs/foundry/architecture-center/overview)
- [AIP、Foundry 与 Apollo](https://www.palantir.com/docs/foundry/architecture-center/platforms)
- [Ontology backend architecture](https://www.palantir.com/docs/foundry/object-backend/overview)
- [Object and link types reference](https://www.palantir.com/docs/foundry/object-link-types/type-reference)
- [Action types](https://www.palantir.com/docs/foundry/action-types/overview)
- [Object Set Service limitations](https://www.palantir.com/docs/foundry/ontologies/oss-limitations)
- [Action permissions](https://www.palantir.com/docs/foundry/action-types/permissions)
- [Action webhooks](https://www.palantir.com/docs/foundry/action-types/webhooks)
- [Ontology scenarios](https://www.palantir.com/docs/foundry/ontology/overview-ontology-scenario)
- [Branching the Ontology](https://www.palantir.com/docs/foundry/ontologies/branching-ontology)
