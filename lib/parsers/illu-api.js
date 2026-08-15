import crypto from "node:crypto"
import * as cheerio from "cheerio"

import { http } from "../core/http.js"
import { unpackIlluPackage } from "./codec.js"
import { OpenGraphParser, cleanText } from "./shared.js"

const API_ORIGIN = "https://api.illund.com"
const NONCE_CHARS = "ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678"

function nonce() {
  let value = ""
  for (let index = 0; index < 16; index += 1) {
    value += NONCE_CHARS[crypto.randomInt(0, NONCE_CHARS.length)]
  }
  return value
}

function signedHeaders(path) {
  const secret = process.env.ILLU_BMOB_SECRET_KEY
  if (!secret) throw new Error("ILLU_BMOB_SECRET_KEY is not configured")
  const timestamp = String(Math.floor(Date.now() / 1000))
  const noncestr = nonce()
  const sign = crypto.createHash("md5").update(path + timestamp + "350704" + noncestr).digest("hex")
  return {
    "X-Bmob-SDK-Type": "API",
    "X-Bmob-Safe-Timestamp": timestamp,
    "X-Bmob-Noncestr-Key": noncestr,
    "X-Bmob-Safe-Sign": sign,
    "X-Bmob-Secret-Key": secret,
  }
}

function decodeResult(value) {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

async function call(path, body) {
  const payload = await http.json(API_ORIGIN + path, {
    method: "POST",
    headers: signedHeaders(path),
    body,
  })
  return decodeResult(payload.result)
}

function time(value) {
  const raw = value?.iso || value
  if (!raw) return null
  const parsed = Date.parse(String(raw).replace(" ", "T") + (String(raw).includes("T") ? "" : "+08:00"))
  return Number.isNaN(parsed) ? null : Math.floor(parsed / 1000)
}

function author(parser, value) {
  return parser.createAuthor(value?.nickname || "", value?.headerImage?.url, value?.words, {}, {
    id: value?.objectId,
  })
}

async function articleContent(detail) {
  const fallback = [cleanText(detail?.description)].filter(Boolean)
  if (!detail?.contentFile?.url) return fallback
  try {
    const files = unpackIlluPackage(await http.buffer(detail.contentFile.url))
    const expected = String(detail.contentFile.filename || "").replace(/_html\.zip$/i, "_html.html")
    const entry = files[expected] || Object.entries(files).find(([name]) => name.toLowerCase().endsWith(".html"))?.[1]
    if (typeof entry !== "string") return fallback
    const $ = cheerio.load(entry)
    const lines = cleanText($.root().text()).split("\n").map(line => line.trim()).filter(Boolean)
    if (lines.length > 1 && lines[0] === detail.title) lines.shift()
    return lines.length ? lines : fallback
  } catch {
    return fallback
  }
}

function buildComment(parser, value) {
  const node = parser.createComment({
    author: author(parser, value.author),
    content: [cleanText(value.content)].filter(Boolean),
    timestamp: time(value.createdAt),
    stats: parser.createStats({ likeCount: value.likeCount, commentCount: value.subCommentCount }),
  })
  node.replies = (value.subCommentList || []).map(item => buildComment(parser, item))
  return node
}

async function comments(parser, objectId, bizType) {
  try {
    const value = await call("/1/functions/getCommonCommentList", {
      mainId: objectId, page: 1, orderType: 2, bizType,
    })
    return (value?.results || []).slice(0, 20).map(item => buildComment(parser, item))
  } catch {
    return []
  }
}

function extractIds(url) {
  let decoded = String(url)
  for (let index = 0; index < 3; index += 1) {
    try {
      const next = decodeURIComponent(decoded)
      if (next === decoded) break
      decoded = next
    } catch {
      break
    }
  }
  return {
    articleId: /articleId=([0-9a-z]+)/i.exec(decoded)?.[1],
    mainId: /mainid=([0-9a-z]+)/i.exec(decoded)?.[1],
  }
}

export class IlluApiParser extends OpenGraphParser {
  static platform = { name: "illu", displayName: "ILLU" }
  static handlers = [{ keyword: "illund.com/share.html", pattern: /illund\.com\/share\.html\?[^\s<]+/i, method: "parse" }]

  async parse(match) {
    const ids = extractIds(match[0])
    try {
      if (ids.articleId) return await this.parseArticle(ids.articleId)
      if (ids.mainId) return await this.parseDrawing(ids.mainId)
      return super.parse(match)
    } catch {
      return super.parse(match)
    }
  }

  async parseArticle(id) {
    const value = await call("/1/functions/getArticleByIdV2", { articleId: id })
    const detail = value?.dataObject || value
    const content = await articleContent(detail)
    return this.result({
      title: cleanText(detail.title), author: author(this, detail.author), content,
      text: content.filter(item => typeof item === "string").join("\n"),
      timestamp: time(detail.publishDate),
      url: "https://illund.com/share.html?al=mindlib%3A%2F%2Freactbox%2F%3FarticleId%3D" + id,
      stats: this.createStats({
        viewCount: detail.readCount, likeCount: detail.thumbUpCount,
        commentCount: detail.commentCount, extra: { rewardCoin: detail.rewardCoin },
      }),
      comments: await comments(this, id, 1),
    })
  }

  async parseDrawing(id) {
    const detail = await call("/1/functions/getDrawingDetail", { mainId: id })
    const content = [cleanText(detail.content), ...(detail.images || []).map(image => this.createGraphic(image.url))].filter(Boolean)
    return this.result({
      title: cleanText(detail.title), author: author(this, detail.author), content,
      text: cleanText(detail.content), timestamp: time(detail.publishDate),
      url: "https://illund.com/share.html?al=mindlib%3A%2F%2Freactbox%2F%3Fmainid%3D" + id,
      stats: this.createStats({
        viewCount: detail.readCount, likeCount: detail.likeCount,
        collectCount: detail.collectCount, commentCount: detail.commentCount,
        extra: { rewardCoin: detail.rewardCoin },
      }),
      comments: await comments(this, id, 4),
    })
  }
}
