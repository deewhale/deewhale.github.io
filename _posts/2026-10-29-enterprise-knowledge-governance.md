---
layout: post
title: "企业级知识库设计与治理：从检索演进到权限、版本与质量闭环"
description: "沿 GitLab 使用 Glean、微软内部 Copilot 治理和 Azure AI Search 的公开机制，解释关键词、混合检索、Cognee 与 Hindsight 如何支持定位后阅读原文，以及权限、版本、删除和评测怎样约束整条证据路径。"
image: "/assets/images/posts/enterprise-knowledge-governance-mechanism.png"
image_alt: "三张主卡展示来源事实、派生索引、检索阅读与引用，下方两张卡列出更新治理和质量闭环职责"
date: 2026-10-29 11:13:25 +0800
display_date: 2026-10-29
tags: [企业知识库, RAG, 混合检索, 知识治理, 软件架构]
---

GitLab 的公开《Glean End User Guide》把 GitLab 项目、Issue、Merge Request、Handbook，以及 Google Drive、Slack、Salesforce 等列为知识来源。用户从一个入口寻找材料，答案可以汇集不同来源并标出出处。对这样的组织，知识库首先要解决的困难很具体：信息已经存在，却散落在不同系统里，提问者还得猜它属于哪个项目、哪种文档和哪套词汇。

同一份手册也记录了集成的边界。部分 Salesforce 报表在 Glean 中主要能被发现位置和元数据，不能直接深入查询报表数据；某些权限映射仍需排障，可能出现源端能够打开、搜索端却提示无权访问的情况。统一入口已经产生价值，但一次连接成功没有消除来源差异。

这也是企业知识库建设容易低估的部分。把资料做成 embedding，只完成了寻找候选证据的一条路径。服务于持续工作的系统，还要让检索结果指向可以继续阅读的材料，知道内容来自哪里、哪个版本有效、当前用户能读什么，以及源端改变后，搜索结果何时跟着改变。

**企业知识库的演进，正在把“找线索”“读材料”和“维护可用证据”分成可以组合的能力。** 关键词、向量和混合检索帮助定位，父文档、结构导航与读取工具让模型继续取证，连接器和知识治理则约束每次检索与阅读。一次返回若干片段只是其中一种实现，不能代表 RAG 的全部能力。

以下以截至 2026-10-29 的公开资料分析这些机制。GitLab 的使用手册与微软的内部治理记录承担真实实践证据；Azure AI Search 文档解释可配置链路；Cognee、Hindsight 及 RAG 框架的最新文档和固定源码用于检查定位、阅读与工具接线。它们承担不同层次的职责，不被拼成同一套端到端实现。文中没有客户系统实测或性能复现。

## 跨源搜索先解决入口，语义检索再补表达差异

文件夹和产品内搜索依赖用户先选对范围。目录组织得好，熟悉组织的人能快速定位；组织持续扩张时，同一主题可能同时出现在手册、讨论、工单与附件中。跨源搜索把多个入口汇集起来，但汇集之后仍要回答：一个问题应该匹配哪些材料？

关键词检索以词项为基础，倒排索引把包含这些词的文档找出来，BM25 等方法再组织候选顺序。它保留了企业资料中特别有价值的信号：精确的产品代号、错误码、接口名、制度编号。成熟全文搜索也早已使用分词、同义词、词干处理和排序模型，不能把它概括为只能逐字匹配。

剩余缺口是表达差异。提问与原文可能使用不同措辞，甚至只有相近含义而没有共同关键词。Dense retrieval 把问题与文本映射为向量，借助向量距离寻找语义相关的候选。2020 年《Dense Passage Retrieval for Open-Domain Question Answering》使用问题编码器和 passage 编码器分别产生表示，再通过内积检索。这给出了绕开部分词汇不一致的具体方法；论文的开放域问答结果并不直接证明企业资料应全部改用向量。

同年的《Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks》进一步把外部 dense 索引与生成模型结合。对知识库设计有意义的变化，是一部分回答依据可以从模型参数移到可更新的外部材料中。更新资料不必总通过重新训练模型完成。但外部索引能更新，只说明更新有了落点，没有说明抓取是否及时，也没有确定哪份资料有权代表当前规则。

因此，语义检索增加的是一条召回通道。它扩大了表达覆盖，也可能把主题相近而条件不符的段落带进来。关键词能锚定精确名称，向量能发现不同表达，二者的失误方式并不相同。

