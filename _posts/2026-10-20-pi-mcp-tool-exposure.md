---
layout: post
title: "Pi MCP：工具发现、Codemode 与调用链路"
description: "以文档升级查询解释 Pi 近期 MCP 更新，贯通配置覆盖、连接认证、四种工具暴露方式、Codemode 嵌套调用和结果检查，并区分可见性、授权及任务成本。"
image: /assets/images/posts/pi-mcp-tool-exposure-mechanism.png
image_alt: "服务器工具经 direct、deferred、codemode 或 hidden 分配入口，调用后检查 MCP 内容、结构化结果与错误标记"
date: 2026-10-20 17:03:07 +0800
display_date: 2026-10-16
categories: [AI, Engineering]
tags: [Pi, MCP, Codemode, Tool Search]
---

让 Agent 查询三个版本的发布说明，整理升级影响，通常只需要搜索与读取。文档服务却可能同时提供几十个接口：检索、下载、索引、修改、删除和管理权限。把所有定义交给模型增加了无关材料，全部藏起来又会失去入口。接入 MCP 时，需要分别回答：服务是否已连接，模型能看见哪些定义，以及调用后凭什么相信结果。

Pi 的近期更新把这些问题放进同一条内置路径：服务连接后，工具可以直接声明、按需加载，或由 Codemode 脚本发现和组合。工具怎样到达模型，与外部服务准许做什么各自生效。理解这层分工，才能在工具数量增加时保留可解释的调用链。

这里固定官方 Pi v1.3.0，资料核查截至 2026 年 10 月 20 日。贯穿案例是一个假设文档服务：搜索发布说明，读取三个版本，检查结果，再输出升级变化。配置和工具名用于说明接入方式；结果处理例已离线执行，没有连接真实服务、使用 OAuth 账户或测量模型表现。

## 近期变化集中在连接、发现与结果处理

Pi 从 0.99.0 开始内置 MCP、Codemode 和 `tool_search`。旧资料中“只能通过社区扩展接 MCP”的描述，不能直接用于这些正式版本。内置实现仍属于可替换扩展，社区适配器、第三方界面与上游 CLI 也可能具有不同的配置和默认行为。

| 正式版本 | 与本文路径相关的变化 |
|---|---|
| 0.99.0—0.99.2 | 引入内置路径；将大工具目录与 Codemode 固定声明分开，调整首次提示等待及命名冲突处理 |
| 1.0.0—1.0.1 | 加强 OAuth 服务身份和凭据关联；支持项目轻量覆盖，减少重复填写服务配置 |
| 1.1.0 | 改善 MCP 管理面板和登录的超时、取消与清理 |
| 1.2.0 | 连接时不再枚举所有资源；接受更多 JSON 结构结果；修复刷新认证期间取消的调用仍迟到执行 |
| 1.3.0 | 保持恢复会话后的活动工具集合，改进 Codemode 取消和超时后的 worker 收敛 |

这条演进线围绕具体执行条件：工具什么时候出现，凭据属于哪个服务，取消后是否仍发请求，以及结果究竟是什么类型。以下能力均按固定正式版本解释，未将后续主分支改动算进已发布行为。

## 一份配置如何成为连接

先为案例准备一个已经安装并审查过的文档服务程序。假设它名为 `demo-docs-server`，可以通过标准输入输出使用 MCP，提供 `search_releases`、`get_release` 和若干管理工具。这个程序及工具名是教学设定，并非 Pi 自带服务。

用户级文件 `~/.pi/agent/mcp.json` 可以写成下面的完整 JSON。启动命令应替换成实际审查过的程序入口，固定程序版本由安装方式负责：

```json
{
  "mcpServers": {
    "docs": {
      "command": "demo-docs-server",
      "exposure": "hidden",
      "toolExposure": {
        "search_releases": "deferred",
        "get_release": "codemode"
      }
    }
  }
}
```

它选择先隐藏默认工具集合，再明确开放搜索与读取路径。`command` 让 Pi 启动一个 stdio 进程；HTTP 服务则使用对应 URL 配置。两种传输负责建立通信，不替服务实施文档级权限。实际接入前仍要确认程序能启动、所需环境已提供，或 HTTP 服务能够访问并完成认证。

