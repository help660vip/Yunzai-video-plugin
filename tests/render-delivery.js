import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import http from "node:http"
import { config } from "../lib/core/config.js"
import { ffmpeg } from "../lib/core/ffmpeg.js"
import { cacheDir } from "../lib/core/paths.js"
import { cacheLifecycle } from "../lib/core/cache-lifecycle.js"
import { Author, AudioContent, Comment, ImageContent, LinkContent, ParseResult, PathTask, PollContent, QuoteContent, Stats, VideoContent } from "../lib/core/model.js"
import { buildMediaFallback, contentText, isMediaUploadError, markMediaRole, packForwardNodes, renderContents, sendForward, splitText } from "../lib/core/sender.js"
import { buildThemeData } from "../lib/render/context.js"
import { listThemes, renderThemeTemplate, resolveTheme, safeThemeFile } from "../lib/render/theme.js"
import { captureLongCard, MAX_RENDER_PIXELS } from "../lib/render/capture.js"
import { closeRenderer, renderAndSend, renderCard } from "../lib/render/renderer.js"
import { renderFixtures } from "../scripts/render-fixtures.js"

const tests = []
const test = (name, fn) => tests.push([name, fn])
const originalConfig = { ...config }
const originalSegment = globalThis.segment
const root = await fs.mkdtemp(path.join(cacheDir, "render-unit-"))
const pixel = path.join(root, "pixel.png")
const videoFile = path.join(root, "sample.mp4")
const pixelData = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==", "base64")
await fs.writeFile(pixel, pixelData)
await fs.writeFile(videoFile, Buffer.from("synthetic-media"))
const platform = { name: "twitter", displayName: "X" }
const result = extra => new ParseResult({ platform, url: "https://example.invalid/post/1", author: new Author("Synthetic Author", { description: "Bio\nsecond line", location: "Earth" }), ...extra })
const flattenText = value => typeof value === "string" ? value : Array.isArray(value) ? value.map(flattenText).join("") : value?.type === "text" ? value.text : ""

test("theme template is data-only and escapes every insertion", () => {
  const html = renderThemeTemplate('{{#if post.title}}<h1>{{post.title}}</h1>{{/if}}{{#each post.content}}<p>{{this.text}}</p>{{/each}}{{post.constructor.name}}', { post: { title: '<script>alert(1)</script>', content: [{ text: 'A&B' }] } })
  assert.equal(html, '<h1>&lt;script&gt;alert(1)&lt;/script&gt;</h1><p>A&amp;B</p>')
  assert.throws(() => renderThemeTemplate('{{#if post.title}}', {}), /区块/)
  assert.throws(() => renderThemeTemplate('{{#each post.content}}{{/if}}', {}), /区块/)
  assert.equal(renderThemeTemplate('{{#each post.content}}{{#if this.type == "video"}}video{{else}}other{{/if}}{{/each}}', { post: { content: [{ type: "video" }, { type: "text" }] } }), "videoother")
})

test("theme discovery selects platform/music/default and rereads changed files", async () => {
  const themeRoot = path.join(root, "themes", "custom")
  await fs.mkdir(themeRoot, { recursive: true })
  await fs.writeFile(path.join(themeRoot, "theme.json"), JSON.stringify({ id: "custom", schema_version: 1, version: "1.0.0" }))
  for (const name of ["twitter", "music", "default"]) await fs.writeFile(path.join(themeRoot, name + ".html"), `<main>${name}</main>`)
  const options = { id: "custom", directories: [path.dirname(themeRoot)] }
  assert.equal((await resolveTheme("twitter", options)).template, '<main>twitter</main>')
  assert.equal((await resolveTheme("netease", options)).template, '<main>music</main>')
  assert.equal((await resolveTheme("weibo", options)).template, '<main>default</main>')
  const old = await resolveTheme("twitter", options)
  await fs.writeFile(path.join(themeRoot, "twitter.html"), '<main>updated</main>')
  assert.notEqual((await resolveTheme("twitter", options)).key, old.key)
  assert.equal((await resolveTheme("twitter", { ...options, id: "missing" })).id, "default")
  assert.equal(await safeThemeFile(themeRoot, "../pixel.png"), null)
  assert.equal(await safeThemeFile(themeRoot, pixel), null)
  assert.equal(await safeThemeFile(themeRoot, "..\\pixel.png"), null)
  const malformed = path.join(root, "themes", "broken")
  await fs.mkdir(malformed)
  await fs.writeFile(path.join(malformed, "theme.json"), '{"id":"../../escape"}')
  assert.deepEqual((await listThemes([path.dirname(themeRoot)])).map(item => item.id), ["custom", "default"])
})

