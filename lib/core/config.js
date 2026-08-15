import fs from "node:fs"
import path from "node:path"
import YAML from "yaml"

import { configDir, ensureRuntimeDirectories } from "./paths.js"
import { log } from "./logger.js"

export const PLATFORM_NAMES = Object.freeze([
  "acfun",
  "bilibili",
  "buff",
  "coolapk",
  "douban",
  "doubao",
  "douyin",
  "ds",
  "duitang",
  "fiveeplay",
  "heybox",
  "hupu",
  "illu",
  "kuaishou",
  "kugou",
  "kuwo",
  "linuxdo",
  "lofter",
  "miyoushe",
  "nga",
  "netease",
  "qsmusic",
  "tiktok",
  "taptap",
  "tieba",
  "twitter",
  "weibo",
  "wmpvp",
  "xiaohongshu",
  "youtube",
  "zhihu",
  "zlb",
])

export const PLATFORM_ALIASES = Object.freeze({
  x: "twitter",
  rednote: "xiaohongshu",
  "5eplay": "fiveeplay",
})

export function normalizePlatformName(name) {
  const value = String(name || "").trim().toLowerCase()
  return PLATFORM_ALIASES[value] || value
}

export const DEFAULT_CONFIG = Object.freeze({
  parser_bili_ck: null,
  parser_ytb_ck: null,
  parser_xhs_ck: null,
  parser_proxy: null,
  parser_need_upload: false,
  parser_need_upload_audio: false,
  parser_need_upload_video: false,
  parser_use_base64: false,
  parser_max_size: 90,
  parser_duration_maximum: 480,
  parser_append_url: false,
  parser_disabled_platforms: [],
  parser_bili_video_codes: ["avc", "av01", "hev"],
  parser_bili_video_quality: 80,
  parser_render_type: "common",
  parser_custom_font: null,
  parser_custom_font_weight: 700,
  parser_need_forward_contents: true,
  parser_emoji_cdn: "https://emojicdn.elk.sh",
  parser_emoji_style: "facebook",
  parser_group_blacklist_enabled: true,
  parser_zhihu_ck: null,
  parser_linuxdo_ck: null,
  parser_embed_url: false,
  parser_append_qrcode: false,
  parser_blacklist_users: [],
  parser_lazy_download: false,
  parser_lazy_download_tip: false,
  parser_lazy_download_timeout: 30,
  parser_download_command: ["xz", "下载"],
  parser_live_photo: true,
  parser_max_comments: 5,
  parser_forward_text_threshold: 1000,
  parser_max_retries: 3,
  parser_day_range: ["6:00", "19:00"],
  parser_bili_cdn_region: "zh",
  parser_bili_cdn_domain: null,
  parser_r18_filter_enabled: true,
  parser_r18_platforms: ["twitter", "youtube", "tiktok"],
  parser_block_x_sensitive: true,
  parser_cache_retention_hours: 24,
  parser_cache_max_mb: 1024,
  parser_dedup_enabled: true,
  parser_dedup_window_seconds: 30,
})

const QUALITY_VALUES = new Set([16, 32, 64, 80, 112, 116, 120])
const VIDEO_CODES = new Set(["avc", "av01", "hev", "unknown"])
const RENDER_TYPES = new Set(["default", "common", "htmlrender", "htmlkit"])
const EMOJI_STYLES = new Set(["apple", "google", "twitter", "facebook"])

function stringOrNull(value, fallback) {
  if (value === null || value === undefined || value === "") return null
  return typeof value === "string" ? value : fallback
}

function booleanValue(value, fallback) {
  return typeof value === "boolean" ? value : fallback
}

function integerValue(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback
  const converted = Number(value)
  return Number.isInteger(converted) ? converted : fallback
}

