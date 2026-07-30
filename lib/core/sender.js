import fs from "node:fs"
import path from "node:path"

import { config } from "./config.js"
import { DownloadError, IgnoreError } from "./errors.js"
import { ImageContent, VideoContent, AudioContent } from "./model.js"
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
  const stat = await fs.promises.stat(filePath)
  if (stat.size > 100 * 1024 * 1024) {
    await sendFile(e, filePath)
    return
  }
  await e.reply(await videoSegment(filePath, thumbnail))
}

function botNickname(e) {
  return e?.bot?.nickname || e?.bot?.name || e?.nickname || "nonebot-plugin-parser"
}

export async function makeForward(e, contents) {
  const userId = String(e?.self_id || e?.bot?.uin || e?.bot?.self_id || 10000)
  const nodes = contents.map(content => ({
    user_id: userId,
    nickname: botNickname(e),
    message: content,
  }))
  const maker = e?.group?.makeForwardMsg || e?.friend?.makeForwardMsg || e?.bot?.makeForwardMsg
  if (typeof maker === "function") {
    try {
      return await maker.call(e.group || e.friend || e.bot, nodes)
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

export async function renderContents(e, result) {
  let failedCount = 0
  const mergeable = []
  const contents = [...result.contents, ...(result.repost?.contents || [])]
  for (const content of contents) {
    const mediaPath = await content.pathTask.safeGet(error => {
      if (!(error instanceof IgnoreError)) failedCount += 1
    })
    if (!mediaPath) continue
    if (content instanceof VideoContent) {
      const gifPath = content.gifPath ? await content.gifPath.safeGet() : null
      if (gifPath) {
        mergeable.push(await imageSegment(gifPath))
      } else {
        const thumbnail = content.cover ? await content.cover.safeGet() : null
        await sendVideo(e, mediaPath, thumbnail)
      }
    } else if (content instanceof AudioContent) {
      await e.reply(await recordSegment(mediaPath))
    } else if (content instanceof ImageContent) {
      mergeable.push(await imageSegment(mediaPath))
    }
  }

  for (const graphic of [...result.graphics, ...(result.repost?.graphics || [])]) {
    if (typeof graphic === "string") {
      mergeable.push(graphic)
      continue
    }
    const graphicPath = await graphic.pathTask.safeGet(error => {
      if (!(error instanceof IgnoreError)) failedCount += 1
    })
    if (!graphicPath) continue
    const image = await imageSegment(graphicPath)
    mergeable.push(graphic.alt ? [image, graphic.alt] : image)
  }

  if (mergeable.length) {
    if (config.parser_need_forward_contents || mergeable.length > 4) {
      await e.reply(await makeForward(e, mergeable))
    } else {
      await e.reply(mergeable)
    }
  }
  if (failedCount > 0) {
    const message = `${failedCount} 项媒体下载失败`
    await e.reply(message)
    throw new DownloadError(message)
  }
}
