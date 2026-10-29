---
layout: post
title: "DeepInfer 的推理引擎设计：专家并行、动态验证与有限重放"
description: "从推理引擎的请求、计算和缓存职责进入，深入分析 DeepInfer 的专家布局、DSpark 预算、异步状态与有限重放，并与 vLLM、SGLang 的对应实现比较。"
image: "/assets/images/posts/deepinfer-inference-design-mechanism.png"
image_alt: "DeepInfer DSpark 稳态解码的三次决策：CPU 使用历史置信信息确定总预算，GPU 用较新信息分配验证长度，目标模型与采样器决定真实接受，并通过修正序列及 KV 长度补齐异步状态"
date: 2026-10-22 10:47:23 +0800
display_date: 2026-10-22
tags: [DeepInfer, LLM Inference, MoE, Speculative Decoding, vLLM, SGLang]
last_modified_at: 2026-10-29 16:32:49 +0800
---

DeepInfer 是 DeepSeek 开源的大模型推理引擎。应用把输入文本和生成参数交给它，它负责载入权重、管理请求与缓存，在多个计算设备上安排模型执行，再把生成结果交回应用。当前公开版本面向 DeepSeek-V4.1-Flash，提供离线 API 和核心执行能力；在线协议、阶段拆分与跨副本路由还需要服务层接入。

理解推理引擎，可以先看它同时处理的三种工作。第一是把权重放到能够容纳它们的设备上，并让多个设备分担模型计算。第二是在不断进入和结束的请求之间安排每一轮计算，让设备保持有效批量。第三是保存上下文和采样状态，让下一轮继续得到正确结果。模型权重给出计算规则，引擎决定这些规则怎样在真实设备和请求负载中运行。

专家并行把不同请求选中的专家计算汇聚起来，增加一次执行的批量；DSpark 根据草稿接受机会和设备耗时，选择本轮验证多少位置。异步调度让 CPU 准备下一轮的工作与设备计算重叠，有限重放则减少特定模型建立局部状态时需要重算的范围。

这些机制会相互影响。专家批量改变一次验证的成本，DSpark 选出的验证长度又改变请求一轮能推进多远。CPU 提前调度以后，上一轮接受结果可能尚未返回，需要修正新一轮的序列与 KV 长度；草稿被拒绝时还可能回退，所以有限重放保留的缓存后缀也必须容纳回退范围。

vLLM、SGLang 也在吸收这些优化。比较引擎时，需要追到目标模型实际使用的执行路径，再判断服务层还需接入什么；功能名录无法独自支持迁移决定。


## 一条生成请求怎样进入这些优化

官方 `examples/offline_inference.py` 是理解执行链的起点。它实际包含文本、图像回归输入，生成后统计困惑度和草稿接受率，并可追加结构化输出检查。沿它调用的 `LLM.generate` 向内追踪，输入先是 prompt 或 token ID 数组，外加采样参数；进入引擎后，输入才成为可以等待、执行和结束的 `Sequence`。

`LLM._add_request` 为请求分配 ID、编码字符串并复制采样参数，随后交给 `LLMEngine.add_request` 检查空输入、token 范围和多模态信息。若请求要求结构化输出，还要先异步编译 grammar matcher，编译完成才能进入待调度队列。收到输入与开始设备计算，是两个时点。

常见执行主线可以压缩成：

```text
prompt / token IDs + SamplingParams
    → Sequence 与必要的 grammar matcher
    → waiting：等待首次 prefill 和缓存资源
    → Scheduler 选择 prefill 或 decode 工作、分配缓存与 query 数量
    → Worker / ModelRunner 执行本轮模型计算
    → Sampler 验证草稿、采样并判断结束
    → 更新 Sequence、缓存与请求输出
    → 未结束的请求继续参与后续 step 调度
```

引擎在请求存续期间，围绕对应的 `Sequence` 保存输入位置、已生成 token、草稿、采样状态及相应 KV 缓存。一次 `step` 从多个请求中选择本轮要执行的工作；实际调度还包含抢占、忽略和资源回收，因此请求可能退出当前执行集合，稍后再继续。采用投机解码后，一轮可以推进多个 token，step 数与实际输出 token 数不再相等。

其中 prefill 处理输入序列，建立生成所需状态；decode 基于这些状态继续生成。前者有较长输入带来的计算批量，后者同时受并发、每请求验证长度和缓存访问影响。因此，prefill 与 decode 使用相同模型，并不意味着应使用相同的并行规模和调度策略。

还要先确定引擎的边界。该版本公开提供离线 LLM API、内部调度、设备 KV 管理、模型执行和采样。完整在线服务所需的分布式 KV 系统、视觉编码／prefill／decode 拆分部署，以及副本间的负载均衡，仍有组件未包含在本次交付中。引擎内部选择“本轮跑哪些序列”，与服务外层选择“请求送往哪台实例”，分别承担两层决策。

配套 DeepSeek Recipe 处理协议、会话与 token 序列之间的转换，HTTP 传输、推理和工具执行仍由调用方提供。官方离线入口直接使用 tokenizer，不能把两套仓库合并想象成已经接好的 API 服务。

