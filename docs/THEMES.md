# 自定义渲染主题

主题为本地 HTML、CSS 和静态资源，无需额外服务。默认卡片支持日夜切换、评论、引用、投票与有序图文。音乐平台使用独立的唱片卡片，显示专辑封面、歌曲信息、静态进度条、时长、倍速和最多六行歌词。

在 `data/themes/my-theme/` 新建 `theme.json`：

```json
{"schema_version":1,"id":"my-theme","name":"我的主题","version":"1.0.0"}
```

同目录添加 `default.html` 和可选的 `style.css`，随后在锅巴中将 `parser_render_theme` 改为 `my-theme`。配置立即生效。`parser_theme_dirs` 可追加主题目录或主题集合目录；相对路径以插件的 `config/` 为基准。主题也可直接放在默认的 `data/themes/` 下，无需追加目录配置。

启动时会预热主题发现和内置图标。后续渲染复用发现结果，同时检查主题目录与清单变更；新增、移除或修改主题后会自动刷新。模板和样式仍在每次渲染时读取。清单可附加 `desc`、`author` 等描述字段。

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

`content` 类型包括 `text`、`image`、`graphic`、`cover`、`sticker`、`live_photo`、`video`、`audio`、`link`、`quote`、`poll`。图片使用 `src`，并在可识别时提供 `width`、`height`、`aspect_ratio` 与 `orientation`。尺寸已经过 EXIF 旋转校正；`orientation` 在高宽比 ≥ 0.9 时为 `portrait`，否则为 `landscape`，`aspect_ratio` 为宽除以高。读取失败时使用占位图，并省略尺寸字段。

媒体提供 `duration`、`size` 与 `speedup`；`duration` 是处理后时长，`speedup` 为 `1.25x` 等标签，原速为 `null`。链接提供 `title`、`description`、`url`、`icon`、`preview`；投票包含 `options` 及其 `text`、`votes`、`percentage`、`image` 和总票数、结束时间等信息。`layout` 可为 `grid` 或 `x`。渲染上下文不会为了计算体积提前下载音视频。

所有主题自动注入内置图标样式，可使用 `<i class="fa-icon fa-music"></i>` 和 `<i class="fa-icon fa-play"></i>`。图标不依赖远端字体或脚本。

统计的额外项目为 `stats.extra` 数组，每项包含 `key`、`label`、`value`。标准统计字段为 `view_count`、`like_count`、`comment_count`、`collect_count`、`share_count`。

## 安全与兼容

主题只能读取自身目录内的静态资源，拒绝路径越界和越界符号链接。浏览器脚本和外部网络请求禁用，模板中的数据不能通过主题请求发送到外部服务器。样式文件、主题模板与主题配置在下次渲染时重新读取。

卡片由宿主可用浏览器或独立浏览器以 2 倍清晰度分段绘制后在本地拼接；CSS 模糊、图层和遮罩由同一页面统一布局，可避免分段接缝。限制为 3,200 万像素及 24,000 CSS 像素高度，超限转为文字结果。该实现使用 JavaScript，无需 Python 或 Rust 运行环境。

`parser_render_format` 可选 `jpeg`、`png`、`webp`，默认使用 JPEG。WebP 在任一边超过 16,383 实际像素时自动改用 JPEG，编码不可用则保留 PNG。卡片始终以图片消息发送，体积超过 5 MiB 也不会转成文件消息。没有可用浏览器时仍可自动解析与发送文字、媒体。

渲染结果按主题、内容、输出格式等指纹持久缓存。同一张卡片的并发请求合并为一次绘制；修改 HTML、CSS 或主题版本会产生新缓存，卡片与其他媒体遵循相同的缓存保留和容量配置。

`default`、`common`、`htmlrender`、`htmlkit` 旧渲染配置继续接受；自定义主题仅作用于卡片渲染。`parser_summary_in_forward` 可将卡片作为合并消息首节点，`parser_video_in_forward` 可将视频一并转发。仅遇到明确的媒体上传故障时，先省略视频，再按需降为保留内容和来源的文字消息。
