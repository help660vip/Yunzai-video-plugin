import path from "node:path"
import fs from "node:fs"
import crypto from "node:crypto"

import { cacheLifecycle, temporaryCachePath } from "./cache-lifecycle.js"
import { config } from "./config.js"
import { cacheDir } from "./paths.js"
import { IgnoreError } from "./errors.js"
import { runProcess, safeUnlink } from "./utils.js"

const transformJobs = new Map()
let activeTranscodes = 0
const transcodeQueue = []

function drainTranscodes() {
  const limit = Math.max(1, Math.floor(Number(config.parser_media_transcode_concurrency) || 1))
  while (activeTranscodes < limit && transcodeQueue.length) {
    activeTranscodes += 1
    transcodeQueue.shift()()
  }
}

export async function withTranscodeLimit(execute) {
  await new Promise(resolve => { transcodeQueue.push(resolve); drainTranscodes() })
  try { return await execute() }
  finally { activeTranscodes -= 1; drainTranscodes() }
}

export function normalizeMediaRanges(ranges, duration) {
  const maximum = Number(duration)
  if (!Number.isFinite(maximum) || maximum <= 0) return []
  const values = []
  for (const pair of ranges || []) {
    if (!Array.isArray(pair) || typeof pair[0] !== "number" || typeof pair[1] !== "number") continue
    const [start, rawEnd] = pair
    const end = Math.min(rawEnd, maximum)
    if (Number.isFinite(start) && Number.isFinite(rawEnd) && start >= 0 && end > start) values.push([start, end])
  }
  const output = []
  for (const [start, end] of values.sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
    const previous = output[output.length - 1]
    if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end)
    else output.push([start, end])
  }
  return output
}

function keepPieces(ranges, duration) {
  const result = []
  let cursor = 0
  for (const [start, end] of ranges) {
    if (start > cursor) result.push([cursor, start])
    cursor = Math.max(cursor, end)
  }
  if (cursor < duration) result.push([cursor, duration])
  return result
}

function atempo(ratio) {
  const values = []
  while (ratio > 2) { values.push("atempo=2"); ratio /= 2 }
  while (ratio < 0.5) { values.push("atempo=0.5"); ratio /= 0.5 }
  values.push(`atempo=${filterNumber(ratio)}`)
  return values.join(",")
}

function streamBitrate(probe, kind) {
  const stream = probe.streams?.find(item => item.codec_type === kind)
  const rate = Number(stream?.bit_rate || 0)
  if (rate > 0) return Math.round(rate)
  const total = Number(probe.format?.bit_rate || 0)
  const other = (probe.streams || []).filter(item => item !== stream).map(item => Number(item.bit_rate || 0))
  return stream && total > 0 && other.every(item => item > 0) ? Math.max(0, Math.round(total - other.reduce((a, b) => a + b, 0))) : null
}

async function editOutputPath(inputPath, suffix, parameters) {
  const stat = await fs.promises.stat(inputPath)
  // Cache retention updates mtime, so it must not invalidate an otherwise stable edit key.
  const key = JSON.stringify(["source-bitrate-v1", path.resolve(inputPath), stat.size, parameters])
  return path.join(cacheDir, "media", crypto.createHash("sha256").update(key).digest("hex") + suffix)
}

async function verifyEditedSize(filePath, maxBytes) {
  const size = (await fs.promises.stat(filePath)).size
  if (size <= 0) throw new Error("媒体预处理产生了空文件")
  if (size > maxBytes) throw new IgnoreError("媒体文件过大")
}

async function publishTemporary(temporary, outputPath) {
  try {
    await fs.promises.rename(temporary, outputPath)
  } catch (error) {
    if (!fs.existsSync(outputPath)) throw error
    await safeUnlink(temporary)
  }
  await cacheLifecycle.touch(outputPath)
  return outputPath
}