用户级配置与项目文件 `.pi/mcp.json` 也有不同用途。Pi 先读取用户定义，再在项目获得信任后读取项目配置。同名项目项若包含启动命令、URL 或类型，按完整定义替换；若只希望复用已配置的地址与凭据，可以使用轻量覆盖：

```json
{
  "mcpServers": {
    "docs": {
      "enabled": true,
      "exposure": "hidden",
      "toolExposure": {
        "search_releases": "deferred",
        "get_release": "codemode"
      }
    }
  }
}
```

轻量覆盖只允许 `enabled`、`exposure` 和 `toolExposure`。它保留用户定义的启动参数和认证材料，但 `toolExposure` 整张映射会被替换，不会逐项递归合并。项目只写一条新规则，可能同时移除原来的其他规则；应检查完整有效清单。

项目信任决定这份项目材料能否被加载，未限制服务进程的文件或网络范围。配置可能启动程序，某些值还支持命令求值，因此查看来源时必须追到执行对象。项目不能新建 `auth.provider` 凭据路由，是一项具体限制，也不能据此推导仓库已获得全面隔离。

保存配置后，用 `pi mcp list` 检查服务；在交互会话中用 `/mcp` 查看来源、连接状态与认证需求，修改配置后通过 `/reload` 重新加载。需要登录时，可以执行 `/mcp login docs`，按提示完成授权。服务连接在后台并发建立；首次提示主要等待需要直接声明的工具，默认最多等待 10 秒，间接发现或点名调用再等待相关连接。尚未连好的工具不能仅凭配置名称完成调用。

HTTP 服务需要 OAuth 时，人先完成登录，Pi 再使用与服务器命名空间和 URL 关联的凭据。即将过期或遇到相应认证失败时可刷新，新增授权范围通常需要重新登录。刷新令牌与一次业务请求的取消分别处理：保存轮换后的凭据，不意味着已经取消的请求还应继续执行。

## 四种暴露方式安排工具入口

服务已连接后，工具可以已经注册，却尚未出现在模型当前请求的工具定义里。Pi 用 exposure 安排这段可见性与可达性：

| MCP 暴露方式 | 初始模型声明 | 常见发现和调用方式 | 适合的任务 |
|---|---|---|---|
| `direct` | 按当前活动集合直接声明 | 模型直接调用 | 少量高频接口 |
| `deferred` | 暂不声明完整定义 | `tool_search` 加载后调用，也可由脚本访问 | 大目录中的原生工具调用 |
| `codemode`，默认 | 暂不声明，也不把全部定义塞进脚本入口说明 | 脚本发现并调用，也可由 `tool_search` 加载 | 读取、筛选和组合多项结果 |
| `hidden` | 不声明 | 在此会话加载状态下不可达 | 只开放明确子集 |

`codemode` 和 `deferred` 的能力有重叠，主要差别之一是自动启用哪种发现入口。前者引导脚本编排，后者引导模型先加载定义。Pi 通用工具层还会将 MCP 的 codemode 归入延迟暴露；因此不能仅看一个内部枚举，就断言用户配置的这两种方式完全相同。

暴露规则匹配服务原始工具名。精确名称优先于通配规则，通配规则按配置中的先后顺序采用第一个匹配项。若先写 `get_*: codemode`，再写 `*: hidden`，一个名为 `get_secret` 的接口仍会走第一条。需要关闭它时，应设置精确的 `get_secret: hidden`，或采用更窄的开放清单。

教学配置只开放两个精确名称，便于把期望与实际清单逐项对照。接入真实服务时，先写出任务所需接口及预期路径，再检查最终工具集合。`hidden` 关闭的是当前 Pi 入口，不撤销外部令牌本身的权限，也不影响另一客户端。

![服务器工具经 direct、deferred、codemode 或 hidden 分配入口，调用后检查 MCP 内容、结构化结果与错误标记](/assets/images/posts/pi-mcp-tool-exposure-mechanism.png)

图中发现、调用和结果检查相互衔接。工具定义进入模型之前可以延后，已经允许的调用仍会抵达服务执行；返回模型的材料还可以经过选择。任何一段缩减，都需要知道省略的究竟是什么。