DeepInfer README 也明确说明，其最初主要基于 vLLM，并受 SGLang、TensorRT-LLM 启发。研究它的重点是具体模型路径怎样组织计算与状态，而非把成熟推理系统里已有的概念重新命名。

对每轮已经选出的请求，专家层能汇聚多大批量，会影响验证的成本；要验证多少草稿，又会改变下一轮请求推进的位置。计算布局、工作量与跨轮状态因此需要一起考虑。


## Wide EP：让专家计算形成批量，再处理最慢的 rank

MoE 层为 token 选择部分专家执行。Attention 需要沿各自请求访问上下文，专家计算则可以把来自不同请求、但选择了相同专家的 token 汇在一起。DeepInfer 利用这一层间差异组合 Attention 数据并行与专家并行。

Attention DP 中，不同 rank，也就是参与并行执行的进程，负责不同请求和相应的注意力状态。到 MoE 层，router 决定 token 要访问哪些专家；dispatch 把 token 送往拥有这些专家权重的 rank，专家执行后再 combine 回原来的请求位置。跨卡移动的是该层所需的 token 数据，专家权重按布局驻留在设备上。

因此，DP 与 EP 描述的是不同层的分工。扩大 EP 不等于把整个模型复制更多份。对 decode 而言，单个请求每轮提供的 token 少，把多卡请求在专家层汇聚，有机会让专家一次处理更多 token，改善矩阵乘法效率，并降低单位输出承担的专家权重访存成本。代价是 dispatch／combine 通信和更大的协同执行范围。

官方生产设计对两个阶段给出了不同配置：prefill 使用 EP2–8／DP2–8，优先选显存能容纳的较小规模；decode 使用 EP64–128／DP64–128，在超节点内扩大专家批量。这些是该模型及其部署拓扑的选择。慢速网络上的跨节点通信、较低并发或不同专家分布，都可能改变收益。源码还支持 balanced CP，即把同一请求的上下文分给多个 rank；官方该期生产配置暂不使用 CP，不能把支持能力和生产选择混成一个默认值。

### 专家数量相等，工作量仍可能不等

专家由 router 选择，其访问量随输入变化。把相同数量的专家均匀放在卡上，只保证权重数量接近；某个 rank 上的专家持续更热，这个 rank 仍可能成为整组完成当前 MoE 层的瓶颈。Wide EP 提高了汇聚批量，也提高了处理这种失衡的重要性。

EPLB，即专家并行负载均衡，处理的是专家的副本与放置。这里有两个对象：logical expert 是模型定义的专家；physical expert 是落在设备槽位中的一份专家权重。同一 logical expert 可以有多个 physical 副本，由此分担访问。增加副本消耗显存，但不会增加模型学到的专家种类。

DeepInfer 的真实处理链比“定期把热门专家复制一下”更完整：

1. 每层记录各物理槽位本轮接收的 token 数，写入历史窗口。
2. 重排时，先依照当前 physical→logical 映射合并副本统计，再在 EP 组内聚合，恢复每个逻辑专家的历史负载。
3. 策略决定哪些专家值得增加副本、各副本放在哪个 rank。
4. 执行本地复制与跨卡权重搬移，完成后才发布新的专家映射。

第二步容易被忽略。一个逻辑专家已经被复制到几张卡以后，某个物理槽位的计数只代表其分担的部分；直接按槽位热度决定下一次复制，会丢掉同一专家的整体需求。`model_executor/eplb` 先把统计还原到逻辑专家，再决定新的物理布局。

### 放置策略保留了历史的时间分布

`rebalance_experts_global` 的输入是跨多个 step、多个 MoE 层的逻辑专家 token 统计，以及物理专家总数和每个 rank 的槽位容量。它先保证每个逻辑专家至少一份，再逐份分配冗余副本。候选收益与历史各 step 的最高每副本负载相关，因此决策不只取决于整个窗口的平均热度。

副本数确定后，`_batch_greedy_indices` 再把它们放入有限槽位。放置一个副本时，策略会考察把它放入不同 rank 后，各历史 step 的最大 rank 负载怎样变化，按这一目标选择位置。保留时间维度的意义在于：历史总量相近的两个专家，可能总在同一轮变热，也可能错峰；把它们放在同一张卡上的结果不同。

这是一个带容量约束的确定性贪心方案。它依据已观察到的分布改善下一阶段布局，未来输入分布改变以后仍要重新统计。更频繁重排能更快响应，也会增加统计、同步和权重移动成本。

新布局确定后，`shuffle.py` 还要据此搬动权重：检查哪些旧槽位可以直接复用，哪些需要卡内复制，哪些需要远端权重；原位更新还要防止源权重先被覆盖。权重搬完再更新 physical→logical、logical→physical 和副本计数，后续执行才能按新布局访问正确权重。把新映射算出来和让执行真正使用它，中间有明确的数据移动与一致性要求。

官方 `tests/models/test_eplb_policy.py` 检查映射自洽、确定性、全零与尖峰负载、多副本等情况。这类测试回答策略输出是否合法。真实收益还要观察每步最慢 rank 的负载、权重搬移成本和最终延迟；映射合法并不能替代吞吐测量。