async function cachedTransform(inputPaths, outputPath, execute) {
  if (fs.existsSync(outputPath)) {
    await cacheLifecycle.touch(outputPath)
    return outputPath
  }
  const existing = transformJobs.get(outputPath)
  if (existing) return existing
  const temporary = temporaryCachePath(outputPath)
  const pending = cacheLifecycle.withActive(
    [...inputPaths, outputPath, temporary],
    async () => {
      await fs.promises.mkdir(path.dirname(outputPath), { recursive: true })
      try {
        await execute(temporary)
        await publishTemporary(temporary, outputPath)
        // Other transformations or pending PathTasks may still reference the source.
        // Cache retention reclaims source files only after their active locks are released.
        return outputPath
      } catch (error) {
        await safeUnlink(temporary)
        throw error
      }
    },
  ).finally(() => transformJobs.delete(outputPath))
  transformJobs.set(outputPath, pending)
  return pending
}

function filterNumber(value) {
  return Number(value).toFixed(9).replace(/0+$/, "").replace(/\.$/, "")
}

function mediaDuration(probe, mediaPath) {
  const duration = Number(probe?.format?.duration)
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`无法获取有效的媒体时长: ${mediaPath}`)
  }
  return duration
}

function videoFrameRate(probe, videoPath) {
  const stream = probe?.streams?.find(item => item.codec_type === "video")
  for (const value of [stream?.avg_frame_rate, stream?.r_frame_rate]) {
    const match = /^(\d+)(?:\/(\d+))?$/.exec(String(value || ""))
    if (match && Number(match[1]) > 0 && Number(match[2] || 1) > 0) return value
  }
  throw new Error(`无法获取有效的视频帧率: ${videoPath}`)
}

function liveVideoFilter(duration, frameRate, loop) {
  const fade = Math.min(0.5, Math.max(0.12, duration * 0.18))
  const stillDuration = 2.5
  const filters = [
    `[0:v]setpts=PTS-STARTPTS,settb=1/1000,format=yuv420p,setsar=1,fps=${frameRate}[vbase]`,
    `[1:v]setpts=PTS-STARTPTS,settb=1/1000,format=yuv420p,setsar=1,fps=${frameRate}[still_base]`,
  ]
  if (loop === 1) {
    filters.push("[vbase]null[vsplit0]", "[still_base]null[still0]")
  } else {
    filters.push(
      `[vbase]split=${loop}${Array.from({ length: loop }, (_, i) => `[vsplit${i}]`).join("")}`,
      `[still_base]split=${loop}${Array.from({ length: loop }, (_, i) => `[still${i}]`).join("")}`,
    )
  }
  for (let index = 0; index < loop; index += 1) {
    filters.push(
      `[vsplit${index}]trim=start=${filterNumber(duration * index)}:duration=${filterNumber(duration)},setpts=PTS-STARTPTS,settb=1/1000[v${index}]`,
      `[still${index}][v${index}]scale2ref=iw:ih:flags=lanczos[s${index}raw][v${index}r]`,
      `[s${index}raw]trim=duration=${stillDuration},setpts=PTS-STARTPTS,settb=1/1000[s${index}]`,
    )
  }
  let composed = duration + stillDuration - fade
  let last = "x_s0"
  filters.push(
    `[v0r][s0]xfade=transition=fade:duration=${filterNumber(fade)}:offset=${filterNumber(Math.max(0, duration - fade))}[${last}]`,
  )
  for (let index = 1; index < loop; index += 1) {
    const toVideo = `x_v${index}`
    const toStill = `x_s${index}`
    filters.push(
      `[${last}][v${index}r]xfade=transition=fade:duration=${filterNumber(fade)}:offset=${filterNumber(Math.max(0, composed - fade))}[${toVideo}]`,
    )
    composed += duration - fade
    filters.push(
      `[${toVideo}][s${index}]xfade=transition=fade:duration=${filterNumber(fade)}:offset=${filterNumber(Math.max(0, composed - fade))}[${toStill}]`,
    )
    composed += stillDuration - fade
    last = toStill
  }
  filters.push(`[${last}]null[outv]`)
  return { filters, composed }
}