Glean 这样的成熟企业搜索产品，把另一部分工作产品化了：连接源系统、维持身份与权限映射、汇集结果并返回出处。GitLab 的实践说明，这层价值不能缩减成“用了哪种 embedding”。反过来，Glean 是闭源产品，公开手册也不足以让外部研究者逐步还原其内部召回融合和权限缓存算法。能够核实的是使用对象、访问边界和管理界面中的可观察状态。

## 混合检索与重排，把“找得到”和“排得对”分开

当精确词与语义都重要时，强行二选一会丢掉已有能力。混合检索保留两路候选，然后融合它们。

Azure AI Search 的公开《Relevance scoring in hybrid search using Reciprocal Rank Fusion》描述了一条具体路径：全文搜索产生一组候选，向量搜索产生另一组候选，RRF 根据各列表中的名次融合，再由 semantic ranker 对候选文本进行语义重排。Elastic 的《Hybrid search》也提供全文与向量并用的实现。

这几个阶段承担不同职责。BM25 分数衡量词项相关性，向量分数表达相应距离或相似度，RRF 计算的是候选在各路列表中的排名贡献。它们的数值尺度不同，不能直接相加，也不能把融合分数解释成答案正确的概率。RRF 避开了先把异质分数校准到同一尺度的要求，却仍受每路候选窗口限制：没有进入任何候选列表的材料，不会因为融合自动出现。

重排处理的是更靠后的问题。Azure《Semantic ranking overview》将 semantic ranker 定位为 BM25 或 RRF 初排之上的第二层排序。它利用问题与候选文本的关系，把更合适的材料提前；输入名单里没有的证据，重排器无从补回。

由此可以把一个模糊的“RAG 回答不好”拆开。应有证据根本没有进入候选，先检查检索范围、解析、分块及召回方式；证据已经出现，只是被大量近邻挤到上下文窗口之外，再考虑融合参数和重排。盲目增加 reranker，可能为缺失的候选多付一次推理成本，却没有触及原因。

| 观察到的缺口 | 增加的机制 | 仍需保留的判断 |
|---|---|---|
| 精确名称能找到，同义表达漏掉 | 向量召回与关键词并行 | 新候选是否适用问题条件 |
| 两路结果都有价值，顺序难以直接比较 | RRF 等排序融合 | 每路候选窗口是否覆盖足够证据 |
| 证据已召回，却排在上下文之外 | 语义重排 | 输入中是否已有正确证据 |
| 答案跨越多个章节或多个问题 | 结构组织、多查询规划 | 是否读全、是否增加了无效调用 |

这张表的用途是定位该改哪一层。它没有给出统一升级顺序：精确标识符查询可能依然主要依靠全文搜索，单段问题也未必需要多步规划。

## 小片段用于定位，阅读可以回到更大的材料

混合检索与重排提高了候选质量，但候选片段不一定足以承担最终判断。限定条件可能在上一段，表格口径可能在章节开头，答案的反例可能位于后文。把 top-k 片段直接拼给模型，容易把“与问题相似”误当成“足够回答”。

一种重要的演进是分开选择单位与阅读单位：用小片段、摘要或事实定位，再读取父文档、相邻块、原页，必要时继续检索和阅读。检索结果由一份现成答案的原料，变成进一步取证的入口。

这条路径已经存在于 RAG 体系内部。LangChain 的 `ParentDocumentRetriever` 用小子块匹配问题，再通过 `doc_id` 取回 docstore 中的父文档，父文档可以是较大文本块，也可以是一整份文档。LlamaIndex 的 `AutoMergingRetriever` 根据已召回叶节点对同父节点的覆盖程度，合并成较大的父节点；`RecursiveRetriever` 则沿 `IndexNode` 的引用继续调用映射的检索器、查询引擎或节点。这里的增量是让定位所需的精细度与阅读所需的完整度分别优化。

这些组件不必都让上层 Agent 自主操作。父块扩展可以在检索管线中一次完成；递归检索也可以由确定的组件关系驱动。只有工具真正暴露给 Agent，模型才有机会在读过材料后选择下一次行动。因此，应把三种能力分开核对。

| 能力 | 检索之后发生什么 | 需要核实的结果 |
|---|---|---|
| 扩展上下文 | 小块匹配后取父块或相邻块 | 返回范围是否包含必要条件，是否被截断 |
| 按定位独立读取 | 根据文档、块或页标识调用读取接口 | 实际读到的表示、版本与访问范围 |
| Agent 多轮取证 | 读后决定补查、扩读、找反证或停止 | 工具是否接通、实际读过哪里、预算是否用尽 |

