import { biliUrl } from "./bilibili-api.js"

function dateFromLabel(label) {
  const match = /^(\d{4})年(\d{1,2})月(\d{1,2})日\s+(\d{1,2}):(\d{2})/.exec(label || "")
  return match ? new Date(match[1] + "-" + match[2].padStart(2, "0") + "-" + match[3].padStart(2, "0") + "T" + match[4].padStart(2, "0") + ":" + match[5] + ":00+08:00").getTime() / 1000 : null
}

export function biliTextNodes(parser, nodes = []) {
  const content = []
  let text = ""
  const flush = () => { if (text) { content.push(text); text = "" } }
  for (const node of nodes) {
    if (node.sticker?.url) {
      flush()
      content.push(parser.createSticker(biliUrl(node.sticker.url), "small", node.sticker.label?.text || node.raw))
    } else text += node.word?.text || node.link?.label?.text || node.sticker?.label?.text || node.raw || node.link?.url || ""
  }
  flush()
  return content
}

function appendParagraph(parser, result, paragraph, { heading = false, newline = false } = {}) {
  if (!paragraph) return
  if (paragraph.text) {
    const items = biliTextNodes(parser, paragraph.text.nodes)
    if (heading) result.title ||= items.filter(item => typeof item === "string").join("")
    else result.content.push(...items, ...(newline ? ["\n"] : []))
  }
  for (const pic of paragraph.pictures?.gallery?.images || []) {
    if (pic.url) result.content.push(parser.createImage(biliUrl(pic.url)))
  }
  if (paragraph.divider?.picture?.url) result.content.push(parser.createImage(biliUrl(paragraph.divider.picture.url)))
}

function applyCounts(parser, result, counts) {
  if (counts) result.stats = parser.createStats(counts)
}

function appendCard(parser, result, card, siteName = "哔哩哔哩") {
  if (!card) return
  result.title ||= card.title || null
  if (card.url && /^https?:\/\//.test(card.url)) {
    result.content.push(parser.createLink(card.url, { title: card.title, description: card.description, previewUrl: biliUrl(card.cover), siteName }))
  } else {
    if (card.description) result.content.push(card.description)
    if (card.cover) result.content.push(parser.createGraphic(biliUrl(card.cover)))
  }
}

function appendMedia(parser, result, media, seen, depth) {
  if (!media) return
  if (media.forwarded?.post) {
    result.repost = buildBiliPost(parser, media.forwarded.post, { seen, depth: depth + 1 })
    result.title ||= "转发动态"
  }
  if (media.video) {
    const card = media.video
    appendCard(parser, result, { ...card, url: card.url?.startsWith("http") ? card.url : card.bvid ? "https://www.bilibili.com/video/" + card.bvid : card.aid ? "https://www.bilibili.com/video/av" + card.aid : "" })
  }
  appendCard(parser, result, media.series)
  for (const pic of media.gallery?.images || []) if (pic.url) result.content.push(parser.createImage(biliUrl(pic.url)))
  if (media.article) {
    const card = media.article
    result.title ||= card.title
    if (card.description) result.content.push(card.description)
    for (const cover of card.covers || []) if (cover) result.content.push(parser.createImage(biliUrl(cover)))
  }
  appendCard(parser, result, media.generic)
  appendCard(parser, result, media.music)
  if (media.live) appendCard(parser, result, { ...media.live, url: media.live.url?.startsWith("http") ? media.live.url : "https://live.bilibili.com/" + media.live.id }, "哔哩哔哩直播")
  if (media.liveJson?.json) {
    try {
      const live = JSON.parse(media.liveJson.json).live_play_info
      if (live) appendCard(parser, result, { title: live.title, cover: live.cover, url: live.link?.split("?")[0] || "https://live.bilibili.com/" + live.room_id }, "哔哩哔哩直播")
    } catch {}
  }
}

