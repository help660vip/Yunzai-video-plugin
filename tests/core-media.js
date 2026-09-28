import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import http from "node:http"
import { PathTask } from "../lib/core/model.js"
import { HttpClient } from "../lib/core/http.js"

import { config, validateConfig } from "../lib/core/config.js"
import { Creator } from "../lib/core/creator.js"
import { StreamDownloader } from "../lib/core/downloader.js"
import { IgnoreError } from "../lib/core/errors.js"
import { ffmpeg } from "../lib/core/ffmpeg.js"
import { cacheLifecycle } from "../lib/core/cache-lifecycle.js"
import { cacheDir } from "../lib/core/paths.js"
import { runProcess } from "../lib/core/utils.js"
import { claimLazyResult, clearLazyResults, finishLazyResult, storeLazyResult } from "../lib/core/lazy.js"

const directory = fs.mkdtempSync(path.join(cacheDir, "core-media-test-"))
const tests = []
const test = (name, fn) => tests.push({ name, fn })

test("PathTask 下载失败可重试、已淘汰缓存重新生成", async () => {
  let attempts = 0
  const output = path.join(directory, "retry.dat")
  const task = new PathTask(async () => {
    attempts++
    if (attempts === 1) throw new Error("retry")
    fs.writeFileSync(output, "media")
    return output
  })
  await assert.rejects(task.get(), /retry/)
  await Promise.all([task.get(), task.get()])
  assert.equal(attempts, 2)
  fs.unlinkSync(output)
  await task.get()
  assert.equal(attempts, 3)
})

test("HTTP 超时持续覆盖响应正文，停滞下载不会永久占锁", async () => {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/octet-stream" })
    response.write("partial")
  })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  try {
    const response = await new HttpClient().request("http://127.0.0.1:" + server.address().port, { timeout: 100 })
    await assert.rejects(response.text(), error => error.name === "AbortError")
  } finally { await new Promise(resolve => server.close(resolve)) }
})

test("HLS 采用原生 FFmpeg 处理分片并原子发布，重复下载合并", async () => {
  const original = ffmpeg.run
  let calls = 0
  const downloader = new StreamDownloader()
  const output = path.join(directory, "stream.mp4")
  const name = path.relative(cacheDir, output)
  ffmpeg.run = async (args, options) => {
    calls += 1
    assert.equal(args[args.indexOf("-protocol_whitelist") + 1], "http,https,tcp,tls,crypto")
    assert.match(args[args.indexOf("-headers") + 1], /Referer: https:\/\/media\.invalid/)
    assert.equal(options.maxBytes, config.parser_max_size * 1024 * 1024)
    const temporary = args.at(-1)
    assert.match(temporary, /\.mp4$/)
    assert.equal(cacheLifecycle.isActive(temporary), true)
    assert.equal(fs.existsSync(output), false)
    await fs.promises.writeFile(temporary, Buffer.alloc(64, 1))
    return { stdout: "", stderr: "" }
  }
  try {
    const options = { fileName: name, headers: { Referer: "https://media.invalid/" } }
    const results = await Promise.all([
      downloader.downloadVideo("https://media.invalid/master.m3u8", options),
      downloader.downloadVideo("https://media.invalid/master.m3u8", options),
    ])
    assert.deepEqual(results, [output, output])
    assert.equal(calls, 1)
    assert.equal(fs.statSync(output).size, 64)
    assert.equal(cacheLifecycle.isActive(output), false)
  } finally { ffmpeg.run = original }
})

test("HLS 失败与超限均回收临时文件且不留下伪成功缓存", async () => {
  const original = ffmpeg.run
  for (const mode of ["failure", "limit", "empty"]) {
    const output = path.join(directory, mode + ".mp4")
    let temporary
    ffmpeg.run = async args => {
      temporary = args.at(-1)
      await fs.promises.writeFile(temporary, Buffer.alloc(mode === "empty" ? 0 : 2))
      if (mode === "failure") throw new Error("simulated encoder failure")
      if (mode === "limit") { const error = new Error("size"); error.code = "MEDIA_SIZE_LIMIT"; throw error }
      return { stdout: "", stderr: "" }
    }
    try {
      await assert.rejects(ffmpeg.downloadHlsToMp4("https://media.invalid/live.m3u8", output),
        mode === "failure" ? /simulated/ : IgnoreError)
      assert.equal(fs.existsSync(output), false)
      assert.equal(fs.existsSync(temporary), false)
      assert.equal(cacheLifecycle.isActive(temporary), false)
    } finally { ffmpeg.run = original }
  }
})