“原文”也需要具体化。原始 PDF 或图片字节、解析后的全文、索引中保存的 chunk，以及源系统此刻的最新文件，是不同对象。拼接存储块可以恢复部分文本上下文，却恢复不了解析时已经丢失的表格布局；读取摄取时保存的全文，也不等于重新打开源端的最新文件。

此前的[PageIndex 长文档检索分析](/posts/pageindex-document-retrieval/)展示了目录树定位与原页读取。它让“先去哪里读，再根据读到的内容回答”更显式，但文档内部导航之前仍需要跨源选择，读取之后仍需要版本和权限约束。ParentDocument、递归检索与树导航可以是这条路径上的不同实现，不能把它们简单排成 RAG 与非 RAG 的对立。

![从候选定位到范围读取再到多轮取证的三个步骤，以及原文表示、工具入口和读取授权的核查职责](/assets/images/posts/enterprise-knowledge-governance-locate-read.png)

图展示三种可以组合的能力。箭头表达从定位到取证的依赖，是否由一次检索完成、由独立工具执行，或由 Agent 多轮决定，需要检查各项目实际入口。

### Cognee：图上下文扩展与读文档是两条路径

Cognee 展示了为什么需要检查实际代码，而不能只凭“图记忆”理解系统。以下分别核对 v1.6.5、固定提交 `37f788b`，以及发布页标为 Latest 的 v1.6.6rc1、提交 `277a314`。后者带候选版标记；它的来源引用与原件读取路径单独说明，不与稳定版能力混写。

这个提交的 `cognee/api/v1/search/search.py` 中，`search` 默认类型是 `HYBRID_COMPLETION`，组合文档 passages 与实体邻域。`recall` 在未指定类型时可以自动路由，关闭路由则回到这一类型。把当前默认仍写成纯图检索，会遗漏文档片段这一条路径。

Cognee 的 context extension 更接近在图证据上继续探索。`GraphCompletionContextExtensionRetriever` 先取 triplets，也就是实体间关系三元组，把它们转成文本；随后用当前上下文生成 completion，将生成结果作为新查询，再取三元组并合并。默认最多进行四轮，没有新增三元组时可以提前结束。实现位于 `cognee/modules/retrieval/graph_completion_context_extension_retriever.py`。

这确实是迭代扩展，但扩展的对象是图上下文。模型根据当前证据形成的文本参与下一次查找，能够触达更多关系，也可能把后续查询带向已有概括。它不等于模型已经打开原 PDF、检查表格或读完支持这些关系的全文。

读文档与邻块的底层实现也已经存在。`cognee-mcp/src/retrieval_utils.py` 中，`get_document_from_graph` 根据 `document_id` 找到 `DocumentChunk`，按 `chunk_index` 排序并返回文本块、总数及截断状态；`get_chunk_neighbors_from_graph` 则取同文档中目标块前后的内容。这使定位后扩读有了可用的基础。

工具接线决定这些能力能否被上层 Agent 使用。在上述两个固定版本中，`CogneeClient.get_document` 和 `get_chunk_neighbors` 可调用上述 helper，但 API 模式明确抛出 `NotImplementedError`；主 `server.py` 通过模型上下文协议（MCP）注册的工具中也未找到这两个读取入口。由此能得出的结论是：文本扩读实现存在，所检查的主 MCP 服务尚未通过这两个入口把 search→read 路径接通。仅展示 helper，不能声称 Agent 开箱即用地拥有这套工具；仅看到入口未注册，也不能说底层没有读文档能力。

不过，这两个 client 方法未接通 API 模式，不能推广成整个 HTTP 服务没有原件读取能力。v1.6.5 与 v1.6.6rc1 的 `get_datasets_router.py::get_raw_data` 都有按 dataset ID 和 data ID 取得原始文件的 HTTP 路径。它先取得已认证用户，检查 dataset 的 read 权限，再确认数据项属于该 dataset，然后从保存的 `raw_data_location` 返回文件：S3 走流式响应，本地文件存储走文件响应，其他存储协议明确不支持。这是读取已存原件字节的路线，与拼接图里的文本块不同。

同一候选版的 MCP `recall` 新增默认关闭的 `include_references`，启用后可在支持的结果中返回 data ID、dataset ID 等引用。应用可据此定位，再调用原件端点并交给文档阅读器，形成“召回定位→鉴权取原件→阅读”的路径。但所检查的主 MCP 服务没有把这个下载入口直接包装成读取工具；来源引用增加了定位信息，不能据此宣称每个 Agent 已经自动阅读 PDF。原件端点也读取摄取后保存的文件，并非实时访问外部 SaaS 的最新内容。

