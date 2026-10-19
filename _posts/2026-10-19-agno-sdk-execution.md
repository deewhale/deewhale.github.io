---
layout: post
title: "Agno SDK：Agent、Team 与 Workflow 的执行机制"
description: "沿一次项目进度查询，拆开 Agno 的提示词、工具循环、Team 委托与 Workflow 数据传递，说明历史、状态、记忆和知识的保存与使用条件。"
image: /assets/images/posts/agno-sdk-execution-execution-map.png
image_alt: "Agent、Team 和 Workflow 三行执行图，分别展示模型选工具、leader 委托成员和程序安排步骤"
date: 2026-10-19 19:36:15 +0800
categories: [AI, Engineering]
tags: [Agno, AI Agent, Python, Workflow]
---

“查一下 ALPHA 项目进度，写成一段简报。”

这句话可以交给一个带查询工具的 Agent，也可以交给一个负责委托的 Team，或者写成先查询、再生成的 Workflow。三种实现最后都可能返回“已完成 3/5，等待评审”。只看这段文字，很难判断查询是否发生、谁选择了查询对象、数据怎样抵达写作环节，以及失败后是否还会继续生成。

Agno 是组织这类执行过程的 Python 框架。它连接模型、工具和数据，也提供多成员协作、步骤编排、持久化与运行服务。理解 SDK 的入口，是追踪一条请求在这些对象之间怎样移动：**模型在哪一步作选择，Python 在哪一步执行，下一步由谁决定。**

以下以 Agno 3.1.3 为代码基线，资料核查截至 2026 年 10 月 19 日。ALPHA、项目数据与提示词均为假设示例。真实模型版本的示例已检查导入和对象构造；执行机制另用预设模型响应驱动真实 SDK 验证，尚未实测外部模型的选择与回答质量。

## 一次 Agent 执行包含两种程序

先把最小实现写全。以下程序需要 Python 环境、`agno==3.1.3`、`openai==3.35.1`，并在运行前设置自己的 `OPENAI_API_KEY`。先安装依赖：

```bash
python -m pip install agno==3.1.3 openai==3.35.1
```

保存为 `progress.py` 后执行 `python progress.py`，会向指定模型发起真实请求并产生相应费用。

```python
from agno.agent import Agent
from agno.models.openai import OpenAIChat


def get_progress(project: str) -> dict:
    """Read delivery progress for a project.

    Args:
        project: Project code, for example ALPHA.
    """
    if project != "ALPHA":
        raise ValueError("unknown project")
    return {
        "project": project,
        "completed": 3,
        "total": 5,
        "blocker": "waiting for review",
    }


agent = Agent(
    model=OpenAIChat(id="gpt-4.1-mini"),
    tools=[get_progress],
    instructions=(
        "Look up progress with the tool, then write a brief "
        "with completed, total and blocker."
    ),
    telemetry=False,
)

if __name__ == "__main__":
    output = agent.run("Write a progress brief for ALPHA")
    print(output.content)
```

这里有两种性质不同的程序。`get_progress` 是普通 Python 函数：收到项目代号，查询并返回数据，或者抛出异常。真实应用中，可以把函数体换成数据库或业务 API 查询。它的身份校验、权限与数据正确性，由应用实现负责。

`instructions` 描述的是模型应该怎样处理任务。Agno 将它用于构建 system message，把 `run()` 的文本输入作为 user message，再交给 `OpenAIChat` 适配器转换为供应商的请求。角色描述、输出配置等也会参与消息组织；显式提供 `system_message` 时有独立的优先路径，不能把所有配置理解为永远按同一顺序拼接字符串。

两者通过工具定义连接。Agno 从函数名、docstring 和类型提示生成模型可见的 JSON Schema。这个例子的工具名是 `get_progress`，参数 `project` 是必填字符串，说明文本解释了项目代号的用途。模型获得的是可调用能力的描述，Python 实现仍在应用进程中。

因此，`tools=[get_progress]` 同时完成两件事：为模型提供选择工具和填写参数所需的信息，为 SDK 注册真正能够执行的函数。只写一个工具名称而没有实现，无法得到业务数据。

## 模型请求调用，SDK 执行函数

调用 `agent.run()` 后，关键轨迹可以展开成下面五步：

