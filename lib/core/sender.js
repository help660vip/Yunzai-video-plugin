import fs from "node:fs"
import path from "node:path"

import { config } from "./config.js"
import { cacheLifecycle } from "./cache-lifecycle.js"
import { DownloadError, IgnoreError } from "./errors.js"
import {
  AudioContent,
  GraphicContent,
  ImageContent,
  LivePhotoContent,
  LinkContent,
  MediaContent,
  PollContent,
  QuoteContent,
  StickerContent,
  VideoContent,
} from "./model.js"
import { log } from "./logger.js"

function segmentApi() {
  return globalThis.segment || {}
}

async function encodedFile(filePath) {
  if (!config.parser_use_base64) return filePath
  return `base64://${(await fs.promises.readFile(filePath)).toString("base64")}`
}

export async function imageSegment(filePath) {
  const file = await encodedFile(filePath)
  const factory = segmentApi().image
  return typeof factory === "function" ? factory(file) : { type: "image", file }
}

export async function recordSegment(filePath) {
  const file = await encodedFile(filePath)
  const factory = segmentApi().record
  return typeof factory === "function"
    ? factory(file, path.basename(filePath))
    : { type: "record", file }
}

export async function fileSegment(filePath, name = path.basename(filePath)) {
  const file = await encodedFile(filePath)
  const factory = segmentApi().file
  return typeof factory === "function" ? factory(file, name) : { type: "file", file, name }
}

export async function videoSegment(filePath, thumbnail = null) {
  const stat = await fs.promises.stat(filePath)
  if (stat.size === 0) return "视频为空文件"
  if (stat.size > 100 * 1024 * 1024) return fileSegment(filePath)
  const file = await encodedFile(filePath)
  const factory = segmentApi().video
  const video =
    typeof factory === "function"
      ? factory(file, path.basename(filePath))
      : { type: "video", file }
  if (thumbnail) {
    try {
      if ((await fs.promises.stat(thumbnail)).size > 0) {
        video.thumb = await encodedFile(thumbnail)
        video.thumbnail = video.thumb
      }
    } catch {}
  }
  return video
}

export async function sendFile(e, filePath, name = path.basename(filePath)) {
  return cacheLifecycle.withActive(filePath, () => sendFileInternal(e, filePath, name))
}

async function sendFileInternal(e, filePath, name) {
  if (typeof segmentApi().file === "function" && typeof e?.reply === "function") {
    try {
      await e.reply(await fileSegment(filePath, name))
      return
    } catch (error) {
      log.warn("[parser] 通用文件消息发送失败，尝试适配器上传接口", error)
    }
  }

  const nativeUploads = [
    e?.group?.sendFile
      ? () => e.group.sendFile(filePath, name)
      : null,
    e?.friend?.sendFile
      ? () => e.friend.sendFile(filePath, name)
      : null,
    e?.group?.fs?.upload
      ? () => e.group.fs.upload(filePath, "/", name)
      : null,
    e?.bot?.uploadGroupFile && e?.group_id
      ? () => e.bot.uploadGroupFile(e.group_id, filePath, name)
      : null,
    e?.bot?.uploadPrivateFile && e?.user_id
      ? () => e.bot.uploadPrivateFile(e.user_id, filePath, name)
      : null,
  ].filter(Boolean)
  for (const upload of nativeUploads) {
    try {
      await upload()
      return
    } catch {}
  }

  if (typeof e?.bot?.sendApi === "function") {
    try {
      await e.bot.sendApi(e.group_id ? "upload_group_file" : "upload_private_file", {
        ...(e.group_id ? { group_id: e.group_id } : { user_id: e.user_id }),
        file: filePath,
        name,
      })
      return
    } catch {}
  }

  log.warn("[parser] 当前适配器没有文件上传接口，退化为通用文件消息段")
  await e.reply(await fileSegment(filePath, name))
}

export async function sendVideo(e, filePath, thumbnail = null) {
  return cacheLifecycle.withActive([filePath, thumbnail], async () => {
  const stat = await fs.promises.stat(filePath)
  if (stat.size > 100 * 1024 * 1024) {
    await sendFile(e, filePath)
    return
  }
  await e.reply(await videoSegment(filePath, thumbnail))
  })
}

function botNickname(e) {
  return e?.bot?.nickname || e?.bot?.name || e?.nickname || "Yunzai 视频解析"
}

