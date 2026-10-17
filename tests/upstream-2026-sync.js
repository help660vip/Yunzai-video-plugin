import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  DEFAULT_CONFIG,
  PLATFORM_NAMES,
  config,
  validateConfig,
} from "../lib/core/config.js"
import { StreamDownloader } from "../lib/core/downloader.js"
import {
  disabledTargets,
  groupSet,
  isEnabled,
  setEnabled,
  targetKey,
} from "../lib/core/group-filter.js"
import { GraphicContent, PathTask, PollContent, QuoteContent, VideoContent } from "../lib/core/model.js"
import { cacheDir, dataDir, resourcesDir } from "../lib/core/paths.js"
import {
  fileUploadOptions,
  packForwardNodes,
  renderContents,
  sendFile,
  sendVideo,
  stripForwardBoundary,
} from "../lib/core/sender.js"
import {
  clearRegistryForTests,
  matchUrl,
  registerParser,
} from "../lib/core/registry.js"
import { BilibiliApi, biliApi } from "../lib/parsers/bilibili-api.js"
import { BilibiliParser } from "../lib/parsers/bilibili.js"
import { douyinVideoTask } from "../lib/parsers/douyin.js"
import { HeyboxApiParser } from "../lib/parsers/heybox-api.js"
import { KuaishouParser } from "../lib/parsers/kuaishou.js"
import { LinuxDoAuth } from "../lib/parsers/linuxdo-auth.js"
import { QQMusicParser } from "../lib/parsers/music.js"
import {
  decryptQqMusicFile,
  qqMusicOutputExtension,
  validateQqAudio,
} from "../lib/parsers/qqmusic-qmc.js"
import { htmlToText } from "../lib/parsers/shared.js"
import { parsePollCard, TwitterParser } from "../lib/parsers/twitter.js"
import { http } from "../lib/core/http.js"
import { buildThemeData, MAX_CONCURRENT_RESOURCES } from "../lib/render/context.js"

const tests = []
const test = (name, run) => tests.push({ name, run })

async function readSnapshot(filePath) {
  try {
    return { exists: true, data: await fs.promises.readFile(filePath) }
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, data: null }
    throw error
  }
}

