---
layout: post
title: "Pi 1.0：原生 MCP 与 Code Mode 的工具编排设计"
description: "从 Pi 1.0 接纳原生 MCP 的设计转变出发，用同一文档任务贯通 direct、deferred 与 Code Mode，解释工具 loadout、共同调用管道、结果过滤及失败后的状态，并提供真实 MCP 集成的可运行案例。"
image: /assets/images/posts/pi-mcp-tool-exposure-mechanism.png
image_alt: "直接调用把中间结果交回模型决定下一步，Code Mode 在脚本内编排 MCP 工具并筛选结果，经统一执行路径后把选定输出交回模型"
date: 2026-10-20 17:03:07 +0800
display_date: 2026-10-16
last_modified_at: 2026-10-20 18:09:37 +0800
categories: [AI, Engineering]
tags: [Pi, MCP, Code Mode, Tool Search, Harness]
---

让 Agent 读取三个版本的发布说明，提取破坏性变更，形成升级检查清单。传统工具调用里，模型先取得版本目录，再请求几份文档，文档结果回到上下文，模型继续处理。若服务提供几十个接口、每份文档又包含大量无关细节，任务中有两类材料会反复经过模型：工具定义，以及中间查询结果。

Pi 1.0 将原生 MCP 与 Code Mode 一起带进稳定版本，关键变化正落在这两处。MCP 提供结构化的服务发现与调用接口；Code Mode 让模型写出一段程序，由 harness 执行查询、循环、并发和筛选，只把选定内容送回模型。工具连接、模型声明与程序编排由此进入同一套运行时设计。

这也解释了 Pi 对 MCP 的态度变化。2026 年 9 月 29 日的官方文章《You Said No MCP!》讨论的核心是组合性：接上一个协议，不会自动得到把多个接口顺畅组合起来的工作方式。10 月 1 日发布的 Pi 1.0，将解释器、原生 MCP 和改造后的工具模型收敛为稳定产品。相关内置能力在此前 0.99.0 已经出现；1.0 是稳定发布的汇合点。

以下先解释这项组合设计，再用一个真实运行的本地 MCP 服务比较三条路径。历史定位依据 1.0 公告，配置与实现固定为官方 v1.3.0，资料核查截至 2026 年 10 月 20 日。文档样本是教学数据，模型响应由人工预设；真实运行的是 MCP 子进程、注册、工具搜索、QuickJS 脚本和共同调用管道。

## 从命令行组合到 harness 内编排

熟悉 Shell 的开发者会用管道组合工具：取得一批记录，解析字段，过滤，再把少量结果交给后面的程序。中间每条记录无需经过一次人的判断。MCP 为外部服务提供了名称、参数定义和调用方式，但如果每项返回都先进入模型上下文，很多本来可以由程序完成的转换仍然需要通过模型传递。

Pi 的设计是在 harness 一侧放一个可复用的 JavaScript 解释器。模型提出组合程序，解释器运行其中的确定性步骤，工具桥接把调用交给宿主，结果回到脚本变量。模型仍负责提出程序、理解最终材料和形成回答，循环与字段筛选则可以由运行时代为完成。

这和让模型写一条 `bash` 命令有相似的组合目标，执行位置有所不同。bash 通常在工具执行环境中运行，那里可能是本地工作区，也可能是远程容器。Code Mode 位于 harness 侧，通过已注入的工具接口协调能力。一个远程文件工具、一个 HTTP 文档服务和一个模型接口，可以被同一个编排程序组合，而不要求它们都成为远程 Shell 中的可执行文件。

这层解释器也因此不限于 MCP。官方示例将 issue 查询与 Jev 分类器组合，说明相同机制可以协调结构化查询和其他模型服务。MCP 提供一批接口，Code Mode 提供组合这些接口的执行位置；有了后者，接入前者才不必意味着把整套工具目录和所有原始结果常驻模型上下文。