```text
应用 → 模型：system 指令 + user 请求 + get_progress 的工具定义
模型 → SDK：调用 get_progress，参数 {"project": "ALPHA"}
SDK  → Python：执行 get_progress(project="ALPHA")
SDK  → 模型：将工具结果作为 tool 消息回填，关联这次调用的 ID
模型 → 应用：根据工具结果生成简报，run 返回 RunOutput
```

第二步中的 tool call 是模型的输出。第三步才真正发生查询。回填时还需要调用标识，因为同一轮可能有多次工具调用，结果必须对应到正确的请求。模型拿到结果后，可以继续请求工具，也可以输出最终回答。Agno 的模型执行层负责推进这个循环。

这解释了 Agent 的自主性具体在哪里：输入没有预先规定所有中间动作，模型在可见工具和当前消息的范围内选择下一步。提示词要求“先查后写”，属于这条选择过程的约束。对于“每次必须查到有效数据才能继续”这样的业务要求，还需要程序可检查的执行记录或控制流。

离线验证保留了真实的 Agent、工具注册、Python 执行与结果回填，只将底层模型响应换成预设序列。先预设一次 `get_progress` 调用，再预设最终简报，实际观察到：工具 schema 包含必填的 `project`；函数以 `ALPHA` 执行；后续模型请求包含工具结果；`RunOutput.content` 为 `3/5; waiting for review`。这组观察支持 SDK 连接与调度机制，不能说明真实模型每次都会正确选工具或忠实使用返回值。

失败分支更能说明 `run()` 的边界。将预设调用参数改为 `UNKNOWN`，Python 函数抛出 `ValueError("unknown project")`。受测路径把它记录为工具错误，`tool_call_error=True`，并将错误信息反馈给下一次模型请求；最终仍然可以返回一段文字。

所以，业务代码应消费 `RunOutput`，检查工具记录中的参数、结果和错误，并按任务约定验证最终内容。`print_response()` 便于显示，`content` 便于取正文，但“拿到了正文”只是执行结果的一个字段。工具是否成功、正文中的数字是否对应工具结果，是另外两项检查。

对这个单 Agent 示例，可以在文件中加入下面的检查函数，并用最后两行替换入口中的 `print(output.content)`。先检查真正执行了预期查询，再采用简报：

```python
import ast


def checked_progress(output):
    records = output.tools or []
    if any(item.tool_call_error for item in records):
        raise RuntimeError("tool failed")
    matches = [
        item for item in records if item.tool_name == "get_progress"
    ]
    if (len(matches) != 1
            or matches[0].tool_args != {"project": "ALPHA"}):
        raise RuntimeError("expected lookup missing or unexpected arguments")
    facts = ast.literal_eval(matches[0].result or "")
    if not isinstance(facts, dict) or facts.get("project") != "ALPHA":
        raise RuntimeError("invalid project result")
    if (type(facts.get("completed")) is not int
            or type(facts.get("total")) is not int):
        raise RuntimeError("invalid counts")
    if not 0 <= facts["completed"] <= facts["total"] or facts["total"] <= 0:
        raise RuntimeError("counts out of range")
    if not isinstance(facts.get("blocker"), str):
        raise RuntimeError("invalid blocker")
    return facts


# 放在入口中的 output = agent.run(...) 之后
facts = checked_progress(output)
print(output.content)
```

在这个版本的受测路径中，工具记录的 `result` 是字符串，普通字典被转成 Python 字面量表示，因此这里用 `ast.literal_eval` 读取，并继续检查类型和取值；解析失败会抛出异常，阻止后面的输出。实际接口也可以在工具内明确返回 JSON，再用 JSON 解析与领域 Schema 校验。不能把这个字典字符串直接当成标准 JSON。

这段检查已用真实 SDK 的离线执行结果验证：正常查询通过，工具异常与完全没有查询两种结果被拒绝。它证明查到了指定项目并检查了字段形状与计数关系，仍需将最终回答与 `facts` 对照，才能判断是否忠实使用了来源。Team 的委托记录与 Workflow 的步骤记录有不同层次，这个检查函数针对单 Agent 的直接查询，不能原样推广到全部结构。


![Agent、Team 和 Workflow 三行执行图，分别展示模型选工具、leader 委托成员和程序安排步骤](/assets/images/posts/agno-sdk-execution-execution-map.png)

