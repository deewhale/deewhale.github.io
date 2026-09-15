---
layout: post
title: "Harness 工程设计：长运行 Agent 的交接与验证"
description: "从 Anthropic 三轮公开实践出发，拆解长运行 Agent 的状态分层、跨会话循环、验证契约、故障恢复与最小实现。"
tags: [Agent, 架构, Harness]
---

一次持续数小时的 Coding Agent 任务，模型报错反而容易处理。更麻烦的是第 17 个会话正常结束，第 18 个会话进入同一个仓库，看到几处新文件、一份过时的进度说明和若干通过的单元测试，于是沿着错误的判断继续工作。等到页面终于可以打开，核心按钮仍没有接上后端，Agent 却已经把任务标成完成。

这里同时发生了三种信息丢失：需求被压缩成了含糊的待办，代码的可运行状态没有留下可靠基线，完成结论来自执行者自己的文字。增加上下文窗口只能延缓问题。只要任务跨过进程、容器或模型会话，工程系统就必须回答三个问题：哪些状态要留下，下一次从哪里恢复，由谁证明这一步确实完成。

Harness 就在处理这组问题。模型负责推理和选择动作；工具提供读写、执行与外部服务；Harness 掌管两者之间的循环、状态、权限、恢复和验收。它的质量决定了模型在第一个小时做出的进展，能不能在第五个小时继续产生价值。

## 先把“长运行”拆成几类状态

长任务经常被概括成“给 Agent 加记忆”。这个说法太粗。项目目标、对话历史、代码版本、测试结果和正在运行的数据库都叫状态，但它们的寿命、权威性和恢复办法完全不同。把这些东西塞进同一段上下文，故障时就很难判断该信哪一份。

一个可维护的 Harness 至少要区分下面五层：

| 状态 | 典型载体 | 谁可以修改 | 保存多久 | 恢复时的用途 |
|---|---|---|---|---|
| 任务定义 | `spec.md`、验收规则、非目标 | 人或受约束的 planner | 整个任务 | 防止范围在多轮执行中漂移 |
| 工作账本 | feature list、当前租约、失败原因、下一步 | Harness 与当轮执行者 | 跨会话 | 决定下一轮接什么工作 |
| 交付物状态 | Git commit、数据库迁移、构建产物 | 工具执行环境 | 长期 | 提供可比较、可回退的事实 |
| 事件记录 | prompt、tool call、tool result、状态变化 | Session 服务追加写 | 按审计策略保留 | 重放决策过程，恢复 Harness |
| 临时运行态 | 进程、端口、浏览器页、容器文件缓存 | Sandbox | 单次运行 | 可以丢弃，按配方重建 |

这里有两个容易混淆的边界。

工作账本和聊天摘要承担不同职责。摘要帮助模型快速定向，账本则要能约束调度，例如一个功能只能处于 `pending / running / blocked / passed` 中的某个状态，`passed` 必须附带验证记录。两者可以同时存在，但用途不同。

Git 只能覆盖任务状态的一部分。它适合保存代码和可回退的变更，却不会自动记录某个验收条件为何通过、一次外部 API 调用有没有发生，或者当前会话是否拿着某项工作的执行权。把所有恢复责任都交给 commit message，最终会把 Git 历史写成一份难以查询的事件数据库。