但一个普通的“工具名、参数、执行函数”列表还不够。harness 需要知道：哪些定义应直接交给模型，哪些只在脚本里可调用，接口属于哪个命名空间，发现时应该显示什么，以及调用以后拿到什么类型的值。Pi 因此同时改造了工具 loadout，即当前会话怎样组织和呈现可用工具的描述。

## 工具 loadout 怎样连接发现、声明与执行

可以把同一工具在运行时的状态分开观察：服务已经连接并注册它；模型当前请求是否声明它；脚本能否通过工具桥接访问它。这三个问题分别影响连接、上下文和执行，不能只用一个“启用”开关表达。

在 0.99 到 1.0 的这轮设计中，Pi 的扩展接口加入 exposure、namespace、annotations、输出定义与结构化结果等元数据，并提供 loadout 准备和嵌套执行能力。它们共同解决的是同一条路径：先安排工具怎样被找到，再为具体入口提供合适描述，最后仍通过明确的运行时代码执行。

其中几项职责尤其重要：

| 信息或接口 | 解决的问题 | 在文档任务中的位置 |
|---|---|---|
| exposure | 哪种入口能看到和使用工具 | 搜索、读取接口先声明，还是按需发现 |
| namespace 与描述 | 大目录怎样缩小候选范围 | 只在 `docs` 服务中找发布说明工具 |
| 输入、输出定义与结构值 | 程序怎样构造参数和取字段 | 从目录取 `versions`，从结果取 `breaking` |
| `prepareLoadout()` | 当前请求如何准备工具呈现 | 让声明与实际会话工具状态对应 |
| `ctx.executeTool()` | 脚本嵌套调用如何进入宿主管道 | 参数校验、前后事件及扩展检查仍发生 |

这些元数据让“按需提供信息”有了具体对象。工具可以保持已注册，而完整定义暂不进入请求；脚本需要时查名称和类型；执行工具时再经过共同管道。它也要求工具作者提供可用于程序的输出，只有一大段适合人阅读的文本，会增加后续解析和核对负担。

异步连接使这套状态还会随会话变化。Pi 用相对稳定的工具说明，并通过追加服务摘要表达可用服务变化，减少反复改写前部描述。这样的设计有利于保持已有请求前缀，但缓存是否命中仍取决于模型提供方与实际请求，不能由实现意图直接推成成本结论。

1.0 发布记录给出过一个具体设置下的提示词观察：GPT-5.6、默认工具与 Code Mode 的请求，由约 5300 prompt tokens 缩到约 3300。这里涉及简化固定说明和按需提供接口参考。它与脚本在运行中筛掉文档内容是两种机制，也不能直接换算成所有 MCP 工作负载的总费用降幅。

## 同一个任务的三条路径

先保持目标和服务不变：列出版本，读取三份说明，保留破坏性变更和证据。工具只有 `list_releases` 与 `read_release`。区别在于，谁看到接口、谁负责组合动作，以及原始数据到哪里去。

`direct` 将工具直接声明给模型。模型先调用目录，再根据结果决定读哪些版本；多个独立读取可以在同一个 assistant 消息中批量提出，运行时能够并行执行。直接调用并不要求每一份文档都单独推理一次。主要代价是定义从一开始就占据请求位置，工具结果也会进入模型历史。

`deferred` 推迟完整声明。模型先调用 `tool_search` 找到相关工具，命中项进入活动集合，下一次模型请求才看到对应定义。此后的目录读取和文档读取仍走模型原生调用路径。它改变的是接口何时出现，中间结果仍要回到模型。

Code Mode 则让模型提出一段组合程序。脚本发现接口、读取目录、并行取文档、检查错误、选择字段，最终输出一个小结果。目录和完整文档可以留在解释器中间变量里，模型读取的是程序显式输出的内容，以及形成和理解程序所需的材料。