export function validateConfig(raw = {}) {
  const cfg = { ...DEFAULT_CONFIG }
  cfg.parser_bili_ck = stringOrNull(raw.parser_bili_ck, cfg.parser_bili_ck)
  cfg.parser_ytb_ck = stringOrNull(raw.parser_ytb_ck, cfg.parser_ytb_ck)
  cfg.parser_xhs_ck = stringOrNull(raw.parser_xhs_ck, cfg.parser_xhs_ck)
  cfg.parser_proxy = stringOrNull(raw.parser_proxy, cfg.parser_proxy)
  cfg.parser_custom_font = stringOrNull(raw.parser_custom_font, cfg.parser_custom_font)
  cfg.parser_zhihu_ck = stringOrNull(raw.parser_zhihu_ck, cfg.parser_zhihu_ck)
  cfg.parser_linuxdo_ck = stringOrNull(raw.parser_linuxdo_ck, cfg.parser_linuxdo_ck)
  cfg.parser_bili_cdn_domain = stringOrNull(
    raw.parser_bili_cdn_domain,
    cfg.parser_bili_cdn_domain,
  )
  if (
    cfg.parser_bili_cdn_domain &&
    !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*bilivideo\.com$/i.test(
      cfg.parser_bili_cdn_domain,
    )
  ) {
    cfg.parser_bili_cdn_domain = null
  }
  if (typeof raw.parser_bili_cdn_region === "string" && raw.parser_bili_cdn_region.trim()) {
    cfg.parser_bili_cdn_region = raw.parser_bili_cdn_region.trim().toLowerCase()
  }

  for (const key of [
    "parser_need_upload",
    "parser_need_upload_audio",
    "parser_need_upload_video",
    "parser_use_base64",
    "parser_append_url",
    "parser_need_forward_contents",
    "parser_group_blacklist_enabled",
    "parser_embed_url",
    "parser_append_qrcode",
    "parser_lazy_download",
    "parser_lazy_download_tip",
    "parser_live_photo",
    "parser_r18_filter_enabled",
    "parser_block_x_sensitive",
    "parser_dedup_enabled",
  ]) {
    cfg[key] = booleanValue(raw[key], cfg[key])
  }

  if (!Object.prototype.hasOwnProperty.call(raw, "parser_need_upload_audio")) {
    cfg.parser_need_upload_audio = cfg.parser_need_upload
  }
  if (!Object.prototype.hasOwnProperty.call(raw, "parser_need_upload_video")) {
    cfg.parser_need_upload_video = cfg.parser_need_upload
  }

  for (const key of [
    "parser_max_size",
    "parser_duration_maximum",
    "parser_custom_font_weight",
    "parser_lazy_download_timeout",
    "parser_max_comments",
    "parser_forward_text_threshold",
    "parser_max_retries",
    "parser_cache_retention_hours",
    "parser_cache_max_mb",
    "parser_dedup_window_seconds",
  ]) {
    const value = integerValue(raw[key], cfg[key])
    if (value >= 0) cfg[key] = value
  }
  cfg.parser_forward_text_threshold = Math.min(4500, cfg.parser_forward_text_threshold)
  cfg.parser_max_comments = Math.min(20, cfg.parser_max_comments)
  cfg.parser_cache_retention_hours = Math.max(1, cfg.parser_cache_retention_hours)
  cfg.parser_cache_max_mb = Math.max(1, cfg.parser_cache_max_mb)
  cfg.parser_dedup_window_seconds = Math.max(1, cfg.parser_dedup_window_seconds)

  if (QUALITY_VALUES.has(Number(raw.parser_bili_video_quality))) {
    cfg.parser_bili_video_quality = Number(raw.parser_bili_video_quality)
  }
  if (Array.isArray(raw.parser_bili_video_codes)) {
    const codes = raw.parser_bili_video_codes.filter(code => VIDEO_CODES.has(code))
    if (codes.length) cfg.parser_bili_video_codes = codes
  }
  if (Array.isArray(raw.parser_disabled_platforms)) {
    cfg.parser_disabled_platforms = [
      ...new Set(
        raw.parser_disabled_platforms
          .map(normalizePlatformName)
          .filter(name => PLATFORM_NAMES.includes(name)),
      ),
    ]
  }
  if (Array.isArray(raw.parser_r18_platforms)) {
    cfg.parser_r18_platforms = [
      ...new Set(
        raw.parser_r18_platforms
          .map(normalizePlatformName)
          .filter(name => PLATFORM_NAMES.includes(name)),
      ),
    ]
  }
  if (Array.isArray(raw.parser_blacklist_users)) {
    cfg.parser_blacklist_users = raw.parser_blacklist_users.map(String).filter(Boolean)
  }
  if (Array.isArray(raw.parser_download_command)) {
    const commands = raw.parser_download_command.map(String).map(item => item.trim()).filter(Boolean)
    if (commands.length) cfg.parser_download_command = [...new Set(commands)]
  }
  if (
    Array.isArray(raw.parser_day_range) &&
    raw.parser_day_range.length === 2 &&
    raw.parser_day_range.every(isClockValue)
  ) {
    cfg.parser_day_range = raw.parser_day_range
  }
  if (RENDER_TYPES.has(raw.parser_render_type)) cfg.parser_render_type = raw.parser_render_type
  if (EMOJI_STYLES.has(raw.parser_emoji_style)) cfg.parser_emoji_style = raw.parser_emoji_style
  if (typeof raw.parser_emoji_cdn === "string" && raw.parser_emoji_cdn) {
    cfg.parser_emoji_cdn = raw.parser_emoji_cdn.replace(/\/+$/, "")
  }
  return cfg
}

