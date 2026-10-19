---
layout: post
title: "Bakabase：从文件扫描到可追溯资源目录"
date: 2026-10-08 14:00:00 +0800
display_date: 2026-10-06
categories: [Software, Open Source]
tags: [Bakabase, Playnite, Hydrus, Stash, 资源管理, 软件架构]
description: "从真实路径规则、属性来源与索引等待顺序理解 Bakabase，并用样本测试判断它与 Playnite、Hydrus、Stash 的适用边界。"
image: /assets/images/posts/bakabase-resource-catalog.jpg
image_alt: "一排带标签的木制卡片目录抽屉"
last_modified_at: 2026-10-19 20:07:46 +0800
---

![一排带标签的木制卡片目录抽屉](/assets/images/posts/bakabase-resource-catalog.jpg)

*摄影：Ilya Semenov / Unsplash；裁切。*

先看一份用于推演的收藏样本：

```text
收藏/
├── 作者甲/
│   ├── 作品乙/
│   │   ├── 01.flac
│   │   ├── cover.jpg
│   │   └── notes.txt
│   └── 系列丙/
│       └── 作品丁/
│           └── 01.flac
└── 散图/
    ├── poster-a.jpg
    └── poster-b.jpg
```

这里至少有三种合理的管理单位：`作品乙` 作为一项，`作品丁` 作为一项，两张散图各自作为一项。若对整个根目录统一取第二层目录，前两项会变成 `作者甲/作品乙` 和 `作者甲/系列丙`；系列被误认成作品。若统一按文件扫描，作品乙又会碎成音轨、封面和说明。目录结构相同，资源总数却取决于规则。

这正是 Bakabase 最值得研究的部分。它面向动画、漫画、音声、电影、图集等本地收藏，允许用户决定文件或哪一级目录获得资源身份，再把路径信息、手工值和外部元数据组织成可检索属性。灵活性来自用户自己定义模型，维护成本也由同一处产生。

以下分析固定在 2026 年 10 月 8 日的官方 main 提交 `74f2a1e`（`v2.4.0-beta.513`；当时稳定版为 2.3.0）。本文基于该提交的源码与仓库测试定义，未实际运行应用或测试；运行体验与性能不在结论范围内。

## 资源粒度由路径标记决定

`ResourceDbModel` 是资源持久化记录。源码里可以直接看到 `Id`、可空的 `Path`、`IsFile`、`ParentId` 和 `Status`。一项 Resource 可以指向文件、目录，也可以暂时没有本地路径。它获得了稳定记录身份，却没有自动获得“作品”“系列”或“作者”的业务含义。

资源发现使用 `ResourceMarkConfig`。下面四个字段足以解释开头样本的大部分行为：

```csharp
new ResourceMarkConfig
{
    MatchMode = PathMatchMode.Layer,
    Layer = 2,
    FsTypeFilter = PathFilterFsType.Directory,
    ApplyScope = PathMarkApplyScope.MatchedOnly
};
```

`MatchMode` 选择层级或正则匹配，`Layer` 从标记根路径计算相对深度，`FsTypeFilter` 区分文件与目录，`ApplyScope` 控制效果是否延伸到子目录。配置还包括 `Extensions`、`ExtensionGroupIds` 和 `IsResourceBoundary`。

把这条规则放在 `收藏/`，第二层目录候选就是 `作者甲/作品乙` 与 `作者甲/系列丙`。修正后一条局部规则可以放在 `作者甲/系列丙/`：将它设为资源边界，再取第一层目录，外层规则会绕开这棵子树，局部规则则选出 `作品丁`。散图另用文件规则和 `.jpg` 扩展名过滤。三种管理单位由三条清楚的政策产生，无需重排原目录。

仓库里的 `PathMarkResourceBoundaryTests` 提供了一个更小的真实测试工件。测试建立 `A/x`、`B/y`、`special/z` 三棵目录，外层 `Layer = 2` 的断言期望得到 3 项资源；给 `special` 增加 `IsResourceBoundary = true` 后，断言期望外层规则只留下 2 项。另一条测试又确认，边界自身以及边界内部的规则仍然生效。

