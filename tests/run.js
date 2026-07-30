import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Response } from "node-fetch"

import { LimitedMap } from "../lib/core/cache.js"
import { config } from "../lib/core/config.js"
import { StreamDownloader } from "../lib/core/downloader.js"
import { handleParserEvent } from "../lib/core/engine.js"
import { IgnoreError } from "../lib/core/errors.js"
import { groupKey, groupSet, isEnabled } from "../lib/core/group-filter.js"
import { extractMessageText } from "../lib/core/message.js"
import { ParseResult, PathTask } from "../lib/core/model.js"
import { cacheDir } from "../lib/core/paths.js"
import {
  BaseParser,
  enabledPlatforms,
  getParser,
  matchUrl,
  registerParser,
} from "../lib/core/registry.js"
import { sendFile } from "../lib/core/sender.js"
import { ytdlp } from "../lib/core/ytdlp.js"
import { closeRenderer, renderAndSend } from "../lib/render/renderer.js"
import { AcfunParser, selectAcfunRepresentation } from "../lib/parsers/acfun.js"
import {
  BilibiliParser,
  selectBilibiliPage,
  selectBilibiliStreams,
} from "../lib/parsers/bilibili.js"
import { DouyinParser } from "../lib/parsers/douyin.js"
import { registerBuiltinParsers } from "../lib/parsers/index.js"
import { KuaishouParser } from "../lib/parsers/kuaishou.js"
import { NgaParser } from "../lib/parsers/nga.js"
import { TikTokParser } from "../lib/parsers/tiktok.js"
import { TwitterParser } from "../lib/parsers/twitter.js"
import { midToId, WeiboParser } from "../lib/parsers/weibo.js"
import { selectXhsVideo, XiaohongshuParser } from "../lib/parsers/xiaohongshu.js"
import { YouTubeParser } from "../lib/parsers/youtube.js"
import { http } from "../lib/core/http.js"

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures")
const fixture = name => fs.readFileSync(path.join(fixtureDir, name), "utf8")

const tests = []
const test = (name, fn) => tests.push({ name, fn })

test("PathTask 只执行一次并共享结果", async () => {
  let count = 0
  const task = new PathTask(async () => {
    count += 1
    return "ok"
  })
  assert.deepEqual(await Promise.all([task.get(), task.get()]), ["ok", "ok"])
  assert.equal(count, 1)
})

test("LimitedMap 保持原版先进先出上限", () => {
  const cache = new LimitedMap(2)
  cache.set("a", 1).set("b", 2)
  assert.equal(cache.get("a"), 1)
  cache.set("c", 3)
  assert.equal(cache.has("a"), false)
  assert.equal(cache.has("b"), true)
})

test("QQ JSON 卡片优先提取 detail_1 URL", () => {
  const event = {
    message: [
      {
        type: "json",
        data: {
          raw: JSON.stringify({
            meta: {
              detail_1: { qqdocurl: "https://b23.tv/example" },
              news: { jumpUrl: "https://example.invalid" },
            },
          }),
        },
      },
      { type: "text", text: "ignored" },
    ],
  }
  assert.equal(extractMessageText(event), "https://b23.tv/example")
})

test("QQ JSON 卡片解析失败时不回退普通文本", () => {
  assert.equal(
    extractMessageText({
      message: [
        { type: "json", data: { raw: "{invalid" } },
        { type: "text", text: "BV1xx411c7mD" },
      ],
    }),
    null,
  )
})

test("普通下载严格检查 Content-Length 并写入缓存", async () => {
  const downloader = new StreamDownloader()
  const target = path.join(cacheDir, "fixture-download.bin")
  fs.rmSync(target, { force: true })
  downloader.http.request = async () =>
    new Response("abc", { status: 200, headers: { "content-length": "3" } })
  try {
    assert.equal(
      await downloader.download("https://media.invalid/file", {
        fileName: path.basename(target),
      }),
      target,
    )
    assert.equal(fs.readFileSync(target, "utf8"), "abc")
    fs.rmSync(target, { force: true })
    downloader.http.request = async () =>
      new Response("", { status: 200, headers: { "content-length": "0" } })
    await assert.rejects(
      downloader.download("https://media.invalid/empty", {
        fileName: path.basename(target),
      }),
      IgnoreError,
    )
  } finally {
    fs.rmSync(target, { force: true })
  }
})

