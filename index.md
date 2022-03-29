
<ul>
  {% for post in site.posts | sort: 'date' %}
    <li>
      <a href="{{ post.url }}">{{post.date.year}} {{ post.title }}</a>
    </li>
  {% endfor %}
</ul>