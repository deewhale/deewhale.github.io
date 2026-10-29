---
layout: post
title: "Paperclip 与 Agno AgentOS 对比：从 Agent 接入到任务交付"
description: "从任务领取、Team 成员委托、Workflow 步骤传参与 Company 交付审查，解释 Paperclip 与 Agno AgentOS 如何组织 Agent 工作，以及两套产品的选择和组合。"
image: /assets/images/posts/paperclip-agentos-control-runtime-mechanism.png
image_alt: "Paperclip 从组织配置、adapter 接入走向工作交付；Agno 从 SDK 组件、AgentOS 服务走向 Control Plane 操作界面，另可启用 Company 管理长期任务和审查"
date: 2026-10-29 10:08:20 +0800
display_date: 2026-10-29
last_modified_at: 2026-10-29 19:46:53 +0800
categories: [AI, Engineering]
tags: [Paperclip, Agno, AgentOS, AI Agent, Agent Harness]
---

Paperclip 是一个管理 AI Agent 工作的网页应用。用户通过适配器接入自己的 Agent，为它配置岗位，并在任务看板中分派工作。接入的 Agent 在各自的环境中读文件、改代码、调用模型，并把进展和产出回报给 Paperclip。一项任务可以经过多次运行、交接或退回，工作要求和已有结果仍保存在任务记录中。

Agno 是构建 Agent 的 Python 框架，开发者在代码里配置模型、工具和执行逻辑。Agent 可以直接在 Python 中运行；需要供其他应用调用时，再注册到 AgentOS，由它接收请求并返回执行结果。Agno 也提供 Company，将这些执行组件接入项目、任务和交付审查。两套产品因此都涉及任务管理，但任务由谁分派、怎样交给执行者、运行结束后如何验收，需要分别看它们的实现。

## Paperclip：把岗位、Agent 和任务连起来

Paperclip 的官方首次使用教程从建立组织开始。启动服务、进入工作台后，先建立组织，再到 Goals 中补充目标。目标说明为什么做，项目归集相关工作，任务（Issue）写明具体要做什么。Agent 则记录承担工作的角色，以及它与其他角色的分工和汇报关系。

教程选择 CEO 作为第一个 Agent。这个名称表示岗位职责：读取目标、提出策略、向其他角色分派工作。要让这个岗位真正工作，用户还得选择要接入的 Agent，准备它需要的模型账号或凭证，并配置工作环境。

Paperclip 通过 adapter（适配器）连接岗位与用户自己的 Agent。适配器根据接入方式启动或调用 Agent，传递岗位配置，并接收运行信息。用户可以选择匹配的适配器，将已有的 Agent 接入任务流程。

岗位、接入的 Agent 和模型配置由此可以分别管理。一个岗位可以换用其他 Agent；同一套 Agent 也可以承担多个岗位，每个岗位使用不同指令。用户需要为当前岗位明确：在哪个工作环境运行，能读取什么材料、使用什么工具，收到任务后遵守哪些要求。测试适配器连接，检查的是 Agent 能否正常启动或被调用；岗位指令和任务描述，决定了启动后它要处理什么。

配置好以后，用户可以点 Run now，立即触发一次运行；也可以配置 heartbeat，定时唤醒 Agent。一次 heartbeat 给执行者一次处理工作的机会：读取目标、当前分派和相关上下文，判断下一步，执行后回报。工作尚未结束时，后续唤醒可以继续处理，所以不必让每个岗位始终占着一个正在推理的进程。

官方 Watching Agents Work 教程展示了这样的第一轮协作：CEO 读取目标和指令，提出策略，用户审查策略，然后让后续任务进入看板。在这个教程里，人负责确认方向，Agent 负责进一步拆分和分派。能否拆出有用的任务，依然依赖执行者的判断与材料；Paperclip 保存这些决定，并提供继续推进工作的入口。

### 分派、唤醒和领取怎样接起来

组织关系说明一个角色向谁汇报，具体要执行哪项工作则记录在 Issue 上。用户或有相应职责的 Agent 创建任务，写入要求和指派对象；管理 Agent 也可以将工作拆成子任务，分别指派。Agent 被唤醒后，按项目附带的 Paperclip skill 读取触发原因与自己的分派，选择本次要处理的任务。

这份 skill 规定了工作前的领取动作：执行者向 Issue 的 checkout 接口提交自己的 Agent 标识、预期可领取的任务状态，并带上本次运行的 ID。服务端先检查任务的依赖等前提，再用带条件的数据库更新取得任务。条件包括任务状态仍符合预期、指派对象允许当前 Agent 领取、运行引用没有被另一项执行占用。成功时，服务端把任务置为 `in_progress`，将领取和执行引用指向本次 run。