test("M3U8 分片按清单顺序拼接且不走普通大小限制", async () => {
  const downloader = new StreamDownloader()
  const target = path.join(cacheDir, "fixture-m3u8.mp4")
  fs.rmSync(target, { force: true })
  let index = 0
  downloader.m3u8Slices = async () => ["https://media.invalid/1", "https://media.invalid/2"]
  downloader.http.request = async () =>
    new Response(index++ === 0 ? "first" : "second", { status: 200 })
  try {
    await downloader.downloadM3u8("https://media.invalid/list.m3u8", {
      fileName: path.basename(target),
    })
    assert.equal(fs.readFileSync(target, "utf8"), "firstsecond")
  } finally {
    fs.rmSync(target, { force: true })
  }
})

test("内置解析器注册并匹配原触发边界", async () => {
  await registerBuiltinParsers()
  assert.ok(enabledPlatforms().includes("哔哩哔哩"))
  assert.ok(enabledPlatforms().includes("NGA"))
  assert.equal(matchUrl("BV1xx411c7mD").parser.platform.name, "bilibili")
  assert.equal(
    matchUrl("https://x.com/example/status/123").parser.platform.name,
    "twitter",
  )
  assert.equal(matchUrl("https://twitter.com/example/status/123"), null)
  assert.equal(matchUrl("https://www.xiaohongshu.com/explore/abc123"), null)
})

test("短链重定向使用匹配结果中的目标方法", async () => {
  const parser = getParser(DouyinParser)
  const originalRedirect = parser.getRedirectUrl
  const originalParseCommon = parser.parseCommon
  let received = null

  parser.getRedirectUrl = async () => "https://www.douyin.com/video/1234567890"
  parser.parseCommon = async (match, route) => {
    received = { id: match.groups.vid, method: route.method }
    return parser.result({ title: "短链解析成功" })
  }

  try {
    const result = await parser.parseWithRedirect("https://v.douyin.com/fixture")
    assert.equal(result.title, "短链解析成功")
    assert.deepEqual(received, { id: "1234567890", method: "parseCommon" })
  } finally {
    parser.getRedirectUrl = originalRedirect
    parser.parseCommon = originalParseCommon
  }
})

test("B站分P越界使用取模", () => {
  const selected = selectBilibiliPage(
    {
      title: "总标题",
      duration: 1,
      pic: "//cover",
      pubdate: 1,
      pages: [
        { part: "P1", duration: 10, first_frame: "//1", ctime: 11, cid: 1 },
        { part: "P2", duration: 20, first_frame: "//2", ctime: 22, cid: 2 },
      ],
    },
    3,
  )
  assert.equal(selected.pageIndex, 0)
  assert.equal(selected.duration, 10)
  assert.match(selected.title, /P1/)
})

test("B站选流遵循清晰度和编码顺序", () => {
  const { video, audio } = selectBilibiliStreams(
    {
      dash: {
        video: [
          { id: 80, codecs: "hev1", baseUrl: "hev" },
          { id: 80, codecs: "avc1", baseUrl: "avc" },
          { id: 120, codecs: "avc1", baseUrl: "4k" },
        ],
        audio: [
          { id: 1, bandwidth: 10, baseUrl: "a1" },
          { id: 2, bandwidth: 20, baseUrl: "a2" },
        ],
      },
    },
    80,
    ["avc", "hev"],
  )
  assert.equal(video.baseUrl, "avc")
  assert.equal(audio.baseUrl, "a2")
})

test("AcFun 清晰度取接口返回的首个受支持项", () => {
  const selected = selectAcfunRepresentation([
    { qualityType: "480p", url: "first" },
    { qualityType: "1080p", url: "second" },
  ])
  assert.equal(selected.url, "first")
})

