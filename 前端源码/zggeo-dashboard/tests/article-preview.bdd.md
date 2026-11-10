# Article Preview BDD

## Scenario: 查看文章时渲染 Markdown 图片

Given 文章正文包含 Markdown 图片：

```markdown
# Where is the Best Audio Store

正文内容。

![门店封面]
(data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ...)
```

When 用户在文章库点击“查看”

Then 弹窗展示成品预览

And `#` 标题渲染成标题

And `![门店封面](data:image/jpeg;base64,...)` 渲染成图片

And 不展示 base64 原始文本

## Scenario: 编辑文章时保留 Markdown 原文

Given 文章正文包含 Markdown 图片

When 用户在文章库点击“编辑”

Then 编辑弹窗展示 Markdown 原文

And 图片仍保留为 `![alt](src)` 格式，方便继续编辑和保存
