---
layout: post
title: "Paperclip 与 Agno AgentOS 对比：从 Agent 接入到任务交付"
description: "Paperclip 是什么，Agno、AgentOS 与 Control Plane 怎样配合？沿官方接入流程与 Company 任务示例，讲清 Agent 从哪里来、谁分派和执行工作、结果如何审查，以及两套产品的选择与组合。"
image: /assets/images/posts/paperclip-agentos-control-runtime-mechanism.png
image_alt: "Paperclip 从组织配置、adapter 接入走向工作交付；Agno 从 SDK 组件、AgentOS 服务走向 Control Plane 操作界面，另可启用 Company 管理长期任务和审查"
date: 2026-10-29 10:08:20 +0800
display_date: 2026-10-29
last_modified_at: 2026-10-29 17:41:09 +0800
categories: [AI, Engineering]
tags: [Paperclip, Agno, AgentOS, AI Agent, Agent Harness]
---

Paperclip 是一个管理 AI Agent 工作的网页应用。用户通过适配器接入自己的 Agent，为它配置岗位，并在任务看板中分派工作。接入的 Agent 在各自的环境中读文件、改代码、调用模型，并把进展和产出回报给 Paperclip。一项任务可以经过多次运行、交接或退回，工作要求和已有结果仍保存在任务记录中。

Agno 是构建 Agent 的 Python 框架，开发者在代码里配置模型、工具和执行逻辑。Agent 可以直接在 Python 中运行；需要供其他应用调用时，再注册到 AgentOS，由它接收请求并返回执行结果。Agno 也提供 Company，将这些执行组件接入项目、任务和交付审查。两套产品因此都涉及任务管理，但任务由谁分派、怎样交给执行者、运行结束后如何验收，需要分别看它们的实现。

## Paperclip：把岗位、Agent 和任务连起来

Paperclip 的官方首次使用教程从建立组织开始。启动服务、进入工作台后，先建立组织，再到 Goals 中补充目标。目标说明为什么做，项目归集相关工作，任务（Issue）写明具体要做什么。Agent 则记录承担工作的角色，以及它与其他角色的分工和汇报关系。

教程选择 CEO 作为第一个 Agent。这个名称表示岗位职责：读取目标、提出策略、向其他角色分派工作。要让这个岗位真正工作，用户还得选择要接入的 Agent，准备它需要的模型账号或凭证，并配置工作环境。Paperclip 保存一个叫 CEO 的角色，并不意味着它另外生成了一个模型。

Paperclip 通过 adapter（适配器）连接岗位与用户自己的 Agent。适配器根据接入方式启动或调用 Agent，传递岗位配置，并接收运行信息。用户可以选择匹配的适配器，将已有的 Agent 接入任务流程。

岗位、接入的 Agent 和模型配置由此可以分别管理。一个岗位可以换用其他 Agent；同一套 Agent 也可以承担多个岗位，每个岗位使用不同指令。用户需要为当前岗位明确：在哪个工作环境运行，能读取什么材料、使用什么工具，收到任务后遵守哪些要求。测试适配器连接，检查的是 Agent 能否正常启动或被调用；岗位指令和任务描述，决定了启动后它要处理什么。

配置好以后，用户可以点 Run now，立即触发一次运行；也可以配置 heartbeat，定时唤醒 Agent。一次 heartbeat 给执行者一次处理工作的机会：读取目标、当前分派和相关上下文，判断下一步，执行后回报。工作尚未结束时，后续唤醒可以继续处理，所以不必让每个岗位始终占着一个正在推理的进程。

官方 Watching Agents Work 教程展示了这样的第一轮协作：CEO 读取目标和指令，提出策略，用户审查策略，然后让后续任务进入看板。在这个教程里，人负责确认方向，Agent 负责进一步拆分和分派。能否拆出有用的任务，依然依赖执行者的判断与材料；Paperclip 保存这些决定，并提供继续推进工作的入口。