`FileSystemResolver.DiscoverFromMarks` 负责执行规则。它先展开扩展名组，再按层级或正则枚举候选，应用资源边界，最后确认文件或目录确实存在。`ResourceSyncService.SyncResources` 随后加载已有资源与 `ResourceSourceLink`，解析候选，按每批 100 项创建或更新记录。资源有增删时，它会重建父子关系；出现新资源路径时，再将相关路径标记置为 Pending。启用 `KeepResourcesOnPathChange` 时，新目录资源还会写入 `bakabase.json` 标记，所以试用原始收藏前要确认挂载权限与这一选项。

按这个设计，样本应得到四项资源：`作品乙`、`作品丁` 和两张散图。为便于继续追踪，下面把 `作品乙` 对应的 Resource 简记为 R-乙；这是示意编号，不是扫描实测输出。音轨、封面和说明仍属于这一个目录资源的文件内容，不各自成为本例的管理项。

资源发现至此只回答“哪些路径应有资源记录”。随后，属性规则给这些资源提取字段，增强器按映射写入外部来源值，来源优先级决定采用哪个值。四步有不同输出：得到 Resource 不代表已有标题，已有标题也不代表完成了联网增强。先核对四项资源及其路径，再讨论封面与标签，才能把后面的字段问题定位到正确对象上。

## 属性值保留来源与选择政策

资源出现以后，路径中的“作者甲”仍是一段字符串。`PropertyMarkConfig` 可以用 `ValueLayer` 从相对层级取目录名，也可以用 `ValueRegex` 捕获文本；固定值走 `FixedValue`。属性规则与资源规则分开，允许同一目录同时回答“什么是一项资源”和“资源有哪些字段”。在样本里，资源规则先将 `作者甲/作品乙/` 识别成 R-乙；接着，属性规则可以把路径中的“作者甲”提取为作者字段，把“作品乙”提取为标题字段。路径切分取决于属性规则自己的根路径与层级配置，不能把前一节资源规则的 `Layer = 2` 原样当成所有字段的位置。

属性同步也保留规则产生过什么效果。`PathMarkSyncService` 收集本轮 Property 与 MediaLibrary effects，结合仍生效的旧 effects 计算最终状态，再应用属性和媒体库成员变化。这给删除或修改规则后的重算留下了依据。配置、规则效果和资源当前值是三组数据，而非一次扫描后混在同一字段里。

外部来源冲突时，`CustomPropertyValueDbModel` 保存的是下面五项：

```text
Id · ResourceId · PropertyId · Value · Scope
```

`PropertyValueScope` 的实际枚举包括 `Manual`、`Synchronization`、`Bangumi`、`DLsite`、`Tmdb`、`Ai`、`Steam` 等。同一标题属性可以同时保存手工值、目录同步值和站点值；刷新某个来源时，其他 Scope 仍有自己的记录。Scope 解决的是来源并存与取舍。逐次修改人、远端响应和转换版本若也要追踪，还需要另一套历史或审计数据。

生效顺序由 `PropertyValueScopeResolver` 处理。资源级 `Priorities` 非空时，就完整接管该属性的来源链；缺少资源级配置时，profile 顺序排在全局顺序之前。每个优先项还有 `FallbackOnEmpty`：设为 `false` 会在该来源为空时停止，设为 `true` 才继续找下一项。解析器把空字符串与空集合视为空值，同时保留数字 `0` 和布尔值 `false` 的业务含义。

沿着 R-乙 继续推演：路径提取先产生 `Synchronization = 作品乙`；用户另写入 `Manual = 作品乙（修订版）`；一次已完成映射的增强又写入 `Bangumi = Work B`。三项记录属于同一个标题属性，Scope 各不相同。将 Bangumi 排在首位，采用值就是 `Work B`；将 Manual 排在首位，采用值变为“作品乙（修订版）”，原始路径与站点值仍可并存。改变来源优先级是在选择现有值，无需重建 R-乙，也不等于重命名目录。