*图：三种结构中的请求与结果传递。*

图的第一行是一名 Agent 的模型—工具循环。第二行把一次工具选择变成向独立成员的委托，成员内部仍可能运行第一行。第三行把查询和写作排成代码定义的步骤。图中箭头相似，控制箭头出现的条件不同。

## Team 增加的是独立执行单元

假设查询需要独立工具权限或专门指令，可以把它交给一个成员，让 leader 负责整理。沿用上面的 `get_progress`，把以下代码放在同一文件中，可以替代单 Agent 的构造和入口；额外导入 `Team`，其余模型依赖与密钥设置相同。

```python
from agno.team import Team

researcher = Agent(
    id="researcher",
    name="Researcher",
    role="Look up project facts",
    model=OpenAIChat(id="gpt-4.1-mini"),
    tools=[get_progress],
    instructions="Use get_progress; return the original fields.",
    telemetry=False,
)

team = Team(
    model=OpenAIChat(id="gpt-4.1-mini"),
    members=[researcher],
    instructions=(
        "Delegate lookup to Researcher, then write a brief "
        "from the returned facts."
    ),
    telemetry=False,
)

if __name__ == "__main__":
    output = team.run("Write a progress brief for ALPHA")
    print(output.content)
```

这里用一个成员就足以看清委托，增加人数不会改变基本关系。leader 与成员各自拥有模型配置和指令；成员还拥有查询工具。默认协调方式下，leader 的模型可见一个 SDK 提供的委托工具。在 3.1.3 中，它叫：

```text
delegate_task_to_member(member_id: str, task: str)
```

`member_id` 必须对应已注册成员的 ID，`task` 是交给该成员的具体工作。SDK 收到这次工具调用后找到成员，执行成员的 `run`，再把其回答作为委托工具的结果交还 leader。leader 获得结果后继续自己的模型循环，形成最终回答。

预设响应实验实际走过了这条路径：leader 请求委托 `researcher` 查询 ALPHA；成员收到自己的角色与指令组成的 system message，以及 leader 任务组成的 user message；成员调用 `get_progress` 并获得数据；成员回答进入 leader 的下一次模型请求；leader 再生成简报。

这与“在一个提示词里列出研究员和编辑两个角色”有实质差别。这里存在独立模型请求、独立工具集合和独立消息上下文。需要不同职责、不同工具或上下文边界时，这种拆分才有明确用途；只为同一条查询增加包装，会增加模型调用和信息交接。

成员能够看到什么，尤其需要显式设计。当前默认 `add_team_history_to_members=False`，`share_member_interactions=False`。leader 知道的完整历史和其他成员交互，并不会无条件送给每个成员。委托任务如何形成也受相关配置影响；成员自己的历史注入设置仍另行生效。

例如 leader 知道“只统计已验收任务”，却只委托“查一下进度”。成员收到的工具返回 `completed=3` 时，可能根本不知道需要核对验收口径。修正点是把统计规则放入任务或明确配置必要上下文，并让工具提供能够验证规则的字段。增加一句“成员要协作”无法补上缺失数据。

同样，leader 的指令要求先委托再写作，仍然需要模型选择执行委托。如果查询发生与否必须受程序约束，就应把查询提升为显式步骤。

## Workflow 把先后关系写进代码

对于“必须先查，查不到就停止”的任务，可以让确定性函数负责查询，再让 Agent 负责表述。继续沿用第一段程序的 `get_progress`、`Agent`、`OpenAIChat`，以下代码替代构造和入口即可运行：

```python
from agno.workflow import Workflow
from agno.workflow.step import Step
from agno.workflow.types import StepInput, StepOutput


def lookup(data: StepInput) -> StepOutput:
    if data.input != "ALPHA":
        return StepOutput(content="unknown project", stop=True)
    return StepOutput(content=get_progress(data.input))


writer = Agent(
    model=OpenAIChat(id="gpt-4.1-mini"),
    instructions=(
        "Write a progress brief from the supplied facts. "
        "Preserve counts and blocker."
    ),
    telemetry=False,
)

workflow = Workflow(
    name="Progress",
    steps=[
        Step(name="lookup", executor=lookup),
        Step(name="write", agent=writer),
    ],
    telemetry=False,
)

if __name__ == "__main__":
    output = workflow.run("ALPHA")
    print(output.content)
```