图读取 helper 本身仍有边界：它取的是保存的提取文本，`PdfDocument.py` 通过 pypdf 从原 PDF 提取文字后交给分块流程。需要核对原始表格或版式时，应选择相应原件读取路径与阅读器。提取文本可用、原件可取得、Agent 实际读过，是三个需要分别验证的条件。

### Hindsight：从记忆事实回到保留的文本与附件

Hindsight 把事实记忆与来源内容的区别表现得更清楚。以下基础读取路径已核查 v1.1.0、提交 `a5a619b`，并对照截至 2026-10-29 的主分支 `6decc29`。记忆层有助于组织长期事实，但它与完整企业知识库入口承担不同职责。

写入 `retain` 后，系统可以从输入中抽取事实（facts），再归纳观察性总结（observation）。Observation 的 `source_memory_ids` 可以回指支持它的事实。召回时，`include.source_facts` 返回这些抽取事实；这是一层溯源关系，返回的内容仍然经过抽取，不能称为原文。

`include.chunks` 才会沿事实的 `chunk_id`，或从 observation 经来源事实找到 chunk，取回保存的 `chunk_text`。返回受预算限制，末尾文本可能截断并标记 `truncated`。因此，“召回时附带原文块”说明用户可以看到部分原始上下文，没有证明所有支持材料已被完整阅读。

独立读取则走另一组接口。`MemoryEngine.get_document` 返回 `original_text`、`content_hash`、文档 ID 和更新时间等；`get_chunk` 取指定块，`list_document_chunks` 按块序号分页。启用相应工具集后，MCP 已注册的 `get_document` 可以调用到文档读取路径。实现可在 `hindsight-api-slim/hindsight_api/engine/memory_engine.py` 与 `mcp_tools.py` 中定位。

这条路径允许 Agent 先用事实记忆找到来源，再调用工具读更完整的保留文本，依据读到的内容决定是否继续。它与只把 recall 返回值直接塞进答案上下文，有明确的操作差别。实际是否继续阅读，仍取决于 Agent 的工具配置与决策，接口存在不代表每次回答都执行了回读。

对保留附件，Hindsight 还有按附件 ID 取得字节和 media type 的 HTTP 路径，相关响应可以提供附件引用。它为图片或文件事实提供了另一种检查依据。但 `get_document.original_text` 是 retain 保存的内容表示，附件字节是另一种存储对象，不能把任何全文读取都解释成下载原始 PDF。

保存策略直接决定这条证据路径能走多远。官方配置中的 `store_document_text=false` 允许事实与内容 hash 留存，但不保存文档全文及可返回的 chunk 文本，对应文档、块读取和附带 chunks 的内容将为空。数据最小化减少了保存内容，也放弃了这份本地文本副本的后续重读能力。若应用仍要求核对原文，就需要另一条受控、可定位的来源读取路径。

`document_id` 与 `content_hash` 可以帮助识别当前保留内容，不能据此推定接口支持任意历史版本回读。对于重要判断，系统应明确读的是摄取快照、当前保留版本，还是外部源最新文件；版本不一致时，需要重新定位或说明证据状态。

## 结构与 Agentic Retrieval 扩大取证范围

定位后阅读解决局部上下文不足，全局概括和复合问题还可能需要组织更多候选。RAPTOR 的论文《Recursive Abstractive Processing for Tree-Organized Retrieval》递归地聚类和生成摘要，建立多个抽象层级；GraphRAG 的《From Local to Global: A Graph RAG Approach to Query-Focused Summarization》提取实体关系并形成社区摘要，支持面向语料整体的归纳。摘要与图关系提供导航线索，重要细节仍可能需要回到它们依赖的材料核验。

企业知识图谱还可能描述人员、内容、活动和访问关系。不能因为 Glean 使用 enterprise knowledge graph 的表述，就认定它采用 GraphRAG 论文的社区摘要算法，也不能因为一个系统提取了实体关系，就推断它拥有企业身份同步能力。

查询侧也可以主动扩大覆盖。Azure 的《Agentic retrieval overview》把 knowledge base 与 knowledge sources 分开：前者组织检索，后者定义可查询来源。在启用相应规划能力时，模型可将复杂问题拆成子查询，并行执行关键词、向量或混合检索，重排后汇集证据。返回的 source references 与 activity log 有助于检查用过哪些来源、执行过哪些检索活动。

