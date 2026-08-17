import crypto from "node:crypto"
import zlib from "node:zlib"
import * as cheerio from "cheerio"

import { config } from "../core/config.js"
import { ParseError } from "../core/errors.js"
import { http } from "../core/http.js"
import { OpenGraphParser, cleanText } from "./shared.js"

const BASE_URL = "https://api.xiaoheihe.cn"
const API_PATH = "/bbs/app/link/tree"
const DEVICE_API = "https://fp-it.portal101.cn/deviceprofile/v4"
const PUBLIC_KEY =
  "MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCXj9exmI4nQjmT52iwr+yf7hAQ06bfSZHTAHUfRBYiagCf/whhd8es0R79wBigpiHLd28TKA8b8mGR8OiiI1hV+qfynCWihvp3mdj8MiiH6SU3lhro2hkfYzImZB0RmWr2zE4Xt1+A6Oyp6bf+W7JSxYUXHw3nNv7Td4jw4jEFKQIDAQAB"
const ORGANIZATION = "0yD85BjYvGFAvHaSQ1mc"
const APP_ID = "heybox_website"

const DES_RULE = Object.freeze({
  appId: ["uy7mzc4h", "xx"],
  box: [null, "jf"],
  canvas: ["snrn887t", "yk"],
  clientSize: ["cpmjjgsu", "zx"],
  organization: ["78moqjfc", "dp"],
  os: ["je6vk6t4", "pj"],
  platform: ["pakxhcd2", "gm"],
  plugins: ["v51m3pzl", "kq"],
  pmf: ["2mdeslu3", "vw"],
  protocol: [null, "protocol"],
  referer: ["y7bmrjlc", "ab"],
  res: ["whxqm2a7", "hf"],
  rtype: ["x8o2h2bl", "lo"],
  sdkver: ["9q3dcxp2", "sc"],
  status: ["2jbrxxw4", "an"],
  subVersion: ["eo3i2puh", "ns"],
  svm: ["fzj3kaeh", "qr"],
  time: ["q2t3odsk", "nb"],
  timezone: ["1uv05lj5", "as"],
  tn: ["x9nzj1bp", "py"],
  trees: ["acfs0xo4", "pi"],
  ua: ["k92crp1t", "bj"],
  url: ["y95hjkoo", "cf"],
  version: [null, "version"],
  vpw: ["r9924ab5", "ca"],
})

function md5(value, upper = false) {
  const digest = crypto.createHash("md5").update(value).digest("hex")
  return upper ? digest.toUpperCase() : digest
}

function nonce(time) {
  return md5(String(time), true)
}

function vm(value) {
  return value & 0x80 ? ((value << 1) & 0xff) ^ 27 : (value << 1) & 0xff
}

function qm(value) {
  return vm(value) ^ value
}

function mm(value) {
  return qm(vm(value))
}

function ym(value) {
  return mm(qm(vm(value)))
}

function gm(value) {
  return ym(value) ^ mm(value) ^ qm(value)
}

function km(values) {
  return [
    gm(values[0]) ^ ym(values[1]) ^ mm(values[2]) ^ qm(values[3]),
    qm(values[0]) ^ gm(values[1]) ^ ym(values[2]) ^ mm(values[3]),
    mm(values[0]) ^ qm(values[1]) ^ gm(values[2]) ^ ym(values[3]),
    ym(values[0]) ^ mm(values[1]) ^ qm(values[2]) ^ gm(values[3]),
    ...values.slice(4),
  ]
}

function av(value, table, end) {
  const source = table.slice(0, end)
  return source ? [...value].map(char => source[char.codePointAt(0) % source.length]).join("") : ""
}

function sv(value, table) {
  return [...value].map(char => table[char.codePointAt(0) % table.length]).join("")
}

function interleave(items) {
  const output = []
  const max = Math.max(...items.map(item => item.length))
  for (let index = 0; index < max; index += 1) {
    for (const item of items) if (index < item.length) output.push(item[index])
  }
  return output.join("")
}

