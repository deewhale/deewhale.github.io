---
layout: post
title: "Stacked PR 工作方式：依赖分层、审查反馈与合并"
description: "基于 GitHub gh-stack 的官方分支模型，解释比较基线、级联重排、审批与测试，以及 Coding Agent 怎样提交可审查的增量。"
image: /assets/images/posts/stacked-pr-review-flow-mechanism.png
image_alt: "官方认证层、API 层与前端层依次以相邻父层为比较基线，下层变更后级联重排和复查"
date: 2026-10-20 09:42:16 +0800
display_date: 2026-08-08
categories: [AI, Engineering]
tags: [GitHub, Git, Stacked PR, Code Review]
last_modified_at: 2026-10-29 15:06:25 +0800
---

Stacked PR 是把有依赖的代码变更组织成一条审查链的方法：最底层基于主干，上层基于紧邻的下层，每个 PR 展示自己增加的行为。这样，工程师可以逐层讨论设计，同时保留最终组合的依赖顺序。

它适合一个较大变更具有清楚的前后关系、又能拆出独立审查任务的情况。Git 分支保存代码历史，PR 的 base 决定展示差异，GitHub 的 stack 保存远端依赖关系；`gh-stack` 则帮助维护这些对象之间的对应。理解三者的分工，比增加 PR 数量更重要。

## 先让代码依赖成为审查顺序

GitHub 官方 `gh-stack` README 使用一条具体示意链：`auth-layer → api-endpoints → frontend`。认证层基于 `main`，API 层基于认证层，前端基于 API 层。这是官方对分支模型的解释，不是一项客户项目。

| 分支 | PR 的 base | 审查的新增内容 |
|---|---|---|
| `auth-layer` | `main` | 认证相关改变 |
| `api-endpoints` | `auth-layer` | 建立在认证层之上的 API 改变 |
| `frontend` | `api-endpoints` | 消费已有 API 的前端改变 |

分支向上包含父层历史，审查范围则从父层到本层展开。如果前端 PR 仍以 `main` 为 base，认证和 API 改动就会反复出现，读者难以辨认本层究竟增加了什么。

Git 的三点比较 `git diff A...B` 从双方共同祖先到 B 展示变化。在这条线性链中，`main...frontend` 展示整体，`api-endpoints...frontend` 展示前端增量。设置正确基线的作用，是为审查建立已知前提。

![main 之后认证层、API 层和前端层依次相接，各 PR 以相邻父层为比较基线](/assets/images/posts/stacked-pr-review-flow-mechanism.png)

图中箭头表示代码依赖和比较基线。下层尚未批准时，上层可以先讨论，但它采用的前提仍可能变化。拆分应沿有意义的行为和依赖进行，单纯按文件数或行数切块不会自动获得这种效果。

## 从本地分支建立远端 PR 链

`gh-stack` 是 GitHub CLI 的扩展，要求 `gh` 2.0及以上和 Git 2.36及以上。官方入口可以登记已有分支，也能在缺失时创建分支：

```bash
gh extension install github/gh-stack
gh stack init --base main auth-layer api-endpoints frontend
gh stack view
gh stack submit
```

这组命令采用官方示意名称。执行前应确认仓库、分支顺序和已有提交，因为拼写错误可能创建一个新层。`view` 用于检查本地关系，`submit` 推送分支，为各层创建或更新 PR，再建立远端 stack。

当前实现将本地 stack 元数据保存在 Git common directory，关联 worktree 共享这份关系；每个 worktree 的 HEAD、索引和 Git 重排状态仍各自管理。本地记录不等于远端审批和检查状态，协作时需要同步两者。

`submit` 的原子性也有明确范围：它先原子推送活动分支，再执行 PR 和 stack API 操作。Git 分支推送整体成功，不代表后续所有远端 API 修改已经一起完成。遇到失败，应先检查远端实际状态，再决定重试范围。

## 下层反馈怎样向上传播