export const ffmpeg = {
  async run(args, options = {}) {
    try {
      return await runProcess("ffmpeg", args, options)
    } catch (error) {
      if (error?.code === "ENOENT") throw new Error("ffmpeg 未安装或无法找到可执行文件")
      throw error
    }
  },

  async pngToJpeg(pngData, quality = 85) {
    const result = await this.run(
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        "pipe:0",
        "-frames:v",
        "1",
        "-f",
        "image2",
        "-c:v",
        "mjpeg",
        "-q:v",
        String(Math.round(((100 - quality) * 31) / 100)),
        "pipe:1",
      ],
      { input: pngData, encoding: null },
    )
    return result.stdout
  },

  async pngToWebp(pngData, quality = 88) {
    const result = await this.run([
      "-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-frames:v", "1",
      "-f", "webp", "-c:v", "libwebp", "-lossless", "0", "-quality",
      String(Math.max(1, Math.min(100, Number(quality) || 88))), "pipe:1",
    ], { input: pngData, encoding: null })
    return result.stdout
  },

  async downloadHlsToMp4(url, outputPath, { headers = {}, maxSizeMb = 90, onProgress = null } = {}) {
    const parsed = new URL(url)
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("HLS 仅支持 HTTP(S)")
    const headerLines = Object.entries(headers).map(([key, value]) => {
      if (!/^[A-Za-z0-9-]+$/.test(key) || /[\r\n\0]/.test(String(value))) {
        throw new Error("无效的媒体请求头")
      }
      return key + ": " + value
    })
    return cachedTransform([], outputPath, async temporary => {
      const args = ["-y", "-hide_banner", "-loglevel", "error", "-nostdin",
        "-protocol_whitelist", "http,https,tcp,tls,crypto",
        "-rw_timeout", "30000000"]
      if (headerLines.length) args.push("-headers", headerLines.join("\r\n") + "\r\n")
      args.push("-i", url, "-c", "copy", "-bsf:a", "aac_adtstoasc", "-movflags", "+faststart", temporary)
      try {
        await this.run(args, { monitorPath: temporary, maxBytes: maxSizeMb * 1024 * 1024,
          onProgress, timeout: 240000 })
      } catch (error) {
        if (error.code === "MEDIA_SIZE_LIMIT") throw new IgnoreError("媒体文件过大")
        throw error
      }
      const size = (await fs.promises.stat(temporary)).size
      if (size <= 0) throw new IgnoreError("媒体文件为空")
      if (size > maxSizeMb * 1024 * 1024) throw new IgnoreError("媒体文件过大")
    })
  },

  async probe(mediaPath) {
    const result = await runProcess("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration,bit_rate:stream=codec_type,duration,avg_frame_rate,r_frame_rate,bit_rate",
      "-of",
      "json",
      mediaPath,
    ])
    return JSON.parse(result.stdout)
  },

  async editVideo(inputPath, { speedRatio = 1, cutRanges = [], muteRanges = [], maxSizeMb = config.parser_max_size } = {}) {
    if (!Number.isFinite(speedRatio) || speedRatio <= 0) throw new RangeError("无效的播放倍速")
    const maxBytes = maxSizeMb * 1024 * 1024
    await verifyEditedSize(inputPath, maxBytes)
    const probe = await this.probe(inputPath)
    const duration = mediaDuration(probe, inputPath)
    const cuts = normalizeMediaRanges(cutRanges, duration)
    const mutes = normalizeMediaRanges(muteRanges, duration)
    if (speedRatio === 1 && !cuts.length && !mutes.length) return inputPath
    const pieces = keepPieces(cuts, duration)
    if (!pieces.length) throw new Error("裁切后没有剩余片段")
    const outputPath = await editOutputPath(inputPath, ".mp4", [speedRatio, cuts, mutes])
    const result = await cachedTransform([inputPath], outputPath, temporary => withTranscodeLimit(async () => {
      const hasAudio = probe.streams?.some(item => item.codec_type === "audio")
      const filters = []
      let video = "0:v:0", audio = hasAudio ? "0:a:0" : null
      if (hasAudio && mutes.length) {
        const enable = mutes.map(([start, end]) => `gte(t,${filterNumber(start)})*lt(t,${filterNumber(end)})`).join("+")
        filters.push(`[0:a:0]volume=enable='${enable}':volume=0[am]`)
        audio = "[am]"
      }
      if (cuts.length) {
        const count = pieces.length
        filters.push(count > 1 ? `[0:v:0]split=${count}${pieces.map((_, i) => `[vc${i}]`).join("")}` : "[0:v:0]null[vc0]")
        if (hasAudio) filters.push(count > 1 ? `${audio.startsWith("[") ? audio : `[${audio}]`}asplit=${count}${pieces.map((_, i) => `[ac${i}]`).join("")}` : `${audio.startsWith("[") ? audio : `[${audio}]`}anull[ac0]`)
        pieces.forEach(([start, end], index) => {
          filters.push(`[vc${index}]trim=start=${filterNumber(start)}:end=${filterNumber(end)},setpts=PTS-STARTPTS[v${index}]`)
          if (hasAudio) filters.push(`[ac${index}]atrim=start=${filterNumber(start)}:end=${filterNumber(end)},asetpts=PTS-STARTPTS[a${index}]`)
        })
        filters.push(pieces.map((_, i) => `[v${i}]` + (hasAudio ? `[a${i}]` : "")).join("") + `concat=n=${count}:v=1:a=${hasAudio ? 1 : 0}[vt]${hasAudio ? "[at]" : ""}`)
        video = "[vt]"
        audio = hasAudio ? "[at]" : null
      }
      if (speedRatio !== 1) {
        filters.push(`${video.startsWith("[") ? video : `[${video}]`}setpts=PTS/${filterNumber(speedRatio)}[vf]`)
        video = "[vf]"
        if (hasAudio) {
          filters.push(`${audio.startsWith("[") ? audio : `[${audio}]`}${atempo(speedRatio)}[af]`)
          audio = "[af]"
        }
      }
      const args = ["-y", "-hide_banner", "-loglevel", "error", "-nostdin", "-i", inputPath]
      if (filters.length) args.push("-filter_complex", filters.join(";"))
      args.push("-map", video)
      if (cuts.length || speedRatio !== 1) {
        args.push("-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p")
        const bitrate = streamBitrate(probe, "video")
        if (bitrate) args.push("-b:v", String(bitrate), "-maxrate", String(bitrate), "-bufsize", String(bitrate * 2))
      } else args.push("-c:v", "copy")
      if (audio) {
        args.push("-map", audio, "-c:a", audio === "0:a:0" ? "copy" : "aac")
        const bitrate = streamBitrate(probe, "audio")
        if (audio !== "0:a:0" && bitrate) args.push("-b:a", String(bitrate))
      } else args.push("-an")
      args.push("-movflags", "+faststart", temporary)
      try { await this.run(args, { monitorPath: temporary, maxBytes }); await verifyEditedSize(temporary, maxBytes) }
      catch (error) { if (error?.code === "MEDIA_SIZE_LIMIT") throw new IgnoreError("媒体文件过大"); throw error }
    }))
    await verifyEditedSize(result, maxBytes)
    return result
  },

  async changeAudioSpeed(inputPath, speedRatio, { maxSizeMb = config.parser_max_size } = {}) {
    if (!Number.isFinite(speedRatio) || speedRatio <= 0) throw new RangeError("无效的播放倍速")
    if (speedRatio === 1) return inputPath
    const maxBytes = maxSizeMb * 1024 * 1024
    await verifyEditedSize(inputPath, maxBytes)
    const suffix = [".mp3", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".wav"].includes(path.extname(inputPath).toLowerCase()) ? path.extname(inputPath).toLowerCase() : ".m4a"
    const outputPath = await editOutputPath(inputPath, suffix, [speedRatio])
    const result = await cachedTransform([inputPath], outputPath, temporary => withTranscodeLimit(async () => {
      const probe = await this.probe(inputPath)
      const args = ["-y", "-hide_banner", "-loglevel", "error", "-nostdin", "-i", inputPath, "-vn", "-af", atempo(speedRatio)]
      const bitrate = streamBitrate(probe, "audio")
      if (bitrate) args.push("-b:a", String(bitrate))
      args.push(temporary)
      try { await this.run(args, { monitorPath: temporary, maxBytes }); await verifyEditedSize(temporary, maxBytes) }
      catch (error) { if (error?.code === "MEDIA_SIZE_LIMIT") throw new IgnoreError("媒体文件过大"); throw error }
    }))
    await verifyEditedSize(result, maxBytes)
    return result
  },

  async mergeAV(videoPath, audioPath, outputPath) {
    return cachedTransform([videoPath, audioPath], outputPath, temporary => this.run([
      "-y",
      "-i",
      videoPath,
      "-i",
      audioPath,
      "-c",
      "copy",
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      temporary,
    ]), [videoPath, audioPath])
  },

  async mergeAVH264(videoPath, audioPath, outputPath) {
    return cachedTransform([videoPath, audioPath], outputPath, temporary => this.run([
      "-y",
      "-i",
      videoPath,
      "-i",
      audioPath,
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "23",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      temporary,
    ]), [videoPath, audioPath])
  },

  async encodeH264(videoPath) {
    const parsed = path.parse(videoPath)
    const outputPath = path.join(parsed.dir, `${parsed.name}_h264${parsed.ext}`)
    return cachedTransform([videoPath], outputPath, temporary => this.run([
      "-y",
      "-i",
      videoPath,
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "23",
      temporary,
    ]), [videoPath])
  },

  async firstFrame(videoPath) {
    const outputPath = path.join(path.dirname(videoPath), `${path.parse(videoPath).name}.jpg`)
    return cachedTransform([videoPath], outputPath, temporary => this.run([
      "-y",
      "-i",
      videoPath,
      "-ss",
      "00:00:01",
      "-vframes",
      "1",
      temporary,
    ]))
  },

  async toGif(videoPath) {
    const outputPath = path.join(path.dirname(videoPath), `${path.parse(videoPath).name}.gif`)
    return cachedTransform([videoPath], outputPath, temporary =>
      this.run(["-y", "-i", videoPath, "-c:v", "gif", temporary]),
    )
  },

  async remuxMp4(inputPath, outputPath) {
    return cachedTransform([inputPath], outputPath, temporary => this.run([
      "-y",
      "-probesize",
      "50M",
      "-analyzeduration",
      "100M",
      "-i",
      inputPath,
      "-c",
      "copy",
      "-bsf:a",
      "aac_adtstoasc",
      "-movflags",
      "+faststart",
      temporary,
    ]))
  },

  async toMp3(inputPath) {
    if (path.extname(inputPath).toLowerCase() === ".mp3") {
      try {
        const result = await runProcess("ffprobe", [
          "-v",
          "error",
          "-select_streams",
          "a:0",
          "-show_entries",
          "stream=codec_name",
          "-of",
          "default=noprint_wrappers=1:nokey=1",
          inputPath,
        ])
        if (result.stdout.trim().toLowerCase() === "mp3") {
          await cacheLifecycle.touch(inputPath)
          return inputPath
        }
      } catch {}
    }
    const parsed = path.parse(inputPath)
    const outputPath = path.join(
      parsed.dir,
      parsed.ext.toLowerCase() === ".mp3" ? parsed.name + "_converted.mp3" : parsed.name + ".mp3",
    )
    return cachedTransform([inputPath], outputPath, temporary =>
      this.run(["-y", "-i", inputPath, "-vn", "-acodec", "libmp3lame", temporary]),
    )
  },

  async mergeLivePhoto(imagePath, videoPath, bgmPath, outputPath, loop = 1) {
    if (!Number.isInteger(loop) || loop < 1) {
      throw new RangeError("Live Photo loop 必须是大于等于 1 的整数")
    }
    const inputs = [imagePath, videoPath, bgmPath].filter(Boolean)
    return cachedTransform(inputs, outputPath, async temporary => {
      const videoProbe = await this.probe(videoPath)
      const duration = mediaDuration(videoProbe, videoPath)
      const frameRate = videoFrameRate(videoProbe, videoPath)
      const { filters, composed } = liveVideoFilter(duration, frameRate, loop)
      const args = [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-stream_loop",
        String(loop),
        "-i",
        videoPath,
        "-loop",
        "1",
        "-i",
        imagePath,
      ]
      if (bgmPath) {
        const bgmDuration = mediaDuration(await this.probe(bgmPath), bgmPath)
        const bgmLoop = Math.max(0, Math.ceil(composed / bgmDuration) - 1)
        if (bgmLoop) args.push("-stream_loop", String(bgmLoop))
        args.push("-i", bgmPath)
      }
      args.push(
        "-filter_complex",
        filters.join(";"),
        "-map",
        "[outv]",
      )
      if (bgmPath) args.push("-map", "2:a:0", "-c:a", "aac", "-b:a", "192k")
      else args.push("-map", "0:a?", "-c:a", "aac")
      args.push(
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-pix_fmt",
        "yuv420p",
        "-t",
        filterNumber(composed),
        "-movflags",
        "+faststart",
        temporary,
      )
      return this.run(args)
    })
  },
}