这里的 query planning 与独立 read 工具仍需分别判断。多次搜索能补不同子问题，却未必提供按页打开原件的工具；一份引用列表也不能证明 Agent 真的读过完整来源。系统要记录实际返回给模型的材料范围与截断状态，才能判断缺失证据发生在定位、扩读还是上下文预算阶段。

这些能力增加了覆盖面，也扩大了错误空间：拆错子问题、选错来源、重复检索和无效扩读都可能增加延迟。活动记录提供诊断材料，本身不证明规划合理或证据完整。

截至 2026-10-29，Azure 文档中基于 `2026-04-01` API 的 minimal effort、extractive 路径及已正式发布的 source 类型可用于生产；LLM 规划、答案合成、非 minimal effort 和多轮能力属于 `2026-08-01-preview`。Minimal effort 跳过模型规划。架构选择应依据具体能力的发布状态。

检索、定位、读取与迭代至此形成了一条更长的证据路径。每增加一个入口，都要回答它读到什么、依据哪个版本、是否重新检查访问权限。成熟知识产品处理的来源与维护问题，也随之延伸到每一次阅读。

## 成熟产品把知识维护变成具名的工作

搜索能找到一份材料，与这份材料仍然适合回答，是两个判断。相似度无法知道制度是否已废止，生成模型也不能替组织指定哪份文档代表正式口径。

Glean 的《How verification works》提供了一个具体补充：具名用户可以确认文档准确且仍然有效，界面展示核验者与核验时间，并支持请求核验、弃用标记和重新核验提醒。它增加的是责任归属与复核动作。核验徽标可以帮助使用者识别维护状态，却不能自动证明每句话都正确；到期提醒仍需要负责人实际处理。

这层机制与检索技术形成分工。检索模型判断问题与材料有多相关，知识维护者判断材料是否仍代表组织认可的说法。若两份文档高度相似却互相矛盾，继续调整 embedding 未必有用；需要先确认生效版本、适用范围和负责人。否则模型可能忠实地总结了两份冲突依据，给出语言流畅却无法执行的答案。

权限也存在类似分工。遵守源端权限可以避免把私有文件直接交给无权用户，但源端已经分享过宽时，搜索和读取工具完全遵守权限，仍可能让内容被更大范围发现。

微软在 2026-05-07 发布的 Inside Track 文章《How we’re tackling Microsoft 365 Copilot governance internally at Microsoft》中，公开了自身推广 Copilot 时的治理实践，包括收紧协作容器的默认设置、敏感度标签、负责人复核以及生命周期管理。这个案例的意义在于：成熟工作入口仍需要源端所有者持续处理过度分享和无人维护的内容。微软既是产品提供者，也是这段内部实践的使用者；这份材料不构成独立客户效果测量。

可发现性还有专门的控制面。SharePoint 的 Restricted Content Discovery 可以在治理期间抑制选定站点出现在相应的组织级发现体验中，但它不修改原访问控制列表（ACL），即规定哪些用户或组可以访问对象的规则；它也不删除索引内容或撤销直接访问。它能降低某些发现路径的暴露，完整的访问治理仍要回到源权限。

Glean 的 Google Drive 连接器文档也把访问与发现区分开：面向链接或公司域共享的文件，是否在搜索中出现，还涉及访问历史和可搜索设置等条件。因此，“用户在源端有权打开”与“搜索应该向他主动呈现”不能总被视为相同条件。

这让企业知识库的职责变得清楚：来源系统保存内容与访问事实，组织决定所有权、权威性和发布范围，知识产品把这些状态传播到使用入口。产品可以提供提醒、核验和限制发现的工具，维护判断仍要有人承担。

## 权限变了，知识库里的副本怎样跟着变

一旦内容被复制到索引或记忆存储，知识库就必须维护一个随源系统变化的派生视图。正文与权限的变化并不总发生在同一时刻，也不总沿同一路径被发现。源端 ACL 与索引中的权限副本，需要通过同步任务连接；索引器（indexer）负责从来源读取变化并更新索引。

Glean 的《Access verification》把 Last crawled、Last indexed 与用户 access 分开呈现。抓取完成、索引完成、特定用户能够访问，代表不同状态。API 限流、来源故障、数据量以及独立的用户组刷新，都可能影响状态传播。GitLab 手册里记录的访问差异，正说明排障需要同时看源端与搜索端，不能只看连接器是否显示绿色。

连接器的数据对象也应表达这种区别。Microsoft Graph 的 externalItem 将 `content`、`properties` 和 `acl` 并列，并用稳定 item ID 支持创建、更新和删除；源系统的用户与组还需要映射到目标身份。内容文本不会自行携带这些语义，只有向量加一个模糊的用户字段，难以完整表达组继承、拒绝规则与身份更新。

