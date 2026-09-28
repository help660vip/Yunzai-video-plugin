import assert from "node:assert/strict"
import { Response } from "node-fetch"
import { config } from "../lib/core/config.js"
import { LinkContent, LivePhotoContent, StickerContent, VideoContent } from "../lib/core/model.js"
import { WeiboParser } from "../lib/parsers/weibo.js"
import { WeiboSession } from "../lib/parsers/weibo-session.js"

const tests = []
const test = (name, fn) => tests.push({ name, fn })
const user = { idstr: "1", screen_name: "演示作者", description: "简介", profile_image_url: "https://media.invalid/a.jpg" }
const status = () => ({ idstr: "123", user, text_raw: "第一段[微笑]\n第二段", created_at: "2026-01-01T12:00:00Z",
  region_name: "地区", attitudes_count: 2, comments_count: 3,
  pic_infos: { a: { pic_id: "a", type: "livephoto", original: { url: "https://media.invalid/a.jpg" }, video: "https://media.invalid/a.mp4" } } })

test("微博音乐卡没有媒体信息时仍解析正文，图片保持懒执行", () => {
  const parser = new WeiboParser()
  const result = parser.collectStatus({ ...status(), page_info: { page_title: "音乐", page_url: "https://weibo.com/music/example", media_info: null } })
  assert.equal(result.author.description, "简介")
  assert.equal(result.author.location, "地区")
  assert.ok(result.content.some(item => item instanceof LinkContent))
  assert.ok(result.content.some(item => item instanceof StickerContent))
  assert.ok(result.allMedia.some(item => item instanceof LivePhotoContent))
  assert.equal(result.author.avatar.promise, null)
  for (const media of result.allMedia) assert.equal(media.pathTask.promise, null)
})

test("微博长文、转发、评论回复与评论 Live Photo", async () => {
  const parser = new WeiboParser()
  const calls = []
  parser.session = { json: async url => {
    calls.push(url)
    if (url.endsWith("statuses/show")) return { ...status(), isLongText: true, retweeted_status: { ...status(), idstr: "122" } }
    if (url.endsWith("statuses/extend")) return { data: { longTextContent: "<p>完整正文</p><p>另一段<img alt='[微笑]'></p>" } }
    if (url.endsWith("comments/hotflow")) return { data: { data: [{ ...status(), text: "回复<br>换行", comments: [{ user, text: "楼中楼" }] }] } }
    throw new Error("Unexpected endpoint")
  } }
  const result = await parser.parseStatus("123")
  assert.ok(result.text.includes("完整正文\n另一段"))
  assert.equal(result.repost.contentId, "122")
  assert.equal(result.comments[0].replies.length, 1)
  assert.ok(result.comments[0].content.some(item => item instanceof LivePhotoContent))
  assert.equal(calls.filter(url => url.includes("comments/")).length, 1)
})

test("关闭评论后状态、视频、文章均不发评论请求", async () => {
  const previous = config.parser_max_comments
  config.parser_max_comments = 0
  const parser = new WeiboParser()
  const calls = []
  parser.session = { json: async url => {
    calls.push(url)
    if (url.endsWith("statuses/show")) return status()
    if (url.endsWith("aj/detail")) return { msg: "success", data: { userinfo: user, title: "文章", content: "<p>前文<img src='https://media.invalid/a.jpg'>后文</p>" } }
    if (url.endsWith("api/component")) return { data: { Component_Play_Playinfo: { author: "作者", urls: { hd: "//media.invalid/v.mp4" }, cover_image: "//media.invalid/c.jpg" } } }
    throw new Error("Unexpected endpoint")
  } }
  try {
    await parser.parseStatus("123")
    const article = await parser.parseArticle("123")
    assert.equal(article.content[0], "前文")
    assert.equal(article.content[2], "后文")
    const video = await parser.parseFid("1034:123")
    assert.ok(video.allMedia[0] instanceof VideoContent)
    assert.equal(video.allMedia[0].pathTask.url, "https://media.invalid/v.mp4")
    assert.equal(calls.length, 3)
  } finally { config.parser_max_comments = previous }
})

test("微博访客凭据单飞刷新、通用请求头和 Cookie 域隔离", async () => {
  const calls = []
  const session = new WeiboSession({ request: async (url, options) => {
    calls.push({ url, options })
    if (url.includes("genvisitor2")) return new Response('visitor_gray_callback({"retcode":20000000,"data":{"sub":"fixture-sub","subp":"fixture-subp"}})')
    if (url === "https://www.weibo.com/") return new Response("", { headers: { "set-cookie": "XSRF-TOKEN=fixture-xsrf; Domain=.weibo.com; Path=/" } })
    return new Response("{}")
  } })
  await Promise.all([session.json("https://www.weibo.com/ajax/statuses/show"), session.json("https://m.weibo.cn/comments/hotflow")])
  assert.equal(calls.filter(item => item.url.includes("genvisitor2")).length, 1)
  const desktop = calls.find(item => item.url.endsWith("statuses/show")).options.headers
  assert.ok(desktop["User-Agent"] || desktop["user-agent"])
  assert.match(desktop.cookie, /SUB=fixture-sub/)
  assert.equal(desktop["x-xsrf-token"], "fixture-xsrf")
  const mobile = calls.find(item => item.url.includes("hotflow")).options.headers
  assert.equal(mobile.cookie, "")
  assert.equal(mobile["x-xsrf-token"], undefined)
  await assert.rejects(session.json("https://weibo.com.example.invalid/"), /域名/)
})

let failed = 0
for (const { name, fn } of tests) {
  try { await fn(); console.log("✓ " + name) }
  catch (error) { failed++; console.error("✗ " + name, error) }
}
if (failed) process.exitCode = 1