大 EP 域还有运维代价。官方生产 Q&A 将整个实例视为一个通信域，一张卡故障可能使实例失效，依靠容量冗余、请求改路由和健康设备重组保持服务。专家计算更有效与实例故障范围扩大，是同一拓扑选择的两个结果。

### vLLM、SGLang 在同一层也有专家均衡

vLLM 的《Expert Parallel Deployment》把 EP 组描述为 TP×DP；TP 为 1 时，Attention 在各 DP rank 处理不同请求，专家分布在 EP 组内。其 EPLB 同样有窗口统计、冗余专家与周期重排，并提供异步负载均衡。额外专家副本占用权重显存，与可用于 KV 的容量共同竞争。

SGLang 集成的 EPLB 也依据专家激活统计放置或复制专家。`EPLBManager` 形成新的位置元数据后，按层分批更新权重与位置，并根据触发条件决定是否重排。三家都要处理热点专家，比较时需要继续看统计、重排与权重移动怎样进入实际执行。

SGLang 的 TBO／SBO 还会把不同 micro-batch 的计算与 dispatch／combine 穿插，或用通信前后 hook 隐藏共享专家计算。这是在设备内重叠通信与计算；后文 DeepInfer 的异步调度则主要重叠 CPU 控制与设备执行。二者优化不同等待，可以同时存在，不能只凭“异步”两个字比较高低。

这里真正需要选的是：在具体模型、设备与通信 backend 的组合中，专家有效批量、负载失衡、通信和权重重排各占多大成本。DeepInfer 当前发布联调了 V4.1-Flash、SM100／Ascend 950 和相应模型路径；vLLM、SGLang 提供多种模型与 backend 组合。这种交付差异能够影响集成工作量，性能结论仍需在相同组合中测量。


## DSpark：把验证预算分给更可能产出有效 token 的前缀

Wide EP 改善既定工作量的执行效率，DSpark 则改变本轮选择的工作量。投机解码先生成草稿，再交给目标模型验证；若连续前缀被接受，一轮目标模型执行可以得到多个输出 token。

必须分清三种长度：草稿模型生成了多少 token，目标模型选了多少位置验证，最终有多少草稿真正被接受。前两者决定计算工作，第三者才影响本轮实际推进。把草稿生成得更长，或者把更多位置送入验证，都无法自动保证更多有效输出。

DeepInfer 生产设计每次生成 5 个草稿 token，并由 confidence head 预测接受机会。靠后的草稿只有在前面的草稿连续接受后才有贡献，因而调度器关注的是前缀收益。对应源码把逐位置 confidence 累乘，形成各前缀能够到达的预测概率。`scheduler.hpp::process_MTPInfo` 明确完成了这次状态转换，原始 confidence 和累计后的 `accept_rates` 分开保存。

### 预算要同时考虑预测收益与硬件耗时

若只看置信度，可以设置一个阈值，超过阈值就验证；若只看草稿长度，可以一律验证满 5 个。两种方案都没有回答多验证一个位置要付出多少设备时间。

`MTPVarlen.schedule` 接收当前序列的草稿与接受率历史，用这些信息估计验证草稿的收益，再用硬件性能曲线估计这批工作需要多久。曲线记录不同 `graph_size` 对应的 forward 耗时，每个 graph size 能容纳一定数量的 query。增加验证位置可能使总 query 数越过当前图的容量，转而使用更大的图，因此耗时不会随着验证长度连续、匀速地增加。

query 是本轮送入目标模型的计算位置。若选择验证 K 个草稿，请求会送入“上轮最后已提交的 token + K 个草稿 token”，共 `1+K` 个位置。模型在每个位置预测下一个 token：前 K 行 logits 依次检验这 K 个草稿；若草稿全部通过，最后一行再用于采样一个新 token。若某个草稿被拒绝，就在首个拒绝行取得最终采样 token，后续各行不再贡献输出。输入中多出的那个基础位置由此提供了一次目标采样机会，而不是直接算作一个新输出 token。

固定源码中的 `get_accept_result` 和 `finalize_verification` 将验证结果整理为“连续接受的草稿前缀 + 一个最终采样 token”，随后再处理结束条件与输出。调度预算把这次最终采样机会计为每请求的基础贡献 `1`；它来自哪一行 logits，取决于草稿在何处被拒绝，或是否全部通过。忽略结束截断时，验证 K 个草稿最多推进 `K+1` 个 token，所以默认 5 个草稿在满接受口径下按 6 个 token 记账。

算法先为每个请求保留一次基础计算所需的预算，再按候选前缀的预测收益逐个增加验证位置。对每个候选总工作量，选择能容纳它的图，估计：

```text
候选有效吞吐 = 预计得到的 token 数 / 预计本轮耗时

预计本轮耗时 = 图的基线 forward 时间
             + 上下文长度影响的运行时修正
             + sampler 时间
```

