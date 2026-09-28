import assert from "node:assert/strict"
import crypto from "node:crypto"
import zlib from "node:zlib"
import { BilibiliParser, selectBilibiliStreams } from "../lib/parsers/bilibili.js"
import { BilibiliApi, biliApi } from "../lib/parsers/bilibili-api.js"
import { biliProtoType, decodeBiliFrame, biliGrpcHeaders, signBiliApp, bvToAv, avToBv, BILI_APP } from "../lib/parsers/bilibili-rpc.js"
import { buildBiliPost, buildBiliComments } from "../lib/parsers/bilibili-content.js"
import { isBiliPcdn, biliSourceDomain, sanitizeBiliStreamUrls, probeBiliSourceSize } from "../lib/parsers/bilibili-cdn.js"
import { registerParser, matchUrl, clearRegistryForTests } from "../lib/core/registry.js"
import { config } from "../lib/core/config.js"
import { StickerContent, ImageContent, LinkContent } from "../lib/core/model.js"

const tests = []
const test = (name, run) => tests.push({ name, run })
const source = (quality, codec = 7) => ({
  info: { quality }, dash: { url: "https://cdn.bilivideo.com/v-" + quality, codec, backups: [] },
})

test("AV/BV conversion is lossless without floating-point truncation", () => {
  for (const aid of ["17", "7654321", "900000000000123", "2251799813685247"]) {
    assert.equal(bvToAv(avToBv(aid)), aid)
  }
  assert.throws(() => bvToAv("BV0invalid"))
  assert.throws(() => avToBv("2251799813685248"))
})

test("Independent wire fields retain int64 identifiers and skip unknown fields", () => {
  const type = biliProtoType("PostIdentity")
  // A wire-level string in field 1 followed by an unknown varint in field 100.
  const id = "1244417412014538000"
  const bytes = Buffer.concat([Buffer.from([10, id.length]), Buffer.from(id), Buffer.from([160, 6, 1])])
  assert.equal(type.toObject(type.decode(bytes)).id, id)
  const request = biliProtoType("ArticleRequest")
  const raw = request.encode(request.fromObject({ id, kind: 1 })).finish()
  assert.equal(request.toObject(request.decode(raw), { longs: String }).id, id)
})

test("gRPC framing validates length, flags, compression and expansion limits", () => {
  const plain = Buffer.from("synthetic binary response")
  const frame = body => {
    const buffer = Buffer.alloc(body.length + 5)
    buffer.writeUInt32BE(body.length, 1)
    body.copy(buffer, 5)
    return buffer
  }
  assert.deepEqual(decodeBiliFrame(frame(plain)), plain)
  const packed = frame(zlib.gzipSync(plain)); packed[0] = 1
  assert.deepEqual(decodeBiliFrame(packed, "gzip"), plain)
  assert.throws(() => decodeBiliFrame(Buffer.from([0, 0, 0])))
  assert.throws(() => decodeBiliFrame(packed, "br"))
  assert.throws(() => decodeBiliFrame(packed.subarray(0, 7), "gzip"))
  assert.throws(() => decodeBiliFrame(packed, "gzip", 4))
})

test("App signing is sorted, stable and correctly encodes reserved characters", () => {
  const signed = signBiliApp({ keyword: "a * ~", z: 1 }, { common: false, now: 0 })
  const query = "appkey=" + BILI_APP.appkey + "&keyword=a+%2A+~&ts=0&z=1"
  assert.equal(signed.sign, crypto.createHash("md5").update(query + BILI_APP.secret).digest("hex"))
  assert.deepEqual(signed, signBiliApp({ z: 1, keyword: "a * ~" }, { common: false, now: 0 }))
})

test("gRPC authentication is optional and device metadata uses native protobuf", () => {
  assert.equal(biliGrpcHeaders().authorization, undefined)
  const headers = biliGrpcHeaders("synthetic-access-value", "42")
  assert.equal(headers.authorization, "identify_v1 synthetic-access-value")
  assert.equal(headers["x-bili-mid"], "42")
  const session = biliProtoType("Session")
  const decoded = session.decode(Buffer.from(headers["x-bili-metadata-bin"], "base64"))
  assert.equal(decoded.accessKey, "synthetic-access-value")
  assert.equal(decoded.app, "android_hd")
  assert.equal(biliProtoType("Network").decode(Buffer.from(headers["x-bili-network-bin"], "base64")).kind, 1)
})

