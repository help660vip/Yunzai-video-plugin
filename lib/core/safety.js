import { config, normalizePlatformName } from "./config.js"

export const BLOCKED_CONTENT_MESSAGE = "检测到受限内容，已停止解析。"
export const BLOCKED_CONTENT = Object.freeze({ __parserBlocked: true })

const R18_PATTERN =
  /(?:\bnsfw\b|\br[\s_-]?18\b|18\s*禁|🔞|adult\s+content|porn(?:ography)?|hentai|成人向|成人视频|色情内容|成人内容)/iu

export function isBlockedContent(value) {
  return value === BLOCKED_CONTENT || value?.__parserBlocked === true
}

export function shouldBlockResult(result) {
  if (!config.parser_r18_filter_enabled || !result?.platform) return false
  const platform = normalizePlatformName(result.platform.name)
  if (!config.parser_r18_platforms.includes(platform)) return false
  return unsafeResult(result, platform)
}

function unsafeResult(result, platform) {
  const safety = result.safety || {}
  const extra = result.extra || {}
  const rating = String(safety.rating || extra.rating || "").toLowerCase()
  const ageLimit = Number(
    safety.ageLimit ?? safety.age_limit ?? extra.ageLimit ?? extra.age_limit ?? 0,
  )
  if (rating === "adult" || safety.adult === true || extra.adult === true) return true
  if (ageLimit >= 18) return true
  if (
    platform === "twitter" &&
    config.parser_block_x_sensitive &&
    (safety.sensitive === true ||
      extra.possiblySensitive === true ||
      extra.possibly_sensitive === true)
  ) {
    return true
  }
  if (textualValues(result).some(value => R18_PATTERN.test(value))) return true
  return result.repost ? unsafeResult(result.repost, platform) : false
}

function textualValues(result) {
  const output = []
  append(output, result.title)
  append(output, result.text)
  append(output, result.aiSummary)
  append(output, result.author?.description)
  append(output, result.extra?.tags)
  append(output, result.extra?.categories)
  for (const item of result.content || []) appendContent(output, item)
  for (const comment of result.comments || []) appendComment(output, comment)
  return output
}

function append(output, value) {
  if (Array.isArray(value)) {
    for (const item of value) append(output, item)
  } else if (typeof value === "string" && value.trim()) {
    output.push(value)
  }
}

function appendContent(output, item) {
  if (typeof item === "string") {
    append(output, item)
    return
  }
  if (!item || typeof item !== "object") return
  append(output, item.text)
  append(output, item.title)
  append(output, item.description)
  append(output, item.siteName)
  append(output, item.desc)
  for (const option of item.options || []) append(output, option.text)
}

function appendComment(output, comment) {
  append(output, comment.author?.description)
  for (const item of comment.content || []) appendContent(output, item)
  for (const reply of comment.replies || []) appendComment(output, reply)
}
