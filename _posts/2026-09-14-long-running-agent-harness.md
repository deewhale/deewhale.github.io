---
layout: post
title: "Harness 工程设计：长运行 Agent 的交接与验证"
description: "从跨会话交班、外部验收到运行时恢复，解释长运行 Coding Agent 如何把一次模型调用变成可持续、可验证的工作过程。"
tags: [Agent, 架构, Harness]
---

一个 Coding Agent 可以在仓库里连续改代码，却不一定能在中断后继续。模型每次调用只能读取有限的 context；任务做不完，就要压缩旧历史或开启新会话。与此同时，容器可能重建，依赖可能失效，接手者也可能从另一个模型实例开始。代码还在，并不代表下一轮知道需求是否完整、哪个版本可信、哪些路径真的通过了测试。

这里把 **Harness** 理解为包在模型调用外面的工程控制层。它负责从外部状态组装本轮 context、把工具请求送到执行环境、记录结果，并决定任务继续、暂停还是结束。它不是某个特定产品，也不只是 system prompt。文章关注的是模型、耐久状态、执行环境和验证之间的边界，不讨论模型训练，也不预设数据库、队列或容器产品。文中的外链只用于标明事实出处，不是理解后文的前置阅读。

“长运行”也不宜按墙钟时间划线。一次工作即使只持续十分钟，只要跨过了模型记忆、会话、执行者或基础设施故障边界，就已经需要交班；反过来，持续两小时但始终有人盯着、结果又能立刻检查的任务，未必值得建设复杂编排。

先看一轮任务最小的控制路径：**从上一个可信版本恢复环境，跑通基线，领取一个有边界的工作项并冻结验收条件；Agent 产出候选版本，外部检查针对这个版本验证结果；通过才把它提升为下一轮的可信落点，失败则保存证据等待修复。**

Anthropic 从 2025 年 11 月到 2026 年 4 月公开的几轮实践，分别处理了跨会话交接、外部验收和运行时解耦。公开材料没有给出通用生产协议；本文的状态规则和伪代码是据此整理的工程推导。

## 交接先于智能：让新会话知道现场在哪里

[2025 年的长运行 Coding Agent 实验](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)针对跨多个会话生成全栈应用，记录了两类反复出现的失败。一类是“一次性铺开”：模型试图一口气实现整个应用，context 耗尽时只留下缺少说明的半成品。另一类是“提前宣布完成”：后续会话看到页面、组件和一些测试已经存在，便把“做了很多”误认成“已经交付”。实验也观察到，压缩旧对话虽然腾出了 context，交接指令仍可能含糊。

改造后的 Harness 给首轮和后续轮使用不同的初始提示。初始化角色创建 `init.sh`、进度文件、初始 Git commit，并把高层要求展开成结构化的功能清单，所有功能先标记为未通过。后续的 coding agent 每轮选择一个尚未通过的功能，实现、测试、更新进度，再提交 Git。两种角色共用 system prompt、工具和总体 Harness；它们是两种开场提示，不是两套长期驻留服务。

这些工件不能互相替代：

- `init.sh` 回答如何把仓库恢复到可测试状态；
- 功能清单回答全部范围里还有什么没有通过；
- 进度文件告诉接手者刚做过什么、建议从哪里继续；
- Git commit 保存可以比较和回退的代码版本。