这里预计 token 数的起点是请求数量，即每请求的基础贡献 1，再加上所选草稿前缀的预测接受收益。随后保留预计吞吐最高的总 query 数。多加一个验证位置后，预测输出可能只增加一点，却触发更大图；这种候选就可能不如少验一些。相反，在原有图的高效区间内增加高收益草稿，可能用较少额外时间换来更多输出。

这条成本曲线有真实的取得路径。启用 CUDA graph 和变长验证时，Worker 在预热、捕获图以后调用 `profile_decode_perf`，优先读取匹配的缓存；没有缓存则对各 graph 做 replay，以设备事件测时并在 EP 组归约，交给调度器使用。它不是仅写在配置中的一条理论曲线。

时间模型也会继续更新。forward 的修正来自最近运行记录，按 graph size 聚合中位数，再用于估计额外成本；sampler 优先使用相同请求数的历史，样本不足则回退到全局估计。DSpark 因而同时读取模型的置信信号与设备的时间信号。得到的是基于估计的调度选择，能否成为真实吞吐收益，还取决于预测质量与负载。

冷启动同样有定义。没有硬件曲线时，代码回退为验证已有全部草稿；缺少历史接受率时，使用初始化填充值。这些分支让流程能启动，也意味着不能把稳态历史优化描述为第一轮已经掌握的真实信息。

### 官方结果显示最优点随并发移动

官方部署 Q&A 给出的 EP64／DP64 结果，比较固定验证 5 个草稿与动态验证。下表选取其三个真实运行点；吞吐是官方根据 benchmark 数据计算的估算值，单位为 tok/s/rank。

| 并发序列/rank | 固定／动态平均验证长度 | 固定／动态平均接受长度 | 固定估算吞吐 | 动态估算吞吐 | 变化 |
|---:|---:|---:|---:|---:|---:|
| 16 | 5 / 4.44 | 3.32 / 3.24 | 4,891 | 4,816 | −1.5% |
| 60 | 5 / 3.58 | 3.30 / 3.21 | 13,730 | 14,466 | +5.4% |
| 96 | 5 / 3.24 | 3.30 / 3.15 | 16,817 | 18,660 | +11.0% |

动态验证没有把平均接受长度提高。它减少了验证工作，并在部分并发区间内，让每秒执行轮数的增加补偿了每轮接受长度的少量下降。16 并发的负收益则说明：当设备工作点变化，少验一些的位置并不必然带来足够的时间收益。官方“生产工作点附近约 4–7%”的结论，应保留约 60 序列/rank 的条件。

这组数据只比较同一系统的两种验证策略。它没有测量 DeepInfer 相对 vLLM 或 SGLang 的速度，也不足以推出所有请求分布下的统一增益。

### 三家的动态验证，差别落在预算与成本模型

“根据负载调整草稿数”至少包含两种不同操作。其一是 batch 大小时统一改变 K，即这批请求都生成或验证相同数量的草稿；其二是在总工作量内，按每个请求的前缀收益分配不同验证长度。前者反映负载，后者还利用请求之间的接受机会差异。

vLLM 当前开发主线同时提供这两类路径。《Dynamic Speculative Decoding》描述操作者预先提供 batch size→K 的区间表；《Adaptive Verification》则让各请求的存活概率参与同一预算竞争，启动时捕获 CUDA graph，并 profile 不同形状的 step 成本，按期望接受 token／秒选工作量。DSpark 可使用训练好的 confidence head；其他受支持的 model-based drafter 可由在线估计器读取 draft logits，并用实际验证结果校准。

vLLM 的 Adaptive Verification 在该快照中默认关闭，要求 full CUDA graph 和支持设备决定 query 长度的 attention backend，并有 LoRA、流水线并行等组合限制。部署版本包含算法以后，还需满足这些条件才能走到该路径；收益则要在目标组合中测量。

SGLang 也要区分 EAGLE 的自适应 tier 与新的 DSpark 路径。前者按 batch 档跟踪真实接受长度的移动平均，调整整批的 draft steps；`DSparkWorkerV2` 接入的 `DSparkVerifyPlanner` 才会用 confidence 的前缀乘积，规划各请求不同长度的验证。

SGLang 这个版本的实际成本来源是 `--speculative-dspark-sps-table-path` 提供的 steps/sec 表。没有给表时，代码构造平坦成本表并警告规划会退化为 verify-all。即使已经有 confidence head、planner 和 ragged verify，缺失设备成本仍可能让动态预算失去作用。相比之下，vLLM 在启动时 profile 成本；DeepInfer 通过启动预热阶段的 profile／缓存取得曲线，再加运行时反馈修正。三者的共同问题是把“多验一些会多产出多少”与“多花多少时间”接起来，不能用是否出现 DSpark 名称代替比较。

这里比较的是 vLLM `fc9b7e6` 与 SGLang `780a5b1` 两个开发快照。采用时先查部署版本是否包含相同路径，再检查 backend 与配置组合是否使它生效；主线已有实现与稳定版默认启用是两项不同事实。


## 异步执行要求把预算、分配与接受拆成三次决策