Azure AI Search 的 SharePoint ACL 索引路径提供了一个可以看清状态变化的机制。以下是官方功能的分析，不是微软内部 Copilot 或 GitLab 部署的实现还原；相关原生 ACL 功能仍处于预览阶段。

摄取时，indexer 读取 SharePoint 项目的有效 ACL，并与文档建立索引。查询时，应用的索引访问授权与终端用户身份分别参与检查，再依据已同步的权限元数据限制结果。关键在“已同步”：查询收到新 token，并不表示索引里的权限副本已经更新。

以父级文件夹的继承权限变动为例，状态沿下面的路径推进：

1. 源端父级 ACL 改变，子项的实际访问范围随之变化。
2. 索引中仍可能保留子项此前的有效 ACL；正文没有修改，也不能据此推断权限没有变化。
3. 当前 SharePoint indexer 不自动识别这类父级继承权限变化。需要触发权限 `resync`，或对指定文档 `resetdocs`，再运行 indexer 完成刷新。
4. 刷新完成后，查询才可依据更新后的索引权限限制后续结果。

对应行为见官方《Use a SharePoint indexer to ingest permission metadata》及《Run or reset indexers》。项目自身 unique ACL 的增量变更，从 `2026-05-01-preview` 起可以在成功的 indexer run 中拾取；这与父级继承变化是不同分支。仅调用刷新接口，没有等实际任务完成，也不能视为权限已经收敛。

这条路径说明，**内容新鲜度与权限新鲜度需要分别观察。** 系统可以把它们做成独立版本字段，也可以记录在同步日志中；无论采用哪种实现，排查时都应能回答最近成功读取正文和权限分别在何时、覆盖了哪些对象。不能用一次正文同步成功来代表整个权限树已经刷新。

![三张主卡依次为明确来源事实、同步与构建派生索引、检索阅读与引用，下方是更新治理和质量闭环两张职责卡](/assets/images/posts/enterprise-knowledge-governance-mechanism.png)

三张主卡的箭头表达来源事实、派生索引和检索阅读之间的信息依赖；下方两张卡列出贯穿它们的更新与质量职责。图为参考设计，不代表某家产品串行执行这些动作或自动提供全部派生失效能力。

独立读取接口也有自己的授权边界。Hindsight 用 bank 划分记忆存储空间，文档与块读取会检查租户、bank 读取权限及文档标签可见范围，读取附件也有相应范围控制；这些是记忆系统内的控制，不等于自动继承任意外部 SaaS 的 ACL。Cognee 的图文档读取辅助函数没有显式用户或 ACL 参数，单凭它不能证明完整应用授权已经覆盖读取；接入服务时应走经过核实的权限路径，不能把已知文档 ID 当作通行证。

授权还要落在正确的位置。Azure 的 security filter 模式本质上对 principal 字符串做过滤。Principal 是参与授权的用户或组等身份主体，这种过滤不负责认证字符串所代表的身份。应用必须从已验证身份构造查询条件，不能允许客户端随意指定他人的 principal。原生 ACL/RBAC 查询授权路径则接收用户 token，按已入索引的权限元数据执行约束，两者不能被描述成同一种保证。

不可见材料应在进入不应接触它的重排服务和生成上下文前被排除。ANN 检索中采用 preFilter 还是 postFilter，讨论的是过滤与候选搜索怎样结合：Azure《Vector query filters》指出，小候选数或高选择性条件下，后过滤可能丢失本来相关且有权访问的结果。这是召回与代价问题，preFilter 本身并不认证用户。

失败路径也属于授权设计。Azure《Query-time ACL and RBAC enforcement》说明，其原生授权评估失败时返回错误，而非返回一份不完整过滤的结果；缺少用户 token 时不返回 ACL 保护的内容，公开内容仍可能返回。自建应用是否采取同样行为，需要明确实现，不能从“接了权限过滤”推定出来。

## 删除、摘要与缓存，让生命周期越过索引边界

权限刷新还不是生命周期的终点。源文档撤回后，正文、片段、摘要、图结构和缓存中可能仍有它的派生内容。删除主记录，只覆盖了其中一个对象。定位与阅读分开后，旧 locator 还可能继续存在：读取入口应重新检查文档是否存在、身份是否仍有权限，不能因为此前 search 返回过这个 ID 就继续放行。