## 从找到工具到脚本组合调用

案例第一步是找到发布说明搜索接口。`tool_search` 是模型可以调用的工具：它搜索尚未声明的候选，并将命中项加入活动集合，下一个模型请求才获得对应定义。这个动作加载接口，没有查询文档；模型之后仍要以正确参数调用搜索工具。

Codemode 则提供另一条路。模型生成 JavaScript，QuickJS 执行脚本，脚本通过工具桥接访问宿主提供的接口。脚本中的 `searchTools()` 查候选，`describeTool()` 查输入输出说明，`describeNamespace()` 补服务级说明；这些辅助操作都是异步的，需要等待结果。

例如，脚本可以执行 `await searchTools("release search", {namespace: "docs", limit: 3})`，获得名称与描述组成的候选列表；再对返回的名称执行 `await describeTool(name)`，取得说明和 TypeScript 声明。确认参数后，才用 `await tools[name](args)` 调用实际接口。这里的 `name` 来自发现结果，`args` 必须按所查定义填写。

当前搜索采用 BM25，根据工具名称、说明、输入定义和命名空间材料排序，默认返回八项。其分词主要处理 ASCII 字母数字。服务元数据使用英文时，加入 `release`、`search` 等相关英文关键词，比假定纯中文查询一定语义匹配更可靠。

找到候选后，应使用返回的实际名称读取定义，再按参数调用。注册名可能经过净化和冲突处理，不宜从服务名与业务工具名手工拼接。确认搜索参数后，先取得版本 ID，再读取三个发布说明；后者若彼此独立，可并行取得，每项结果仍必须检查。

下面是调用过程的示意，`搜索接口` 和 `读取接口` 代表已经发现并检查定义的实际工具，不是可直接执行的方法名：

```text
await searchTools("docs release search")
    → 选候选，await describeTool(实际名称)
    → 依定义调用搜索接口，得到版本 ID
    → 对三个 ID 调用读取接口，收集 allSettled 结果
    → 检查错误、结构与证据
    → 只输出已核对的变化和未完成项
```

内置 Codemode 通过 `ctx.executeTool` 进入共同工具管道。嵌套调用仍经过参数校验、工具前后事件与已配置的扩展检查，脚本并没有天然绕过这些控制。自行使用底层 Codemode 库时，若只直接调用 `tool.execute`，则可能跳过 Agent hooks；需要用相应的 `runToolCall` 接入共同路径。库支持某项检查，与应用已经接好检查是两件事。

读取多份文档适合并行；依赖上一步返回 ID 的操作需要顺序执行。写入、删除或发送动作还要考虑共享状态和副作用。脚本语法允许并发，不会替使用者判断重复或乱序执行的后果。

## fulfilled 之后还要检查工具错误与证据

工具返回到脚本时，MCP 适配器保留 `content`、`structuredContent`、`isError` 等结果内容，移除 `_meta`。当服务明确返回 `isError: true` 时，Promise 仍可能成功解析成这个结构值。`Promise.allSettled` 中的 fulfilled 只说明拿到了返回值。

传输失败、参数无效或扩展阻断等没有可用结构结果的失败，则可能表现为 rejected。正确检查顺序是：先区分 Promise 状态，再读 `isError`，随后验证任务要使用的数据形状及证据。

给案例规定一个教学输出格式：`structuredContent` 必须是含 `items` 数组的对象，每项具有非空 `title` 与 `evidence`。下面是可用 Node.js 独立运行的最小结果检查程序，不调用 Pi 或 MCP：

```javascript
function inspect(result) {
  if (result.isError) return 'tool_error';
  const v = result.structuredContent;
  if (!v || Array.isArray(v) || typeof v !== 'object'
      || !Array.isArray(v.items)) return 'invalid_shape';
  return v.items.every(x => x
    && typeof x.title === 'string' && x.title.trim()
    && typeof x.evidence === 'string' && x.evidence.trim())
      ? 'accepted' : 'needs_review';
}

const calls = [
  async () => ({ structuredContent: {
    items: [{title: '检查项目覆盖', evidence: 'release-1.0.1'}]
  }}),
  async () => ({ isError: true }),
  async () => { throw new Error('连接中断'); },
  async () => ({ structuredContent: {items: [{title: '待核对'}]} }),
  async () => ({ structuredContent: [] })
];
const results = await Promise.allSettled(calls.map(f => f()));
console.log(results.map(r => r.status === 'rejected'
  ? 'request_failed' : inspect(r.value)));
```