function isClockValue(value) {
  if (typeof value !== "string" || !/^\d{1,2}:\d{2}$/.test(value)) return false
  const [hour, minute] = value.split(":").map(Number)
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59
}

export const configPath = path.join(configDir, "config.yaml")

export function loadConfig(filePath = configPath) {
  ensureRuntimeDirectories()
  try {
    const raw = YAML.parse(fs.readFileSync(filePath, "utf8")) || {}
    const cfg = validateConfig(raw)
    for (const key of Object.keys(DEFAULT_CONFIG)) {
      if (Object.prototype.hasOwnProperty.call(raw, key) && cfg[key] !== raw[key]) {
        if (Array.isArray(cfg[key]) && JSON.stringify(cfg[key]) === JSON.stringify(raw[key])) continue
        log.warn(`[parser] 配置项 ${key} 无效或包含无效值，已采用兼容值`)
      }
    }
    return cfg
  } catch (error) {
    log.error("[parser] 读取 config/config.yaml 失败，使用默认配置", error)
    return { ...DEFAULT_CONFIG }
  }
}

export const config = loadConfig()

const configListeners = new Set()

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function replaceConfig(next) {
  const previous = { ...config }
  for (const key of Object.keys(config)) delete config[key]
  Object.assign(config, next)
  for (const listener of configListeners) {
    try {
      listener(config, previous)
    } catch (error) {
      log.warn("[parser] Config hot-reload listener failed", error)
    }
  }
  return config
}

export function onConfigChange(listener) {
  if (typeof listener !== "function") throw new TypeError("Config listener must be a function")
  configListeners.add(listener)
  return () => configListeners.delete(listener)
}

export function reloadConfig(filePath = configPath) {
  return replaceConfig(loadConfig(filePath))
}

function assertConfigPatch(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new TypeError("Config patch must be an object")
  }
  const candidate = validateConfig({ ...config, ...patch })
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_CONFIG, key)) {
      throw new Error("Unknown config key: " + key)
    }
    if (!sameValue(candidate[key], value)) {
      throw new Error("Invalid config value: " + key)
    }
  }
  return candidate
}

export function saveConfig(patch, filePath = configPath) {
  const next = assertConfigPatch(patch)
  ensureRuntimeDirectories()
  const source = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : ""
  const document = YAML.parseDocument(source || "{}\n")
  if (document.errors.length) throw document.errors[0]
  for (const key of Object.keys(DEFAULT_CONFIG)) document.set(key, next[key])

  const temporaryPath = filePath + "." + process.pid + "." + Date.now() + ".tmp"
  let descriptor
  try {
    descriptor = fs.openSync(temporaryPath, "wx")
    fs.writeFileSync(descriptor, String(document), "utf8")
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = undefined
    fs.renameSync(temporaryPath, filePath)
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor)
    try {
      fs.unlinkSync(temporaryPath)
    } catch {}
    throw error
  }
  return replaceConfig(next)
}

export function customFontPath() {
  if (!config.parser_custom_font) return null
  const candidate = path.join(configDir, config.parser_custom_font)
  if (fs.existsSync(candidate)) return candidate
  const legacy = path.join(configDir, "..", "data", config.parser_custom_font)
  if (!fs.existsSync(legacy)) return null
  try {
    fs.mkdirSync(path.dirname(candidate), { recursive: true })
    fs.renameSync(legacy, candidate)
    log.info(`[parser] 字体文件已从 data 迁移到 ${candidate}`)
    return candidate
  } catch (error) {
    log.warn(`[parser] 字体文件迁移失败，继续使用旧路径 ${legacy}`, error)
    return legacy
  }
}