Azure Storage indexer 的《Change and delete detection using indexers for Azure Storage》把更新与删除检测分开。修改时间可以帮助发现新建和更新；源对象消失，却未必留下索引器能读取的删除事件。采用软删除策略时，indexer 需要在保留窗口内成功看到删除标记，才能删除对应索引项。策略应从第一次运行就设置，事后加上策略再 reset，不能保证清除所有此前遗留的孤儿记录。

因此，软删除保留时间需要覆盖正常同步间隔，也要留出任务故障后的恢复余量。具体窗口必须由部署负载和来源策略确定。这项机制能支持的工程结论是：新建、更新、删除应分别验收，不能把“增量同步工作正常”当成三者都已被证明。

Hindsight 主分支的文档删除实现进一步展示了逻辑删除与物理清除的差别：数据库事务会清理源记录、相关记忆与链接，并处理依赖已删事实的 observation；附件文件随后尝试删除，失败不回滚逻辑删除。该实现可以定位到主分支 `6decc29` 的 `memory_engine.py`，但不能被写成所有版本已保证缓存、导出和备份中的字节同时擦除。

更复杂的派生对象需要保留来源关系。一个片段至少应能回到源对象、版本与位置；多文档摘要还应知道自己依赖了哪些材料。这是由前述状态传播机制推导出的设计要求，不是某家产品字段表。

跨权限摘要尤其容易出问题。如果摘要合并了访问范围不同的文档，不能任取其中一份 ACL 作为整个摘要的访问范围。可行的设计包括按当前用户可见的材料生成，或对多源派生内容施加能够满足必要来源访问条件的约束。否则，即便原始片段检索做了正确过滤，摘要本身仍可能暴露不可见材料。

答案缓存同样依赖身份与时效。相同问题不代表不同用户可以共享同一份回答；按用户分开缓存后，撤权或来源失效仍可能要求重验与失效处理。已经合法展示给用户的信息无法靠删除索引收回，这里的目标是让后续服务不再继续提供失效或已撤权的证据。

减少副本也是一种架构选择。Azure 的 remote SharePoint knowledge source 通过 Copilot Retrieval API 代表用户检索，省去另建 Azure Search 内容索引的路径，把更多权限与标签治理留在来源侧。它仍受来源 API 的许可、格式、配额和可用性约束，且属于 `2026-08-01-preview`。直接查询来源服务不等于该来源内部绝无索引延迟；是否采用远端路径，要比较减少副本维护的收益与接口能力限制。

## 质量闭环从证据失效的位置开始

到这里，“知识库可用”已经有了比答案流畅更具体的含义：对特定身份，系统取得当前有效的合法证据，回答受到这些证据支持，来源变化能传播到后续使用中。

评测需要顺着这条路径拆开，并把定位与实际阅读分别记录。可以用来源 ID、版本或 hash、页或块范围、读取接口及截断标记描述一次取证；这些是参考设计中的观察项。引用存在只说明有出处标识，实际读过哪些材料才说明模型获得了什么。

来源没有覆盖问题，增加检索模型无法补出事实；源端已有新版本而索引没有同步，答案可能忠实引用旧材料；正确材料已经定位却没读到必要父块或原页，应查读取工具接线、范围和预算；材料已返回却没进入上下文，应查排序和打包；上下文正确而结论仍不受支持，再检查回答生成。

Azure Architecture Center 的《Develop a RAG solution — Information retrieval phase》把检索与相关性标注联系起来；Microsoft Foundry 的《RAG evaluators for generative AI》区分文档检索、上下文相关性、groundedness 与回答完整性等维度。这里最容易混淆的是 groundedness：回答忠实于给定上下文，不代表上下文本身仍然正确有效，也不保证回答满足了问题。

因此，相关性数据集应固定身份与语料快照。对一名无权读取文档的用户，受保护材料不应被标作“应该召回”；对语料本来没有答案的问题，也不应强求系统返回一个最相近片段。Recall@k 关注证据是否进入候选，MRR 或 NDCG 关注相关材料的位置，引用支持度则检查被引段落是否支撑具体结论。一个综合分数无法替代这些责任区分。

前述公开机制还可以转化为部署前的状态变化验收。下面是建议执行的验证设计，本文没有在租户中执行这些实验。

