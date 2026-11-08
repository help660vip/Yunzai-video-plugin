import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { EventEmitter } from "node:events"
import { PNG } from "pngjs"
import { config } from "../lib/core/config.js"
import { cacheDir } from "../lib/core/paths.js"
import { cacheIndex } from "../lib/core/cache-index.js"
import { ffmpeg } from "../lib/core/ffmpeg.js"
import { AudioContent, GraphicContent, ImageContent, LivePhotoContent, ParseResult, PathTask, VideoContent } from "../lib/core/model.js"
import { buildThemeData, PLACEHOLDER_IMAGE, serializeContent } from "../lib/render/context.js"
import { captureLongCard } from "../lib/render/capture.js"
import { effectiveRenderFormat, imageDimensions } from "../lib/render/image.js"
import { listThemes, resolveTheme, warmupThemes } from "../lib/render/theme.js"
import { browserManager } from "../lib/render/browser-manager.js"
import { renderAndSend, renderCard } from "../lib/render/renderer.js"

const tests = []
const test = (name, run) => tests.push([name, run])
const snapshot = { config: { ...config }, withPage: browserManager.withPage, jpeg: ffmpeg.pngToJpeg, webp: ffmpeg.pngToWebp }
const root = await fs.mkdtemp(path.join(cacheDir, "render-140-"))
const files = new Set(), pages = []
const localImage = path.join(root, "image.png")
await fs.writeFile(localImage, PNG.sync.write(new PNG({ width: 12, height: 8 })))

function post(title, extra = {}) {
  return new ParseResult({ platform: { name: "bilibili", displayName: "示例平台" }, title: title + path.basename(root),
    url: "https://example.invalid/content", text: "固定示例", ...extra })
}

function mockBrowser({ width = 3, height = 3 } = {}) {
  browserManager.withPage = async (_event, run) => {
    const page = new EventEmitter()
    Object.assign(page, {
      html: "", scale: 1, async setJavaScriptEnabled() {}, async setRequestInterception() {},
      async setViewport(value) { this.scale = value.deviceScaleFactor }, async goto() {},
      async setContent(html) { this.html = html }, async evaluate() {}, async $() { return null },
      async $eval() { return { x: 0, y: 0, width, height } }, viewport() { return { deviceScaleFactor: this.scale } },
      async screenshot({ clip }) { return PNG.sync.write(new PNG({ width: Math.ceil(clip.width * this.scale), height: Math.ceil(clip.height * this.scale) })) },
    })
    pages.push(page)
    return run(page)
  }
}

async function render(result, format = "png") {
  const file = await renderCard(result, "common", { format })
  files.add(file)
  return file
}

test("image headers expose dimensions, aspect ratio and the 0.9 portrait threshold", () => {
  const png = PNG.sync.write(new PNG({ width: 10, height: 9 }))
  assert.deepEqual(imageDimensions(png), { width: 10, height: 9, aspect_ratio: 10 / 9, orientation: "portrait" })
  const gif = Buffer.from("47494638396120001000", "hex")
  assert.deepEqual(imageDimensions(gif), { width: 32, height: 16, aspect_ratio: 2, orientation: "landscape" })
  assert.deepEqual(imageDimensions(Buffer.from("<svg viewBox='0 0 80 40'></svg>")), { width: 80, height: 40, aspect_ratio: 2, orientation: "landscape" })
  assert.deepEqual(imageDimensions(Buffer.from("not an image")), {})
})

test("JPEG EXIF rotation and extended WebP canvas dimensions are honored", () => {
  const exif = Buffer.alloc(32)
  exif.write("Exif\0\0"); exif.write("II", 6); exif.writeUInt16LE(42, 8); exif.writeUInt32LE(8, 10)
  exif.writeUInt16LE(1, 14); exif.writeUInt16LE(274, 16); exif.writeUInt16LE(3, 18)
  exif.writeUInt32LE(1, 20); exif.writeUInt16LE(6, 24)
  const app = Buffer.alloc(4); app[0] = 0xff; app[1] = 0xe1; app.writeUInt16BE(exif.length + 2, 2)
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), app, exif, Buffer.from([0xff, 0xc0, 0, 11, 8, 0, 10, 0, 30, 1, 1, 0x11, 0, 0xff, 0xd9])])
  assert.deepEqual(imageDimensions(jpeg), { width: 10, height: 30, aspect_ratio: 1 / 3, orientation: "portrait" })
  const webp = Buffer.alloc(30)
  webp.write("RIFF"); webp.writeUInt32LE(22, 4); webp.write("WEBPVP8X", 8); webp.writeUInt32LE(10, 16)
  webp.writeUIntLE(639, 24, 3); webp.writeUIntLE(359, 27, 3)
  assert.deepEqual(imageDimensions(webp), { width: 640, height: 360, aspect_ratio: 640 / 360, orientation: "landscape" })
  assert.deepEqual(imageDimensions(jpeg.subarray(0, 15)), {})
})