| 比较维度 | direct | deferred | Code Mode |
|---|---|---|---|
| 初始接口定义 | 直接声明 | 相关工具暂未完整声明 | 先提供脚本入口与发现方式 |
| 发现动作 | 已有定义可直接选 | `tool_search` 加载声明 | 脚本 `searchTools`、`describeTool` |
| 谁组织依赖 | 模型提出后续调用 | 加载后由模型组织 | 模型写程序，解释器推进程序 |
| 原始结果去向 | 模型工具历史 | 模型工具历史 | 先进入脚本，选择后再输出 |
| 独立调用并行 | 支持 | 支持 | 通过程序组合支持 |
| 失败如何处理 | 结果回模型再判断 | 同 direct | 脚本可先分类和保留未完成项 |

![直接调用把中间结果交回模型决定下一步，Code Mode 在脚本内编排 MCP 工具并筛选结果，经统一执行路径后把选定输出交回模型](/assets/images/posts/pi-mcp-tool-exposure-mechanism.png)

图中变化的是控制与数据经过模型的位置。三条路径仍可能发出完全相同数量的外部请求；Code Mode 也需要生成程序、发现定义、运行工具和输出结果。只有当中间转换足够明确、原始数据中有大量可省略内容时，这层编排才有机会减少不必要的模型输入与往返。

MCP 配置还有 `hidden`，用于关闭此客户端中的对应入口。默认 MCP exposure 为 `codemode`。`codemode` 与 `deferred` 具有重叠的可达性，主要差别之一是自动启用的发现入口：前者引导脚本，后者引导工具搜索；并非两个互斥权限域。Pi 的通用工具层也会把 MCP codemode 映射到延迟暴露。

这些方式可以在同一服务中按工具选择。把少量常用查询直接声明、大目录延迟发现、批处理交给 Code Mode，是一种合理组合。外部服务令牌具有什么权限，则要另外配置。

## 服务怎样进入这条路径

要看见以上差别，需要先有一个真正可调用的服务。本文的 mock 服务通过 stdio 交换 JSON-RPC，实现 `initialize`、`tools/list` 和 `tools/call`。初始化返回服务器身份与工具能力；工具列表给出两个接口的名称和输入定义；调用再返回内容与结构值。

它的工具目录核心如下，完整服务代码在后面的附件中：

```javascript
const tools = [
  {
    name: 'list_releases',
    description: 'List release versions',
    inputSchema: {
      type: 'object', properties: {}, additionalProperties: false
    }
  },
  {
    name: 'read_release',
    description: 'Read one release and breaking changes',
    inputSchema: {
      type: 'object',
      properties: {version: {type: 'string'}},
      required: ['version'], additionalProperties: false
    }
  }
];
```

目录返回 `versions: ['1.0', '1.1', '1.2']`。读取存在的版本时，返回 `version`、`breaking` 和 `evidence`；读取 `missing` 时，返回 `isError: true`。这些版本与变更是实验材料，不代表 Pi 对应版本的实际发布说明。

配置文件需要给 Pi 提供启动方式。用户级 `~/.pi/agent/mcp.json` 可以采用以下结构，路径占位需换成下载后脚本的实际绝对路径：

```json
{
  "mcpServers": {
    "docs": {
      "command": "node",
      "args": ["<mock-docs.mjs 的绝对路径>"],
      "description": "Release documentation evidence",
      "exposure": "codemode"
    }
  }
}
```

`command` 与 `args` 启动服务进程；HTTP 服务使用对应 URL 配置。Pi 连接并取得工具列表后，注册供会话使用的接口，再按 exposure 安排呈现。配置存在、进程启动、协议初始化、工具注册，是可逐步检查的不同状态。

实际 CLI 接入时，可用 `pi mcp list` 检查服务，在交互会话中用 `/mcp` 查看来源、连接状态和认证需求，修改后用 `/reload` 加载。HTTP 服务若要求 OAuth，可通过 `/mcp login docs` 完成登录。连接在后台并发建立，首次提示主要等待 direct 工具，默认最多等待 10 秒；间接入口在需要相关服务时再等待。

本文附件的 runner 自动生成隔离配置并等待工具注册，不会改用户配置。这个显式等待使实验关注注册后的三种路径，未验证首次提示的等待时序或真实 OAuth 登录。