test("HLS 拒绝非网络协议、请求头注入和缓存越界", async () => {
  const output = path.join(directory, "invalid.mp4")
  await assert.rejects(ffmpeg.downloadHlsToMp4("file:///invalid", output), /HTTP/)
  await assert.rejects(ffmpeg.downloadHlsToMp4("https://media.invalid/a.m3u8", output,
    { headers: { Cookie: "fixture\r\nInjected: value" } }), /请求头/)
  const downloader = new StreamDownloader()
  await assert.rejects(downloader.downloadM3u8("https://media.invalid/a.m3u8", { fileName: "../../outside.mp4" }), /缓存目录/)
  await assert.rejects(downloader.download("https://media.invalid/a", { fileName: "../outside" }), /缓存目录/)
})

test("媒体进程结束时再次检查体积，及时终止运行中的超限任务", async () => {
  for (const delay of [0, 5000]) {
    const output = path.join(directory, "process-" + delay + ".dat")
    const start = Date.now()
    await assert.rejects(runProcess(process.execPath, ["-e",
      "require('node:fs').writeFileSync(process.argv[1],Buffer.alloc(2048));setTimeout(()=>{},Number(process.argv[2]))",
      output, String(delay)], { monitorPath: output, maxBytes: 1024 }), { code: "MEDIA_SIZE_LIMIT" })
    assert.ok(Date.now() - start < 4000)
  }
})

test("取消媒体进程后等待退出再释放调用方", async () => {
  const identity = path.join(directory, "abort.pid")
  const controller = new AbortController()
  const stopped = assert.rejects(runProcess(process.execPath, ["-e",
    "require('node:fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)",
    identity], { signal: controller.signal }), { name: "AbortError" })
  try {
    const deadline = Date.now() + 5000
    while (!fs.existsSync(identity)) {
      if (Date.now() > deadline) throw new Error("Child did not start")
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    const pid = Number(fs.readFileSync(identity, "utf8"))
    controller.abort()
    await stopped
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" })
  } finally {
    controller.abort()
    await stopped
  }
})

test("图片布局和动态大小保持懒执行", () => {
  let started = 0
  const image = Creator.image(() => { started++; return "image" }, { layout: "x" })
  const video = Creator.video(() => { started++; return "video" }, { isDynamicSize: true })
  assert.equal(image.layout, "x")
  assert.equal(video.isDynamicSize, true)
  assert.equal(started, 0)
})

test("新增配置验证、未知主题路径和兼容时长配置", () => {
  const cfg = validateConfig({ parser_bili_audio_quality: 30251, parser_x_ck: "fixture",
    parser_bili_access_key: "fixture", parser_render_theme: "paper", parser_theme_dirs: ["./data/themes"],
    parser_summary_in_forward: true, parser_video_in_forward: true, parser_max_comments: 0,
    parser_duration_maximum: 480 })
  assert.equal(cfg.parser_bili_audio_quality, 30251)
  assert.equal(cfg.parser_render_theme, "paper")
  assert.equal(cfg.parser_max_comments, 0)
  assert.equal(cfg.parser_duration_maximum, 480)
  assert.equal(validateConfig({ parser_render_theme: "../bad" }).parser_render_theme, "default")
  assert.equal(validateConfig({ parser_bili_audio_quality: 999 }).parser_bili_audio_quality, 30280)
})

test("懒下载隔离账号与群，同一用户跨群并发不重复下载", () => {
  clearLazyResults()
  const first = { self_id: "bot1", user_id: "user1", group_id: "group1", adapter_name: "onebot" }
  const otherBot = { ...first, self_id: "bot2" }
  const otherGroup = { ...first, group_id: "group2" }
  storeLazyResult(first, { id: 1 })
  storeLazyResult(otherBot, { id: 2 })
  storeLazyResult(otherGroup, { id: 3 })
  const current = claimLazyResult(first)
  assert.equal(current.result.id, 1)
  assert.equal(claimLazyResult(otherGroup).state, "busy")
  assert.equal(claimLazyResult(otherBot).result.id, 2)
  finishLazyResult(current.key)
  assert.equal(claimLazyResult(otherGroup).state, "missing")
  clearLazyResults()
})

let failed = 0
try {
  for (const { name, fn } of tests) {
    try { await fn(); console.log("✓ " + name) }
    catch (error) { failed++; console.error("✗ " + name, error) }
  }
} finally {
  clearLazyResults()
  fs.rmSync(directory, { recursive: true, force: true })
}
if (failed) process.exitCode = 1
