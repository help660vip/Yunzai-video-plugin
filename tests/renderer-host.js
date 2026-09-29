import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { EventEmitter } from "node:events"
import { PNG } from "pngjs"
import { config } from "../lib/core/config.js"
import { ffmpeg } from "../lib/core/ffmpeg.js"
import { cacheDir } from "../lib/core/paths.js"
import { Author, ParseResult, VideoContent } from "../lib/core/model.js"
import { browserManager } from "../lib/render/browser-manager.js"
import { discoverBrowserCandidates } from "../lib/render/browser-discovery.js"
import { closeRenderer, renderAndSend, renderCard } from "../lib/render/renderer.js"

// Real renderer/sender calls with a synthetic manager Page; no browser or platform requests.
const tests = []
const test = (name, run) => tests.push([name, run])
const original = { config: { ...config }, segment: globalThis.segment, logger: globalThis.logger,
  withPage: browserManager.withPage, reportFailure: browserManager.reportFailure, pngToWebp: ffmpeg.pngToWebp }
const root = await fs.mkdtemp(path.join(cacheDir, "renderer-host-unit-"))
const generated = new Set(), pages = [], calls = [], reported = []
const unique = path.basename(root)
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const file = path.join(root, "synthetic.mp4")
await fs.writeFile(file, "synthetic-video-not-uploaded")

function post(name, extra = {}) {
  return new ParseResult({ platform: { name: "bilibili", displayName: "Synthetic" },
    author: new Author("Synthetic author"), title: name + "-" + unique, text: name + " content",
    url: "https://example.invalid/" + name, ...extra })
}

function event(name) {
  const e = { name, runtime: { marker: name }, replies: [],
    async reply(message) { assert.equal(this, e); this.replies.push(message) } }
  return e
}

function pageMock({ gotoError = null } = {}) {
  const page = new EventEmitter()
  Object.assign(page, {
    closes: 0, html: "", urls: [], currentViewport: { deviceScaleFactor: 2 },
    async setJavaScriptEnabled() {},
    async setRequestInterception() {},
    async setViewport(value) { this.currentViewport = value },
    async goto(url) { this.urls.push(url); if (gotoError) throw gotoError },
    async setContent(html) { this.html = html },
    async evaluate() { return true },
    async $() { return null },
    async $eval() { return { x: 0, y: 0, width: 2, height: 2 } },
    viewport() { return this.currentViewport },
    async screenshot({ clip }) {
      return PNG.sync.write(new PNG({ width: clip.width * this.currentViewport.deviceScaleFactor, height: clip.height * this.currentViewport.deviceScaleFactor }))
    },
    async close() { this.closes++ },
  })
  pages.push(page)
  return page
}

function mockManager(factory = () => pageMock(), before = null) {
  browserManager.withPage = async function (e, callback) {
    assert.equal(this, browserManager)
    calls.push(e)
    const page = factory(e, calls.length)
    try { await before?.(e, page); return await callback(page) }
    finally { await page.close() }
  }
}

function remember(result) { if (result.renderImage) generated.add(result.renderImage) }
async function send(e, result, options = {}) {
  try { await renderAndSend(e, result, options) } finally { remember(result) }
}

async function theme(name, template) {
  const directory = path.join(root, name)
  await fs.mkdir(directory)
  await fs.writeFile(path.join(directory, "theme.json"), JSON.stringify({ id: name, schema_version: 1 }))
  await fs.writeFile(path.join(directory, "default.html"), template)
  config.parser_theme_dirs = [directory]
  config.parser_render_theme = name
}

test("renderAndSend passes its exact event through renderCard to the manager", async () => {
  mockManager()
  const e = event("event-a"), result = post("event-forwarding")
  await send(e, result, { sendContents: false })
  assert.deepEqual(calls, [e])
  assert.equal(e.replies.length, 1)
  assert.equal(e.replies[0][0].type, "image")
  assert.equal(PNG.sync.read(await fs.readFile(result.renderImage)).width, 4)
  assert.match(pages[0].html, /event-forwarding content/)
  assert.equal(pages[0].closes, 1)
})

test("bot summary cards stay PNG even when WebP conversion is available", async () => {
  mockManager()
  let webpCalls = 0
  const unavailable = ffmpeg.pngToWebp
  ffmpeg.pngToWebp = async () => { webpCalls++; return Buffer.from("synthetic-webp") }
  const result = post("png-summary")
  try {
    await send(event("png-summary"), result, { sendContents: false })
    assert.equal(webpCalls, 0)
    assert.equal(path.extname(result.renderImage), ".png")
    assert.equal(PNG.sync.read(await fs.readFile(result.renderImage)).width, 4)
  } finally {
    ffmpeg.pngToWebp = unavailable
  }
})

