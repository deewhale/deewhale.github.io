---
layout: default
title: 主题索引
permalink: /topics/
description: 按主题浏览 Pepper 的 AI 编程、软件工程、系统架构与开源项目文章。
---

<article class="page prose">

# 主题索引

按文章标签浏览已有内容，点击标题即可阅读全文。

专题阅读：[Pi 的会话架构、任务恢复与工具调用](/topics/pi-mcp/)。

<div class="topic-index">
{% assign sorted_tags = site.tags | sort %}
{% for tag in sorted_tags %}
  <section class="topic-group" id="topic-{{ forloop.index }}">
    <h2>{{ tag[0] }} <span class="topic-count">{{ tag[1] | size }}</span></h2>
    <ul>
      {% assign topic_posts = tag[1] %}
      {% include post-order.html posts=topic_posts %}
      {% for post_key in ordered_post_keys %}
        {% assign post_url = post_key | split: '|' | last %}
        {% assign post = site.posts | where: 'url', post_url | first %}
        <li><a href="{{ post.url | relative_url }}">{{ post.title }}</a></li>
      {% endfor %}
    </ul>
  </section>
{% endfor %}
</div>

</article>
