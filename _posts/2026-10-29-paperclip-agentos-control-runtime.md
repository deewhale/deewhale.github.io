---
layout: post
title: "Paperclip 与 Agno AgentOS：任务协作、执行管理与平台边界"
description: "沿任务领取、执行接入、持久队列与结果审查，比较 Paperclip 和 Agno AgentOS Company 的状态、恢复、审批与预算边界，说明何时选用以及怎样组合。"
image: /assets/images/posts/paperclip-agentos-control-runtime-mechanism.png
image_alt: "Paperclip 的 Issue、run、adapter 与实际 harness 执行链，对照 Agno Company Task 经 run 接口和持久队列到本地 executor、交付后待审的职责关系"
date: 2026-10-29 10:08:20 +0800
display_date: 2026-10-29
categories: [AI, Engineering]
tags: [Paperclip, Agno, AgentOS, AI Agent, Agent Harness]
---

一个 Agent 已经能接任务、调用工具并返回结果，仍然会留下另一组问题：这项工作交给了谁，运行失败后由谁处理，产出经过谁确认，重新启动会不会重复执行？当执行者分散在不同程序和服务里，这些问题尤其难以沿一条记录查清。

Paperclip 与 Agno AgentOS 都在处理这组问题。Paperclip 以组织、Issue 和唤醒机制组织工作，通过 adapter 连接执行环境。Agno 从 Agent、Team、Workflow 的执行框架发展到服务运行层；当前的 Company 也有长期任务、范围确认、结果审查，并已接入 AgentOS 的运行接口和持久队列。

因此，选择时应比较的是：**工作怎样交给执行者，任务状态怎样与实际运行对齐，失败与批准分别在哪一层生效。**把两者简单分为“任务管理”和“Agent 执行”，会漏掉已经重叠的部分；根据两个产品名称中的组织隐喻判断能力，也看不到接入代价。

以下以 Paperclip `v2026.1023.0`、Agno `v3.1.11` 为源码基线，资料核查截至 2026 年 10 月 29 日。涉及在线文档时，以当日官方说明为准。分析依据是公开源码和官方原型，没有部署这两个平台、执行模型调用或进行宕机实验。Agno SDK 内部的工具循环与成员委托，已在[《Agno SDK：Agent、Team 与 Workflow 的执行机制》](/posts/agno-sdk-execution/)中展开；这里从长期任务进入运行层，追踪状态的归属与交接。

## 先把一项工作与一次执行分开

Agno 仓库的 `cookbook/05_agent_os/30_company/06_execute_tasks.py` 给出了一个适合观察这条路径的官方原型。它创建名为 `SDK` 的 Product、名为 `Release` 的 Project，以及标题为 `Draft release notes` 的 Task。Task 的 brief 是整理经过审查的变更，证据字段保存对应的来源说明。

这个原型没有让模型撰写发布说明。注册的 `draft` Workflow 只有一个确定性函数步骤：读取输入中的 `brief`、`wiki`、`evidence`、`execution_context`，返回以 `Draft ready for review:` 开头的字符串。它用最少的执行内容，展示任务如何进入平台、得到运行结果，再等待审查。以下沿这段官方代码解析状态流转，不把它当成真实发布工作的效果证明。

默认创建的 Task 在 `backlog`。接受任务时，调用者将它转为 `ready`，说明接受原因，并绑定 `executor_type="workflow"`、`executor_id="draft"`。这一步确定了谁来执行、按什么范围执行，还没有开始运行。

随后向 `/company/tasks/{id}/runs` 提交 `attempt: 1`，才进入实际执行链。源码保存任务与本次执行的关联，任务进入 `in_progress`；持久队列中的 worker 执行已注册的 Workflow。官方原型重复提交同一 attempt，断言得到同一个 `run_id`，再查询 Task，直到它成为 `in_review`。此时运行结果的状态已经是 `COMPLETED`，任务仍等待审查。

这条路径里至少有四种不同对象：

| 对象 | 回答的问题 | 在官方原型中的作用 |
|---|---|---|
| Task | 这项工作是什么，谁接受了什么范围 | 保存 brief、证据、执行者和工作状态 |
| run | 这一次执行发生了什么 | 保存状态、结果及相应运行信息 |
| session | 多次相关执行怎样连续使用上下文和记录 | 同一 Task 保留会话，后续 attempt 沿用它 |
| queue job | 哪个 worker 负责领取和推进执行 | 持久保存待执行负载、领取状态和尝试信息 |