两个运行同时领取同一任务时，第一个成功更新会改变状态及运行引用。第二个更新再检查这些条件，就无法按旧状态取得处理权。对于已有其他有效执行占用的冲突，官方 skill 要求停止处理该项任务，不再争抢重试。同一 run 的重复领取，以及旧运行已经结束后的引用清理，则由服务端按具体状态处理。

领取成功后，执行者继续读取任务、祖先任务及评论，取得工作要求与已有材料，再在自己的环境中执行。处理完成时，通过 Paperclip 接口留下结果、更新状态或报告阻塞；这些写入带着当前 run 标识，使本次处理能追溯到具体运行。下一位角色可以从持续保存的任务记录继续，而不必依赖上一位仍保持着一段模型对话。

这里有两种互相补充的记录。Issue 保存工作要求、讨论和产出，Agent 的 Live Run 或 Runs 保存某次启动的过程。一项工作被退回后可以再次启动，原来的要求与结果仍留在任务中；排查某次执行出错，则沿关联的 run 查看。Paperclip 保存任务处理权和工作进展，接入的 Agent 负责这次运行中的模型与工具调用。

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

## Agno 怎样编排成员：模型委托与程序控制流

Agno 的 Agent 已经有自己的模型、指令和工具循环。把多个 Agent 放在一起后，还要决定谁取得当前工作、给它什么输入，以及拿到结果以后调用谁。Team 和 Workflow 将这些决定放在不同位置。

### Team：leader 通过工具把工作委托给成员

官方 Coordinate Mode 示例创建了 Researcher 和 Writer 两个 Agent。Researcher 的职责是整理事实，Writer 的职责是将材料组织成文章。Team 的指令要求信息类请求先交给 Researcher，再让 Writer 整理，最后汇总。这里的顺序写在给 leader 的指令中，由 leader 的模型在运行时据此选择成员和生成委托内容。示例中的关键配置是：

```python
team = Team(
    name="Research & Writing Team",
    mode=TeamMode.coordinate,
    model=OpenAIResponses(id="gpt-5.2"),
    members=[researcher, writer],
    instructions=[
        "For informational requests, ask the Researcher to gather facts first,",
        "then ask the Writer to polish the findings into a final piece.",
        "Synthesize everything into a cohesive response.",
    ],
)
```

这段配置摘录中的 `researcher` 和 `writer` 是前面已创建的成员对象。Team 的 `model` 用于 leader，成员各自保留自己的模型和指令。

SDK 将成员信息和委托工具提供给 leader。成员信息告诉模型有哪些可选成员、各自的 ID、名称和职责；委托工具则让选择变成可执行的调用。以协调模式中的 `delegate_task_to_member(member_id, task)` 为例，模型生成成员 ID 和具体任务，SDK 才根据 ID 找到成员并运行它。成员名称和 `role` 中的职责说明，参与 leader 对成员的选择。

一次委托沿着以下路径执行：

1. leader 接收用户输入、Team 指令和成员信息，模型决定自己回答，还是调用委托工具。
2. 模型选择委托时，输出目标 `member_id` 和发给成员的 `task`。SDK 解析工具参数、查找目标成员，把委托内容交给该成员运行。
3. 成员使用自己的模型、指令和工具处理输入。需要调用搜索等工具时，由该成员的 SDK 工具循环执行；它完成后返回结果。
4. 返回内容成为 leader 这次工具调用的结果，加入 leader 的消息上下文。leader 再调用模型，可以继续委托、补充要求，或组织最终答复。

SDK 还会将成员运行关联到父 Team run，并在工具记录中保存子运行 ID。查看一次 Team 执行时，可以沿委托找到成员处理的过程；这层父子关系记录的是执行过程。

在这个示例中，“先研究、后写作”是给 leader 的协调要求。leader 要将它落实为委托调用，也要把研究结果放进后续写作所需的输入。改变指令或输入，可能改变它选择的成员、委托次数和任务内容。开发者提供了可选成员和协调要求，具体这一次怎样分工由模型决定。

成员上下文还需要单独配置。默认 `determine_input_for_members=True`，成员取得的是 leader 编写的 `task`。`add_team_history_to_members` 与 `share_member_interactions` 默认关闭，前者控制是否附加 Team 历史，后者控制是否附加本次运行中已有的成员交互。因此，Writer 需要 Researcher 的结果时，leader 应将结果写入新委托，或显式开启相应共享；只把两位成员放进 `members`，并没有完成材料交接。

### Workflow：由步骤定义决定调用顺序和数据交接