test("AcFun 页面夹具保留无来源 URL 和首个清晰度行为", async () => {
  const original = http.text
  http.text = async () => fixture("acfun.html")
  try {
    const result = await new AcfunParser().parse({ groups: { acid: "123" } })
    assert.equal(result.title, "AcFun 测试")
    assert.equal(result.url, null)
    assert.equal(result.video.duration, null)
  } finally {
    http.text = original
  }
})

test("快手页面夹具可同时生成视频和图集", async () => {
  const original = http.text
  const parser = new KuaishouParser()
  parser.getRedirectUrl = async () => "https://v.m.chenzhongtech.com/fw/photo/example"
  http.text = async () => fixture("kuaishou.html")
  try {
    const match = KuaishouParser.handlers[0].pattern.exec("v.kuaishou.com/example")
    const result = await parser.parse(match)
    assert.equal(result.videoContents.length, 1)
    assert.equal(result.imageContents.length, 2)
    assert.equal(result.videoContents[0].duration, 2)
    assert.equal(result.url, null)
  } finally {
    http.text = original
  }
})

test("NGA 403 guestJs 重试后只解析首帖", async () => {
  const original = http.request
  let requests = 0
  http.request = async () => {
    requests += 1
    if (requests === 1) {
      return new Response(
        `<script>document.cookie = "guestJs=fixture-cookie; path=/";</script>`,
        { status: 403 },
      )
    }
    return new Response(fixture("nga.html"), { status: 200 })
  }
  try {
    const result = await new NgaParser().parse({ groups: { tid: "42" } })
    assert.equal(requests, 2)
    assert.equal(result.title, "NGA 测试主题")
    assert.equal(result.author.name, "NGA作者")
    assert.equal(result.graphics.filter(item => typeof item !== "string").length, 1)
  } finally {
    http.request = original
  }
})

test("小红书视频流优先 H265", () => {
  const [url, duration] = selectXhsVideo({
    media: {
      stream: {
        h264: [{ masterUrl: "h264", duration: 1000 }],
        h265: [{ masterUrl: "h265", duration: 2000 }],
      },
    },
  })
  assert.equal(url, "h265")
  assert.equal(duration, 2)
})

test("小红书 Explore 异常后无条件回退 Discovery", async () => {
  const originalRequest = http.request
  const originalText = http.text
  http.request = async () => new Response("<html>explore failed</html>", { status: 200 })
  http.text = async () => fixture("xiaohongshu-discovery.html")
  try {
    const result = await new XiaohongshuParser().parseCommon({
      groups: { query: "abc?x=1", xhsId: "abc" },
    })
    assert.equal(result.title, "小红书备用页")
    assert.equal(result.videoContents[0].duration, 2)
    assert.equal(result.timestamp, 1760000000)
    assert.equal(result.url, null)
  } finally {
    http.request = originalRequest
    http.text = originalText
  }
})

test("微博 mid 转 Base62 与原算法一致", () => {
  assert.equal(midToId("5007452630158934"), "O37Sn0Fls")
})

test("微博递归构建转发结果", () => {
  const parser = new WeiboParser()
  const data = {
    user: { id: 1, screen_name: "A", profile_image_url: null },
    text: "正文<br />第二行",
    bid: "abc",
    created_at: "Thu Oct 02 14:39:33 +0800 2025",
    pics: [],
    retweeted_status: {
      user: { id: 2, screen_name: "B", profile_image_url: null },
      text: "原文",
      bid: "def",
      created_at: "Thu Oct 02 14:39:33 +0800 2025",
      pics: [],
    },
  }
  const result = parser.collectStatus(data)
  assert.equal(result.text, "正文\n第二行")
  assert.equal(result.repost.author.name, "B")
})

