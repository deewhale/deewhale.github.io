---
layout: default
title: 主题索引
permalink: /topics/
description: 按主题浏览 Pepper 的 AI 编程、软件工程、系统架构与开源项目文章。
---

<article class="page prose">

# 主题索引

按文章标签浏览已有内容。每个主题下的链接都指向完整文章，不生成重复正文。

<div class="topic-index">
{% assign sorted_tags = site.tags | sort %}
{% for tag in sorted_tags %}
  <section class="topic-group" id="topic-{{ forloop.index }}">
    <h2>{{ tag[0] }} <span class="topic-count">{{ tag[1] | size }}</span></h2>
    <ul>
      {% for post in tag[1] %}
        <li><a href="{{ post.url | relative_url }}">{{ post.title }}</a></li>
      {% endfor %}
    </ul>
  </section>
{% endfor %}
</div>

</article>