官方 Workflow Using Steps 示例同样做文章处理，但定义了 research、writing、editing 三个 Step，分别绑定研究、写作和编辑 Agent，再按这个顺序放入 `Steps`。研究 Agent 配置搜索工具，写作和编辑 Agent 处理前面产生的材料。省去模型定义，编排关系是：

```python
research_step = Step(name="research", agent=researcher)
writing_step = Step(name="writing", agent=writer)
editing_step = Step(name="editing", agent=editor)

article_creation_sequence = Steps(
    name="article_creation",
    steps=[research_step, writing_step, editing_step],
)
article_workflow = Workflow(steps=[article_creation_sequence])
```

这段摘录保留官方示例的步骤关系。工作流用 `StepInput` 携带原始输入和前序结果，用 `StepOutput` 保存当前步骤的输出。函数步骤可以直接读取 `StepInput` 中的这些数据；Agent 步骤的消息装配则优先取最近一个前序输出的内容，内容非空时直接作为输入，否则使用原始输入。

在这条顺序流程中，research 收到原始主题，writing 收到 research 的结果，editing 收到 writing 的草稿。后续 Agent 若还需要原始要求或更早步骤的材料，就要在上一步输出中保留它们，或显式组装输入。工作流保存着前序结果，与每个 Agent 实际收到哪些内容，需要分别设计。

research 是否需要搜索、搜索什么，仍由研究 Agent 的模型和工具循环决定；research 完成后调用 writing，则由已定义的步骤顺序决定。writing 返回草稿后，Workflow 执行器按 `steps` 列表调度 editing，并将草稿作为它的输入。

这也给修改流程一个明确位置：需要先审核研究材料，就在 research 与 writing 之间加入相应步骤；需要按结果分支，就在流程定义中提供条件判断。Team 适合将分工留给模型根据材料调整；Workflow 适合把必须执行的顺序、交接和控制条件写入程序。一个 Workflow 步骤也可以调用 Team，在固定流程中的局部保留动态协作。

这两种对象都能注册到 AgentOS。应用只需调用这个 Team 或 Workflow 的运行接口，内部的成员委托和步骤推进由相应组件完成。接入服务和定义编排是两件相连的工作：AgentOS 负责找到要运行的组件，组件内部的 Team 或 Workflow 决定输入怎样变成输出。更多 SDK 对象见[《Agno SDK：Agent、Team 与 Workflow 的执行机制》](/posts/agno-sdk-execution/)。

## Company：保存工作要求，把执行结果交给审查

一次接口调用结束后，工作可能还没被接受。它属于哪个项目、当初要求是什么、结果为什么被退回，都需要保存到下一次执行。Agno 的 Company 在运行服务之上提供了这些工作记录。

Company 需要显式启用。它把工作分成 Product、Project 和 Task 三层。官方 `06_execute_tasks.py` 示例创建名为 SDK 的 Product，建立其中的一轮 Release 发布项目，再创建“起草发布说明”（Draft release notes）的 Task，要求整理经过审查的变更。Task 保存工作要求和证据引用；程序另外注册 ID 为 `draft` 的 Workflow，负责取得任务输入并返回待审文本。

### 从 Task 到已注册组件

示例将 Task 转为 `ready` 时，同时写入 `executor_type="workflow"`、`executor_id="draft"`。这一步明确了工作范围和执行组件。随后，应用为这项 Task 发起 `attempt=1` 的运行请求。Company 按执行类型和 ID 从 AgentOS 的注册表查找组件，将工作交给已经定义好的 Workflow；组件的选择来自 Task 上的绑定。

交给组件的输入也有明确结构。Company 将 Task 的 `brief`、公司级与当前产品的 wiki 正文、`evidence` 序列化为 JSON，并为已接受的执行添加第四项 `execution_context`，其中包含任务标识和交付要求。官方的 `draft` Workflow 包含确定性函数，它读取这份输入、直接返回文本，不调用模型。将执行者换成 Team 时，同一类 JSON 先成为 Team 的输入，再由 leader 决定怎样拆成发给成员的 `task`。

运行请求复用 AgentOS 对应组件的运行接口，并设置后台执行、非流式返回。持久队列保存待执行工作，worker 根据已注册组件标识找到 Workflow 或 Team，再调用它的执行方法。因此，执行组件需要配置数据库，AgentOS 需要启用持久队列与 worker；只建立 Task 记录还没有接通执行。官方示例分别配置 Company 记录与队列存储，其中队列使用 PostgreSQL。

### Task、尝试与成员 run 分别保存什么

同一 Task 下，`attempt` 标识一次执行尝试，Task ID 与 attempt 共同确定该次运行的标识。官方示例连续两次提交 `attempt=1`，检查返回的是同一个 run ID。这使调用方在响应丢失后可以重试提交，取得已有执行，而不是每次请求都新建一次尝试。