test("抖音图片与视频同时存在时优先图片", async () => {
  const original = http.request
  const router = {
    loaderData: {
      "video_(id)/page": {
        videoInfoRes: {
          item_list: [
            {
              create_time: 1,
              desc: "测试",
              author: { nickname: "作者", avatar_thumb: { url_list: ["avatar"] } },
              images: [{ url_list: ["image"] }],
              video: {
                play_addr: { url_list: ["video"] },
                cover: { url_list: ["cover"] },
                duration: 1000,
              },
            },
          ],
        },
      },
    },
  }
  http.request = async () =>
    new Response(`<script>window._ROUTER_DATA = ${JSON.stringify(router)}</script>`, {
      status: 200,
    })
  try {
    const result = await new DouyinParser().parseVideoPage("https://example.invalid")
    assert.equal(result.imageContents.length, 1)
    assert.equal(result.video, null)
    assert.equal(result.url, null)
  } finally {
    http.request = original
  }
})

test("X/VxTwitter 构建 GIF 和递归引用", async () => {
  const original = http.json
  http.json = async () => ({
    article: { title: "文章" },
    date_epoch: 1,
    text: "推文",
    user_name: "作者",
    user_profile_image_url: null,
    media_extended: [{ type: "gif", url: "gif.mp4", duration_millis: 2000 }],
    qrt: {
      article: null,
      date_epoch: 2,
      text: "引用",
      user_name: "B",
      user_profile_image_url: null,
      media_extended: [],
    },
  })
  try {
    const match = TwitterParser.handlers[0].pattern.exec("x.com/user/status/123")
    const result = await new TwitterParser().parse(match)
    assert.equal(result.videoContents[0].isGif, true)
    assert.equal(result.repost.text, "引用")
    assert.equal(result.url, null)
  } finally {
    http.json = original
  }
})

test("YouTube 超时长时只保留缩略图", async () => {
  const original = ytdlp.extractInfo
  const previous = config.parser_duration_maximum
  const parser = new YouTubeParser()
  parser.fetchAuthor = async () => parser.createAuthor("频道")
  ytdlp.extractInfo = async () => ({
    title: "长视频",
    channelId: "channel",
    duration: 481,
    timestamp: 1760000000,
    thumbnail: "https://img.example/youtube.jpg",
  })
  config.parser_duration_maximum = 480
  try {
    const result = await parser.parseVideo("https://youtube.com/watch?v=fixture")
    assert.equal(result.video, null)
    assert.equal(result.imageContents.length, 1)
    assert.equal(result.url, null)
  } finally {
    ytdlp.extractInfo = original
    config.parser_duration_maximum = previous
  }
})

test("TikTok 短链重定向后按 yt-dlp 字段构造结果", async () => {
  const original = ytdlp.extractInfo
  const parser = new TikTokParser()
  parser.getRedirectUrl = async () => "https://www.tiktok.com/@fixture/video/1"
  ytdlp.extractInfo = async () => ({
    title: "TikTok 测试",
    channel: "作者",
    duration: 5,
    timestamp: 1760000000,
    thumbnail: "https://img.example/tiktok.jpg",
  })
  try {
    const match = TikTokParser.handlers[0].pattern.exec("vt.tiktok.com/fixture")
    const result = await parser.parse(match)
    assert.equal(result.author.name, "作者")
    assert.equal(result.videoContents[0].duration, 5)
    assert.equal(result.url, null)
  } finally {
    ytdlp.extractInfo = original
  }
})

test("default 渲染输出头、正文和 extra", async () => {
  const previous = config.parser_render_type
  config.parser_render_type = "default"
  const replies = []
  try {
    await renderAndSend(
      { reply: async value => replies.push(value) },
      new ParseResult({
        platform: { name: "test", displayName: "测试" },
        title: "标题",
        text: "正文",
        extra: { info: "附加" },
      }),
    )
    assert.equal(replies.length, 1)
    assert.match(replies[0].join(""), /测试/)
    assert.match(replies[0].join(""), /附加/)
  } finally {
    config.parser_render_type = previous
  }
})