看板中的任务可以由用户分派，也可以由有相应职责的 Agent 拆成子任务、交给其他角色。执行者取得分派后，读取任务要求和讨论，在自己的工作环境中处理，再通过 Paperclip 接口更新进展、补充评论或提交产物。项目附带的 Paperclip skill 说明了这套操作方法，包括怎样查找和领取任务、报告阻塞、回报结果。它是执行者需要遵循的操作指引，实际执行仍由接入的 Agent 完成。

这里要区分两种记录。任务页保存一项工作的要求、讨论和产出；Agent 的 Live Run 或 Runs 保存某次启动的执行过程。一项任务可以经过多次运行，也可以换人处理或被退回，任务记录仍然存在。排查某次执行为什么出错，要看运行记录；判断工作是否交付，则要看产物和审查结果。

Paperclip 因此主要通过任务组织角色间的协作：这个角色负责什么，处理后交给谁，下一位沿用哪些材料，都围绕持续存在的工作记录展开。某个角色在一次运行中怎样调用模型、选择工具，则由接入的 Agent 自己负责。

## Agno：把执行逻辑写成组件，再提供运行接口

用 Agno 构造 Agent 时，开发者在 Python 中选择模型、写入指令，并配置它能调用的工具。工具可以是函数，也可以连接搜索、数据库或其他系统。运行过程中，模型选择工具和参数，SDK 实际调用工具，把返回结果加入上下文，再让模型继续，直到得到答案或达到停止条件。

这样的 Agent 已经可以在 Python 中直接运行。若网页、业务后端或其他服务也要调用它，就可以把 Agent 注册到 AgentOS。AgentOS 为注册组件提供运行 API，并按配置接入会话、数据库和其他运行设施。调用方提交输入时，由服务找到组件，再由组件推进执行。

官方 Run Your First AgentOS 示例创建了一个叫 Agno Assist 的 Agent，使用 Claude 模型和 SQLite 存储。省去安装与启动步骤，代码中的关系如下：

```python
from agno.agent import Agent
from agno.db.sqlite import SqliteDb
from agno.models.anthropic import Claude
from agno.os import AgentOS

db = SqliteDb(db_file="agno.db")
agent = Agent(
    name="Agno Assist",
    model=Claude(id="claude-sonnet-4-5"),
    db=db,
)
agent_os = AgentOS(agents=[agent], db=db)
app = agent_os.get_app()
```

`Agent` 保存模型调用等配置，`db` 用来保存会话，`AgentOS(agents=[agent], db=db)` 把这个 Agent 注册进服务，`get_app()` 得到对外的应用。模型本身由外部供应商提供。示例没有给 Agent 配置搜索或文件编辑工具；需要这些行为时，还得提供工具及相应访问条件。

按照教程准备依赖、模型凭证并启动文件后，用户得到一个能够接收 API 请求的服务。API 文档说明请求方式，运行信息接口显示已注册的组件。应用向某个 Agent 的运行接口发送消息，SDK 推进模型和工具调用，接口返回内容或流式事件。后续请求若要沿用已有上下文，需要携带相应会话信息。

Control Plane 则是操作这套服务的网页入口。用户在网页中添加 OS，填入自己运行的 AgentOS 地址；连接后，界面列出服务注册的 Agent、Team 和 Workflow，用户可以测试组件、查看会话和运行数据。能查看哪些会话、知识和追踪内容，取决于服务端启用了什么。执行进程仍在用户部署 AgentOS 的地方运行，能够访问的资源也由该部署决定。

需要多个执行者时，Agno 提供两种组织方式。Team 在协调模式下由 leader 根据当前输入选择成员、委托工作，再根据成员返回的结果继续处理。每个成员有自己的指令和工具；leader 负责协调，成员之间仍有上下文的区分。Workflow 则由开发者预先写明步骤和控制流，安排函数、Agent 或 Team 按相应顺序和分支执行。

两者的区别在于谁决定分工和顺序：Team 把一部分决定交给协调者模型，Workflow 把关键安排放进流程定义。它们都可以注册到 AgentOS，对外成为一个可调用组件。调用者发送一次请求，组件内部可能执行工具循环、委托成员，也可能推进多个步骤。具体执行机制见[《Agno SDK：Agent、Team 与 Workflow 的执行机制》](/posts/agno-sdk-execution/)。

