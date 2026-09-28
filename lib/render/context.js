import fs from "node:fs/promises"
import path from "node:path"
import QRCode from "qrcode"
import { config } from "../core/config.js"
import { cacheLifecycle } from "../core/cache-lifecycle.js"
import { resourcesDir } from "../core/paths.js"
import { AudioContent, GraphicContent, ImageContent, LinkContent, LivePhotoContent, PollContent, QuoteContent, StickerContent, VideoContent } from "../core/model.js"
import { MUSIC_PLATFORMS, THEME_SCHEMA_VERSION } from "./theme.js"

export const PLACEHOLDER_IMAGE = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"

export async function safeSource(task, fallback = PLACEHOLDER_IMAGE) {
  try {
    const file = typeof task === "string" ? task : await task?.safeGet()
    if (!file) return fallback
    return await cacheLifecycle.withActive(file, async () => {
      const data = await fs.readFile(file)
      let mime = "image/jpeg"
      if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) mime = "image/png"
      else if (data.subarray(0, 3).toString() === "GIF") mime = "image/gif"
      else if (data.subarray(8, 12).toString() === "WEBP") mime = "image/webp"
      return `data:${mime};base64,${data.toString("base64")}`
    })
  } catch { return fallback }
}

function jsonValue(value, seen = new Set(), depth = 0) {
  if (value == null || ["string", "boolean", "number"].includes(typeof value)) return value ?? null
  if (depth > 16 || seen.has(value) || typeof value !== "object") return null
  seen.add(value)
  const result = Array.isArray(value)
    ? value.map(item => jsonValue(item, seen, depth + 1))
    : Object.fromEntries(Object.entries(value).filter(([key]) => !["__proto__", "constructor", "prototype"].includes(key)).map(([key, item]) => [key, jsonValue(item, seen, depth + 1)]))
  seen.delete(value)
  return result
}

export function serializeStats(stats = {}) {
  return {
    view_count: stats.viewCount ?? null, like_count: stats.likeCount ?? null,
    collect_count: stats.collectCount ?? null, share_count: stats.shareCount ?? null,
    comment_count: stats.commentCount ?? null,
    extra: Object.entries(stats.extra || {}).map(([key, value]) => ({
      key, label: Array.isArray(value) ? value[0] : key === "hot" ? "热度" : key,
      value: jsonValue(Array.isArray(value) ? value[1] : value),
    })),
  }
}

async function serializeAuthor(author) {
  if (!author) return null
  return { name: author.name, id: author.id, description: author.description, location: author.location,
    avatar: await safeSource(author.avatar, await safeSource(path.join(resourcesDir, "avatar.png"))) }
}

async function displaySize(item) {
  if (item.isDynamicSize) return "动态大小"
  const size = item.sizeBytes ?? item._sizeBytes ?? item.pathTask?.size
  return Number.isFinite(size) && size >= 0 ? (size / 1024 / 1024).toFixed(1) + " MiB" : "未知大小"
}

export async function serializeContent(item, isCover = false) {
  if (typeof item === "string") return { type: "text", text: item }
  if (item instanceof ImageContent || item instanceof GraphicContent) {
    return { type: isCover ? "cover" : item instanceof ImageContent ? "image" : "graphic",
      src: await safeSource(item.pathTask), layout: item.layout || "grid", alt: item.alt,
      is_live: false, source_url: item.pathTask?.url || null }
  }
  if (item instanceof LivePhotoContent) return { type: "live_photo", src: await safeSource(item.baseImage), layout: "grid", is_live: true, source_url: item.pathTask?.url || null }
  if (item instanceof StickerContent) return { type: "sticker", src: await safeSource(item.pathTask, null), size: item.size, description: item.description }
  if (item instanceof VideoContent) return { type: "video", src: item.cover?.requiresMedia ? PLACEHOLDER_IMAGE : await safeSource(item.cover), duration: item.displayDuration, size: await displaySize(item), source_url: item.pathTask?.url || null }
  if (item instanceof AudioContent) return { type: "audio", duration: item.displayDuration, size: await displaySize(item), source_url: item.pathTask?.url || null }
  if (item instanceof LinkContent) return { type: "link", url: item.url, title: item.title, site_name: item.siteName,
    description: item.description, icon: await safeSource(item.icon, null), preview: await safeSource(item.preview, null) }
  if (item instanceof QuoteContent) return { type: "quote", text: item.text, title: item.title, url: item.url, icon: await safeSource(item.icon, null) }
  if (item instanceof PollContent) return { type: "poll", title: item.title,
    options: item.options.map(option => ({ text: option.text, votes: option.votes, percentage: item.optionPercentage(option) })),
    option_vote_total: item.optionVoteTotal, total_votes: item.totalVotes, total_voters: item.totalVoters,
    multiple: item.multiple, closed: item.closed, close_at: item.closeAt }
  return { type: "unknown", text: "" }
}

async function serializeComment(comment, depth = 0) {
  return { author: await serializeAuthor(comment.author), content: await Promise.all((comment.content || []).map(item => serializeContent(item))),
    timestamp: comment.timestamp, formatted_datetime: comment.formattedDatetime,
    stats: serializeStats(comment.stats), parent_author: await serializeAuthor(comment.parentAuthor),
    replies: depth < 8 ? await Promise.all((comment.replies || []).slice(0, 20).map(item => serializeComment(item, depth + 1))) : [] }
}

export async function buildThemeData(result, { colorScheme = "light", themeId = "default", botName = "Yunzai", maxComments = config.parser_max_comments, appendQrcode = config.parser_append_qrcode } = {}) {
  const seen = new Set()
  const serializePost = async (post, depth = 0) => {
    if (!post || seen.has(post) || depth > 10) return null
    seen.add(post)
    let coverFound = false
    const content = []
    for (const item of post.orderedContent) {
      const cover = MUSIC_PLATFORMS.has(post.platform.name) && !coverFound && (item instanceof ImageContent || item instanceof GraphicContent)
      content.push(await serializeContent(item, cover))
      coverFound ||= cover
    }
    return { title: post.title, url: post.url, timestamp: post.timestamp, formatted_datetime: post.formattedDatetime(),
      extra: jsonValue(post.extra), platform: { id: post.platform.name, name: post.platform.displayName, logo: await safeSource(path.join(resourcesDir, post.platform.name + ".png")) },
      author: await serializeAuthor(post.author), content, stats: serializeStats(post.stats),
      comments: await Promise.all(post.comments.slice(0, maxComments).map(comment => serializeComment(comment))),
      qrcode: null, ai_summary: post.aiSummary, embed_url: post.embedUrl, repost: await serializePost(post.repost, depth + 1) }
  }
  const post = await serializePost(result)
  if (appendQrcode && result.url) post.qrcode = await QRCode.toDataURL(result.url, { margin: 1, width: 116 })
  return { schema_version: THEME_SCHEMA_VERSION, theme: colorScheme, theme_id: themeId, post,
    meta: { bot_name: botName, rendering_time: new Date().toISOString(), width: 752 } }
}