它们相互关联，但不会同时完成。“run 已完成”意味着执行过程得到了结果；“Task 已完成”还需要按任务的要求确认结果。原型的自动化分支也明确展示了审查者另行将 Task 转为 `done`。如果结果需要修改，可以在任务规则允许的状态下调整范围、重新接受并启动新的 attempt，任务身份无需随之消失。

Paperclip 也有类似的分离。Issue 表达持续存在的工作，heartbeat run 表达一次被唤醒后的执行窗口。同一 Issue 可以经历多次工作、交接和后续唤醒。一次进程退出成功，只能说明某次执行的结果，Issue 是否已经满足交付要求，还要看任务状态和执行策略。

由此可以确定第一个比较前提：两者都需要把“做事的过程”与“工作已经交付”分开。差异主要出现在它们怎样把工作交到实际执行程序手中。

## Paperclip 把工作交给不同 harness

Paperclip 的组织树表达汇报和升级关系。官方 Org Structure 说明每个 Agent 有一个直属经理，组织结构不允许循环，同时允许跨团队分派工作。这有助于回答谁负责、问题向谁升级，却不能直接当作执行步骤的依赖图。管理者 Agent 何时拆分目标、怎样指派，仍然需要运行中的判断；数据库里存在上下级关系，不会自动产生合理计划。

到了可执行的工作单，服务端开始处理更明确的约束。`server/src/services/issues.ts` 的 `checkout` 路径先核对可指派的 Agent、暂停限制和未解除的阻塞依赖，再尝试把 Issue 置为 `in_progress`。更新条件带上允许的原状态、分派者以及 `checkoutRunId`、`executionRunId` 等占用信息。

这使领取成为一个有条件的状态变更。两个执行者同时看见同一张待办单，并不意味着它们都能成功领取；更新竞争失败后，代码重新检查当前记录，只有满足相应条件才处理过期引用或接管，否则报告冲突。这里保护的是任务占用关系。即使领取只成功一次，也不能由此推导任务中的每个外部 API 只会调用一次。

这个领取接口由执行者在 heartbeat 窗口中调用。heartbeat 可以由时间或事件唤醒，携带任务、唤醒原因和连接上下文，先通过 adapter 启动执行者。Agent 再通过 Paperclip 的接口读取任务、领取工作、回报进展和状态。仓库中的 `skills/paperclip/SKILL.md` 描述了执行者应遵守的工作方式。读者需要同时看到两种约束：服务端能检查领取条件和状态更新；执行者是否按说明先读任务、补充说明，则还涉及 harness 中的模型和程序怎样使用这些接口。

这里的 harness 可以理解为让 Agent 真正工作的执行环境：它负责模型交互、工具、上下文以及会话推进。Paperclip 通过 adapter 与这些环境连接。adapter 的价值不只在“能发送请求”，更在于能取回多少运行证据、保留多少会话关联，以及能否停止实际执行。

HTTP adapter 的实现能清楚展示这个边界。固定版本的 `server/src/adapters/http/execute.ts` 将配置模板与 `agentId`、Paperclip 的 `runId`、上下文、连接说明等字段合成 JSON，发送给目标地址。非 2xx 响应会抛错；2xx 响应则返回 `exitCode: 0`。这个函数没有读取响应体，也没有从响应中提取远端 `run_id`、session 或 usage。

所以，同一个 HTTP 成功，在两端可能代表不同的事情。远端返回 202，可以表示“已经接单，稍后执行”；HTTP adapter 此时会认为这次调用成功。它没有因此证明远端 Agent 已经做完，更没有证明 Issue 达到了交付条件。若把 HTTP 成功直接映射为工作完成，状态就会在这里提前走到终点。

超时也有相同边界。该函数使用 `AbortController` 中止等待中的 HTTP 请求。停止等待，不会自动变成远端作业的取消指令。远端可能已经入队、正在使用工具，甚至已经完成了外部写入。能否停止它，要看后续是否存在可定位的作业标识、取消接口和终止回执。

这是 HTTP adapter 这条具体路径的行为。Paperclip 的其他 adapter 可以有更深的进程、会话和恢复集成，不能把一个薄 HTTP 入口的边界推广为所有 adapter 的能力上限。采用 Paperclip 时，值得逐一检查的正是目标执行环境对应的 adapter：**它连接的是一个请求，还是一个能持续观察和控制的执行过程。**

## AgentOS Company 把任务接入已有运行层

