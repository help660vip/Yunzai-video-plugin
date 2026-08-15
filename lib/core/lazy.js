import { config } from "./config.js"
import { userKeys } from "./group-filter.js"

const sessions = new Map()

function sessionKey(e) {
  const user = userKeys(e)[0]
  if (!user) return null
  const group = String(e?.group_id || "private")
  return group + ":" + user
}

export function storeLazyResult(e, result) {
  const key = sessionKey(e)
  if (!key) return false
  sessions.set(key, {
    result,
    expiresAt: Date.now() + config.parser_lazy_download_timeout * 1000,
    downloading: false,
  })
  return true
}

export function claimLazyResult(e) {
  const key = sessionKey(e)
  const entry = key ? sessions.get(key) : null
  if (!entry) return { state: "missing" }
  if (entry.expiresAt <= Date.now()) {
    sessions.delete(key)
    return { state: "expired" }
  }
  if (entry.downloading) return { state: "busy" }
  entry.downloading = true
  return { state: "ready", key, result: entry.result }
}

export function finishLazyResult(key, keep = false) {
  const entry = sessions.get(key)
  if (!entry) return
  if (keep) entry.downloading = false
  else sessions.delete(key)
}

export function clearLazyResults() {
  sessions.clear()
}

export function lazySessionCount() {
  return sessions.size
}
