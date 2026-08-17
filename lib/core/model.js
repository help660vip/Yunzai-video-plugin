import { fmtDuration } from "./utils.js"

export class PathTask {
  constructor(factory, label = "task", metadata = {}) {
    this.factory = typeof factory === "function" ? factory : async () => factory
    this.label = label
    this.url = metadata.url || null
    this.cacheKey = metadata.cacheKey || null
    this.headers = metadata.headers || {}
    this.useBrowserClient = Boolean(metadata.useBrowserClient)
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
  constructor(pathTask, { needSend = true } = {}) {
    this.pathTask = pathTask instanceof PathTask ? pathTask : new PathTask(pathTask)
    this.needSend = needSend
  }
}

export class AudioContent extends MediaContent {
  constructor(pathTask, { duration = null, needSend = true } = {}) {
    super(pathTask, { needSend })
    this.duration = duration
  }

  get displayDuration() {
    return this.duration ? fmtDuration(this.duration) : null
  }
}

export class VideoContent extends MediaContent {
  constructor(
    pathTask,
    { cover = null, duration = null, isGif = false, gifPath = null, needSend = true } = {},
  ) {
    super(pathTask, { needSend })
    this.cover = cover && !(cover instanceof PathTask) ? new PathTask(cover) : cover
    this.duration = duration
    this.isGif = isGif
    this.gifPath = gifPath && !(gifPath instanceof PathTask) ? new PathTask(gifPath) : gifPath
  }

  get displayDuration() {
    return this.duration ? "时长: " + fmtDuration(this.duration) : null
  }
}

export class ImageContent extends MediaContent {
  constructor(pathTask, { alt = null, needSend = true } = {}) {
    super(pathTask, { needSend })
    this.alt = alt
  }
}

export class GraphicContent extends MediaContent {
  constructor(pathTask, { alt = null, needSend = true } = {}) {
    super(pathTask, { needSend })
    this.alt = alt
  }
}

export class StickerContent extends MediaContent {
  constructor(pathTask, { size = "medium", description = null } = {}) {
    super(pathTask, { needSend: false })
    this.size = size === "small" ? "small" : "medium"
    this.description = description
    this.desc = description
  }
}

export class LivePhotoContent extends MediaContent {
  constructor(
    videoTask,
    { baseImage, bgm = null, loop = 1, livePath = null, needSend = true } = {},
  ) {
    super(videoTask, { needSend })
    if (!Number.isInteger(loop) || loop < 1) {
      throw new RangeError("Live Photo loop 必须是大于等于 1 的整数")
    }
    this.baseImage = baseImage instanceof PathTask ? baseImage : new PathTask(baseImage)
    this.bgm = bgm && !(bgm instanceof PathTask) ? new PathTask(bgm) : bgm
    this.loop = loop
    this.livePath = livePath && !(livePath instanceof PathTask) ? new PathTask(livePath) : livePath
  }

  getBase() {
    return this.baseImage.get()
  }

  getLive() {
    return this.livePath?.get() || this.pathTask.get()
  }
}

export class Author {
  constructor(
    name,
    { avatar = null, description = null, id = null, location = null } = {},
  ) {
    this.name = name || ""
    this.avatar = avatar && !(avatar instanceof PathTask) ? new PathTask(avatar) : avatar
    this.description = description
    this.id = id
    this.location = location
  }
}

export class Stats {
  constructor({
    viewCount = null,
    likeCount = null,
    collectCount = null,
    shareCount = null,
    commentCount = null,
    extra = {},
  } = {}) {
    this.viewCount = viewCount
    this.likeCount = likeCount
    this.collectCount = collectCount
    this.shareCount = shareCount
    this.commentCount = commentCount
    this.extra = extra || {}
  }
}

export class Comment {
  constructor({
    author,
    content = [],
    timestamp = null,
    stats = new Stats(),
    replies = [],
    parentAuthor = null,
  }) {
    this.author = author
    this.content = content
    this.timestamp = timestamp
    this.stats = stats instanceof Stats ? stats : new Stats(stats)
    this.replies = replies
    this.parentAuthor = parentAuthor
  }