export async function makeForward(e, contents) {
  const userId = String(e?.self_id || e?.bot?.uin || e?.bot?.self_id || 10000)
  const nodes = contents.map(content => ({
    user_id: userId,
    nickname: botNickname(e),
    message: content,
  }))
  const owner = [e?.group, e?.friend, e?.bot].find(value => typeof value?.makeForwardMsg === "function")
  const maker = owner?.makeForwardMsg
  if (typeof maker === "function") {
    try {
      return await maker.call(owner, nodes)
    } catch (error) {
      log.warn("[parser] 合并转发构造失败，退化为普通消息", error)
    }
  }
  return contents.flatMap((item, index) => (index ? ["\n", item] : [item]))
}

export async function reaction(e, status) {
  const emoji = {
    resolving: { id: "424", text: "👀" },
    done: { id: "144", text: "🎉" },
    fail: { id: "10060", text: "❌" },
  }[status]
  if (!emoji || !e?.message_id) return
  const candidates = [
    () => e.group?.setReaction?.(e.message_id, emoji.id, true),
    () => e.friend?.setReaction?.(e.message_id, emoji.id, true),
    () =>
      e.bot?.sendApi?.("set_msg_emoji_like", {
        message_id: e.message_id,
        emoji_id: emoji.id,
        set: true,
      }),
    () => e.bot?.setMsgEmojiLike?.(e.message_id, emoji.id, true),
  ]
  for (const invoke of candidates) {
    try {
      const result = invoke()
      if (result !== undefined) {
        await result
        return
      }
    } catch {}
  }
  log.debug(`[parser] 当前适配器不支持消息表态: ${emoji.text}`)
}

const mediaRoles = new WeakMap()
const MEDIA_TYPES = new Set(["image", "video", "record", "audio", "voice", "file"])
export const MAX_FORWARD_NODES = 90
export const MAX_FORWARD_TEXT_LENGTH = 30000

export function markMediaRole(segment, role) {
  if (segment && typeof segment === "object") mediaRoles.set(segment, { ...(mediaRoles.get(segment) || {}), role })
  return segment
}

function snapshot(value) {
  if (Array.isArray(value)) return value.map(snapshot)
  if (!value || typeof value !== "object") return value
  if (Buffer.isBuffer(value)) return Buffer.from(value)
  const copied = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, snapshot(item)]))
  if (mediaRoles.has(value)) mediaRoles.set(copied, { ...mediaRoles.get(value) })
  return copied
}

export function isMediaUploadError(error) {
  const pattern = /\bHTTP Upload failed with code \d+\b|\brich media transfer failed\b|\bHighway request timeout\b/i
  return [error, error?.info, error?.data].filter(Boolean).some(value =>
    [value.message, value.wording, value.msg].some(message => typeof message === "string" && pattern.test(message)))
}

export function splitText(text, maxLength) {
  const chars = [...String(text)]
  if (maxLength <= 0 || chars.length <= maxLength) return [chars.join("")]
  const output = []
  for (let start = 0; start < chars.length;) {
    let end = Math.min(start + maxLength, chars.length)
    if (end < chars.length) {
      for (let cursor = end - 1; cursor >= start; cursor--) {
        if (/[。！？!?；;，,、…\n]/.test(chars[cursor])) { end = cursor + 1; break }
      }
    }
    output.push(chars.slice(start, end).join(""))
    start = end
  }
  return output
}

function plainText(node) {
  if (typeof node === "string") return node
  if (Array.isArray(node)) return node.map(plainText).join("")
  return node?.type === "text" ? String(node.text ?? node.data?.text ?? "") : ""
}