Agno Company 走的是另一条接线方式。它是显式开启的能力：配置 `CompanyConfig` 后，`libs/agno/agno/os/app.py` 才注册 Company 的产品、项目、任务和执行等路由。Company 可以使用 AgentOS 的数据库，也可以单独配置数据库。这已经是运行服务中的接口，不只是 SDK 里孤立的一组数据类。

前面的官方原型把 `draft` Workflow 放进 `Registry`。Registry 是 AgentOS 查找执行者的注册表，Company Task 接受执行者时引用其类型和 ID，开始运行时再次检查。`libs/agno/agno/company/execution.py` 的 `_executor` 只接受已注册的 Agent、Team 或 Workflow；执行阶段明确拒绝 `RemoteAgent`、`RemoteTeam` 和 `RemoteWorkflow`，因为这条 Task 路径要求使用持久队列支持的本地执行者。

“本地”在这里指运行层能够解析和调用的执行组件，并不意味着只能调用进程内部的数据。工具仍然可以访问远程服务。Agno 也提供外部框架的接入方式，不能从 Company 这一处检查推出整个 AgentOS 只支持 Agno 原生实现。需要区分的是：可注册到本地运行层的执行组件，与代表远端执行的 Remote 对象，不是同一种接入关系。

任务启动路由随后复用普通运行接口。`libs/agno/agno/os/routers/company/runs.py` 的 `_run_route` 通过内部 ASGI 调用进入相应的 Agent、Team 或 Workflow 路由，携带可信的授权上下文。Task 的 brief、知识和证据被组装为执行输入；任务关联、session、run 与持久队列沿已有执行链处理。

队列提交与 Task 更新之间也有明确次序：先接受持久 ticket，再把 Task 置为 `in_progress`。如果提交进程在两者之间停止，worker 可以恢复这次任务状态更新。若任务接受的范围已经改变，提交会冲突，等待中的 ticket 被取消；已经领取的 ticket 也由 worker 检查并拒绝。两处存储不会因为有同一个任务 ID 就自动保持一致，这些检查承担了协调责任。

这让 Company 不必重新实现一套模型与工具循环。Task 负责说明被接受的工作和执行范围，普通 run 路径负责执行。运行结束后，Company 再将结果映射回工作状态，成功结果进入 `in_review`。需要人工确认的原因也因此清楚：运行层知道程序返回了什么，却无法仅凭正常结束，判断这份结果已经满足任务的验收要求。

Task 的身份还能跨越多次执行。官方 Company README 说明，运行尚活跃时，同一 attempt 的重复启动返回已有运行关联；任务进入 `in_review` 后，再提交旧 attempt 则返回冲突。新的工作尝试使用后续 attempt，并保留任务的 session。这里有两种不同编号：Company 的 attempt 表示这项工作第几次被启动；队列内部的 attempt 则用于某次 run 被 worker 重试。两者都叫“尝试”，解决的问题不同。第一次工作启动对应的 run，也可能因 worker 故障发生内部重试。

同样不能靠修改 Task 状态停止执行。Company 的规则明确限制：当对应 run 仍在执行，或暂停等待批准时，不能仅把 Task 改回另一个工作状态，便假定执行已经结束。需要先处理实际 run，再让任务状态反映结果。否则任务列表虽然显示空闲，旧执行仍可能继续调用工具。

从这条路径看，AgentOS Company 的主要便利来自共用运行基础设施。执行者已经能够注册到这个运行层时，任务、会话、运行结果和队列之间有现成的关联。代价也在同一处：必须满足该执行路径的组件、存储与持久化条件，不能把任意远端作业当作一个本地 executor 直接纳入。

![Paperclip 的 Issue、run、adapter 与实际 harness 执行链，对照 Agno Company Task 经 run 接口和持久队列到本地 executor、交付后待审的职责关系](/assets/images/posts/paperclip-agentos-control-runtime-mechanism.png)

*图：两套系统各自的工作与执行路径。箭头表示执行接入的职责关系，不代表全部 API 调用时序；Paperclip 的 checkout 由 adapter 启动后的执行者调用。两行之间没有现成跨平台集成。*

图中 Paperclip 把执行交到 adapter 对应的 harness，AgentOS Company 则把 Task 交进已有运行接口和队列。两条路径都要从执行结果回到工作状态；区别在于这一段关联由哪套运行基础设施维护。下一步需要检查的，正是执行过程突然消失时，这条关联还能保留什么。

## 持久接单、重新执行与从断点继续

