<div align="center">

# Yunzai Video Parser

面向 Miao-Yunzai / TRSS-Yunzai 的多平台链接与分享卡片解析插件

![Node.js](https://img.shields.io/badge/Node.js-%3E%3D16.14-339933?logo=node.js&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-ESM-F7DF1E?logo=javascript&logoColor=black)
![Miao-Yunzai](https://img.shields.io/badge/Miao--Yunzai-Supported-00A1D6)
![TRSS-Yunzai](https://img.shields.io/badge/TRSS--Yunzai-Supported-7C3AED)
[![GitHub Stars](https://img.shields.io/github/stars/help660vip/Yunzai-video-plusin?logo=github)](https://github.com/help660vip/Yunzai-video-plusin/stargazers)
[![GitHub Issues](https://img.shields.io/github/issues/help660vip/Yunzai-video-plusin?logo=github)](https://github.com/help660vip/Yunzai-video-plusin/issues)

[项目主页](https://github.com/help660vip/Yunzai-video-plusin)
· [问题反馈](https://github.com/help660vip/Yunzai-video-plusin/issues)
· [版本发布](https://github.com/help660vip/Yunzai-video-plusin/releases)

[快速安装](#安装)
· [使用方法](#使用方法)
· [配置说明](#配置)
· [常见问题](#常见问题)
· [参与开发](#开发)

</div>

> [!NOTE]
> 本项目是 `nonebot-plugin-parser 2.6.7` 的原生 JavaScript 迁移版，仅适用于
> Miao-Yunzai 与 TRSS-Yunzai。插件不会启动 Python 子进程。

## 功能特点

- 支持 B站、抖音、快手、微博、小红书、YouTube、TikTok、X、AcFun、NGA。
- 自动识别普通文本和 QQ JSON 分享卡片中的链接。
- 支持视频、音频、图片、图文及合并转发。
- 提供文本与 Puppeteer 信息卡两类渲染方式，渲染失败时自动降级。
- 支持群聊黑名单 / 白名单模式以及管理员命令开关。
- 支持 B站扫码登录、Cookie 登录及音频提取。
- 自动缓存解析结果和媒体文件，每天定时清理。
- 提供公共 API，可由其他 Yunzai 插件注册自定义解析器。

## 支持平台

| 平台 | 支持的常见链接 | 额外要求 |
| --- | --- | --- |
| B站 | BV/AV、短链、动态、Opus、直播、收藏夹、专栏 | 合并 DASH 音视频需要 FFmpeg |
| 抖音 | 短链、`video`、`note`、`slides` | — |
| 快手 | 短链、作品页、陈总科技分享页 | — |
| 微博 | 博文、TV、视频、分享页、长文章 | — |
| 小红书 | 短链、`explore`、`discovery` | 部分内容需要 Cookie |
| YouTube | `watch`、`shorts`、`youtu.be` | 需要 `yt-dlp` |
| TikTok | `www`、`vt`、`vm` | 需要 `yt-dlp` |
| X / Twitter | `x.com/.../status/...` | 依赖第三方解析接口 |
| AcFun | `/ac数字`、`ac=数字` | — |
| NGA | 带有 `tid=数字` 的主题链接 | — |

> [!TIP]
> YouTube 和 TikTok 解析器只会在启动时检测到 `yt-dlp` 后注册。未安装
> `yt-dlp` 不影响其他平台使用。

## 环境要求

| 项目 | 要求 | 用途 |
| --- | --- | --- |
| Yunzai | Miao-Yunzai 或 TRSS-Yunzai | 插件运行环境 |
| Node.js | `>= 16.14` | JavaScript 运行环境 |
| Chrome / Chromium | 推荐安装 | `common`、`htmlrender` 信息卡渲染 |
| Puppeteer | 通常由 Yunzai 提供 | 驱动浏览器渲染信息卡 |
| FFmpeg | 推荐安装并加入 `PATH` | B站 DASH 合并、GIF、封面与转码 |
| yt-dlp | 可选，需加入 `PATH` | YouTube、TikTok 和 `ym` 命令 |

## 安装

### 1. 放置插件

下载或克隆本仓库到 Yunzai 的 `plugins` 目录，并确保目录结构如下：

```text
Yunzai/
└─ plugins/
   └─ yunzai-video-plusin/
      ├─ index.js
      ├─ package.json
      ├─ config/
      ├─ lib/
      └─ resources/
```

在 Yunzai 根目录执行：

```bash
git clone --depth=1 https://github.com/help660vip/Yunzai-video-plusin.git ./plugins/yunzai-video-plusin
```

无法使用 Git 时，也可以在[项目主页](https://github.com/help660vip/Yunzai-video-plusin)
点击 **Code → Download ZIP**，下载后解压为 `plugins/yunzai-video-plusin`。

### 2. 安装依赖

进入插件目录安装 Node.js 依赖：

```bash
cd Yunzai/plugins/yunzai-video-plusin
pnpm install
```

如需完整的音视频解析能力，请确认外部程序可被 Yunzai 进程访问：

```bash
ffmpeg -version
yt-dlp --version
```

### 3. 重启 Yunzai

重启后，日志中会输出当前启用的平台。若未检测到 FFmpeg 或 `yt-dlp`，插件也会给出
对应提示。

## 使用方法

安装完成后，直接向机器人发送受支持的链接或 QQ 分享卡片即可触发解析。

### 命令

| 命令 | 权限与范围 | 说明 |
| --- | --- | --- |
| `@机器人 开启解析` | 主人 / 群主 / 管理员，群聊 | 在当前名单模式下开启本群解析 |
| `@机器人 关闭解析` | 主人 / 群主 / 管理员，群聊 | 在当前名单模式下关闭本群解析 |
| `bm BV号 [分P]` | 所有用户 | 提取 B站音频并发送为语音 |
| `ym YouTube链接` | 所有用户，需要 `yt-dlp` | 提取 YouTube 音频并发送为语音 |
| `blogin` | 仅主人私聊 | 扫码登录 B站并保存凭据 |

示例：

```text
bm BV1xx411c7mD
bm BV1xx411c7mD 2
ym https://youtu.be/example
```

### 群聊开关逻辑

- `parser_group_blacklist_enabled: true`：黑名单模式，默认所有群开启，名单内的群关闭。
- `parser_group_blacklist_enabled: false`：白名单模式，默认所有群关闭，名单内的群开启。
- 群开关保存在 `data/group_set.json`，切换模式后名单含义会随之改变。

## 配置

配置文件位于 [`config/config.yaml`](config/config.yaml)。修改后请重启 Yunzai。

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `parser_bili_ck` | `null` | B站 Cookie；也可留空后使用 `blogin` 扫码登录 |
| `parser_ytb_ck` | `null` | YouTube 浏览器 Cookie 字符串 |
| `parser_xhs_ck` | `null` | 小红书 Cookie |
| `parser_proxy` | `null` | 仅供 YouTube / TikTok 的 `yt-dlp` 使用的代理 |
| `parser_need_upload` | `false` | 音频命令发送语音后是否再上传文件 |
| `parser_use_base64` | `false` | 是否将图片、音频、视频、文件转为 Base64 消息段 |
| `parser_max_size` | `90` | 普通媒体流最大下载大小，单位 MB |
| `parser_duration_maximum` | `480` | 最大媒体时长，单位秒 |
| `parser_append_url` | `false` | 是否在解析结果中附加来源链接 |
| `parser_disabled_platforms` | `[]` | 全局禁用的平台标识列表 |
| `parser_bili_video_codes` | `[avc, av01, hev]` | B站视频编码选择顺序 |
| `parser_bili_video_quality` | `80` | B站清晰度代码 |
| `parser_render_type` | `common` | 解析信息的渲染方式 |
| `parser_custom_font` | `null` | 自定义字体文件名，字体放入 `config/` |
| `parser_custom_font_weight` | `700` | 用户名与标题的字体粗细 |
| `parser_need_forward_contents` | `true` | 图片和图文内容是否使用合并转发 |
| `parser_emoji_cdn` | `https://emojicdn.elk.sh` | 信息卡 Emoji 图片 CDN |
| `parser_emoji_style` | `facebook` | Emoji 样式 |
| `parser_group_blacklist_enabled` | `true` | `true` 为群黑名单模式，`false` 为群白名单模式 |

### 常用配置示例

```yaml
# 在解析信息中附带原链接
parser_append_url: true

# 禁用指定平台
parser_disabled_platforms:
  - twitter
  - nga

# 限制为 60 MB、5 分钟
parser_max_size: 60
parser_duration_maximum: 300

# 不使用 Puppeteer，改为纯文本信息
parser_render_type: default
```

`parser_disabled_platforms` 可填写：

```text
acfun
bilibili
douyin
kuaishou
nga
tiktok
twitter
weibo
xiaohongshu
youtube
```

B站清晰度可选 `16`、`32`、`64`、`80`、`112`、`116`、`120`；编码可选
`avc`、`av01`、`hev`。`parser_emoji_style` 可选 `apple`、`google`、`twitter`、
`facebook`。

### 渲染方式

| 值 | 说明 |
| --- | --- |
| `default` | 纯文本与普通消息段，不依赖 Puppeteer |
| `common` | Puppeteer 通用信息卡 |
| `htmlrender` | Puppeteer 渐变样式信息卡 |
| `htmlkit` | 暂未实现，会自动回退到 `common` |

当 Puppeteer 或浏览器不可用时，`common` 和 `htmlrender` 会自动回退到 `default`。

## Cookie 与数据安全

> [!WARNING]
> Cookie 具有账号权限，并会以明文保存在本机。请勿截图分享、提交到 GitHub 或发送到
> 不可信的第三方。发布代码前务必再次检查 `config/config.yaml` 中没有真实 Cookie。

- B站配置 Cookie、扫码凭据和刷新后的 Cookie 保存在 `data/bilibili_cookies.json`。
- YouTube Cookie 会转换为 `config/ytb_cookies.txt`，供 `yt-dlp` 使用。
- 群开关保存在 `data/group_set.json`。
- 下载媒体与渲染图片保存在 `data/cache/`。
- `data/` 已被 `.gitignore` 忽略；`config/config.yaml` 未被忽略，请特别注意其中的隐私信息。

插件每天 `01:00` 自动清理媒体文件、渲染卡片和内存中的解析结果缓存。

## 更新

进入插件目录拉取代码并重新安装依赖：

```bash
cd Yunzai/plugins/yunzai-video-plusin
git pull
pnpm install
```

完成后重启 Yunzai。

## 常见问题

<details>
<summary><strong>YouTube、TikTok 或 ym 命令没有反应</strong></summary>

这些功能依赖 `yt-dlp`。请先执行 `yt-dlp --version`，并确认运行 Yunzai 的用户能够在
`PATH` 中找到它，然后重启 Yunzai。

</details>

<details>
<summary><strong>B站视频只有画面或无法合并</strong></summary>

B站高画质通常使用分离的 DASH 音视频流，需要 FFmpeg 合并。请执行
`ffmpeg -version` 检查安装状态，并在修复环境变量后重启 Yunzai。

</details>

<details>
<summary><strong>信息卡渲染失败</strong></summary>

确认 Yunzai 已安装 Puppeteer，并且系统存在可用的 Chrome / Chromium。也可以将
`parser_render_type` 改为 `default`，直接使用纯文本渲染。

</details>

<details>
<summary><strong>某个平台突然无法解析</strong></summary>

平台网页结构、接口、风控或 Cookie 状态可能发生变化。请先更新插件，检查运行日志，
必要时重新配置 Cookie；反馈问题时请附上已脱敏的日志和示例链接。

</details>

<details>
<summary><strong>其他 TRSS 适配器发送效果不一致</strong></summary>

QQ / ICQQ / OneBot 场景支持视频、语音、文件和合并转发。其他适配器缺少相关能力时，
插件会尽量退化为通用消息段，实际展示效果取决于适配器。

</details>

## 自定义解析器

其他 Yunzai 插件可以从 `lib/public.js` 导入扩展接口：

```js
import {
  BaseParser,
  registerParser,
} from "../yunzai-video-plusin/lib/public.js"

class ExampleParser extends BaseParser {
  static platform = {
    name: "example",
    displayName: "示例",
  }

  static handlers = [
    {
      keyword: "example.com",
      pattern: /example\.com\/video\/(?<id>\w+)/,
      method: "parse",
    },
  ]

  async parse(match) {
    return this.result({
      title: match.groups.id,
      author: this.createAuthor("示例作者"),
      contents: [
        this.createVideo("https://example.com/video.mp4"),
      ],
    })
  }
}

registerParser(ExampleParser)
```

公共导出还包括解析结果模型、媒体模型、下载器、配置及错误类型，详见
[`lib/public.js`](lib/public.js)。

## 开发

```bash
pnpm install
pnpm run check
pnpm test
```

主要目录：

```text
.
├─ index.js          # Yunzai 插件入口、命令与定时任务
├─ config/           # 用户配置
├─ lib/core/         # 配置、缓存、下载、消息与发送适配
├─ lib/parsers/      # 各平台解析器
├─ lib/render/       # 文本与 Puppeteer 信息卡渲染
├─ resources/        # 字体、平台图标和兜底图片
├─ scripts/          # 开发检查脚本
└─ tests/            # 自动化测试与固定响应夹具
```

遇到问题可前往
[GitHub Issues](https://github.com/help660vip/Yunzai-video-plusin/issues) 反馈，并建议同时提供：

- Miao-Yunzai / TRSS-Yunzai 版本与适配器类型；
- Node.js、FFmpeg、`yt-dlp` 版本；
- 触发问题的链接类型；
- 已移除 Cookie、Token、QQ 号等敏感内容的完整日志。

## 使用须知

本项目仅供学习、研究与个人使用。使用者应遵守所在地法律法规、内容平台服务协议及
著作权规则，并自行确认对相关内容拥有下载、处理和传播权限。本项目与文中提及的平台
没有隶属、授权或合作关系，也不保证第三方接口长期可用。

如果这个项目对你有帮助，欢迎在
[GitHub](https://github.com/help660vip/Yunzai-video-plusin) 点一个 Star。
