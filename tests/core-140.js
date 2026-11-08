import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { CacheIndex } from "../lib/core/cache-index.js"
import { config, validateConfig } from "../lib/core/config.js"
import { sendComponent, forwardComponent } from "../lib/core/components.js"
import { clearDedupForTests, runSessionParse, claimContent } from "../lib/core/dedup.js"
import { Creator } from "../lib/core/creator.js"
import { ParseResult } from "../lib/core/model.js"
import { renderContents } from "../lib/core/sender.js"
import { supportGuoba } from "../guoba.support.js"
import { BaseParser, registerParser, matchUrl } from "../lib/core/registry.js"

const snapshot = { ...config }
const tests = []
const test = (name, fn) => tests.push({ name, fn })
const event = { self_id: 1, group_id: 2, user_id: 3 }
const tick = () => new Promise(resolve => setImmediate(resolve))

test("configuration accepts declarative components, per-platform cooldown and validated media rules", () => {
  const value = validateConfig({ parser_send_components: ["video", "video"], parser_forward_components: [], parser_dedup_window_seconds: 0, parser_dedup_platforms: ["x"], parser_media_speedup_rules: ["bilibili:123:1.25", "bilibili:123:Infinity", "unknown:123:2"], parser_bsb_api_base: "https://example.invalid/api", parser_bsb_categories: ["sponsor", "intro"] })
  assert.deepEqual(value.parser_send_components, ["card", "video"])
  assert.deepEqual(value.parser_forward_components, [])
  assert.deepEqual(value.parser_dedup_platforms, ["twitter"])
  assert.equal(value.parser_dedup_window_seconds, 0)
  assert.deepEqual(value.parser_media_speedup_rules, ["bilibili:123:1.25"])
  assert.equal(validateConfig({ parser_bsb_api_base: "file:///etc/passwd" }).parser_bsb_api_base, null)
  assert.equal(validateConfig({ parser_bsb_api_base: "https://user:secret@example.invalid" }).parser_bsb_api_base, null)
})

test("component lists take precedence while null keeps legacy switches hot", () => {
  config.parser_send_components = null
  config.parser_forward_components = null
  config.parser_append_url = true
  config.parser_summary_in_forward = true
  assert.equal(sendComponent("url"), true)
  assert.equal(forwardComponent("card"), true)
  config.parser_send_components = ["card", "audio"]
  config.parser_forward_components = ["audio", "video"]
  assert.equal(sendComponent("url"), false)
  assert.equal(sendComponent("video"), false)
  assert.equal(forwardComponent("video"), false)
  assert.equal(forwardComponent("audio"), true)
})

test("Guoba distinguishes compatibility/all-platform choices from explicitly empty lists", () => {
  config.parser_send_components = null
  config.parser_forward_components = null
  config.parser_dedup_platforms = null
  let saved
  const ui = supportGuoba({ save: value => { saved = value } }).configInfo
  const data = ui.getConfigData()
  assert.deepEqual(data.parser_send_components, ["__legacy__"])
  assert.deepEqual(data.parser_dedup_platforms, ["__all__"])
  ui.setConfigData(data, { Result: { ok: () => true } })
  assert.equal(saved.parser_send_components, null)
  assert.equal(saved.parser_dedup_platforms, null)
  ui.setConfigData({ parser_send_components: [], parser_forward_components: [], parser_dedup_platforms: [] }, { Result: { ok: () => true } })
  assert.deepEqual(saved.parser_send_components, ["card"])
  assert.deepEqual(saved.parser_forward_components, [])
  assert.deepEqual(saved.parser_dedup_platforms, [])
})

test("disabled media/body components never execute download tasks", async () => {
  config.parser_send_components = ["card"]
  config.parser_forward_components = []
  let tasks = 0, replies = 0
  const task = async () => { tasks++; throw new Error("disabled task executed") }
  const result = new ParseResult({ title: "hidden", platform: { name: "fixture" }, author: Creator.author("author", { id: "1" }), content: [Creator.video(task), Creator.audio(task), Creator.graphic(task), "hidden text"] })
  await renderContents({ reply: async () => { replies++ } }, result)
  assert.equal(tasks, 0)
  assert.equal(replies, 0)
})

test("zero cooldown coalesces only concurrent requests and releases every session", async () => {
  clearDedupForTests()
  config.parser_dedup_enabled = true
  config.parser_dedup_platforms = null
  config.parser_dedup_window_seconds = 0
  let starts = 0, release
  const gate = new Promise(resolve => { release = resolve })
  const factory = async state => { starts++; await gate; state.outputStarted = true; return "return" }
  const first = runSessionParse(event, "bilibili", "same", factory)
  const second = runSessionParse(event, "bilibili", "same", factory)
  await tick()
  assert.equal(starts, 1)
  release()
  await Promise.all([first, second])
  await runSessionParse(event, "bilibili", "same", factory)
  assert.equal(starts, 2)
})

