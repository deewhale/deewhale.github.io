# Pepper 的小站

基于 Jekyll 和 GitHub Pages 的个人博客，推送到 `main` 后自动发布。

## 写一篇文章

在 `_posts/` 新建 `YYYY-MM-DD-title.md`：

```markdown
---
layout: post
title: "文章标题"
description: "一句话摘要"
tags: [技术, 随笔]
---

正文从这里开始。
```

提交并推送：

```bash
git add .
git commit -m "post: 文章标题"
git push
```

GitHub Actions 会自动构建并发布到 <https://deewhale.github.io>。

## 本地预览（可选）

安装 Jekyll 后运行：

```bash
bundle exec jekyll serve
```

然后访问 <http://localhost:4000>。

