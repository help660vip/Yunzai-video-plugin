import { fmtDuration } from "./utils.js"

export class PathTask {
  constructor(factory, label = "task") {
    this.factory = typeof factory === "function" ? factory : async () => factory
    this.label = label
    this.promise = null
  }

  get() {
    if (!this.promise) this.promise = Promise.resolve().then(this.factory)
    return this.promise
  }

  async safeGet(onError) {
    try {
      return await this.get()
    } catch (error) {
      onError?.(error)
      return null
    }
  }
}

export class MediaContent {
  constructor(pathTask) {
    this.pathTask = pathTask instanceof PathTask ? pathTask : new PathTask(pathTask)
  }
}

export class AudioContent extends MediaContent {
  constructor(pathTask, { duration = null } = {}) {
    super(pathTask)
    this.duration = duration
  }
}

export class VideoContent extends MediaContent {
  constructor(
    pathTask,
    { cover = null, duration = null, isGif = false, gifPath = null } = {},
  ) {
    super(pathTask)
    this.cover = cover && !(cover instanceof PathTask) ? new PathTask(cover) : cover
    this.duration = duration
    this.isGif = isGif
    this.gifPath = gifPath && !(gifPath instanceof PathTask) ? new PathTask(gifPath) : gifPath
  }

  get displayDuration() {
    return this.duration ? `时长: ${fmtDuration(this.duration)}` : null
  }
}

export class ImageContent extends MediaContent {
  constructor(pathTask, { alt = null } = {}) {
    super(pathTask)
    this.alt = alt
  }
}

export class Author {
  constructor(name, { avatar = null, description = null } = {}) {
    this.name = name
    this.avatar = avatar && !(avatar instanceof PathTask) ? new PathTask(avatar) : avatar
    this.description = description
  }
}

export class ParseResult {
  constructor({
    platform,
    author = null,
    title = null,
    text = null,
    timestamp = null,
    url = null,
    contents = [],
    graphics = [],
    extra = {},
    repost = null,
    renderImage = null,
  }) {
    this.platform = platform
    this.author = author
    this.title = title
    this.text = text
    this.timestamp = timestamp
    this.url = url
    this.contents = contents
    this.graphics = graphics
    this.extra = extra
    this.repost = repost
    this.renderImage = renderImage
  }

  get header() {
    let value = this.platform.displayName
    if (this.author) value += ` @${this.author.name}`
    if (this.title) value += ` | ${this.title}`
    return value
  }

  get displayUrl() {
    return this.url ? `链接: ${this.url}` : null
  }

  get repostDisplayUrl() {
    return this.repost?.url ? `原帖: ${this.repost.url}` : null
  }

  get extraInfo() {
    return this.extra.info || null
  }

  get video() {
    if (this.contents.length !== 1) return null
    const item = this.contents[0]
    return item instanceof VideoContent && !item.isGif ? item : null
  }

  set video(value) {
    if (value && this.contents.length === 0) this.contents.push(value)
  }

  get videoContents() {
    return this.contents.filter(item => item instanceof VideoContent)
  }

  get imageContents() {
    return this.contents.filter(item => item instanceof ImageContent)
  }

  get audioContents() {
    return this.contents.filter(item => item instanceof AudioContent)
  }

  get gridMedias() {
    return this.contents.filter(
      item => item instanceof VideoContent || item instanceof ImageContent,
    )
  }

  get contentType() {
    if (this.extra.content_type) return this.extra.content_type
    if (this.video) return "视频"
    if (this.graphics.length) return "图文"
    return "动态"
  }

  formattedDatetime() {
    if (this.timestamp === null || this.timestamp === undefined) return null
    const value = new Date(Number(this.timestamp) * 1000)
    const parts = [
      value.getFullYear(),
      String(value.getMonth() + 1).padStart(2, "0"),
      String(value.getDate()).padStart(2, "0"),
      String(value.getHours()).padStart(2, "0"),
      String(value.getMinutes()).padStart(2, "0"),
      String(value.getSeconds()).padStart(2, "0"),
    ]
    return `${parts[0]}-${parts[1]}-${parts[2]} ${parts[3]}:${parts[4]}:${parts[5]}`
  }

  *downloadTasks(imgOnly = false) {
    if (this.author?.avatar) yield this.author.avatar
    for (const item of this.contents) {
      if (!imgOnly || item instanceof ImageContent) yield item.pathTask
      if (item instanceof VideoContent && item.cover) yield item.cover
    }
    for (const item of this.graphics) {
      if (item instanceof ImageContent) yield item.pathTask
    }
    if (this.repost) yield* this.repost.downloadTasks(imgOnly)
  }

  async ensureDownloadsComplete({ imgOnly = false, suppressErrors = true } = {}) {
    const results = await Promise.allSettled([...this.downloadTasks(imgOnly)].map(task => task.get()))
    if (!suppressErrors) {
      const failed = results.find(item => item.status === "rejected")
      if (failed) throw failed.reason
    }
  }
}
