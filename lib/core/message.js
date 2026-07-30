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