外层收到的原始输入是项目代号 `ALPHA`。`lookup` 获得 `StepInput`，其中 `input` 保留这次 Workflow 的原始输入。函数返回 `StepOutput(content=...)`，把查询结果交给后一步。这里第二步是 Agent，主要接收最近步骤的输出，因此写作者拿到的是项目事实。

数据依赖复杂后，需要把“当前输入”与“先前输出”分开。函数步骤可通过 `previous_step_content` 取得最近输出，通过 `get_step_content("lookup")` 按名称取结果，也可以处理 `previous_step_outputs`。假如最后一步同时需要原始请求、查询结果和校验结果，应由函数明确组装这些材料，再交给模型。不能假定每个 Agent 步骤默认收到前面所有步骤的完整内容。

`stop=True` 则改变后续执行。对不存在的项目，查询步骤直接产生停止标记，写作步骤没有机会运行。离线验证将两个步骤均实现为普通函数，正常输入得到 `3/5; waiting for review`；输入 `UNKNOWN` 时，记录的已访问步骤只有 `lookup`。这验证了受测路径的停止行为。模型写作的忠实度仍需要另行测试。

查询成功后若还要核对 `0 <= completed <= total`，可以把这个条件放入函数步骤。模型负责处理自然语言，确定性代码处理能明确表达的约束，两者通过步骤输出连接。真实业务查询还应将超时、数据缺失等状态映射到明确的停止、重试或人工处理路径，而不是把任何错误都转成一段可供继续写作的普通文本。

Workflow 还提供条件、路由、并行和循环等结构。条件的判断可以来自函数，也可以依赖模型结果。外层顺序受代码组织，不代表步骤内部的模型输出就变为确定性内容。Team 也能成为某个步骤：外层规定何时协作，内层由 leader 选择如何分配任务。

## 保存了记录，还要决定模型能看到什么

简报生成后，用户下一次说“继续查上次的项目”，系统需要找回哪种信息？Agno 中几类数据各有用途，不能用一个“记忆”开关代替。

<div style="overflow-x: auto;" markdown="1">

| 数据 | 在简报任务中保存什么 | 怎样进入后续执行 |
|---|---|---|
| run | 一次请求、回答、工具记录与指标，用 `run_id` 定位 | 应用查询执行记录；记录存在不代表自动加入提示词 |
| session / history | 同一会话里的多次 run 和消息，用 `session_id` 关联 | 配置数据库保存；通过 `add_history_to_context` 等选项选择注入历史 |
| session_state | 已处理记录号、计数器等程序状态 | 工具通过 `RunContext.session_state` 读写；配置数据库后可跨 run 保存 |
| user memory | 用户偏好、从交互提取的长期事实，用 `user_id` 关联 | 配置记忆更新与使用，可跨 session 提供用户相关信息 |
| Knowledge | 交付规范、项目术语等可检索材料 | 摄入、建立索引，再检索相关内容加入模型上下文 |
{: style="min-width: 720px;"}

</div>

例如，要让模型理解“上次的项目”，可以启用 `add_history_to_context=True`，并用 `num_history_runs` 限制历史范围。3.1.3 默认不启用历史注入。数据库负责把数据留下，注入策略负责挑选本次模型要看什么；两者分别影响可追踪性、上下文长度和回答依据。

SQLite 离线实验检验了这一差别：工具通过 SDK 注入的 `RunContext` 把会话计数器从 0 改为 1，下一次以同一 `session_id` 运行，保存的状态仍为 1；但在未开启历史注入时，下一次模型请求没有上一轮的文本。工具所需的 `run_context` 由框架提供，不要求模型生成这个参数。

若要在简报程序中明确开启数据库与历史，可以在原来的 Agent 构造时增加如下配置。SQLite 依赖可安装 `sqlalchemy[asyncio]==2.1.5`：

