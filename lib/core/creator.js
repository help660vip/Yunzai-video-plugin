import crypto from "node:crypto"
import path from "node:path"

import { config } from "./config.js"
import { downloader } from "./downloader.js"
import { ffmpeg } from "./ffmpeg.js"
import { cacheDir } from "./paths.js"
import {
  AudioContent,
  Author,
  Comment,
  GraphicContent,
  ImageContent,
  LinkContent,
  LivePhotoContent,
  PathTask,
  PollContent,
  PollOption,
  QuoteContent,
  Stats,
  StickerContent,
  VideoContent,
} from "./model.js"

const STICKER_CDN = "https://sticker.sokoko.org/assets/"

function stableKey(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 24)
}

export function DownloadFunc(factory, { url = null, extHeaders = {}, cacheKey = null } = {}) {
  if (typeof factory !== "function") throw new TypeError("DownloadFunc factory 必须是函数")
  const task = (...args) => factory(...args)
  task.url = url
  task.ext_headers = extHeaders
  task.cacheKey = cacheKey
  return task
}

function mediaTask(kind, value, options = {}) {
  if (value instanceof PathTask) return value
  if (typeof value === "function") {
    const headers = value.ext_headers || value.extHeaders || options.headers
    const cacheKey = value.cacheKey || options.cacheKey
    return new PathTask(value, kind + ":" + (cacheKey || value.url || "custom"), {
      url: value.url || null,
      cacheKey,
      headers,
    })
  }
  const url = String(value)
  const method = {
    image: "downloadImage",
    video: "downloadVideo",
    audio: "downloadAudio",
  }[kind]
  return new PathTask(
    () =>
      downloader[method](url, {
        headers: options.headers || {},
        cacheKey: options.cacheKey,
        browser: options.browser,
      }),
    kind + ":" + (options.cacheKey || url),
    {
      url,
      cacheKey: options.cacheKey,
      headers: options.headers,
      useBrowserClient: options.browser,
    },
  )
}

function optionalImage(url, options = {}) {
  return url ? mediaTask("image", url, options) : null
}

export class Creator {
  static author(
    name,
    {
      avatarUrl = null,
      description = null,
      id = null,
      location = null,
      headers = {},
      browser = false,
      cacheKey = null,
    } = {},
  ) {
    return new Author(name, {
      avatar: optionalImage(avatarUrl, { headers, browser, cacheKey }),
      description,
      id,
      location,
    })
  }

  static video(
    urlOrTask,
    {
      coverUrl = null,
      duration = null,
      needSend = true,
      headers = {},
      browser = false,
      cacheKey = null,
    } = {},
  ) {
    const task = mediaTask("video", urlOrTask, { headers, browser, cacheKey })
    const cover =
      optionalImage(coverUrl, {
        headers,
        browser,
        cacheKey: cacheKey ? cacheKey + ":cover" : null,
      }) ||
      new PathTask(async () => ffmpeg.firstFrame(await task.get()), "cover-from-video")
    return new VideoContent(task, { cover, duration, needSend })
  }

  static gif(
    url,
    { coverUrl = null, duration = null, headers = {}, browser = false, cacheKey = null } = {},
  ) {
    const videoTask = mediaTask("video", url, { headers, browser, cacheKey })
    const gifTask = new PathTask(
      async () => ffmpeg.toGif(await videoTask.get()),
      "gif:" + (cacheKey || url),
    )
    return new VideoContent(videoTask, {
      cover: optionalImage(coverUrl, { headers, browser }),
      duration,
      isGif: true,
      gifPath: gifTask,
    })
  }

  static videos(urls = [], options = {}) {
    if (options.cacheKeys && options.cacheKeys.length !== urls.length) {
      throw new RangeError("cacheKeys 与视频 URL 数量必须一致")
    }
    return urls.filter(Boolean).map((url, index) =>
      this.video(url, {
        ...options,
        cacheKey: options.cacheKeys?.[index] || options.cacheKey || null,
      }),
    )
  }

  static audio(
    urlOrTask,
    {
      duration = null,
      needSend = true,
      headers = {},
      browser = false,
      cacheKey = null,
    } = {},
  ) {
    return new AudioContent(
      mediaTask("audio", urlOrTask, { headers, browser, cacheKey }),
      { duration, needSend },
    )
  }

  static image(
    urlOrTask,
    { alt = null, needSend = true, headers = {}, browser = false, cacheKey = null } = {},
  ) {
    return new ImageContent(
      mediaTask("image", urlOrTask, { headers, browser, cacheKey }),
      { alt, needSend },
    )
  }