test("Playback respects video caps, codec priority and ranked audio caps", () => {
  const data = { media: {
    video: [source(80, 12), source(80, 7), source(120), source(125), source(126)],
    audio: [
      { quality: 30216, url: "low" }, { quality: 30280, url: "standard" },
      { quality: 30251, url: "lossless" }, { quality: 30250, url: "dolby" },
    ],
  } }
  let selected = selectBilibiliStreams(data, 127, ["avc", "hev"], 30280)
  assert.equal(selected.video.id, 120)
  assert.equal(selected.audio.baseUrl, "standard")
  selected = selectBilibiliStreams(data, 80, ["avc", "hev"], 30251)
  assert.equal(selected.video.codecs, "avc")
  assert.equal(selected.audio.baseUrl, "lossless")
  assert.equal(selectBilibiliStreams(data, 16, ["avc"], 30216).video, undefined)
  assert.equal(selectBilibiliStreams(data, 80, ["avc"], 30250).audio.baseUrl, "dolby")
  assert.equal(selectBilibiliStreams({ media: { video: [], audio: [] } }, 80, ["avc"], 30280).audio, null)
})

test("Progressive streams preserve fallback URLs", () => {
  const selected = selectBilibiliStreams({ media: { video: [{
    info: { quality: 32, format: "mp4" },
    segments: { items: [{ url: "https://cdn.bilivideo.com/file.mp4", backups: ["https://backup.bilivideo.com/file.mp4"] }] },
  }] } }, 80, ["avc"], 30280)
  assert.equal(selected.video.baseUrl, "https://cdn.bilivideo.com/file.mp4")
  assert.equal(selected.video.backupUrl.length, 1)
  assert.equal(selected.audio, null)
})

test("PCDN detection covers public IPs, peer domains, ports and query hints", () => {
  for (const url of [
    "https://203.0.113.1/file", "https://node.mcdn.bilivideo.net/file",
    "https://a.nexusedgeio.com/file", "https://a.ahdohpiechei.com/file",
    "https://upos-sz-mirror14b.bilivideo.com/file", "https://clean.bilivideo.com:448/file",
    "https://clean.bilivideo.com/file?os=mcdn", "https://upos-sz-302.bilivideo.com/file",
  ]) assert.equal(isBiliPcdn(url), true, url)
  assert.equal(isBiliPcdn("https://upos-sz-mirrorcos.bilivideo.com/file"), false)
  const peer = "https://node.szbdyd.com/file?xy_usource=https%3A%2F%2Fupos-sz-mirrorcos.bilivideo.com"
  assert.equal(biliSourceDomain(peer), "upos-sz-mirrorcos.bilivideo.com")
  assert.equal(biliSourceDomain("https://node.szbdyd.com/file?xy_usource=untrusted.invalid"), null)
  assert.equal(new URL(sanitizeBiliStreamUrls({ url: peer }, { region: "proxy" })[0]).hostname, "upos-sz-mirrorcos.bilivideo.com")
  assert.equal(new URL(sanitizeBiliStreamUrls({ url: "https://clean.bilivideo.com/file" }, { region: "proxy" })[0]).hostname, "proxy-tf-all-ws.bilivideo.com")
})

test("Source size probing continues across failed or zero-length routes", async () => {
  const attempts = []
  assert.equal(await probeBiliSourceSize(["a", "b", "c", "d"], async url => {
    attempts.push(url)
    if (url === "a") throw new Error("unavailable")
    return url === "b" ? 0 : 1024
  }), 1024)
  assert.deepEqual(attempts, ["a", "b", "c"])
  assert.equal(await probeBiliSourceSize(null, async () => assert.fail()), null)
})

