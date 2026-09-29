import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { fileURLToPath, pathToFileURL } from "node:url"

import emojiRegex from "emoji-regex"
import QRCode from "qrcode"

import { config, customFontPath } from "../core/config.js"
import { ffmpeg } from "../core/ffmpeg.js"
import { cacheLifecycle, temporaryCachePath } from "../core/cache-lifecycle.js"
import { cacheDir, resourcesDir } from "../core/paths.js"
import {
  GraphicContent,
  AudioContent,
  ImageContent,
  LinkContent,
  LivePhotoContent,
  PollContent,
  QuoteContent,
  StickerContent,
  VideoContent,
} from "../core/model.js"
import { fileSegment, imageSegment, markMediaRole, renderContents, sendForward } from "../core/sender.js"
import { log } from "../core/logger.js"
import { buildThemeData } from "./context.js"
import { captureLongCard } from "./capture.js"
import { renderThemeTemplate, resolveTheme, safeThemeFile } from "./theme.js"
import { browserManager } from "./browser-manager.js"

const renderKeys = new WeakMap()

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

function mimeOf(filePath, data) {
  if (data?.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return "image/png"
  }
  if (data?.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return "image/jpeg"
  if (data?.subarray(0, 3).toString("ascii") === "GIF") return "image/gif"
  if (
    data?.subarray(0, 4).toString("ascii") === "RIFF" &&
    data?.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp"
  }
  const ext = path.extname(filePath).toLowerCase()
  if (ext === ".png") return "image/png"
  if (ext === ".gif") return "image/gif"
  if (ext === ".webp") return "image/webp"
  if (ext === ".svg") return "image/svg+xml"
  if (ext === ".ttf") return "font/ttf"
  return "image/jpeg"
}

async function dataUri(filePath) {
  return cacheLifecycle.withActive(filePath, async () => {
    const data = await fs.promises.readFile(filePath)
    return `data:${mimeOf(filePath, data)};base64,${data.toString("base64")}`
  })
}

function renderEmoji(text) {
  const regex = emojiRegex()
  let cursor = 0
  let output = ""
  for (const match of String(text || "").matchAll(regex)) {
    output += escapeHtml(text.slice(cursor, match.index))
    const encoded = encodeURIComponent(match[0])
    output += `<img class="emoji" src="${config.parser_emoji_cdn}/${encoded}?style=${config.parser_emoji_style}" alt="${escapeHtml(match[0])}">`
    cursor = match.index + match[0].length
  }
  return output + escapeHtml(String(text || "").slice(cursor))
}

async function mediaPreview(content) {
  let filePath
  let play = false
  let live = false
  if (content instanceof LivePhotoContent) {
    live = true
    play = true
    filePath = await content.baseImage.safeGet()
  } else if (content instanceof VideoContent) {
    play = true
    filePath = content.cover?.requiresMedia ? null : await content.cover?.safeGet()
    if (!filePath) {
      const fallback = 1 + Math.floor(Math.random() * 9)
      filePath = path.join(resourcesDir, "fallback_pic", `${fallback}.jpg`)
    }
  } else {
    filePath = await content.pathTask.safeGet()
  }
  if (!filePath) return null
  return { source: await dataUri(filePath), play, live, duration: content.displayDuration, layout: content.layout || "grid" }
}

function statsHtml(stats) {
  if (!stats) return ""
  const values = [
    ["浏览", stats.viewCount],
    ["点赞", stats.likeCount],
    ["评论", stats.commentCount],
    ["收藏", stats.collectCount],
    ["分享", stats.shareCount],
    ...Object.entries(stats.extra || {}).map(([label, value]) => Array.isArray(value) ? value : [label === "hot" ? "热度" : label, value]),
  ].filter(([, value]) => value !== null && value !== undefined && value !== "" && value !== "-")
  if (!values.length) return ""
  return (
    '<div class="stats">' +
    values
      .map(
        ([label, value]) =>
          '<span><small>' + escapeHtml(label) + '</small><b>' + escapeHtml(value) + "</b></span>",
      )
      .join("") +
    "</div>"
  )
}

async function richItemHtml(item) {
  if (typeof item === "string") {
    return '<div class="rich-text">' + renderEmoji(item).replace(/\n/g, "<br>") + "</div>"
  }
  if (!item) return ""
  if (item instanceof AudioContent) {
    return '<div class="audio-card"><b>音频</b><span>' + escapeHtml(item.displayDuration || "") + '</span></div>'
  }
  if (item instanceof GraphicContent) {
    const filePath = await item.pathTask.safeGet()
    if (!filePath) return item.alt ? '<div class="rich-text">' + renderEmoji(item.alt) + "</div>" : ""
    return (
      '<figure class="rich-graphic"><img src="' +
      (await dataUri(filePath)) +
      '">' +
      (item.alt ? "<figcaption>" + renderEmoji(item.alt) + "</figcaption>" : "") +
      "</figure>"
    )
  }
  if (item instanceof StickerContent) {
    const filePath = await item.pathTask.safeGet()
    if (!filePath) return item.description ? '<span class="sticker-fallback">' + escapeHtml(item.description) + "</span>" : ""
    return (
      '<img class="sticker ' +
      item.size +
      '" src="' +
      (await dataUri(filePath)) +
      '" alt="' +
      escapeHtml(item.description || "贴纸") +
      '">'
    )
  }
  if (item instanceof LinkContent) {
    const iconPath = await item.icon?.safeGet()
    const previewPath = await item.preview?.safeGet()
    const icon = iconPath ? '<img class="link-icon" src="' + (await dataUri(iconPath)) + '">' : ""
    const preview = previewPath ? '<img class="link-preview" src="' + (await dataUri(previewPath)) + '">' : ""
    return (
      '<div class="link-card">' +
      preview +
      '<div class="link-body"><div class="link-source">' +
      icon +
      escapeHtml(item.siteName || item.url) +
      '</div><b>' +
      escapeHtml(item.title) +
      "</b>" +
      (item.description ? "<p>" + renderEmoji(item.description) + "</p>" : "") +
      "</div></div>"
    )
  }
  if (item instanceof QuoteContent) {
    const iconPath = await item.icon?.safeGet()
    const icon = iconPath ? '<img class="quote-icon" src="' + (await dataUri(iconPath)) + '">' : ""
    return (
      '<div class="quote-card' + (/翻译|译文|translation/i.test(item.title || "") ? ' translation' : '') + '"><div>' +
      icon +
      "<b>" +
      escapeHtml(item.title || item.url || "引用内容") +
      "</b></div><p>" +
      renderEmoji(item.text).replace(/\n/g, "<br>") +
      "</p></div>"
    )
  }
  if (item instanceof PollContent) {
    const total = item.optionVoteTotal
    const options = item.options
      .map(option => {
        const percentage = total ? (option.votes / total) * 100 : 0
        return (
          '<div class="poll-option"><div><span>' +
          escapeHtml(option.text) +
          "</span><small>" +
          option.votes +
          " 票 · " +
          percentage.toFixed(1) +
          '%</small></div><i style="width:' +
          percentage.toFixed(2) +
          '%"></i></div>'
        )
      })
      .join("")
    return (
      '<div class="poll"><header><b>' +
      escapeHtml(item.title || "投票") +
      "</b><small>" +
      (item.closed ? "已结束" : "进行中") +
      "</small></header>" +
      options +
      '<footer>' +
      (item.totalVoters === null ? "" : item.totalVoters + " 人参与") +
      (item.multiple ? " · 多选" : "") +
      "</footer></div>"
    )
  }
  return ""
}

async function imageGridHtml(items) {
  const media = []
  for (const item of items) {
    const preview = await mediaPreview(item)
    if (preview) media.push(preview)
  }
  if (!media.length) return ""
  const limit = media[0].layout === "x" ? 4 : 9
  const visible = media.slice(0, limit), hidden = media.length - visible.length
  return '<div class="grid count-' + visible.length + (media[0].layout === "x" ? ' layout-x' : '') + '">' + visible.map((item, index) =>
    '<div class="media"><img src="' + item.source + '">' + (item.play ? '<span class="play">▶</span>' : '') +
    (item.live ? '<span class="live-tag">LIVE</span>' : '') + (item.duration ? '<span class="duration">' + escapeHtml(item.duration) + '</span>' : '') +
    (hidden && index === visible.length - 1 ? '<span class="more">+' + hidden + '</span>' : '') + '</div>').join('') + '</div>'
}

async function richContentHtml(items) {
  const output = []
  let images = []
  const flush = async () => { if (images.length) { output.push(await imageGridHtml(images)); images = [] } }
  for (const item of items || []) {
    if (item instanceof ImageContent || item instanceof LivePhotoContent) { images.push(item); continue }
    await flush()
    if (item instanceof VideoContent) { output.push(await imageGridHtml([item])); continue }
    output.push(await richItemHtml(item))
  }
  await flush()
  return output.filter(Boolean).join("")
}

async function commentHtml(comment, nested = false) {
  const avatarPath = await comment.author?.avatar?.safeGet()
  const avatar = avatarPath ? await dataUri(avatarPath) : null
  const body = await richContentHtml(comment.content)
  const replies = []
  for (const reply of (comment.replies || []).slice(0, 5)) {
    replies.push(await commentHtml(reply, true))
  }
  return (
    '<article class="comment ' +
    (nested ? "reply" : "") +
    '">' +
    (avatar ? '<img class="comment-avatar" src="' + avatar + '">' : "") +
    '<div class="comment-main"><header><b>' +
    renderEmoji(comment.author?.name || "") +
    "</b>" +
    (comment.parentAuthor ? "<small>回复 @" + escapeHtml(comment.parentAuthor.name) + "</small>" : "") +
    "</header>" +
    body +
    '<footer>' +
    escapeHtml(comment.formattedDatetime || "") +
    (comment.author?.location ? " · " + escapeHtml(comment.author.location) : "") +
    (comment.stats?.likeCount ? " · 赞 " + escapeHtml(comment.stats.likeCount) : "") +
    "</footer>" +
    replies.join("") +
    "</div></article>"
  )
}

async function commentsHtml(comments) {
  if (!comments?.length || config.parser_max_comments <= 0) return ""
  const output = []
  for (const comment of comments.slice(0, config.parser_max_comments)) {
    output.push(await commentHtml(comment))
  }
  return '<section class="comments"><h2>热门评论</h2>' + output.join("") + "</section>"
}

function themeName() {
  const [startText, endText] = config.parser_day_range
  const toMinutes = value => {
    const [hour, minute] = value.split(":").map(Number)
    return hour * 60 + minute
  }
  const start = toMinutes(startText)
  const end = toMinutes(endText)
  const now = new Date()
  const current = now.getHours() * 60 + now.getMinutes()
  const daytime = start <= end ? current >= start && current < end : current >= start || current < end
  return daytime ? "day" : "night"
}

async function resultView(result, mode, nested = false) {
  const theme = themeName()
  const logoPath = path.join(resourcesDir, `${result.platform.name}.png`)
  const logo = fs.existsSync(logoPath) ? await dataUri(logoPath) : null
  const avatarPath = await result.author?.avatar?.safeGet()
  const avatar = await dataUri(
    avatarPath && fs.existsSync(avatarPath) ? avatarPath : path.join(resourcesDir, "avatar.png"),
  )
  const media = []
  for (const item of result.gridMedias) {
    if (result.content.includes(item)) continue
    const preview = await mediaPreview(item)
    if (preview) media.push(preview)
  }
  const graphics = []
  if (!result.contents.length) {
    for (const item of result.graphics) {
      if (typeof item === "string") {
        graphics.push(`<div class="graphic-text">${renderEmoji(item).replace(/\n/g, "<br>")}</div>`)
        continue
      }
      const graphicPath = await item.pathTask.safeGet()
      const source = await dataUri(
        graphicPath ||
          path.join(
            resourcesDir,
            "fallback_pic",
            `${1 + Math.floor(Math.random() * 9)}.jpg`,
          ),
      )
      graphics.push(
        `<figure><img src="${source}">${
          item.alt ? `<figcaption>${renderEmoji(item.alt)}</figcaption>` : ""
        }</figure>`,
      )
    }
  }
  const rich = result.content.length ? await richContentHtml(result.content) : ""
  const stats = statsHtml(result.stats)
  const comments = await commentsHtml(result.comments)
  const qrcode =
    !nested && config.parser_append_qrcode && result.url
      ? await QRCode.toDataURL(result.url, { margin: 1, width: 116 })
      : null
  const visibleMedia = media.slice(0, 9)
  const hiddenCount = Math.max(0, media.length - visibleMedia.length)
  const info = [
    result.extraInfo,
    result.timestamp !== null && result.timestamp !== undefined
      ? result.formattedDatetime()
      : null,
  ]
    .filter(Boolean)
    .join(" · ")
  return `
  <section class="result ${mode} ${theme} ${nested ? "nested" : ""}" data-platform="${escapeHtml(result.platform.name)}">
    <header>
      ${logo ? `<img class="logo" src="${logo}">` : ""}
      <span>${escapeHtml(result.platform.displayName)}</span>
      <span class="type">${escapeHtml(result.contentType)}</span>
    </header>
    ${
      result.author
        ? `<div class="author"><img src="${avatar}"><div><b>${renderEmoji(result.author.name)}</b>${
            result.author.description
              ? `<small>${renderEmoji(result.author.description)}</small>`
              : ""
          }${result.author.location ? `<small class="author-location">${escapeHtml(result.author.location)}</small>` : ""}</div></div>`
        : ""
    }
    ${stats}
    ${result.title ? `<h1>${renderEmoji(result.title)}</h1>` : ""}
    ${result.text && !rich ? `<div class="text">${renderEmoji(result.text).replace(/\n/g, "<br>")}</div>` : ""}
    ${rich ? `<div class="rich-content">${rich}</div>` : ""}
    ${
      visibleMedia.length
        ? `<div class="grid count-${Math.min(visibleMedia.length, 9)}">${visibleMedia
            .map(
              (item, index) => `<div class="media"><img src="${item.source}">${
                item.play ? '<span class="play">▶</span>' : ""
              }${item.live ? '<span class="live-tag">LIVE</span>' : ""
              }${item.duration ? `<span class="duration">${item.duration}</span>` : ""}${
                hiddenCount && index === visibleMedia.length - 1
                  ? `<span class="more">+${hiddenCount}</span>`
                  : ""
              }</div>`,
            )
            .join("")}</div>`
        : ""
    }
    ${graphics.length ? `<div class="graphics">${graphics.join("")}</div>` : ""}
    ${result.aiSummary ? `<div class="ai-summary"><b>AI 摘要</b>${renderEmoji(result.aiSummary).replace(/\n/g, "<br>")}</div>` : ""}
    ${info ? `<div class="info">${renderEmoji(info)}</div>` : ""}
    ${result.repost ? `<div class="repost">${await resultView(result.repost, mode, true)}</div>` : ""}
    ${comments}
    ${qrcode ? `<footer class="source-footer"><span>扫码查看原内容</span><img src="${qrcode}"></footer>` : ""}
  </section>`
}

export async function renderCard(result, mode = config.parser_render_type, { forceBuiltin = false, format = "auto", event = null } = {}) {
  if (!["auto", "png"].includes(format)) throw new TypeError("不支持的卡片输出格式")
  const selectedTheme = forceBuiltin ? { id: "default", key: "builtin-2", template: null, css: "", root: null } : await resolveTheme(result.platform.name)
  const renderKey = crypto.createHash("sha256").update(JSON.stringify([
    selectedTheme.key, mode, themeName(), format, config.parser_custom_font, config.parser_custom_font_weight,
    config.parser_emoji_cdn, config.parser_emoji_style, config.parser_max_comments, config.parser_append_qrcode,
  ])).digest("hex")
  if (result.renderImage && renderKeys.get(result) === renderKey && fs.existsSync(result.renderImage)) return result.renderImage
  await result.ensureDownloadsComplete({ imgOnly: true, suppressErrors: true })
  const fontPath = customFontPath() || path.join(resourcesDir, "HYSongYunLangHeiW.ttf")
  const font = await dataUri(fontPath)
  const body = await resultView(result, mode)
  let html = `<!doctype html><html><head><meta charset="utf-8"><style>
  @font-face{font-family:parser;src:url("${font}")}*{box-sizing:border-box}
  body{margin:0;padding:24px;background:transparent;font-family:parser,"Microsoft YaHei",sans-serif;color:#20242a}
  .result{--primary:#6366f1;--grad-from:#eeeefd;--grad-via:#dddefa;--grad-to:#c7c8fa;width:752px;padding:26px;border-radius:24px;background:linear-gradient(150deg,#fff,#f4f6fa);box-shadow:0 8px 30px #0002}
  .result[data-platform="bilibili"]{--primary:#00a1d6;--grad-from:#c8e4f2;--grad-via:#c8ebf5;--grad-to:#a8ddf0}
  .result[data-platform="weibo"]{--primary:#e6162d;--grad-from:#f6d4d4;--grad-via:#f0b0b0;--grad-to:#e88a8a}
  .result[data-platform="xiaohongshu"]{--primary:#ff2442;--grad-from:#fce4ec;--grad-via:#f8ccda;--grad-to:#f5aab8}
  .result[data-platform="douyin"],.result[data-platform="tiktok"]{--primary:#161823;--grad-from:#c8e4e3;--grad-via:#a8d8d6;--grad-to:#7ecac8}
  .result[data-platform="youtube"]{--primary:#f00;--grad-from:#fce6e6;--grad-via:#f8d0d0;--grad-to:#f5b0b0}
  .result[data-platform="twitter"]{--primary:#000;--grad-from:#eee;--grad-via:#d8d8d8;--grad-to:#c0c0c0}
  .result[data-platform="kuaishou"]{--primary:#ff4906;--grad-from:#fcece0;--grad-via:#f8dac8;--grad-to:#f5c0a0}
  .result[data-platform="acfun"]{--primary:#fd4c5d;--grad-from:#fce6e9;--grad-via:#f8d0d5;--grad-to:#f5b0b8}
  .result[data-platform="nga"]{--primary:#816b45;--grad-from:#f4f0e8;--grad-via:#ebe3d4;--grad-to:#e0d5c0}
  .result.htmlrender{background:linear-gradient(160deg,var(--grad-from),var(--grad-via) 50%,var(--grad-to));border:1.5px solid #ffffff8c;box-shadow:-2px -2px 8px #00000008,6px 8px 24px #0000001a,12px 16px 48px #00000014}
  .result.htmlrender header,.result.htmlrender .type{color:var(--primary)}.result.htmlrender .type{background:#ffffff70}
  header{display:flex;align-items:center;gap:10px;font-size:20px;font-weight:700;color:#58606d}
  .logo{width:34px;height:34px;object-fit:contain}.type{margin-left:auto;padding:5px 12px;border-radius:14px;background:#eceff5;font-size:14px}
  .author{display:flex;align-items:center;gap:14px;margin-top:20px}.author>img{width:62px;height:62px;border-radius:50%;object-fit:cover}
  .author b{font-size:21px;font-weight:${config.parser_custom_font_weight}}.author small{display:block;margin-top:5px;color:#7e8794;font-size:14px}
  h1{margin:20px 0 9px;font-size:28px;line-height:1.35;font-weight:${config.parser_custom_font_weight}}.text{font-size:18px;line-height:1.65;max-height:320px;overflow:hidden}
  .emoji{width:1.15em;height:1.15em;vertical-align:-.2em}.grid{display:grid;gap:7px;margin-top:20px;border-radius:17px;overflow:hidden}
  .grid.count-1{grid-template-columns:1fr}.grid:not(.count-1){grid-template-columns:repeat(3,1fr)}
  .media{position:relative;min-height:180px;background:#e6e9ef}.count-1 .media{max-height:500px}
  .media>img{display:block;width:100%;height:100%;min-height:180px;max-height:500px;object-fit:cover}
  .play{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);display:grid;place-items:center;width:72px;height:72px;padding-left:5px;border-radius:50%;background:#0009;color:#fff;font-size:34px}
  .duration{position:absolute;right:9px;bottom:9px;padding:4px 8px;border-radius:7px;background:#000a;color:white;font-size:12px}
  .more{position:absolute;inset:0;display:grid;place-items:center;background:#0007;color:#fff;font-size:58px;font-weight:700}
  .graphics{display:flex;flex-direction:column;gap:16px;margin-top:20px}.graphic-text{font-size:18px;line-height:1.65}
  figure{margin:0;text-align:center}figure img{display:block;max-width:100%;max-height:720px;margin:auto;border-radius:13px;object-fit:contain}figcaption{margin-top:9px;color:#89919d;font-size:14px}
  .info{margin-top:18px;color:#89919d;font-size:14px}.repost{margin-top:20px}.nested.result{width:auto;padding:19px;border:1px solid #dfe3ea;box-shadow:none;background:#f9fafc}
  .nested .grid .media{min-height:120px}.nested .media>img{min-height:120px;max-height:300px}
  .stats{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px}.stats span{display:flex;gap:5px;align-items:baseline;padding:6px 10px;border-radius:9px;background:#f1f3f6}.stats small{color:#89919d}.stats b{font-size:14px}
  .rich-content{display:flex;flex-direction:column;gap:10px;margin-top:16px}.rich-text{font-size:17px;line-height:1.7}.rich-graphic{margin:0}.rich-graphic img{width:100%;max-height:none;border-radius:12px}.sticker{display:inline-block;object-fit:contain}.sticker.small{width:28px;height:28px}.sticker.medium{width:52px;height:52px}
  .link-card{display:flex;align-items:flex-start;overflow:hidden;border:1px solid #dfe3ea;border-radius:12px;background:#fff}.link-preview{display:block;width:160px;height:auto;max-height:240px;flex:0 0 auto;object-fit:contain;align-self:flex-start}.link-body{min-width:0;padding:12px}.link-source{display:flex;gap:6px;align-items:center;color:#7e8794;font-size:12px}.link-icon{width:18px;height:18px;border-radius:3px}.link-body p{margin:5px 0 0;color:#6f7782;font-size:13px}
  .quote-card{padding:12px 14px;border-radius:0 10px 10px 0;border-left:4px solid var(--primary);background:#f2f4f7}.quote-card>div{display:flex;gap:7px;align-items:center}.quote-card p{margin:8px 0 0;line-height:1.6}.quote-icon{width:24px;height:24px;border-radius:5px}
  .poll{padding:14px;border-radius:12px;background:#f3f5f8}.poll header{display:flex;justify-content:space-between}.poll-option{margin-top:10px}.poll-option>div{display:flex;justify-content:space-between}.poll-option i{display:block;height:5px;margin-top:5px;border-radius:5px;background:var(--primary)}.poll footer{margin-top:10px;color:#89919d;font-size:12px}
  .live-tag{position:absolute;left:8px;top:8px;padding:3px 7px;border-radius:5px;background:#0009;color:white;font-size:11px}.ai-summary{margin-top:16px;padding:14px;border-radius:12px;background:#eef6ff;line-height:1.6}.ai-summary b{display:block;margin-bottom:6px;color:#3979b7}
  .comments{margin-top:22px;padding-top:18px;border-top:1px solid #dfe3ea}.comments h2{font-size:18px}.comment{display:flex;gap:9px;margin-top:14px}.comment-avatar{width:34px;height:34px;border-radius:50%;object-fit:cover}.comment-main{min-width:0;flex:1}.comment-main header{display:flex;gap:7px;font-size:14px}.comment-main header small,.comment-main footer{color:#89919d;font-size:11px}.comment-main .rich-text{font-size:14px}.comment.reply{margin-left:6px;padding:8px;border-radius:9px;background:#f3f5f8}.source-footer{display:flex;justify-content:flex-end;align-items:center;gap:12px;margin-top:20px;color:#89919d;font-size:12px}.source-footer img{width:86px;height:86px}
  .htmlrender .stats span,.htmlrender .link-card,.htmlrender .quote-card,.htmlrender .poll,.htmlrender .comment.reply{background:#ffffff80}
  .result.night{color:#e8ecf2;background:linear-gradient(150deg,#1d2430,#111722)}.night .text,.night .rich-text{color:#dce2ea}.night .nested.result,.night .stats span,.night .link-card,.night .quote-card,.night .poll,.night .comment.reply{background:#252d3a;border-color:#394454}.night .link-body p,.night .quote-card p,.night .comment-main footer{color:#aeb8c5}.night .ai-summary{background:#1c344b;color:#dce8f4}
  .grid.count-2,.grid.count-4{grid-template-columns:repeat(2,1fr)}
  .grid.count-1 .media,.grid.count-1 .media>img{height:auto;max-height:none;min-height:0}
  .grid:not(.count-1) .media{aspect-ratio:1;min-height:0}.grid:not(.count-1) .media>img{height:100%;min-height:0;max-height:none}
  .grid.layout-x.count-3{grid-template-columns:repeat(2,1fr);grid-template-rows:180px 180px}.layout-x.count-3 .media:first-child{grid-row:span 2;aspect-ratio:auto}.layout-x.count-3 .media{aspect-ratio:auto}
  .rich-content .grid{margin-top:0}.comment .grid{max-width:320px}.comment .grid.count-1{max-width:180px}.comment .grid.count-1 .media>img{max-height:360px;object-fit:contain}.comment .media .play{width:36px;height:36px;font-size:18px}
  .author>div{min-width:0}.author small{white-space:pre-wrap;overflow-wrap:anywhere}.author-location{font-size:12px!important}.rich-text,.text{overflow-wrap:anywhere;white-space:normal}.text{max-height:none;overflow:visible}
  .translation{border-left-style:dashed}.translation p{white-space:normal}.audio-card{display:flex;gap:12px;align-items:center;padding:18px;background:#f1f3f6;border-radius:12px}.night .audio-card{background:#252d3a}.audio-card span{color:#89919d}
  </style></head><body>${body}</body></html>`
  try {
    if (selectedTheme.template) {
      const data = await buildThemeData(result, { colorScheme: themeName() === "day" ? "light" : "dark", themeId: selectedTheme.id })
      html = renderThemeTemplate(selectedTheme.template, data)
      if (!/<(?:html|body)\b/i.test(html)) html = '<!doctype html><html><head></head><body>' + html + '</body></html>'
    }
    const themeStyle = '<style>' + selectedTheme.css.replace(/<\/style/gi, "<\\/style") + '</style>'
    const base = selectedTheme.baseUrl ? '<base href="' + escapeHtml(selectedTheme.baseUrl) + '">' : ''
    const security = '<meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; img-src data: file: https:; style-src &#39;unsafe-inline&#39; file:; font-src data: file:; script-src &#39;none&#39;; connect-src &#39;none&#39;; frame-src &#39;none&#39;">'
    html = /<head\b[^>]*>/i.test(html) ? html.replace(/<head\b[^>]*>/i, match => match + base + security) : base + security + html
    html = /<\/head>/i.test(html) ? html.replace(/<\/head>/i, themeStyle + '</head>') : themeStyle + html
  } catch (error) {
    if (!forceBuiltin && selectedTheme.root) {
      log.warn("[parser] 自定义主题无效，已回退内置主题")
      return renderCard(result, mode, { forceBuiltin: true, format, event })
    }
    throw error
  }
  const allowedEmojiUrls = new Set(selectedTheme.root ? [] : [...html.matchAll(/<img class="emoji" src="([^"]+)"/g)].map(match => match[1].replace(/&amp;/g, "&")))
  // A JSON origin stays application/json with newer setContent implementations.
  // Establish a genuine HTML file document without changing browser security.
  const originUrl = pathToFileURL(path.join(resourcesDir, "render-origin.html")).href
  try {
    return await browserManager.withPage(event, async page => {
      await page.setJavaScriptEnabled(false)
      await page.setRequestInterception(true)
      let originPending = Boolean(selectedTheme.root)
      page.on("request", request => {
        void (async () => {
          const url = request.url()
          if (originPending && url === originUrl && request.isNavigationRequest?.()) {
            originPending = false
            return request.continue()
          }
          if (url.startsWith("data:") || url === "about:blank" || allowedEmojiUrls.has(url)) return request.continue()
          if (selectedTheme.root && url.startsWith("file:")) {
            const filename = fileURLToPath(url)
            const relative = path.relative(selectedTheme.root, filename).split(path.sep).join("/")
            if (await safeThemeFile(selectedTheme.root, relative)) return request.continue()
          }
          return request.abort()
        })().catch(() => { if (!request.isInterceptResolutionHandled?.()) void request.abort().catch(() => {}) })
      })
      await page.setViewport({ width: 800, height: 1200, deviceScaleFactor: 2 })
      if (selectedTheme.root) await page.goto(originUrl, { waitUntil: "domcontentloaded" })
      await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 30000 })
      await page.evaluate(async () => {
        const timeout = delay => new Promise(resolve => setTimeout(resolve, delay))
        const images = [...document.images].map(image => {
          if (image.complete) return Promise.resolve()
          return new Promise(resolve => {
            image.addEventListener("load", resolve, { once: true })
            image.addEventListener("error", resolve, { once: true })
          })
        })
        await Promise.race([Promise.all(images), timeout(8000)])
        if (document.fonts?.ready) {
          await Promise.race([document.fonts.ready, timeout(8000)])
        }
      })
      const selector = await page.$("main") ? "main" : ".result"
      const png = await captureLongCard(page, selector)
      let buffer = png
      let extension = ".png"
      if (format !== "png") {
        try {
          buffer = await ffmpeg.pngToWebp(png)
          extension = ".webp"
        } catch (error) {
          log.debug(`[parser] FFmpeg 渲染图压缩失败，保留 PNG: ${error.message}`)
        }
      }
      const digest = crypto.createHash("sha256").update(html).digest("hex")
      const target = path.join(cacheDir, `render-${digest}${extension}`)
      const temporary = temporaryCachePath(target)
      await cacheLifecycle.withActive([target, temporary], async () => {
        try {
          await fs.promises.writeFile(temporary, buffer)
          await fs.promises.rename(temporary, target)
        } finally { await fs.promises.unlink(temporary).catch(() => {}) }
      })
      result.renderImage = target
      renderKeys.set(result, renderKey)
      return target
    })
  } catch (error) {
    if (!forceBuiltin && selectedTheme.root) {
      log.warn("[parser] 自定义主题渲染失败，已回退内置主题")
      return renderCard(result, mode, { forceBuiltin: true, format, event })
    }
    throw error
  }
}

