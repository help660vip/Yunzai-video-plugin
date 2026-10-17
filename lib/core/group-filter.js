import fs from "node:fs"
import path from "node:path"

import { config } from "./config.js"
import { dataDir } from "./paths.js"

const groupSetPath = path.join(dataDir, "group_set.json")
const legacyPath = path.join(dataDir, "disabled_groups.json")
const disabledTargetsPath = path.join(dataDir, "disabled_targets.json")

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

function loadDisabledTargets() {
  if (!fs.existsSync(disabledTargetsPath)) fs.writeFileSync(disabledTargetsPath, "[]", "utf8")
  try {
    const values = JSON.parse(fs.readFileSync(disabledTargetsPath, "utf8"))
    return new Set(Array.isArray(values) ? values.map(String).filter(Boolean) : [])
  } catch {
    return new Set()
  }
}

export const disabledTargets = loadDisabledTargets()

function saveSet(filePath, values) {
  const temporary = filePath + "." + process.pid + ".tmp"
  let descriptor
  try {
    descriptor = fs.openSync(temporary, "wx")
    fs.writeFileSync(descriptor, JSON.stringify([...values].sort()), "utf8")
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = undefined
    fs.renameSync(temporary, filePath)
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
    try { fs.unlinkSync(temporary) } catch (error) { if (error.code !== "ENOENT") throw error }
  }
}

function saveGroups() {
  saveSet(groupSetPath, groupSet)
}

function saveDisabledTargets() {
  saveSet(disabledTargetsPath, disabledTargets)
}

function adapterScope(e) {
  const adapter =
    e?.adapter_name || e?.adapter?.name || e?.bot?.adapter?.name || e?.platform || "QQClient"
  return /icqq|onebot|qq/i.test(String(adapter)) ? "QQClient" : String(adapter)
}

export function groupKey(e) {
  return `${adapterScope(e)}_${e.group_id}`
}

export function userKeys(e) {
  const scope = adapterScope(e)
  const userId = String(e?.user_id || e?.sender?.user_id || "")
  return userId ? [userId, scope + "_" + userId] : []
}

export function targetKey(e, target = null) {
  const scope = adapterScope(e)
  const raw = target === null || target === undefined ? "" : String(target).trim()
  const explicit = /^(group|user|private):(.+)$/i.exec(raw)
  const type = explicit
    ? explicit[1].toLowerCase()
    : e?.isGroup || e?.group_id
      ? "group"
      : "user"
  const id = explicit?.[2] || raw || (type === "group" ? e?.group_id : e?.user_id || e?.sender?.user_id)
  if (!id) return null
  return `${scope}_${type === "group" ? "GROUP" : "USER"}_${String(id)}`
}

export function isEnabled(e) {
  if (userKeys(e).some(key => config.parser_blacklist_users.includes(key))) return false
  const userId = e?.user_id || e?.sender?.user_id
  const userTarget = userId ? targetKey(e, `user:${userId}`) : null
  if (userTarget && disabledTargets.has(userTarget)) return false
  if (!e?.isGroup && !e?.group_id) return true
  const present = groupSet.has(groupKey(e))
  return config.parser_group_blacklist_enabled ? !present : present
}

export function setEnabled(e, enabled, target = null) {
  const key = targetKey(e, target)
  if (!key) return false
  const explicit = target !== null && target !== undefined && String(target).trim() !== ""
  const targetMatch = /^(group|user|private):(.+)$/i.exec(String(target || "").trim())
  const groupId = targetMatch?.[1].toLowerCase() === "group"
    ? targetMatch[2]
    : !targetMatch && (e?.isGroup || e?.group_id)
      ? explicit ? String(target).trim() : e.group_id
      : null
  const groupEvent = groupId ? { ...e, isGroup: true, group_id: groupId } : null
  if (groupEvent) {
    const groupListKey = groupKey(groupEvent)
    const previousGroupContained = groupSet.has(groupListKey)
    const shouldContain = config.parser_group_blacklist_enabled ? !enabled : enabled
    if (previousGroupContained === shouldContain) return false
    if (shouldContain) groupSet.add(groupListKey)
    else groupSet.delete(groupListKey)
    try {
      saveGroups()
    } catch (error) {
      if (previousGroupContained) groupSet.add(groupListKey)
      else groupSet.delete(groupListKey)
      throw error
    }
    return true
  }

  const wasDisabled = disabledTargets.has(key)
  if (enabled) disabledTargets.delete(key)
  else disabledTargets.add(key)
  const targetChanged = wasDisabled === enabled
  if (!targetChanged) return false
  try {
    saveDisabledTargets()
  } catch (error) {
    if (wasDisabled) disabledTargets.add(key)
    else disabledTargets.delete(key)
    throw error
  }
  return true
}