test("concurrent renders keep per-message context and pages isolated", async () => {
  mockManager(() => pageMock(), async e => { if (e.name === "first") await pause(15) })
  const first = event("first"), second = event("second")
  const left = post("concurrent-first"), right = post("concurrent-second")
  await Promise.all([send(first, left, { sendContents: false }), send(second, right, { sendContents: false })])
  assert.equal(calls.length, 2)
  assert(calls.includes(first) && calls.includes(second))
  assert.equal(first.replies.length, 1)
  assert.equal(second.replies.length, 1)
  assert.notEqual(left.renderImage, right.renderImage)
  assert(pages.every(page => page.closes === 1))
})

test("legacy renderCard without an event still follows the independent path", async () => {
  mockManager()
  const result = post("legacy-no-event")
  try { await renderCard(result, "common", { format: "png" }) } finally { remember(result) }
  assert.deepEqual(calls, [null])
  assert.equal(PNG.sync.read(await fs.readFile(result.renderImage)).width, 4)
})

test("malformed custom theme recursion preserves the current event", async () => {
  mockManager()
  await theme("malformed", "{{#if never-closed}}")
  const e = event("template-error")
  await send(e, post("template-fallback"), { sendContents: false })
  assert.deepEqual(calls, [e])
  assert.match(pages[0].html, /class="result/)
  assert.equal(e.replies[0][0].type, "image")
})

test("custom theme page failure preserves event when retrying the built-in theme", async () => {
  mockManager((_event, count) => pageMock({ gotoError: count === 1 ? new Error("synthetic theme navigation failure") : null }))
  await theme("navigation", "<main>{{post.title}}</main>")
  const e = event("page-error")
  await send(e, post("page-fallback"), { sendContents: false })
  assert.deepEqual(calls, [e, e])
  assert.equal(pages[0].urls.length, 1)
  assert(pages[0].urls[0].endsWith("/resources/render-origin.html"))
  assert.equal(pages[1].urls.length, 0)
  assert(pages.every(page => page.closes === 1))
  assert.equal(e.replies[0][0].type, "image")
})

test("custom theme starts as HTML and only its exact bootstrap navigation is allowed", async () => {
  mockManager()
  await theme("html-origin", "<main>{{post.title}}</main>")
  await send(event("html-origin"), post("html-origin"), { sendContents: false })
  const page = pages[0]
  assert.equal(page.urls.length, 1)
  assert(page.urls[0].endsWith("/resources/render-origin.html"))
  const request = (url, navigation = false) => new Promise(resolve => page.emit("request", {
    url: () => url, isNavigationRequest: () => navigation,
    continue: async () => resolve("continued"), abort: async () => resolve("aborted"),
  }))
  assert.equal(await request(page.urls[0], true), "continued")
  assert.equal(await request(page.urls[0], true), "aborted", "bootstrap exception is single-use")
  assert.equal(await request(page.urls[0]), "aborted", "bootstrap is not a theme resource")
  assert.equal(await request(new URL("../package.json", page.urls[0]).href, true), "aborted")
  assert.equal(await request("https://example.invalid/forbidden"), "aborted")
})

test("result image cache retains no event and a new message replies to its own event", async () => {
  mockManager()
  const first = event("cached-first"), second = event("cached-second"), third = event("fresh-third")
  const result = post("cached-post")
  await send(first, result, { sendContents: false })
  await send(second, result, { sendContents: false })
  await send(third, post("fresh-post"), { sendContents: false })
  assert.deepEqual(calls, [first, third])
  assert.equal(second.replies.length, 1)
  assert(!Object.values(result).some(value => value === first || value === second || value === third))
  assert(!JSON.stringify(result).includes("cached-first"))
})

test("browser failure preserves default text and video sending", async () => {
  browserManager.withPage = async e => { calls.push(e); throw new Error("synthetic browser unavailable") }
  const e = event("default-fallback")
  const result = post("video-fallback", { contents: [new VideoContent(file)] })
  await send(e, result)
  assert.deepEqual(calls, [e])
  assert.equal(reported.length, 1)
  assert.match(JSON.stringify(e.replies), /video-fallback/)
  assert(e.replies.some(reply => reply?.type === "video" && reply.file === file))
  assert.equal(result.renderImage, null)
})

async function realBorrowedBrowserSmoke() {
  const { candidates } = await discoverBrowserCandidates()
  let hostBrowser = null
  for (const candidate of candidates.slice(0, 3)) {
    if (typeof candidate.puppeteer?.launch !== "function") continue
    try {
      hostBrowser = await candidate.puppeteer.launch({
        executablePath: candidate.executablePath, headless: true, timeout: 8000,
        args: process.platform === "linux" && process.getuid?.() === 0 ? ["--no-sandbox", "--disable-setuid-sandbox"] : [],
      })
      break
    } catch {}
  }
  if (!hostBrowser) {
    console.log("SKIP real borrowed-browser smoke: no locally usable browser; mocks are not a real-browser validation")
    return
  }
  const keys = ["PUPPETEER_EXECUTABLE_PATH", "PUPPETEER_BROWSER_WS_ENDPOINT", "PUPPETEER_BROWSER_URL"]
  const environment = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  const originalWithPage = browserManager.withPage
  try {
    for (const key of keys) delete process.env[key]
    browserManager.withPage = original.withPage
    const hostPage = await hostBrowser.newPage()
    await hostPage.setContent('<!doctype html><meta charset="utf-8"><main id="sentinel">Host page must survive</main>')
    const before = (await hostBrowser.pages()).length
    const e = event("real-borrowed")
    e.runtime.puppeteer = { browser: hostBrowser }
    const result = post("real-borrowed-local-page")
    await send(e, result, { sendContents: false })
    assert(result.renderImage, "real browser should create a card, not silently fall back")
    assert.equal(PNG.sync.read(await fs.readFile(result.renderImage)).width, 1504)
    assert.equal((await hostBrowser.pages()).length, before, "plugin pages and contexts must be closed after rendering")
    await closeRenderer()
    const connected = typeof hostBrowser.isConnected === "function" ? hostBrowser.isConnected() : hostBrowser.connected
    assert(connected, "closeRenderer must never close or disconnect a borrowed Browser")
    assert(!hostPage.isClosed(), "an existing host Page must not be closed")
    assert.equal(await hostPage.$eval("#sentinel", element => element.textContent), "Host page must survive")
    assert.equal((await hostBrowser.pages()).length, before)
    console.log("PASS real borrowed-browser local static smoke (" + process.platform + "; not a Debian 12 claim)")
  } finally {
    browserManager.withPage = originalWithPage
    for (const key of keys) {
      if (environment[key] === undefined) delete process.env[key]
      else process.env[key] = environment[key]
    }
    // This test launched its host stand-in and owns it; the plugin never closes it.
    await hostBrowser.close()
  }
}

try {
  globalThis.segment = {}
  globalThis.logger = Object.fromEntries(["debug", "info", "warn", "error", "mark", "success"].map(level => [level, () => {}]))
  browserManager.reportFailure = error => reported.push(error)
  ffmpeg.pngToWebp = async () => { throw new Error("synthetic PNG fallback") }
  for (const [name, run] of tests) {
    Object.assign(config, original.config, { parser_render_type: "common", parser_render_theme: "default", parser_theme_dirs: [],
      parser_append_qrcode: false, parser_append_url: false, parser_embed_url: false,
      parser_summary_in_forward: false, parser_video_in_forward: false, parser_need_forward_contents: false,
      parser_need_upload_video: false, parser_need_upload_audio: false, parser_use_base64: false,
      parser_forward_text_threshold: 10000 })
    calls.length = 0; pages.length = 0; reported.length = 0
    await run()
    console.log("PASS " + name)
  }
  console.log("Renderer/host integration mocks: " + tests.length + " tests passed")
  await realBorrowedBrowserSmoke()
} finally {
  browserManager.withPage = original.withPage
  browserManager.reportFailure = original.reportFailure
  ffmpeg.pngToWebp = original.pngToWebp
  Object.assign(config, original.config)
  globalThis.segment = original.segment
  globalThis.logger = original.logger
  for (const filename of generated) {
    assert.equal(path.dirname(filename), cacheDir)
    assert(/^render-[a-f0-9]+\.(png|webp)$/.test(path.basename(filename)))
    await fs.unlink(filename).catch(() => {})
  }
  assert.equal(path.dirname(root), cacheDir)
  assert(path.basename(root).startsWith("renderer-host-unit-"))
  await fs.rm(root, { recursive: true, force: true })
}