任务与运行关联起来后，最容易被一句“支持恢复”掩盖的，是故障究竟发生在哪里。收到请求、接受作业、开始模型调用、完成工具副作用、保存最终结果，是不同时间点。恢复机制应说明自己覆盖哪一段。

前面的 Company Task 执行路径要求开启 durable queue。Agno 的普通后台运行接口则既可能走持久队列，也可能在进程内继续。`QueueConfig` 的 durable 默认关闭；启用后，仍需配置支持队列的存储和 worker，让执行组件能够由 worker 重新解析，并使请求负载可以持久化。普通 Agent 运行路由也存在媒体附件等不能进入该队列的分支。因此，单看 `background=True` 或 HTTP 202，无法判断一个普通后台请求是否具备持久接单能力。

在符合条件的 durable 路径中，AgentOS 先提交 queue job，再准备 `PENDING` 的 run 记录、唤醒 worker，并返回 `run_id`、`session_id`。这一顺序对应一个具体保证：确认接受之前，待执行工作已经进入队列存储。请求进程随后退出，待办工作仍可由队列系统继续处理。

官方 `06_execute_tasks.py` 还特意分开了两种存储。示例可以把 Company 记录和 session 放在 SQLite，队列仍使用 PostgreSQL。不能因为看到了 SQLite 配置，就推导它提供了同样的持久队列支持。官方 README 进一步指出，生产环境中的 attempt fencing 需要 PostgreSQL 会话存储。选择持久化方案时，任务记录库、会话库和队列库分别承担什么责任，应单独确认。

作业入队后，worker 领取它并获得租约，通过 heartbeat 续租。租约用于证明当前仍有执行者负责这项工作。若续租消失，其他 worker 或清理流程可以处理过期作业，但“租约过期”只表明当前所有权需要重新确认，不能证明外部世界没有发生变化。

Agno 的 Durable Queue 文档与 `libs/agno/agno/os/job_queue.py` 将过期处理和重试次数相连。默认 `max_attempts=1` 时，失去 worker 的过期作业不会无条件重新执行，耗尽尝试后会进入可见的错误状态。配置更大的尝试次数，才允许新的队列 attempt 重新执行整个 run。

这个默认值体现了恢复与重复副作用之间的取舍。自动重试提高了工作继续推进的机会，也增加了重复执行工具的可能。worker 领取后已经向外部系统提交了操作，随后在保存成功记录前消失，新的 worker 无法只凭队列状态知道那次操作究竟有没有成功。

attempt fencing 则处理另一类竞争：旧 worker 只是暂时失联，稍后又回来提交结果，而新的 worker 已经接手。运行和事件写入检查 attempt 所有权，可以拒绝旧尝试晚到的更新，避免它覆盖新尝试的状态。它保护的是平台内的记录一致性，不能撤销旧 worker 已经完成的外部调用。

这也解释了几种“重试”不能混用。模型请求重试可以重做一次失败的模型调用，并保留当时上下文；队列重试重新执行整个 run；人工批准后的 `continue_run` 则针对明确暂停的执行。保存了 session，说明上下文和记录可以被后续执行使用，并不等于进程在任意工具调用中间崩溃，都能从那个指令位置继续。

Paperclip 也有专门的恢复实现。`server/src/services/heartbeat/recovery.ts` 包含运行存活检查、adapter 停止控制、远端终止回执，以及特定 native session 的重启恢复处理。这些机制要求结合实际 adapter、执行所有权和会话证据理解。把 Paperclip 描述成故障后只能从头唤醒，会漏掉已有实现；把它描述成对任意远端 harness 都能从工具中断处继续，则超出了这些实现的范围。

对于两个平台，验收恢复能力都应落到一个明确故障点：请求已返回、作业尚未领取时，是否还能找到待办记录；worker 已领取后失联，是报错还是允许重做；外部调用已成功但尚未回写时，怎样核对结果。前两项主要依赖平台的持久队列和所有权机制，后一项还需要外部系统提供可复用的操作标识、幂等处理或结果查询。

这些是依据实现提出的验证入口，本次没有执行故障注入。平台的“重新领取成功”与外部操作“恰好发生一次”，应分别取证。

## 审批与预算要落实到拦截位置

状态与故障边界明确后，才能比较审批。任务产出需要审查，与某个工具动作必须事先批准，发生在执行链的不同位置。

Paperclip 的 Execution Policy 在任务交付处提供服务端门槛。当执行者尝试把 Issue 标为 `done`，如果策略要求 review 或 approval，流程会进入相应的 `in_review`、改派和执行状态处理；要求修改时再回到执行者。这比在提示词中写“做完请找人审核”更有约束力，因为完成状态的变更需要通过服务端规则。

