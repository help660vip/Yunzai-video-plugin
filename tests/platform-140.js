import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Response } from "node-fetch"

import { config } from "../lib/core/config.js"
import { TipError } from "../lib/core/errors.js"
import { http } from "../lib/core/http.js"
import { AudioContent, GraphicContent } from "../lib/core/model.js"
import { encodeProto, decodeProto } from "../lib/parsers/codec.js"
import { DuitangApiParser, HupuApiParser } from "../lib/parsers/community-api.js"
import { KuwoParser, NeteaseParser, kuwoLrcTimestamp } from "../lib/parsers/music.js"
import { QmcCipher, decryptQqMusicFile } from "../lib/parsers/qqmusic-qmc.js"
import { richHtml } from "../lib/parsers/shared.js"
import { TiebaApiParser, tiebaInternals } from "../lib/parsers/tieba-api.js"
import { XiaohongshuParser } from "../lib/parsers/xiaohongshu.js"

const cases = []
const test = (name, run) => cases.push({ name, run })
const media = "https://media.invalid/audio.mp3"
const picture = "https://media.invalid/cover.jpg"
const withHttp = async (overrides, run) => {
  const original = Object.fromEntries(["request", "json", "text", "buffer"].map(key => [key, http[key]]))
  for (const key of Object.keys(original)) http[key] = overrides[key] || (async () => { throw new Error("Unexpected HTTP: " + key) })
  try { return await run() } finally { Object.assign(http, original) }
}
const withConfig = async (values, run) => {
  const original = Object.fromEntries(Object.keys(values).map(key => [key, config[key]]))
  Object.assign(config, values)
  try { return await run() } finally { Object.assign(config, original) }
}
const neteaseSong = { name: "Song", artists: [{ name: "One" }, {}, { name: "Two" }],
  album: { name: "Album", picUrl: picture }, duration: 123456, fee: 0 }

test("Netease uses official detail, manual outer redirect and optional lyric without downloading", async () => {
  const calls = []
  await withHttp({
    json: async (url, options) => {
      calls.push(url)
      if (url.endsWith("/detail")) {
        assert.equal(options.params.ids, "[1]")
        return { code: 200, songs: [neteaseSong] }
      }
      assert.equal(url, "https://music.163.com/api/song/lyric")
      assert.deepEqual(options.params, { id: "1", lv: "-1", kv: "-1", tv: "-1" })
      return { lrc: { lyric: "[00:00.00]Lyrics" } }
    },
    request: async (url, options) => {
      calls.push(url)
      assert.equal(options.params.id, "1.mp3")
      assert.equal(options.redirect, "manual")
      return new Response(null, { status: 302, headers: { location: media } })
    },
  }, async () => {
    const result = await new NeteaseParser().parse(["song/1", "1"])
    assert.equal(result.contentId, "1")
    assert.equal(result.title, "Song")
    assert.equal(result.author.name, "One、Two")
    assert.equal(result.extra.album, "Album")
    const audio = result.content.find(item => item instanceof AudioContent)
    assert.equal(audio.duration, 123.456)
    assert.equal(audio.pathTask.url, media)
    assert.equal(result.text, "[00:00.00]Lyrics")
    assert.equal(calls.length, 3)
  })
})

test("Netease resolves relative audio redirects and tolerates unavailable lyric", async () => {
  await withHttp({
    json: async url => {
      if (url.endsWith("/detail")) return { code: 200, songs: [neteaseSong] }
      throw new Error("Lyric unavailable")
    },
    request: async () => new Response(null, { status: 302, headers: { location: "/audio/404.mp3" } }),
  }, async () => {
    const result = await new NeteaseParser().parse(["song/1", "1"])
    assert.equal(result.content.find(item => item instanceof AudioContent).pathTask.url, "https://music.163.com/audio/404.mp3")
    assert.equal(result.text, null)
  })
})

test("Netease distinguishes missing, paid and copyright-restricted songs", async () => {
  for (const [songs, location, expected] of [
    [[], media, /没有查到/],
    [[{ ...neteaseSong, fee: 1 }], "/404/", /VIP 或付费/],
    [[neteaseSong], "/404", /版权限制/],
  ]) {
    await withHttp({ json: async () => ({ code: 200, songs }), request: async () =>
      new Response(null, { status: 302, headers: { location } }) }, async () => {
      await assert.rejects(new NeteaseParser().parse(["song/1", "1"]), error => error instanceof TipError && expected.test(error.message))
    })
  }
})

test("Netease rejects non-redirect responses and unsafe media redirect schemes", async () => {
  for (const [status, location] of [[200, media], [302, ""], [302, "file:///private.mp3"]]) {
    await withHttp({ json: async () => ({ code: 200, songs: [neteaseSong] }), request: async () =>
      new Response(null, { status, headers: { location } }) }, async () => {
      await assert.rejects(new NeteaseParser().parse(["song/1", "1"]), /没有音源跳转|无效跳转/)
    })
  }
})