function hkey(time) {
  const table = "AB45STUVWZEFGJ6CH01D237IXYPQRKLMN89"
  const normalized = "/" + API_PATH.split("/").filter(Boolean).join("/") + "/"
  const mixed = interleave([
    av(String(time + 1), table, -2),
    sv(normalized, table),
    sv(nonce(time), table),
  ]).slice(0, 20)
  const digest = md5(mixed)
  const sum = km([...digest.slice(-6)].map(char => char.codePointAt(0)))
    .reduce((total, value) => total + value, 0) % 100
  return av(digest.slice(0, 5), table, -4) + String(sum).padStart(2, "0")
}

function buildUrl(linkId, time = Math.floor(Date.now() / 1000)) {
  const url = new URL(BASE_URL + API_PATH)
  for (const [key, value] of Object.entries({
    os_type: "web",
    app: "heybox",
    client_type: "web",
    version: "999.0.4",
    _time: time,
    nonce: nonce(time),
    hkey: hkey(time),
    link_id: linkId,
    page: 1,
    index: 1,
    limit: 5,
    x_client_type: "weboutapp",
    x_app: "heybox_website",
    x_os_type: "Windows",
    web_version: "2.5",
  })) {
    url.searchParams.set(key, value)
  }
  return url.href
}

function zeroPad(buffer, blockSize) {
  const remainder = buffer.length % blockSize
  return remainder ? Buffer.concat([buffer, Buffer.alloc(blockSize - remainder)]) : buffer
}

function desEncrypt(value, key) {
  const cipher = crypto.createCipheriv("des-ede3", Buffer.from(key.repeat(3)), null)
  cipher.setAutoPadding(false)
  return Buffer.concat([
    cipher.update(zeroPad(Buffer.from(String(value)), 8)),
    cipher.final(),
  ]).toString("base64")
}

function desObject(value) {
  const result = {}
  for (const [key, item] of Object.entries(value)) {
    const rule = DES_RULE[key]
    if (!rule) result[key] = item
    else result[rule[1]] = rule[0] ? desEncrypt(item, rule[0]) : item
  }
  return result
}

function tnValue(value) {
  return Object.keys(value).sort().map(key => {
    const item = value[key]
    if (typeof item === "number") return String(item * 10000)
    if (item && typeof item === "object" && !Array.isArray(item)) return tnValue(item)
    return String(item)
  }).join("")
}

function smid() {
  const now = new Date()
  const digits = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join("")
  const value = digits + md5(crypto.randomUUID()) + "00"
  return value + md5("smsk_web_" + value).slice(0, 14) + "0"
}

function smPayload() {
  const uuid = Buffer.from(crypto.randomUUID())
  const privateId = md5(uuid).slice(0, 16)
  const publicKey = crypto.createPublicKey({
    key: Buffer.from(PUBLIC_KEY, "base64"),
    format: "der",
    type: "spki",
  })
  const ep = crypto.publicEncrypt(
    { key: publicKey, padding: crypto.constants.RSA_PKCS1_PADDING },
    uuid,
  ).toString("base64")
  const current = Date.now()
  const browser = {
    plugins:
      "MicrosoftEdgePDFPluginPortableDocumentFormatinternal-pdf-viewer1,MicrosoftEdgePDFViewermhjfbmdgcfjbbpaeojofohoefgiehjai1",
    ua:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36 Edg/146.0.0.0",
    canvas: crypto.randomBytes(4).toString("hex"),
    timezone: -480,
    platform: "Win32",
    url: "https://www.xiaoheihe.cn/",
    referer: "",
    res: "1920_1080_24_1.25",
    clientSize: "0_0_1080_1920_1920_1080_1920_1080",
    status: "0011",
    vpw: crypto.randomUUID(),
    svm: current,
    trees: crypto.randomUUID(),
    pmf: current,
  }
  const target = {
    ...browser,
    protocol: 102,
    organization: ORGANIZATION,
    appId: APP_ID,
    os: "web",
    version: "3.0.0",
    sdkver: "3.0.0",
    box: "",
    rtype: "all",
    smid: smid(),
    subVersion: "1.0.0",
    time: 0,
  }
  target.tn = md5(tnValue(target))
  const compressed = zlib.gzipSync(Buffer.from(JSON.stringify(desObject(target))), {
    level: 2,
    mtime: 0,
  }).toString("base64")
  const plaintext = zeroPad(Buffer.concat([Buffer.from(compressed), Buffer.from([0])]), 16)
  const cipher = crypto.createCipheriv(
    "aes-128-cbc",
    Buffer.from(privateId),
    Buffer.from("0102030405060708"),
  )
  cipher.setAutoPadding(false)
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]).toString("hex")
  return {
    appId: APP_ID,
    compress: 2,
    data,
    encode: 5,
    ep,
    organization: ORGANIZATION,
    os: "web",
  }
}

