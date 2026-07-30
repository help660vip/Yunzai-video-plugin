import fs from "node:fs"
import path from "node:path"
import YAML from "yaml"

import { configDir, ensureRuntimeDirectories } from "./paths.js"
import { log } from "./logger.js"

export const PLATFORM_NAMES = Object.freeze([
  "acfun",
  "bilibili",
  "douyin",
  "kuaishou",
  "nga",
  "tiktok",
  "twitter",
  "weibo",
  "xiaohongshu",
  "youtube",
])

export const DEFAULT_CONFIG = Object.freeze({
  parser_bili_ck: null,
  parser_ytb_ck: null,
  parser_xhs_ck: null,
  parser_proxy: null,
  parser_need_upload: false,
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
})

const QUALITY_VALUES = new Set([16, 32, 64, 80, 112, 116, 120])
const VIDEO_CODES = new Set(["avc", "av01", "hev"])
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

function validate(raw = {}) {
  const cfg = { ...DEFAULT_CONFIG }
  cfg.parser_bili_ck = stringOrNull(raw.parser_bili_ck, cfg.parser_bili_ck)
  cfg.parser_ytb_ck = stringOrNull(raw.parser_ytb_ck, cfg.parser_ytb_ck)
  cfg.parser_xhs_ck = stringOrNull(raw.parser_xhs_ck, cfg.parser_xhs_ck)
  cfg.parser_proxy = stringOrNull(raw.parser_proxy, cfg.parser_proxy)
  cfg.parser_custom_font = stringOrNull(raw.parser_custom_font, cfg.parser_custom_font)

  for (const key of [
    "parser_need_upload",
    "parser_use_base64",
    "parser_append_url",
    "parser_need_forward_contents",
    "parser_group_blacklist_enabled",
  ]) {
    cfg[key] = booleanValue(raw[key], cfg[key])
  }

  cfg.parser_max_size = integerValue(raw.parser_max_size, cfg.parser_max_size)
  cfg.parser_duration_maximum = integerValue(
    raw.parser_duration_maximum,
    cfg.parser_duration_maximum,
  )
  cfg.parser_custom_font_weight = integerValue(
    raw.parser_custom_font_weight,
    cfg.parser_custom_font_weight,
  )

  if (QUALITY_VALUES.has(Number(raw.parser_bili_video_quality))) {
    cfg.parser_bili_video_quality = Number(raw.parser_bili_video_quality)
  }
  if (Array.isArray(raw.parser_bili_video_codes)) {
    const codes = raw.parser_bili_video_codes.filter(code => VIDEO_CODES.has(code))
    if (codes.length) cfg.parser_bili_video_codes = codes
  }
  if (Array.isArray(raw.parser_disabled_platforms)) {
    cfg.parser_disabled_platforms = raw.parser_disabled_platforms.filter(name =>
      PLATFORM_NAMES.includes(name),
    )
  }
  if (RENDER_TYPES.has(raw.parser_render_type)) cfg.parser_render_type = raw.parser_render_type
  if (EMOJI_STYLES.has(raw.parser_emoji_style)) cfg.parser_emoji_style = raw.parser_emoji_style
  if (typeof raw.parser_emoji_cdn === "string" && raw.parser_emoji_cdn) {
    cfg.parser_emoji_cdn = raw.parser_emoji_cdn.replace(/\/+$/, "")
  }
  return cfg
}

export function loadConfig() {
  ensureRuntimeDirectories()
  const configPath = path.join(configDir, "config.yaml")
  try {
    const raw = YAML.parse(fs.readFileSync(configPath, "utf8")) || {}
    const cfg = validate(raw)
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