test("Kuwo official metadata, lower bitrate fallback, lyric and threaded comments compose a music result", async () => {
  const attempts = []
  await withConfig({ parser_max_comments: 2 }, () => withHttp({ json: async (url, options) => {
    if (url.includes("datacenter.kuwo.cn")) {
      assert.equal(options.params.ids, "7")
      return [{ name: "Song", artist: "Singer", artistPic: picture, album: "Album", albumpic: picture, duration: "125" }]
    }
    if (url.includes("mobi.kuwo.cn")) {
      attempts.push(options.params.br)
      if (options.params.br === "320kmp3") throw new Error("HTTP 503")
      return { data: { purl: "//media.invalid/audio.mp3" } }
    }
    if (url.includes("getlyric")) return { code: 200, data: { lrclist: [
      { time: "1.005", lineLyric: "  One\n  line " }, { time: "59.995", lineLyric: "Next" },
    ] } }
    assert.equal(options.params.count, 2)
    return { code: "200", top_comments: [{ u_name: "Top", u_id: "u", u_pic: picture, msg: "Comment", time: "100", like_num: "9", child_comment_count: 7,
      child_comments: Array.from({ length: 6 }, (_, index) => ({ u_name: "Reply", msg: `Reply ${index}`, like_num: "1" })) }],
    hot_comments: [{ u_name: "Hot", msg: "Second" }], comments: [{ msg: "Truncated" }] }
  } }, async () => {
    const result = await new KuwoParser().parse(["play_detail/7", "7"])
    const audio = result.content.find(item => item instanceof AudioContent)
    assert.equal(audio.pathTask.url, media)
    assert.equal(audio.duration, 125)
    assert.equal(result.extra.info, "MP3 192K")
    assert.equal(result.text, "[00:01.01]One line\n[01:00.00]Next")
    assert.deepEqual(attempts, ["320kmp3", "192kmp3"])
    assert.equal(result.comments.length, 2)
    assert.equal(result.comments[0].author.id, "u")
    assert.equal(result.comments[0].stats.likeCount, 9)
    assert.equal(result.comments[0].replies.length, 5)
    assert.equal(result.comments[1].author.name, "Hot")
    assert.ok(result.content.some(item => item instanceof AudioContent))
  }))
})

test("Kuwo skips invalid sources through the final quality and optional failures stay nonfatal", async () => {
  const attempts = []
  await withConfig({ parser_max_comments: 0 }, () => withHttp({ json: async (url, options) => {
    if (url.includes("mobi.kuwo.cn")) {
      attempts.push(options.params.br)
      return options.params.br === "128kmp3" ? { surl: media } : { url: "invalid" }
    }
    throw new Error("Optional service unavailable")
  } }, async () => {
    const parser = new KuwoParser()
    assert.deepEqual(await parser.fetchAudio("7"), { url: media, quality: "MP3 128K" })
    assert.deepEqual(attempts, ["320kmp3", "192kmp3", "128kmp3"])
    assert.equal(await parser.fetchLyric("7"), "")
    assert.deepEqual(await parser.fetchComments("7"), [])
  }))
})

test("Kuwo exhausts unavailable qualities and reports missing song metadata", async () => {
  await withHttp({ json: async url => url.includes("datacenter") ? [] : {} }, async () => {
    await assert.rejects(new KuwoParser().fetchAudio("7"), /无法获取/)
    await assert.rejects(new KuwoParser().fetchInfo("7"), /未找到/)
  })
  assert.equal(kuwoLrcTimestamp("0.0049"), "[00:00.00]")
  assert.equal(kuwoLrcTimestamp("0.005"), "[00:00.01]")
  assert.equal(kuwoLrcTimestamp("3599.999"), "[60:00.00]")
})

test("RedNote discovery lazily downloads Huawei CDN with ByteDance fallback on 422 and 424", async () => {
  const parser = new XiaohongshuParser()
  const original = parser.downloader.downloadVideo
  const downloads = []
  parser.downloader.downloadVideo = async (url, options) => { downloads.push([url, options]); return "/synthetic/video.mp4" }
  try {
    await withHttp({ text: async () => `<script>window.__INITIAL_STATE__=${JSON.stringify({ noteData: { data: { noteData: {
      noteId: "n1", title: "Title", user: {}, video: { consumer: { originVideoKey: "origin/key" }, capa: { duration: 5 } }, cover: { fileId: "cover" },
    } } } })}</script>` }, async () => {
      const result = await parser.parseDiscovery("https://www.xiaohongshu.com/discovery/item/n1", "n1")
      assert.equal(downloads.length, 0)
      assert.equal(result.video.pathTask.url, "https://sns-video-hw.xhscdn.com/origin/key")
      assert.equal(await result.video.pathTask.get(), "/synthetic/video.mp4")
      assert.equal(downloads.length, 1)
      assert.deepEqual(downloads[0][1].fallbackUrls, ["https://sns-video-bd.xhscdn.com/origin/key"])
      assert.deepEqual(downloads[0][1].retryHttpStatuses, [422, 424])
      assert.equal(downloads[0][1].cacheKey, "rednote:origin/key")
    })
  } finally { parser.downloader.downloadVideo = original }
})