function plainContent(items) {
  const output = []
  for (const item of items || []) {
    if (typeof item === "string") output.push(item)
    else if (item instanceof GraphicContent && item.alt) output.push(item.alt)
    else if (item instanceof StickerContent && item.description) output.push(item.description)
    else if (item instanceof LinkContent) {
      output.push([item.siteName, item.title, item.description, item.url].filter(Boolean).join(" · "))
    } else if (item instanceof QuoteContent) {
      output.push([item.title, item.text, item.url].filter(Boolean).join("\n"))
    } else if (item instanceof PollContent) {
      const choices = item.options.map(option => option.text + " " + option.votes + "票").join(" / ")
      output.push((item.title || "投票") + ": " + choices)
    }
  }
  return output
}

async function defaultMessages(result) {
  const orderedText = result.content.length ? plainContent(result.content) : []
  const body = orderedText.length ? orderedText : [result.text]
  const texts = [result.header, ...body, result.aiSummary, result.extraInfo]
  if (config.parser_append_url) texts.push(result.displayUrl, result.repostDisplayUrl)
  if (config.parser_embed_url && result.embedUrl) texts.push("播放: " + result.embedUrl)
  const filtered = texts.filter(Boolean)
  const messages = filtered.map((text, index) =>
    index < filtered.length - 1 ? `${text}\n` : text,
  )
  if (result.video?.cover && !result.video.cover.requiresMedia) {
    const cover = await result.video.cover.safeGet()
    if (cover) messages.splice(1, 0, await imageSegment(cover))
  }
  return messages
}

