import crypto from "node:crypto"

import { config, onConfigChange, normalizePlatformName } from "./config.js"

export const DEDUP_TTL_MS = 30_000

const claims = new Map()
const flights = new Map()
const sessions = new Map()
const recentRequests = new Map()
const MAX_RECORDS = 2000
const botObjects = new WeakMap()
let nextBotObjectId = 1

function adapterName(e) {
  return String(
    e?.adapter_name ||
      e?.adapter?.name ||
      e?.bot?.adapter?.name ||
      e?.platform ||
      "default",
  ).toLowerCase()
}

function botIdentity(e) {
  const explicit =
    e?.self_id ??
    e?.bot?.self_id ??
    e?.bot?.uin ??
    e?.bot?.id ??
    e?.bot_id
  if (explicit !== null && explicit !== undefined && explicit !== "") {
    return adapterName(e) + ":" + String(explicit)
  }
  const object = e?.bot
  if (object && typeof object === "object") {
    if (!botObjects.has(object)) botObjects.set(object, nextBotObjectId++)
    return adapterName(e) + ":object-" + botObjects.get(object)
  }
  return adapterName(e) + ":default"
}

export function dedupScope(e) {
  const groupId = e?.group_id ?? e?.group?.group_id ?? e?.group?.id
  if (groupId !== null && groupId !== undefined && groupId !== "") {
    return botIdentity(e) + ":group:" + String(groupId)
  }
  const userId = e?.user_id ?? e?.sender?.user_id ?? e?.friend?.user_id ?? e?.friend?.id
  if (userId === null || userId === undefined || userId === "") return null
  return botIdentity(e) + ":private:" + String(userId)
}

function taskIdentity(task) {
  return {
    cacheKey: task.cacheKey || null,
    label: task.label || null,
    url: task.url || null,
  }
}

function stableValue(value, seen = new WeakSet()) {
  if (value === null || value === undefined) return null
  if (typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value)
  if (typeof value === "bigint") return String(value)
  if (typeof value === "function") return null
  if (typeof value !== "object") return String(value)
  if (
    value.constructor?.name === "PathTask" ||
    ("factory" in value && "promise" in value && "label" in value)
  ) {
    return { type: "PathTask", ...taskIdentity(value) }
  }
  if (seen.has(value)) return "[Circular]"
  seen.add(value)
  if (Array.isArray(value)) {
    const output = value.map(item => stableValue(item, seen))
    seen.delete(value)
    return output
  }
  const output = {}
  const ignored = new Set(["factory", "headers", "promise", "renderImage"])
  for (const key of Object.keys(value).sort()) {
    if (ignored.has(key)) continue
    const item = value[key]
    if (item === undefined || typeof item === "function") continue
    output[key] = stableValue(item, seen)
  }
  seen.delete(value)
  return output
}

function digest(value) {
  return crypto.createHash("sha256").update(value).digest("hex")
}

function canonicalUrl(value) {
  try {
    const url = new URL(String(value))
    url.hash = ""
    for (const name of [...url.searchParams.keys()]) {
      if (/^(?:utm_.+|fbclid|gclid)$/i.test(name)) url.searchParams.delete(name)
    }
    url.searchParams.sort()
    return url.toString()
  } catch {
    return String(value).trim()
  }
}

export function contentFingerprint(result) {
  const platform = String(result?.platform?.name || "unknown").trim().toLowerCase()
  if (
    result?.contentId !== null &&
    result?.contentId !== undefined &&
    result?.contentId !== ""
  ) {
    return digest(JSON.stringify(["content-id", platform, String(result.contentId)]))
  }
  const url = result?.url || result?.embedUrl
  if (url) return digest(JSON.stringify(["canonical-url", platform, canonicalUrl(url)]))
  return digest(JSON.stringify(["content", platform, stableValue(result)]))
}

function prune(now) {
  for (const [key, expiresAt] of claims) {
    if (expiresAt <= now) claims.delete(key)
  }
}

export function claimContent(e, result, now = Date.now()) {
  if (!dedupEnabled(result?.platform?.name) || !config.parser_dedup_window_seconds) return true
  const scope = dedupScope(e)
  if (!scope) return true
  prune(now)
  const key = scope + ":" + contentFingerprint(result)
  const expiresAt = claims.get(key)
  if (expiresAt && expiresAt > now) return false
  claims.set(key, now + config.parser_dedup_window_seconds * 1000)
  while (claims.size > MAX_RECORDS) claims.delete(claims.keys().next().value)
  return true
}

export function dedupEnabled(platform) {
  return config.parser_dedup_enabled && (config.parser_dedup_platforms === null || config.parser_dedup_platforms?.includes(normalizePlatformName(platform)))
}

// Serializes the complete parse/output lifecycle within a conversation. A
// failed parse may be retried once by queued callers, but output is never replayed.
export async function runSessionParse(e, platform, requestKey, factory) {
  const scope = dedupScope(e)
  if (!scope || !dedupEnabled(platform)) return factory({ outputStarted: false })
  const key = JSON.stringify([scope, platform, requestKey])
  const now = Date.now()
  for (const [stored, expires] of recentRequests) if (expires <= now) recentRequests.delete(stored)
  if ((recentRequests.get(key) || 0) > now) return "return"
  let pending = sessions.get(key)
  if (!pending) {
    pending = { tail: Promise.resolve(), users: 0, attempts: 0, succeeded: false, outputStarted: false }
    sessions.set(key, pending)
  }
  pending.users++
  const previous = pending.tail
  let release
  pending.tail = new Promise(resolve => { release = resolve })
  try {
    await previous
    if (pending.succeeded || pending.outputStarted || pending.attempts >= 2) return "return"
    pending.attempts++
    try {
      const value = await factory(pending)
      pending.succeeded = value !== false
      return value
    } finally {
      if ((pending.succeeded || pending.outputStarted) && config.parser_dedup_window_seconds > 0) {
        recentRequests.set(key, Date.now() + config.parser_dedup_window_seconds * 1000)
        while (recentRequests.size > MAX_RECORDS) recentRequests.delete(recentRequests.keys().next().value)
      }
    }
  } finally {
    release()
    if (--pending.users === 0 && sessions.get(key) === pending) sessions.delete(key)
  }
}

export function singleflight(key, factory) {
  const requestKey = String(key)
  const active = flights.get(requestKey)
  if (active) return active
  const promise = Promise.resolve().then(factory)
  flights.set(requestKey, promise)
  promise.finally(() => {
    if (flights.get(requestKey) === promise) flights.delete(requestKey)
  }).catch(() => {})
  return promise
}

export function clearDedupForTests() {
  claims.clear()
  flights.clear()
  sessions.clear()
  recentRequests.clear()
}

export function dedupStateForTests() {
  return { claims: claims.size, flights: flights.size }
}

onConfigChange((next, previous) => {
  recentRequests.clear()
  if (
    next.parser_dedup_enabled !== previous.parser_dedup_enabled ||
    next.parser_dedup_window_seconds !== previous.parser_dedup_window_seconds ||
    JSON.stringify(next.parser_dedup_platforms) !== JSON.stringify(previous.parser_dedup_platforms)
  ) {
    claims.clear()
    recentRequests.clear()
  }
})