再清空首选来源，结果取决于对应的 `FallbackOnEmpty`。允许回退才继续检查下一来源；禁止回退则在该空值停止。因此“手工标题还在，但卡片显示了站点标题”可以先由来源选择解释，不能直接认定保存失败。试用时应同时核对各 Scope 的记录和最终采用值，才知道刷新改变了数据本身，还是改变了选择结果。

增强器还有独立映射边界。`AbstractEnhancer` 构造来源上下文并生成带类型的原始值，`EnhancerService` 再把 source target 映射到用户属性，按 Scope 写入。来源提供了作者或标签，并不自动决定它应落入哪个自建字段。资源发现、属性规则同步与联网增强是相接的几条路径，排查空标题时也应分别检查。

我更看重这种来源模型，而非支持了多少元数据站点。站点列表会变化，`Value + Scope + preference` 仍是一份可迁移的冲突政策。不过它值得付出的前提是收藏确实存在多来源冲突；若所有条目始终只信一个来源，这套配置的收益会明显变小。

## 索引等待定义“同步完成”的时刻

Bakabase 用 SQLite 保存资源、属性、来源链接、媒体库成员和规则效果，属性搜索另有内存索引。`ResourceSearchIndex` 按 `PropertyPool → PropertyId → NormalizedValue → ResourceId` 组织等值索引，并为数值、日期等范围查询维护有序结构。`ResourceSearchIndexService` 通过一个 `SingleReader = true` 的 Channel 接收增量更新。

更能说明同步完成边界的是 `PathMarkSyncService.SyncMarks` 的调用顺序。去掉进度上报和异常处理，主路径可缩成下面六行：

```text
Collect effects
Compute final state
Apply property and media-library changes
PersistEffects(...)
await ResourceSearchIndexService.WaitForPendingUpdatesAsync(...)
BatchUpdateMarkStatuses(...)
```

也就是说，属性与规则效果写入后，服务先向索引队列插入 barrier，等此前的更新处理完成，再把路径标记更新为已同步。仓库中的 `PathMarkSyncProgressTests` 还把预期进度顺序写成 `80 → 90 → 95 → 100`：持久化 effects、等待索引、更新标记状态、完成。`ResourceSearchIndexIncrementalTests` 则定义了跨合并批次的 barrier 测试，要求等待点覆盖它之前拆出的全部批次。

这段顺序解释了“数据库已经写入”和“筛选结果已经可见”之间的差别，也给同步状态一个可检查的含义。它覆盖的是属性与媒体库同步到内存索引的这条队列顺序；文件系统、SQLite 与索引仍各自拥有状态。搜索实现还把“索引返回空集合”与“索引不可用返回 null”分开，后者才走旧数据库查询路径。

把这条顺序放回 R-乙：修改作者提取规则后，先得到新的规则 effect，再把作者字段变化写入持久记录，索引更新随后进入队列。等待点的作用，是让“此轮标记已同步”的信号排在此前索引更新之后。此前的标题来源选择仍是另一件事；索引追上写入，并不替用户决定该信哪一个标题。

这也给排错提供了顺序。若样本不是预期的四项，先检查路径、资源边界和局部规则，暂不动来源优先级。若资源数及路径正确，但 R-乙 的标题不符，先查该属性各 Scope 的值、增强映射及优先链。若作者的持久值已经更新，按同一属性筛选却还落在旧结果上，再看路径标记是否仍在同步、索引等待是否完成，并核对查询条件；内存索引返回空集合本身不会触发数据库回退。三种现象分别指向对象身份、字段选择和派生查询状态，重新全量扫描未必能解决后两种问题。

## 四种工具的条件化推荐

Playnite、Hydrus、Stash 和 Bakabase 都能碰到文件、封面和标签，但它们替用户预先决定的事情不同。下面的表用选择条件代替功能数量：