function avatarUrl(user = {}) {
  const value = user.avatar || user.avatar_url || null
  if (
    value &&
    value.includes("?") &&
    !value.endsWith(">") &&
    !value.toLowerCase().endsWith("%3e")
  ) {
    return value + "\\"
  }
  return value
}

function imageUrl(value) {
  return value ? value + "\\" : value
}

function stickerContent(parser, value) {
  const output = []
  const text = String(value || "")
  let cursor = 0
  for (const match of text.matchAll(/\[([^\]]+)\]/g)) {
    if (match.index > cursor) output.push(text.slice(cursor, match.index))
    output.push(
      parser.createSticker(
        `https://sticker.sokoko.org/assets/heybox/${encodeURIComponent(match[1])}.webp`,
        match[1].includes("bigemoji") ? "medium" : "small",
        match[1],
        { cacheKey: "sticker:heybox:" + match[1] },
      ),
    )
    cursor = match.index + match[0].length
  }
  if (cursor < text.length) output.push(text.slice(cursor))
  return output.filter(Boolean)
}

function htmlContent(parser, html) {
  const $ = cheerio.load("<div id=parser-root>" + (html || "") + "</div>")
  const output = []
  let buffer = ""
  const flush = () => {
    const text = cleanText(buffer)
    if (text) output.push(text)
    buffer = ""
  }
  const walk = node => {
    if (node.type === "text") {
      buffer += node.data || ""
      return
    }
    if (node.type !== "tag") return
    const element = $(node)
    if (node.name === "noscript") return
    if (node.name === "img") {
      const src =
        element.attr("data-original") ||
        element.attr("data-actualsrc") ||
        element.attr("data-default-watermark-src") ||
        element.attr("src")
      if (src) {
        flush()
        output.push(parser.createGraphic(src, element.attr("alt")))
      }
      return
    }
    for (const child of node.children || []) walk(child)
    if (["p", "div", "br", "li"].includes(node.name)) buffer += "\n"
  }
  for (const child of $("#parser-root").get(0)?.children || []) walk(child)
  flush()
  return output
}

export class HeyboxApiParser extends OpenGraphParser {
  static platform = { name: "heybox", displayName: "小黑盒" }
  static handlers = [
    {
      keyword: "api.xiaoheihe.cn/v3/bbs/app/api/web/share",
      pattern: /api\.xiaoheihe\.cn\/v3\/bbs\/app\/api\/web\/share[^\s<]*[?&]link_id=([A-Za-z0-9]+)/i,
      method: "parse",
    },
    {
      keyword: "xiaoheihe.cn/bbs/post_share",
      pattern: /(?:www\.)?xiaoheihe\.cn\/bbs\/post_share[^\s<]*[?&]link_id=([A-Za-z0-9]+)/i,
      method: "parse",
    },
    {
      keyword: "xiaoheihe.cn/app/bbs",
      pattern: /(?:www\.)?xiaoheihe\.cn\/app\/bbs\/link\/([A-Za-z0-9]+)/i,
      method: "parse",
    },
  ]

  constructor() {
    super()
    this.headers = {
      ...this.headers,
      referer: "https://www.xiaoheihe.cn/",
      origin: "https://www.xiaoheihe.cn",
      accept: "application/json, text/plain, */*",
    }
    this.deviceId = ""
    this.deviceTask = null
  }

