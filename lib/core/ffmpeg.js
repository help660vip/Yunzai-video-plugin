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
}