test("Duitang atlas, blog and comment requests use the xapi hostname", async () => {
  const parser = new DuitangApiParser()
  await withHttp({ json: async url => {
    assert.equal(new URL(url).hostname, "xapi.duitang.com")
    return { status: 1, data: { ok: true } }
  } }, async () => {
    for (const endpoint of ["vienna/atlas/detail/", "blog/with_instance_tag/detail/", "vienna/comment/list/"]) {
      assert.deepEqual(await parser.api(endpoint, {}), { ok: true })
    }
  })
})

test("Hupu video without a source keeps fallback children in content order", () => {
  const parser = new HupuApiParser()
  const items = richHtml(parser, '<p>Before</p><video><span>Fallback</span><img src="/image.jpg"></video><p>After</p>', "https://bbs.hupu.com/")
  assert.equal(items[0], "Before\nFallback")
  assert.ok(items[1] instanceof GraphicContent)
  assert.equal(items[1].pathTask.url, "https://bbs.hupu.com/image.jpg")
  assert.equal(items[2], "After")
  const video = richHtml(parser, '<video src="https://media.invalid/video.mp4?token=temporary"><span>Hidden</span></video>', "https://bbs.hupu.com/")
  assert.equal(video.length, 1)
  assert.equal(video[0].pathTask.cacheKey, null)
})

test("Tieba requests five floor replies using compatible request and response field numbers", async () => {
  const root = tiebaInternals.root
  assert.equal(root.lookupType("PbPageReqIdl.DataReq").fields.floor_rn.id, 9)
  assert.equal(root.lookupType("PbPageReqIdl.DataReq").fields.floor_sort_type.id, 74)
  assert.equal(root.lookupType("User.UserGrowth").fields.level_id.type, "uint32")
  await withConfig({ parser_max_comments: 1 }, () => withHttp({ buffer: async (url, options) => {
    const body = options.body
    const start = body.indexOf(Buffer.from("\r\n\r\n")) + 4
    const end = body.lastIndexOf(Buffer.from("\r\n---*_r1999--\r\n"))
    const request = decodeProto(root, "PbPageReqIdl", body.subarray(start, end))
    assert.equal(request.data.floor_rn, 5)
    assert.equal(request.data.kz, 123)
    assert.equal(request.data.common._client_version, "12.64.1.1")
    return Buffer.from(encodeProto(root, "PbPageResIdl", { data: {
      thread: { id: 123, title: "Topic", post_id: 1, author: { name_show: "Author" } },
      post_list: [{ id: 1, floor: 1, content: [{ type: 0, text: "Body" }] },
        { id: 2, floor: 2, author: { id: 2, name_show: "Reader" }, content: [{ type: 0, text: "Reply" }],
          sub_post_list: { sub_post_list: Array.from({ length: 5 }, (_, index) => ({ id: index + 3, author: { id: 3, name_show: "Child" }, content: [{ type: 0, text: "Child reply" }] })) } }],
    } }))
  } }, async () => {
    const result = await new TiebaApiParser().parse(["https://tieba.baidu.com/p/123"])
    assert.equal(result.title, "Topic")
    assert.equal(result.comments[0].author.name, "Reader")
    assert.equal(result.comments[0].replies.length, 3)
  }))
})

test("QMC Map and RC4 output stays identical across arbitrary streaming boundaries", () => {
  for (const keyLength of [80, 320]) {
    const key = Buffer.from(Array.from({ length: keyLength }, (_, index) => (index * 7 + 3) & 255))
    const input = Buffer.from(Array.from({ length: 140000 }, (_, index) => (index * 11 + 5) & 255))
    const whole = Buffer.from(input)
    new QmcCipher(key).decrypt(whole)
    const streamed = Buffer.from(input)
    const cipher = new QmcCipher(key)
    let offset = 0
    for (const size of [63, 65, 4990, 2, 60415, 65536, 9000]) {
      const end = Math.min(streamed.length, offset + size)
      cipher.decrypt(streamed.subarray(offset, end), offset)
      offset = end
    }
    cipher.decrypt(streamed.subarray(offset), offset)
    assert.equal(crypto.createHash("sha256").update(streamed).digest("hex"), crypto.createHash("sha256").update(whole).digest("hex"))
  }
})

test("QQ audio file conversion streams multiple chunks and validates cached headers", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "yunzai-qmc-stream-"))
  try {
    const source = path.join(directory, "synthetic.ogg")
    const content = Buffer.concat([Buffer.from("OggS"), Buffer.alloc(180000, 42)])
    await fs.writeFile(source, content)
    const output = await decryptQqMusicFile(source)
    assert.deepEqual(await fs.readFile(output), content)
    assert.equal(await decryptQqMusicFile(source), output)
    await fs.writeFile(output, "invalid")
    await decryptQqMusicFile(source)
    assert.deepEqual(await fs.readFile(output), content)
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

let failed = 0
for (const { name, run } of cases) {
  try { await run(); console.log("PASS", name) }
  catch (error) { failed++; console.error("FAIL", name, error) }
}
console.log(`${cases.length - failed}/${cases.length} passed`)
if (failed) process.exitCode = 1
