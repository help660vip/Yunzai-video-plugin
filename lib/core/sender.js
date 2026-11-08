import fs from "node:fs"
import path from "node:path"

import { config } from "./config.js"
import { sendComponent, forwardComponent } from "./components.js"
import { prepareResultMedia } from "./media-preprocess.js"
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

export function fileUploadOptions(timeoutSeconds = config.parser_file_upload_timeout) {
  if (timeoutSeconds === null || timeoutSeconds === undefined) return {}
  const value = Number(timeoutSeconds)
  return Number.isFinite(value) && value > 0 ? { _timeout: value } : {}
}

export async function waitForFileUpload(factory, timeoutSeconds = config.parser_file_upload_timeout) {
  if (typeof factory !== "function") throw new TypeError("文件上传任务必须是函数")
  return factory(fileUploadOptions(timeoutSeconds))
}

async function sendFileInternal(e, filePath, name) {
  if (typeof segmentApi().file === "function" && typeof e?.reply === "function") {
    try {
      const message = await fileSegment(filePath, name)
      await waitForFileUpload(options => e.reply(message, false, options))
      return
    } catch (error) {
      log.warn("[parser] 通用文件消息发送失败，尝试适配器上传接口", error)
    }
  }

  const nativeUploads = [
    e?.group?.sendFile
      ? options => e.group.sendFile(filePath, name, options)
      : null,
    e?.friend?.sendFile
      ? options => e.friend.sendFile(filePath, name, options)
      : null,
    e?.group?.fs?.upload
      ? options => e.group.fs.upload(filePath, "/", name, options)
      : null,
    e?.bot?.uploadGroupFile && e?.group_id
      ? options => e.bot.uploadGroupFile(e.group_id, filePath, name, options)
      : null,
    e?.bot?.uploadPrivateFile && e?.user_id
      ? options => e.bot.uploadPrivateFile(e.user_id, filePath, name, options)
      : null,
  ].filter(Boolean)
  for (const upload of nativeUploads) {
    try {
      await waitForFileUpload(upload)
      return
    } catch {}
  }

  if (typeof e?.bot?.sendApi === "function") {
    try {
      await waitForFileUpload(options =>
        e.bot.sendApi(e.group_id ? "upload_group_file" : "upload_private_file", {
          ...(e.group_id ? { group_id: e.group_id } : { user_id: e.user_id }),
          file: filePath,
          name,
          ...options,
        }),
      )
      return
    } catch {}
  }

  log.warn("[parser] 当前适配器没有文件上传接口，退化为通用文件消息段")
  const message = await fileSegment(filePath, name)
  await waitForFileUpload(options => e.reply(message, false, options))
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

export function stripForwardBoundary(node) {
  const parts = (Array.isArray(node) ? node : [node]).map(snapshot)
  const indexes = parts.map((part, index) =>
    typeof part === "string" || part?.type === "text" ? index : -1).filter(index => index >= 0)
  if (!indexes.length) return Array.isArray(node) ? parts : parts[0]
  const update = (index, leading, trailing) => {
    const part = parts[index]
    let value = plainText(part)
    if (leading) value = value.replace(/^\n+/, "")
    if (trailing) value = value.replace(/\n+$/, "")
    const updated = typeof part === "string"
      ? value
      : { ...part, ...(Object.prototype.hasOwnProperty.call(part, "text") ? { text: value } : { data: { ...(part.data || {}), text: value } }) }
    if (part && typeof part === "object" && updated && typeof updated === "object" && mediaRoles.has(part)) {
      mediaRoles.set(updated, { ...mediaRoles.get(part) })
    }
    parts[index] = updated
  }
  update(indexes[0], true, indexes.length === 1)
  if (indexes.length > 1) update(indexes[indexes.length - 1], false, true)
  const filtered = parts.filter(part => !(typeof part === "string" || part?.type === "text") || plainText(part) !== "")
  return Array.isArray(node) ? filtered : filtered[0]
}

export function packForwardNodes(contents) {
  const softLimit = Math.min(MAX_FORWARD_TEXT_LENGTH, Math.max(1, config.parser_forward_text_threshold || MAX_FORWARD_TEXT_LENGTH))
  const nodes = []
  for (const sourceNode of contents) {
    const node = stripForwardBoundary(sourceNode)
    if (node === undefined || (Array.isArray(node) && node.length === 0)) continue
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

export function containsFileSegment(value, seen = new Set()) {
  if (!value || typeof value !== "object") return false
  if (seen.has(value)) return false
  seen.add(value)
  if (value.type === "file") return true
  if (Array.isArray(value)) return value.some(item => containsFileSegment(item, seen))
  return Object.values(value).some(item => containsFileSegment(item, seen))
}

async function replyForwardPacket(e, packet) {
  const message = await makeForward(e, snapshot(packet))
  if (!containsFileSegment(packet)) return e.reply(message)
  return waitForFileUpload(options => e.reply(message, false, options))
}

export async function sendForward(e, contents, result) {
  for (const packet of packForwardNodes(contents)) {
    const original = snapshot(packet)
    try { await replyForwardPacket(e, original) }
    catch (error) {
      if (!isMediaUploadError(error)) throw error
      const videoFallback = buildMediaFallback(original, result, true)
      if (!videoFallback) {
        const plain = buildMediaFallback(original, result)
        if (!plain) throw error
        for (const fallback of packForwardNodes(plain)) await replyForwardPacket(e, fallback)
        continue
      }
      for (const fallback of packForwardNodes(videoFallback)) {
        try { await replyForwardPacket(e, fallback) }
        catch (videoError) {
          if (!isMediaUploadError(videoError)) throw videoError
          const plain = buildMediaFallback(fallback, result)
          if (!plain) throw videoError
          for (const textPacket of packForwardNodes(plain)) await replyForwardPacket(e, textPacket)
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
    [item.closed ? "已结束" : "进行中", item.multiple && "多选", item.totalVoters != null && `${item.totalVoters} 人参与`, item.totalVotes != null && item.totalVotes !== item.totalVoters && `${item.totalVotes} 票`, item.closeAt && `截止 ${item.closeAt}`].filter(Boolean).join(" · ")].join("\n")
  return ""
}

export async function renderContents(e, result, { summaryNode = null } = {}) {
  prepareResultMedia(result)
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
      if (sendComponent("content") && current.title) nodes.push(current.title)
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
          if (!sendComponent("content")) continue
          const text = contentText(item)
          if (item instanceof LinkContent) {
            flush()
            const preview = await resolve(item.preview, false)
            if (preview) nodes.push(await imageSegment(preview))
          }
          if (item instanceof QuoteContent || item instanceof PollContent) {
            flush()
            if (item instanceof PollContent && item.options.some(option => option.image)) {
              for (const option of item.options) {
                const image = await resolve(option.image, false)
                if (image) nodes.push(await imageSegment(image))
              }
            }
            nodes.push(markMediaRole({ type: "text", text: (prefixPending && current.author?.name ? `${current.author.name}：` : "") + text }, "protected-text"))
            prefixPending = false
            continue
          }
          if (text) buffer += typeof item === "string" || item instanceof StickerContent ? text : (buffer && !buffer.endsWith("\n") ? "\n" : "") + text + "\n"
          continue
        }
        if (item.needSend === false || seenMedia.has(item)) continue
        if (item instanceof VideoContent && !sendComponent("video")) {
          if (sendComponent("cover") && !item.cover?.requiresMedia) {
            const cover = await resolve(item.cover, false)
            if (cover) { flush(); nodes.push(await imageSegment(cover)) }
          }
          continue
        }
        if (item instanceof AudioContent && !sendComponent("audio")) continue
        if (!(item instanceof AudioContent || item instanceof VideoContent) && !sendComponent("content")) continue
        seenMedia.add(item); flush()
        if (item instanceof LivePhotoContent) {
          const base = await resolve(item.baseImage)
          const live = await item.getPath(config.parser_live_photo ? item.livePath || item.pathTask : item.pathTask).catch(error => {
            if (!(error instanceof IgnoreError)) failedCount++
            return null
          })
          if (live) releases.push(cacheLifecycle.protect(live))
          if (!config.parser_live_photo && base) nodes.push(await imageSegment(base))
          if (live) nodes.push(markMediaRole(await videoSegment(live, base), "video"))
          continue
        }
        const file = await item.getPath().catch(error => {
          if (!(error instanceof IgnoreError)) failedCount++
          return null
        })
        if (file) releases.push(cacheLifecycle.protect(file))
        if (!file) continue
        if (item instanceof VideoContent) {
          const gif = await resolve(item.gifPath, false)
          if (gif) { nodes.push(await imageSegment(gif)); continue }
          const cover = sendComponent("cover") ? await resolve(item.cover, false) : null
          if (forwardComponent("video") || summaryNode) {
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
          if (summaryNode || forwardComponent("audio")) nodes.push(config.parser_need_upload_audio ? await fileSegment(file) : await recordSegment(file))
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
      if (forwardComponent("content") || forwardComponent("cover") || forwardComponent("audio") || nodes.length > 4 || hasForwardVideo || summaryNode || length > config.parser_forward_text_threshold) await sendForward(e, nodes, result)
      else await e.reply(nodes.flat())
    }
    if (failedCount) {
      const message = `${failedCount} 项媒体下载失败`
      await e.reply(message)
      throw new DownloadError(message)
    }
  } finally { for (const release of releases) release() }
}