项目还可以在受信任后提供 `.pi/mcp.json`。同名项目项给出完整启动定义时会替换用户定义；1.0.1 增加轻量覆盖，只允许改变 `enabled`、`exposure` 与 `toolExposure`，保留已有启动方式和凭据。例如项目可以将默认入口改为 hidden，只开放读接口：

```json
{
  "mcpServers": {
    "docs": {
      "exposure": "hidden",
      "toolExposure": {
        "list_releases": "deferred",
        "read_release": "codemode"
      }
    }
  }
}
```

`toolExposure` 是整张映射替换，不逐项递归合并；精确原始工具名优先，通配规则则按配置顺序采用第一个匹配项。审查有效配置时，要检查完整开放清单。工具隐藏只限制当前 Pi 入口，不会撤销服务令牌，也不会限制服务进程可访问的文件与网络。

配置文件可能启动程序，项目信任因此涉及执行代码的来源。项目不能新建 `auth.provider` 路由是一项具体限制，不能替代操作系统层隔离。对文档任务，服务端只读权限与窄工具清单共同决定允许发生的动作。

## 发现名称之后，还要取得接口说明

在延迟路径里，`tool_search` 搜索候选并将命中工具加载到下一次模型声明。Code Mode 里的 `searchTools` 返回候选名称与接口参考描述，不会把它们自动变成模型当前直接声明的工具。返回描述本身可以包含 TypeScript 接口样本；脚本也可以用 `describeTool` 按名称定点取得输入输出说明。关键是查看实际接口参考，不能只读名称就猜参数。

两者虽然都叫搜索，造成的状态变化不同。前者改变后续模型请求的 loadout；后者服务于当前脚本理解接口。把它们合称为“懒加载”，容易漏掉模型与程序各自取得什么信息。

```javascript
const found = await searchTools('release', {namespace: 'docs'});
text({found: found.map(x => x.name)});
text(await describeTool('mcp__docs__read_release'));
```

这是实际实验脚本的起点。样本服务的两个注册名已经确认，因此后面使用固定名称；真实接入应根据返回候选选择接口，不能仅凭服务名与原始工具名手工拼接。注册名可能经历净化或冲突处理，名称猜对也不代表参数猜对。

`searchTools`、`describeTool` 和 `describeNamespace` 都是异步 helper，需要 `await`。当前搜索使用 BM25，根据工具名称、说明、参数和 namespace 等材料排序，默认返回八项，分词主要处理 ASCII 字母数字。英文服务描述下，使用 `release`、`search` 等对应关键词，比假定中文查询一定具备语义检索能力更稳妥。

发现质量也取决于服务作者。描述只写“执行操作”，会使查询很难区分用途；明确操作对象、输入字段和返回内容，脚本才能在大目录中挑出合理候选。命名空间提供范围，具体描述提供区分度，两者都无法替代业务授权。

## 让程序保留错误，再选择输出

找到接口后，实际脚本先取目录，再批量读取三个版本和一个缺失版本。它在正常结果中选择破坏性变更与短证据，同时保留缺失项：

```javascript
const index = await tools.mcp__docs__list_releases({});
const versions = [...index.structuredContent.versions, 'missing'];
const rows = await Promise.allSettled(versions.map(version =>
  tools.mcp__docs__read_release({version})
));
return rows.map((r, i) =>
  r.status === 'rejected'
    ? {version: versions[i], status: 'rejected'}
    : r.value.isError
      ? {version: versions[i], status: 'tool_error'}
      : {
          version: versions[i],
          breaking: r.value.structuredContent.breaking,
          evidence: r.value.structuredContent.evidence.slice(0, 35)
        }
);
```

实际脚本返回以下短结果，`evidence` 末尾的换行按 JSON 转义表示；这里没有省掉其他返回条目：