  static images(urls = [], options = {}) {
    if (options.cacheKeys && options.cacheKeys.length !== urls.length) {
      throw new RangeError("cacheKeys 与图片 URL 数量必须一致")
    }
    return urls.filter(Boolean).map((url, index) =>
      this.image(url, {
        ...options,
        cacheKey: options.cacheKeys?.[index] || options.cacheKey || null,
      }),
    )
  }

  static graphic(
    urlOrTask,
    { alt = null, needSend = true, headers = {}, browser = false, cacheKey = null } = {},
  ) {
    return new GraphicContent(
      mediaTask("image", urlOrTask, { headers, browser, cacheKey }),
      { alt, needSend },
    )
  }

  static sticker(
    url,
    {
      size = "medium",
      description = null,
      headers = {},
      browser = false,
      cacheKey = null,
    } = {},
  ) {
    return new StickerContent(mediaTask("image", url, { headers, browser, cacheKey }), {
      size,
      description,
    })
  }

  static platformSticker(platform, name, options = {}) {
    const url = STICKER_CDN + encodeURIComponent(platform) + "/" + encodeURIComponent(name) + ".webp"
    return this.sticker(url, {
      ...options,
      cacheKey: options.cacheKey || "sticker:" + platform + ":" + name,
    })
  }

  static livePhoto(
    videoUrl,
    imageUrl,
    {
      bgmUrl = null,
      loop = 1,
      needSend = true,
      headers = {},
      browser = false,
      cacheKey = null,
    } = {},
  ) {
    if (!Number.isInteger(loop) || loop < 1) {
      throw new RangeError("Live Photo loop 必须是大于等于 1 的整数")
    }
    const videoTask = mediaTask("video", videoUrl, {
      headers,
      browser,
      cacheKey: cacheKey ? cacheKey + ":video" : null,
    })
    const baseImage = mediaTask("image", imageUrl, {
      headers,
      browser,
      cacheKey: cacheKey ? cacheKey + ":image" : null,
    })
    const bgm = bgmUrl
      ? mediaTask("audio", bgmUrl, {
          headers,
          browser,
          cacheKey: cacheKey ? cacheKey + ":bgm" : null,
        })
      : null
    const output = path.join(
      cacheDir,
      stableKey(
        (cacheKey || String(videoUrl) + String(imageUrl)) +
          ":loop=" + loop +
          ":bgm=" + String(bgmUrl || ""),
      ) + "-live.mp4",
    )
    const livePath = new PathTask(
      async () => {
        if (!config.parser_live_photo) return videoTask.get()
        return ffmpeg.mergeLivePhoto(
          await baseImage.get(),
          await videoTask.get(),
          bgm ? await bgm.get() : null,
          output,
          loop,
        )
      },
      "live-photo:" + (cacheKey || videoUrl),
    )
    return new LivePhotoContent(videoTask, {
      baseImage,
      bgm,
      loop,
      livePath,
      needSend,
    })
  }

  static stats(values = {}) {
    return new Stats({
      viewCount: values.viewCount ?? values.views ?? values.view ?? null,
      likeCount: values.likeCount ?? values.likes ?? values.like ?? null,
      collectCount: values.collectCount ?? values.collects ?? values.favorites ?? null,
      shareCount: values.shareCount ?? values.shares ?? values.reposts ?? null,
      commentCount: values.commentCount ?? values.comments ?? values.replies ?? null,
      extra: values.extra || {},
    })
  }

  static comment(values) {
    const stats =
      values.stats instanceof Stats
        ? values.stats
        : this.stats({
            ...(values.stats || {}),
            likes: values.likes,
            comments: values.replyCount,
          })
    return new Comment({
      ...values,
      content: Array.isArray(values.content) ? values.content : [values.content].filter(Boolean),
      stats,
    })
  }

  static link(
    url,
    {
      title = null,
      siteName = null,
      description = null,
      iconUrl = null,
      previewUrl = null,
      headers = {},
      browser = false,
      cacheKey = null,
    } = {},
  ) {
    return new LinkContent({
      url,
      title,
      siteName,
      description,
      icon: optionalImage(iconUrl, {
        headers,
        browser,
        cacheKey: cacheKey ? cacheKey + ":icon" : null,
      }),
      preview: optionalImage(previewUrl, {
        headers,
        browser,
        cacheKey: cacheKey ? cacheKey + ":preview" : null,
      }),
    })
  }

  static quote(
    text,
    { title = null, url = null, iconUrl = null, headers = {}, browser = false, cacheKey = null } = {},
  ) {
    return new QuoteContent({
      text,
      title,
      url,
      icon: optionalImage(iconUrl, { headers, browser, cacheKey }),
    })
  }

  static poll(values = {}) {
    return new PollContent(values)
  }

  static pollOption(text, votes = 0) {
    return new PollOption(text, votes)
  }
}