如果 CPU 每轮都等待设备采样结束，读回接受结果，再处理状态、选择下一轮 batch，设备就会在 CPU 后处理与调度期间出现空档。DeepInfer 默认启用异步调度，让 CPU 先准备下一轮，把这段工作与设备计算重叠。这条机制在项目中称为 ZOS，展开为 zero-overhead batch scheduler；后文的 ZOS 路径就是这里的 CPU／设备重叠执行路径。官方 Q&A 明确说明其思路借鉴 SGLang 和 NanoFlow。

CPU 开始调度下一轮时，上一轮的真实接受长度和最新 confidence 可能还在设备上，尚未返回给 CPU。若强制读回全部结果再决策，就重新引入了要隐藏的等待；若直接相信旧长度，又可能把 token 位置、KV 位置或验证长度算错。

DeepInfer 将控制拆开：CPU 先决定本轮总共做多少 query，设备再用较新的信息决定各请求分到多少，最后由实际验证确定接受多少。三次决策依赖不同信息，不能互相代替。

![DeepInfer DSpark 的 CPU 总预算、GPU 验证分配与目标模型真实接受，以及异步状态修正](/assets/images/posts/deepinfer-inference-design-mechanism.png)

图表达的是已有历史时的决策关系，并非一条逐项同步的时间线。总预算、每请求长度与实际接受，对应三个不同的输出。

### CPU 用哪个历史，GPU 又修正什么

在历史齐备的第 N 轮，CPU 用 N−2 轮的接受率预测选择总预算。`schedule_cnt` 与 `process_cnt` 记录某请求被调度和结果处理的次数：二者相等，表示最近结果已经回写；相差一，表示仍有一轮在途。算法由此识别 `accept_rates` 和 `prev_accept_rates` 各对应哪个相对时点，而非始终机械读取同一个字段。

随后，在存在上轮状态且当前 batch 与上轮有重叠的路径中，`Worker._correct_seqlens_qk` 使用当前请求到上轮请求的 remap，访问仍在设备上的较新结果。开启变长验证时，CUDA 内核读取原始 confidence，再做前缀累乘，按预测收益排名，把 CPU 已定的总验证位置分给各请求，写出新的 `seqlens_q`。

CPU 保存的 `accept_rates` 已经过累乘；GPU 读取的是原始 confidence，所以需要自己累乘。两处处理面向不同输入。对于新进入 batch、没有上轮对应项的请求，remap 也明确标识缺少历史，不能随意沿用原先同一行的另一个请求数据。

这次修正只回答“值得验证多少”。KV 长度还要依据上轮真正接受的 token 数修正，才能让新一轮从正确的位置继续。置信预测不能作为 KV 已经推进的事实。query 长度修正会回写到 pinned CPU buffer，采样元数据更新前仍有必要的事件等待；异步执行隐藏的是部分等待，工作和同步并未凭空消失。

### 一轮 Worker 怎样重叠新旧状态

在 `Worker.execute_model_step` 中，可以看到明确的交错顺序：

```text
准备并修正当前轮输入
    → launch 当前轮 main forward
    → 处理 prev_step_state，等待所需旧采样结果
    → 更新当前轮采样元数据
    → launch 当前轮 sample
    → 保存 curr_step_state，供后续处理
```

把新 forward 先提交给设备，旧结果的 CPU 后处理就有机会与它重叠。decode 加 ZOS 路径把当前后处理延迟到下一 step；prefill 或关闭 ZOS 时则在本步处理。离线请求循环结束后仍要 `flush_inflight_reqs`，取完这些已经提交但尚未对外整理的结果。

输出生命周期也属于这套设计。底层返回的是由池管理的输出指针，下次 step 可能回收，离线入口先 clone，再按 request ID 汇总并恢复输入顺序。性能优化要求跨轮复用内存，也就要求持有输出的上层在正确时点复制；只看 `model.forward` 无法看到这一层责任。

实际接受发生在 `Sampler._verification`。目标模型输出经过必要的结构化输出 mask，再执行验证、取得连续接受前缀并整理最终 token。若 grammar matcher 曾随着候选 token 推进，被拒绝的草稿还要回退 matcher 状态。因此，高 confidence、被选中验证、满足格式、真正接受，分别对应预测、预算、合法性与采样结果。

SGLang 的 overlap loop 同样先提交当前 forward、处理上一批，再执行依赖先前结果的采样；其 DSpark planner 也要处理滞后 confidence。具体到请求槽复用，`FutureMap` 配合 `req_generation` 检查历史属于谁，避免把已离开的请求的置信信息施加到占用同一槽的新请求。这与 DeepInfer 的 remap／计数器处理的是同一类状态身份问题，具体数据结构不同。

由此检查异步实现时，需要同时追踪请求身份、query／KV 长度、上一轮状态和在途输出，确认各自依据的是哪一轮事实。把调度挪到另一个线程，只改变执行时机；正确的跨轮状态修正，才能维持生成语义。


## 有限重放：利用跨层结构减少 decoder 的状态重建

前面的机制主要作用于 decode。长输入开始生成以前，prefill 仍要建立模型所需的状态；DeepInfer 在这里利用了 V4.1 的跨层 encoder／decoder 结构。