```json
[
  {
    "version": "1.0",
    "breaking": [],
    "evidence": "Release 1.0: verified fixture line\n"
  },
  {
    "version": "1.1",
    "breaking": ["rename retryLimit to retries"],
    "evidence": "Release 1.1: verified fixture line\n"
  },
  {
    "version": "1.2",
    "breaking": [],
    "evidence": "Release 1.2: verified fixture line\n"
  },
  {"version": "missing", "status": "tool_error"}
]
```

根据这份教学材料，可以形成一条具体检查项：如果目标配置仍使用 `retryLimit`，应核对 1.1 的字段重命名要求，迁移到 `retries` 并重新验证配置。1.0 与 1.2 的空数组表示样本声明没有破坏性变更；不能据此推导真实发布中没有变更。`missing` 则保留了材料缺口，下一步应纠正版本 ID 或补取资料，不能声称全部升级影响已经核对完毕。

这一段在官方 QuickJS worker 中真实运行。它不是 Node.js 程序，`tools`、`searchTools` 与 `text` 来自 Code Mode 注入；将它单独交给 Node 执行不会得到这些接口。完整 runner 会将它作为脚本传给 `codemode` 工具。

检查顺序很关键。网络、参数校验或扩展阻断可能让调用 rejected；MCP 服务返回的 `CallToolResult.isError` 却可能是一个 fulfilled 值。`missing` 就走后一条路径：请求拿到了合法协议结果，结果内容说明工具失败。`Promise.allSettled` 收集完毕，还要读取 `isError`，之后才能把数据当成成功内容。

脚本采用真实服务预先约定的教学结构，所以直接读取 `versions`、`breaking` 和 `evidence`。对未知或不断变化的服务，还要检查结果形状：结构值是否为对象、数组字段是否存在、证据是否非空，再决定接收、补读或人工核对。MCP 结构化结果不必永远是对象，1.2 已修复数组、null 和其他 JSON 值的处理；通用客户端不能先假定 `.items` 或 `.versions` 一定存在。

示例只取证据前 35 个字符，用于显示输出选择发生在哪里，不证明这段截取足以支持真实升级判断。真实任务应按变更条目选取对应原文、稳定版本 ID 与位置；字段完整只解决能否读取，原文是否支持结论还需要内容核对。

错误项也必须成为输出的一部分。如果把 `missing` 静默过滤掉，最终“已经比较全部版本”就可能建立在不完整材料上。脚本外层返回成功，只说明这段检查程序按预期执行，它内部仍明确记录了一项 `tool_error`。

内置 Code Mode 的嵌套调用通过 `ctx.executeTool` 进入共同管道，参数校验、`tool_call`、`tool_result` 与已配置的扩展检查仍会发生。自行集成底层 Code Mode 库时，如果只直接调用 `tool.execute`，则可能跳过 Agent hooks，需要用相应执行桥接接入。下面的实验正好能区分“脚本可调用工具”与“调用经过共同检查”这两个主张。

## 真实集成观察到了哪些变化