这个门槛保护的是交付确认。若 harness 已持有外部系统凭据，并在申请完成之前执行了写入，Issue 的审查规则不会自动追回那次写入。需要禁止未经批准的外部动作时，检查必须放在工具执行前，或者由真正执行写入的系统拒绝缺少授权的请求。

Agno 有一条更靠近工具的审批路径。`requires_confirmation` 提供基础的人在环路确认暂停；需要数据库中的 pending approval 记录、管理者 resolve 和后续继续执行这条路径时，官方示例使用 `@approval(type="required")`。`@approval(type="audit")` 则用于记录其他人在环路决策，不替代执行前的确认暂停。有相应权限的管理者处理持久审批记录后，再通过继续运行的路径推进。`libs/agno/agno/os/routers/approvals/router.py` 检查处理权限，并以 pending 状态作为更新条件，避免一个批准请求被任意重复改写。

官方审批示例中的 `delete_user_data` 只是返回模拟字符串，没有删除真实数据。它可以解释暂停、审批记录和继续执行的关系，不能作为真实删除流程已经安全部署的证据。真正删除数据时，还必须确认工具参数、批准对象和最终写入操作保持一致。

Company Task 的 `in_review` 是另一层：run 完成后审查工作结果。一个任务可以先在某个工具调用前等待确认，恢复执行得到结果，再进入 Task 的产出审查。前者决定“现在能否执行这个动作”，后者决定“这项工作能否被接受”。只比较是否有一个 approval 功能，会把这两层差异抹平。

预算也应按生效位置理解。Paperclip 从 adapter 或 runtime 接收成本与用量，在 dispatch 前进行运行预算预留，并据此控制后续开工。固定版本的 `heartbeat.ts` 已接入 `reserveRunBudget`；官方 Costs 文档同时讨论了预留额度和未定价用量。这说明预算是参与调度的控制，不能直接写成模型供应商账单的绝对上限。

预算是否有效还取决于回报是否完整。前面检查的 HTTP adapter 没有解析响应里的 usage；如果远端运行产生的费用没有通过其他路径回传，平台看到的数字就不覆盖全部消耗。已经发出的调用也可能继续产生费用，阻止下一次唤醒无法取消此前的消耗。采用前应把预留、实际用量、未定价部分和远端回报连成一条账目路径。

Agno 已核实的 metrics、usage 和队列并发配置，则分别提供运行信息与资源限制。它们有助于观察消耗和控制同时运行的数量，但不能由此推出组织级月度费用封顶。本次材料不足以确认它与 Paperclip 具有同样的预算分派机制，也不足以断言它完全没有其他预算能力。若预算是决定条件，应要求目标部署对费用来源、拦截位置和在途消耗给出可验证的解释。

## 身份不能从组织树或 user_id 推出来

审批者是谁、执行者能读什么，最终还依赖身份和权限。组织结构、任务归属与数据访问权，分别来自不同规则。

Paperclip 的部署文档区分 `local_trusted` 与面向共享使用的 authenticated 模式。默认可信本地使用不要求登录，这适合相应信任前提，不能直接承接多人服务的访问边界。组织树里某个 Agent 向另一名 Agent 汇报，也不意味着它因此获得了源系统中全部数据的访问权；真正的数据权限仍要由工具及被访问系统核对。

Agno 当前 Security Overview 则明确区分 JWT 认证与 scope 授权检查。配置 JWT 验证，用于确认令牌的有效性；启用 `authorization=True`，才会执行相应的 scope 限制。共享的 `security_key` 也不能代替逐接口权限。请求体里给出 `user_id`，更不能自行证明调用者就是该用户。

Company 又多了一层协作范围。具备相应 Company scope 的调用者可以共享查看和处理工作记录，不能把普通 session 的用户隔离规则直接延伸为“Company Task 只有创建者能看”。执行 session 仍有所有者检查；Company 启动执行时还需要核对任务与 executor 的运行权限，并保留相应关联。工作共享与会话归属可以同时存在，但不是同一个隔离维度。

因此，权限验证需要沿实际读取和写入路径进行：已验证的身份怎样进入请求上下文，哪一步检查任务权限，哪一步检查执行者权限，工具又怎样核对外部资源。仅修改一个 `user_id` 参数或增加一个组织角色，无法完成这条链。

