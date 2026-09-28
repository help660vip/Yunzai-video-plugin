import { config } from "./config.js"
import { userKeys } from "./group-filter.js"
import { dedupScope } from "./dedup.js"

const sessions = new Map()
const activeUsers = new Map()

function sessionKey(e) {
  const user = userKeys(e)[0]
  if (!user) return null
  const scope = dedupScope(e)
  return scope ? JSON.stringify([scope, user]) : null
}

function downloadUserKey(e) {
  return dedupScope({ ...e, group_id: null, group: null })
}

function prune() {
  for (const [key, entry] of sessions) {
    if (entry.expiresAt <= Date.now() && !entry.downloading) sessions.delete(key)
  }
}

export function storeLazyResult(e, result) {
  const key = sessionKey(e)
  if (!key) return false
  prune()
  if (activeUsers.has(downloadUserKey(e))) return false
  sessions.set(key, {
    result,
    userKey: downloadUserKey(e),
    expiresAt: Date.now() + config.parser_lazy_download_timeout * 1000,
    downloading: false,
  })
  return true
}

export function claimLazyResult(e) {
  const key = sessionKey(e)
  if (activeUsers.has(downloadUserKey(e))) return { state: "busy" }
  const entry = key ? sessions.get(key) : null
  if (!entry) return { state: "missing" }
  if (entry.expiresAt <= Date.now()) {
    sessions.delete(key)
    return { state: "expired" }
  }
  if (entry.downloading) return { state: "busy" }
  entry.downloading = true
  activeUsers.set(entry.userKey, key)
  for (const [otherKey, other] of sessions) {
    if (otherKey !== key && other.userKey === entry.userKey) sessions.delete(otherKey)
  }
  return { state: "ready", key, result: entry.result }
}

export function finishLazyResult(key, keep = false) {
  const entry = sessions.get(key)
  if (!entry) return
  if (activeUsers.get(entry.userKey) === key) activeUsers.delete(entry.userKey)
  if (keep) entry.downloading = false
  else sessions.delete(key)
}

export function clearLazyResults() {
  sessions.clear()
  activeUsers.clear()
}

export function lazySessionCount() {
  prune()
  return sessions.size
}