test("common 与 htmlrender 均输出可发送的 Puppeteer 卡片", async () => {
  const previous = config.parser_render_type
  const generated = []
  try {
    for (const mode of ["common", "htmlrender"]) {
      config.parser_render_type = mode
      const result = new ParseResult({
        platform: { name: "test", displayName: "测试平台" },
        title: `${mode} 标题`,
        text: "卡片正文",
        timestamp: 1760000000,
      })
      const replies = []
      await renderAndSend(
        { reply: async value => replies.push(value) },
        result,
      )
      assert.ok(result.renderImage)
      assert.equal(fs.existsSync(result.renderImage), true)
      assert.equal(replies[0][0].type, "image")
      generated.push(result.renderImage)
    }
  } finally {
    config.parser_render_type = previous
    await closeRenderer()
    for (const file of generated) fs.rmSync(file, { force: true })
  }
})

test("群名单在黑名单与白名单模式下语义相反", () => {
  const previous = config.parser_group_blacklist_enabled
  const event = { isGroup: true, group_id: 123, adapter_name: "OneBot V11" }
  const key = groupKey(event)
  groupSet.clear()
  try {
    config.parser_group_blacklist_enabled = true
    assert.equal(isEnabled(event), true)
    groupSet.add(key)
    assert.equal(isEnabled(event), false)
    config.parser_group_blacklist_enabled = false
    assert.equal(isEnabled(event), true)
    groupSet.delete(key)
    assert.equal(isEnabled(event), false)
  } finally {
    groupSet.clear()
    config.parser_group_blacklist_enabled = previous
  }
})

test("QQ 无 file 消息段时使用群文件原生上传接口", async () => {
  const previous = globalThis.segment
  let upload = null
  globalThis.segment = {}
  try {
    await sendFile(
      {
        group: {
          sendFile: async (file, name) => {
            upload = { file, name }
          },
        },
      },
      "fixture.flac",
    )
    assert.deepEqual(upload, { file: "fixture.flac", name: "fixture.flac" })
  } finally {
    globalThis.segment = previous
  }
})

test("自动解析命中后返回 Yunzai 阻断标记", async () => {
  class FixtureParser extends BaseParser {
    static platform = { name: "fixture", displayName: "夹具" }
    static handlers = [
      {
        keyword: "fixture.invalid",
        pattern: /fixture\.invalid\/(?<id>\d+)/,
        method: "parse",
      },
    ]

    parse(match) {
      return this.result({ title: match.groups.id, text: "解析完成" })
    }
  }
  registerParser(FixtureParser)
  const previous = config.parser_render_type
  config.parser_render_type = "default"
  const replies = []
  try {
    const status = await handleParserEvent({
      isGroup: false,
      message: [{ type: "text", text: "https://fixture.invalid/7" }],
      reply: async value => replies.push(value),
    })
    assert.equal(status, "return")
    assert.equal(replies.length, 1)
  } finally {
    config.parser_render_type = previous
  }
})

test("Yunzai 入口可由标准 plugin/segment 全局加载", async () => {
  globalThis.plugin = class {
    constructor(options) {
      Object.assign(this, options)
    }
    reply() {}
  }
  globalThis.segment = {
    image: file => ({ type: "image", file }),
    video: file => ({ type: "video", file }),
    record: file => ({ type: "record", file }),
    file: (file, name) => ({ type: "file", file, name }),
  }
  const entry = await import(`../index.js?test=${Date.now()}`)
  assert.equal(new entry.ParserMessagePlugin().priority, 5)
  assert.equal(new entry.ParserCommandPlugin().priority, 3)
  assert.equal(new entry.ParserMaintenancePlugin().task.cron, "0 0 1 * * *")
  assert.ok(getParser(BilibiliParser))
})

let failures = 0
for (const item of tests) {
  try {
    await item.fn()
    console.log(`✓ ${item.name}`)
  } catch (error) {
    failures += 1
    console.error(`✗ ${item.name}`)
    console.error(error)
  }
}

console.log(`\n${tests.length - failures}/${tests.length} tests passed`)
if (failures) process.exitCode = 1