  get formattedDatetime() {
    return formatTimestamp(this.timestamp)
  }
}

export class LinkContent {
  constructor({
    url,
    title = null,
    siteName = null,
    description = null,
    icon = null,
    preview = null,
  }) {
    this.url = url
    this.title = title || url
    this.siteName = siteName
    this.description = description
    this.icon = icon && !(icon instanceof PathTask) ? new PathTask(icon) : icon
    this.preview = preview && !(preview instanceof PathTask) ? new PathTask(preview) : preview
  }
}

export class QuoteContent {
  constructor({ text, title = null, url = null, icon = null }) {
    this.text = text
    this.title = title
    this.url = url
    this.icon = icon && !(icon instanceof PathTask) ? new PathTask(icon) : icon
  }
}

export class PollOption {
  constructor(text, votes = 0) {
    this.text = text
    this.votes = Math.max(0, Number(votes) || 0)
  }
}

export class PollContent {
  constructor({
    options = [],
    title = null,
    totalVotes = null,
    totalVoters = null,
    multiple = false,
    closed = false,
    closeAt = null,
  } = {}) {
    this.options = options.map(item =>
      item instanceof PollOption ? item : new PollOption(item.text, item.votes),
    )
    this.title = title
    this.totalVotes = totalVotes
    this.totalVoters = totalVoters
    this.multiple = Boolean(multiple)
    this.closed = Boolean(closed)
    this.closeAt = closeAt
  }

  get optionVoteTotal() {
    return this.options.reduce((sum, option) => sum + option.votes, 0)
  }

  optionPercentage(option) {
    return this.optionVoteTotal ? (Math.max(0, option.votes) / this.optionVoteTotal) * 100 : 0
  }
}

export class SafetyInfo {
  constructor({ rating = "unknown", sensitive = false, ageLimit = 0, reasons = [] } = {}) {
    this.rating = ["safe", "sensitive", "adult", "unknown"].includes(rating)
      ? rating
      : "unknown"
    this.sensitive = Boolean(sensitive)
    this.ageLimit = Number(ageLimit) || 0
    this.reasons = Array.isArray(reasons) ? reasons : [String(reasons)]
  }
}

function formatTimestamp(timestamp) {
  if (timestamp === null || timestamp === undefined || timestamp === "") return ""
  const numeric = Number(timestamp)
  const value = Number.isFinite(numeric)
    ? new Date(Math.abs(numeric) < 1e12 ? numeric * 1000 : numeric)
    : new Date(timestamp)
  if (Number.isNaN(value.getTime())) return ""
  const parts = [
    value.getFullYear(),
    String(value.getMonth() + 1).padStart(2, "0"),
    String(value.getDate()).padStart(2, "0"),
    String(value.getHours()).padStart(2, "0"),
    String(value.getMinutes()).padStart(2, "0"),
    String(value.getSeconds()).padStart(2, "0"),
  ]
  return parts[0] + "-" + parts[1] + "-" + parts[2] + " " + parts[3] + ":" + parts[4] + ":" + parts[5]
}

function contentMedia(items) {
  return items.filter(item => item instanceof MediaContent)
}

export class ParseResult {
  constructor({
    platform,
    contentId = null,
    author = null,
    title = null,
    text = null,
    timestamp = null,
    url = null,
    contents = [],
    graphics = [],
    content = [],
    stats = new Stats(),
    comments = [],
    aiSummary = null,
    embedUrl = null,
    safety = new SafetyInfo(),
    extra = {},
    repost = null,
    renderImage = null,
  }) {
    this.platform = platform
    this.contentId =
      contentId === null || contentId === undefined || contentId === ""
        ? null
        : String(contentId)
    this.author = author
    this.title = title
    this.text = text
    this.timestamp = timestamp
    this.url = url
    this.contents = contents
    this.graphics = graphics
    this.content = content
    this.stats = stats instanceof Stats ? stats : new Stats(stats)
    this.comments = comments
    this.aiSummary = aiSummary
    this.embedUrl = embedUrl
    this.safety = safety instanceof SafetyInfo ? safety : new SafetyInfo(safety)
    this.extra = extra
    this.repost = repost
    this.renderImage = renderImage
  }

