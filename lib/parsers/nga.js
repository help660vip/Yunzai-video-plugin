import { load } from "cheerio"

import { BaseParser } from "../core/registry.js"
import { ParseError } from "../core/errors.js"
import { http } from "../core/http.js"
import { sleep } from "../core/utils.js"

function textLines(element) {
  const lines = []
  const visit = node => {
    if (node?.type === "text") {
      for (const part of String(node.data || "").split(/\r?\n/)) {
        const text = part.trim()
        if (text) lines.push(text)
      }
      return
    }
    for (const child of node?.children || []) visit(child)
  }
  visit(element)
  return lines
}

export class NgaParser extends BaseParser {
  static platform = { name: "nga", displayName: "NGA" }
  static handlers = [
    {
      keyword: "nga",
      pattern: /tid=(?<tid>\d+)/,
      method: "parse",
    },
  ]

  constructor() {
    super()
    this.headers = {
      Referer: "https://nga.178.com/",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      "Accept-Encoding": "gzip, deflate",
      Connection: "keep-alive",
      "Upgrade-Insecure-Requests": "1",
    }
  }

  async parse(match) {
    const url = `https://nga.178.com/read.php?tid=${match.groups.tid}`
    let response = await http.request(url, {
      headers: this.headers,
      allowError: true,
    })
    let html = await response.text()
    if (response.status === 403 && html.includes("guestJs")) {
      const cookie = /document\.cookie\s*=\s*['"]guestJs=([^;'"]+)/.exec(html)?.[1]
      if (cookie) {
        await sleep(300)
        response = await http.request(`${url}&rand=${Math.floor(Math.random() * 1000)}`, {
          headers: { ...this.headers, cookie: `guestJs=${cookie}` },
          allowError: true,
        })
        html = await response.text()
      }
    }
    if (response.status !== 200) throw new ParseError(`无法获取页面, HTTP ${response.status}`)
    if (html.includes("需要") && (html.includes("登录") || html.includes("请登录"))) {
      throw new ParseError("页面可能需要登录后访问")
    }
    const $ = load(html)
    const result = this.result({ url })
    result.title = $("#postsubject0").first().text().trim() || null

    const href = $("#postauthor0").first().attr("href") || ""
    const uid = /[?&]uid=(\d+)/.exec(href)?.[1]
    const usersRaw = /commonui\.userInfo\.setAll\s*\(\s*(\{.*?\})\s*\)/s.exec(html)?.[1]
    if (uid && usersRaw) {
      try {
        const name = JSON.parse(usersRaw)?.[uid]?.username
        if (name) result.author = this.createAuthor(name)
      } catch {}
    }

    const timeText = $("#postdate0").first().text().trim()
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(timeText)) {
      result.timestamp = Math.floor(new Date(timeText.replace(" ", "T")).getTime() / 1000)
    }
    const content = $("#postcontent0").first()[0]
    for (const line of textLines(content)) {
      if (line.includes("[")) {
        const images = [...line.matchAll(/\[img\]\.(.*?)\[\/img\]/g)]
        if (images.length) {
          for (const image of images) {
            result.graphics.push(
              this.createImage(`https://img.nga.178.com/attachments${image[1]}`),
            )
          }
        } else {
          const clean = line.replace(/\[[^\]]*?\]/g, "").trim()
          if (clean) result.graphics.push(clean)
        }
      } else {
        result.graphics.push(line)
      }
    }
    return result
  }
}