test("theme context keeps order, locations, tuple stats and replies without downloading AV", async () => {
  let videoDownloads = 0
  const post = result({ content: ["first", new ImageContent(new PathTask(pixel), { layout: "x" }), "last", new VideoContent(new PathTask(() => { videoDownloads++; throw new Error("must remain lazy") }), { cover: new PathTask(pixel) })],
    stats: new Stats({ extra: { heart: ["喜欢", "12"], hot: "5" } }),
    comments: [new Comment({ author: new Author("Commenter", { location: "Moon" }), content: [new ImageContent(pixel)], replies: [new Comment({ author: new Author("Reply"), content: ["answer"] })] })] })
  const data = await buildThemeData(post, { appendQrcode: true })
  assert.deepEqual(data.post.content.map(item => item.type), ["text", "image", "text", "video"])
  assert.equal(data.post.content[1].layout, "x")
  assert.equal(data.post.author.location, "Earth")
  assert.equal(data.post.author.description, "Bio\nsecond line")
  assert.equal(data.post.stats.extra[0].label, "喜欢")
  assert.equal(data.post.comments[0].replies[0].content[0].text, "answer")
  assert.match(data.post.qrcode, /^data:image\/png/)
  assert.equal(videoDownloads, 0)
  assert.doesNotThrow(() => JSON.stringify(data))
})

test("music context recognizes cover and dynamic audio size", async () => {
  const audio = new AudioContent(() => { throw new Error("no audio download") }, { duration: 30 })
  audio.isDynamicSize = true
  const data = await buildThemeData(result({ platform: { name: "netease", displayName: "音乐" }, content: [new ImageContent(pixel), audio] }))
  assert.equal(data.post.content[0].type, "cover")
  assert.equal(data.post.content[1].size, "动态大小")
})

test("lazy summary and theme context never execute a video-derived cover task", async () => {
  let downloads = 0
  const video = new PathTask(async () => { downloads++; return videoFile })
  const cover = new PathTask(async () => { await video.get(); return pixel })
  cover.requiresMedia = true
  const post = result({ content: [new VideoContent(video, { cover })] })
  Object.assign(config, { parser_render_type: "default", parser_lazy_download: true, parser_summary_in_forward: true })
  const replies = []
  await renderAndSend({ reply: async message => replies.push(message) }, post, { sendContents: false })
  await buildThemeData(post)
  await post.ensureDownloadsComplete({ imgOnly: true })
  assert.equal(downloads, 0)
  assert.equal(replies.length, 1)
  config.parser_lazy_download = false
})

test("text splitting preserves punctuation, surrogate pairs and original content", () => {
  const source = '一二。😀😀test!尾部'
  const parts = splitText(source, 4)
  assert.equal(parts.join(''), source)
  assert(parts.every(part => [...part].length <= 4 && !/[\uD800-\uDBFF]$/.test(part)))
  assert.equal(parts[0], '一二。')
})

test("forward packets honor node/text caps and protected poll blocks", () => {
  config.parser_forward_text_threshold = 10
  const poll = markMediaRole({ type: "text", text: "P".repeat(100) }, "protected-text")
  const packets = packForwardNodes([poll, ...Array.from({ length: 100 }, (_, index) => "node" + index)])
  assert.equal(flattenText(packets[0][0]).length, 100)
  assert(packets.every(packet => packet.length <= 90 && [...flattenText(packet)].length <= 30000))
  assert(packForwardNodes(["x".repeat(40000)]).length >= 2)
})

test("only explicit media-upload errors trigger fallback", () => {
  assert(isMediaUploadError(new Error("HTTP Upload failed with code 500")))
  assert(isMediaUploadError({ info: { wording: "rich media transfer failed" } }))
  assert(isMediaUploadError({ data: { msg: "Highway request timeout" } }))
  assert(!isMediaUploadError(new Error("request timeout")))
  assert(!isMediaUploadError({ retcode: 1200 }))
})