| 改变真实来源状态 | 检查后续服务的结果 | 若不符合，首先定位 |
|---|---|---|
| 收回 SharePoint 项目自身权限，并完成支持该变化的索引刷新 | 相应身份不再取得该项及其受保护派生内容 | 身份和组映射、API 版本、索引权限与缓存 |
| 改变父级继承权限 | 明确触发并完成所需权限刷新，随后按新范围检索 | 是否误用正文修改时间、是否只提交刷新未完成运行 |
| 对受策略覆盖的对象软删除，并在保留窗口内运行 indexer | 索引项消失，相关派生对象按设计失效 | 删除策略建立时间、墓碑窗口、稳定对象 ID 与依赖关系 |
| 用无权限身份提相同问题，并尝试按已知 ID 读取 | 不可见证据不进入结果与模型上下文，独立读取也受限 | 服务端身份构造、查询和读取授权、摘要与共享缓存 |
| 定位后扩读，或关闭原文保留后再次读取 | 明确返回范围、版本与截断状态，缺失文本不能伪装成已完成取证 | 原件与提取文本的保存策略、MCP 工具注册、读取预算 |
| 询问语料没有充分依据的问题 | 表达证据不足，避免把近邻写成确定事实 | 来源覆盖、检索输出、上下文选择与生成规则 |

这些验证需要同时检查误放行与误拒绝。GitLab 手册记载的源端可读、搜索端拒绝，属于后者；只检查“没有泄漏”，仍可能留下一个合法用户无法使用的系统。反过来，平均答案分数再高，也不能抵消撤权未传播的发布缺陷。

对相关性能力的升级，应从观察到的失效开始。材料散落且访问关系尚不清楚，先补连接器、对象映射和授权传播；同义表达漏召回，保留精确检索再评估向量与融合；候选已经齐全而位置不佳，再引入重排；候选能定位却缺上下文，增加父文档、邻块或原页读取；问题确实依赖多层或跨源证据，再比较树、图与多查询编排的覆盖、延迟和成本。每次增加能力，都应能说明它修复了哪类已发现的问题。

企业知识库最终需要交付的是一条能够持续维护的证据路径。GitLab 使用 Glean 展示了跨源入口的实际价值，也保留了来源语义与权限映射的工作；微软内部 Copilot 实践把源端所有权和分享范围带回部署过程；Cognee 和 Hindsight 的代码说明，图或记忆能够帮助定位，重新读取材料的能力则取决于保存对象、读取入口与工具接线；Azure 的公开状态变化则揭示了副本更新的具体边界。架构决策由此落到可以检验的问题上：找到线索之后读了什么，读到的版本是否仍然有效，改变来源和权限之后，每一条后续读取路径怎样确认自己已经跟上。

## 主要参考资料

- GitLab Handbook：《Glean End User Guide》；Glean：《Access verification》《Permissions (Google Drive)》《How verification works》。
- Microsoft Inside Track：《How we’re tackling Microsoft 365 Copilot governance internally at Microsoft》，2026-05-07；Microsoft Learn：《Restrict discovery of SharePoint sites and content》。
- 《Dense Passage Retrieval for Open-Domain Question Answering》，2020；《Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks》，2020。
- Elastic：《Hybrid search》《Reciprocal rank fusion》；Azure AI Search：《Relevance scoring in hybrid search using Reciprocal Rank Fusion》《Semantic ranking overview》。
- 《RAPTOR: Recursive Abstractive Processing for Tree-Organized Retrieval》，2024；《From Local to Global: A Graph RAG Approach to Query-Focused Summarization》，v2，2025。
- Azure AI Search：《Agentic retrieval overview》《Use a SharePoint indexer to ingest permission metadata》《Query-time ACL and RBAC enforcement》《Run or reset indexers》《Change and delete detection using indexers for Azure Storage》《Create a remote SharePoint knowledge source》。
- Microsoft Graph：《Create, update, and delete items in a Microsoft Graph connection》；Azure Architecture Center：《Develop a RAG solution — Information retrieval phase》；Microsoft Foundry：《RAG evaluators for generative AI》。

- LangChain：`ParentDocumentRetriever`；LlamaIndex：`AutoMergingRetriever`、`RecursiveRetriever` 官方参考。
- Cognee v1.6.5，提交 `37f788b`：`cognee/api/v1/search/search.py`、`cognee/api/v1/recall/recall.py`、`cognee/modules/retrieval/graph_completion_context_extension_retriever.py`、`cognee-mcp/src/retrieval_utils.py`、`cognee_client.py`、`server.py`；v1.6.6rc1，提交 `277a314`：同类检索与 MCP 入口，以及 `cognee/api/v1/datasets/routers/get_datasets_router.py` 的原件读取路径。
- Hindsight v1.1.0，提交 `a5a619b`，及主分支提交 `6decc29`：`hindsight-api-slim/hindsight_api/engine/memory_engine.py`、`mcp_tools.py`、`api/http.py`；官方 Documents 与 Configuration 文档。