async function restoreSnapshot(filePath, snapshot) {
  if (!snapshot.exists) {
    await fs.promises.unlink(filePath).catch(error => {
      if (error?.code !== "ENOENT") throw error
    })
    return
  }
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${process.pid}.sync-test.tmp`
  try {
    await fs.promises.writeFile(temporary, snapshot.data, { flag: "wx" })
    await fs.promises.rename(temporary, filePath)
  } finally {
    await fs.promises.unlink(temporary).catch(() => {})
  }
}

function replaceSet(target, values) {
  target.clear()
  for (const value of values) target.add(value)
}

test("2026 sync configuration validates upload timeout, render format and QQ Music", () => {
  assert.equal(DEFAULT_CONFIG.parser_file_upload_timeout, null)
  assert.equal(DEFAULT_CONFIG.parser_render_format, "jpeg")
  assert.equal(PLATFORM_NAMES.includes("qqmusic"), true)

  const valid = validateConfig({
    parser_file_upload_timeout: "900",
    parser_render_format: "webp",
    parser_disabled_platforms: ["qqmusic"],
  })
  assert.equal(valid.parser_file_upload_timeout, 900)
  assert.equal(valid.parser_render_format, "webp")
  assert.deepEqual(valid.parser_disabled_platforms, ["qqmusic"])

  assert.equal(validateConfig({ parser_file_upload_timeout: 0 }).parser_file_upload_timeout, null)
  assert.equal(validateConfig({ parser_render_format: "bmp" }).parser_render_format, "jpeg")
})

test("file upload timeout is attached only to file delivery", async () => {
  const directory = await fs.promises.mkdtemp(path.join(cacheDir, "sync-upload-"))
  const file = path.join(directory, "fixture.mp4")
  await fs.promises.writeFile(file, "synthetic-media")
  const previousTimeout = config.parser_file_upload_timeout
  const previousSegment = globalThis.segment
  const calls = []
  globalThis.segment = {
    file: (value, name) => ({ type: "file", file: value, name }),
    video: (value, name) => ({ type: "video", file: value, name }),
  }
  config.parser_file_upload_timeout = 17
  try {
    assert.deepEqual(fileUploadOptions(), { _timeout: 17 })
    const event = { reply: async (...args) => calls.push(args) }
    await sendFile(event, file, "fixture.mp4")
    await sendVideo(event, file)
    assert.equal(calls.length, 2)
    assert.equal(calls[0][0].type, "file")
    assert.deepEqual(calls[0].slice(1), [false, { _timeout: 17 }])
    assert.equal(calls[1][0].type, "video")
    assert.equal(calls[1].length, 1)
  } finally {
    config.parser_file_upload_timeout = previousTimeout
    globalThis.segment = previousSegment
    await fs.promises.rm(directory, { recursive: true, force: true })
  }
})

test("forward packing removes only outer boundary newlines", () => {
  const image = { type: "image", file: "fixture" }
  assert.deepEqual(
    stripForwardBoundary([
      { type: "text", text: "\n标题\n\n" },
      image,
      { type: "text", data: { text: "\n正文\n" } },
    ]),
    [
      { type: "text", text: "标题\n\n" },
      image,
      { type: "text", data: { text: "\n正文" } },
    ],
  )
  assert.deepEqual(packForwardNodes(["\n标题\n", "\n正文\n"]), [[
    ["标题"],
    ["正文"],
  ]])
})

test("group and user target switches preserve scope and restore persistent state", async () => {
  const groupFile = path.join(dataDir, "group_set.json")
  const targetFile = path.join(dataDir, "disabled_targets.json")
  const [groupSnapshot, targetSnapshot] = await Promise.all([
    readSnapshot(groupFile),
    readSnapshot(targetFile),
  ])
  const originalGroups = [...groupSet]
  const originalTargets = [...disabledTargets]
  const originalMode = config.parser_group_blacklist_enabled
  const originalUsers = [...config.parser_blacklist_users]
  const group = {
    isGroup: true,
    group_id: "sync-group",
    user_id: "sync-admin",
    adapter_name: "OneBot V11",
  }
  const privateUser = {
    isGroup: false,
    user_id: "sync-user",
    adapter_name: "OneBot V11",
  }
  try {
    replaceSet(groupSet, [])
    replaceSet(disabledTargets, [])
    await fs.promises.writeFile(groupFile, "[]", "utf8")
    await fs.promises.writeFile(targetFile, "[]", "utf8")
    config.parser_group_blacklist_enabled = true
    config.parser_blacklist_users = []

    assert.equal(isEnabled(group), true)
    assert.equal(setEnabled(group, false), true)
    assert.equal(isEnabled(group), false)
    assert.equal(setEnabled(group, false), false)
    assert.equal(setEnabled(group, true), true)
    assert.equal(isEnabled(group), true)

    assert.equal(targetKey(privateUser), "QQClient_USER_sync-user")
    assert.equal(setEnabled(privateUser, false), true)
    assert.equal(isEnabled(privateUser), false)
    assert.equal(isEnabled({ ...privateUser, user_id: "other-user" }), true)
    assert.equal(isEnabled({ ...privateUser, adapter_name: "Discord" }), true)
    assert.equal(setEnabled(privateUser, true), true)

    assert.equal(setEnabled(group, false, "user:target-user"), true)
    assert.equal(isEnabled({ ...privateUser, user_id: "target-user" }), false)
    assert.equal(setEnabled(group, true, "user:target-user"), true)
  } finally {
    config.parser_group_blacklist_enabled = originalMode
    config.parser_blacklist_users = originalUsers
    replaceSet(groupSet, originalGroups)
    replaceSet(disabledTargets, originalTargets)
    await Promise.all([
      restoreSnapshot(groupFile, groupSnapshot),
      restoreSnapshot(targetFile, targetSnapshot),
    ])
  }
})

test("semantic HTML keeps inline whitespace and expands anchors", () => {
  assert.equal(
    htmlToText(
      '<p>前  内联 <strong>粗体</strong> 后 <a href="/go">链接</a></p><p>第二</p>',
      "https://example.invalid/base",
    ),
    "前  内联 粗体 后 链接 (https://example.invalid/go)\n第二",
  )
})

test("Douyin media tasks rotate every unique playback URL", async () => {
  const calls = []
  const parser = {
    downloader: {
      downloadVideo: async (url, options) => {
        calls.push({ url, options })
        return "fixture.mp4"
      },
    },
  }
  const task = douyinVideoTask(parser, {
    play_addr: {
      url_list: [
        "https://cdn.invalid/one.mp4",
        "",
        "https://cdn.invalid/two.mp4",
        "https://cdn.invalid/one.mp4",
      ],
    },
  }, "douyin:fixture")
  assert.equal(typeof task, "function")
  assert.equal(task.url, "https://cdn.invalid/one.mp4")
  assert.equal(task.cacheKey, "douyin:fixture")
  assert.equal(task.ext_headers.referer, "https://www.douyin.com/")
  assert.equal(await task(), "fixture.mp4")
  assert.deepEqual(calls[0].options.fallbackUrls, ["https://cdn.invalid/two.mp4"])
  assert.deepEqual(calls[0].options.retryHttpStatuses, [460])
  assert.equal(calls[0].options.cacheKey, "douyin:fixture")
})

test("Linux Do cookies rotate, clear and share concurrent login probes", async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "yunzai-linuxdo-sync-"))
  const cookieFile = path.join(directory, "cookies.txt")
  const previousCookie = config.parser_linuxdo_ck
  try {
    await fs.promises.writeFile(cookieFile, "_t=identity; _forum_session=fresh", "utf8")
    config.parser_linuxdo_ck = "_t=identity; _forum_session=stale"
    const retained = new LinuxDoAuth({ cookiePath: cookieFile })
    assert.deepEqual(await retained.cookies(), {
      _t: "identity",
      _forum_session: "fresh",
    })

    config.parser_linuxdo_ck = "_t=new-identity; _forum_session=new-session"
    assert.deepEqual(await retained.cookies(), {
      _t: "new-identity",
      _forum_session: "new-session",
    })

    await fs.promises.writeFile(cookieFile, "_t=alive; keep=1", "utf8")
    config.parser_linuxdo_ck = null
    const cleared = new LinuxDoAuth({ cookiePath: cookieFile })
    await cleared.updateFromResponse({
      status: 200,
      headers: { raw: () => ({ "set-cookie": ["_t=deleted; Path=/; HttpOnly"] }) },
    })
    assert.deepEqual(await cleared.cookies(), { keep: "1" })
    assert.equal(await fs.promises.readFile(cookieFile, "utf8"), "keep=1")

    await fs.promises.writeFile(cookieFile, "_t=probe", "utf8")
    let probes = 0
    const client = {
      browserRequest: async () => {
        probes += 1
        await new Promise(resolve => setTimeout(resolve, 10))
        return {
          status: 200,
          url: "https://linux.do/session/current.json",
          body: JSON.stringify({ current_user: { id: 1 } }),
          headers: { raw: () => ({ "set-cookie": [] }) },
        }
      },
    }
    const concurrent = new LinuxDoAuth({ cookiePath: cookieFile, client })
    assert.deepEqual(
      await Promise.all([
        concurrent.validateLogin({ force: true }),
        concurrent.validateLogin({ force: true }),
        concurrent.validateLogin({ force: true }),
      ]),
      [true, true, true],
    )
    assert.equal(probes, 1)
  } finally {
    config.parser_linuxdo_ck = previousCookie
    await fs.promises.rm(directory, { recursive: true, force: true })
  }
})

test("download fallback adopts the successful URL suffix", async () => {
  const previousRetries = config.parser_max_retries
  const downloader = new StreamDownloader()
  const key = `sync-fallback-${process.pid}-${Date.now()}`
  const calls = []
  let output = null
  config.parser_max_retries = 1
  downloader.downloadOnce = async (url, target) => {
    calls.push(url)
    if (calls.length === 1) throw new Error("synthetic primary failure")
    await fs.promises.writeFile(target, Buffer.from([0x00, 0x01, 0x02]))
    return { contentType: "application/octet-stream", finalUrl: url }
  }
  try {
    output = await downloader.download("https://primary.invalid/audio.mp3", {
      suffix: ".dat",
      detectFormat: "audio",
      cacheKey: key,
      fallbackUrls: ["https://backup.invalid/audio.mgg?token=fixture"],
    })
    assert.deepEqual(calls, [
      "https://primary.invalid/audio.mp3",
      "https://backup.invalid/audio.mgg?token=fixture",
    ])
    assert.equal(path.extname(output), ".mgg")
    assert.deepEqual(await fs.promises.readFile(output), Buffer.from([0x00, 0x01, 0x02]))
  } finally {
    config.parser_max_retries = previousRetries
    if (output) await fs.promises.unlink(output).catch(() => {})
  }
})

test("Heybox image captions become graphic alt text", () => {
  const parser = new HeyboxApiParser()
  const content = parser.buildLinkContent({
    text: JSON.stringify([{
      type: "html",
      text: '<p><img src="https://img.invalid/a.jpg"></p><div class="img-desc">图片说明</div>',
    }]),
  }, "heybox:fixture")
  const graphic = content.find(item => item instanceof GraphicContent)
  assert.ok(graphic)
  assert.equal(graphic.alt, "图片说明")
  assert.equal(content.includes("图片说明"), false)
})

test("Bilibili live HTML descriptions retain anchor destinations", async () => {
  const parser = new BilibiliParser()
  const originalJson = biliApi.json
  const originalReady = parser.readyCredential
  parser.readyCredential = async () => {}
  biliApi.json = async () => ({
    room_info: {
      room_id: 42,
      uid: 7,
      title: "Fixture Live",
      live_status: 1,
      area_name: "测试区",
      parent_area_name: "分区",
      description: '<p><strong>支持：</strong><a href="https://example.invalid/help">这里</a></p>',
    },
    anchor_info: { base_info: { uname: "主播", face: "//img.invalid/avatar.jpg" } },
  })
  try {
    const result = await parser.parseLive(42)
    assert.match(result.text, /支持：这里 \(https:\/\/example\.invalid\/help\)/)
  } finally {
    biliApi.json = originalJson
    parser.readyCredential = originalReady
  }
})

test("X image polls retain votes, images and closing metadata", () => {
  const card = {
    legacy: {
      name: "poll2choice_image",
      binding_values: [
        { key: "choice_count", value: { string_value: "2" } },
        { key: "choice1_label", value: { string_value: "A" } },
        { key: "choice1_count", value: { string_value: "3" } },
        { key: "choice1_image_original", value: { image_value: { url: "https://pbs.twimg.com/media/a.jpg" } } },
        { key: "choice2_label", value: { string_value: "B" } },
        { key: "choice2_count", value: { string_value: "2" } },
        { key: "choice2_image_original", value: { image_value: { url: "https://pbs.twimg.com/media/b.jpg" } } },
        { key: "counts_are_final", value: { boolean_value: true } },
        { key: "end_datetime_utc", value: { string_value: "2026-09-28T01:40:00Z" } },
      ],
    },
  }
  const parsed = parsePollCard(card)
  assert.deepEqual(parsed.options.map(item => [item.text, item.votes]), [["A", 3], ["B", 2]])
  assert.equal(parsed.closed, true)
  assert.match(parsed.closeAt, /^2026-09-28 \d{2}:40$/)

  const poll = new TwitterParser().buildContent({
    rest_id: "42",
    legacy: { full_text: "投票", lang: "zh", extended_entities: { media: [] } },
    card,
  }).find(item => item instanceof PollContent)
  assert.ok(poll)
  assert.equal(poll.options[0].image instanceof PathTask, true)
  assert.equal(poll.options[0].image.url, "https://pbs.twimg.com/media/a.jpg")
  assert.equal(poll.optionVoteTotal, 5)
})

test("X poll translation ignores stale translatable flags and falls back to API", async () => {
  const parser = new TwitterParser()
  const previousCookie = config.parser_x_ck
  const originalJson = http.json
  let requests = 0
  config.parser_x_ck = "auth_token=fixture; ct0=csrf"
  http.json = async url => {
    assert.match(String(url), /translation\.json/)
    requests += 1
    return {
      result: {
        text: "你好",
        associated_data: { poll_translations: ["甲"] },
      },
    }
  }
  const tweet = {
    rest_id: "99",
    is_translatable: false,
    legacy: { lang: "en", full_text: "hello", extended_entities: { media: [] } },
    card: {
      legacy: {
        name: "poll2choice_text_only",
        binding_values: [
          { key: "choice_count", value: { string_value: "2" } },
          { key: "choice1_label", value: { string_value: "A" } },
          { key: "choice2_label", value: { string_value: "B" } },
        ],
      },
    },
    grok_translated_post_with_availability: { is_available: true, data: null },
  }
  const result = { content: [], repost: null }
  try {
    await parser.translateResult(tweet, result)
    assert.equal(requests, 1)
    const quote = result.content.find(item => item instanceof QuoteContent)
    assert.ok(quote)
    assert.match(quote.text, /你好/)
    assert.match(quote.text, /1\. 甲/)
    assert.match(quote.text, /2\. B/)
  } finally {
    http.json = originalJson
    config.parser_x_ck = previousCookie
  }
})

test("poll option images precede protected poll text in message delivery", async () => {
  const parser = new TwitterParser()
  const pixel = path.join(resourcesDir, "fallback_pic", "1.jpg")
  const poll = parser.createPoll({
    title: "图片投票",
    closeAt: "2026-10-17 20:00",
    options: [parser.createPollOption("A", 1, { imageUrl: "https://example.invalid/a.jpg" })],
  })
  poll.options[0].image = new PathTask(async () => pixel, "poll-image")
  const result = parser.result({ content: [poll] })
  const previousForward = config.parser_need_forward_contents
  config.parser_need_forward_contents = false
  const replies = []
  try {
    await renderContents({ reply: async message => replies.push(message) }, result)
    const flattened = replies.flat(4)
    assert.equal(flattened[0]?.type, "image")
    assert.match(String(flattened.find(item => item?.type === "text")?.text || ""), /截止 2026-10-17 20:00/)
  } finally {
    config.parser_need_forward_contents = previousForward
  }
})

test("theme resources load concurrently with a per-render ceiling and stable order", async () => {
  const parser = new TwitterParser()
  const pixel = path.join(resourcesDir, "fallback_pic", "1.jpg")
  let active = 0
  let peak = 0
  const content = Array.from({ length: 20 }, (_, index) => new GraphicContent(
    new PathTask(async () => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise(resolve => setTimeout(resolve, 5))
      active -= 1
      return pixel
    }, "render-resource-" + index),
    { alt: "item-" + index },
  ))
  const data = await buildThemeData(parser.result({ content }), { appendQrcode: false })
  assert(peak > 1)
  assert(peak <= MAX_CONCURRENT_RESOURCES)
  assert.deepEqual(data.post.content.map(item => item.alt), content.map(item => item.alt))
})

test("Bilibili credential checks and refreshes only once for concurrent callers", async () => {
  const api = new BilibiliApi()
  api.configuredCookie = config.parser_bili_ck
  api.cookies = { SESSDATA: "fixture", bili_jct: "csrf", ac_time_value: "refresh" }
  api.initPromise = Promise.resolve(api.cookies)
  let validations = 0
  let refreshes = 0
  api.checkValid = async () => {
    validations += 1
    await new Promise(resolve => setTimeout(resolve, 5))
    return true
  }
  api.refreshIfNeeded = async () => {
    refreshes += 1
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  const values = await Promise.all(Array.from({ length: 12 }, () => api.credential()))
  assert.equal(validations, 1)
  assert.equal(refreshes, 1)
  assert(values.every(value => value === api.cookies))
})

test("known combined media size blocks work before download and actual size is rechecked", async () => {
  const previousMaximum = config.parser_max_size
  let started = 0
  const media = new VideoContent(new PathTask(async () => {
    started += 1
    return path.join(resourcesDir, "fallback_pic", "1.jpg")
  }, "size-limit"))
  try {
    config.parser_max_size = 1
    media.sizeBytes = 2 * 1024 * 1024
    await assert.rejects(media.getPath(), /过大/)
    assert.equal(started, 0)
    media.sizeBytes = null
    config.parser_max_size = 0.000001
    await assert.rejects(media.getPath(), /过大/)
    assert.equal(started, 1)
  } finally {
    config.parser_max_size = previousMaximum
  }
})

test("Kuaishou mobile routes accept alphabetic photo identifiers", () => {
  clearRegistryForTests()
  registerParser(KuaishouParser)
  assert.equal(matchUrl("https://m.gifshow.com/fw/photo/AbC123")?.method, "parse")
})

test("QQ Music exposes deterministic routes and decryption helpers", async () => {
  clearRegistryForTests()
  registerParser(QQMusicParser)
  assert.equal(
    matchUrl("https://y.qq.com/n/ryqq_v2/songDetail/0039MnYb0qxYhV")?.method,
    "parseMid",
  )
  assert.equal(
    matchUrl("https://i2.y.qq.com/n3/other/pages/playsong/index.html?ADTAG=wrong&songmid=0039MnYb0qxYhV"),
    null,
  )
  assert.equal(qqMusicOutputExtension("fixture.mgg"), ".ogg")
  assert.equal(validateQqAudio(Buffer.from("OggS synthetic"), ".ogg"), true)
  assert.equal(typeof decryptQqMusicFile, "function")

  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "yunzai-qqmusic-interface-"))
  const unsupported = path.join(directory, "fixture.wav")
  try {
    await fs.promises.writeFile(unsupported, "OggS synthetic")
    await assert.rejects(decryptQqMusicFile(unsupported, ""), /不支持|unsupported/i)
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true })
  }
})

let failures = 0
for (const item of tests) {
  try {
    await item.run()
    console.log("PASS " + item.name)
  } catch (error) {
    failures += 1
    console.error("FAIL " + item.name)
    console.error(error)
  }
}
if (failures) process.exit(1)
console.log(`Upstream 2026 sync: ${tests.length} tests passed`)