| 收藏的主要问题 | 直接推荐 | 推荐理由与接受的约束 |
|---|---|---|
| 聚合 Steam、GOG、独立游戏与模拟器 ROM，并负责启动 | Playnite | `Game` 模型已有平台、安装状态、启动动作、游玩时间与库来源；接受 Windows 桌面/全屏启动器作为中心 |
| 大量独立图片或短视频，需要哈希身份、精确查重、标签和相似关系 | Hydrus | 文件导入内部存储，以哈希和文件级服务组织；接受原目录与多文件作品结构退居次要位置 |
| 视频与图片需要 Scene、Image、Gallery、人物、工作室、标签和集合关系 | Stash | 领域实体和 Go/GraphQL 服务已经给出浏览模型；接受它围绕视频与图片的既定词汇 |
| 收藏混合了目录作品、单文件和多种来源，现有目录约定要保留 | Bakabase | 用户可以配置资源边界、属性提取和来源政策；接受规则设计、例外处理与长期维护 |

比较快照分别是 Playnite 10.62、Hydrus v689、Stash v0.31.1（架构核对也参考同期 develop）与 Bakabase 2.4 beta。它们适合解决的对象不同，因此这张表用于选模型，不用于推导速度、容量或元数据质量。

我的推荐很明确：游戏收藏直接从 Playnite 开始；以单文件归档和查重为中心时选 Hydrus；视频图片关系库优先试 Stash。Bakabase 排在这些专门工具之后，适用于至少两种资源粒度共存、目录关系需要保留、来源冲突需要按字段治理的收藏。仅仅因为“以后也许会混放”，还不足以提前承担通用建模成本。

版本和部署也会改变试用边界。2.4 beta 的源码机制不应反推成 2.3.0 的稳定承诺。官方 Docker 文档描述的是 `linux/amd64` headless 服务与浏览器界面，Linux 桌面仍是另一条产品线；服务需要持久化数据卷并使用容器内媒体路径。默认远程访问模式适合可信网络，公网暴露端口需要另行收紧。完整 Organizer 仍在设计文档中标为 Pending，实现进度表为空；现有安全移动代码拥有日志、暂存复制、长度或哈希校验以及符号链接拒绝策略，范围比完整自动整理方案小。

## 用样本表决定是否扩大范围

首次试用先写预期资源数，并把验证限制在复制出来的样本：只读挂载用于发现与查询，改名和移动留在可写副本。下面这张表是本次基于源码拟定、尚未运行的验收单：

| 样本或操作 | 预期结果 | 失败时优先检查 |
|---|---|---|
| `作者甲/作品乙/` 含音轨、封面、说明 | 1 个目录 Resource，路径指向 `作品乙` | 根路径、`Layer`、`FsTypeFilter` |
| `作者甲/系列丙/作品丁/` 比常规结构多一层 | 1 个 Resource 指向 `作品丁`；外层规则绕开 `系列丙` 子树 | `IsResourceBoundary` 与局部规则根路径 |
| `散图/` 下两张 JPG | 2 个文件 Resource，作品目录规则保持原结果 | 文件规则、扩展名与 extension group |
| 标题同时写入 Manual 与 Bangumi | 两个 Scope 值共存；显示值随优先顺序切换 | 资源级 preference、profile/global 顺序 |
| 清空首选标题，再写入评分 `0` 和开关 `false` | 标题按 `FallbackOnEmpty` 决定是否回退；`0`、`false` 保留 | 空值策略与属性类型 |
| 修改作者提取规则后重新同步 | 标记最终为 Synced，按新作者筛选能命中预期资源 | effect 重算、索引 barrier、搜索回退状态 |
| 在可写副本移动 `作品乙` | 身份、父子关系及 `bakabase.json` 行为符合选项，残留可解释 | `KeepResourcesOnPathChange`、来源链接、操作日志 |

先确认 R-乙 没有被拆成音轨与封面、`作品丁` 没有被系列目录吞掉，再确认来源切换和作者筛选都符合规则；这些通过后才考虑可写移动，全部通过后再扩大目录。Bakabase 的采用门槛就落在这里：是否愿意持续维护这组资源边界、来源取舍与同步观察。收藏确实混合、目录关系有保留价值、多来源冲突又值得治理时，这份维护工作才有对应收益。
