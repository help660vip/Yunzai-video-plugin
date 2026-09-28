import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"

import { Response } from "node-fetch"

import { config } from "../lib/core/config.js"
import { StreamDownloader } from "../lib/core/downloader.js"
import { DownloadError } from "../lib/core/errors.js"
import { GraphicContent, LinkContent, StickerContent, VideoContent } from "../lib/core/model.js"
import { cacheDir } from "../lib/core/paths.js"
import { clearRegistryForTests, matchUrl, registerParser } from "../lib/core/registry.js"
import { runProcess } from "../lib/core/utils.js"
import { sanitizeBiliStreamUrls } from "../lib/parsers/bilibili-cdn.js"
import { DouyinParser } from "../lib/parsers/douyin.js"
import { MiyousheApiParser } from "../lib/parsers/miyoushe-api.js"
import { MIYOUSHE_STICKERS } from "../lib/parsers/miyoushe-stickers.js"
import { TiebaApiParser, tiebaInternals } from "../lib/parsers/tieba-api.js"
import { TwitterParser } from "../lib/parsers/twitter.js"

const tests = []
const test = (name, fn) => tests.push({ name, fn })

test("FFmpeg 子进程协议可通过 stdin 输入并返回二进制 stdout", async () => {
  const input = Buffer.from([0, 1, 2, 255])
  const result = await runProcess(
    process.execPath,
    ["-e", "process.stdin.pipe(process.stdout)"],
    { input, encoding: null },
  )
  assert.ok(Buffer.isBuffer(result.stdout))
  assert.deepEqual(result.stdout, input)
})

test("B站流保留替换 CDN 与全部非 PCDN 原始回退地址", () => {
  const urls = sanitizeBiliStreamUrls({
    baseUrl: "https://upos-sz-mirror08c.bilivideo.com/video.m4s?token=1",
    backupUrl: [
      "https://xy123x1x2x3xy.mcdn.bilivideo.cn/pcdn/video.m4s",
      "https://upos-sz-mirrorcoso1.bilivideo.com/video.m4s?token=2",
    ],
  }, { region: "zh" })
  assert.equal(urls[0], "https://upos-sz-mirrorcos.bilivideo.com/video.m4s?token=1")
  assert.equal(urls[1], "https://upos-sz-mirror08c.bilivideo.com/video.m4s?token=1")
  assert.equal(urls[2], "https://upos-sz-mirrorcoso1.bilivideo.com/video.m4s?token=2")
  assert.equal(urls.some(url => url.includes("mcdn")), false)
})

test("下载器强制 identity 并在可重试状态码后轮换备用 URL", async () => {
  const downloader = new StreamDownloader()
  const originalRequest = downloader.http.request
  const previousRetries = config.parser_max_retries
  const key = "media-fallback-" + Date.now()
  const media = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom")])
  const calls = []
  let output = null
  try {
    config.parser_max_retries = 1
    downloader.http.request = async (url, options) => {
      calls.push({ url, headers: options.headers })
      if (calls.length === 1) return new Response("blocked", { status: 403 })
      return new Response(media, {
        status: 200,
        headers: { "content-length": String(media.length), "content-type": "application/octet-stream" },
      })
    }
    output = await downloader.download("https://primary.invalid/media", {
      cacheKey: key,
      suffix: ".dat",
      detectFormat: "video",
      headers: { "Accept-Encoding": "gzip", referer: "https://source.invalid/" },
      fallbackUrls: ["https://fallback.invalid/media"],
      retryHttpStatuses: [403],
    })
    assert.deepEqual(calls.map(item => item.url), [
      "https://primary.invalid/media",
      "https://fallback.invalid/media",
    ])
    assert.equal(calls[0].headers["accept-encoding"], "identity")
    assert.equal(Object.keys(calls[0].headers).some(key => key === "Accept-Encoding"), false)
    assert.equal(path.extname(output), ".mp4")
    assert.deepEqual(fs.readFileSync(output), media)
  } finally {
    downloader.http.request = originalRequest
    config.parser_max_retries = previousRetries
    if (output) fs.rmSync(output, { force: true })
  }
})

test("未列入重试集合的 HTTP 状态不会重试", async () => {
  const downloader = new StreamDownloader()
  const originalRequest = downloader.http.request
  const previousRetries = config.parser_max_retries
  let calls = 0
  try {
    config.parser_max_retries = 3
    downloader.http.request = async () => {
      calls += 1
      return new Response("unauthorized", { status: 401 })
    }
    await assert.rejects(
      downloader.download("https://primary.invalid/unauthorized", {
        cacheKey: "media-401-" + Date.now(),
        suffix: ".dat",
        fallbackUrls: ["https://fallback.invalid/unauthorized"],
        retryHttpStatuses: [403],
      }),
      DownloadError,
    )
    assert.equal(calls, 1)
  } finally {
    downloader.http.request = originalRequest
    config.parser_max_retries = previousRetries
  }
})