可下载[完整实验附件](/assets/examples/pi-mcp-tool-exposure/pi-mcp-codemode.zip)，其中包含固定依赖、mock 服务、上述脚本与 runner，也可单独查看[运行说明](/assets/examples/pi-mcp-tool-exposure/README.md)和[脚本](/assets/examples/pi-mcp-tool-exposure/upgrade.js)。在新目录解压，使用 Node.js 22.19 或更新版本执行：

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run verify
```

runner 为 direct、deferred、codemode 分别创建隔离配置和内存会话，启动真实 stdio 子进程，装配官方 MCP、工具搜索与 Code Mode 扩展，再让预设模型响应驱动对应工具计划。为避开提供方认证，它在绑定扩展后进入底层 `session.agent.prompt()`，并使用 identity `prepareRequest`；因此没有验证真实 `session.prompt()` 认证，也没有测量模型自主规划。

runner 对 Code Mode 的完整四项返回执行精确相等断言，核对版本、变更数组、证据前缀与错误项。direct 和 deferred 的长文本已经经过截断，只断言可见前部保留了预期 version、breaking、evidence 字段和 missing 错误，不把它们宣称为完整 JSON 内容等价。因而这个实验既能核对短结果确实保留了什么，也保留了三路内容比较的实际范围。

结果先看定义的出现位置：direct 在第一轮就声明了两个 MCP 工具；deferred 首轮没有，调用 `tool_search` 后下一轮出现；Code Mode 全程没有将这两个接口作为模型直接工具声明，但脚本能够发现并调用它们。这正是模型声明与脚本可达性分离的可观察结果。

再看共同管道。每个外部工具都有调用前后两个 hook 事件：

| 观察项 | direct | deferred | Code Mode |
|---|---:|---:|---:|
| 实际 MCP 业务调用 | 5 | 5 | 5 |
| `tool_call` / `tool_result` 事件总数 | 10 | 12 | 12 |
| 携带父调用标识的嵌套事件 | 0 | 0 | 10 |
| 预设响应计划的模型请求数，含结束响应 | 3 | 4 | 2 |

五次业务调用分别是一次目录、四次读取。deferred 多出的事件来自 `tool_search`；Code Mode 多出的事件来自外层脚本调用，十个嵌套事件对应五次 MCP 操作，带有 `parentToolCallId`。所以脚本编排减少了中间值经过模型的需要，并没有把外部工具变成绕开 hooks 的直接后门。

最后看输出量。实验在每份文档里人为重复填料，以触发 Pi 模型侧的文本截断。direct、deferred 的模型可见工具结果文本分别为 62155、62325 个字符，Code Mode 为 884 个字符；后者仍输出了发现名称和接口说明。这些是人工长文样本的字符观察，不是 token、真实模型表现或费用基准，3、4、2 轮也来自预设计划，不能推成普遍轮数。

这个差异能支持的结论很具体：deferred 推迟接口定义，未替模型过滤文档；Code Mode 在取到数据后选出了少量字段。三条路径外部调用仍为五次，服务费用和网络等待并没有因输出短而消失。代码写错、选错字段或过滤掉关键例外，还可能让较短输出损害任务质量。

Pi 模型侧 MCP 文本超过 20 KiB 时会截掉中间部分，尝试保存全文并提供回读位置；保存成功后才能依赖全文回读。脚本取得的结构值不经过这层模型侧文本截断，可以先检查和筛选。脚本自己的输出预算、单次工具超时与整体截止时间则是另外几项限制，各自约束不同对象。

## 脚本完成、状态提交与外部效果

一次脚本调用结束后，下一次 Code Mode 会启动新的 VM。需要跨脚本保存少量数据时，可以用同步 `store` 和 `load`；成功脚本的写入保存为会话中的 `codemode-store` 条目，再按当前分支读取。

以下是依据接口设计的故障示意，没有在前面集成实验中执行写操作：

```javascript
await tools.some_write({key: 'upgrade-42'});
store('progress', {done: true});
throw new Error('stop before successful completion');
```

假设工具已经完成外部写入，随后脚本失败：本次 store 写入不会成功提交，但外部动作已经发生。`load('progress')` 下次没有这条进度，不足以证明写操作没发生。把脚本失败后重跑整段程序，仍可能重复外部动作。

这与 Pi Durable 的任务恢复有明确分工。普通会话 store 保存数据，不保存任意 JavaScript 执行位置；Durable 额外保存任务、检查点和可恢复的编排关系。需要跨进程继续执行时，应从外层 harness 的任务身份与重放策略设计起，不能把 Code Mode 当成自动具备事务回滚的业务工作流。

取消同样有多个位置。模型不再等待脚本、工具请求被取消、worker 实际退出、对端动作停止，是相关但不同的事件。1.3 改进了超时、取消和 worker 清理；对某些尚未返回的运行原语，调用结束与实际退出仍可能存在时间差。外部系统已经接受的写入，需要它自己的取消或核对机制。

1.0 到 1.3 的修复也体现了这条链的实际复杂性：1.2 修复认证刷新期间取消后仍迟到发送请求，1.3 修复恢复会话后的活动工具集合。刷新令牌成功，应保存轮换后的凭据；已经取消的业务请求，则不应因此继续执行。凭据更新与业务动作的生命周期需要分别管理。

对 HTTP 服务，1.0 按服务名与 URL 关联凭据，并加强 OAuth 返回服务身份及授权范围处理。它解决“这份凭据属于哪个服务、后续还能申请什么范围”，exposure 解决“模型和脚本经什么入口到达工具”。隐藏接口不会缩小令牌本身的权限，登录成功也不代表任务需要的所有接口都应向模型开放。

如果服务把文档作为资源 URI 返回，固定版还提供资源列表、模板列表与读取工具；它们与工具目录是不同对象。连接不必先枚举整个资源库，避免大量资源挡住工具注册。可读取资源也不意味着客户端能够渲染 MCP Apps 交互界面，这不是当前文档任务所依赖的路径。

## 接入者与服务作者分别需要改变什么

对接入者，选择从任务结构开始。工具少、结果短、需要模型根据每一步新证据作判断时，direct 往往足够。目录大但仍希望模型使用原生接口逐项决策时，deferred 可以推迟无关声明。调用之间已有明确的循环、并发、关联和筛选关系时，Code Mode 才能把这些步骤交给程序执行。

一个只有一次短查询的任务，额外发现与脚本可能增加工作量；一个必须不断阅读新材料再改变目标的调查，也未必适合预先写成长程序。可以让模型先形成局部计划，用短脚本执行确定部分，再把保留的证据与异常交回下一次判断。

对 MCP 服务作者，可组合性需要体现在实际返回值里。清晰的名称和描述帮助发现；输入定义帮助构造调用；输出定义与 `structuredContent` 一致，帮助程序取值；稳定 ID、证据位置和规范 `isError`，帮助在筛选后保留可追溯性。只返回一段“成功了”的自然语言，会把数据提取与错误判断重新推给模型。

QuickJS 限制脚本直接使用 Node、文件与网络 API，但注入工具仍可改变外部世界。服务端只读身份、执行环境隔离与明确的扩展规则，决定实际动作范围；程序沙箱只负责它所约束的那部分路径。

评估时应保留一份同任务账本：完成了哪些查询，哪些版本缺失，证据是否足够，实际调用几次，模型读入多少，是否需要重新执行。只有任务质量与完整性相当时，才有理由比较请求轮数、缓存、耗时和成本。

Pi 1.0 的组合设计提供了一种具体分工：模型提出可检查的程序，harness 持有发现与执行机制，MCP 服务提供结构化能力，外部系统承担实际权限和操作结果。采用这条路径的条件，是能把确定的中间工作写清楚，并让最终输出保留足以支持下一次判断的证据。

## 主要资料

Earendil《You Said No MCP!》与《Pi 1.0》；Pi 1.0.0 Release Notes；官方仓库 earendil-works/pi 的 v1.3.0《MCP Servers》《Codemode》文档、Coding Agent Changelog、Code Mode 包 README 及 SDK 内置扩展示例。

实现定位使用官方仓库 `earendil-works/pi`，固定版本 `v1.3.0`，commit `71023aec1546d6d677a65669c5665c0927ce0dd0`：

| 要核对的机制 | 仓库内相对路径 |
|---|---|
| 配置、连接与暴露方式 | `packages/coding-agent/docs/mcp.md`；`packages/coding-agent/src/extensions/mcp/tools.ts` |
| 搜索后加载模型声明 | `packages/coding-agent/src/extensions/tool-search/tool.ts` |
| 内置 Code Mode 嵌套调用 | `packages/coding-agent/src/extensions/codemode/tool.ts` |
| helper、store 与独立集成 | `packages/codemode/README.md`；`packages/coding-agent/docs/codemode.md` |
| SDK 显式装配内置扩展 | `packages/coding-agent/examples/sdk/14-codemode-mcp.ts` |
