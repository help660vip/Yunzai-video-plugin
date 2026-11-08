import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"

import { config } from "../lib/core/config.js"
import { cacheDir } from "../lib/core/paths.js"
import { cacheLifecycle } from "../lib/core/cache-lifecycle.js"
import { ffmpeg, normalizeMediaRanges } from "../lib/core/ffmpeg.js"
import { AudioContent, Author, ParseResult, PathTask, VideoContent } from "../lib/core/model.js"
import { mediaSpeedup, prepareResultMedia } from "../lib/core/media-preprocess.js"
import { BilibiliSponsorBlock } from "../lib/parsers/bilibili-sponsorblock.js"
import { BilibiliParser, selectBilibiliPage } from "../lib/parsers/bilibili.js"
import { BilibiliApi, biliApi } from "../lib/parsers/bilibili-api.js"
import { IgnoreError } from "../lib/core/errors.js"

const tests = []
const test = (name, run) => tests.push({ name, run })
const directory = fs.mkdtempSync(path.join(cacheDir, "media-140-"))
const created = new Set()
const originalConfig = { ...config }
const originalRun = ffmpeg.run
const originalProbe = ffmpeg.probe
let sourceCounter = 0
function source(suffix = ".mp4", size = 20) {
  const filePath = path.join(directory, "source-" + sourceCounter++ + suffix)
  fs.writeFileSync(filePath, Buffer.alloc(size, 7))
  return filePath
}
function stubProbe(hasAudio = true) {
  ffmpeg.probe = async () => ({ format: { duration: "60", bit_rate: "1128000" }, streams: [
    { codec_type: "video", bit_rate: "1000000" }, ...(hasAudio ? [{ codec_type: "audio", bit_rate: "128000" }] : []),
  ] })
}
function stubRun(inspect = () => {}) {
  ffmpeg.run = async (args, options) => {
    inspect(args, options)
    const temporary = args[args.length - 1]
    fs.writeFileSync(temporary, Buffer.alloc(10, 9))
    created.add(temporary)
    return { stdout: "", stderr: "" }
  }
}
async function remember(value) { const output = await value; created.add(output); return output }
const segment = (start, end, category = "sponsor", actionType = "skip", cid = 9) => ({ segment: [start, end], category, actionType, cid })
const query = rows => BilibiliSponsorBlock.query("BVsynthetic", 9, 60, {
  apiBase: "https://example.test/base", categories: ["sponsor", "intro", "selfpromo", "music_offtopic"],
  client: { request: async () => ({ status: 200, json: async () => rows }) },
})