Anthropic 2025 年公开的[长运行 Agent 实验](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)还比较朴素：第一次会话由 initializer 创建 `init.sh`、进度文件、初始提交和结构化 feature list；之后的 coding agent 每轮只做一个功能，开工前读取进度与 Git 历史，收工时留下清晰提交。官方同时发布了[最小示例仓库](https://github.com/anthropics/claude-quickstarts/tree/main/autonomous-coding)，其中每次 coding session 都使用新的上下文，跨会话进度落在 `feature_list.json` 和 Git 中。

这个方案的重要贡献是给每种状态找到了模型之外的落点。它并不等于通用的生产架构：示例面向全栈应用生成，feature list 中固定生成大量测试项，安全控制也只是演示级的目录限制和命令 allowlist。可以借它理解交班协议，不宜把目录结构原样搬进所有任务。

## 一轮执行怎样跨过下一轮

把长任务写成 `while true` 很容易。持续推进需要一个更严格的事务边界。下面这条执行路径综合了 Anthropic 的公开做法，也加入了工程上必要的恢复约束；后者是我的实现建议，并非 Anthropic 对外公布的内部协议。

```text
读取 durable state
       │
       ▼
重建 sandbox ──► 基线检查失败 ──► 修复或回退，停止领取新任务
       │
       ▼
领取一个工作单元（带 lease）
       │
       ▼
冻结本轮 validation contract
       │
       ▼
修改环境 ──► 记录 tool events ──► 生成候选 commit
       │
       ▼
外部验证 ──► failed/blocked ──► 写入证据，释放或续租
       │ passed
       ▼
提交 checkpoint + 更新账本 + 发出下一轮唤醒事件
```

恢复从“定向”开始。Harness 读取任务定义、最近事件、工作账本和仓库 HEAD，按固定配方创建 sandbox，然后运行一条足够快的基线检查。对于 Web 应用，这可能是启动服务、完成登录、创建一条记录并重新读取；对于编译器，可能是一组短小的回归样例。基线失败时，本轮的首要任务是恢复已知可用状态，不能在损坏的基础上领取新功能。

接着只领取一个有边界的工作单元。以下是生产化建议：为工作单元增加租约，不要简单地把 `pending` 改成 `running`。会话崩溃后，永久的 `running` 会成为僵尸状态；带过期时间和 owner 的 lease 允许 Harness 判断原执行者是否还活着，并在超时后安全重派。单 Agent 串行执行也值得保留这个字段，因为它让崩溃恢复逻辑保持明确。

实现开始前冻结一份 validation contract。它至少应包含输入、预期环境变化、禁止出现的回归、验证命令和证据位置。合同不能由实现者在提交之后单方面放宽。Anthropic 2026 年 3 月的[三角色 Harness 实验](https://www.anthropic.com/engineering/harness-design-long-running-apps)让 generator 与 evaluator 在每个 sprint 开始前协商合同，随后 evaluator 用 Playwright 操作运行中的应用，并检查 UI、API 和数据库状态；任一评分项低于阈值，sprint 就失败。

最后才是提交。一次成功交班需要同时写入代码 checkpoint、账本状态和验证证据。三者应引用同一个 `run_id` 或 commit SHA，避免出现“进度文件说通过，仓库却已被后续失败尝试覆盖”的分叉。更新顺序也要有约束：先保存候选产物和验证结果，再原子地推进账本；唤醒下一轮放在最后。做不到跨存储事务时，可以采用幂等事件和 reconciliation job，扫描“已有通过证据但账本未推进”或“账本通过但证据缺失”的记录。

## 两套角色设计，解决的是不同阶段的问题

Anthropic 的公开实践在半年内出现了明显演进。把这些版本并排看，比记住某个角色名称更有用。

2025 年 11 月的 initializer / coding agent 方案，先解决任务无法顺利换班。initializer 把一个高层需求展开成可逐项验收的列表，并把所有项目初始化为失败；coding agent 每轮选择一个未完成项，实现、测试、提交、交接。官方说明中所谓两个 agent，主要区别其实是首轮与后续轮使用不同 prompt，system prompt、工具和总体 Harness 相同。

到 2026 年 3 月，研究重点转向规格不足和自我验收偏松。planner 把一到四句话扩展成产品规格，但刻意不锁死底层实现，以免错误设计沿流水线放大；generator 分阶段实现；evaluator 在系统外沿用户路径验收。文件成了三个角色之间的通信协议。

这套结构随后又被削减。换用 Opus 4.6 后，研究者测试并移除了 sprint 分解，不再逐个 sprint 验收，改成每次完整 build 后做一次 QA；未通过时，再进入下一轮 build / QA。planner 被保留下来。官方给出的理由很具体：没有 planner 时，generator 会缩小需求范围；对于模型已经能稳定完成的部分，evaluator 只是额外开销；在能力边缘，独立 QA 仍能抓到展示型占位功能和缺失的核心交互。

因此，initializer 和 planner 不应被当作两个时代的同义词。initializer 建立可恢复的项目环境，planner 补全产品范围。小而明确的迁移任务可能只需要 initializer；一条模糊的产品需求即使能在单个上下文里写完，也可能需要 planner。evaluator 的必要性同样取决于任务是否接近当前模型的可靠性边界，以及失败代价是否值得支付独立验收成本。

## Session、Harness、Sandbox 各自负责什么

文件交班能支撑一台机器上的实验，托管系统还要处理进程崩溃、容器失联、凭证隔离和弹性扩缩容。Anthropic 在 2026 年 4 月公开的 [Managed Agents 架构](https://www.anthropic.com/engineering/managed-agents)把三个概念分开：

- Session 是追加式事件日志，保留输入、输出、工具调用和中间事件。它在 Harness 进程之外持久化。
- Harness 是“脑”的循环：装配上下文、调用模型、路由工具、消费和写入 session events。它可以是无状态进程。
- Sandbox 是“手”的执行环境。代码、shell 和浏览器运行在这里，必要时按标准配方重新创建。

拆开以后，故障语义才清楚。Sandbox 挂掉，Harness 收到一次工具错误，重建环境并从持久化工件恢复；Harness 挂掉，新实例读取 session log，从最后一个已确认事件继续；上下文被压缩或清空，原始 session events 仍然可查询。官方展示的接口包括 `execute(name, input)`、`provision({resources})`、`wake(sessionId)`、`getSession(id)` 和 `emitEvent(id, event)`，这些是架构形状的说明，并不意味着自建系统需要照抄名称。

这个分离还形成安全边界。生成代码所在的 sandbox 不应拿到长期凭证。Managed Agents 的公开方案把 OAuth token 放在外部 vault，通过代理完成 MCP 调用；Git 凭证在初始化时与资源绑定，Agent 可以 push/pull，却不直接读取 token。把 Harness 和 sandbox 放在同一个容器虽然省去了网络接口，prompt injection 一旦诱导模型读取环境变量，影响范围也会更大。

Session 与模型当前看到的 context window 是两层东西。session 可以保留完整的追加日志；Harness 只选择其中一部分，经过裁剪、压缩或重组后送给模型。这让“可恢复的历史”与“本轮最有用的上下文”各自演进。前者追求完整和可审计，后者追求相关性、延迟与 token 成本。

## Context reset 和 compaction 没有固定赢家

Compaction 会把较早消息压缩成摘要，保留同一会话的连续感；reset 则结束当前上下文，用结构化交接开启干净会话。二者都在丢信息，只是丢失方式不同。

| 策略 | 优点 | 主要风险 | 适合观察的信号 |
|---|---|---|---|
| Compaction | 少一次冷启动，保留近期推理连续性 | 摘要遗漏后续才显重要的细节；旧指令仍可能污染判断 | 压缩后返工率、检索旧事实的失败率 |
| Context reset | 清掉累积噪声和错误锚点，角色边界清晰 | 依赖交接工件完整；增加 token、延迟和编排复杂度 | 新会话定向耗时、重复调查比例 |
| 按需检索 session | 原始事件可恢复，当前上下文保持轻量 | 检索策略本身会漏召回，基础设施更复杂 | 关键事件召回率、恢复成功率 |

选择取决于模型的实际行为。Anthropic 披露，Sonnet 4.5 在长任务接近上下文上限时会提前收尾，compaction 不足以化解，因而需要 reset；Opus 4.5 上同一行为减弱，研究者删除了 reset，让自动 compaction 支撑连续会话。换用 Opus 4.6 后，研究者又测试并移除了 sprint 结构。Harness 中相当一部分代码，其实是在补偿某一代模型的行为。

所以，上线前要做模型 × 任务的消融测试。固定一组长任务，分别关闭 reset、独立 evaluator、强制分块等机制，记录成功率、返工次数、墙钟时间和 token 成本。模型升级时重跑。没有这一步，旧脚手架会悄悄变成延迟和费用来源。

## 验证合同要挡住“看起来完成了”

Agent 的 final message 只能算 transcript 的一部分。Anthropic 在[Agent 评测方法](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)里把 outcome 定义为 trial 结束时环境的最终状态：订票 Agent 说“已预订”不算数，数据库里存在正确订单才算。这个区分应直接进入 Harness 的状态机。

验证可以分三层。第一层是确定性检查：编译、单测、静态分析、数据库断言、文件哈希。第二层是执行路径：浏览器或 API 客户端从外部完成用户动作，检查多个组件是否接通。第三层才是模型评分，用 rubric 评价可维护性、交互质量或研究完整性等开放问题。能用代码判断的条件，不要交给 LLM 投票。

独立 evaluator 也会放水。Anthropic 的实验记录了一个很有价值的失败：早期 QA 能发现真实问题，随后又说服自己问题不严重并批准交付；研究者通过阅读日志、收集判断分歧、反复修改 QA prompt 才改善评分，而且深层功能仍有漏测。这说明 evaluator 需要版本化的 rubric、少量人工校准样例和持续回归，不能因为它换了一个上下文就假定它客观。

在更大规模的实验中，验证器甚至决定系统会朝哪里优化。Anthropic 的[C 编译器 Agent 团队实验](https://www.anthropic.com/engineering/building-c-compiler)使用 16 个并行实例，累计接近 2,000 个会话、约 2 万美元 API 成本；研究者强调测试 Harness 要足够准确，否则 Agent 会稳定地解决错误问题。项目后期频繁回归后，他们加入 CI 和更严格的测试门槛。这个案例支持的是“验证质量决定长任务上限”，不证明多 Agent 对任何任务都划算。

故障恢复也应该由合同驱动，不能统一重试：

| 故障 | 保留什么 | 恢复动作 | 禁止的动作 |
|---|---|---|---|
| 模型调用超时 | 已确认事件、当前 lease | 同 session 重试，超过次数后释放 lease | 重复执行未标记幂等的外部写操作 |
| Harness 崩溃 | 外部 session log、账本 | 新实例从最后确认事件唤醒 | 根据内存中的“印象”补写成功状态 |
| Sandbox 损坏 | Git checkpoint、初始化配方、外部数据快照 | 丢弃容器，重建并跑基线 | 在不可解释的脏环境继续实现 |
| 验证失败 | 候选 commit、失败证据、日志索引 | 保持任务未通过，生成有边界的修复轮次 | 修改验收规则来配合现有结果 |
| 外部副作用结果未知 | 幂等键、请求记录、目标系统状态 | 先查询结果，再决定补偿或重试 | 直接重复付款、发信或发布 |

最后一行常被 Coding Agent 示例掩盖。Git 操作容易回退，付款、删库、发邮件没有天然回滚。长运行 Harness 一旦能接触真实业务系统，就需要幂等键、审批点、补偿操作和权限上限；“从 checkpoint 重跑”只适用于副作用边界已经设计好的任务。

## 一个能落地的最小版本

如果团队正在自建 Harness，更稳妥的起点是单 Agent 串行版本。下面是基于上述公开材料推导的最小设计，用来说明职责，不代表 Anthropic 产品内部实现。

```text
.agent/
  spec.md                 # 目标、边界、不可变验收要求
  work-items.jsonl        # 工作单元与状态变化，追加写
  runs/<run_id>.json      # 模型、输入版本、成本、起止时间
  evidence/<run_id>/      # 测试输出、截图、状态断言
  handoff.md              # 给下一轮的短摘要，可重新生成
scripts/
  bootstrap               # 幂等地创建运行环境
  smoke                   # 数分钟内完成的基线检查
  verify <work_item_id>   # 按合同验收单项
```

调度器只需要维护一个清楚的循环：

```python
while budget.available() and not ledger.all_passed():
    sandbox = provision(recipe_version)
    restore_repo(sandbox, ledger.last_good_commit)
    require(smoke(sandbox).passed)

    item = ledger.acquire(owner=run_id, ttl="30m")
    contract = freeze_contract(item)
    result = run_model(item, contract, session_slice())
    candidate = checkpoint(result.files)
    evidence = verify(candidate, contract, fresh_sandbox=True)

    if evidence.passed:
        ledger.commit_pass(item, candidate, evidence)
    else:
        ledger.record_failure(item, candidate, evidence)
```

生产化时再补四件事：外部写操作的幂等与审批；session event 的持久存储；租约与 reconciliation；按 run、模型、任务类型统计成本和失败原因。只有当日志显示规格经常不足、自我验收持续漏错，或工作单元确实能并行，才分别引入 planner、evaluator 或多 Agent 调度。

停止条件也要由 Harness 掌握。`all_passed` 只是正常出口，还应包括预算耗尽、同一失败连续出现、外部依赖不可用、连续多轮没有产生可验收进展，以及触发人工审批。模型可以提出“我需要继续”或“这里已经完成”，调度器根据账本和配额作最终决定。否则，无限循环会把错误方向稳定地放大。

观测面不要只收集 token 数。每个 run 至少关联模型与 prompt 版本、读取的状态版本、领取的 work item、工具错误分类、候选 commit、验证结果、墙钟时间和费用。这样才能回答一次失败究竟来自模型能力、交接缺失、环境抖动，还是验证器误判。长任务最昂贵的情况往往不是直接失败，而是十轮之后才发现前九轮建立在错误前提上；状态版本和验证证据能把追责点往前推。

这一套设施有明确的经济边界。Anthropic 的复古游戏生成实验中，完整 Harness 运行约 6 小时、花费 200 美元，单 Agent 对照约 20 分钟、9 美元；后续 DAW 实验仍耗时约 3 小时 50 分钟、token 成本 124.70 美元。这些是少量公开实验的记录，不能外推成通用倍率，却足以提醒团队：每次规划、冷启动、端到端浏览和返工都在收费。

十分钟能完成、结果容易人工检查的任务，不值得搭建完整控制面。需求会持续变化、交付物能被机器验证、失败后需要恢复、单次运行成本又足够高时，Harness 的投入才会回本。高风险外部操作还要再加一道条件：验证和补偿必须先于自治时长。

模型会继续变。某一代模型需要的 reset，下一代可能嫌它累赘；今天有价值的 evaluator，明天可能只在极难任务上出现收益。可以长期保留的东西更少，也更基础：耐久的任务状态、可重建的执行环境、清楚的副作用边界，以及不接受口头完工的验证合同。长运行能力就建立在这几条纪律上。

## 参考资料

- [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)，Anthropic Engineering，2025-11-26
- [Harness design for long-running application development](https://www.anthropic.com/engineering/harness-design-long-running-apps)，Anthropic Engineering，2026-03-24
- [Scaling Managed Agents: Decoupling the brain from the hands](https://www.anthropic.com/engineering/managed-agents)，Anthropic Engineering，2026-04-08
- [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)，Anthropic Engineering，2026-01-09
- [Building a C compiler with a team of parallel Claudes](https://www.anthropic.com/engineering/building-c-compiler)，Anthropic Engineering，2026-02-05
- [Autonomous Coding Agent Demo](https://github.com/anthropics/claude-quickstarts/tree/main/autonomous-coding)，Anthropic 官方示例仓库
