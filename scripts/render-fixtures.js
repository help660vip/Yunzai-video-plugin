import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { PNG } from "pngjs"

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
import { closeRenderer, renderCard } from "../lib/render/renderer.js"

const screenshotDir = path.resolve("docs", "screenshots")
const avatar = path.join(resourcesDir, "preview", "avatar.svg")
const cover = path.join(resourcesDir, "preview", "coast.svg")
const second = path.join(resourcesDir, "preview", "architecture.svg")
const task = value => new PathTask(async () => value, "fixture:" + path.basename(value))

function fixtureResult() {
  const author = new Author("Yunzai 视频解析", {
    avatar: task(avatar),
    description: "让链接里的内容，清晰呈现。",
  })
  const replyAuthor = new Author("示例用户", { avatar: task(avatar) })
  return new ParseResult({
    platform: { name: "bilibili", displayName: "哔哩哔哩" },
    author,
    title: "Yunzai Video Plugin",
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
    aiSummary: "图文、视频与音乐，一条链接即可分享。",
    extra: { info: "内容卡片展示" },
  })
}

async function render(name, dayRange, outputDir) {
  config.parser_render_type = "common"
  config.parser_day_range = dayRange
  config.parser_append_qrcode = true
  const result = fixtureResult()
  const rendered = await renderCard(result, "common", { format: "png" })
  // Validate and encode an actual PNG; the output extension must never depend on FFmpeg.
  const png = PNG.sync.read(await fs.promises.readFile(rendered))
  await fs.promises.writeFile(path.join(outputDir, name), PNG.sync.write(png))
}

export async function renderFixtures(outputDir = screenshotDir) {
  const previous = { ...config }
  await fs.promises.mkdir(outputDir, { recursive: true })
  try {
    await render("render-light.png", ["0:00", "24:00"], outputDir)
    await render("render-dark.png", ["0:00", "0:00"], outputDir)
  } finally {
    Object.assign(config, previous)
    await closeRenderer()
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await renderFixtures()