test("route cache identities ignore share parameters but retain handler and declared page parameters", () => {
  class RouteParser extends BaseParser {
    static platform = { name: "route140", displayName: "Route" }
    static handlers = [{ keyword: "route140.invalid", pattern: /route140\.invalid\/post\/(?<id>\d+)[^\s]*/, params: { p: { default: "1" } }, method: "parse" }]
  }
  registerParser(RouteParser)
  const first = matchUrl("https://route140.invalid/post/42?utm_source=one")
  const second = matchUrl("https://route140.invalid/post/42?p=1&utm_source=two")
  const page = matchUrl("https://route140.invalid/post/42?p=2")
  assert.equal(first.cacheKey, second.cacheKey)
  assert.notEqual(first.cacheKey, page.cacheKey)
})

test("queued parse failures retry once; started output is never repeated", async () => {
  clearDedupForTests()
  let attempts = 0
  const failed = async () => { attempts++; await tick(); throw new Error("parse failed") }
  const outcomes = await Promise.allSettled(Array.from({ length: 5 }, () => runSessionParse(event, "bilibili", "failure", failed)))
  assert.equal(attempts, 2)
  assert.equal(outcomes.filter(value => value.status === "rejected").length, 2)
  attempts = 0
  const output = async state => { attempts++; state.outputStarted = true; await tick(); throw new Error("send failed") }
  await Promise.allSettled(Array.from({ length: 3 }, () => runSessionParse(event, "bilibili", "output", output)))
  assert.equal(attempts, 1)
})

test("platform cooldown selection and conversation isolation preserve existing defaults", async () => {
  clearDedupForTests()
  config.parser_dedup_window_seconds = 30
  config.parser_dedup_platforms = ["bilibili"]
  let starts = 0
  const factory = async () => { starts++ }
  await runSessionParse(event, "bilibili", "same", factory)
  await runSessionParse(event, "bilibili", "same", factory)
  await runSessionParse({ ...event, group_id: 9 }, "bilibili", "same", factory)
  await runSessionParse(event, "youtube", "same", factory)
  await runSessionParse(event, "youtube", "same", factory)
  assert.equal(starts, 4)
  const result = { platform: { name: "youtube" }, contentId: "1" }
  assert.equal(claimContent(event, result), true)
  assert.equal(claimContent(event, result), true)
})

test("cache index reuses detected suffixes and restores metadata after restart without rescanning", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "yunzai-index-"))
  try {
    const payload = path.join(directory, "stable.ogg")
    await fs.writeFile(payload, "audio")
    const index = new CacheIndex(directory)
    const entry = await index.set(payload, { duration: 12 })
    assert.equal(entry.size, 5)
    index.scan = () => { throw new Error("unexpected scan") }
    assert.equal((await index.get(path.join(directory, "stable.mp3"))).path, payload)
    index.touch(payload, Date.now() + 10000)
    await index.flush(0)
    const restarted = new CacheIndex(directory)
    assert.deepEqual((await restarted.get(payload)).extra, { duration: 12 })
    await fs.unlink(payload)
    assert.equal(await restarted.get(payload), null)
    assert.equal(await restarted.get(path.join(directory, "..", "outside.mp3")), null)
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

test("cache index ignores transient payloads, corrupted metadata and external symlinks", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "yunzai-index-safe-"))
  try {
    await fs.writeFile(path.join(directory, "incomplete.part-123.mp4"), "temporary")
    await fs.writeFile(path.join(directory, "good.png"), "image")
    await fs.writeFile(path.join(directory, "good.meta"), '{"path":"../../secret","lastHit":"bad"}')
    await fs.mkdir(path.join(directory, "real"))
    await fs.writeFile(path.join(directory, "real", "asset.jpg"), "asset")
    await fs.symlink(path.join(directory, "real"), path.join(directory, "linked"), "junction")
    const index = new CacheIndex(directory)
    await index.warmup()
    assert.equal(await index.get(path.join(directory, "incomplete.mp4")), null)
    assert.equal((await index.get(path.join(directory, "good.png"))).path, path.join(directory, "good.png"))
    assert.equal(await index.set(path.join(directory, "..", "outside.png")), null)
    assert.equal(await index.get(path.join(directory, "linked", "asset.jpg")), null)
    assert.equal(await index.set(path.join(directory, "linked", "asset.jpg")), null)
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

let failed = 0
try {
  for (const item of tests) {
    Object.assign(config, snapshot)
    try { await item.fn(); console.log("PASS " + item.name) }
    catch (error) { failed++; console.error("FAIL " + item.name, error) }
    finally { clearDedupForTests() }
  }
} finally { Object.assign(config, snapshot) }
if (failed) process.exitCode = 1
else console.log(`Core 1.4.0 parity: ${tests.length} tests passed`)
