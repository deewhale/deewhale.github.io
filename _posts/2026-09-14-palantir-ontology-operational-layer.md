---
layout: post
title: "Palantir Ontology 核心架构：从业务对象到生产动作"
description: "沿一条缺料改排闭环，解释 Palantir Ontology 如何组织对象查询、候选计算、Action 写回、结果反馈，以及权限和版本治理。"
tags: [Palantir, 数据架构, Ontology]
---

设想这样一次制造业缺料处置：风险模型发出缺料告警，计划员需要判断哪些订单会受影响。订单计划日期在 ERP，开工状态在 MES，库存和在途批次来自其他数据源，供应商又刚刚更新了承诺交期。把这些信息放进一张报表，只解决了“看见问题”；计划员还要比较改排与替代料方案，把选中的日期安全写回 ERP，并确认外部系统最终接受了这次修改。

在 Palantir 的产品体系里，Foundry 承载企业数据、业务逻辑与工作流，Ontology 是其中把这些分散状态组织成业务对象、关系和受控动作的一层。[Palantir 将它称为建立在组织数字资产之上的 operational layer](https://www.palantir.com/docs/foundry/architecture-center/overview)。

这比通常的只读语义层多承担了一段生产责任。语义层主要让不同查询对“订单、库存、风险”形成一致解释；Ontology 还要表达“谁可以对哪张订单做什么”，让动作经过条件检查后进入业务系统，并把执行结果带回同一个对象空间。它不是给表换一套业务名称，也不意味着取代 ERP 或 MES，而是在源系统和业务应用之间建立一份可运行的契约。

## 先把缺料处置闭环画完整

一次可执行的缺料处置至少包含下面这条路径：

    ERP / MES / 库存 / 供应商 / 风险模型
                      │
             映射为业务对象与关系
                      │
          查询受影响订单，补齐上下文
                      │
        Function、规则、优化模型或人
               形成候选处置方案
                      │
          RescheduleOrder Action
                      │
                 写回 ERP
                      │
       ERP 新状态重新摄取并关联结果

这里有三个不同的状态。风险告警是观察结果；“把订单延后两天”是候选方案；ERP 已确认的新计划日期才是业务事实。把三者混在一个字段里，页面上的“已提交”就很容易被误读为“已经完成”。

源系统的权威也要按属性划分。ERP 可以继续决定订单的计划日期，MES 负责现场是否已经开工，风险分数来自某个有版本的模型输出。Ontology 为它们提供共同的订单身份和访问方式，但不会自动消除标识冲突、更新延迟或来源之间的矛盾。团队仍要明确每个关键属性由谁负责，以及发生冲突时以哪一侧为准。

只读语义层通常在“查询受影响订单”或“形成候选方案”之后结束，真实修改由人转到另一个系统完成。这完全可能是正确边界。只有当多个应用或 Agent 需要复用同一批对象和业务动作，且写回、权限、失败恢复与结果追踪也要共享治理时，才有必要把闭环后半段纳入公共层。

## 用对象、关系和动作表示缺料处置

缺料场景不需要先记住一组 Palantir 服务名。用六个构件就能建立最小模型：

| 构件 | 在缺料处置中的含义 | 解决的问题 |
|---|---|---|
| Object | 某张生产订单、某种物料、某个供应商、某次供应风险 | 用稳定身份表示业务实体或事件 |
| Link | 订单消耗物料、物料由供应商供应、风险影响订单 | 让应用复用关系，而不是各自拼接字段 |
| Object Set | 未来三天高风险且尚未处置的订单集合 | 保存固定对象范围，或保存可随数据重算的查询定义 |
| Function | 读取库存、交期和订单优先级，计算改排候选 | 在对象和关系之上运行逻辑 |
| Action | 以订单、新日期、原因和候选编号提交改排 | 把写入限制为一个有明确业务含义的动词 |
| Interface | 让订单、维护窗口等不同类型共享“可排程”能力 | 为多个对象类型提供共同属性、关系或动作边界 |

在 Palantir 的 Ontology Language 中，Object type 定义一类对象的 schema，object instance 才是某个具体实例。创建类型时，数据源列可映射为 properties，其中一列成为唯一 primary key；Link type 则定义不同类型间可复用的关系。[对象与关系的基础定义见官方类型参考](https://www.palantir.com/docs/foundry/object-link-types/type-reference)，[对象类型创建文档](https://www.palantir.com/docs/foundry/object-link-types/create-object-type/index.html)和[关系类型创建文档](https://www.palantir.com/docs/foundry/object-link-types/create-link-type)进一步说明了主键与数据源映射。

这份假设模型可以很小：`ProductionOrder（生产订单）` 以订单号为身份，通过 `consumes` 连接 `Material（物料）`；物料再通过 `suppliedBy` 连接供应商。风险模型每次运行产生一个 `SupplyRisk（供应风险）`，记录预测窗口、模型版本和风险分数，并通过 `affects` 指向受影响订单。`RescheduleOrder（改排订单）` 只接收订单、新日期、原因和候选编号，不暴露任意字段更新。

如果生产订单和维护窗口都需要进入同一个排程组件，可以让它们实现 `Schedulable（可排程）` Interface，并把各自的开始时间、结束时间和排程动作映射到共同能力上。[Interface 可以声明必填属性以及 link、action capability constraints](https://www.palantir.com/docs/foundry/interfaces/create-interface)。调用方因此面向一份稳定契约，而不是为每种对象重写适配逻辑。

稳定契约也带来兼容责任。更换订单主键会破坏跨应用引用，改变 link 基数会影响查询，放宽 Action 参数可能扩大生产副作用。Ontology 一旦进入业务操作，它的变更就应像业务 API 一样接受兼容性评审，而不是被当作只供搜索的元数据目录。

## 这些定义如何在 Palantir 里运行

类型定义本身不会生成一个可查询的高风险订单集合。Palantir 公开的 Ontology 后端把定义、索引和查询拆开，由 Ontology Metadata Service（OMS）、Object Data Funnel、object database 和 Object Set Service（OSS）分担，[官方后端架构说明了这些组件的关系](https://www.palantir.com/docs/foundry/object-backend/overview)。

放回缺料场景，这组服务完成的是一条具体读取路径：

    Ontology Language 中的类型定义 ──► OMS

    ERP / MES / 供应商 / 模型输出
                    │
           Object Data Funnel
                    │
             object database
                    │
          OSS 查询 Object Set
                    │
       应用或 Function 读取与计算

OMS 回答“系统定义了哪些类型和能力”，object database 保存的是按这些定义索引后的对象状态，OSS 则把对象集合交给应用和逻辑。三者不能互换：把元数据定义清楚，不代表对象已经更新；对象已经索引，也不代表某条关系查询没有成本。

Object Set 是读取侧的关键抽象。“今天交给某位计划员处理的十张订单”可以保存具体对象 ID；“未来三天高风险且尚未处置的订单”可以保存动态查询，数据变化后重新计算。Function 再沿 link 读取库存、替代料、订单优先级和供应商承诺，形成几个候选方案。共享对象 ID 让不同计算结果回到同一张订单，不必依赖文本描述重新匹配。

这个例子选择让 Function 只产生候选，把生产修改交给 Action。这是架构边界，不是 Function 的产品限制；[Palantir Functions 可以返回 Ontology edits，实际写入需由 function-backed Action 应用](https://www.palantir.com/docs/foundry/functions/edits-overview)。分开之后，候选可以记录输入版本和影响范围，并在真正提交前重新检查。库存或交期在计算后发生变化时，旧候选不会自然变成当前事实。

Object Set 提供稳定的语义接口，不代表查询只有一种物理执行方式。[OSS 会根据操作和规模在存储下推、内存和 Spark 等路径间选择](https://www.palantir.com/docs/foundry/ontologies/oss-limitations)。因此，高频关系和派生计算仍要按真实工作负载评审：先过滤、分页，避免不必要的全量加载；必要时再为访问路径调整模型。对象化消除了每个应用重复解释字段的工作，没有消除物理查询成本。

新鲜度是读取路径上更直接的边界。ERP 刚更新的日期，要等相应数据链经过 Funnel 更新对象索引后，才会出现在新的 Object Set 中。若候选方案会触发高风险写入，Action 提交时应重新检查订单是否仍可改排，而不能只相信几分钟前读取的对象快照。

## Action 把候选方案带过生产边界

`RescheduleOrder` 可以收敛成下面这份业务契约：

    RescheduleOrder
    parameters: orderId, proposedDate, reason, candidateId
    submission criteria: 订单尚未开工，候选仍有效，日期与原因合法
    edits: 记录所选方案与当前执行状态
    external effect: 将计划日期提交给 ERP

这是架构示例，不是 Palantir 配置语法。[Action type](https://www.palantir.com/docs/foundry/action-types/overview)提供参数、提交条件、对象或关系编辑以及提交副作用等构件。参数表达业务意图，submission criteria 在提交时复核当前条件，edit rules 处理平台内状态变化，外部效果则越过 Ontology 边界进入 ERP。

窄动作比通用更新接口多了一层业务约束。应用或 Agent 只能请求“把这张订单改到这个日期，并说明原因”，不能任意选择对象类型和字段。订单已经开工、计划窗口关闭或候选版本过期时，同一个入口可以明确拒绝提交。

真正困难的地方是 Ontology 与 ERP 无法凭一个 Action 自动组成跨系统原子事务。Palantir 的 webhook 支持两种顺序：

    writeback:   Action → ERP → Ontology changes

    side effect: Action → Ontology changes → 返回成功 ──► ERP

[Writeback webhook 在其他规则之前调用](https://www.palantir.com/docs/foundry/action-types/webhooks)。外部请求失败会阻止后续 Ontology 修改，但外部已经成功以后，内部修改仍可能失败，于是出现“ERP 已改、Ontology 未改”的窗口。Side-effect webhook 在对象修改后运行，多个 side effect 也没有顺序保证；主编辑成功时，ERP 的副作用可能尚未完成或最终失败。

选择顺序取决于哪一侧可以暂时领先。ERP 必须先确认计划日期时，writeback 更贴近权威系统；发送通知或触发非关键下游任务时，side effect 可以让主编辑先完成。页面上的“成功”必须对应一个定义清楚的证据：是平台接受了请求、ERP 已经确认，还是对象状态已和源系统重新对齐。

跨系统恢复因此需要业务侧设计。请求应带稳定幂等键；超时或响应未知时，先查询 ERP 当前状态，再决定是否重试；候选编号、Action submission 和外部 transaction 要能对账；确实需要撤销时，由业务规则定义补偿动作。这些是从失败窗口推导出的工程要求，不是对 Palantir 内部自动实现的描述。

一个可观察的执行状态可以区分 `submitted`、`external-confirmed`、`reconciled` 和 `failed`。名称不重要，重要的是不要让按钮返回值提前取代外部业务事实。ERP 确认的新日期仍要经数据链重新摄取，Funnel 更新对象索引，应用再把最终状态与原风险、候选和 Action 关联。到这一步，系统才能回答改排是否真的发生、短缺是否解除，以及风险是否转移到其他订单。

[Action log 是可选配置，并且只为成功提交生成日志对象](https://www.palantir.com/docs/foundry/action-types/action-log)。它可以保存操作者和提交上下文，却不是完整交易总账：失败提交、绕过 Action 的编辑、ERP 最终状态和业务结果仍需其他证据。反馈闭环的价值正在这里——评估不再停在模型分数或按钮点击，而能连接“提出了什么、执行了什么、最后发生了什么”。

## 当 AIP Agent 成为同一条路径的调用者

至此才需要引入 Palantir 的另外两个平台名。[官方平台架构](https://www.palantir.com/docs/foundry/architecture-center/platforms)把数据、Ontology 和业务工作流放在 Foundry，把模型接入、Agent、自动化与评估放在 AIP；Apollo 负责这些平台服务的持续交付和运行基础设施。Apollo 不拥有订单或改排规则，它解决的是平台如何在不同环境中被部署和运行。

AIP 改变的是谁来使用 Ontology，而不是重写前面的业务链。[AIP 架构把 Ontology context、Agent 与自动化、生产观察和评估放在同一体系中](https://www.palantir.com/docs/foundry/architecture-center/aip-architecture)。在缺料场景里，Agent 可以读取当前调用者可见的 `SupplyRisk` 和关联订单，调用 Function 比较方案，再尝试提交已有的 `RescheduleOrder`。

这种工具面比把 ERP 通用写账号交给模型更容易约束和评估。Agent 的可选动作有稳定名称和参数，提交条件会按当前业务状态复核，结果又能用对象与动作 ID 回到同一条反馈链。测试也可以围绕具体允许与拒绝样本展开：什么订单可以改排，什么状态必须拒绝，外部结果未知时怎样停止或转人工。

类型与权限并不会自动保证 Agent 安全。Action 定义过宽、Function 缺陷、受污染输入或错误的业务规则仍会造成问题。Ontology 提供的是测试、审批、拒绝和追踪的挂点；哪些高风险动作需要人工确认，仍应由具体业务后果决定，而不是默认所有 Agent Action 都必须审批。

## 能写以后，治理对象已经变了

### Action 的运行时权限

一次 Action submission 会经过多个检查点：[调用者能否看到 action type，能否访问相关对象、关系和数据源，参数是否满足 submission criteria，以及对象编辑或 action log 创建是否具备相应权限](https://www.palantir.com/docs/foundry/action-types/permissions)。按钮不可见、对象参数为空、业务条件拒绝和写入失败，分别指向不同层次；用一个范围过宽的角色解决所有问题，会破坏窄动作原本提供的最小授权。

Palantir 文档说明，新 object type 默认只允许经 Action 编辑；在这种配置下，提交者通常只需对被修改对象拥有 Read。若另外开放 Forms、Object Explorer 或 API direct edit，dataset-backed 类型会要求用户拥有 writeback dataset 的 Edit，而这可能让用户看到整份 dataset。为方便一个入口而放宽底层编辑权限，会同时改变数据暴露范围和可用写入路径。

读取安全和写出安全要分开评审。假设 Function 能读取受限的供应商成本，Action 却把决策解释写入更多人可见的 `ScheduleDecision`：输出若带出合同价格，就发生了敏感信息降级泄露。截至 2026-09-15，[Palantir 的 read/write authorizations 仍处于 Beta](https://www.palantir.com/docs/foundry/action-types/read-write-authorizations)：read authorization 设定额外读取上界，write authorization 规定输出必须满足的最低安全要求；它们补充现有权限和 submission criteria，本身不授予访问，也不会自动添加安全标记。

Submission criteria 判断“这张订单当前能不能改排”，安全授权判断“哪些数据可以参与计算、结果可以落到什么安全级别”。两者都需要，因为严格的业务条件无法阻止敏感输入从低级别输出泄露，安全标记也不会替团队判断改排是否符合生产规则。

### 候选数据、生产动作与资源定义

缺料处置中还有三种容易混淆的变化：未提交的候选方案、隔离的假设数据、Ontology 定义本身。它们不应共用一个模糊的“分支”概念。

| 机制 | 改变的对象 | 在缺料场景中的作用 | 进入主状态的方式 |
|---|---|---|---|
| 候选方案 | 尚未生效的决策记录 | 保存“延后订单”或“替换物料”的输入与影响 | 选择后仍需提交 Action |
| Ontology Scenario | 隔离的运行期对象编辑 | 比较两套假设状态对后续订单的影响 | 通过单独受控的 merge action |
| Action | 生产对象、关系或外部副作用 | 真正提交改排或其他业务操作 | 通过运行时条件后执行 |
| Global Branching | object、link、action、interface 等资源定义 | 修改排程属性、Action 参数或相关应用 | 检查、review、rebase 后合入 main |

这里的“候选方案”只是场景用语，不是固定的 Palantir `Proposal` 资源。[Ontology Scenario](https://www.palantir.com/docs/foundry/ontology/overview-ontology-scenario)面向运行期 what-if 分析：人或 Agent 可以在隔离对象数据上应用 Action、比较方案，再经单独的 merge action 把选中编辑带回主状态；截至 2026-09-15，该能力仍处于 Beta。官方文档保证的是 Ontology 对象编辑的隔离，并没有为外部系统提供回滚语义；若流程还会调用 webhook，就不能据此把外部副作用视为可撤销。

[Global Branching](https://www.palantir.com/docs/foundry/global-branching/overview)处理另一类问题。团队可以在 branch 上同时修改 `ProductionOrder`、`RescheduleOrder` 和相关应用，运行检查、处理 rebase 冲突并评审后合入 main。它治理平台资源如何共同演进，不为计划员今天改排一张订单创建资源分支。

## 三种采用路线

缺料场景暴露的不是一个产品功能清单，而是一条责任边界。稳定业务 ID、明确 source of truth、窄业务动作、提交时复核、外部结果对账和反馈关联，都可以脱离 Palantir 单独采用。区别在于这些责任由现有系统分别承担，还是进入同一个平台资源模型和开发生命周期。

| 路线 | 缺料场景能做到哪里 | 生产写入由谁负责 | 适用条件 |
|---|---|---|---|
| 只读语义层 | 统一订单、库存和风险口径，查询受影响订单，辅助人工判断 | 人在 ERP 操作，或由既有业务系统处理 | 需求止于指标统一、关系检索、告警和人工决策支持 |
| 轻量运营层 | 用领域 API 暴露稳定对象，以工作流和策略系统实现少量窄 Action | 既有领域服务和工作流引擎 | 对象与动作数量有限，已有 API、授权、审计和失败恢复基础 |
| 完整 Ontology 平台 | 让多个应用或 Agent 复用对象、关系、Function、Action、权限、Scenario 与开发治理 | Ontology Action 与外部写回共同承担 | 跨系统动作多、复用面广，需要统一治理，且组织愿意长期维护运行时契约 |

只读不是未完成的 Ontology。若风险页面只需帮助计划员定位订单，人工继续在 ERP 中执行，增加 Action、Scenario 和跨系统写回只会引入新的生产责任。此时应把对象身份和数据新鲜度做好，而不是为了“闭环”把所有操作搬进公共层。

完整平台的取舍不在于能否替代某个单点组件，而在于是否愿意维护跨组件的一致资源模型。采用后，对象、Function、Action 和应用会逐渐成为专有资源，因此还要评估平台依赖和退出成本。

决定之前，需要明确订单计划日期的最终责任方和旧候选的失效条件，也要明确 ERP 成功而 Ontology 失败时的对账责任，以及 `RescheduleOrder` 的长期维护者。只要这些责任还没有明确归属，把对象和 Action 放进更完整的平台，就只会把原有断点换成一组更难看见的运行时契约。

### 官方资料

- [Architecture Center：Ontology 概览](https://www.palantir.com/docs/foundry/architecture-center/overview)
- [Object and link types reference](https://www.palantir.com/docs/foundry/object-link-types/type-reference)
- [Ontology backend architecture](https://www.palantir.com/docs/foundry/object-backend/overview)
- [Action types](https://www.palantir.com/docs/foundry/action-types/overview)
- [Action webhooks](https://www.palantir.com/docs/foundry/action-types/webhooks)
- [Action permissions](https://www.palantir.com/docs/foundry/action-types/permissions)
- [AIP、Foundry 与 Apollo](https://www.palantir.com/docs/foundry/architecture-center/platforms)
- [Ontology scenarios](https://www.palantir.com/docs/foundry/ontology/overview-ontology-scenario)
- [Branching the Ontology](https://www.palantir.com/docs/foundry/ontologies/branching-ontology)
