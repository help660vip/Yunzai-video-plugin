import { config, normalizePlatformName } from "./config.js"
import { ffmpeg, normalizeMediaRanges } from "./ffmpeg.js"
import { IgnoreError, TipError } from "./errors.js"
import { log } from "./logger.js"


export function mediaSpeedup(platform, authorId, rules = config.parser_media_speedup_rules || []) {
  if (authorId === null || authorId === undefined || authorId === "") return 1
  let ratio = 1
  for (const raw of rules) {
    const [name, id, speed] = String(raw).split(":").map(part => part.trim())
    const candidate = Number(speed)
    if (normalizePlatformName(name) === normalizePlatformName(platform) && id === String(authorId) && Number.isFinite(candidate) && candidate > 0) ratio = candidate
  }
  return ratio
}

// This step only plans processing. It is safe to call before rendering and never starts a download.
export function prepareResultMedia(result, seen = new Set(), inheritedSpeed = null) {
  if (!result || seen.has(result)) return result
  seen.add(result)
  const speed = inheritedSpeed ?? mediaSpeedup(result.platform?.name || result.platform, result.author?.id)
  for (const media of result.allMedia || []) {
    if ((media.mediaKind === "audio" || media.mediaKind === "video") && media.needSend !== false) media.speedup = speed
  }
  if (result.repost) prepareResultMedia(result.repost, seen, speed)
  return result
}

export async function preprocessMedia(media, { sourcePath } = {}) {
  if (!sourcePath || !["audio", "video"].includes(media.mediaKind)) return sourcePath
  const ratio = Number(media.speedup) || 1
  const cutRanges = normalizeMediaRanges(media.cutRanges || [], media.duration)
  const muteRanges = normalizeMediaRanges(media.muteRanges || [], media.duration)
  if (cutRanges.length === 1 && cutRanges[0][0] === 0 && cutRanges[0][1] === Number(media.duration)) {
    throw new TipError("空降区间覆盖整条视频，没有可发送的内容")
  }
  if (ratio === 1 && !cutRanges.length && !muteRanges.length) return sourcePath
  try {
    return media.mediaKind === "audio"
      ? await ffmpeg.changeAudioSpeed(sourcePath, ratio)
      : await ffmpeg.editVideo(sourcePath, { speedRatio: ratio, cutRanges, muteRanges })
  } catch (error) {
    // Size limits must never be bypassed by falling back to the source.
    if (error instanceof IgnoreError || error?.code === "MEDIA_SIZE_LIMIT") throw error
    log.warn("[parser] 媒体预处理失败，使用原始文件")
    media.speedup = 1
    media.cutRanges = []
    media.muteRanges = []
    return sourcePath
  }
}