Paperclip 的用户先配置岗位和工作，再接入 Agent；Agno 的开发者先定义执行组件，再将其提供给应用或用户调用。这个入口差异影响采用时要准备什么，却还没有涵盖两者在长期工作管理上的重叠。

## Company：保存工作要求，把执行结果交给审查

一次接口调用结束后，工作可能还没被接受。它属于哪个项目、当初要求是什么、结果为什么被退回，都需要保存到下一次执行。Agno 的 Company 在运行服务之上提供了这些工作记录。

Company 需要显式启用。它把工作分成 Product、Project 和 Task 三层。官方 `06_execute_tasks.py` 示例中，Product 是名为 SDK 的产品，Project 是其中的一轮 Release 发布项目，Task 则是这轮发布里“起草发布说明”（Draft release notes）的具体任务，要求整理经过审查的变更。Task 保存要求、执行者、状态和结果；它下面的 run 记录一次具体执行。程序另外注册一个 ID 为 `draft` 的 Workflow，供这项任务调用。

这个 Workflow 只包含确定性函数：按代码读取 Task 传入的上下文，直接返回待审文本，不调用模型。它演示的是任务材料怎样送进执行组件、结果怎样回到工作记录，发布说明的质量仍留待审查。它是官方示范程序，并非真实项目的发布说明生产记录。

示例先创建 Task，写入 brief 和证据引用，再将 Task 转为 `ready`，绑定已注册的 `draft` Workflow。此时，工作要求和执行者已经确定。接着发起运行请求，AgentOS 把任务材料交给对应 Workflow，通过持久队列安排 worker 执行，并保存 Task 与这次运行的关联。worker 负责从持久队列领取工作，再调用相应的已注册组件执行。

Workflow 正常返回后，run 显示完成，Task 进入 `in_review`。这分别表示两件事：程序做完了本次步骤，产出正在等待接受。审查通过后，Task 才进入 `done`；需要修改时，工作记录继续保留，使后续处理能够关联原来的要求和结果。

要把这条路径接通，还需要满足执行条件。Task 必须绑定运行层能够解析的已注册组件；任务执行使用持久队列，需要支持的存储和 worker。官方示例分别配置 Company 记录与队列存储，其中队列使用 PostgreSQL。启用 Company、建立 Task、注册组件、配置队列和 worker，合起来才构成从工作要求到实际执行的路径。

普通问答接口或 Workflow 运行仍可以直接调用，不必先建立 Product、Project 和 Task；Company 将这套已有执行能力进一步接入长期工作和交付审查。

![Paperclip 与 Agno 的两条使用路径：组织配置并接入执行者，或定义组件并启动服务；两者都可以把执行关联到持续工作的记录与审查](/assets/images/posts/paperclip-agentos-control-runtime-mechanism.png)

*图：上排是 Paperclip 的岗位与工作，通过 adapter 连接 Agent，并在工作台跟踪交付；下排是 Agno SDK 定义的组件，经 AgentOS 提供 API，再由 Control Plane 连接操作。Company 可以在运行服务之上启用，保存长期任务和审查记录；普通组件运行可以直接进入 AgentOS。*

## 多个 Agent 协作时，谁决定分工

比较多 Agent 能力，需要看角色怎样跨任务交接，以及成员怎样在一次组件运行内分工。

Paperclip 的角色协作可以跨任务、跨多次唤醒。CEO 提出策略、建立任务、分派给其他角色；接收工作的角色处理后，在任务里回报或安排交接。不同岗位可以接入不同的 Agent。任务记录把这些 Agent 的工作连起来，让人看到哪一个角色对哪项工作负责。

Agno Team 首先组织一次组件运行中的成员协作。leader 根据输入委托成员，收到结果后继续处理，应用无需为每次成员委托建立长期任务。需要跨运行保存产品责任、工作要求和验收记录时，可以再启用 Company：Task 交给一个 Team，Team 内部再决定成员分工。

