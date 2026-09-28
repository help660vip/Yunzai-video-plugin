# 自定义渲染主题

主题为本地 HTML、CSS 和静态资源，无需额外服务。默认卡片支持日夜切换、评论、引用、投票、音乐与有序图文。

在 `data/themes/my-theme/` 新建 `theme.json`：

```json
{"schema_version":1,"id":"my-theme","name":"我的主题","version":"1.0.0"}
```

同目录添加 `default.html` 和可选的 `style.css`，随后在锅巴中将 `parser_render_theme` 改为 `my-theme`。配置立即生效。`parser_theme_dirs` 可追加主题目录或主题集合目录；相对路径以插件的 `config/` 为基准。主题也可直接放在默认的 `data/themes/` 下，无需追加目录配置。

## 模板选择

按平台同名文件（如 `bilibili.html`、`twitter.html`）、音乐平台的 `music.html`、`default.html` 的顺序选择。缺少模板时使用内置卡片；损坏的主题或渲染失败不会阻断解析，自动回退内置卡片或文字结果。

```html
<!doctype html>
<html>
<head><meta charset="utf-8"></head>
<body>
  <main style="width:752px;padding:24px;background:white;color:#20242a">
    <h1>{{post.title}}</h1>
    {{#if post.author}}<p>{{post.author.name}} · {{post.author.location}}</p>{{/if}}
    {{#each post.content}}
      {{#if this.text}}<p>{{this.text}}</p>{{/if}}
      {{#if this.src}}<img src="{{this.src}}" style="max-width:100%">{{/if}}
    {{/each}}
  </main>
</body>
</html>
```

卡片根节点使用 `main`，建议宽度 752 CSS 像素。支持 `{{字段路径}}`、`{{#if 字段}}…{{else}}…{{/if}}`、`{{#unless 字段}}…{{/unless}}`、`{{#each 列表}}…{{/each}}`，循环内通过 `this` 和 `@index` 访问当前项及索引。条件可使用严格类型的 `==`、`!=` 比较，例如 `{{#if this.type == "video"}}`。模板不执行函数或 JavaScript，所有字段插值自动转义 HTML。

## 数据接口

根数据可通过 `data` 前缀或直接字段访问，例如 `data.post.title` 与 `post.title` 等价。

| 字段 | 内容 |
| --- | --- |
| `schema_version` | 数据版本，当前为 `1` |
| `theme` / `theme_id` | `light` 或 `dark` / 所选主题 ID |
| `post` | 标题、来源、作者、有序内容、统计、评论、引用原帖 |
| `meta` | 机器人名称、渲染时间、建议宽度 |

`post` 包含 `title`、`url`、`timestamp`、`formatted_datetime`、`platform`、`author`、`content`、`stats`、`comments`、`qrcode`、`ai_summary`、`embed_url`、`extra`、`repost`。作者包含 `name`、`id`、`description`、`location`、`avatar`。评论拥有相同的作者、内容和统计结构，以及 `replies`、`parent_author`。

`content` 类型包括 `text`、`image`、`graphic`、`cover`、`sticker`、`live_photo`、`video`、`audio`、`link`、`quote`、`poll`。图片使用 `src`；媒体提供 `duration`、`size`；链接提供 `title`、`description`、`url`、`icon`、`preview`；投票包含 `options` 及其 `text`、`votes`、`percentage`。`layout` 可为 `grid` 或 `x`。渲染上下文不会为了计算体积提前下载音视频。

统计的额外项目为 `stats.extra` 数组，每项包含 `key`、`label`、`value`。标准统计字段为 `view_count`、`like_count`、`comment_count`、`collect_count`、`share_count`。

## 安全与兼容

主题只能读取自身目录内的静态资源，拒绝路径越界和越界符号链接。浏览器脚本和外部网络请求禁用，模板中的数据不能通过主题请求发送到外部服务器。样式文件、主题模板与主题配置在下次渲染时重新读取。

卡片以 2 倍清晰度分段截图后在本地拼接，限制为 3,200 万像素及 24,000 CSS 像素高度，超限转为文字结果。具备 FFmpeg 时输出 WebP，否则保留 PNG；超过 5 MiB 的卡片按文件发送。没有浏览器时仍可自动解析与发送文字、媒体。

`default`、`common`、`htmlrender`、`htmlkit` 旧渲染配置继续接受；自定义主题仅作用于卡片渲染。`parser_summary_in_forward` 可将卡片作为合并消息首节点，`parser_video_in_forward` 可将视频一并转发。仅遇到明确的媒体上传故障时，先省略视频，再按需降为保留内容和来源的文字消息。
