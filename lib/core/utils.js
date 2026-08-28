import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { spawn, spawnSync } from "node:child_process"
import { fileURLToPath, pathToFileURL } from "node:url"

import { log } from "./logger.js"

export const COMMON_HEADERS = Object.freeze({
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/55.0.2883.87 UBrowser/6.2.4098.3 Safari/537.36",
})

export const IOS_HEADERS = Object.freeze({
  "user-agent":
    "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1 Edg/132.0.0.0",
})

export const ANDROID_HEADERS = Object.freeze({
  "user-agent":
    "Mozilla/5.0 (Linux; Android 15; SM-G998B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Mobile Safari/537.36 Edg/132.0.0.0",
})

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

export function md5Name(url, defaultSuffix = "") {
  let suffix = defaultSuffix
  let resource = String(url)
  try {
    const parsed = new URL(url)
    suffix = path.extname(parsed.pathname) || defaultSuffix
    parsed.hash = ""
    resource = parsed.href
  } catch {}
  return `${crypto.createHash("md5").update(resource).digest("hex").slice(0, 16)}${suffix}`
}

export function stripHtml(value = "") {
  return String(value)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
}

export function fmtDuration(seconds) {
  if (!Number.isFinite(Number(seconds))) return null
  const total = Math.max(0, Math.floor(Number(seconds)))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
    : `${minutes}:${String(secs).padStart(2, "0")}`
}

export function localFile(value) {
  if (!value) return value
  if (Buffer.isBuffer(value)) return value
  if (/^(https?:|base64:|data:|file:)/i.test(value)) return value
  return pathToFileURL(path.resolve(value)).href
}

export function fileFromImport(metaUrl) {
  return fileURLToPath(metaUrl)
}

export function commandExists(command, timeout = 5000) {
  const result = spawnSync(command, ["--version"], {
    windowsHide: true,
    stdio: "ignore",
    timeout,
  })
  return !result.error && result.status === 0
}

export function runProcess(command, args, options = {}) {
  log.debug(`[parser] ${command} ${args.join(" ")}`)
  const { input = null, encoding = "utf8", ...spawnOptions } = options
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: [input === null ? "ignore" : "pipe", "pipe", "pipe"],
      ...spawnOptions,
    })
    const stdoutChunks = []
    const stderrChunks = []
    child.stdout?.on("data", chunk => {
      stdoutChunks.push(Buffer.from(chunk))
    })
    child.stderr?.on("data", chunk => {
      stderrChunks.push(Buffer.from(chunk))
    })
    child.once("error", reject)
    child.once("close", code => {
      const stdoutBuffer = Buffer.concat(stdoutChunks)
      const stderrBuffer = Buffer.concat(stderrChunks)
      const stdout = encoding === null ? stdoutBuffer : stdoutBuffer.toString(encoding)
      const stderr = encoding === null ? stderrBuffer : stderrBuffer.toString(encoding)
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`${command} 执行失败(${code}): ${stderrBuffer.toString().trim()}`))
    })
    if (input !== null) child.stdin?.end(input)
  })
}

export async function safeUnlink(filePath) {
  try {
    await fs.promises.unlink(filePath)
  } catch (error) {
    if (error?.code !== "ENOENT") log.warn(`[parser] 删除文件失败: ${filePath}`, error)
  }
}

export function randomChoice(items) {
  if (!Array.isArray(items) || !items.length) return undefined
  return items[Math.floor(Math.random() * items.length)]
}

export function pickUrl(value) {
  if (!value) return undefined
  if (typeof value === "string") return value
  if (Array.isArray(value)) return randomChoice(value.map(pickUrl).filter(Boolean))
  return pickUrl(value.url_list || value.urlList || value.urls || value.url)
}

export function parseCookieString(cookie = "") {
  const result = {}
  for (const item of String(cookie).split(";")) {
    const index = item.indexOf("=")
    if (index <= 0) continue
    result[item.slice(0, index).trim()] = item.slice(index + 1).trim()
  }
  return result
}

export function cookieHeader(cookies = {}) {
  return Object.entries(cookies)
    .map(([key, value]) => `${key}=${value}`)
    .join("; ")
}

export function jsonFromAssignment(html, marker) {
  const start = html.indexOf(marker)
  if (start < 0) throw new Error(`未找到 ${marker}`)
  let cursor = html.indexOf("=", start)
  if (cursor < 0) throw new Error(`未找到 ${marker} 的赋值`)
  cursor += 1
  while (/\s/.test(html[cursor])) cursor += 1
  const opener = html[cursor]
  const closer = opener === "{" ? "}" : opener === "[" ? "]" : null
  if (!closer) throw new Error(`${marker} 不是 JSON 对象`)
  let depth = 0
  let quote = null
  let escaped = false
  for (let index = cursor; index < html.length; index += 1) {
    const char = html[index]
    if (quote) {
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === opener) depth += 1
    if (char === closer) {
      depth -= 1
      if (depth === 0) {
        return JSON.parse(html.slice(cursor, index + 1).replace(/\bundefined\b/g, "null"))
      }
    }
  }
  throw new Error(`${marker} JSON 未闭合`)
}