test("video fallback preserves text/images and text fallback retains source", () => {
  const image = { type: "image", file: pixel }
  const video = markMediaRole({ type: "file", file: videoFile }, "video")
  const post = result({ title: "Synthetic title" })
  const partial = buildMediaFallback([["before", image, video, "after"]], post, true)
  assert(partial.some(node => Array.isArray(node) && node.some(item => item.type === "image")))
  assert.match(flattenText(partial), /before.*after/s)
  assert.match(flattenText(partial), /example\.invalid/)
  const plain = buildMediaFallback(partial, post)
  assert(!JSON.stringify(plain).includes(pixel))
  assert.equal((flattenText(plain).match(/媒体上传失败/g) || []).length, 1)
  assert.equal(buildMediaFallback([{ type: "unknown" }], post), null)
})

test("forward retries only failed packets and survives adapter mutation", async () => {
  config.parser_forward_text_threshold = 1000
  const calls = []
  let attempts = 0
  const e = { group: { makeForwardMsg: async nodes => ({ type: "forward", nodes }) }, reply: async message => {
    calls.push(JSON.parse(JSON.stringify(message)))
    attempts++
    if (attempts === 1) { message.nodes[0].message[0] = "MUTATED"; throw new Error("HTTP Upload failed with code 500") }
    if (attempts === 2) throw new Error("rich media transfer failed")
  } }
  await sendForward(e, [["original", { type: "image", file: pixel }, { type: "video", file: videoFile }]], result({ title: "Title" }))
  assert.equal(attempts, 3)
  assert.match(JSON.stringify(calls[2]), /original/)
  assert(!JSON.stringify(calls[2]).includes('MUTATED'))
  assert(!JSON.stringify(calls[2]).includes(videoFile))
  let failures = 0
  await assert.rejects(() => sendForward({ ...e, reply: async () => { failures++; throw new Error("permission denied") } }, [{ type: "video", file: videoFile }], result({})), /permission/)
  assert.equal(failures, 1)
})

test("ordered merged delivery puts summary first, video inside and protects active files", async () => {
  Object.assign(config, { parser_summary_in_forward: true, parser_video_in_forward: true, parser_need_forward_contents: false, parser_need_upload_video: false, parser_need_upload_audio: false, parser_forward_text_threshold: 1000 })
  const output = []
  const e = { group: { makeForwardMsg: async nodes => ({ type: "forward", nodes }) }, reply: async message => {
    assert(cacheLifecycle.isActive(videoFile))
    assert(cacheLifecycle.isActive(pixel))
    output.push(message)
  } }
  const post = result({ content: ["before", new ImageContent(pixel), "after", new VideoContent(videoFile, { cover: pixel })] })
  const summary = markMediaRole({ type: "image", file: "summary" }, "summary")
  await renderContents(e, post, { summaryNode: [summary] })
  assert.equal(output.length, 1)
  assert.equal(output[0].nodes[0].message[0].file, "summary")
  const content = JSON.stringify(output[0])
  assert(content.indexOf('before') < content.indexOf(pixel.replaceAll('\\', '\\\\')))
  assert(content.includes('"type":"video"'))
  assert.equal((content.match(/Synthetic Author：/g) || []).length, 1)
  assert(!cacheLifecycle.isActive(videoFile))
})

test("upload fallback never resends an already successful forward packet", async () => {
  config.parser_forward_text_threshold = 1000
  const calls = []
  const e = { group: { makeForwardMsg: async nodes => ({ type: "forward", nodes }) }, reply: async message => {
    calls.push(message)
    if (calls.length === 2) throw new Error("HTTP Upload failed with code 500")
  } }
  await sendForward(e, [...Array.from({ length: 90 }, (_, index) => "successful-node-" + index), { type: "video", file: videoFile }], result({}))
  assert.equal(calls.length, 3)
  assert.equal(calls.filter(message => JSON.stringify(message).includes('successful-node-0')).length, 1)
})

test("plain quote/link/poll content remains meaningful", () => {
  assert.match(contentText(new QuoteContent({ title: "译文", text: "Translation" })), /译文\nTranslation/)
  assert.match(contentText(new LinkContent({ url: "https://example.invalid", title: "Link" })), /Link/)
  assert.match(contentText(new PollContent({ title: "Question", options: [{ text: "A", votes: 2 }], totalVoters: 2 })), /100\.0%/)
})