```python
from agno.db.sqlite import SqliteDb

persistent_agent = Agent(
    model=OpenAIChat(id="gpt-4.1-mini"),
    tools=[get_progress],
    instructions="Query progress first, then write a brief.",
    db=SqliteDb(db_file="progress.db"),
    add_history_to_context=True,
    num_history_runs=3,
    telemetry=False,
)
# 认证后由应用绑定标识；后续请求沿用同一 session_id
result = persistent_agent.run(
    "Write a progress brief for ALPHA",
    session_id="progress-conversation",
    user_id="authenticated-user",
)
```

这里的 SQLite 保存执行数据，历史选项把同一会话最近的运行加入模型上下文。示例标识用于展示绑定位置，真实服务应从可信认证结果取得用户标识，并控制会话归属。

结构化状态适合记录“处理到第几条”等应用事实。用户长期偏好则适合 user memory。按配置，`update_memory_on_run` 可以在运行后更新记忆，`enable_agentic_memory` 让模型通过相应工具管理记忆。稳定的 `user_id` 帮助关联数据，但这个字符串本身不能证明身份；应用应在认证后绑定它，并核对用户是否有权访问 ALPHA。

Knowledge 又有不同的数据路径：读取材料、切分内容、建立 embedding 或其他检索索引，按问题检索匹配片段，再提供给模型。会话数据库留下“之前说过什么”，知识检索解决“当前问题需要哪部分材料”。即使同一种数据库能承担两种存储，配置与使用过程也不同。这里未实际连接向量与 embedding 服务，无法从前面的工具循环实验推断检索质量。

输出也可以结构化。当前版本的参数名为 `output_schema`，可以指定 Pydantic 模型等输出约束。它有助于把回答解析成约定字段；若模型返回 `completed=4`，仍需与查询到的 3 对照。字段类型、来源一致性与业务正确性需要不同检查。

## 从 Python 程序到运行服务

前面的程序直接调用 SDK，已经能够执行 Agent、Team 和 Workflow。需要把它们提供给其他应用时，可以使用 AgentOS。它是基于 FastAPI 的自托管运行层，承接执行接口、流式事件、追踪、数据库与工作调度等服务能力。

服务配置会引入新的责任。3.1.3 的 AgentOS 构造参数 `authorization` 默认是 `False`；需要 JWT 授权时，应开启并配置可信令牌和对应权限。接口认证确认请求者是谁，工具中的项目权限检查决定他能查什么。两者配合，才能阻止一个合法用户查询其他人的项目。本文只核查了相关文档与源码，没有部署服务或实测授权行为。

长任务还需要明确恢复目标。Agno 当前提供人工介入的暂停与 `continue_run`、checkpoint，以及 durable 队列等不同机制。启用持久队列需要相应的 durable 配置、支持协议的持久化存储和 worker；仅给普通进程内任务配置数据库，不能由此推断进程重启后会从任意位置继续。本文没有执行宕机恢复实验，恢复能力应按所选机制和故障场景验收。

外部副作用需要业务系统共同参与。假设以后把“查进度”扩展为“创建评审任务”，远程系统已经创建成功，应用却在登记成功前崩溃。重新领取任务后再次创建，可能产生重复记录。框架层的请求去重与租约不能独自消除这个窗口；业务 API 还需要可重复使用的操作 ID、幂等处理和结果查询。

## 按必须成立的规则选择结构

对于一个工具域里的查询与回答，先从单 Agent 开始，检查模型提出的调用、实际工具结果和最终内容能否对应。只有需要独立职责、工具权限或上下文时，再增加 Team 成员，并明确委托任务必须带上哪些事实。

如果要求是“查询必须发生”“计数无效必须停止”“审批通过才能提交”，把这些条件编码进工具或 Workflow 的函数步骤。可以让某一步使用 Team 完成复杂判断，但执行权限和必须成立的约束应由相应程序与业务系统维护。

采用 Agno 前，最有用的设计材料是一条具体请求的路径：输入从哪里来，模型能选择什么，Python 实际执行什么，哪条记录证明成功，哪个失败结果会阻止下一步。能画清并验证这条路径，才有依据扩大工具、成员和运行规模。

## 主要资料

- Agno：Tools Overview
- Agno：Teams Overview 与 Delegation
- Agno：Workflows Overview
- Agno：Sessions、State、Memory 与 Knowledge Overview
- Agno：AgentOS Overview
- Agno 3.1.3 源码：Agent、Model、Function、Team、Workflow 与 AgentOS
