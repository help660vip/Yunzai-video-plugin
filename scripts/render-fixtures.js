import fs from "node:fs"
import path from "node:path"

import { config } from "../lib/core/config.js"
import {
  Author,
  Comment,
  GraphicContent,
  ImageContent,
  LinkContent,
  LivePhotoContent,
  ParseResult,
  PathTask,
  PollContent,
  QuoteContent,
  Stats,
  StickerContent,
} from "../lib/core/model.js"
import { resourcesDir } from "../lib/core/paths.js"
import { closeRenderer, renderAndSend } from "../lib/render/renderer.js"

const screenshotDir = path.resolve("docs", "screenshots")
const avatar = path.join(resourcesDir, "avatar.png")
const cover = path.join(resourcesDir, "fallback_pic", "3.jpg")
const second = path.join(resourcesDir, "fallback_pic", "6.jpg")
const task = value => new PathTask(async () => value, "fixture:" + path.basename(value))

function fixtureResult() {
  const author = new Author("Yunzai 视频解析", {
    avatar: task(avatar),
    description: "固定响应渲染夹具 · 32 平台统一内容模型",
  })
  const replyAuthor = new Author("示例用户", { avatar: task(avatar) })
  return new ParseResult({
    platform: { name: "bilibili", displayName: "哔哩哔哩" },
    author,
    title: "Yunzai Video Plugin 3.0",
    text: "有序富文本、统计、评论、投票、引用和 Live Photo 可以在同一张卡片中自然展示。",
    timestamp: 1786723200,
    url: "https://github.com/help660vip/Yunzai-video-plugin",
    stats: new Stats({
      viewCount: "12.8万",
      likeCount: "8600",
      commentCount: "328",
      collectCount: "1400",
      shareCount: "526",
    }),
    contents: [
      new ImageContent(task(cover), { alt: "封面" }),
      new LivePhotoContent(task("fixture.mp4"), {
        baseImage: task(second),
        livePath: task("fixture-live.mp4"),
      }),
    ],
    content: [
      "正文会严格保留平台返回的内容顺序。",
      new GraphicContent(task(cover), { alt: "富文本配图" }),
      new StickerContent(task(avatar), { size: "small", description: "贴纸" }),
      new LinkContent({
        url: "https://github.com/help660vip/Yunzai-video-plugin",
        title: "项目主页",
        siteName: "GitHub",
        description: "Miao-Yunzai / TRSS-Yunzai 视频解析插件",
        preview: task(second),
      }),
      new QuoteContent({
        title: "引用内容",
        text: "引用与转发会递归参与海外平台 R18 安全检查。",
      }),
      new PollContent({
        title: "你更常用哪种发送方式？",
        options: [
          { text: "链接即解析并下载", votes: 86 },
          { text: "手动懒下载", votes: 14 },
        ],
        totalVoters: 100,
      }),
    ],
    comments: [
      new Comment({
        author: replyAuthor,
        content: ["评论与楼中楼也能保持原有顺序。"],
        timestamp: 1786726800,
        stats: new Stats({ likeCount: 24 }),
        replies: [
          new Comment({
            author,
            parentAuthor: replyAuthor,
            content: ["默认仍然是发链接后直接下载媒体。"],
            timestamp: 1786726860,
          }),
        ],
      }),
    ],
    aiSummary: "统一的 ParseResult 可在没有浏览器时自动降级为纯文本。",
    extra: { info: "固定夹具 · 不包含线上 Cookie 或 Token" },
  })
}

async function render(name, dayRange) {
  config.parser_render_type = "common"
  config.parser_day_range = dayRange
  config.parser_append_qrcode = true
  const result = fixtureResult()
  await renderAndSend(
    { reply: async () => {} },
    result,
    { sendContents: false },
  )
  await fs.promises.copyFile(result.renderImage, path.join(screenshotDir, name))
}

await fs.promises.mkdir(screenshotDir, { recursive: true })
try {
  await render("render-light.png", ["0:00", "24:00"])
  await render("render-dark.png", ["0:00", "0:00"])
} finally {
  await closeRenderer()
}