test("image, graphic, cover and Live Photo metadata remain lazy for video downloads", async () => {
  let downloads = 0
  const image = new ImageContent(localImage), graphic = new GraphicContent(localImage)
  const live = new LivePhotoContent(new PathTask(() => { downloads++; throw Error("must remain lazy") }), { baseImage: localImage })
  for (const item of [image, graphic, live]) {
    const value = await serializeContent(item)
    assert.equal(value.width, 12); assert.equal(value.height, 8); assert.equal(value.orientation, "landscape")
  }
  assert.equal((await serializeContent(graphic, true)).type, "cover")
  assert.equal(downloads, 0)
  const missing = await serializeContent(new ImageContent(path.join(root, "missing.png")))
  assert.equal(missing.src, PLACEHOLDER_IMAGE); assert.equal(missing.width, undefined)
})

test("theme media exposes adjusted duration and speedup without starting its media task", async () => {
  let downloads = 0
  const task = new PathTask(() => { downloads++; throw Error("must remain lazy") })
  const audio = new AudioContent(task, { duration: 180 }), video = new VideoContent(task, { duration: 120 })
  audio.speedup = 2; video.speedup = 1.25
  assert.equal((await serializeContent(audio)).speedup, "2x")
  assert.equal((await serializeContent(audio)).duration, "1:30")
  assert.equal((await serializeContent(video)).speedup, "1.25x")
  assert.equal((await serializeContent(new AudioContent(task))).speedup, null)
  assert.equal(downloads, 0)
})

test("long-card tiles stitch every row in order and reject unsafe canvas sizes", async () => {
  const shots = []
  const page = {
    async $eval() { return { x: 2, y: 7, width: 3, height: 2005 } }, viewport: () => ({ deviceScaleFactor: 1 }),
    async screenshot({ clip }) {
      shots.push(clip)
      const image = new PNG({ width: clip.width, height: clip.height })
      for (let row = 0; row < clip.height; row++) {
        for (let column = 0; column < clip.width; column++) {
          const index = (row * clip.width + column) * 4
          image.data[index] = (clip.y - 7 + row) % 251; image.data[index + 3] = 255
        }
      }
      return PNG.sync.write(image)
    },
  }
  const image = PNG.sync.read(await captureLongCard(page))
  assert.deepEqual(shots.map(clip => clip.height), [1000, 1000, 5])
  for (let row = 0; row < 2005; row++) assert.equal(image.data[row * 3 * 4], row % 251)
  page.$eval = async () => ({ x: 0, y: 0, width: 752, height: 24001 })
  await assert.rejects(captureLongCard(page), RangeError)
})

test("WebP's physical 16383 pixel bound selects JPEG, with PNG encoding fallback", async () => {
  assert.equal(effectiveRenderFormat("webp", { width: 16383, height: 20 }), "webp")
  assert.equal(effectiveRenderFormat("webp", { width: 20, height: 16384 }), "jpeg")
  assert.equal(effectiveRenderFormat("auto", { width: 16384, height: 20 }), "jpeg")
  assert.equal(effectiveRenderFormat("png", { width: 20, height: 16384 }), "png")
  let jpeg = 0, webp = 0
  ffmpeg.pngToJpeg = async () => { jpeg++; throw Error("synthetic encoder unavailable") }
  ffmpeg.pngToWebp = async () => { webp++; throw Error("unexpected WebP encoder call") }
  mockBrowser({ width: 2, height: 8200 })
  const file = await render(post("oversized-webp"), "webp")
  assert.equal(path.extname(file), ".png"); assert.equal(jpeg, 1); assert.equal(webp, 0)
})

test("theme warmup caches discovery while manifest, additions and CSS stay hot", async () => {
  const themes = path.join(root, "themes"), directory = path.join(themes, "sample")
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(path.join(directory, "theme.json"), JSON.stringify({ id: "sample", desc: "正式主题示例" }))
  await fs.writeFile(path.join(directory, "default.html"), "<main>{{post.title}}</main>")
  config.parser_theme_dirs = [themes]
  await warmupThemes()
  assert.equal((await listThemes()).find(theme => theme.id === "sample").description, "正式主题示例")
  const first = await resolveTheme("bilibili", { id: "sample" })
  await fs.writeFile(path.join(directory, "style.css"), "main{color:red}")
  assert.notEqual((await resolveTheme("bilibili", { id: "sample" })).key, first.key)
  await fs.writeFile(path.join(directory, "theme.json"), JSON.stringify({ id: "renamed", desc: "已更新" }))
  assert((await listThemes()).some(theme => theme.id === "renamed"))
  assert(!(await listThemes()).some(theme => theme.id === "sample"))
  const second = path.join(themes, "second")
  await fs.mkdir(second); await fs.writeFile(path.join(second, "theme.json"), '{"id":"second"}')
  assert((await listThemes()).some(theme => theme.id === "second"))
})