这里的 encoder 和 decoder 是模型内部的层组，prefill 和 decode 则是请求运行的阶段。decoder 层组也需要参与 prefill，建立后续生成要用的状态。把这两组概念分开，才能理解“减少 decoder prefill”究竟省在哪里。

还需要区分两种缓存：block KV 保存压缩或索引后的、可复用的上下文信息；SWA KV 保存局部滑动窗口注意力需要的状态。V4.1 允许 decoder 的 block KV 从最后 encoder 的 hidden state 投影得到，而 decoder 各层的 SWA 状态仍需要建立。

逐层精确重建这些局部状态，会遇到向前展开的依赖：当前层窗口内某个位置的 hidden，本身依赖上一层更早的位置。官方 Q&A 以 20 层 decoder 为对象，给出完整重建需要处理最后 2,560 个 token 的设计说明。即使每层只看局部窗口，多层叠加以后，要恢复的输入范围也会扩大。

SWA bounded replay 选择只重放末尾有限区间，并把区间外的滑窗依赖截断。若重放起点为 s，逻辑窗口为 128，位置 i 的 query 只访问 `max(s, i−127)` 到 i 的 key。得到的是近似的 SWA KV；重放开头缺少的依赖，无法仅凭“每层都是局部窗口”证明无影响。

对 decoder 而言，主要收益来自：encoder 仍处理所需输入，跨层 block KV 路径仍保留；consumer 层用有限后缀建立后续 decode 要用的局部状态，减少完整 decoder 前向工作。该重建结果用于 decode，不进入前缀缓存。它依赖这种模型结构，不能照搬为任意 Transformer 都可跳过早期位置。

官方生产设计还把同一思想用于另一种情形：block 前缀缓存命中、SWA 状态却缺失时，回退一个 block，重建近尾 SWA；已命中的 block KV 继续复用。这与每次 prefill 在 decoder 侧少算 consumer 工作，触发条件不同。分开两条路径，才能知道缓存命中究竟省掉了哪部分计算。

### 从 mask 到 compact，省掉的计算才真正落地

只把区间外的 attention mask 置空，仍可能保留完整 query 布局，后续层继续搬运和处理大量无须保留的行。DeepInfer 提供 mask 和 compact 两种实现，二者表达相同的截断语义，执行数据布局不同。

`prepare_tensor_input_v4.cpp::update_yoco_prompt_v4` 依据当前 chunk、保留长度和窗口生成元数据。mask 模式保留完整布局，将重放矩形外的滑窗可见范围置空；compact 模式则生成需要保留的 query 索引、累计长度、位置、SWA 存储槽位和压缩 key 范围。

源码把 YoCo 边界之前的 encoder 层组称为 producer，把从 `n_prefill_layer` 开始的 decoder 层组称为 consumer；这里描述的是完整 query 与截断后 query 两段执行路径。KV-source 则是另一项跨层共享关系：某层负责生成 KV，后续映射到它的层复用该 KV。consumer 层也可以是 KV-source，二者并非同义划分；当前代码要求首个 consumer 的 KV 来源不跨越这个压缩边界。

真正的压缩发生在 producer／consumer 层边界。主模型先切换到 consumer 元数据，进入首个 consumer decoder layer 时，`compact_yoco_boundary` 按保留索引 gather hidden state、residual 与跨层候选索引；`get_consumer_view` 相应更新 query 总量和位置，并清除依赖旧布局的 attention 索引，让后续按新布局重建。consumer 的 query 主干由此实际处理更少的行。

与此同时，代码保留完整 hidden state 和对应元数据。`attn.py::_store_yoco_full_kv` 专门沿 full hidden 路径完成 main／index KV 的投影与更新。因而不能把 compact 理解成“所有 decoder 工作和全部 KV 一并只剩后缀”：query 执行缩短，仍需保留的跨层 KV 工作继续有自己的完整数据路径。

这解释了优化的范围：输入没有在模型入口被直接裁短，encoder 也没有被要求忽略整个早期前缀。删掉的是特定层边界以后、不再需要完整执行的 query；block KV 与保留 query 之间仍须维持正确的索引关系。

启用 CP 时还多一层条件。原来的 token 已按完整序列分给各 rank，截断后继续使用旧下标会破坏布局。实现先找各 rank 保留下来的行，跨 CP 组收集，再依 compact 后的新划分取回本 rank 数据。少算 query 需要配套的重分布成本，这也是模型优化与并行组织相互约束的具体位置。

参数中的 128、134 与 140 分别有用途。128 是逻辑窗口；134 出现在窗口加草稿回退余量的部分存储或命中边界；README 推荐 compact 保留 140 个 token。运行时要求保留长度覆盖窗口加最大回退范围，因而不能读到“末尾重放 128”就把 compact keep 一律改成 128。前文的草稿拒绝会把状态向后退，保留区间必须容纳这种退回。

### 官方等价性程序究竟检验什么

`examples/yoco/yoco_equiv.py` 比较 mask 与 compact 是否实现同一种截断计算，配套文档为《YoCo mask/compact equivalence verification》。程序从元数据与模型输出两层检查两种布局的对应关系。

