import fs from "node:fs"
import path from "node:path"

import { config } from "./config.js"
import { dataDir } from "./paths.js"

const groupSetPath = path.join(dataDir, "group_set.json")
const legacyPath = path.join(dataDir, "disabled_groups.json")

function loadGroupSet() {
  if (!fs.existsSync(groupSetPath)) {
    if (fs.existsSync(legacyPath)) fs.renameSync(legacyPath, groupSetPath)
    else fs.writeFileSync(groupSetPath, "[]", "utf8")
  }
  try {
    return new Set(JSON.parse(fs.readFileSync(groupSetPath, "utf8")))
  } catch {
    return new Set()
  }
}

export const groupSet = loadGroupSet()

function save() {
  const temporary = groupSetPath + "." + process.pid + ".tmp"
  let descriptor
  try {
    descriptor = fs.openSync(temporary, "wx")
    fs.writeFileSync(descriptor, JSON.stringify([...groupSet].sort()), "utf8")
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = undefined
    fs.renameSync(temporary, groupSetPath)
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
    try { fs.unlinkSync(temporary) } catch (error) { if (error.code !== "ENOENT") throw error }
  }
}

export function groupKey(e) {
  const adapter =
    e.adapter_name || e.adapter?.name || e.bot?.adapter?.name || e.platform || "QQClient"
  const scope = /icqq|onebot|qq/i.test(String(adapter)) ? "QQClient" : String(adapter)
  return `${scope}_${e.group_id}`
}

export function userKeys(e) {
  const adapter =
    e.adapter_name || e.adapter?.name || e.bot?.adapter?.name || e.platform || "QQClient"
  const scope = /icqq|onebot|qq/i.test(String(adapter)) ? "QQClient" : String(adapter)
  const userId = String(e?.user_id || e?.sender?.user_id || "")
  return userId ? [userId, scope + "_" + userId] : []
}

export function isEnabled(e) {
  if (userKeys(e).some(key => config.parser_blacklist_users.includes(key))) return false
  if (!e?.isGroup && !e?.group_id) return true
  const present = groupSet.has(groupKey(e))
  return config.parser_group_blacklist_enabled ? !present : present
}

export function setEnabled(e, enabled) {
  if (!e?.isGroup && !e?.group_id) return false
  const key = groupKey(e)
  const shouldContain = config.parser_group_blacklist_enabled ? !enabled : enabled
  const contained = groupSet.has(key)
  if (contained === shouldContain) return false
  if (shouldContain) groupSet.add(key)
  else groupSet.delete(key)
  try { save() } catch (error) {
    if (contained) groupSet.add(key)
    else groupSet.delete(key)
    throw error
  }
  return true
}
