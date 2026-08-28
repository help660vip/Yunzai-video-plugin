import path from "node:path"
import fs from "node:fs"

import { cacheLifecycle, temporaryCachePath } from "./cache-lifecycle.js"
import { runProcess, safeUnlink } from "./utils.js"

const transformJobs = new Map()

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

async function cachedTransform(inputPaths, outputPath, execute, removeInputs = []) {
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
        await Promise.all(removeInputs.map(item => safeUnlink(item)))
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

  async probe(mediaPath) {
    const result = await runProcess("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration:stream=codec_type,duration,avg_frame_rate,r_frame_rate",
      "-of",
      "json",
      mediaPath,
    ])
    return JSON.parse(result.stdout)
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
