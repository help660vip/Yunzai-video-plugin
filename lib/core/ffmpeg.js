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

export const ffmpeg = {
  async run(args) {
    try {
      return await runProcess("ffmpeg", args)
    } catch (error) {
      if (error?.code === "ENOENT") throw new Error("ffmpeg 未安装或无法找到可执行文件")
      throw error
    }
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
      await cacheLifecycle.touch(inputPath)
      return inputPath
    }
    const outputPath = path.join(path.dirname(inputPath), path.parse(inputPath).name + ".mp3")
    return cachedTransform([inputPath], outputPath, temporary =>
      this.run(["-y", "-i", inputPath, "-vn", "-acodec", "libmp3lame", temporary]),
    )
  },

  async mergeLivePhoto(imagePath, videoPath, bgmPath, outputPath, loop = 1) {
    const repeats = Math.max(0, Math.floor(Number(loop) || 1) - 1)
    const inputs = [imagePath, videoPath, bgmPath].filter(Boolean)
    return cachedTransform(inputs, outputPath, temporary => {
      const args = [
        "-y", "-stream_loop", String(repeats), "-i", videoPath,
        "-loop", "1", "-t", "2.5", "-i", imagePath,
      ]
      if (bgmPath) args.push("-stream_loop", "-1", "-i", bgmPath)
      args.push(
        "-filter_complex",
        "[1:v][0:v]scale2ref=iw:ih[still][video];[video][still]concat=n=2:v=1:a=0,format=yuv420p[outv]",
        "-map", "[outv]",
      )
      if (bgmPath) args.push("-map", "2:a:0", "-shortest", "-c:a", "aac", "-b:a", "192k")
      else args.push("-map", "0:a?", "-c:a", "aac")
      args.push(
        "-c:v", "libx264", "-preset", "veryfast",
        "-movflags", "+faststart", temporary,
      )
      return this.run(args)
    })
  },
}
