---
layout: post
title: "Palantir Ontology 核心架构研究"
description: "从对象与动作的建模出发，拆解 Palantir Ontology 的运行时、查询、写回、权限和分支机制，以及这套架构值得借鉴和需要警惕的部分。"
tags: [Palantir, 数据架构, Ontology]
---

一家制造企业发现，三天后某条产线会缺料。预测模型已经在报表上把风险标成红色，计划员也看见了。接下来仍有一串工作：确认短缺对应哪些工单，查替代料和供应商产能，估算改排产的代价，向 ERP 提交调整，通知采购，再观察交付结果。

这串工作通常跨越数仓、BI、邮件、Excel 和 ERP。每套系统都完成了自己的职责，整条决策链却没有一个共同的执行上下文。数据团队交付“信息”，业务团队靠人把信息翻译成动作。

Palantir Ontology 处理的就是这段翻译。它把订单、物料、设备等业务对象，预测与优化逻辑，可以执行的动作，以及每一步的权限绑定到同一套模型中。理解这套架构的关键，也正在“绑定”二字：Ontology 不只提供统一名词，还参与查询、决策和写回的运行过程。

## 它在 Palantir 全栈中的位置

Palantir 把标准架构分成 Foundry、AIP 和 Apollo 三个平台。[官方架构说明](https://www.palantir.com/docs/foundry/architecture-center/platforms)给出的边界很明确：Foundry 负责数据运营，包括数据管理、逻辑开发、Ontology 和业务工作流；AIP 提供模型接入、Agent、自动化与评估工具；Apollo 管理承载 Foundry 和 AIP 的基础设施及持续交付。

Ontology 位于 Foundry 和 AIP 共同使用的中间层。向下，它把数据集、流数据、模型和函数组织成业务可用的资源；向上，它向应用、分析工具和 Agent 提供对象、关系、动作及权限。Apollo 不参与订单应该如何建模，它解决这些平台服务如何跨环境部署和升级。

可以把公开架构压缩成下面这张图：

```text
业务应用 / 分析 / Agent / 自动化
               │
     Ontology Language + Toolchain
   object · link · interface · action
               │
          Ontology Engine
    OMS · Object DB · OSS · Actions
       Funnel · Functions on Objects
               │
数据集 / Restricted View / 流 / 模型 / 外部系统

Foundry：数据、逻辑、Ontology 与工作流
AIP：模型、Agent、自动化与评估
Apollo：部署与运行基础设施
```

这张图有一条容易忽略的边界。Ontology 不是企业所有数据的物理存储替代品。官方将它描述为建立在 Foundry 数字资产之上的 operational layer；对象实例仍由数据源映射、索引和用户编辑产生。源系统里的主数据质量、同步延迟和接口稳定性不会因为加了一层 Ontology 自动消失。

## 一套同时约束读取和行动的语言

在 Ontology 中，业务世界先被拆成四类核心构件。

**Object type** 定义一种实体或事件，例如 `Material`、`ProductionOrder`、`Supplier`、`SupplyRisk`。属性承载物料号、承诺日期、风险分数等数据。每个对象要有能够稳定定位实例的主键。

**Link type** 定义对象之间的有向关系及基数。`ProductionOrder consumes Material`、`Supplier supplies Material` 这类关系让应用和查询服务能够沿业务关系查找，而不必让每个应用重写 join 逻辑。

**Action type** 是可提交的一组变更定义。它有参数、提交条件和规则，可以创建或修改对象、属性与链接，也可以调用函数、发通知或请求外部系统。Palantir 的[类型参考](https://www.palantir.com/docs/foundry/object-link-types/type-reference)和 [Action 文档](https://www.palantir.com/docs/foundry/action-types/overview)把 Action 视为面向业务目标的一次提交，而非页面上的任意字段编辑。

**Interface** 给不同 object type 加一份抽象契约。比如 `Schedulable` 可以要求实现者映射 `startTime`、`endTime` 等属性；`ProductionOrder` 和 `MaintenanceWindow` 保留各自的数据结构，同时可被同一套组件或查询逻辑消费。Interface 还可声明 link 和 action capability 的约束，实现它的 object type 再映射到具体关系或动作。[官方说明](https://www.palantir.com/docs/foundry/interfaces/create-interface)区分必填与可选属性，也要求必需的 link/action constraint 必须由具体类型满足。

Interface 很像面向对象语言中的接口，但类比到此为止。它是 Ontology 元数据的一部分，支持范围仍依具体产品入口而异。例如截至 2026 年 9 月，[Actions on interfaces](https://www.palantir.com/docs/foundry/action-types/actions-on-interfaces) 的提交条件会统一作用于所有实现类型，尚不支持 action log，也不能和 functions 组合。抽象可以减少重复，权限粒度却可能随之变粗。

四类构件合在一起，才形成可运行的业务契约。对象说明“现在有什么”，链接说明“它们怎样关联”，Action 说明“允许怎样改变”，Interface 让跨类型能力可以复用。

## 和数仓语义层、知识图谱究竟差在哪

这几个概念经常被放在一起，原因是它们都试图给原始数据补上业务含义。差别要放到运行时观察。

| 架构 | 主要建模单位 | 擅长的读取 | 写入与副作用 | 治理重点 | 常见消费者 |
|---|---|---|---|---|---|
| 数仓模型 | 表、列、事实、维度 | 批量分析、明细查询 | 通常由 ETL 或业务系统负责 | schema、质量、血缘 | SQL、BI、数据科学 |
| 指标语义层 | metric、dimension、entity | 一致口径的聚合 | 通常不承载业务写操作 | 指标定义与口径版本 | BI、自助分析、API |
| 知识图谱 | 节点、边、本体、规则 | 关系遍历、实体解析、推理 | 取决于具体图平台 | 实体语义与关系一致性 | 搜索、推荐、推理系统 |
| Palantir Ontology | object、link、interface、action | 对象搜索、过滤、聚合与 Search Around | Action、function、webhook、writeback | 读取权限、动作权限、业务变更与审计 | 应用、运营人员、Agent |

表中的前三类是常见架构范式，内部差异很大，不能据此判断某个具体产品缺少写能力。这里要说明的是设计中心：指标层把“收入怎么算”变成公共定义；图谱把“供应商和物料如何关联”变成可查询关系；Ontology 还把“哪个计划员可以对哪些工单发起改排，以及结果写到哪里”纳入模型。

代价也由此产生。指标口径更新错了，报表可能失真；Action 规则或权限更新错了，生产流程可能直接受到影响。Ontology 团队维护的是线上业务接口，发布纪律要接近应用服务，而非普通元数据目录。

## 元数据和实例数据分开运行

Palantir 公布的[Ontology 后端架构](https://www.palantir.com/docs/foundry/object-backend/overview)由多组服务协作完成。文档只披露高层职责，没有公开这些服务的内部协议、存储引擎实现或一致性算法。可以确认的边界如下：

- **Ontology Metadata Service（OMS）** 保存 object type、link type、action type 等本体资源的定义。它回答“系统里有哪些类型和能力”。
- **Object databases** 保存索引后的对象数据，为应用提供低延迟查询与查询计算，也参与索引和用户编辑编排。官方将 Object Storage v2 定义为当前承载 Ontology 的 canonical data store；本文不据此判断各个现有租户的迁移状态。
- **Object Set Service（OSS）** 承担 Ontology 读取，提供搜索、过滤、聚合、对象加载和关系遍历。Object set 既可以是一组固定主键，也可以保存为随底层数据变化而更新的动态定义。
- **Actions service** 应用用户编辑，校验结构化的变更条件，并可记录历史 action log。
- **Object Data Funnel** 在 Object Storage v2 中编排写入。它读取数据集、Restricted View、流式数据源以及 Action 产生的用户编辑，将它们索引进对象数据库，并跟随底层数据源更新。
- **Functions on Objects** 让开发者使用生成的类型绑定读取对象和链接，也可通过 Ontology edit API 生成复杂编辑。官方特别说明，“Functions on Objects”并不是一种独立于普通 Function 的正式运行时类别，更像对一组用法的统称。

这套分工首先解决演进问题。OMS 中的业务类型定义不必和每一份对象实例塞在同一个系统里；读请求经 OSS 选择执行路径；批量数据更新和用户编辑经 Funnel 进入索引；复杂业务逻辑留给 Function。Palantir 还公开说明，Object Storage v2 将旧架构中集中在一起的索引和查询职责解耦，以便分别水平扩展。

这里能得出一个架构推论：Ontology 的“统一”发生在契约和访问面，不代表底层只有一个数据库。这个结论来自公开服务边界，不应继续推演成某种未披露的事务或消息架构。

## 一次缺料处置怎样穿过系统

继续用开头的缺料场景。假设 `ProductionOrder` 通过 link 连接到 `Material`，`Material` 又连接 `Supplier`；预测结果生成 `SupplyRisk` 对象；计划员可执行 `RescheduleOrder` 和 `RequestExpedite` 两个 Action。

第一步是建立对象状态。ERP 的订单和物料数据、MES 的排产状态、供应商回传和预测模型输出先成为 Foundry 数据资产。Funnel 读取这些来源并维护 Object Storage v2 中的索引。OMS 保存各 object type 的属性、主键、链接和 Action 定义。此时 Ontology 提供的是经过业务命名的读模型，ERP 仍可继续担任订单的 source of truth。

第二步是形成待处理集合。运营应用向 OSS 查询未来三天 `riskScore` 超过阈值、状态仍为 `Open` 的 `SupplyRisk`，再沿 link 找出受影响的 `ProductionOrder`、物料和供应商。结果可以保存为动态 object set，交给其他 Foundry 应用继续使用。权限过滤在查询过程中生效，因此不同工厂的计划员看到的集合可能不同。

第三步是计算选项。一个 Function 读取订单优先级、库存、替代料和产能，返回若干改排方案及影响。AIP Agent 也可以使用这些对象和函数提出方案。模型此时生成的是候选决策；它能调用哪些资源，仍受平台授权和 Action 条件限制。

第四步是提交动作。计划员选择方案，调用 `RescheduleOrder(order, newDate, reason)`。Actions service 检查调用者能否查看相关类型和数据源、是否满足 submission criteria、是否具备被修改对象及 action log 的必要权限。规则可以更新订单的计划日期，创建 `ScheduleDecision`，并链接到原风险和操作者。

第五步是写回 ERP。如果 ERP 才是排产日期的权威来源，Action 可以调用 webhook。这里存在两种语义完全不同的顺序：[writeback webhook](https://www.palantir.com/docs/foundry/action-types/webhooks) 在 Ontology 编辑前调用，外部请求失败时终止后续编辑；side-effect webhook 在对象修改后执行，用户可能已经看到成功，外部请求随后仍可能失败。

即便选择 writeback webhook，也得不到跨系统原子事务。官方文档明确指出，外部请求可能成功，而后续 Ontology 修改失败。于是系统仍需幂等键、对账任务和补偿流程。使用 side effect 时，异步失败队列、重试策略和业务可见的“同步中/失败”状态更不能省。

第六步是反馈。ERP 的新状态再次进入数据管道，Funnel 更新对象索引，`ScheduleDecision` 与实际交付结果被用于运营分析或模型评估。到这里，预测、决策、执行和结果才闭合。若配置了 [action log](https://www.palantir.com/docs/foundry/action-types/action-log)，它记录成功提交的决定、操作者和上下文；Action 失败不会进入这份日志，需要用 action metrics、monitoring，以及 Function 或 webhook 的执行历史诊断。对象状态与外部系统的对账另有职责，不能指望一张日志覆盖整条链路。

这条链路也解释了 Ontology 的价值来自哪里：统一对象 ID 让上下文可以跨应用传递，Action 把写入范围收窄，写回机制连接现有 source of truth，结果又回到同一语义空间。少任何一环，它都可能退化成另一层数据展示。

## OSS 让对象抽象付出真实的查询成本

对象 API 容易制造一种错觉：既然应用只操作 object set，底层规模和 join 就不用再考虑。Palantir 的 [OSS 限制文档](https://www.palantir.com/docs/foundry/ontologies/oss-limitations)恰好说明相反的事实。OSS 会按查询规模和复杂度自动选择三类执行路径：

1. 简单过滤与聚合尽量下推到存储层，利用索引完成；
2. 复杂度较高、规模适中的 object set 在内存中执行；
3. 超出内存能力或涉及某些复杂操作时，切换到 Spark 分布式执行，换取规模，承担更高延迟和计算成本。

文档给出的默认边界很具体：Object Storage v2 中，Search Around 和 derived properties 在超过 10 万对象时可能转入 Spark；单次 Search Around 的结果集默认最多 1000 万对象，整个查询从各数据集加载的对象合计最多 3000 万；Ontology SDK 的 `.all()` / `.allAsync()` 最多把 10 万对象载入内存。实际阈值还受租户配置、查询阶段和功能影响，不能把这些数字当 SLA。

执行路径不仅由数量决定。derived property、计算 SQL 列、intermediary link type、interface Search Around 等操作可能失去快速下推条件，小集合也会进入内存或 Spark。分页返回少于请求条数，也不表示已经读完；调用方要继续使用 page token，直到 token 为空。

这对建模有直接约束。把所有关系都建成多跳 link，再让业务页面临时计算派生属性，语义上很漂亮，交互延迟可能很差。官方给出的建议包括提前过滤、分页、避免无法利用索引的表达式，以及在频繁触碰限制时适度反规范化。Ontology 没有取消物理设计，只是把物理设计藏到了对象接口后面。

## 权限模型里最容易踩的两处坑

一句“Action 按用户权限执行”会遗漏关键细节。[Action permissions](https://www.palantir.com/docs/foundry/action-types/permissions) 至少包含四层判断：用户能否看见 action type，能否看见被编辑的 object/link type 及数据源，是否通过 submission criteria，以及能否修改或创建相关对象和 action log。

第一处坑来自直接编辑。新 object type 默认只允许经 Action 编辑。在这种配置下，提交者通常只需对被编辑对象有 `Read`，Action 负责把业务写权限收束在预定义入口。若团队同时开放 Foundry Forms、Object Explorer 或 API 直接编辑，底层为 dataset 的 object type 会要求提交者拥有 writeback dataset 的 `Edit`。官方提醒，`Edit` 可能让用户看到整份 writeback dataset 中超出当前操作所需的数据。因此，给用户补权限让按钮“先能点”可能扩大数据暴露面。

第二处坑是读权限不会自动成为写入安全。行列访问控制、Restricted View、object security policy 和 property security policy 会过滤 Action 运行时能读到什么，但官方标注这些控制只在读取侧执行，不自然延伸到 Action 写出的数据。处于 Beta 的 [read/write authorizations](https://www.palantir.com/docs/foundry/action-types/read-write-authorizations) 可以再设输入安全上界和输出安全下界；它们补充用户权限和 submission criteria，既不授予访问，也不会自动添加 marking。

更棘手的是降级写入。若 write authorization 比 read authorization 宽松，Action 可能把高敏输入加工成较低敏输出。这可以是有审批的解密或脱敏流程，也可能造成 data spill。当前文档说明，保存或发布 Action 时会检查配置者的 declassification 权限，但若没有设置 read authorization，就不会执行相应的降级检查。团队需要把 Action 当成数据流的一段来做威胁建模，不能只审调用者角色。

权限设计还要覆盖失败状态：谁能看 action log，通知接收者能否看到消息中包含的对象数据，webhook 使用何种身份访问外部系统，补偿任务又以谁的身份运行。Ontology 把这些问题集中到了一个可治理入口，同时也让配置错误具有更大的爆炸半径。

## Scenario 与 Global Branching 管的是两种变化

Palantir 文档里同时出现 scenario、branch 和 proposal，读起来很像同一套 Git 工作流。它们服务于不同对象。

[Ontology scenario](https://www.palantir.com/docs/foundry/ontology/overview-ontology-scenario) 是运行期数据沙箱。人或 Agent 可在隔离分叉上应用一个或多个 Action，比较方案，再通过单独受控的 merge action 把选中编辑合入 main Ontology data。Scenario 会周期性基于 main 或 global branch 自动 rebase；它不是历史快照或通用数据版本库。该能力截至本文核验时仍处于 Beta，默认有 30 天存活期，也存在 Action 合并限制。

[Global Branching](https://www.palantir.com/docs/foundry/ontologies/branching-ontology) 面向 builder 的开发隔离。团队可以在 branch 上修改 object type、link type、action type 等 Ontology resources，运行检查、处理 rebase 冲突、发起 review，再合入 main。它保护的是模型、逻辑和端到端应用变更，不是每一次业务操作都创建一条资源分支。

Proposal 则是决策交互中的候选输出。Agent 可以提出方案，由操作员修改、反馈或批准；是否在 scenario 中演算、是否最终触发 Action，由具体工作流决定。把三者分开后，治理关系才清楚：Global Branching 管“系统定义怎么改”，Scenario 管“假设数据怎么变”，Action 管“生产对象允许发生什么”，proposal 只是尚未落地的建议。

## AIP 接进来以后，Ontology 承担控制面

企业 Agent 的风险通常不在回答错一个数字，而在错误答案被转成了生产动作。AIP 给模型提供接入、Agent、自动化和评估能力；Ontology 给这些能力划定可见对象、可调用函数和可提交 Action 的边界。[AIP 架构文档](https://www.palantir.com/docs/foundry/architecture-center/aip-architecture)也把持续注入 Ontology context、构建 Agent 与自动化、观察和评估生产行为列在同一架构中。

在缺料场景里，Agent 无须获得 ERP 的通用写账号。它读取当前用户可见的 `SupplyRisk` 和相关对象，调用受版本管理的 Function 计算方案，生成 proposal；高风险动作先写入 scenario；最终提交仍经过 Action 的参数、submission criteria 和权限检查。若 Action 配置了 action log，成功提交后还会生成相应日志对象。权限的最小单位从“能不能访问这个系统”收窄到“能不能对这类对象执行这个业务动词”。

这并不保证 Agent 安全。Action 的定义可能过宽，Function 可以包含缺陷，提示注入可能影响候选参数，scenario 也有功能限制。可取之处是把模型输出置于已有的类型、权限和执行机制内，使测试、审批、拒绝和追溯有明确挂点。模型能力更换时，业务动作契约可以继续存在。

## 落地时先做一条窄闭环

要借鉴 Ontology，不宜从“建立全公司的数字孪生”开工。一个可操作的顺序是：

1. **选一个有执行后果的决策。** 它应当高频、跨系统、当前依赖人工搬运，并且结果能被观测。缺料处置、设备告警分派、客户退款审核都比“统一客户视图”更容易检验架构价值。
2. **确定对象身份和 source of truth。** 为核心对象建立稳定主键，写清每个属性来自哪里、允许多大延迟、冲突时谁优先。没有这一步，link 只会把不一致的数据连接起来。
3. **先交付只读对象接口。** 用少量 object/link type 复现当前判断过程，测量 OSS 查询路径与权限过滤。页面能打开不等于可运营，还要观察高峰延迟、索引新鲜度和大 object set 的退化。
4. **增加一个窄 Action。** 参数应表达业务意图，规则限制影响范围，并保存 reason、操作者、输入版本和结果。先让人工提交，验证失败处理和审计，再考虑 Agent 调用。
5. **明确写回一致性。** 为外部系统定义幂等键、超时、重试、对账与补偿；根据业务后果选择 writeback webhook 或 side effect。不要用“已触发”冒充“已完成”。
6. **把结果接回评估。** 记录建议、批准、执行和业务结果之间的关联。没有结果反馈，Agent 只能优化语言输出，无法证明决策质量改善。

做完第一条闭环，团队才有材料判断是否扩展 object type、抽象 interface、建设 scenario，或把更多动作开放给自动化。若只读查询已经足够，停在指标语义层或对象 API 往往更便宜。

## 组织成本与平台锁定

Ontology 的技术魅力来自统一，长期成本也来自统一。对象、链接、动作和权限一旦成为多个应用的公共接口，任何变更都会穿过数据、应用和运营团队。需要有人承担下面这些持续工作：

- object type 的 owner 负责身份、属性语义和兼容性；
- Action owner 对提交条件、副作用、回滚和审计负责；
- 数据 owner 负责源数据质量、更新时效和 Restricted View；
- 应用与 Agent owner 负责消费契约、评估失败并处理降级；
- 安全团队审查读取范围、写入授权、外部凭据和降级流向。

这已经接近领域平台团队，而不是一次数据建模项目。若所有 object、function、action、应用组件和部署流程都使用 Palantir 专有资源，迁移成本会随着闭环数量增长。对象属性还能映射回通用 schema，Action 的 submission criteria、Ontology edit 逻辑、scenario 交互和 Workshop 应用却更难原样搬走。

降低锁定风险的办法并非拒绝平台能力，而是保留边界：源系统继续拥有清晰的数据所有权；外部接口采用稳定的业务 ID 和幂等协议；关键规则有平台外可读的规范与测试；Action 日志可以导出对账；模型和 Agent 不直接依赖页面状态。这样即使无法无损迁移，也知道哪些部分是业务资产，哪些部分是产品实现。

Palantir Ontology 给数据架构提出了一个很具体的问题：团队愿不愿意为“采取行动”建立与数据读取同等级别的类型、权限和生命周期治理。愿意，并且确有跨系统决策闭环时，这套架构能把报表后的人工断点变成软件接口。只想统一名词或做关系检索时，较轻的语义层、对象 API 或知识图谱已经够用。

### 官方资料

- [AIP、Foundry 与 Apollo](https://www.palantir.com/docs/foundry/architecture-center/platforms)
- [Ontology backend architecture](https://www.palantir.com/docs/foundry/object-backend/overview)
- [Object and link types reference](https://www.palantir.com/docs/foundry/object-link-types/type-reference)
- [Action types](https://www.palantir.com/docs/foundry/action-types/overview)
- [Object Set Service limitations](https://www.palantir.com/docs/foundry/ontologies/oss-limitations)
- [Action permissions](https://www.palantir.com/docs/foundry/action-types/permissions)
- [Action log 与 Action metrics](https://www.palantir.com/docs/foundry/action-types/action-log)
- [Ontology scenarios](https://www.palantir.com/docs/foundry/ontology/overview-ontology-scenario)
- [Branching the Ontology](https://www.palantir.com/docs/foundry/ontologies/branching-ontology)