组件正常返回后，run 显示完成，Task 进入 `in_review`。程序步骤结束与交付被接受分别记录；审查通过后，Task 才进入 `done`。需要修改时，后续尝试继续关联同一项工作的要求和审查记录。若执行者是 Team，这次 Task 运行下面还可以有多个成员 run：Company 关联整项工作的一次执行，Team 的父子运行关系说明这次执行内部委托过谁。

普通问答和 Workflow 仍可以直接调用。Company 增加的是产品、项目和任务记录，将已有执行能力接入接受工作、执行尝试和交付审查。它没有替代 Team 的成员选择或 Workflow 的步骤控制。

![Paperclip 与 Agno 的两条使用路径：组织配置并接入执行者，或定义组件并启动服务；两者都可以把执行关联到持续工作的记录与审查](/assets/images/posts/paperclip-agentos-control-runtime-mechanism.png)

*图：上排是 Paperclip 的岗位与工作，通过 adapter 连接 Agent，并在工作台跟踪交付；下排是 Agno SDK 定义的组件，经 AgentOS 提供 API，再由 Control Plane 连接操作。Company 可以在运行服务之上启用，保存长期任务和审查记录；普通组件运行可以直接进入 AgentOS。*

## 从成员协作回到长期任务

Paperclip 的角色交接经过 Issue：上一位留下结果、分派后续工作，接收者在唤醒后领取任务、读取材料。两位角色之间传递的是工作记录与处理责任，各自内部怎样调用模型和工具，由接入的 Agent 决定。

Agno Team 的成员交接经过委托工具及其返回值，Workflow 的交接经过步骤输入输出。Company 在外层保存整项工作的要求、执行尝试与审查；Task 绑定 Team 时，内部仍按委托机制协作，绑定 Workflow 时则按流程定义推进。开发者可以分别修改长期任务的执行者，以及执行组件内部的成员和流程。

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

通用 HTTP adapter 的接入参数包括远端 `url`、请求方法、headers、超时与可选的 `payloadTemplate`。默认以 POST 发送 JSON：先放入模板字段，再写入本次的 `agentId`、`runId`、`context` 和 `connectionInstructions`；有运行时工具定义时，还会附上 `paperclipRuntimeTools`。远端据这些材料找到接入身份及本次工作，也可以用 run ID 关联自己的执行记录。

这条固定实现检查 HTTP 状态，成功时返回 `exitCode: 0` 与请求摘要；它没有读取响应体中的作业结果。因此，远端若仅把工作放入队列后返回成功，Paperclip 这一轮记录的是请求已获成功响应。要继续跟踪远端作业，接入方还需保存作业标识、查询最终结果，并通过任务接口回报进展、产物与费用。适配器的请求配置接通了调用，任务回报接通了交付。

取消也要沿这条调用关系追下去。停止等待 HTTP 响应后，远端作业可能还在运行；任务改为不再进行时，已经发出的工具操作也可能继续。需要确认实际执行者有没有收到取消、有没有停止，以及已经发生的外部写入怎样处理。

AgentOS 的持久队列保存待执行工作及运行关联，使请求进程退出后仍有继续处理的依据。但队列重试可能重新执行一次 run：如果上一次已经对外部系统写入成功，重新执行就可能再次写入。要避免重复，仍需为操作提供标识、实现幂等处理，或先查询已有结果。

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

如果 Company Task 同时独立管理相同要求和验收，两边就可能分别改派、退回或发起执行。这时需要规定哪一边可以修改工作范围，另一边怎样跟随；重试时也要区分，是查询已有运行，还是确实开始新一次尝试。

Paperclip 与 Agno AgentOS 的典型入口不同，长期任务管理又使它们成为部分重叠的选择。判断应落在手头的工作上：从哪里提出要求，由谁推进执行，在哪里接受结果。先确认一套产品能把这条路径走到哪一步，再决定是否值得维护两套系统之间的连接。

## 主要资料

- Paperclip 官方文档：What is Paperclip、Create Your First Company、Hire Your First Agent、Watching Agents Work、Execution Policy、Costs & Budgets。
- Paperclip 源码：HTTP adapter、任务服务、heartbeat 调度与恢复实现。
- Agno 官方文档：SDK Introduction、Run Your First AgentOS、Connect Your AgentOS、Control Plane、Approvals Overview、Durable Queue。
- Agno 官方编排示例：Coordinate Mode、Workflow Using Steps。
- Agno Company 官方示例：Company README、`06_execute_tasks.py`。
- Agno `v3.1.11` 发布说明：外部 Agent 与 Team、Workflow 的接入。