L1 检查元数据：同一请求在 mask 与 compact 布局下，SWA pivots、可见 key、存储槽位和压缩 key 范围能否对应。它不加载权重，但仍依赖当前仓库的编译扩展和设备条件。

L2 使用兼容的 V4.1 YoCo checkpoint，固定 teacher-forcing 轨迹，逐项比较 logprob 与 top-K。固定轨迹让两次计算沿相同 token 序列前进，避免自由生成过早分叉以后，无法判断差异最初来自哪里。DFlash 加 MTP 时还可比较 confidence，且官方明确其输出有一轮滞后。

这套验证支持的结论是：compact 的索引与数据移动，应当保留 mask 所定义的截断语义。它没有用未截断的完整重算作基准。因此，实现等价与近似质量需要分别评价：前者检查压缩布局有没有算错，后者检查截断依赖以后，目标任务的质量与性能怎样变化。

### 与前缀缓存比较，先分清复用和重建的职责

vLLM 的 Prefix Cache 用块 hash 识别相同前缀，KV 管理器查找已计算块，再分配未计算的空间。SGLang 的 RadixAttention 沿 token 前缀树匹配；HiCache 进一步管理数据位于 GPU、实例本地 host，还是后端存储。命中较低层时，还要判断搬回缓存与立即重算的代价。这些机制回答“哪些历史状态可以找到、保留和复用”。

bounded replay 回答的是另一步：已经利用跨层 block KV 之后，如何以有限工作重建 decoder 自己的局部 SWA 状态。缓存命中、状态重建和执行布局压缩可以组合，不能把它们当成三个互斥的缓存产品。

更直接的同层比较也已经存在。vLLM 当前主线的 `CacheConfig.swa_bounded_replay` 针对 DeepSeek-V4.1，把 SWA KV 排除在前缀缓存之外，命中后重算末尾窗口，并让最后 KV-source 之后的层只执行尾窗；该路径要求 Model Runner V2。SGLang 的 `deepseek_v4.py` 同样有 decoder SWA bounded replay，从最后 KV-source 层开始进入有限尾窗，并检查 source、index、candidate 等结构条件。

三套引擎的具体模型路径都已有有限重放，比较应进一步对齐重放窗口、数值路径、近似误差及配置组合。源码能说明各自怎样重建状态；这些路径是否得到等价结果，还需要同条件运行和质量比较。


## 性能数据要区分执行轮数与真实输出

前面的动态验证表给出官方估算吞吐，公开 benchmark 则从执行轮数按满接受口径换算吞吐；用户实际得到多少输出，还需累计真实新输出 token。三类数字的计数起点不同。

`examples/benchmark.py::measure_decode` 测量干净时间窗内的 step 间隔，得到 `avg_SPS`，单位始终是 steps/s。打印吞吐时，它按请求数、CP 规模与最大草稿长度换算。`examples/README.md` 明确这是 full-acceptance accounting；默认 `nextn=5`，相当于按每请求每 step 6 个 token 记账。

即使打开变长验证，固定版本的打印公式仍乘 `1+nextn`，没有在该时间窗累计真实接受 token。因而这个数适合观察固定记账口径下的执行能力，不能直接称为目标业务真实输出 token/s。

绘图脚本又有另一层换算。`plot_pareto.py` 用外部传入的草稿接受率构造 `tau=1+nextn*draft_acceptance`，据此变换曲线；默认接受率为 1。这里的接受率是输入假设，脚本没有从请求轨迹测出它。脚本还排除了用这套固定长度公式处理 VARLEN；这一限制避免误用，却不会自动补出真实有效吞吐。

实际比较 DeepInfer、vLLM 与 SGLang，至少需要对齐同一模型和 checkpoint、硬件与通信域、并行布局、上下文和输出长度分布、并发、缓存条件、草稿配置，以及质量约束。随后把 steps/s、真实新输出 token 数／总时间、验证长度与接受长度分布、首 token 延迟和后续 token 延迟同时保留。只记录一个 tok/s，可能把更长草稿、不同接受率或更宽松延迟条件误认成引擎速度差异。

README 的 prefill 图使用 4 张 SM100，decode 图使用 64 张 SM100，分别在单一 scale-up 域内。它们提供官方选定条件下的性能观察，无法与其他框架在不同卡数、模型和负载下的图直接拼成排名。沿实际计数路径解释数字，比在图上挑一处最高点更能支持部署判断。


## 三套系统的差异，需要落在实际部署的组合上

经过前面的逐层比较，可以把选择问题收束到三个决定，而非罗列支持多少功能。