export function packForwardNodes(contents) {
  const softLimit = Math.min(MAX_FORWARD_TEXT_LENGTH, Math.max(1, config.parser_forward_text_threshold || MAX_FORWARD_TEXT_LENGTH))
  const nodes = []
  for (const node of contents) {
    let fragment = [], length = 0
    for (const segment of Array.isArray(node) ? node : [node]) {
      const isText = typeof segment === "string" || segment?.type === "text"
      const role = segment && typeof segment === "object" ? mediaRoles.get(segment)?.role : null
      const protectedText = role === "protected-text"
      const parts = isText ? splitText(plainText(segment), protectedText ? MAX_FORWARD_TEXT_LENGTH : softLimit).map(text => role ? markMediaRole({ type: "text", text }, role) : text) : [segment]
      for (const part of parts) {
        const size = [...plainText(part)].length
        if (fragment.length && length + size > softLimit) { nodes.push(fragment); fragment = []; length = 0 }
        fragment.push(part)
        length += size
      }
    }
    if (fragment.length) nodes.push(fragment)
  }
  const packets = []
  let packet = [], length = 0
  for (const node of nodes) {
    const size = [...plainText(node)].length
    if (packet.length && (packet.length >= MAX_FORWARD_NODES || length + size > MAX_FORWARD_TEXT_LENGTH)) {
      packets.push(packet); packet = []; length = 0
    }
    packet.push(node); length += size
  }
  if (packet.length) packets.push(packet)
  return packets
}

export function buildMediaFallback(nodes, result, videoOnly = false) {
  const converted = []
  let replaced = false, hasSummary = false
  for (const node of nodes) {
    const parts = []
    for (const segment of Array.isArray(node) ? node : [node]) {
      if (segment && typeof segment === "object" && mediaRoles.get(segment)?.role === "fallback-notice") continue
      if (typeof segment === "string" || segment?.type === "text") { parts.push(snapshot(segment)); continue }
      if (!MEDIA_TYPES.has(segment?.type)) return null
      const meta = mediaRoles.get(segment) || {}
      const isVideo = segment.type === "video" || meta.role === "video"
      if (videoOnly && !isVideo) { parts.push(snapshot(segment)); hasSummary ||= meta.role === "summary"; continue }
      replaced = true
      if (videoOnly && !meta.coverInForward && meta.thumbnail) parts.push(snapshot(meta.thumbnail))
      if (meta.role !== "summary") parts.push(`\n[${isVideo ? "视频" : "媒体"}已省略，请通过原链接查看]\n`)
    }
    if (parts.length) converted.push(parts)
  }
  if (!replaced) return null
  let existing = converted.map(plainText).join("\n")
  const notice = [videoOnly ? "媒体上传失败，已省略视频" : "媒体上传失败，已改为纯文字内容"]
  const seen = new Set()
  for (let current = result; current && !seen.has(current); current = current.repost) {
    seen.add(current)
    for (const value of [!hasSummary && current.title, !hasSummary && current.author?.name && `作者：${current.author.name}`, current.url && `链接: ${current.url}`].filter(Boolean)) {
      if (!existing.includes(value)) { notice.push(value); existing += "\n" + value }
    }
  }
  return [markMediaRole({ type: "text", text: notice.join("\n") }, "fallback-notice"), ...converted]
}

export async function sendForward(e, contents, result) {
  for (const packet of packForwardNodes(contents)) {
    const original = snapshot(packet)
    try { await e.reply(await makeForward(e, snapshot(original))) }
    catch (error) {
      if (!isMediaUploadError(error)) throw error
      const videoFallback = buildMediaFallback(original, result, true)
      if (!videoFallback) {
        const plain = buildMediaFallback(original, result)
        if (!plain) throw error
        for (const fallback of packForwardNodes(plain)) await e.reply(await makeForward(e, fallback))
        continue
      }
      for (const fallback of packForwardNodes(videoFallback)) {
        try { await e.reply(await makeForward(e, snapshot(fallback))) }
        catch (videoError) {
          if (!isMediaUploadError(videoError)) throw videoError
          const plain = buildMediaFallback(fallback, result)
          if (!plain) throw videoError
          for (const textPacket of packForwardNodes(plain)) await e.reply(await makeForward(e, textPacket))
        }
      }
    }
  }
}

export function contentText(item) {
  if (typeof item === "string") return item
  if (item instanceof StickerContent) return item.description || "[表情]"
  if (item instanceof LinkContent) return [item.title, item.description, item.url].filter(Boolean).join("\n")
  if (item instanceof QuoteContent) return [item.title, item.text, item.url].filter(Boolean).join("\n")
  if (item instanceof PollContent) return ["【投票】" + (item.title || "投票"), ...item.options.map(option => `- ${option.text}: ${option.votes} 票 (${item.optionPercentage(option).toFixed(1)}%)`),
    [item.closed ? "已结束" : "进行中", item.multiple && "多选", item.totalVoters != null && `${item.totalVoters} 人参与`].filter(Boolean).join(" · ")].join("\n")
  return ""
}