因此，“支持多个 Agent”还不足以说明协作方式相同。Paperclip 的典型路径先建立岗位与工作的持续关系；Agno Team 的典型路径先解决一次输入怎样由多个成员共同处理，再由 Company 将执行组件接入长期工作。Agno 的 Workflow 还允许把步骤和分支直接写成程序，以减少执行时临时决定顺序的部分。

两者都可以接入已有的 Agent。Paperclip 使用适配器连接；Agno 除了原生 Agent，也支持通过已适配的外部 Agent 参与 Team 和 Workflow。接入时可以保留已有 Agent 内部的模型与工具调用逻辑，不必全部改写成原生 Agno Agent。

在 Company 中使用这些已适配的外部 Agent，可以先将其放进 Workflow 的步骤，将 Workflow 注册到 AgentOS，再把 Task 绑定到这个 Workflow。Task 运行时，队列 worker 调用 Workflow，由步骤调用外部执行者；运行记录和交付审查仍归 Company Task 关联。这条路径要求 Workflow 配有执行数据库，并启用持久队列。Company 的任务执行要求本地注册、可由队列调用的组件，不能把指向另一套服务的 RemoteAgent、RemoteTeam 或 RemoteWorkflow 直接当成同样的执行入口。

| 要完成的事 | Paperclip 的典型做法 | Agno / AgentOS 的典型做法 |
|---|---|---|
| 确定执行者 | 建岗位，选择 adapter，配置工作环境 | 定义或接入 Agent，再组合 Team、Workflow |
| 提交工作 | 建任务，写明要求并分派 | 调用运行 API；需要长期记录时建立 Company Task |
| 安排分工 | 角色之间拆任务、分派、交接 | Team 内委托，或按 Workflow 步骤执行；Company 保存长期工作 |
| 追查过程 | 看任务讨论、产物及关联的运行记录 | 通过 Control Plane 或 API 看会话、运行和追踪；Company 关联任务结果 |
| 接受结果 | 按任务的交付和审查规则结项 | 普通运行返回结果；Company Task 另行审查交付 |

选择时首先要问：当前最缺的是统一组织已有执行者，还是开发一个可由应用调用的组件？如果还需要长期工作管理，再判断 Paperclip 的任务流程或 Agno Company 是否已覆盖要求。

## 运行结束、动作获批和费用入账，各自意味着什么

把工作接上执行程序后，界面状态仍需结合实际动作理解。接单、执行和交付不在同一时刻发生；批准方向与批准工具操作，也不在同一个位置生效。

### 远端接单之后，怎样取得最终结果

Paperclip 的通用 HTTP adapter 可以向远端服务发请求。远端返回成功响应时，可能只是把作业放进了自己的队列，实际工作还没做完。若采用这种远端执行方式，连接层就需要保存远端作业标识，继续查询进展、取得结果，再回报 Paperclip 的工作状态。否则，Paperclip 这边看到请求成功，人却可能误以为远端已经完成交付。

这里说的是通用 HTTP adapter。CLI 或会话适配器可能接得更深，能提供更多运行信息，各种 adapter 应分别检查。

取消也要沿这条调用关系追下去。停止等待 HTTP 响应后，远端作业可能还在运行；任务改为不再进行时，已经发出的工具操作也可能继续。需要确认实际执行者有没有收到取消、有没有停止，以及已经发生的外部写入怎样处理。

AgentOS 的持久队列保存待执行工作及运行关联，使请求进程退出后仍有继续处理的依据。但队列重试可能重新执行一次 run：如果上一次已经对外部系统写入成功，重新执行就可能再次写入。要避免重复，仍需为操作提供标识、实现幂等处理，或先查询已有结果。保存了工作和运行记录，并不等于外部操作自动只发生一次。

### 审查工作方向、工具动作与交付物

Paperclip 首次使用教程让人审查 CEO 策略，约束的是后续工作的方向。任务的 execution policy 则可以要求交付经过 review 或 approval 后，才允许完成状态变更，约束的是任务怎样结项。工具若已在外部系统完成写入，后来退回交付物，也不会撤销那次写入。

