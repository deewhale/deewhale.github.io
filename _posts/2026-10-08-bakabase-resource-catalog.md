---
layout: post
title: "Bakabase：从文件扫描到可追溯资源目录"
date: 2026-10-08 14:00:00 +0800
categories: [Software, Open Source]
tags: [Bakabase, Playnite, Hydrus, Stash, 资源管理, 软件架构]
description: "从真实路径规则、属性来源与索引等待顺序理解 Bakabase，并用样本测试判断它与 Playnite、Hydrus、Stash 的适用边界。"
image: /assets/images/posts/bakabase-resource-catalog.jpg
image_alt: "一排带标签的木制卡片目录抽屉"
last_modified_at: 2026-10-10 12:00:00 +0800
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

以下分析固定在 2026 年 10 月 8 日的官方 main 提交 `74f2a1e`，版本标识为 `v2.4.0-beta.513`；当时稳定版是 2.3.0。源码中的类、字段和测试定义已经逐项核对。本机没有 .NET SDK，Docker 客户端也连接不到 OrbStack daemon，官方镜像又以 `linux/amd64` 发布而本机是 arm64，因此这次没有启动应用、镜像或测试。文中的“预期结果”来自代码路径和仓库测试断言，运行体验与性能仍留在实测边界之外。

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

`MatchMode` 选择层级或正则匹配，`Layer` 从标记根路径计算相对深度，`FsTypeFilter` 区分文件与目录，`ApplyScope` 控制效果是否延伸到子目录。配置还包括 `Extensions`、`ExtensionGroupIds` 和 `IsResourceBoundary`。这些名字并非文案抽象，而是提交 `74f2a1e` 中的实际类型与字段。

把这条规则放在 `收藏/`，第二层目录候选就是 `作者甲/作品乙` 与 `作者甲/系列丙`。修正后一条局部规则可以放在 `作者甲/系列丙/`：将它设为资源边界，再取第一层目录，外层规则会绕开这棵子树，局部规则则选出 `作品丁`。散图另用文件规则和 `.jpg` 扩展名过滤。三种管理单位由三条清楚的政策产生，无需重排原目录。

仓库里的 `PathMarkResourceBoundaryTests` 提供了一个更小的真实测试工件。测试建立 `A/x`、`B/y`、`special/z` 三棵目录，外层 `Layer = 2` 的断言期望得到 3 项资源；给 `special` 增加 `IsResourceBoundary = true` 后，断言期望外层规则只留下 2 项。另一条测试又确认，边界自身以及边界内部的规则仍然生效。虽然本轮没有执行这些测试，测试构造、实现分支和预期计数三者是对齐的。

`FileSystemResolver.DiscoverFromMarks` 负责执行规则。它先展开扩展名组，再按层级或正则枚举候选，应用资源边界，最后确认文件或目录确实存在。`ResourceSyncService.SyncResources` 随后加载已有资源与 `ResourceSourceLink`，解析候选，按每批 100 项创建或更新记录。资源有增删时，它会重建父子关系；出现新资源路径时，再将相关路径标记置为 Pending。启用 `KeepResourcesOnPathChange` 时，新目录资源还会写入 `bakabase.json` 标记，所以试用原始收藏前要确认挂载权限与这一选项。

我的第一个判断是：评估 Bakabase 时，应先写下每棵目录预期产生几项 Resource，再讨论封面、标签和增强器。资源单位选错以后，增加字段只是在装饰错误的对象；它修不好作品与系列之间的身份边界。

## 属性值保留来源与选择政策

资源出现以后，路径中的“作者甲”仍是一段字符串。`PropertyMarkConfig` 可以用 `ValueLayer` 从相对层级取目录名，也可以用 `ValueRegex` 捕获文本；固定值走 `FixedValue`。属性规则与资源规则分开，允许同一目录同时回答“什么是一项资源”和“资源有哪些字段”。

属性同步也保留规则产生过什么效果。`PathMarkSyncService` 收集本轮 Property 与 MediaLibrary effects，结合仍生效的旧 effects 计算最终状态，再应用属性和媒体库成员变化。这给删除或修改规则后的重算留下了依据。配置、规则效果和资源当前值是三组数据，而非一次扫描后混在同一字段里。

外部来源冲突时，`CustomPropertyValueDbModel` 保存的是下面五项：

```text
Id · ResourceId · PropertyId · Value · Scope
```

`PropertyValueScope` 的实际枚举包括 `Manual`、`Synchronization`、`Bangumi`、`DLsite`、`Tmdb`、`Ai`、`Steam` 等。同一标题属性可以同时保存手工值、目录同步值和站点值；刷新某个来源时，其他 Scope 仍有自己的记录。Scope 解决的是来源并存与取舍。逐次修改人、远端响应和转换版本若也要追踪，还需要另一套历史或审计数据。

生效顺序由 `PropertyValueScopeResolver` 处理。资源级 `Priorities` 非空时，就完整接管该属性的来源链；缺少资源级配置时，profile 顺序排在全局顺序之前。每个优先项还有 `FallbackOnEmpty`：设为 `false` 会在该来源为空时停止，设为 `true` 才继续找下一项。解析器把空字符串与空集合视为空值，同时保留数字 `0` 和布尔值 `false` 的业务含义。

例如标题有 `Manual = 作品乙` 与 `Bangumi = Work B` 两个值。把 Bangumi 排在前面会显示 `Work B`；调换顺序后显示手工标题；再清空首选来源，结果取决于对应的 `FallbackOnEmpty`。这组测试比“手工修改有没有保存”更有价值，因为它检查的是长期刷新时真正采用哪项数据。