test("遗留断点收到 416 后删除分片并从备用线路完整重下", async () => {
  const downloader = new StreamDownloader()
  const originalRequest = downloader.http.request
  const originalDownloadOnce = downloader.downloadOnce.bind(downloader)
  const previousRetries = config.parser_max_retries
  const key = "media-416-" + Date.now()
  let calls = 0
  let output = null
  try {
    config.parser_max_retries = 1
    downloader.http.request = async (url, options) => {
      calls += 1
      if (calls === 1) {
        assert.equal(options.headers.range, "bytes=6-")
        return new Response(null, { status: 416 })
      }
      assert.equal(url, "https://fallback.invalid/restart")
      assert.equal(options.headers.range, undefined)
      return new Response("fresh", { status: 200, headers: { "content-length": "5" } })
    }
    let attempts = 0
    downloader.downloadOnce = async (url, target, options) => {
      attempts += 1
      if (attempts === 1) fs.writeFileSync(target, "legacy")
      else assert.equal(fs.existsSync(target), false)
      return originalDownloadOnce(url, target, options)
    }
    output = await downloader.download("https://primary.invalid/restart", {
      cacheKey: key,
      fallbackUrls: ["https://fallback.invalid/restart"],
    })
    assert.equal(path.extname(output), ".dat")
    assert.equal(fs.readFileSync(output, "utf8"), "fresh")
    assert.equal(calls, 2)
  } finally {
    downloader.http.request = originalRequest
    config.parser_max_retries = previousRetries
    if (output) fs.rmSync(output, { force: true })
  }
})

test("压缩响应忽略传输 Content-Length，且断点响应严格校验 Content-Range", async () => {
  const downloader = new StreamDownloader()
  const originalRequest = downloader.http.request
  const compressedPath = path.join(cacheDir, "media-compressed.tmp")
  const resumePath = path.join(cacheDir, "media-range.tmp")
  try {
    downloader.http.request = async () => new Response("decoded", {
      status: 200,
      headers: { "content-encoding": "gzip", "content-length": "2" },
    })
    await downloader.downloadOnce("https://media.invalid/compressed", compressedPath, {
      headers: {}, chunkSize: 16, browser: false,
    })
    assert.equal(fs.readFileSync(compressedPath, "utf8"), "decoded")

    fs.writeFileSync(resumePath, "abc")
    downloader.http.request = async () => new Response("def", {
      status: 206,
      headers: { "content-length": "3", "content-range": "bytes 2-4/6" },
    })
    await assert.rejects(
      downloader.downloadOnce("https://media.invalid/range", resumePath, {
        headers: {}, chunkSize: 16, browser: false,
      }),
      /Content-Range 错误/,
    )
    assert.equal(fs.readFileSync(resumePath, "utf8"), "abc")
  } finally {
    downloader.http.request = originalRequest
    fs.rmSync(compressedPath, { force: true })
    fs.rmSync(resumePath, { force: true })
  }
})

test("X Article 按 Draft.js UTF-16 实体范围保持文字与媒体顺序", () => {
  const parser = new TwitterParser()
  const tweet = {
    __typename: "Tweet",
    rest_id: "article-1",
    legacy: { full_text: "推文引言", display_text_range: [0, 4], extended_entities: { media: [] } },
    core: { user_results: { result: { core: { name: "作者", screen_name: "writer" }, legacy: {} } } },
    article: { article_results: { result: {
      rest_id: "article-body-1",
      title: "长文章标题",
      preview_text: "摘要",
      cover_media: { media_info: { original_img_url: "https://img.invalid/cover.jpg" } },
      content_state: {
        blocks: [
          { text: "前😀文X后", entityRanges: [{ key: 0, offset: 4, length: 1 }] },
          { text: "第二段", entityRanges: [] },
        ],
        entityMap: [{ key: 0, value: { type: "MEDIA", data: { mediaItems: [{ mediaId: "video-1" }] } } }],
      },
      media_entities: [{
        media_id: "video-1",
        media_info: {
          preview_image: { original_img_url: "https://img.invalid/video.jpg" },
          duration_millis: 4500,
          variants: [
            { content_type: "video/mp4", url: "https://video.invalid/low.mp4", bit_rate: 10 },
            { content_type: "video/mp4", url: "https://video.invalid/high.mp4", bit_rate: 20 },
          ],
        },
      }],
    } } },
  }
  const result = parser.collectTweet(tweet)
  assert.equal(result.title, "长文章标题")
  assert.ok(result.content[0] instanceof GraphicContent)
  assert.equal(result.content[1], "推文引言")
  assert.equal(result.content[2], "前😀文")
  assert.ok(result.content[3] instanceof VideoContent)
  assert.equal(result.content[3].pathTask.url, "https://video.invalid/high.mp4")
  assert.equal(result.content[3].duration, 4.5)
  assert.equal(result.content[4], "后\n第二段")
})

