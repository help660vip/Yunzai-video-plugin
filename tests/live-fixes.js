import assert from "node:assert/strict"
import { Response } from "node-fetch"

import { config } from "../lib/core/config.js"
import { ParseError } from "../lib/core/errors.js"
import { http } from "../lib/core/http.js"
import { ImageContent } from "../lib/core/model.js"
import { buildInfoArgs } from "../lib/core/ytdlp.js"
import { AcfunParser } from "../lib/parsers/acfun.js"
import { biliApi } from "../lib/parsers/bilibili-api.js"
import { BilibiliParser } from "../lib/parsers/bilibili.js"
import { WeiboParser } from "../lib/parsers/weibo.js"

const tests = []
const test = (name, fn) => tests.push({ name, fn })

test("AcFun videoInfo 支持页面中的双层 JSON 编码", async () => {
  const original = http.text
  const play = {
    adaptationSet: [
      {
        representation: [
          { qualityType: "1080p", url: "https://media.invalid/acfun.m3u8" },
        ],
      },
    ],
  }
  const payload = {
    title: "AcFun 双层 JSON",
    currentVideoInfo: {
      durationMillis: 12_000,
      ksPlayJson: JSON.stringify(play),
    },
  }
  const escaped = JSON.stringify(JSON.stringify(payload)).slice(1, -1)
  http.text = async () =>
    "<html><script>window.videoInfo =" + escaped + "</script></html>"
  try {
    const info = await new AcfunParser().parseVideoInfo(
      "https://www.acfun.cn/v/ac123",
    )
    assert.equal(info.title, "AcFun 双层 JSON")
    assert.equal(info.currentVideoInfo.durationMillis, 12_000)
    assert.deepEqual(info.currentVideoInfo.ksPlayJson, play)
  } finally {
    http.text = original
  }
})

test("B站专栏新接口失败时降级到旧 article/view API", async () => {
  const original = biliApi.json
  const calls = []
  biliApi.json = async (url, options) => {
    calls.push({ url, options })
    if (url.endsWith("/x/article/viewinfo")) throw new Error("new API unavailable")
    if (url.endsWith("/x/article/view")) {
      return {
        title: "旧专栏标题",
        summary: "旧专栏摘要",
        publish_time: 1_760_000_000,
        content:
          '<p>第一段</p><img data-src="//i0.hdslb.com/article.jpg" alt="配图"><p>最后一段</p>',
        author: {
          mid: 42,
          name: "专栏作者",
          face: "//i0.hdslb.com/avatar.jpg",
          sign: "作者签名",
        },
        stats: { view: 10, like: 2, reply: 1, share: 3 },
      }
    }
    throw new Error("unexpected Bilibili endpoint: " + url)
  }
  try {
    const result = await new BilibiliParser().parseArticle(123)
    assert.deepEqual(
      calls.map(item => item.url),
      [
        "https://api.bilibili.com/x/article/viewinfo",
        "https://api.bilibili.com/x/article/view",
      ],
    )
    assert.deepEqual(calls[1].options.params, { id: 123 })
    assert.equal(result.contentId, "cv123")
    assert.equal(result.url, "https://www.bilibili.com/read/cv123")
    assert.equal(result.title, "旧专栏标题")
    assert.equal(result.text, "旧专栏摘要")
    assert.equal(result.author.name, "专栏作者")
    assert.equal(result.graphics[0], "第一段")
    assert.equal(result.graphics[1] instanceof ImageContent, true)
    assert.equal(result.graphics[1].alt, "配图")
    assert.equal(result.graphics[2], "最后一段")
  } finally {
    biliApi.json = original
  }
})

test("微博状态接口 200 但缺失 data 时抛出 ParseError", async () => {
  const original = http.request
  http.request = async () =>
    new Response(JSON.stringify({ ok: 0, msg: "fixture removed" }), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    })
  try {
    await assert.rejects(
      new WeiboParser().parseStatus("fixture"),
      error => error instanceof ParseError && error.message === "fixture removed",
    )
  } finally {
    http.request = original
  }
})

test("yt-dlp 信息请求参数不再包含 force-generic-extractor", () => {
  const previous = config.parser_proxy
  config.parser_proxy = "http://127.0.0.1:7890"
  try {
    const args = buildInfoArgs(
      "https://www.youtube.com/watch?v=fixture",
      "fixture-cookies.txt",
    )
    assert.deepEqual(args, [
      "--dump-single-json",
      "--skip-download",
      "--quiet",
      "--no-warnings",
      "--proxy",
      "http://127.0.0.1:7890",
      "--cookies",
      "fixture-cookies.txt",
      "https://www.youtube.com/watch?v=fixture",
    ])
    assert.equal(args.includes("--force-generic-extractor"), false)
  } finally {
    config.parser_proxy = previous
  }
})

let failures = 0
for (const item of tests) {
  try {
    await item.fn()
    console.log("✓ " + item.name)
  } catch (error) {
    failures += 1
    console.error("✗ " + item.name)
    console.error(error)
  }
}

console.log("\n" + (tests.length - failures) + "/" + tests.length + " tests passed")
if (failures) process.exitCode = 1