官方的 [initializer prompt](https://github.com/anthropics/claude-quickstarts/blob/main/autonomous-coding/prompts/initializer_prompt.md)把 `feature_list.json` 视为功能覆盖的权威来源，并要求后续执行者只修改条目的通过状态；[coding prompt](https://github.com/anthropics/claude-quickstarts/blob/main/autonomous-coding/prompts/coding_prompt.md)则要求新会话先读规格、功能清单、进度和 Git 历史，启动应用并重验核心路径，之后才领取新工作。发现回归时，原本通过的功能要退回未通过并优先修复。

启动顺序是这套做法中最容易被忽略的部分。新会话一进仓库就写新功能，可能把依赖尚未恢复、服务没有启动或旧代码已经回归，误判成当前工作项的问题。先重建现场，再跑一条短基线，才能把“上一个落点是否仍可信”和“这一轮准备改什么”分开。每轮只推进一个功能也是同样的考虑：一次提交、一次进度更新和一组测试尽量围绕同一个工作单元，接手者才说得清变化来自哪里。

把继续工作所需的信息移出模型 context，能让下一轮找到起点，却不能证明功能清单没有漏项，也不能消除 Agent 自行验收时放宽标准的倾向。

## 完成不在消息里，而在可检查的结果里

2026 年 3 月的[长运行应用 Harness 实验](https://www.anthropic.com/engineering/harness-design-long-running-apps)把工作拆给三个角色。Planner 把一到四句话的产品要求扩展为规格，重点确定产品范围和高层设计，避免过早写死底层实现；Generator 根据规格构建应用；Evaluator 在执行者之外启动系统，用浏览器自动化工具 Playwright 检查页面操作、API 和数据库状态。

这三个名字描述的是实验分工，不是固定的产品层次。Planner 补的是范围：简短要求若没有先展开成完整的产品能力，Generator 可能只实现眼前最容易展示的部分。Evaluator 补的是自验偏差：页面存在、按钮可点、单元测试通过，都不能证明一条用户路径已经接通。

实验一度按 sprint 工作，也就是把较大的构建拆成若干小轮。每轮写代码前，Generator 与 Evaluator 先协商验证合同（validation contract）：这一轮要交付哪些行为，测试怎样操作，应该观察到什么结果。条件冻结后才进入实现。这样做的目的，是避免执行者先看到自己的代码，再把“完成”改写成现状刚好能通过的样子。

假设工作项是增加登录功能，“存在登录页面”只描述了一个界面；可执行的条件需要走完整路径：注册新账号，用该账号登录，访问受保护接口并确认返回正确身份，再用错误密码检查拒绝分支。编译和单测检查局部代码，端到端测试检查组件是否接通，状态断言再确认数据库或外部系统中的结果。它们覆盖不同盲区，不是从低到高互相替代。

Anthropic 在[评测方法说明](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)中区分了交互记录（transcript）和最终结果（outcome）。一次订票任务里，Agent 回复“已经预订”仍只是交互记录；环境中确实存在参数正确的预订记录，才是可检查的结果。代码任务同样如此：最后一条消息和进度摘要有助于定位做过什么，但只有指向特定候选版本的测试输出、用户路径和持久化状态，才足以推进完成状态。

外部验收也不等于再找一个模型投票。可编码的条件优先交给编译、测试和状态断言，跨组件主路径交给端到端测试；交互质量、视觉一致性或可维护性等开放判断，才适合交给带评分准则（rubric）的模型评估。确定性检查可能脆弱，模型评分则不稳定，两者都不构成单独充分的裁判。

Evaluator 自己也需要回归。Anthropic 记录过早期 Evaluator 找到真实问题后，又说服自己问题不严重并批准交付；深层交互也容易漏测。官方材料说明研究者会人工读日志，并据此调整 QA prompt。基于这一失败模式，本文进一步建议把已经由人工判定对错的边界案例留作校准集，在 prompt 或模型变化后重新运行。独立 context 减少了执行者给自己放行的倾向，却没有消除模型评分的偏差。

“完成”由此指向约定的候选版本，以及按实现前条件检查过的环境结果。但如果保存事件的进程、控制循环和运行代码的容器一起消失，再好的验收合同也无法恢复。

## 日志、控制和执行必须能分别恢复

Anthropic 在 2026 年 4 月公开的 [Managed Agents 参考架构](https://www.anthropic.com/engineering/managed-agents)回顾了早期实现的故障：session、Harness 与 Sandbox 曾放在同一容器中，容器失效会连同 Session 一起丢失，也很难判断问题出在事件历史、控制逻辑还是工具环境。新的架构把职责拆开：

| 组件 | 负责什么 | 故障后怎样继续 |
|---|---|---|
| Model | 根据当前 context 推理并选择动作 | Harness 重新装配输入，不依赖模型保存任务状态 |
| Harness | 调用模型、路由工具、消费并写入事件 | 新实例从外部 Session 恢复控制循环 |
| Session | 在 Harness 之外保存只追加、不原地改写的事件日志 | 保留输入、输出和工具调用，供 Harness 查询与转换 |
| Sandbox | 运行代码、shell、浏览器及文件操作 | 丢弃旧环境，按配方重建并恢复已持久化工件 |

大写的 Session 在这里是架构组件，不是“一次聊天”的同义词；它与模型当前读取的 context 也不是一回事。Session 可以保存比一次模型调用更长的历史，Harness 只选择当前需要的事件、规格、代码状态和失败证据来组装 context。完整历史留作查询和审计，不必每轮全部塞给模型。

这种拆分让故障有了明确归属。Sandbox 掉线时，Session 中已经写入的事件和仓库中的持久工件仍在，Harness 可以创建新环境；Harness 崩溃时，新实例读取 Session 的末尾事件，恢复模型调用和工具路由；context 被裁剪或重开时，Session 不必跟着改写。代码版本、验证证据和外部服务里的业务结果仍由各自系统保存——Session 记录发生过什么，但不是全部任务事实的唯一数据库。

任务需要继续时，一次唤醒事件可以重新触发托管执行。Harness 取得 Session，选择相关历史和任务工件组成 context，调用模型；工具请求被送到 Sandbox，结果再追加回 Session。模型需要继续时进入下一次循环，需要等待外部结果时便退出。控制进程无须和某个 Session 绑定到任务结束，Sandbox 也无须为了保存聊天历史一直存活。

组件边界也决定凭证边界。公开架构给出的原则是让长期凭证留在 Sandbox 之外：Git 凭证可在环境初始化时绑定到仓库 remote，使 Agent 不直接读取 token；外部工具的 OAuth token 可保存在外部密钥库（vault），由受限代理代表 Session 调用服务。这样能缩小生成代码直接读取长期密钥的暴露面，却不能替代最小权限、操作审批和业务授权。

到这里，早期交班工件各自有了稳定位置：项目文件和版本进入耐久存储，Session 保存事件历史，Harness 决定本轮给模型什么并控制工具调用，Sandbox 是可替换的执行现场。至于一次 context 保留多久、任务是否拆成 sprint、是否每轮都运行独立 Evaluator，并不属于同一层的固定边界。

## 脚手架要用失败数据续费

稳定的是状态和责任边界，可变的是为某个模型失败模式增加的补偿机制。context 压缩（compaction）把早期历史缩成摘要，在较低输入成本下保留连续性；context reset 则结束当前输入，依靠结构化交接开启新会话。前者可能漏掉后来才显得重要的细节，后者增加重新定向的成本，也更依赖交班材料完整。两者没有脱离模型和任务的固定赢家。

[Anthropic 的应用实验](https://www.anthropic.com/engineering/harness-design-long-running-apps)展示了策略如何随 Claude 模型变化。Sonnet 4.5 在 context 接近上限时容易提前收尾，自动压缩没有缓解，研究者因此加入 reset。换成 Opus 4.5 后，相同行为减弱，他们删除 reset，让自动压缩维持连续会话。到 Opus 4.6，研究者又删除 sprint，不再逐段 build/QA，而是在一次完整构建后统一验收。

这些删改不是在宣告某种机制过时。reset 原本补偿接近 context 上限时的收尾倾向，sprint 原本把超出能力边界的构建拆成可验收片段；当模型能在更长的连续 context 中完成完整构建时，两者反而增加冷启动、合同协商和多轮 QA 的成本。最终外部验收仍然保留，变化的是补偿路径，不是对结果负责的原则。

角色也要接受同样的检验。实验的消融——一次只移除一个组件做对照——显示，拿掉 Planner 后 Generator 会缩小需求范围。Evaluator 的价值则集中在模型能力边缘：它能抓住展示型占位和缺失的关键交互；对模型已经稳定完成的部分，额外 QA 可能只增加时间和 token。角色名称不重要，重要的是它所补偿的失败是否还能在目标任务上观察到。

并行 Agent 数量同样属于可变机制。[Anthropic 的 C 编译器实验](https://www.anthropic.com/engineering/building-c-compiler)在进入编译 Linux 内核这类难拆分阶段后，多个 Agent 会撞上同一个故障并互相覆盖。并行只有在工作单元能够独立领取、修改范围冲突可控、结果可以分别验收时才有意义；任务无法分解，增加执行者只会放大竞争。这个案例说明的不是“多 Agent 无效”，而是并行度也应由任务结构和失败数据决定。

评估 Harness 时，应固定任务集和完成标准，每次只关闭 reset、强制分块、独立 Evaluator 或并行执行中的一项，再比较成功率、返工、真实经过时间和 token。观测数据也要服务于诊断：模型和 prompt 版本说明输入条件，工具错误与候选提交定位执行问题，状态版本和重新定向耗时反映恢复成本，最终证据与人工裁决检查验收是否放水。若删掉 Evaluator 的同时放松完成标准，成本下降也不能说明它已经多余。

## 从五类状态开始，而不是从多 Agent 平台开始

下面是一套基于上述公开实践推导的最小方案，不是 Anthropic 公布的 SDK、存储格式或产品协议。起点不是复杂调度，而是让每个问题都有明确的权威来源。

| 状态 | 回答的问题 | 最小载体 | 推进规则 |
|---|---|---|---|
| 任务定义 | 做什么，怎样算完成 | 有版本的 spec / feature list | 需求确认后更新；执行者不能为迁就实现而改写 |
| 工作账本 | 当前做到哪里 | 工作项 ledger | 领取、失败、阻塞或验证通过时追加记录 |
| 交付物 | 实际产出了什么 | Git commit / 构建产物 | 工具执行后先形成可恢复的候选版本 |
| 验证证据 | 哪个版本满足什么条件 | 测试输出、截图、状态断言 | 验证器针对工作项和候选版本生成 |
| 临时现场 | 当前运行着什么 | 进程、端口、容器缓存 | 随运行创建，故障时重建，不作为任务真相 |

范围看 spec，文件看仓库，完成状态看与版本绑定的证据。交接摘要只是从这些来源提取的阅读入口，写错时可以重新生成。一个 `passed` 条目如果找不到对应 commit 和可复查证据，就应退回待验证，而不是根据进度说明猜测。

单 Agent 串行系统先守住四条约束就够了：基线不通过时不领取新任务；一次只推进一个有边界的工作项；验证证据同时指向工作项和候选版本；只有证据通过，账本才能进入 `passed`。这些规则可以由程序检查，比保存一篇很长的总结更可靠。

只有在需要处理进程崩溃或并发时，才增加三件东西：`run_id` 用来关联一次尝试、候选版本和验证证据；带过期时间的执行租约（lease）防止崩溃进程永久占住工作项；状态对账（reconciliation）检查“证据已通过但账本未推进”或“账本通过但证据缺失”之类的部分更新。这三项是生产化建议，Anthropic 的公开示例没有给出通用 schema 或跨存储事务协议。

最小控制循环可以写成：

```python
while budget_ok() and has_pending_item():
    env = rebuild(last_trusted_commit())
    require(baseline_passes(env))

    item, run_id = acquire_one_item(with_lease=True)
    contract = freeze_validation(item)
    candidate = run_agent(env, item, contract)
    candidate_ref = persist_candidate(candidate, run_id)

    evidence = verify(candidate_ref, contract)
    persist_evidence(item, run_id, candidate_ref, evidence)
    promote_if_passed(item, candidate_ref, evidence)
    reconcile_partial_updates()
    stop_if_stalled_or_approval_needed()
```

这里有两个不同动作：候选版本先持久化，保证验证期间崩溃后仍能找到；只有外部验证通过，它才被提升为 `last_trusted_commit`，成为下一轮恢复的起点。唤醒下一轮也要发生在账本、候选引用和证据都完成耐久更新之后，避免新的执行者读到旧账本并重复领取。

停止条件同样不能留给模型自述。预算耗尽、同一失败反复出现、连续几轮没有可验收进展、依赖服务不可用或操作需要审批时，Harness 应结束或挂起循环。具体阈值由业务风险和成本决定，不存在从这些实验中得出的通用数字。

代码仓库中的重试还不能直接推广到所有工具。付款请求如果在响应前断线，本地无法判断服务端是否已经扣款；这类外部副作用不能像 Git 修改一样从检查点（checkpoint）盲目重做。Harness 应先用业务键或幂等键——让重复请求被识别为同一次业务操作的唯一标识——查询结果，再决定重试、对账或补偿。外部系统没有查询、幂等、审批或补偿能力时，不应把该操作交给无人值守的长运行循环。

复杂 Harness 只在三个条件同时出现时开始划算：任务确实会跨 context 或基础设施故障边界；交付物存在机器可检查的结果；中断恢复的价值高于额外的状态与验证成本。短时间内能完成、人工检查很便宜、需求还在快速变化的工作，保留 Git、启动脚本和验收命令通常已经足够。

扩展也应由日志里的失败驱动；没有稳定复现的缺口，就不要预先增加角色、状态或并行度。

检验设计是否成立，可以在任意时刻中断执行，然后只凭留下的材料回答三个问题：最后可信的版本是哪一个，下一项安全动作是什么，上一轮的验证证据在哪里。三个答案都明确时，模型升级后可以放心删除 reset、sprint 或多余角色；只要其中一个仍靠聊天记忆或进程内状态，更长的 context 只是把猜测推迟到下一次故障。

## 参考资料

- [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)，Anthropic Engineering，2025-11-26
- [Initializer prompt](https://github.com/anthropics/claude-quickstarts/blob/main/autonomous-coding/prompts/initializer_prompt.md)，Anthropic 官方 GitHub
- [Coding prompt](https://github.com/anthropics/claude-quickstarts/blob/main/autonomous-coding/prompts/coding_prompt.md)，Anthropic 官方 GitHub
- [Harness design for long-running application development](https://www.anthropic.com/engineering/harness-design-long-running-apps)，Anthropic Engineering，2026-03-24
- [Scaling Managed Agents: Decoupling the brain from the hands](https://www.anthropic.com/engineering/managed-agents)，Anthropic Engineering，2026-04-08
- [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)，Anthropic Engineering，2026-01-09
- [Building a C compiler with a team of parallel Claudes](https://www.anthropic.com/engineering/building-c-compiler)，Anthropic Engineering，2026-02-05
