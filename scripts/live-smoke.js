import fs from "node:fs"
import path from "node:path"

import { config } from "../lib/core/config.js"
import { contentFingerprint } from "../lib/core/dedup.js"
import { getParser, matchUrl } from "../lib/core/registry.js"
import { shouldBlockResult } from "../lib/core/safety.js"
import { cacheDir } from "../lib/core/paths.js"
import { registerBuiltinParsers } from "../lib/parsers/index.js"
import { BilibiliParser } from "../lib/parsers/bilibili.js"

const inputPath = process.argv[2]
if (!inputPath) {
  throw new Error("Usage: node scripts/live-smoke.js <cases.json> [report.json]")
}

const reportPath = process.argv[3] || null
let cases = JSON.parse(fs.readFileSync(inputPath, "utf8"))
if (!Array.isArray(cases)) throw new TypeError("Smoke cases must be an array")
const platformFilter = new Set(
  String(process.env.SMOKE_PLATFORMS || "")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean),
)
if (platformFilter.size) cases = cases.filter(item => platformFilter.has(item.platform))
const labelFilter = new Set(
  String(process.env.SMOKE_LABELS || "")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean),
)
if (labelFilter.size) cases = cases.filter(item => labelFilter.has(item.label))
const forceDownload = process.env.SMOKE_FORCE_DOWNLOAD === "1"

await registerBuiltinParsers()
config.parser_max_size = Math.min(100, config.parser_max_size)

function withTimeout(promise, timeoutMs, label) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label + " timed out")), timeoutMs)
    }),
  ]).finally(() => clearTimeout(timer))
}

function redactError(error) {
  return String(error?.message || error)
    .replace(/https?:\/\/\S+/g, "[url]")
    .replace(/(cookie|token|sessdata)\s*[=:]\s*\S+/gi, "$1=[redacted]")
}

function safeError(error) {
  const message = redactError(error)
  if (/404|deleted|删除|失效|not found/i.test(message)) return "EXPIRED"
  if (/401|403|418|login|登录|cookie|风控|captcha/i.test(message)) return "ACCESS_LIMITED"
  if (/timed out|timeout|aborted|unexpected response|ETIMEDOUT|ECONNRESET|ENETUNREACH/i.test(message)) return "NETWORK_LIMITED"
  return "ERROR"
}

async function parseCase(item) {
  if (item.kind === "bilibili-audio") {
    const matched = /(BV[A-Za-z0-9]{10})(?:\s+(\d{1,3}))?/.exec(item.input)
    if (!matched) return { status: "ROUTE_MISS" }
    const parser = getParser(BilibiliParser)
    const pageIndex = Number(matched[2] || 1) - 1
    const streams = await withTimeout(
      parser.extractDownloadStreams({ bvid: matched[1], pageIndex }),
      45000,
      item.label,
    )
    if (!item.download && !forceDownload) {
      return {
        status: "PARSED",
        media: Number(Boolean(streams.videoUrls?.length)) + Number(Boolean(streams.audioUrls?.length)),
      }
    }
    if (!streams.audioUrls?.length) return { status: "ERROR", error: "audio stream unavailable" }
    const file = await withTimeout(
      parser.downloader.downloadAudio(streams.audioUrls[0], {
        fileName: "smoke-" + matched[1] + "-" + pageIndex + ".mp3",
        headers: parser.headers,
        fallbackUrls: streams.audioUrls.slice(1),
        retryHttpStatuses: BilibiliParser.BILI_RETRYABLE_HTTP_STATUSES,
      }),
      180000,
      item.label + " download",
    )
    return {
      status: "DOWNLOADED",
      media: Number(Boolean(streams.videoUrls?.length)) + Number(Boolean(streams.audioUrls?.length)),
      file,
      bytes: fs.statSync(file).size,
    }
  }

  const route = matchUrl(String(item.input).replace(/\\\?/g, "?"))
  if (!route) return { status: "ROUTE_MISS" }
  const result = await withTimeout(
    route.parser[route.method](route.match, route),
    60000,
    item.label,
  )
  if (shouldBlockResult(result)) return { status: "BLOCKED" }

  const summary = {
    status: "PARSED",
    platform: result.platform?.name || route.parser.platform?.name,
    contentId: result.contentId || null,
    fingerprint: contentFingerprint(result).slice(0, 16),
    contentType: result.contentType,
    media: result.allMedia.length,
    comments: result.comments?.length || 0,
  }
  if ((!item.download && !forceDownload) || !result.allMedia.length) return summary

  const media = result.allMedia.find(value => value.needSend !== false)
  if (!media?.pathTask) return summary
  const file = await withTimeout(media.pathTask.get(), 180000, item.label + " download")
  const stat = fs.statSync(file)
  if (stat.size > 100 * 1024 * 1024) throw new Error("Smoke download exceeded 100 MiB")
  return { ...summary, status: "DOWNLOADED", file, bytes: stat.size }
}

const existing = new Set()
async function snapshot(directory) {
  let entries = []
  try {
    entries = await fs.promises.readdir(directory, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const candidate = path.join(directory, entry.name)
    if (entry.isDirectory()) await snapshot(candidate)
    else if (entry.isFile()) existing.add(path.resolve(candidate))
  }
}
await snapshot(cacheDir)

const report = []
for (let index = 0; index < cases.length; index += 1) {
  const item = cases[index]
  const started = Date.now()
  try {
    const outcome = await parseCase(item)
    report.push({
      case: index + 1,
      label: item.label,
      expectedPlatform: item.platform,
      ...outcome,
      elapsedMs: Date.now() - started,
    })
  } catch (error) {
    report.push({
      case: index + 1,
      label: item.label,
      expectedPlatform: item.platform,
      status: safeError(error),
      error: redactError(error).slice(0, 240),
      elapsedMs: Date.now() - started,
    })
  }
  const row = report.at(-1)
  console.log(
    String(row.case).padStart(2, "0") +
      " " +
      String(row.expectedPlatform).padEnd(12) +
      " " +
      row.status +
      " " +
      row.label,
  )
}

for (const row of report) {
  if (!row.file || existing.has(path.resolve(row.file))) continue
  try {
    await fs.promises.unlink(row.file)
    row.cleaned = true
  } catch {
    row.cleaned = false
  }
  delete row.file
}

if (reportPath) fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8")

const counts = Object.fromEntries(
  [...new Set(report.map(item => item.status))]
    .sort()
    .map(status => [status, report.filter(item => item.status === status).length]),
)
console.log(JSON.stringify(counts))
