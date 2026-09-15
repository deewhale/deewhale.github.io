---
layout: post
title: "Harness 工程设计：长运行 Agent 的交接与验证"
description: "沿 Anthropic 三次公开实践的演进，解释长运行 Agent 如何建立跨会话状态、外部验收、故障恢复与托管边界。"
tags: [Agent, 架构, Harness]
---

[Anthropic 2025 年的长运行 Coding Agent 实验](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)记录了两种反复出现的失败。第一种是 one-shot implementation：模型试图一次铺开整个应用，context 耗尽时，仓库里只剩一批缺少说明的半成品。第二种是 premature completion：后续会话看到页面、组件和若干测试已经存在，便把“做了很多”当成“已经完成”。自动压缩旧对话可以腾出 context，却没有自动产生可靠的交接。

问题由此从一次模型调用延伸到了整个工作过程。代码在仓库里，服务跑在执行环境里，任务范围和进度留在文档中，完成结论还要靠测试确认。任意一部分只存在于即将消失的 context 或进程内，下一轮就得猜测现场。

Anthropic 随后公开的两轮实践继续沿着这条线推进：先让新会话接得上，再把规格与外部验收接入循环，最后将会话日志、控制循环和执行环境拆成独立的托管组件。三次公开材料构成这里的事实边界；由这些实践推导的恢复协议集中放在最小实现部分。

## 一、2025：先让下一轮接得上

### 长运行的边界不在墙钟时间

“长运行”很容易被理解成几个小时甚至几天。对 Harness 来说，更有用的界线是任务是否跨过了模型内部记忆无法承担的边界。一次工作即使只持续十分钟，只要中间必须换 context、换执行者或重建容器，就已经需要交班；反过来，持续两小时但始终由人盯着、结果又能立即检查的任务，未必值得引入复杂编排。

Anthropic 最初的改造在同一套 Harness 中给首轮和后续轮使用不同初始提示。根据[实验报告](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)，initializer 创建 `init.sh`、`claude-progress.txt`、初始 Git commit，并把高层要求展开为结构化 feature list，所有功能先标记为 failing。coding agent 每轮选择一个尚未通过的功能，实现、测试、更新进度，然后提交 Git。两种角色共用 system prompt 和工具，区别主要在首轮提示，不需要两组长期驻留服务。

这几个文件各自补了一块缺口。`init.sh` 把“怎样让仓库进入可测试状态”变成可重复执行的动作；feature list 保存整个完成范围，防止后续会话因为眼前已有成果而提前收尾；进度文件留下刚做过什么以及建议从哪里继续；Git commit 则保存可以比较和回退的代码落点。模型的 context 可以更换，项目却不再随着旧对话一起消失。

