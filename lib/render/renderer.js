import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"

import emojiRegex from "emoji-regex"

import { config, customFontPath } from "../core/config.js"
import { cacheDir, resourcesDir } from "../core/paths.js"
import { ImageContent, VideoContent } from "../core/model.js"
import { imageSegment, makeForward, renderContents } from "../core/sender.js"
import { log } from "../core/logger.js"

let browserPromise = null

function browserExecutable() {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.ProgramFiles
      ? path.join(process.env.ProgramFiles, "Google", "Chrome", "Application", "chrome.exe")
      : null,
    process.env["ProgramFiles(x86)"]
      ? path.join(
          process.env["ProgramFiles(x86)"],
          "Microsoft",
          "Edge",
          "Application",
          "msedge.exe",
        )
      : null,
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean)
  return candidates.find(candidate => fs.existsSync(candidate))
}

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
  if (ext === ".ttf") return "font/ttf"
  return "image/jpeg"
}

async function dataUri(filePath) {
  const data = await fs.promises.readFile(filePath)
  return `data:${mimeOf(filePath, data)};base64,${data.toString("base64")}`
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
  if (content instanceof VideoContent) {
    play = true
    filePath = await content.cover?.safeGet()
    if (!filePath) {
      const fallback = 1 + Math.floor(Math.random() * 9)
      filePath = path.join(resourcesDir, "fallback_pic", `${fallback}.jpg`)
    }
  } else {
    filePath = await content.pathTask.safeGet()
  }
  if (!filePath) return null
  return { source: await dataUri(filePath), play, duration: content.displayDuration }
}

async function resultView(result, mode, nested = false) {
  const logoPath = path.join(resourcesDir, `${result.platform.name}.png`)
  const logo = fs.existsSync(logoPath) ? await dataUri(logoPath) : null
  const avatarPath = await result.author?.avatar?.safeGet()
  const avatar = await dataUri(
    avatarPath && fs.existsSync(avatarPath) ? avatarPath : path.join(resourcesDir, "avatar.png"),
  )
  const media = []
  for (const item of result.gridMedias) {
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
  <section class="result ${mode} ${nested ? "nested" : ""}" data-platform="${escapeHtml(result.platform.name)}">
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
          }</div></div>`
        : ""
    }
    ${result.title ? `<h1>${renderEmoji(result.title)}</h1>` : ""}
    ${result.text ? `<div class="text">${renderEmoji(result.text).replace(/\n/g, "<br>")}</div>` : ""}
    ${
      visibleMedia.length
        ? `<div class="grid count-${Math.min(visibleMedia.length, 9)}">${visibleMedia
            .map(
              (item, index) => `<div class="media"><img src="${item.source}">${
                item.play ? '<span class="play">▶</span>' : ""
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
    ${info ? `<div class="info">${renderEmoji(info)}</div>` : ""}
    ${result.repost ? `<div class="repost">${await resultView(result.repost, mode, true)}</div>` : ""}
  </section>`
}

async function browser() {
  if (!browserPromise) {
    const executablePath = browserExecutable()
    browserPromise = import("puppeteer")
      .then(({ default: puppeteer }) =>
        puppeteer.launch({
        headless: true,
          ...(executablePath ? { executablePath } : {}),
          args: ["--no-sandbox", "--disable-setuid-sandbox", "--ignore-certificate-errors"],
        }),
      )
      .catch(error => {
        browserPromise = null
        throw error
      })
  }
  return browserPromise
}

async function renderCard(result, mode) {
  if (result.renderImage && fs.existsSync(result.renderImage)) return result.renderImage
  await result.ensureDownloadsComplete({ imgOnly: true, suppressErrors: true })
  const fontPath = customFontPath() || path.join(resourcesDir, "HYSongYunLangHeiW.ttf")
  const font = await dataUri(fontPath)
  const body = await resultView(result, mode)
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
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
  </style></head><body>${body}</body></html>`
  const page = await (await browser()).newPage()
  try {
    await page.setViewport({ width: 800, height: 1200, deviceScaleFactor: 1 })
    await page.setContent(html, { waitUntil: "networkidle0", timeout: 60000 })
    const element = await page.$(".result")
    const buffer = await element.screenshot({ type: "png" })
    const target = path.join(cacheDir, `${crypto.randomBytes(16).toString("hex")}.png`)
    await fs.promises.writeFile(target, buffer)
    result.renderImage = target
    return target
  } finally {
    await page.close()
  }
}

async function sendDefault(e, result) {
  const texts = [result.header, result.text, result.extraInfo]
  if (config.parser_append_url) texts.push(result.displayUrl, result.repostDisplayUrl)
  const filtered = texts.filter(Boolean)
  const messages = filtered.map((text, index) =>
    index < filtered.length - 1 ? `${text}\n` : text,
  )
  if (result.video?.cover) {
    const cover = await result.video.cover.safeGet()
    if (cover) messages.splice(1, 0, await imageSegment(cover))
  }
  const total = filtered.reduce((sum, text) => sum + text.length, 0)
  await e.reply(total > 300 ? await makeForward(e, messages) : messages)
}

export async function renderAndSend(e, result) {
  let type = config.parser_render_type
  if (type === "htmlkit") {
    log.warn("[parser] htmlkit 渲染器尚未实现，已回退到 common")
    type = "common"
  }
  if (type === "default") {
    await sendDefault(e, result)
  } else {
    try {
      const card = await renderCard(result, type)
      const message = [await imageSegment(card)]
      if (config.parser_append_url) {
        const urls = [result.displayUrl, result.repostDisplayUrl].filter(Boolean)
        if (urls.length) message.push(urls.join("\n"))
      }
      await e.reply(message)
    } catch (error) {
      log.warn("[parser] Puppeteer 卡片渲染失败，回退到 default", error)
      await sendDefault(e, result)
    }
  }
  await renderContents(e, result)
}

export async function closeRenderer() {
  if (!browserPromise) return
  try {
    await (await browserPromise).close()
  } finally {
    browserPromise = null
  }
}