export async function renderAndSend(e, result, options = {}) {
  let type = config.parser_render_type
  if (type === "htmlkit") {
    log.warn("[parser] htmlkit 渲染器尚未实现，已回退到 common")
    type = "common"
  }
  let message, card = null
  if (type === "default") message = await defaultMessages(result)
  else {
    try {
      // QQ/OneBot rich-media upload is not consistently compatible with WebP.
      // Keep renderCard's public auto/WebP mode, but send bot summary cards as PNG.
      card = await renderCard(result, type, { event: e, format: "png" })
      const cardSegment = (await fs.promises.stat(card)).size >= 5 * 1024 * 1024 ? await fileSegment(card) : await imageSegment(card)
      message = [markMediaRole(cardSegment, "summary")]
      if (config.parser_append_url) {
        const urls = [result.displayUrl, result.repostDisplayUrl].filter(Boolean)
        if (urls.length) message.push(urls.join("\n"))
      }
      if (config.parser_embed_url && result.embedUrl) message.push("播放: " + result.embedUrl)
    } catch (error) {
      browserManager.reportFailure(error)
      message = await defaultMessages(result)
    }
  }
  await cacheLifecycle.withActive(card ? [card] : [], async () => {
    if (config.parser_summary_in_forward && options.sendContents !== false) {
      await renderContents(e, result, { summaryNode: message })
      return
    }
    const total = message.filter(item => typeof item === "string").join("").length
    if (total > config.parser_forward_text_threshold) await sendForward(e, message, result)
    else await e.reply(message)
    if (options.sendContents !== false) await renderContents(e, result)
  })
}

export async function closeRenderer() {
  await browserManager.close()
}