  async ensureDevice() {
    if (this.deviceId) return this.deviceId
    if (this.deviceTask) return this.deviceTask
    this.deviceTask = (async () => {
      const result = await http.json(DEVICE_API, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: smPayload(),
      })
      if (Number(result?.code) !== 1100 || !result?.detail?.deviceId) {
        throw new ParseError("小黑盒设备凭证获取失败")
      }
      this.deviceId = "B" + result.detail.deviceId
      return this.deviceId
    })().finally(() => {
      this.deviceTask = null
    })
    return this.deviceTask
  }

  buildLinkContent(link, cacheKey) {
    const output = []
    try {
      const parts = JSON.parse(link.text || "[]")
      for (const part of parts) {
        if (part.type === "html") {
          output.push(...htmlContent(this, part.text))
          break
        }
        if (part.type === "text") output.push(...stickerContent(this, part.text))
        else if (part.type === "img" && part.live_url) {
          output.push(
            this.createLivePhoto(part.live_url, imageUrl(part.url), null, 1, {
              cacheKey: cacheKey + ":live:" + output.length,
            }),
          )
        } else if (part.type === "img" && part.url) {
          output.push(this.createImage(imageUrl(part.url)))
        }
      }
    } catch {
      if (link.text) output.push(link.text)
    }
    if (link.has_video && link.video_url) {
      output.push(this.createVideo(link.video_url, link.video_thumb, null, { cacheKey }))
    }
    return output
  }

  buildComment(item) {
    const content = stickerContent(this, item.text)
    for (const image of item.imgs || []) {
      if (image.url) content.push(this.createImage(imageUrl(image.url)))
    }
    if (item.is_cy) {
      content.push(
        this.createSticker(
          "https://sticker.sokoko.org/assets/heybox/cy.webp",
          "small",
          "插眼",
          { cacheKey: "sticker:heybox:cy" },
        ),
      )
    }
    return this.createComment({
      author: this.createAuthor(
        item.user?.username || "",
        avatarUrl(item.user),
        null,
        this.headers,
        { id: item.user?.userid, location: item.ip_location },
      ),
      content,
      timestamp: item.create_at,
      stats: this.createStats({ likes: item.up, comments: item.child_num }),
    })
  }

  collect(payload, linkId) {
    if (payload?.status !== "ok" || !payload?.result?.link) {
      throw new ParseError("小黑盒接口未返回帖子")
    }
    const data = payload.result
    const link = data.link
    const comments = []
    for (const wrapper of (data.comments || []).slice(0, config.parser_max_comments)) {
      const items = wrapper.comment || []
      if (!items.length) continue
      const root = this.buildComment(items[0])
      root.replies.push(...items.slice(1).map(item => this.buildComment(item)))
      comments.push(root)
    }
    return this.result({
      contentId: linkId,
      title: link.title,
      text: link.description,
      content: this.buildLinkContent(link, "heybox:" + linkId),
      timestamp: link.create_at,
      url: `https://www.xiaoheihe.cn/app/bbs/link/${linkId}`,
      author: this.createAuthor(
        link.user?.username || "",
        avatarUrl(link.user),
        null,
        this.headers,
        { id: link.user?.userid, location: link.ip_location },
      ),
      comments,
      stats: this.createStats({
        views: link.click,
        likes: link.link_award_num,
        comments: link.comment_num,
        shares: link.forward_num,
        collects: link.favour_count,
        extra: { battery: link.battery?.count },
      }),
    })
  }

  async parse(match) {
    const linkId = match[1]
    try {
      const deviceId = await this.ensureDevice()
      const payload = await http.json(buildUrl(linkId), {
        headers: this.headers,
        cookies: { x_xhh_tokenid: deviceId },
      })
      return this.collect(payload, linkId)
    } catch (error) {
      if (error instanceof ParseError && error.message.includes("未返回帖子")) throw error
      return super.parse(match)
    }
  }
}

export const heyboxInternals = { buildUrl, hkey, nonce, smPayload }