export function buildBiliPost(parser, item, { id = null, article = false, seen = new Set(), depth = 0 } = {}) {
  const stableId = String(item.identity?.id || item.id || id || "")
  const result = parser.result({
    contentId: stableId || null,
    url: item.identity?.url?.startsWith("http") ? item.identity.url : stableId ? "https://www.bilibili.com/" + (article ? "opus/" : "dynamic/") + stableId : null,
    content: [], extra: { content_type: article ? "图文" : "动态" },
  })
  if (seen.has(item) || depth > 8) return result
  seen.add(item)
  for (const block of item.blocks || []) {
    if (block.author) {
      const author = block.author
      const profile = author.profile || {}
      result.author = parser.createAuthor(profile.name, biliUrl(profile.avatar), profile.bio, parser.headers, { id: String(author.id || profile.id || ""), location: author.location })
      result.timestamp ||= dateFromLabel(author.dateLabel)
    }
    if (block.forwardAuthor) {
      const author = block.forwardAuthor
      result.author = parser.createAuthor((author.labels || []).map(value => value.text || "").join("").replace(/^@/, ""), biliUrl(author.avatar), null, parser.headers, { id: String(author.id || "") })
      result.timestamp ||= dateFromLabel(author.dateLabel)
    }
    if (block.description) {
      const nodes = block.description.nodes || []
      for (const node of nodes) {
        if (node.kind === 9 && (node.url || node.icon)) result.content.push(parser.createSticker(biliUrl(node.url || node.icon), node.size === 1 ? "small" : "medium", node.text))
        else if (node.text) result.content.push(node.text)
      }
      if (!nodes.length && block.description.text) result.content.push(block.description.text)
    }
    appendMedia(parser, result, block.media, seen, depth)
    applyCounts(parser, result, block.counts || block.forwardCounts || block.footer?.counts)
    if (block.summary) {
      appendParagraph(parser, result, block.summary.heading, { heading: true })
      appendParagraph(parser, result, block.summary.body)
      for (const pic of block.summary.images || []) if (pic.url) result.content.push(parser.createImage(biliUrl(pic.url)))
    }
    if (block.paragraph) appendParagraph(parser, result, block.paragraph.paragraph, { heading: block.paragraph.heading, newline: article })
  }
  return result
}

export function biliCommentText(parser, text = "", emotes = {}) {
  const entries = Object.entries(emotes).map(([key, value]) => ({ ...value, label: value.text || key })).filter(item => item.label && item.url)
  const content = []
  let cursor = 0
  while (cursor < text.length) {
    let next = null, offset = text.length
    for (const entry of entries) {
      const index = text.indexOf(entry.label, cursor)
      if (index >= 0 && index < offset) { next = entry; offset = index }
    }
    if (!next) { content.push(text.slice(cursor)); break }
    if (offset > cursor) content.push(text.slice(cursor, offset))
    content.push(parser.createSticker(biliUrl(next.url), Number(next.size) === 1 ? "small" : "medium", next.label))
    cursor = offset + next.label.length
  }
  return content
}

export function buildBiliComments(parser, data, limit = 5) {
  const values = [], seen = new Set()
  for (const value of [data.pinned, ...(data.top || []), ...(data.replies || [])]) {
    if (!value?.id || seen.has(String(value.id))) continue
    seen.add(String(value.id))
    values.push(value)
  }
  const pinned = data.pinned?.id ? values.shift() : null
  values.sort((left, right) => Number(right.likes || 0) - Number(left.likes || 0))
  if (pinned) values.unshift(pinned)
  const convert = (value, parentAuthor = null, depth = 0) => {
    const profile = value.author || {}
    const author = parser.createAuthor(profile.name, biliUrl(profile.avatar), null, parser.headers, { id: String(profile.id || ""), location: value.context?.location })
    const content = biliCommentText(parser, value.body?.text || "", value.body?.emotes)
    content.push(...(value.body?.pictures || []).filter(pic => pic.url).map(pic => parser.createImage(biliUrl(pic.url))))
    return parser.createComment({
      author, content, timestamp: value.published, parentAuthor,
      stats: parser.createStats({ likes: value.likes, comments: value.count }),
      replies: depth < 1 ? (value.replies || []).slice(0, 5).map(reply => convert(reply, author, depth + 1)) : [],
    })
  }
  return values.slice(0, Math.max(0, limit)).map(value => convert(value))
}