## 根据已有执行边界选择，组合时保留一份任务事实

沿这条路径，两者的取舍可以收敛到相同的比较维度。

| 比较维度 | Paperclip | Agno AgentOS Company |
|---|---|---|
| 长期工作 | Issue 关联分派、依赖、交付状态和执行策略 | Task 关联 Product、Project、接受范围和结果审查 |
| 一次执行 | heartbeat run 通过 adapter 进入 harness | Task run 复用普通 Agent、Team、Workflow 运行接口 |
| 接入不同执行环境 | 以目标 adapter 的会话、结果、停止能力为准 | Company 执行要求支持 durable queue 的本地注册 executor；Remote 对象不走这条路径 |
| 故障处理 | 恢复依赖具体 adapter、所有权与会话证据 | 持久接单、租约和队列重试；默认尝试次数不等于自动重跑 |
| 批准生效处 | execution policy 约束任务交付，外部动作需相应前置检查 | 工具前 approval 与 Task 结果 in_review 分别处理 |
| 预算与用量 | 预算预留参与开工控制，依赖成本回报完整性 | 已核实运行指标与并发控制；组织预算须进一步验收 |

已有多个独立 harness，主要缺少统一的工作分派、交付追踪和预算管理时，Paperclip 是值得优先评估的入口。关键工作是检查每个目标 adapter 的实际控制深度。如果 adapter 只能发一个 webhook，跨系统的执行状态、取消与费用仍然需要补齐；如果它已有完整会话集成，平台能够承担的责任就更多。

执行主体已经可以注册进 Agno，且希望 Task、session、run 和队列统一管理时，应先检查 Company 是否满足工作流程。为同一组执行者再增加一套任务系统，会多出状态同步和权限映射成本。Company 的约束也要一起接受：任务执行者必须能被相应运行路径解析，持久队列的存储、worker 与重试策略需要正式配置。

两者组合也有合理条件，例如需要在跨 harness 的统一工作管理下，保留某个 AgentOS 的专门运行能力。但组合价值应来自这两个独立边界，而非它们都具有平台化名称。

按已经核对的接口，Paperclip 的通用 HTTP adapter 发送 JSON，Agno 普通 run 路由有自己的输入字段与异步执行语义，不能仅把 URL 填进去就认定集成完成。本次没有找到两者专用集成的证据，也没有执行端到端组合。依据接口设计，一层桥接至少需要保存 Paperclip run 与 Agno `run_id`、`session_id` 的关联，等待真实终态，再回报结果、错误和成本；取消还要取得远端实际处理结果。

这层桥接首先应确定一份任务事实归谁维护。如果 Paperclip Issue 负责工作范围与验收，AgentOS 可以负责执行记录；若 Company Task 已承担同样职责，再复制一个可独立修改的 Issue，就需要处理两处同时改派、退回和重试的冲突。一次重试究竟创建新的工作尝试，还是查询已有 run，也必须由关联记录决定，不能依赖标题相同或模型记住上次发生了什么。

采用前，可以用官方原型的真实对象完成一轮有针对性的检查：运行期间重复提交同一 attempt，应能定位既有执行；收到异步接单响应，应继续追踪到运行终态；运行成功后，应看见任务仍按规则等待审查；提出取消后，应核对实际执行是否停止；启用重试后，应确认外部操作如何查重或查询结果。每一项都有对应的状态和证据，结果不符合预期时也能定位到具体交接点。

最终需要回答的是一项持续工作怎样可靠地交付：谁拥有任务事实，谁拥有执行状态，谁确认产出，谁有权让下一步发生。把这四个问题沿真实执行路径逐个落实，才有依据决定采用 Paperclip、采用 AgentOS Company，或承担组合两者的额外成本。

## 主要资料

- Paperclip `v2026.1023.0`：`server/src/services/issues.ts`、`server/src/adapters/http/execute.ts`、`server/src/services/heartbeat.ts` 与 `server/src/services/heartbeat/recovery.ts`
- Paperclip 官方文档：Org Structure、HTTP Adapter、Execution Policy、Costs、Deployment Modes
- Agno `v3.1.11`：`cookbook/05_agent_os/30_company/README.md` 与 `06_execute_tasks.py`
- Agno `v3.1.11`：`libs/agno/agno/company/execution.py`、`os/routers/company/runs.py`、`os/job_queue.py` 与相关运行、审批路由
- Agno 官方文档：AgentOS Introduction、Background Execution Overview、Durable Queue、Approvals Overview、Security Overview