test("Post and article blocks keep text, stickers, galleries, cards and repost order", () => {
  const parser = new BilibiliParser()
  const item = { identity: { id: "900000000000000001" }, blocks: [
    { author: { id: "42", dateLabel: "2026年09月01日 12:00", profile: { name: "Example", avatar: "https://example.invalid/avatar.png" } } },
    { description: { nodes: [{ text: "before " }, { kind: 9, text: "[smile]", url: "https://example.invalid/sticker.png" }, { text: " after" }] } },
    { media: { gallery: { images: [{ url: "https://example.invalid/photo.png" }] }, video: { title: "Video", aid: "17", cover: "https://example.invalid/cover.png" } } },
    { media: { forwarded: { post: { identity: { id: "900000000000000002" }, blocks: [{ description: { text: "quote" } }] } } } },
    { counts: { shares: "3", likes: "4", comments: "5" } },
  ] }
  const result = buildBiliPost(parser, item)
  assert.equal(result.contentId, item.identity.id)
  assert.equal(result.author.id, "42")
  assert.equal(result.timestamp, Date.parse("2026-09-01T12:00:00+08:00") / 1000)
  assert.equal(result.content[0], "before ")
  assert.ok(result.content[1] instanceof StickerContent)
  assert.equal(result.content[2], " after")
  assert.ok(result.content[3] instanceof LinkContent)
  assert.ok(result.content[4] instanceof ImageContent)
  assert.equal(result.repost.content[0], "quote")
  assert.equal(result.stats.likeCount, "4")
  for (const media of result.allMedia) assert.equal(media.pathTask.promise, null)
  const article = buildBiliPost(parser, { id: "900000000000000003", blocks: [
    { paragraph: { heading: true, paragraph: { text: { nodes: [{ word: { text: "Heading" } }] } } } },
    { paragraph: { paragraph: { text: { nodes: [{ word: { text: "A" } }, { sticker: { url: "https://example.invalid/emoji.png", label: { text: "[ok]" } } }, { link: { label: { text: "B" }, url: "https://example.invalid" } }] } } } },
    { paragraph: { paragraph: { pictures: { gallery: { images: [{ url: "https://example.invalid/a.png" }] } } } } },
  ] }, { article: true })
  assert.equal(article.title, "Heading")
  assert.equal(article.content[0], "A")
  assert.ok(article.content[1] instanceof StickerContent)
  assert.equal(article.content[2], "B")
  assert.equal(article.content[3], "\n")
  assert.ok(article.content[4] instanceof ImageContent)
})

test("Comment processing pins, deduplicates and preserves reply authors and emotes", () => {
  const parser = new BilibiliParser()
  const reply = (id, likes) => ({ id, likes, author: { id: "42", name: "Example" }, body: { text: "Hello [ok]", emotes: { "[ok]": { url: "https://example.invalid/emoji.png", size: 1 } } } })
  const pinned = reply("1", 0)
  pinned.replies = [reply("4", 1)]
  const comments = buildBiliComments(parser, { pinned, top: [pinned, reply("2", 10)], replies: [reply("3", 20)] }, 3)
  assert.equal(comments.length, 3)
  assert.equal(comments[0].stats.likeCount, 0)
  assert.equal(comments[1].stats.likeCount, 20)
  assert.ok(comments[0].content[1] instanceof StickerContent)
  assert.equal(comments[0].replies[0].parentAuthor, comments[0].author)
})

test("New URL routes support episodes, seasons, watchlater, search and users", () => {
  clearRegistryForTests()
  registerParser(BilibiliParser)
  for (const [url, method] of [
    ["https://www.bilibili.com/bangumi/play/ep17", "parseBangumiMatch"],
    ["https://www.bilibili.com/bangumi/play/ss17", "parseBangumiMatch"],
    ["https://www.bilibili.com/list/watchlater?bvid=" + avToBv("17") + "&p=2", "parseWatchlater"],
    ["https://search.bilibili.com/all?keyword=synthetic", "parseSearch"],
    ["https://space.bilibili.com/17", "parseUserMatch"],
    ["https://space.bilibili.com/17/favlist?fid=42", "parseFavMatch"],
  ]) assert.equal(matchUrl(url)?.method, method, url)
  const id = "900000000000000017"
  assert.equal(matchUrl("https://t.bilibili.com/" + id).match.groups.dynamicId, id)
})

