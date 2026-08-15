import { log } from "./logger.js"

function rawJson(segment) {
  const data = segment?.data
  if (typeof data === "string") return data
  if (data && typeof data.raw === "string") return data.raw
  if (typeof segment?.raw === "string") return segment.raw
  if (data && typeof data === "object") return data
  return null
}

function cardUrl(segment) {
  const raw = rawJson(segment)
  if (!raw) return null
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw
    const meta = parsed?.meta
    return (
      meta?.detail_1?.qqdocurl ||
      meta?.news?.jumpUrl ||
      meta?.music?.jumpUrl ||
      null
    )
  } catch (error) {
    log.warn("[parser] JSON 卡片解析失败", error)
    return null
  }
}

export function extractMessageText(e) {
  const message = Array.isArray(e?.message) ? e.message : []
  const hyper = message.find(item => item?.type === "json")
  if (hyper) return cardUrl(hyper)
  const text = message
    .filter(item => item?.type === "text")
    .map(item => item.text || item.data?.text || "")
    .join("")
    .trim()
  return text || String(e?.msg || "").trim() || null
}

function replyId(e) {
  return (
    e?.reply_id ||
    e?.source?.message_id ||
    e?.source?.seq ||
    e?.message?.find?.(item => item?.type === "reply")?.data?.id ||
    null
  )
}

async function fetchReply(e) {
  if (e?.source?.message || e?.source?.raw_message) return e.source
  if (typeof e?.getReply === "function") {
    try {
      const value = await e.getReply()
      if (value) return value
    } catch {}
  }
  const id = replyId(e)
  if (!id) return null
  const readers = [
    e?.bot?.getMsg ? () => e.bot.getMsg(id) : null,
    e?.bot?.getMessage ? () => e.bot.getMessage(id) : null,
    e?.friend?.getMsg ? () => e.friend.getMsg(id) : null,
    e?.group?.getMsg ? () => e.group.getMsg(id) : null,
  ].filter(Boolean)
  for (const read of readers) {
    try {
      const value = await read()
      if (value) return value.data || value
    } catch {}
  }
  return null
}

export async function extractMessageTexts(e) {
  const output = []
  const current = extractMessageText(e)
  if (current) output.push(current)
  const reply = await fetchReply(e)
  if (reply) {
    const quoted = extractMessageText({
      message: reply.message || reply.content,
      msg: reply.raw_message || reply.msg || reply.message,
    })
    if (quoted && !output.includes(quoted)) output.push(quoted)
  }
  return output
}
