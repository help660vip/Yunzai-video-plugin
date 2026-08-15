import path from "node:path"
import fs from "node:fs"

import { runProcess, safeUnlink } from "./utils.js"

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
    await this.run([
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
      outputPath,
    ])
    await Promise.all([safeUnlink(videoPath), safeUnlink(audioPath)])
    return outputPath
  },

  async mergeAVH264(videoPath, audioPath, outputPath) {
    await this.run([
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
      outputPath,
    ])
    await Promise.all([safeUnlink(videoPath), safeUnlink(audioPath)])
    return outputPath
  },

  async encodeH264(videoPath) {
    const parsed = path.parse(videoPath)
    const outputPath = path.join(parsed.dir, `${parsed.name}_h264${parsed.ext}`)
    if (fs.existsSync(outputPath)) return outputPath
    await this.run([
      "-y",
      "-i",
      videoPath,
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "23",
      outputPath,
    ])
    await safeUnlink(videoPath)
    return outputPath
  },

  async firstFrame(videoPath) {
    const outputPath = path.join(path.dirname(videoPath), `${path.parse(videoPath).name}.jpg`)
    if (fs.existsSync(outputPath)) return outputPath
    await this.run([
      "-y",
      "-i",
      videoPath,
      "-ss",
      "00:00:01",
      "-vframes",
      "1",
      outputPath,
    ])
    return outputPath
  },

  async toGif(videoPath) {
    const outputPath = path.join(path.dirname(videoPath), `${path.parse(videoPath).name}.gif`)
    if (fs.existsSync(outputPath)) return outputPath
    await this.run(["-y", "-i", videoPath, "-c:v", "gif", outputPath])
    return outputPath
  },

  async remuxMp4(inputPath, outputPath) {
    if (fs.existsSync(outputPath)) return outputPath
    await this.run([
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
      outputPath,
    ])
    return outputPath
  },

  async toMp3(inputPath) {
    if (path.extname(inputPath).toLowerCase() === ".mp3") return inputPath
    const outputPath = path.join(path.dirname(inputPath), path.parse(inputPath).name + ".mp3")
    if (fs.existsSync(outputPath)) return outputPath
    await this.run(["-y", "-i", inputPath, "-vn", "-acodec", "libmp3lame", outputPath])
    return outputPath
  },

  async mergeLivePhoto(imagePath, videoPath, bgmPath, outputPath, loop = 1) {
    if (fs.existsSync(outputPath)) return outputPath
    const repeats = Math.max(0, Math.floor(Number(loop) || 1) - 1)
    const args = [
      "-y",
      "-stream_loop",
      String(repeats),
      "-i",
      videoPath,
      "-loop",
      "1",
      "-t",
      "2.5",
      "-i",
      imagePath,
    ]
    if (bgmPath) args.push("-stream_loop", "-1", "-i", bgmPath)
    args.push(
      "-filter_complex",
      "[1:v][0:v]scale2ref=iw:ih[still][video];[video][still]concat=n=2:v=1:a=0,format=yuv420p[outv]",
      "-map",
      "[outv]",
    )
    if (bgmPath) args.push("-map", "2:a:0", "-shortest", "-c:a", "aac", "-b:a", "192k")
    else args.push("-map", "0:a?", "-c:a", "aac")
    args.push(
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-movflags",
      "+faststart",
      outputPath,
    )
    await this.run(args)
    return outputPath
  },
}