将程序保存为 `.mjs` 文件执行，结果依次为 `accepted`、`tool_error`、`request_failed`、`needs_review`、`invalid_shape`。五项里四项 fulfilled，只有一项满足教学规则。离线例验证了这些分支，没有证明远程文档真实或证据确实支持结论；字段通过后仍要核对内容。

v1.2 起已经修复数组、null 与其他 JSON 值的结构结果处理。没有输出定义时，不能假定 `structuredContent` 永远是对象，也不能仅凭 HTTP 成功直接读取 `.items`。上面的形状要求来自本案例，不是 MCP 对所有工具的统一规定。

最终汇总应保留已核对的变化，同时报告授权不足、连接失败和缺证据的条目。若静默删掉失败项，“三个版本已比较”就可能变成只比较了一个。脚本也应避免把整个原始文档重新输出，否则前面的组合并没有减少模型需要读取的材料。

## 大结果与资源走各自的读取路径

模型侧 MCP 文本超过 20 KiB 时，适配器会截去中间部分，尝试保存全文，并返回可回读位置。脚本得到的结构内容不经过这层模型侧文本截断，因此可以先检查完整结果，再选少量材料输出。全文文件只有保存成功后才可回读，不能无条件承诺所有截断内容都能恢复。

Codemode 的显式输出预算又是另一层限制。它约束脚本向模型输出多少，工具请求超时约束某次请求，脚本截止时间约束脚本执行。几项设置作用于不同对象；一次请求的超时不等于整个任务的截止时间。

如果发布说明由资源 URI 提供，正式版本中的 `list_mcp_resources`、`list_mcp_resource_templates` 和 `read_mcp_resource` 可以进入资源链路。需要服务声明相应能力，再按服务器与 URI 读取。连接时不预先遍历整个目录，让大型资源列表不会挡住工具注册。

资源可以是文本、图像或二进制，不能由“存在资源”推断 Pi 会渲染交互应用。这个版本排除 MCP Apps 的界面资源。对升级任务，应先明确需要哪份文档，再取得对应内容，而不是把整个资源库提前放进上下文。

读资源遇到瞬时 HTTP 失败可有一次重试，普通工具调用不套用同样的通用重试，以避免重复副作用。另有会话失效后重建连接再试的特定分支，因此也不能概括为任何工具调用都绝不重试。若读取工具实际隐藏了写入行为，客户端仅凭名称无法证明重试安全。

## 按外部动作与任务成本决定采用方式

QuickJS 限制脚本直接使用 Node、文件和网络 API，但脚本调用的工具仍可能读取文件、运行命令或改变外部系统。Pi 默认使用启动账户的权限，也不默认对每次工具调用询问。服务端凭据、运行环境隔离和具体扩展检查，需要分别配置。

因此，先决定文档任务允许哪些外部动作，再安排发现方式。服务提供只读凭据时优先使用，按任务暴露搜索和读取；需要限制程序实际访问范围时，在执行环境提供相应边界。脚本失败、取消或不再等待某项 Promise，也不会自动撤销对端已完成的操作。

工具少且调用简单，可以直接声明；目录大而仍希望模型逐项原生调用，可以按需加载；需要批量读取、筛选与组合时，可以用 Codemode。它减少的是无关定义和不必返回模型的中间材料，发现步骤也可能增加轮次。

试点应记录实际工具定义量、发现及调用轮数、缓存类别、执行耗时与任务成功。对三个版本的文档查询，成功标准应包含三份材料是否取得、错误是否显式保留、每条变化是否有支持内容。只有这些条件满足后，较短的上下文与较少输出才能进入成本比较。

## 主要资料

Pi 文档《MCP Servers》《Codemode》《Run Pi safely》；Pi Coding Agent《Changelog》；@earendil-works/pi-codemode README。