test("API methods build the native request contracts without media downloads", async () => {
  const api = new BilibiliApi(), calls = []
  api.grpc = async (...args) => { calls.push(args); return {} }
  api.appJson = async (...args) => { calls.push(args); return {} }
  await api.postDetail("900000000000000017")
  assert.equal(calls.at(-1)[3].id, "900000000000000017")
  await api.playback({ aid: "17", cid: "18", quality: 120, codecs: ["av01"] })
  assert.equal(calls.at(-1)[3].codec, 3)
  assert.equal(calls.at(-1)[3].allow4k, true)
  await api.search("query", { type: 2 })
  assert.equal(calls.at(-1)[1].type, 2)
  assert.equal(calls.at(-1)[1].highlight, 1)
  await api.userVideos("17", { aid: "18" })
  assert.equal(calls.at(-1)[1].aid, "18")
  await api.userDynamics("17", { cursor: "next", page: 2 })
  assert.equal(calls.at(-1)[3].cursor, "next")
  await api.bangumi({ seasonId: "17" })
  assert.equal(calls.at(-1)[1].season_id, "17")
  assert.throws(() => api.search(" ", {}))
  assert.throws(() => api.userVideos("17", { pageSize: -1 }))
})

test("Access Key settings are read on every call and app QR state remains compatible", async () => {
  const original = config.parser_bili_access_key
  try {
    const api = new BilibiliApi()
    config.parser_bili_access_key = "synthetic-one"
    assert.equal((await api.accessCredential()).accessKey, "synthetic-one")
    config.parser_bili_access_key = "synthetic-two"
    assert.equal((await api.accessCredential()).accessKey, "synthetic-two")
    let accepted = false
    api.acceptAppCredential = () => { accepted = true }
    api.json = async url => url.endsWith("/auth_code") ? { url: "https://example.invalid/login", auth_code: "synthetic" } : { code: 0, data: {} }
    const login = await api.startQrLogin()
    assert.equal(login.key, "app:synthetic")
    assert.equal((await api.pollQrLogin(login.key)).code, 0)
    assert.equal(accepted, true)
    api.json = async () => { throw new Error("offline") }
    api.startWebQrLogin = async () => ({ key: "web" })
    assert.equal((await api.startQrLogin()).key, "web")
  } finally { config.parser_bili_access_key = original }
})

test("Video metadata keeps lazy tasks, selected page identity and source size", async () => {
  const parser = new BilibiliParser()
  parser.readyCredential = async () => null
  parser.videoInfo = async () => ({
    aid: "17", bvid: avToBv("17"), title: "Synthetic video", duration: 10,
    pic: "https://example.invalid/cover.png", owner: { mid: "42", name: "Author" },
    pages: [{ cid: "18", duration: 10, part: "One" }],
  })
  parser.extractDownloadStreams = async () => ({ videoUrls: ["https://example.invalid/video"], audioUrls: null, sourceSize: 1024 })
  parser.fetchComments = async () => []
  const result = await parser.parseVideo({ bvid: avToBv("17"), pageNum: 40 })
  assert.equal(result.contentId, avToBv("17") + ":0")
  assert.equal(result.video.pathTask.promise, null)
  assert.equal(result.video.cover.promise, null)
  assert.equal(result.video.sizeBytes, 1024)
  assert.match(result.embedUrl, /p=1$/)
})

test("Native dynamic and Opus routes retain exact identities and comment types", async () => {
  const previousPost = biliApi.postDetail, previousArticle = biliApi.articleDetail
  try {
    const parser = new BilibiliParser(), kinds = []
    parser.readyCredential = async () => null
    parser.fetchComments = async (id, kind) => { kinds.push(kind); return [] }
    biliApi.postDetail = async id => ({ post: { kind: 7, identity: { id }, blocks: [] } })
    biliApi.articleDetail = async id => ({ article: { id, kind: 1, originalId: "42", blocks: [{ paragraph: { paragraph: { text: { nodes: [{ word: { text: "Article" } }] } } } }] } })
    const result = await parser.parseDynamicOrOpus("900000000000000017")
    assert.equal(result.contentId, "900000000000000017")
    assert.equal(result.content[0], "Article")
    assert.deepEqual(kinds, [12])
  } finally { biliApi.postDetail = previousPost; biliApi.articleDetail = previousArticle }
})

let passed = 0
for (const { name, run } of tests) {
  try { await run(); passed++; console.log("✓ " + name) }
  catch (error) { console.error("✗ " + name); console.error(error); process.exitCode = 1 }
}
console.log(passed + "/" + tests.length + " Bilibili tests passed")