test("米游社 UGC 支持片段查询参数、统计、媒体、表情和楼中楼", () => {
  clearRegistryForTests()
  registerParser(MiyousheApiParser)
  const route = matchUrl(
    "https://act.miyoushe.com/ys/ugc_community/mx/#/pages/level-detail/index?id=28498621183&region=cn_gf01",
  )
  assert.equal(route.params.id, "28498621183")
  assert.equal(route.params.region, "cn_gf01")
  const parser = route.parser
  const reply = {
    user_info: { uid: "2", avatar: "https://img.invalid/reply.jpg", nickname: "评论者" },
    content: "不错_(星谷米游姬-好耶)", created_at: 1, client_ip: "上海",
    reply_stat: { like_count: "2", reply_count: "1" },
    sub_replies: [{
      user_info: { uid: "3", avatar: "https://img.invalid/sub.jpg", nickname: "回复者" },
      content: "同意", created_at: 2, client_ip: "北京",
      reply_stat: { like_count: "1", reply_count: "0" }, sub_replies: [],
    }],
  }
  const result = parser.collectUgc({ data: { resp_map: {
    reply_card: { data: { reply_card_response: { reply_count: 12, reply_list: [reply] } } },
    developer_info: { data: { developer_news_response: { developer: {
      aid: "1", mys_user_info: { aid: "1", avatar_url: "https://img.invalid/a.jpg", nickname: "开发者" },
    } } } },
    level_detail: { data: { level_detail_response: { level_info: {
      level_id: "28498621183", level_name: "心跳通讯录", play_type: "角色扮演",
      level_intro: "简介", desc: "详情", images: [{ url: "https://img.invalid/level.jpg" }],
      video_info: { video_id: "v1", video_url: "https://video.invalid/ugc.mp4", video_cover: "https://img.invalid/v.jpg" },
      good_rate: "96%", hot_score: "9999",
    } } } },
  } } }, "28498621183", "cn_gf01")
  assert.equal(result.contentId, "28498621183")
  assert.equal(result.title, "心跳通讯录 - 角色扮演")
  assert.deepEqual(result.stats.extra.hot, ["热度", "9999"])
  assert.equal(result.videoContents.length, 1)
  assert.ok(result.comments[0].content.some(item => item instanceof StickerContent))
  assert.equal(result.comments[0].replies[0].parentAuthor.name, "评论者")
})

test("贴吧使用官方表情 CDN、链接卡和视频内容，评论保持接口顺序", () => {
  const parser = new TiebaApiParser()
  const content = tiebaInternals.contents(parser, [
    { type: 0, text: "正文" },
    { type: 2, text: "image_emoticon", c: "表情" },
    { type: 1, text: "标题", link: "https://example.invalid/card" },
    { type: 5, src: "https://video.invalid/tieba.mp4", during_time: 8 },
  ])
  assert.equal(content[0], "正文")
  assert.ok(content[1] instanceof StickerContent)
  assert.match(content[1].pathTask.url, /^https:\/\/gsp0\.baidu\.com\//)
  assert.ok(content[2] instanceof LinkContent)
  assert.ok(content[3] instanceof VideoContent)
  const comments = tiebaInternals.buildComments(parser, {
    user_list: [
      { id: 20, name_show: "普通用户" },
      { id: 10, name_show: "楼主" },
    ],
    post_list: [
      { id: 2, floor: 2, author_id: 20, content: [{ type: 0, text: "先返回" }] },
      { id: 3, floor: 3, author_id: 10, content: [{ type: 0, text: "后返回" }] },
    ],
  }, { post_id: 1, author_id: 10 })
  assert.deepEqual(comments.map(comment => comment.author.name), ["普通用户", "楼主"])
})

test("抖音视频使用原比例封面，米游社表情资源映射完整", () => {
  const result = new DouyinParser().buildWorkResult({
    aweme_id: "cover-1", share_info: { share_desc: "", share_desc_info: "测试" },
    author: {}, statistics: {}, video: {
      duration: 1000,
      play_addr: { uri: "video-id" },
      cover: { url_list: ["https://img.invalid/normal.jpg"] },
      cover_original_scale: { url_list: ["https://img.invalid/original.jpg"] },
    },
  })
  assert.equal(result.videoContents[0].cover.url, "https://img.invalid/original.jpg")
  assert.equal(Object.keys(MIYOUSHE_STICKERS).length, 3154)
  assert.ok(MIYOUSHE_STICKERS["星谷米游姬-好耶"])
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

console.log(`\n${tests.length - failures}/${tests.length} media regression tests passed`)
if (failures) process.exitCode = 1
