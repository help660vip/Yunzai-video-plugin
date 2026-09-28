import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { cacheDir } from "../lib/core/paths.js"
import { cacheLifecycle } from "../lib/core/cache-lifecycle.js"
import { buildInfoArgs, buildVideoFormatArgs, createYtDlpRuntimeResolver, detectFfmpeg, runYtDlpDownload, selectYtDlpRuntimeArgs } from "../lib/core/ytdlp.js"

const cases = []
const test = (name, fn) => cases.push({ name, fn })
const modernHelp = "  --js-runtimes RUNTIME[:PATH]\n  --no-remote-components  Disable remote components"

test("FFmpeg availability uses its supported version argument", () => {
  assert.equal(detectFfmpeg((command, args, options) => {
    assert.equal(command, "ffmpeg")
    assert.deepEqual(args, ["-version"])
    assert.equal(options.timeout, 5000)
    assert.equal(options.windowsHide, true)
    return { status: 0 }
  }), true)
  assert.equal(detectFfmpeg(() => ({ error: new Error("synthetic missing"), status: null })), false)
})

test("Format selection permits unknown sizes while honoring known-size limits", () => {
  const split = buildVideoFormatArgs(80, { ffmpeg: true, maxMiB: 100 })
  assert.equal(split[1], "bv[filesize<=?18M]+ba/b[filesize<=?20M]")
  assert.equal(split.includes("--merge-output-format"), true)
  const combined = buildVideoFormatArgs(80, { ffmpeg: false, maxMiB: 12 })
  assert.equal(combined[1], "b[ext=mp4][filesize<=?12M][filesize_approx<=?12M]")
  assert.equal(combined.includes("--recode-video"), false)
})

test("Modern yt-dlp explicitly enables a supported local Node runtime", () => {
  const execPath = path.join("C:", "Program Files", "nodejs", "node.exe")
  const args = selectYtDlpRuntimeArgs(modernHelp, { nodeVersion: "22.0.0", execPath })
  assert.deepEqual(args, ["--ignore-config", "--no-remote-components", "--js-runtimes", "node:" + execPath])
  assert.equal(args.includes("--remote-components"), false)
  assert.equal(args.some(arg => /ejs:github|ejs:npm|cookies-from-browser|age-limit/.test(arg)), false)
  assert.deepEqual(selectYtDlpRuntimeArgs(modernHelp, { nodeVersion: "24.1.0", execPath }), args)
})

test("Node 16/18/20 and older yt-dlp retain compatible defaults", () => {
  for (const nodeVersion of ["16.14.0", "18.20.0", "20.10.0", "invalid"]) {
    assert.deepEqual(selectYtDlpRuntimeArgs(modernHelp, { nodeVersion }), ["--ignore-config", "--no-remote-components"])
  }
  assert.deepEqual(selectYtDlpRuntimeArgs("--dump-single-json --skip-download", { nodeVersion: "22.0.0" }), ["--ignore-config"])
  assert.deepEqual(selectYtDlpRuntimeArgs("--js-runtimes-extra X"), ["--ignore-config"])
})

test("Capability probing is bounded, cached and merges simultaneous requests", async () => {
  let calls = 0
  const resolve = createYtDlpRuntimeResolver(async (command, args, options) => {
    calls++
    assert.equal(command, "yt-dlp")
    assert.deepEqual(args, ["--ignore-config", "--help"])
    assert.equal(options.timeout, 15000)
    return { stdout: modernHelp }
  }, { nodeVersion: "22.0.0", execPath: "/synthetic/node" })
  const [first, second] = await Promise.all([resolve(), resolve()])
  assert.equal(calls, 1)
  assert.deepEqual(first, second)
  first.push("mutated")
  assert.equal((await resolve()).includes("mutated"), false)
  assert.equal(calls, 1)
})

test("Probe failures preserve legacy execution without injecting unsupported options", async () => {
  const resolve = createYtDlpRuntimeResolver(async () => { throw new Error("synthetic timeout") })
  assert.deepEqual(await resolve(), ["--ignore-config"])
})

test("Metadata builder stays backward compatible and accepts explicit runtime options", () => {
  const source = "https://video.invalid/synthetic"
  const original = buildInfoArgs(source)
  const updated = buildInfoArgs(source, null, ["--ignore-config", "--js-runtimes", "node:/synthetic/node"])
  assert.equal(original.includes("--js-runtimes"), false)
  assert.equal(updated.at(-1), source)
  assert.equal(updated.includes("node:/synthetic/node"), true)
  assert.equal(updated.includes("--force-generic-extractor"), false)
})

test("Download guard rejects combined temporary streams above the size budget", async () => {
  const directory = fs.mkdtempSync(path.join(cacheDir, "synthetic-ytdlp-"))
  const temporary = path.join(directory, "synthetic.mp4")
  const first = path.join(directory, "synthetic.f1.mp4")
  const second = path.join(directory, "synthetic.f2.m4a")
  try {
    await assert.rejects(() => runYtDlpDownload(["synthetic"], temporary, {
      maximum: 16, timeout: 1234,
      runner: async (_command, _args, options) => {
        assert.equal(options.timeout, 1234)
        fs.writeFileSync(first, Buffer.alloc(10))
        fs.writeFileSync(second, Buffer.alloc(10))
        return { stdout: "", stderr: "" }
      },
    }), error => error.code === "MEDIA_SIZE_LIMIT")
    assert.equal(cacheLifecycle.isActive(first), false)
    assert.equal(cacheLifecycle.isActive(second), false)
  } finally {
    for (const item of [first, second]) if (fs.existsSync(item)) fs.unlinkSync(item)
    fs.rmdirSync(directory)
  }
})

test("Download guard interrupts a growing stream and protects active artifacts", async () => {
  const directory = fs.mkdtempSync(path.join(cacheDir, "synthetic-ytdlp-"))
  const temporary = path.join(directory, "synthetic.mp4")
  const part = temporary + ".part"
  let protectedWhileRunning = false
  try {
    await assert.rejects(() => runYtDlpDownload([], temporary, {
      maximum: 8, pollMs: 5,
      runner: async (_command, _args, { signal }) => new Promise((resolve, reject) => {
        fs.writeFileSync(part, Buffer.alloc(12))
        signal.addEventListener("abort", () => {
          protectedWhileRunning = cacheLifecycle.isActive(part)
          reject(new Error("synthetic aborted"))
        }, { once: true })
      }),
    }), error => error.code === "MEDIA_SIZE_LIMIT")
    assert.equal(protectedWhileRunning, true)
    assert.equal(cacheLifecycle.isActive(part), false)
  } finally {
    if (fs.existsSync(part)) fs.unlinkSync(part)
    fs.rmdirSync(directory)
  }
})

let failures = 0
for (const { name, fn } of cases) {
  try { await fn(); console.log("✓ " + name) }
  catch (error) { failures++; console.error("✗ " + name, error) }
}
console.log((cases.length - failures) + "/" + cases.length + " yt-dlp runtime tests passed")
if (failures) process.exitCode = 1