test("tile capture rejects unsafe dimensions before allocating image memory", async () => {
  await assert.rejects(() => captureLongCard({ $eval: async () => ({ width: 1600, height: 24000, x: 0, y: 0 }), viewport: () => ({ deviceScaleFactor: 2 }) }), /安全尺寸/)
  assert.equal(MAX_RENDER_PIXELS, 32000000)
})

test("documentation screenshots stay PNG with or without FFmpeg", async () => {
  const previousCompression = ffmpeg.pngToWebp
  const names = ["render-light.png", "render-dark.png"]
  const before = await Promise.all(names.map(name => fs.readFile(path.resolve("docs", "screenshots", name))))
  let compressionCalls = 0
  try {
    for (const available of [true, false]) {
      ffmpeg.pngToWebp = async () => {
        compressionCalls++
        if (!available) throw new Error("not installed")
        return Buffer.from("RIFF synthetic WEBP")
      }
      const output = path.join(root, available ? "ffmpeg-present" : "ffmpeg-absent")
      await renderFixtures(output)
      const { PNG } = await import("pngjs")
      for (const name of names) {
        const bytes = await fs.readFile(path.join(output, name))
        assert(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
        assert.equal(PNG.sync.read(bytes).width, 1504)
      }
    }
    assert.equal(compressionCalls, 0)
    for (const [index, name] of names.entries()) assert((await fs.readFile(path.resolve("docs", "screenshots", name))).equals(before[index]))
  } finally { ffmpeg.pngToWebp = previousCompression }
})

test("local theme assets render across tile boundaries without script or network access", async () => {
  let requests = 0
  const server = http.createServer((request, response) => { requests++; response.end("not permitted") })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  const themeRoot = path.join(root, "secure-theme")
  const generated = []
  const originalCompression = ffmpeg.pngToWebp
  ffmpeg.pngToWebp = async () => { throw new Error("PNG fallback fixture") }
  try {
    await fs.mkdir(themeRoot)
    await fs.writeFile(path.join(themeRoot, "theme.json"), JSON.stringify({ id: "secure", schema_version: 1 }))
    await fs.writeFile(path.join(themeRoot, "assets.css"), 'body{margin:0}main{width:400px;height:2300px;background:#c01020}main div{height:1100px;background:#10c020}')
    await fs.writeFile(path.join(themeRoot, "default.html"), `<!doctype html><html><head><link rel="stylesheet" href="assets.css"></head><body><main><div></div><img src="http://127.0.0.1:${server.address().port}/leak"><script>document.querySelector('main').style.background='blue';fetch('http://127.0.0.1:${server.address().port}/script')</script></main></body></html>`)
    Object.assign(config, { parser_theme_dirs: [themeRoot], parser_render_theme: "secure", parser_append_qrcode: false })
    const first = await renderCard(result({ title: "Synthetic" }), "common")
    generated.push(first)
    const { PNG } = await import("pngjs")
    const rendered = PNG.sync.read(await fs.readFile(first))
    assert.equal(rendered.width, 800)
    assert.equal(rendered.height, 4600)
    const rgb = (x, y) => [...rendered.data.subarray((y * rendered.width + x) * 4, (y * rendered.width + x) * 4 + 3)]
    assert.deepEqual(rgb(10, 2199), [16, 192, 32])
    assert.deepEqual(rgb(10, 2200), [192, 16, 32])
    assert.deepEqual(rgb(10, 4599), [192, 16, 32])
    assert.equal(requests, 0)
    await fs.writeFile(path.join(themeRoot, "default.html"), '{{#if broken}}')
    const fallback = await renderCard(result({ title: "Fallback" }), "common")
    generated.push(fallback)
    assert.equal(PNG.sync.read(await fs.readFile(fallback)).width, 1504)
  } finally {
    ffmpeg.pngToWebp = originalCompression
    await closeRenderer()
    await new Promise(resolve => server.close(resolve))
    for (const file of generated) await fs.unlink(file).catch(() => {})
  }
})

try {
  globalThis.segment = {}
  for (const [name, fn] of tests) { await fn(); console.log('PASS ' + name) }
  console.log(`Rendering/delivery: ${tests.length} tests passed`)
} finally {
  await closeRenderer()
  Object.assign(config, originalConfig)
  globalThis.segment = originalSegment
  // Only this test-created cache directory is removed.
  assert(path.dirname(root) === cacheDir && path.basename(root).startsWith("render-unit-"))
  await fs.rm(root, { recursive: true, force: true })
}