官方发布的 [initializer prompt](https://github.com/anthropics/claude-quickstarts/blob/main/autonomous-coding/prompts/initializer_prompt.md)把 feature list 称为待建功能的 source of truth，并要求后续执行者只修改功能的通过状态。[coding prompt](https://github.com/anthropics/claude-quickstarts/blob/main/autonomous-coding/prompts/coding_prompt.md)则要求新会话先读规格、feature list、进度文件和 Git 历史，启动应用并重验核心路径，随后才开始新工作；发现回归时，要把相应功能改回 failing 并优先修复。

这个启动顺序很重要。新会话如果一进仓库就领取新功能，可能把环境没启动、依赖没恢复或旧代码已回归误判成当前任务的问题。先恢复现场、再跑一条短基线，可以把“上一个落点还能不能工作”和“这一轮准备改什么”分开。每轮只推进一个功能也服务于同一目的：一次提交、一次进度更新和一组验证证据尽量围绕同一个工作单元，交接时才说得清改了什么。

当时的实验还要求 Agent 使用浏览器工具从用户视角测试功能，源文件已经生成并不能满足验收。每次会话开工前重验一两个已经通过的功能，实际是在为 Git 落点做抽样回归；完成当前功能后再留下截图和进度。这样即便下一轮完全没有旧 context，也能从 feature 状态、仓库版本和可复查结果三条线重建判断。实验对象是全栈应用生成，其中“先验证旧基线、再接受新改动”的次序可以继续用于其他代码任务。

第一版 Harness 把继续工作所需的信息移到模型之外。它解决了“下一轮从哪里开始”，但没有完全解决“任务是否定义完整”和“完成判断是否可信”。feature list 可以漏项，同一个 coding agent 也可能对自己的实现过于宽松。到了 2026 年，实验的重点便从能否交班移到了交付标准。

## 二、2026：规格与验收进入循环

### Planner 补范围，Evaluator 看结果

2026 年 3 月的[长运行应用 Harness 实验](https://www.anthropic.com/engineering/harness-design-long-running-apps)使用 Planner、Generator、Evaluator 三种角色。Planner 把一到四句话的产品要求扩展成规格，重点描述产品范围和高层设计，同时避免过早写死底层实现。Generator 按规格构建应用。Evaluator 在执行者之外启动系统，使用 Playwright 从页面操作到 API 与数据库状态，检查功能是否真正接通。

三个角色通过文件交换结果，文件在这里相当于角色之间的接口。Planner 交付产品规格和初始功能范围，Generator 留下实现、运行说明与候选结果，Evaluator 读取预先约定的合同并生成 QA 证据。角色隔离的价值不在“多几个 Agent”，而在每个阶段的输入输出可以单独查看：范围缩小时能回到 Planner 的产物，代码失败时看 Generator 的执行记录，验收分歧则回到合同和测试动作。

这轮实验针对的是两个不同问题。Planner 防止短提示在实现过程中不断缩水：一个“音乐工作站”如果没有先展开轨道、编辑、播放等产品范围，Generator 很可能只实现一个能展示的界面。Evaluator 处理的则是自验偏差：页面存在、按钮可点、单元测试通过，都不等于用户路径已经完成。

当时的 sprint 设计还让 Generator 与 Evaluator 在写代码前协商 validation contract。合同约定这一轮交付哪些行为、怎样操作、观察哪个结果；达成一致后才进入实现。这个顺序防止执行者先看到自己的实现，再把“完成”修改成现有代码刚好能通过的样子。合同也给失败留下统一格式：哪一步动作未达到预期、观察到什么状态、证据对应哪个候选版本。下一轮据此修复具体缺口，无需从 Evaluator 的整段对话里重新推断问题。

以 Coding Agent 增加登录功能为例，“有登录页面”只描述了一个界面。可执行的验收条件需要走完整路径：注册新账号，用该账号登录，访问受保护接口并确认返回正确身份，再用错误密码检查拒绝分支。编译和单测可以确认局部代码，浏览器与 API 测试检查组件之间是否接通，截图或状态断言则把结果留给下一轮复核。规格描述产品边界，验证合同描述可以观察到的行为，两者之间不能靠一句“功能已完成”补齐。

### 完成是一种环境状态

Anthropic 在[Agent 评测方法](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)中把 transcript 和 outcome 分开：transcript 是一次 trial 的交互记录，outcome 是结束时环境中的最终状态。订票 Agent 回复“已经预订”仍属于 transcript；数据库里存在参数正确的 reservation，才构成可检查的 outcome。

同样的区分适用于代码任务。Agent 说测试通过，只能帮助定位它做过什么；仓库中对应版本的测试输出、运行中的用户路径和持久化数据，才支持把工作项推进为完成。可编码的条件优先交给编译、测试和状态断言；跨组件的主路径使用端到端测试；交互质量或可维护性等开放判断再交给带 rubric 的模型评分。这里不存在从低级到高级的替代关系，每种检查都覆盖不同盲区。

Evaluator 也会犯错。Anthropic 记录过早期 QA 找到真实问题后，又说服自己问题不严重并批准交付；深层交互依旧容易漏测。研究者需要人工读日志，收集与人工判断不一致的样例，继续调整 rubric、示范与提示。独立 context 减少了执行者给自己放行的倾向，却没有让模型评分变成确定性裁判。

因此，Evaluator 的输出也要像产品代码一样接受回归。“看到了缺陷却最终放行”“主路径通过但深层操作失败”这类边界案例尤其适合进入校准集。prompt 或模型变化后重新运行这些人工裁决过的样例，才能知道 QA 是更严格了，还是换了一种解释。外部验收把判定责任移出执行者，判定过程本身仍需检查。

从这一轮实践开始，Harness 管理的“完成”指向针对约定版本、按预先确定的条件检查过的 outcome；Generator 的最后一条消息只保留在 transcript 中。接下来要处理的是托管问题——如果保存事件的进程、控制循环和执行代码的容器一起消失，再好的验收合同也无法恢复。

## 三、Managed runtime：让日志、控制和执行分别恢复

### Session、Harness、Sandbox 的职责

Anthropic 在 2026 年 4 月公开的 [Managed Agents 架构](https://www.anthropic.com/engineering/managed-agents)回顾了早期实现的一个故障：session、Harness 与 Sandbox 曾经放在同一容器里，容器失效会把 Session 一起带走，也很难判断究竟是事件流、控制逻辑还是工具环境出了问题。新的参考架构把这些职责拆开。

| 组件 | 负责什么 | 故障后怎样继续 |
|---|---|---|
| Model | 根据当前 context 推理、选择下一项动作 | Harness 重新装配输入，不依赖模型保存任务状态 |
| Harness | 调用模型、路由工具、消费并写入事件 | 新实例从外部 Session 恢复控制循环 |
| Session | 在 Harness 之外追加保存输入、输出与工具调用事件 | 保留历史，供 Harness 查询和转换 |
| Sandbox | 运行代码、shell、浏览器及文件操作 | 丢弃旧环境，按配方重建并恢复工件 |

拆开之后，故障才有明确归属。Sandbox 掉线时，Session 里的已确认事件和仓库工件仍然存在，Harness 可以创建新环境继续；Harness 进程崩溃时，新实例读取 Session 最后的事件，再恢复模型调用与工具路由；context 被裁剪或重开时，完整 Session 不必跟着改写，Harness 只选择当前需要的事件组装新输入。

一轮托管执行可以由 wake 事件重新触发：Harness 取得 Session，选择相关历史与任务工件组成 context，调用模型；模型发出工具请求后，Harness 把它路由到 Sandbox，并把结果追加回 Session。模型需要继续时进入下一次循环，需要等待外部结果时则暂时退出。控制进程无需和某个 Session 绑定到任务结束，Sandbox 也无需为了保存聊天历史而一直存活，扩缩容和故障替换才有了实际空间。

这里也划清了 Session 与 context 的关系。Session 是外部的 append-only event log，可以比一次模型调用保存更长的历史；context 是 Harness 当前交给模型的有限切片。代码版本、测试证据以及外部服务中的业务结果仍留在各自系统里。Session 保存发生过的事件，仓库回答有哪些文件，验证记录回答哪个版本通过，外部系统回答副作用是否落地。

追加日志的意义在于旧事件不会因为一次摘要重写而消失，恢复者可以追到某个工具结果在何时被确认。它并不要求每轮把全部历史重新塞给模型。Harness 可以把最近事件、任务规格、当前代码状态和失败证据按需要组合，完整历史留作查询与审计。于是“保留多久”与“本轮读取多少”成为两个独立参数，既不必用 context 容量绑住恢复能力，也不必让日志规模直接决定每次调用成本。

托管边界也覆盖凭证。[同一篇 Managed Agents 文章](https://www.anthropic.com/engineering/managed-agents)描述了两种处理：Git 凭证在 Sandbox 初始化时绑定到仓库 remote，使 Agent 可以 push/pull 而不直接读取 token；MCP OAuth token 存在外部 vault，由专用代理代表 Session 调用服务，Harness 同样不接触原始凭证。这样可以缩小生成代码读取长期密钥的暴露面，但工具授权是否过宽、操作是否需要审批，仍要由业务权限设计解决。

这一步完成后，早期做法里的几个要素获得了稳定位置：交接工件留在耐久存储，Session 负责事件历史，Harness 决定每轮给模型什么并处理工具调用，Sandbox 作为可替换的执行环境。至于一次 context 要保留多久、任务是否拆成 sprint、需不需要独立 Evaluator，并不属于同一层的固定边界。

这也是长运行任务能够被日常运维，而不只是被持续观察的前提。

## 四、模型升级后，哪些机制被删掉了

### Reset 和 compaction 没有固定赢家

Compaction 把当前会话较早的历史压缩成摘要，以较低成本保留连续性；context reset 则结束当前输入，依靠结构化交接开启新会话。两者都会损失信息。前者可能漏掉后来才显重要的细节，后者增加重新定向的成本，也更依赖交班工件完整。

[Anthropic 对不同模型的实验记录](https://www.anthropic.com/engineering/harness-design-long-running-apps)说明了这种策略为什么不能固化。Sonnet 4.5 在 context 接近上限时容易提前收尾，自动 compaction 没能缓解，研究者因此加入 reset。换成 Opus 4.5 后，同一行为减弱，他们删除 reset，让自动 compaction 维持连续会话。到 Opus 4.6，研究者又移除 sprint，不再逐段 build/QA，而是在一次完整 build 后统一验收。

每项机制都对应过具体的模型行为。reset 用于清掉接近上限时的收尾倾向，sprint 用于把超出能力边界的构建拆成可验收片段。当模型能在更长连续 context 中完成完整 build 时，这两项机制会额外制造冷启动、合同协商和多轮 QA 成本。最终外验在删改后仍然保留；变化发生在补偿路径，对 outcome 负责的验收原则没有撤掉。

Planner 被保留下来，因为消融实验显示，拿掉 Planner 后 Generator 会缩小需求范围。Evaluator 的价值则集中在模型能力边缘：它能抓住展示型占位、缺少关键交互等问题；对模型已经能稳定完成的部分，额外 QA 可能只增加运行时间和 token。角色名称本身没有稳定性，稳定的是它所补偿的失败是否仍然存在。

Harness 因而需要和模型一起回归。准备一组覆盖长 context、模糊规格、深层交互和中断恢复的任务，固定验收口径，每次只关闭 reset、强制分块或独立 Evaluator 中的一项，再比较成功率、返工、墙钟时间和 token。只跑一个顺利样例没有意义；如果去掉 Evaluator 的同时也把完成标准放松，成本虽然下降，却无法说明该机制已经多余。

观测数据还要能定位失败来自哪里。至少记录模型与 prompt 版本、每轮读入的状态版本、重新定向耗时、工具错误、候选提交和最终证据。新模型让成功率上升但恢复时间变长，可能意味着它更能持续实现，却更依赖旧 context；删除 reset 后 token 下降但返工增加，则说明交班材料还不足。消融的目标不是把组件越删越少，而是找出每项复杂度正在换取什么。

多 Agent 调度也应该接受同样的检验。Anthropic 的[C 编译器实验](https://www.anthropic.com/engineering/building-c-compiler)使用 16 个并行 Agent、接近 2,000 个会话，API 成本约 2 万美元；进入编译 Linux 内核这类难以拆分的阶段后，多个 Agent 会撞上同一个故障并互相覆盖。并行要建立在可独立领取、写集冲突可控、结果可分别验收的工作单元上。任务无法分解时，增加执行者只会放大竞争。

这些删改揭示了 Harness 中两种不同寿命的机制。耐久状态、环境重建、外部验收和故障归属跟着工作过程存在；reset、sprint、Evaluator 的运行频率以及 Agent 数量，跟着具体模型和任务的失败数据变化。模型升级时如果只换模型、不重做消融，旧脚手架就会继续收取延迟和费用。

## 五、最小实现与适用边界

### 状态权威和恢复协议

下面是一套从上述公开实践推导出的工程方案，不代表 Anthropic 已公布的产品协议。最小系统先把状态按用途分开，不必一开始建设复杂的多 Agent 平台。

| 状态 | 回答的问题 | 最小载体 | 更新条件 |
|---|---|---|---|
| 任务定义 | 做什么，怎样算完成 | 有版本的 spec / feature list | 需求确认后更新，执行者不能为迁就实现而改写 |
| 工作账本 | 当前做到哪里 | work-item ledger | 领取、失败、阻塞或验证通过时追加记录 |
| 交付物 | 实际产出了什么 | Git commit / 构建产物 | 工具执行后形成可恢复版本 |
| 验证证据 | 哪个版本满足了什么条件 | 测试输出、截图、状态断言 | 验证器针对对应版本生成 |
| 临时现场 | 当前运行着什么 | 进程、端口、容器缓存 | 随运行创建，故障时直接重建 |

权威跟着问题走：范围看 spec，文件看仓库，完成状态看指向该版本的证据。handoff 从这些来源提取阅读摘要，写错时可以重新生成。若一个 `passed` 条目找不到对应 commit 和证据，恢复动作就是退回待验证，下一轮不需要根据进度说明猜测。

几条状态转换足以支撑最初版本：基线不通过时禁止领取新任务；工作项领取后只能由持有执行权的运行更新；验证证据必须同时标出工作项和候选版本；账本只有在证据通过后才能进入 `passed`。这些约束比保存一篇长总结更有效，因为进程重启后仍能用程序检查。摘要负责降低阅读成本，不参与裁决事实。

需要处理进程崩溃或并发时，再增加三个最小字段。`run_id` 把一次尝试、候选 commit 和验证证据关联起来；带期限的 lease 表示当前工作项由谁执行，进程消失后可以回收；reconciliation 检查“证据已通过但账本未推进”或“账本通过但证据缺失”的部分更新。候选 commit 只有经过外部验证才成为下一轮采用的落点。对单 Agent 串行系统来说，这些设计也能把恢复判断从内存和聊天摘要中移出来。

进程如果恰好在验证完成、账本更新之前退出，新的运行先按 `run_id` 找到候选版本和证据：证据仍能复查就补齐账本，证据已经失效就重新验证。它不重复执行模型，也不凭一次旧的 `passed` 标记推进。reconciliation 的用途到这里已经足够，不需要为了最小版本先建设通用事务系统。

### 一条够用的控制循环

最小控制循环可以写成：

```python
while budget_ok() and has_pending_item():
    env = rebuild(last_good_commit())
    require(smoke(env))

    item = acquire(run_id, lease_ttl)
    contract = freeze_validation(item)
    candidate = run_agent(env, item, contract)
    evidence = verify(candidate, contract)

    persist(candidate, evidence)
    promote_if_passed(item, candidate, evidence)
    reconcile_partial_updates()
    stop_if_stalled_or_approval_needed()
```

循环从重建环境和短基线开始。基线失败时先修复旧落点，不领取新任务；基线通过后才领取一个有边界的工作项并冻结验收条件。执行者产生候选版本，独立验证针对该版本检查 outcome，通过后再推进账本。唤醒下一轮要发生在这些耐久更新之后，避免新执行者读到旧账本并重复领取。

停止条件和成功条件一样要外置。预算耗尽、同一失败连续出现、几轮都没有产生可验收进展、依赖服务不可用或操作需要审批时，调度器结束或挂起循环。模型可以提出继续和完成，但它读不到团队全部预算，也不能替代权限策略。把停止权放在 Harness，既防止错误方向无限放大，也给人工接管留下一个明确入口。

付款只需作为一个改变重试策略的反例：请求在响应前断线时，本地不知道服务端是否已经扣款，不能像 Git 修改一样从 checkpoint 直接重做。此类工具必须先用业务键或幂等键查询结果；系统没有幂等、审批、对账或补偿能力时，就不应交给长运行循环自动重试。

采用范围可以用三条条件判断：任务会跨 context 或基础设施故障边界；交付物存在机器可检查的 outcome；中断后恢复的价值足以覆盖额外的状态与验证成本。短时可完成、人工检查很便宜、需求仍在快速变化的工作，保留 Git、启动脚本和验收命令往往已经足够。日志若显示新会话经常重新调查，再改善交班；规格持续缩水，再加 Planner；自验稳定漏错，再加入独立 Evaluator；工作单元能够真正隔离以后，才考虑并行。

最后只问一个恢复问题：执行随时中断后，系统能否仅凭留下的材料确定最后可信状态、下一项安全动作以及上一轮的验证证据？如果答案是肯定的，模型升级时就可以放心删除 reset、sprint 或多余角色；如果答案是否定的，再长的 context 也只是把猜测推迟到了下一次故障。

## 参考资料

- [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)，Anthropic Engineering，2025-11-26
- [Initializer prompt](https://github.com/anthropics/claude-quickstarts/blob/main/autonomous-coding/prompts/initializer_prompt.md)，Anthropic 官方 GitHub
- [Coding prompt](https://github.com/anthropics/claude-quickstarts/blob/main/autonomous-coding/prompts/coding_prompt.md)，Anthropic 官方 GitHub
- [Harness design for long-running application development](https://www.anthropic.com/engineering/harness-design-long-running-apps)，Anthropic Engineering，2026-03-24
- [Scaling Managed Agents: Decoupling the brain from the hands](https://www.anthropic.com/engineering/managed-agents)，Anthropic Engineering，2026-04-08
- [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)，Anthropic Engineering，2026-01-09
- [Building a C compiler with a team of parallel Claudes](https://www.anthropic.com/engineering/building-c-compiler)，Anthropic Engineering，2026-02-05