增强器还有独立映射边界。`AbstractEnhancer` 构造来源上下文并生成带类型的原始值，`EnhancerService` 再把 source target 映射到用户属性，按 Scope 写入。来源提供了作者或标签，并不自动决定它应落入哪个自建字段。资源发现、属性规则同步与联网增强是相接的几条路径，排查空标题时也应分别检查。

我更看重这种来源模型，而非支持了多少元数据站点。站点列表会变化，`Value + Scope + preference` 仍是一份可迁移的冲突政策。不过它值得付出的前提是收藏确实存在多来源冲突；若所有条目始终只信一个来源，这套配置的收益会明显变小。

## 索引等待定义“同步完成”的时刻

Bakabase 用 SQLite 保存资源、属性、来源链接、媒体库成员和规则效果，属性搜索另有内存索引。`ResourceSearchIndex` 按 `PropertyPool → PropertyId → NormalizedValue → ResourceId` 组织等值索引，并为数值、日期等范围查询维护有序结构。`ResourceSearchIndexService` 通过一个 `SingleReader = true` 的 Channel 接收增量更新。

真正有价值的发现是 `PathMarkSyncService.SyncMarks` 的调用顺序。把进度上报和异常处理拿掉，主路径可以缩成下面六行：

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

我的第二个工程判断是：如果要借鉴 Bakabase 的设计，优先借鉴 barrier 的位置，而非照抄索引数据结构。索引可以替换，完成信号却必须等派生状态追上持久状态，否则用户会得到一次“同步成功但搜不到”的模糊承诺。

## 四种工具的条件化推荐

Playnite、Hydrus、Stash 和 Bakabase 都能碰到文件、封面和标签，但它们替用户预先决定的事情不同。下面的表用选择条件代替功能数量：

| 收藏的主要问题 | 直接推荐 | 推荐理由与接受的约束 |
|---|---|---|
| 聚合 Steam、GOG、独立游戏与模拟器 ROM，并负责启动 | Playnite | `Game` 模型已有平台、安装状态、启动动作、游玩时间与库来源；接受 Windows 桌面/全屏启动器作为中心 |
| 大量独立图片或短视频，需要哈希身份、精确查重、标签和相似关系 | Hydrus | 文件导入内部存储，以哈希和文件级服务组织；接受原目录与多文件作品结构退居次要位置 |
| 视频与图片需要 Scene、Image、Gallery、人物、工作室、标签和集合关系 | Stash | 领域实体和 Go/GraphQL 服务已经给出浏览模型；接受它围绕视频与图片的既定词汇 |
| 收藏混合了目录作品、单文件和多种来源，现有目录约定要保留 | Bakabase | 用户可以配置资源边界、属性提取和来源政策；接受规则设计、例外处理与长期维护 |

比较快照分别是 Playnite 10.62、Hydrus v689、Stash v0.31.1（架构核对也参考同期 develop）与 Bakabase 2.4 beta。它们适合解决的对象不同，因此这张表用于选模型，不用于推导速度、容量或元数据质量。

我的推荐很明确：游戏收藏直接从 Playnite 开始；以单文件归档和查重为中心时选 Hydrus；视频图片关系库优先试 Stash。Bakabase 排在这些专门工具之后，适用于至少两种资源粒度共存、目录关系需要保留、来源冲突需要按字段治理的收藏。我不赞成为“以后也许会混放”提前承担通用建模成本。

版本和部署也会改变试用边界。2.4 beta 的源码机制不应反推成 2.3.0 的稳定承诺。官方 Docker 文档描述的是 `linux/amd64` headless 服务与浏览器界面，Linux 桌面仍是另一条产品线；服务需要持久化数据卷并使用容器内媒体路径。默认远程访问模式适合可信网络，公网暴露端口需要另行收紧。完整 Organizer 仍在设计文档中标为 Pending，实现进度表为空；现有安全移动代码拥有日志、暂存复制、长度或哈希校验以及符号链接拒绝策略，范围比完整自动整理方案小。

## 用样本表决定是否扩大范围

我会把首次试用限制在复制出来的样本；只读挂载适合验证发现与查询，改名和移动留在可写副本。若时间只够做一件事，先写预期资源数。下面这张表是本次基于源码拟定、尚未运行的验收单：

| 样本或操作 | 预期结果 | 失败时优先检查 |
|---|---|---|
| `作者甲/作品乙/` 含音轨、封面、说明 | 1 个目录 Resource，路径指向 `作品乙` | 根路径、`Layer`、`FsTypeFilter` |
| `作者甲/系列丙/作品丁/` 比常规结构多一层 | 1 个 Resource 指向 `作品丁`；外层规则绕开 `系列丙` 子树 | `IsResourceBoundary` 与局部规则根路径 |
| `散图/` 下两张 JPG | 2 个文件 Resource，作品目录规则保持原结果 | 文件规则、扩展名与 extension group |
| 标题同时写入 Manual 与 Bangumi | 两个 Scope 值共存；显示值随优先顺序切换 | 资源级 preference、profile/global 顺序 |
| 清空首选标题，再写入评分 `0` 和开关 `false` | 标题按 `FallbackOnEmpty` 决定是否回退；`0`、`false` 保留 | 空值策略与属性类型 |
| 修改作者提取规则后重新同步 | 标记最终为 Synced，按新作者筛选能命中预期资源 | effect 重算、索引 barrier、搜索回退状态 |
| 在可写副本移动 `作品乙` | 身份、父子关系及 `bakabase.json` 行为符合选项，残留可解释 | `KeepResourcesOnPathChange`、来源链接、操作日志 |

通过前六项，再考虑可写移动；通过全部项目，再扩大到更多目录。多数收藏只有一种主要对象时，我会停在 Playnite、Hydrus 或 Stash。Bakabase 值得继续投入的条件更窄：资源粒度确实混合，原目录关系有保留价值，多来源取舍又值得长期维护。