export async function renderContents(e, result, { summaryNode = null } = {}) {
  // The legacy text-only API already sent its complete body in the summary.
  if (!summaryNode && !result.content.length && !result.allMedia.length && !result.graphics.length && !result.repost) return
  const releases = []
  const nodes = []
  let failedCount = 0, hasForwardVideo = false
  const resolve = async (task, required = true) => {
    const file = await task?.safeGet(error => { if (required && !(error instanceof IgnoreError)) failedCount++ })
    if (file) releases.push(cacheLifecycle.protect(file))
    return file
  }
  try {
    const seenResults = new Set()
    for (let current = result; current && !seenResults.has(current); current = current.repost) {
      if (seenResults.size) nodes.push(">>>>> 原帖 <<<<<")
      seenResults.add(current)
      if (current.title) nodes.push(current.title)
      let buffer = "", prefixPending = true
      const flush = () => {
        if (!buffer) return
        nodes.push((prefixPending && current.author?.name ? `${current.author.name}：` : "") + buffer)
        prefixPending = false; buffer = ""
      }
      const seenMedia = new Set()
      const items = [...current.orderedContent, ...current.allMedia]
      for (const item of items) {
        if (!(item instanceof MediaContent) || item instanceof StickerContent) {
          const text = contentText(item)
          if (item instanceof LinkContent) {
            flush()
            const preview = await resolve(item.preview, false)
            if (preview) nodes.push(await imageSegment(preview))
          }
          if (item instanceof QuoteContent || item instanceof PollContent) {
            flush()
            nodes.push(markMediaRole({ type: "text", text: (prefixPending && current.author?.name ? `${current.author.name}：` : "") + text }, "protected-text"))
            prefixPending = false
            continue
          }
          if (text) buffer += typeof item === "string" || item instanceof StickerContent ? text : (buffer && !buffer.endsWith("\n") ? "\n" : "") + text + "\n"
          continue
        }
        if (item.needSend === false || seenMedia.has(item)) continue
        seenMedia.add(item); flush()
        if (item instanceof LivePhotoContent) {
          const base = await resolve(item.baseImage)
          const live = await resolve(config.parser_live_photo ? item.livePath || item.pathTask : item.pathTask)
          if (!config.parser_live_photo && base) nodes.push(await imageSegment(base))
          if (live) nodes.push(markMediaRole(await videoSegment(live, base), "video"))
          continue
        }
        const file = await resolve(item.pathTask)
        if (!file) continue
        if (item instanceof VideoContent) {
          const gif = await resolve(item.gifPath, false)
          if (gif) { nodes.push(await imageSegment(gif)); continue }
          const cover = await resolve(item.cover, false)
          if (config.parser_video_in_forward || summaryNode) {
            let coverSegment = null
            if (cover) { coverSegment = await imageSegment(cover); nodes.push(coverSegment) }
            const video = config.parser_need_upload_video ? await fileSegment(file) : await videoSegment(file, cover)
            markMediaRole(video, "video")
            if (video && typeof video === "object") mediaRoles.set(video, { role: "video", thumbnail: coverSegment, coverInForward: Boolean(coverSegment) })
            nodes.push(video); hasForwardVideo = true
          } else {
            await sendVideo(e, file, cover)
            if (config.parser_need_upload_video) await sendFile(e, file)
          }
        } else if (item instanceof AudioContent) {
          if (summaryNode) nodes.push(config.parser_need_upload_audio ? await fileSegment(file) : await recordSegment(file))
          else {
            await e.reply(await recordSegment(file))
            if (config.parser_need_upload_audio) await sendFile(e, file)
          }
        } else if (item instanceof ImageContent || item instanceof GraphicContent) {
          const image = await imageSegment(file)
          nodes.push(item.alt ? [image, item.alt] : image)
        }
      }
      flush()
    }
    if (summaryNode) nodes.unshift(summaryNode)
    if (nodes.length) {
      const length = nodes.map(plainText).join("").length
      if (config.parser_need_forward_contents || nodes.length > 4 || hasForwardVideo || summaryNode || length > config.parser_forward_text_threshold) await sendForward(e, nodes, result)
      else await e.reply(nodes.flat())
    }
    if (failedCount) {
      const message = `${failedCount} 项媒体下载失败`
      await e.reply(message)
      throw new DownloadError(message)
    }
  } finally { for (const release of releases) release() }
}