test("built-in music cards use static progress, lyrics and prepared speedup", async () => {
  mockBrowser()
  const audio = new AudioContent(new PathTask(() => { throw Error("no audio download while drawing") }), { duration: 180 })
  audio.speedup = 2
  const result = post("Music <title>", { platform: { name: "qqmusic", displayName: "QQ 音乐" }, content: [
    new ImageContent(localImage), "[00:01.00]第一行\n[00:02.00]第二行\n三\n四\n五\n六\n七", audio,
  ] })
  await render(result)
  const html = pages[pages.length - 1].html
  assert.match(html, /class="result music/); assert.match(html, /静态播放进度条/)
  assert.match(html, /1:30/); assert.match(html, />2x</)
  assert.match(html, /<p>第一行<\/p>/); assert.doesNotMatch(html, /<p>七<\/p>/)
  assert.match(html, /Music &lt;title&gt;/); assert.match(html, /data-parser-icons/)
  assert.doesNotMatch(html, /<(?:audio|script)\b/); assert.doesNotMatch(html, /<p>\[00:01/)
  const data = await buildThemeData(result)
  assert.equal(data.post.content[0].type, "cover")
})

test("identical cards coalesce browser work and reuse the persistent format-specific index", async () => {
  mockBrowser()
  const start = pages.length
  const [left, right] = await Promise.all([render(post("same-card")), render(post("same-card"))])
  assert.equal(left, right); assert.equal(pages.length - start, 1)
  assert.equal(await render(post("same-card")), left); assert.equal(pages.length - start, 1)
  assert((await cacheIndex.get(left)).extra.renderKey)
  await render(post("same-card"), "jpeg")
  assert.equal(pages.length - start, 2, "different formats must not share an indexed image")
})

test("card-only text mode filters body text and does not resolve a disabled video cover", async () => {
  mockBrowser()
  config.parser_send_components = ["card"]
  config.parser_render_type = "default"
  let coverDownloads = 0
  const video = new VideoContent(new PathTask(() => { throw Error("must remain lazy") }), {
    cover: new PathTask(() => { coverDownloads++; return localImage }),
  })
  const start = pages.length, replies = []
  await renderAndSend({ async reply(value) { replies.push(value) } }, post("card-only", {
    text: "正文不可出现", contents: [video],
  }), { sendContents: false })
  assert.equal(pages.length, start); assert.equal(coverDownloads, 0)
  assert.match(JSON.stringify(replies), /card-only/); assert.doesNotMatch(JSON.stringify(replies), /正文不可出现/)
})

test("card-only browser failure keeps a useful text summary", async () => {
  browserManager.withPage = async () => { throw Error("synthetic browser unavailable") }
  config.parser_send_components = ["card"]
  const replies = []
  await renderAndSend({ async reply(value) { replies.push(value) } }, post("text-fallback"), { sendContents: false })
  assert(replies.length > 0); assert.match(JSON.stringify(replies), /text-fallback/)
})

test("changing media speed or cut ranges invalidates the same result's rendered summary", async () => {
  mockBrowser()
  const video = new VideoContent(new PathTask(() => { throw Error("no media download") }), { cover: localImage, duration: 180 })
  const result = post("prepared-media", { contents: [video] })
  const start = pages.length
  const first = await render(result)
  video.speedup = 2
  const second = await render(result)
  assert.notEqual(second, first)
  assert.match(pages[pages.length - 1].html, />2x</)
  video.cutRanges = [[0, 30]]
  const third = await render(result)
  assert.notEqual(third, second)
  assert.equal(pages.length - start, 3)
})

try {
  for (const [name, run] of tests) {
    Object.assign(config, snapshot.config, { parser_render_type: "common", parser_render_theme: "default", parser_theme_dirs: [],
      parser_append_qrcode: false, parser_send_components: ["card", "content", "cover"], parser_forward_components: [] })
    ffmpeg.pngToJpeg = async () => { throw Error("synthetic JPEG unavailable") }
    ffmpeg.pngToWebp = async () => { throw Error("synthetic WebP unavailable") }
    await run()
    console.log("PASS " + name)
  }
  console.log("Render 1.4.0 regressions: " + tests.length + " tests passed")
} finally {
  Object.assign(config, snapshot.config)
  browserManager.withPage = snapshot.withPage
  ffmpeg.pngToJpeg = snapshot.jpeg; ffmpeg.pngToWebp = snapshot.webp
  for (const file of files) {
    assert.equal(path.dirname(file), cacheDir)
    await cacheIndex.remove(file); await fs.unlink(file).catch(() => {})
  }
  assert.equal(path.dirname(root), cacheDir)
  assert(path.basename(root).startsWith("render-140-"))
  await fs.rm(root, { recursive: true, force: true })
}