Agno 另有工具调用前的确认与审批机制：在受保护的工具执行之前暂停，等待相应处理，再继续运行。Company Task 的 `in_review` 则留在产出返回之后，用于判断整项交付是否合格。一次工作可以先获准执行某个动作，完成后再接受交付审查。判断审批功能是否满足需要，要明确希望人在什么动作之前或之后作决定。

### 预算怎样影响继续开工

Paperclip 在分派一次运行、启动付费工作之前预留预算。对于该运行适用的预算策略，它把已记录费用、尚未释放的预留和本次预留一起与额度比较；余量不足，就拒绝这次开工。这里控制的是新的付费工作能否开始，预留检查本身不会终止已经发出的模型调用，也不能限制供应商最终账单。

这个判断依赖费用记录完整。执行者没有回传的消耗不会自动计入，通用 HTTP adapter 的响应也不会自动提供完整的模型 usage 集成。预留让尚未结算的运行占用一部分额度，后续成本回报再补足实际消耗；使用远端执行者时，需要把这条回报接通，才能让下一次开工判断依据实际费用。

Agno 的 usage、metrics 用于观察消耗，并发配置用于限制同时运行的工作数量。这些配置各有用途，与按组织角色分派月度额度属于不同操作。费用额度若是采用条件，就要检查目标部署实际提供的预算流程，不能仅凭运行监控推断它已经具备相同的额度控制。

## 选择与组合：先决定哪一边保存工作的最终决定

如果用户已经有自己的 Agent，困难主要是任务散落、分工不清、交付难追踪，Paperclip 的起步方式更直接。把执行者接进来，配置岗位和环境，再集中分派任务。采用成本主要在 adapter、账号、工作区与回报方式的配置，以及谁分派、谁审查、阻塞时怎样继续的流程安排。

如果要把 Agent 嵌入应用，让后端通过 API 调用具有明确输入输出、工具和会话的组件，Agno SDK 到 AgentOS 的路径更直接。开发者控制组件内部的执行方式，再选择 Team 或 Workflow。相应投入是组件定义、服务部署、存储和访问控制；需要长期工作时，再接上 Company 的任务执行与审查流程。

若执行组件已在 AgentOS 中，Company 也足以保存项目要求和验收，先判断这一套是否已经够用。继续增加 Paperclip，通常是因为还要统一管理其他 Agent、岗位或工作流程。另一种组合起点是 Paperclip 已经管理跨执行者的工作，而某项能力适合单独做成 AgentOS 服务。

组合时，要先确定谁保存一项工作的要求，谁有权分派、退回和接受结果。假如这些决定归 Paperclip Issue 管，AgentOS 就承担一次或多次具体执行。连接层保存 Issue、Paperclip 运行和 AgentOS run 的关联，持续取得结果、错误与费用，再回报任务。把服务地址填入 HTTP adapter，只完成了发请求的入口，后续结果仍需要接回来。

如果 Company Task 同时独立管理相同要求和验收，两边就可能分别改派、退回或发起执行。这时需要规定哪一边可以修改工作范围，另一边怎样跟随；重试时也要区分，是查询已有运行，还是确实开始新一次尝试。两张任务有相同标题，并不能让这些决定自动同步。

Paperclip 与 Agno AgentOS 的典型入口不同，长期任务管理又使它们成为部分重叠的选择。判断应落在手头的工作上：从哪里提出要求，由谁推进执行，在哪里接受结果。先确认一套产品能把这条路径走到哪一步，再决定是否值得维护两套系统之间的连接。

## 主要资料

- Paperclip 官方文档：What is Paperclip、Create Your First Company、Hire Your First Agent、Watching Agents Work、Execution Policy、Costs & Budgets。
- Paperclip 源码：HTTP adapter、任务服务、heartbeat 调度与恢复实现。
- Agno 官方文档：SDK Introduction、Run Your First AgentOS、Connect Your AgentOS、Control Plane、Approvals Overview、Durable Queue。
- Agno Company 官方示例：Company README、`06_execute_tasks.py`。
- Agno `v3.1.11` 发布说明：外部 Agent 与 Team、Workflow 的接入。