test("Timeline ranges reject invalid values and merge only overlap or adjacency", () => {
  assert.deepEqual(normalizeMediaRanges([[10, 20], [15, 25], [25, 30], [40, 45], [59, 80], [-1, 2], [9, 8], [true, 2], [3, NaN], [31, 31]], 60), [[10, 30], [40, 45], [59, 60]])
})
test("SponsorBlock encodes query and filters categories and selected cid", async () => {
  let target
  const plan = await BilibiliSponsorBlock.query("BVsynthetic", 9, 60, { apiBase: "https://example.test/base/", categories: ["sponsor"], client: { request: async url => {
    target = url
    return { status: 200, json: async () => [segment(1, 5), segment(3, 7), segment(20, 30, "sponsor", "mute"), segment(1, 5, "intro"), segment(1, 5, "sponsor", "skip", 10)] }
  } } })
  assert.equal(target.pathname, "/base/api/skipSegments")
  assert.equal(target.searchParams.get("actionTypes"), '["skip","mute","full"]')
  assert.deepEqual(plan.cutRanges, [[1, 7]])
  assert.deepEqual(plan.muteRanges, [[20, 30]])
  assert.equal(plan.outputDuration, 54)
})
test("SponsorBlock full labels and whole-video cuts have distinct semantics", async () => {
  const full = await query([segment(0, 0, "sponsor", "full")])
  assert.equal(full.isFullVideoAd, true); assert.equal(full.coversEntireVideo, false)
  const music = await query([segment(0, 0, "music_offtopic", "full")])
  assert.equal(music.isFullVideoAd, false)
  const cuts = await query([segment(0, 30), segment(30, 60, "intro")])
  assert.equal(cuts.coversEntireVideo, true); assert.equal(cuts.isFullVideoAd, false)
})
test("SponsorBlock disabled and failed queries preserve the original timeline", async () => {
  const client = { request: async () => { throw new Error("offline") } }
  for (const options of [{ apiBase: null, categories: ["sponsor"] }, { apiBase: "https://example.test", categories: [] }, { apiBase: "https://example.test", categories: ["sponsor"] }]) {
    const plan = await BilibiliSponsorBlock.query("BVsynthetic", 9, 60, { ...options, client })
    assert.equal(plan.outputDuration, 60)
    assert.deepEqual(plan.cutRanges, [])
  }
})
test("Author speed rules support aliases, final overrides and lazy preparation", () => {
  config.parser_media_speedup_rules = ["x:42:1.5", "twitter:42:2"]
  assert.equal(mediaSpeedup("twitter", 42), 2)
  let downloads = 0
  const outer = new VideoContent(new PathTask(() => { downloads++; return "missing.mp4" }), { duration: 60 })
  const inner = new AudioContent(new PathTask("missing.m4a"), { duration: 120 })
  const result = new ParseResult({ platform: { name: "twitter" }, author: new Author("outer", { id: "42" }), contents: [outer], repost: new ParseResult({ platform: { name: "twitter" }, author: new Author("inner", { id: "99" }), contents: [inner] }) })
  prepareResultMedia(result)
  assert.equal(downloads, 0); assert.equal(outer.speedup, 2); assert.equal(inner.speedup, 2)
  assert.equal(inner.displayDuration, "1:00")
})
test("Video edit combines cuts, mute and speed in one source-bitrate operation", async () => {
  stubProbe()
  stubRun((args, options) => {
    const filter = args[args.indexOf("-filter_complex") + 1]
    assert.match(filter, /volume=enable='gte\(t,20\)\*lt\(t,30\)'/)
    assert.match(filter, /concat=n=2:v=1:a=1/)
    assert.match(filter, /setpts=PTS\/2/)
    assert.match(filter, /atempo=2/)
    assert.equal(args[args.indexOf("-b:v") + 1], "1000000")
    assert.equal(options.maxBytes, config.parser_max_size * 1024 * 1024)
  })
  await remember(ffmpeg.editVideo(source(), { speedRatio: 2, cutRanges: [[5, 10]], muteRanges: [[20, 30]] }))
})
test("Silent video speedup omits audio mapping and audio filters", async () => {
  stubProbe(false)
  stubRun(args => {
    assert(args.includes("-an"))
    assert.doesNotMatch(args.join(" "), /atempo|asplit|atrim/)
  })
  await remember(ffmpeg.editVideo(source(), { speedRatio: 1.5 }))
})
test("Extreme audio speed uses safe atempo stages and preserves source bitrate", async () => {
  stubProbe()
  stubRun(args => {
    assert.equal(args[args.indexOf("-af") + 1], "atempo=2,atempo=2,atempo=2,atempo=2")
    assert.equal(args[args.indexOf("-b:a") + 1], "128000")
  })
  await remember(ffmpeg.changeAudioSpeed(source(".m4a"), 16))
})
test("Stable edited cache coalesces simultaneous jobs and survives retention touches", async () => {
  stubProbe()
  let count = 0
  stubRun(() => { count++ })
  const input = source()
  const results = await Promise.all([remember(ffmpeg.editVideo(input, { speedRatio: 1.25 })), remember(ffmpeg.editVideo(input, { speedRatio: 1.25 }))])
  assert.equal(results[0], results[1]); assert.equal(count, 1)
  await fs.promises.utimes(input, new Date(), new Date(Date.now() + 10000))
  assert.equal(await remember(ffmpeg.editVideo(input, { speedRatio: 1.25 })), results[0]); assert.equal(count, 1)
})
test("Transcode concurrency is shared and source/output paths remain protected", async () => {
  config.parser_media_transcode_concurrency = 1
  stubProbe()
  let active = 0, maximum = 0
  ffmpeg.run = async args => {
    active++; maximum = Math.max(maximum, active)
    const input = args[args.indexOf("-i") + 1], temporary = args[args.length - 1]
    assert(cacheLifecycle.isActive(input)); assert(cacheLifecycle.isActive(temporary))
    await new Promise(resolve => setTimeout(resolve, 15))
    fs.writeFileSync(temporary, "synthetic")
    created.add(temporary)
    active--
  }
  await Promise.all([remember(ffmpeg.editVideo(source(), { speedRatio: 1.5 })), remember(ffmpeg.editVideo(source(), { speedRatio: 1.5 }))])
  assert.equal(maximum, 1)
})
test("Failed processing releases locks, deletes partial output and retries", async () => {
  stubProbe()
  const input = source()
  let temporary
  ffmpeg.run = async args => { temporary = args[args.length - 1]; fs.writeFileSync(temporary, "partial"); throw new Error("synthetic failure") }
  await assert.rejects(ffmpeg.editVideo(input, { speedRatio: 1.5 }))
  assert.equal(fs.existsSync(temporary), false); assert.equal(cacheLifecycle.isActive(input), false)
  stubRun()
  await remember(ffmpeg.editVideo(input, { speedRatio: 1.5 }))
})
test("Source size is checked before download and before editing", async () => {
  let downloads = 0, edits = 0
  const old = ffmpeg.editVideo
  ffmpeg.editVideo = async file => { edits++; return file }
  try {
    const media = new VideoContent(new PathTask(() => { downloads++; return source() }))
    media.speedup = 2; media.sizeBytes = config.parser_max_size * 1024 * 1024 + 1
    await assert.rejects(media.getPath(), IgnoreError)
    assert.equal(downloads, 0); assert.equal(edits, 0)
    config.parser_max_size = 0.000001
    const downloaded = new VideoContent(new PathTask(source()))
    downloaded.speedup = 2
    await assert.rejects(downloaded.getPath(), IgnoreError)
    assert.equal(edits, 0)
  } finally { ffmpeg.editVideo = old; config.parser_max_size = originalConfig.parser_max_size }
})
test("Oversized edited output is rejected and its temporary file is removed", async () => {
  stubProbe()
  let temporary
  ffmpeg.run = async args => { temporary = args[args.length - 1]; fs.writeFileSync(temporary, Buffer.alloc(1024)) }
  await assert.rejects(ffmpeg.editVideo(source(), { speedRatio: 2, maxSizeMb: 0.0001 }), IgnoreError)
  assert.equal(fs.existsSync(temporary), false)
})
test("Processing failure falls back to source and resets displayed planned edits", async () => {
  stubProbe()
  ffmpeg.run = async () => { throw new Error("synthetic processing failure") }
  const input = source()
  const media = new VideoContent(new PathTask(input), { duration: 60 })
  media.speedup = 2; media.cutRanges = [[1, 3]]
  assert.equal(await media.getPath(), input)
  assert.equal(media.speedup, 1); assert.deepEqual(media.cutRanges, [])
})
test("Single-part video duration uses the selected page metadata", () => {
  assert.equal(selectBilibiliPage({ duration: 900, pages: [{ cid: 9, duration: 120 }] }).duration, 120)
})
test("Configured app token never borrows a different cookie account's identity", async () => {
  const api = new BilibiliApi()
  api.cookies = { DedeUserID: "42" }
  config.parser_bili_access_key = "synthetic-token"
  assert.deepEqual(await api.accessCredential(), { accessKey: "synthetic-token", mid: null })
  config.parser_bili_access_key = originalConfig.parser_bili_access_key
})
test("Bilibili account blacklist requests carry app signing and independent token", async () => {
  const api = new BilibiliApi()
  api.accessCredential = async () => ({ accessKey: "synthetic-token", mid: "77" })
  let options
  api.json = async (_, opts) => { options = opts; return { list: [] } }
  await api.blackList(2, 50)
  assert.equal(options.params.access_key, "synthetic-token")
  assert.equal(options.params.pn, "2")
  assert.match(options.params.sign, /^[a-f0-9]{32}$/)
})
test("Dynamic identity survives an embedded video and still provides lazy media", async () => {
  const parser = new BilibiliParser()
  const oldPost = biliApi.postDetail
  parser.readyCredential = async () => null
  parser.raiseIfBlocked = async () => {}
  parser.fetchComments = async () => []
  const video = new VideoContent(new PathTask("missing.mp4"))
  parser.parseVideo = async () => parser.result({ contentId: "BVsynthetic:0", url: "https://www.bilibili.com/video/BVsynthetic", contents: [video] })
  biliApi.postDetail = async () => ({ post: { kind: 2, blocks: [{ author: { id: "42", profile: { name: "author" } } }, { media: { video: { bvid: "BVsynthetic", aid: "17", title: "video" } } }] } })
  try {
    const result = await parser.parseDynamicOrOpus("123456")
    assert.equal(result.url, "https://t.bilibili.com/123456"); assert.equal(result.contentId, "123456")
    assert.equal(result.author.id, "42"); assert(result.allMedia.includes(video))
  } finally { biliApi.postDetail = oldPost }
})
test("Whole-video skip retains its cover and notice without starting media downloads", async () => {
  const parser = new BilibiliParser()
  const oldQuery = BilibiliSponsorBlock.query
  let downloads = 0
  parser.readyCredential = async () => null
  parser.raiseIfBlocked = async () => {}
  parser.videoInfo = async () => ({ bvid: "BVsynthetic", aid: 17, duration: 900, desc: "description", pages: [{ cid: 9, duration: 60 }], owner: { name: "author" } })
  parser.extractDownloadStreams = async () => ({ videoUrls: ["https://example.test/video.mp4"], sourceSize: 20 })
  parser.fetchComments = async () => []
  parser.downloader = { download: async () => { downloads++; return "missing.mp4" } }
  BilibiliSponsorBlock.query = async () => new BilibiliSponsorBlock(60, [{ start: 0, end: 60, category: "intro", actionType: "skip", cid: 9 }])
  try {
    const result = await parser.parseVideo({ bvid: "BVsynthetic" })
    const media = result.allMedia[0]
    assert.equal(media.needSend, false)
    assert.match(result.text, /空降标注覆盖整条视频/)
    await assert.rejects(media.pathTask.get(), /空降区间覆盖整条视频/)
    assert.equal(downloads, 0)
  } finally { BilibiliSponsorBlock.query = oldQuery }
})

test("gRPC keeps cookie account identity separate from the app token owner", async () => {
  const api = new BilibiliApi()
  api.cookies = { DedeUserID: "42" }
  api.accessCredential = async () => ({ accessKey: "synthetic", mid: "99" })
  assert.deepEqual(await api.grpcCredential(), { accessKey: "synthetic", mid: "99", dedeuserid: "42" })
  api.cookies = null
  assert.equal((await api.grpcCredential()).dedeuserid, "")
})

try {
  for (const { name, run } of tests) {
    ffmpeg.run = originalRun; ffmpeg.probe = originalProbe
    await run()
    console.log("ok - " + name)
  }
  console.log(`Media 1.4.0 tests passed (${tests.length}/${tests.length})`)
} finally {
  ffmpeg.run = originalRun; ffmpeg.probe = originalProbe
  Object.assign(config, originalConfig)
  for (const filePath of created) if (filePath.startsWith(cacheDir + path.sep)) await fs.promises.unlink(filePath).catch(() => {})
  for (const entry of await fs.promises.readdir(directory)) await fs.promises.unlink(path.join(directory, entry))
  await fs.promises.rmdir(directory)
}