| 要作出的决定 | DeepInfer 本文固定版 | vLLM 开发主线快照 | SGLang 开发主线快照 |
|---|---|---|---|
| 从哪层开始集成 | V4.1-Flash 离线引擎；完整在线存储、阶段拆分与跨副本路由需另接 | 离线 API 与在线服务；已有 KV connector 和 P/D 接法，相关文档仍标实验性 | 离线 Engine 与在线 API；已有 P/D 传输及 router 接法 |
| 怎样使动态验证生效 | 置信前缀收益、硬件时间曲线与运行时修正协作；异步下再修正请求长度 | 共同 K 查表之外已有每请求预算；Adaptive Verification 启动 profile 成本，并受 graph／backend／并行条件约束 | EAGLE tier 之外已有 DSpark 每请求预算；该 planner 需要 SPS 成本表，缺表可退化为全验证 |
| 复用以后还需重建什么 | block KV 与 SWA 分开；consumer query 压缩与 full KV 投影分路 | 前缀块缓存外，V4.1 MRv2 已有有限 SWA 重放 | Radix／HiCache 外，V4 模型路径已含 decoder 有限尾窗 |

从请求入口到真实输出计数，以上机制形成了同一条优化链。Wide EP 与 EPLB 决定计算在哪些设备形成批量，DSpark 决定本轮投入多少验证工作，异步修正保证旧结果尚在途时仍能继续，bounded replay 则决定下一阶段必须重建多少状态。任何一项少算，都要同时保住它依赖的请求身份、缓存位置和采样语义。

DeepInfer 当前的明确发布范围，为深入研究 V4.1-Flash 在指定硬件上的优化提供了相对集中的参考。vLLM、SGLang 则已有可接的在线入口与更多模型、backend 的配置面。后者可以减少部分服务集成工作，前者把特定模型的执行路径暴露得更集中；这些差异没有直接给出吞吐高低。

更关键的是交叉支持。模型支持、专家并行、某个 attention backend、DSpark、分离式服务和确定性模式，各自列为功能，不代表所有功能能在同一组合中同时生效。采用时应检查目标提交中真正走到的执行分支，再衡量该组合的质量、延迟和运维责任。


## 按真实入口评估采用条件

若准备评估 DeepInfer，起点应是公开版本支持的模型、设备和交付范围。当前基线面向 DeepSeek-V4.1-Flash，硬件列出 NVIDIA SM100 与 Huawei Ascend 950；是否适合已有环境，先由这些条件决定。完整服务层的集成责任，也应进入成本评估。

随后可以沿官方现有对象推进验证：先用 `offline_inference.py` 检查输入、生成和采样输出；用 EPLB 策略测试核映射不变量，再观察真实负载和搬权重成本；用 YoCo L1／L2 区分索引实现与截断算法；最后在同一负载下改变 DSpark、重放等配置，记录有效吞吐、延迟与质量。

README 的 Feature details and configuration 给出了对照所需的开关：`DEEPINFER_ENABLE_MTP_VARLEN=1` 打开 confidence-scheduled 变长验证，设为 `0` 关闭这项动态长度机制，最大草稿长度由 `DEEPINFER_USE_NEXTN_DECODE` 控制。YoCo 的 `DEEPINFER_YOCO_PREFILL_TRUNCATION_MODE` 接受 `off`、`mask`、`compact`；V4.1 的 README 推荐 `compact` 配合 `DEEPINFER_YOCO_PREFILL_KEEP_TOKENS=140`。mask／compact 的同语义对照入口是 `examples/yoco/README.md` 的 L1 metadata 与 L2 end-to-end output 小节，完整重放与截断质量则另作比较。两次对照应保持其他配置一致。这些对照分别检验动态预算、布局等价与截断质量，结果需要按各自的观察对象解释。

需要可重复对照时，还要固定影响结果的组合条件。官方对 NVIDIA 的确定输出说明要求 batch-invariant 模式、关闭 MTP_VARLEN，并为每条序列传入固定 `seq_seed`。随机种子控制采样随机数，batch invariant 则处理 batch 组成导致的数值路径变化，二者承担不同责任；这些条件也不能外推成跨硬件或跨版本逐位一致。

已经采用 vLLM 或 SGLang 的系统，可以先检查目标模型路径是否已有所需实现，以及当前 backend 和配置是否使它生效。若仍准备切换引擎，再用相同模型、硬件、工作负载与质量约束做对照，并把服务层需要另接的组件计入成本。真实收益足以覆盖迁移与后续维护，才有采用依据。


## 主要资料

- DeepInfer，提交 `9bd9cf243fc53ef9afbf8f04d391d989117d6ab9`：README、引擎与调度源码、EPLB、DSpark 和 YoCo 实现。
- DeepSeek V4.1 Flash Inference Deployment Q&A，`doc/inference_deployment_qa.md`：Expert-parallel load balancing、Speculative decoding、Asynchronous scheduling、KV cache hits and recomputation 小节。
- DeepInfer `examples/README.md`、`examples/benchmark.py`、`examples/sweep/plot_pareto.py`：离线回归入口、满接受记账与绘图换算。
- YoCo mask/compact equivalence verification，`examples/yoco/README.md`：L1 metadata、L2 end-to-end output 与 Notes and limitations。
- vLLM，开发主线 `fc9b7e6`：Expert Parallel Deployment、Dynamic Speculative Decoding、Adaptive Verification、Prefix Caching 及 CacheConfig。
- SGLang，开发主线 `780a5b1`：Expert Parallelism、Adaptive Speculative Decoding、HiCache Design 与 DSpark、DeepSeek V4 源码。