认证层发生审查修改以后，API 层仍可能包含旧认证历史，前端又依赖旧 API 历史。更新需要从底向上，让每层保留自己的增量并接到新的父层。

Git 的 `rebase --onto` 为这种移动提供底层表达：给定新基线、旧基线和子分支，将旧边界以后的增量重放到新位置。旧边界必须是重排前的提交身份；分支名会移动，无法在移动后再凭名字恢复原范围。

`gh stack rebase` 自动维护这条级联关系，先读取远端，再按层更新；已合并的父层还涉及新的主干和合并身份，工具会使用对应重放路径。冲突时可以修正并暂存，再通过以下入口继续：

```bash
gh stack rebase
# 解决冲突并 git add 后：
gh stack rebase --continue
```

需要撤回整个重排时，`gh stack rebase --abort` 使用保存的原始引用恢复。这里的恢复针对代码分支操作，不能扩展成撤销已经发生的业务发布。

重排处理的是提交关系。即使Git没有文本冲突，认证规则变化也可能使API层的原假设失效。检查应同时看本层差异是否变化、它依赖的下层行为是否变化，以及最终组合是否满足验收条件。后两项不能由“无冲突”代替。

## 审批保留与组合测试各有依据

GitHub 对未改变差异的重排可以保留已有审批，包括配置了过时审批撤销规则的情况。这减少了纯历史调整造成的重复审查。

保留的事实是：某份差异已被接受。下层行为改变后，层内文本保持相同也可能需要复查。对于官方认证、API、前端这条模型，认证范围变化可能影响API可达性，API返回语义变化又可能影响界面。具体检查来自实际改动，不能从PR自身文件数推断。

因此，更新说明应标出改变了哪项前提，以及哪些上层检查覆盖了它。审查者据此决定重读范围，CI则检查当前提交组合。审批与测试共同服务交付，但分别提供人的判断与程序观察。

`sync` 可以把获取远端、级联重排、推送和PR状态同步串起来；真正分叉的本地/远端stack仍需要选择如何协调。多人或多个Agent工作时，预先分配每层的维护者，比让双方反复改写同一条链更容易保住审查上下文。

## 合并遵循已经建立的依赖

GitHub 的合并规则从最低未合并层开始，可选择连续的一段。不能孤立合并中间层并跳过其尚未落地主干的依赖。底层批准和检查、线性历史以及主干保护规则，都参与最终判断。

合并下层后，剩余层需要接到更新后的主干。Squash等合并方式可能改变提交身份，后续应按真实合并结果更新基线，而非继续假定旧父提交就是主干中的同一对象。

合并队列也需要区分顺序与原子范围。当前CLI README和GitHub Docs对队列分组描述存在差异：可以确认依赖按正确顺序入队、下层被移出会影响上层；不能把代码队列推导为数据库变更和业务发布的原子事务。依赖某个分组行为前，应以目标仓库当时的服务行为和规则为准。

## 给 Agent 的单位是一层可解释的改变

Coding Agent 可以负责一个层次的实现、说明和回归，前提是任务指出它依赖的父层及验收行为。底层更新时，再让各上层根据变化重新检查。这样，Agent生成的代码沿已有审查顺序进入系统。

可以独立合并的改动适合普通并行PR；父接口仍剧烈变化的工作，宜先收敛共同前提。Stack越长，下层变化传播得越远，工具只能降低维护操作的摩擦，无法消除这种依赖成本。

判断是否值得采用，可以落在三个问题上：每层新增行为能否单独解释，父层前提是否明确，变化后能否验证组合。具备这些条件，再交给工具维护分支、base和远端关系，分层审查才有稳定对象。

## 主要资料

- GitHub gh-stack v0.3.0：README、rebase与submit命令实现。
- Git官方手册：git-diff、git-rebase。
- GitHub Docs：Merging stacked pull requests。
- GitHub Changelog：Stacked pull requests generally available。