  get orderedContent() {
    if (this.content.length) return this.content
    return [this.text, ...this.contents, ...this.graphics].filter(Boolean)
  }

  get header() {
    let value = this.platform.displayName
    if (this.author) value += " @" + this.author.name
    if (this.title) value += " | " + this.title
    return value
  }

  get displayUrl() {
    return this.url ? "链接: " + this.url : null
  }

  get repostDisplayUrl() {
    return this.repost?.url ? "原帖: " + this.repost.url : null
  }

  get extraInfo() {
    return this.extra.info || null
  }

  get allMedia() {
    const seen = new Set()
    const values = [...this.contents, ...contentMedia(this.content), ...this.graphics].filter(
      item => item instanceof MediaContent,
    )
    return values.filter(item => {
      if (seen.has(item)) return false
      seen.add(item)
      return true
    })
  }

  get video() {
    const values = this.allMedia.filter(item => item.needSend !== false)
    if (values.length !== 1) return null
    const item = values[0]
    return item instanceof VideoContent && !item.isGif ? item : null
  }

  set video(value) {
    if (value && this.contents.length === 0 && this.content.length === 0) this.contents.push(value)
  }

  get videoContents() {
    return this.allMedia.filter(item => item instanceof VideoContent)
  }

  get imageContents() {
    return this.allMedia.filter(item => item instanceof ImageContent)
  }

  get audioContents() {
    return this.allMedia.filter(item => item instanceof AudioContent)
  }

  get gridMedias() {
    return this.allMedia.filter(
      item =>
        item instanceof VideoContent ||
        item instanceof ImageContent ||
        item instanceof LivePhotoContent,
    )
  }

  get contentType() {
    if (this.extra.content_type) return this.extra.content_type
    if (this.audioContents.length) return "音频"
    if (this.videoContents.length) return "视频"
    if (this.allMedia.length || this.graphics.length) return "图文"
    return "动态"
  }

  formattedDatetime() {
    return formatTimestamp(this.timestamp) || null
  }

  *downloadTasks(imgOnly = false) {
    if (this.author?.avatar) yield this.author.avatar
    for (const item of this.allMedia) {
      if (item instanceof LivePhotoContent) {
        yield item.baseImage
        if (!imgOnly) {
          yield item.pathTask
          if (item.bgm) yield item.bgm
        }
        continue
      }
      if (
        !imgOnly ||
        item instanceof ImageContent ||
        item instanceof GraphicContent ||
        item instanceof StickerContent
      ) {
        yield item.pathTask
      }
      if (item instanceof VideoContent && item.cover) yield item.cover
    }
    for (const item of this.content) {
      if (item instanceof LinkContent) {
        if (item.icon) yield item.icon
        if (item.preview) yield item.preview
      } else if (item instanceof QuoteContent && item.icon) {
        yield item.icon
      }
    }
    for (const comment of this.comments) yield* commentTasks(comment, imgOnly)
    if (this.repost) yield* this.repost.downloadTasks(imgOnly)
  }

  async ensureDownloadsComplete({ imgOnly = false, suppressErrors = true } = {}) {
    const tasks = [...new Set([...this.downloadTasks(imgOnly)])]
    const results = await Promise.allSettled(tasks.map(task => task.get()))
    if (!suppressErrors) {
      const failed = results.find(item => item.status === "rejected")
      if (failed) throw failed.reason
    }
  }
}

function* commentTasks(comment, imgOnly) {
  if (comment.author?.avatar) yield comment.author.avatar
  for (const item of comment.content || []) {
    if (item instanceof MediaContent) {
      if (!imgOnly || (!(item instanceof AudioContent) && !(item instanceof VideoContent))) {
        yield item.pathTask
      }
      if (item instanceof VideoContent && item.cover) yield item.cover
    } else if (item instanceof LinkContent) {
      if (item.icon) yield item.icon
      if (item.preview) yield item.preview
    }
  }
  for (const reply of comment.replies || []) yield* commentTasks(reply, imgOnly)
}
