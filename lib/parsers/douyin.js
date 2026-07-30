import { BaseParser } from "../core/registry.js"
import { ParseError } from "../core/errors.js"
import { http } from "../core/http.js"
import { IOS_HEADERS, ANDROID_HEADERS, pickUrl, randomChoice } from "../core/utils.js"
import { log } from "../core/logger.js"

function videoDataFromRouter(data) {
  const loader = data?.loaderData || {}
  const page = loader["video_(id)/page"] || loader["note_(id)/page"]
  const items = page?.videoInfoRes?.item_list || []
  if (!items.length) throw new ParseError("can't find data in videoInfoRes")
  return randomChoice(items)
}

function avatarUrl(author = {}) {
  return pickUrl(author.avatar_thumb) || pickUrl(author.avatar_medium)
}

export class DouyinParser extends BaseParser {
  static platform = { name: "douyin", displayName: "抖音" }
  static handlers = [
    {
      keyword: "v.douyin",
      pattern: /v\.douyin\.com\/[a-zA-Z0-9_-]+/,
      method: "parseShort",
    },
    {
      keyword: "jx.douyin",
      pattern: /jx\.douyin\.com\/[a-zA-Z0-9_-]+/,
      method: "parseShort",
    },
    {
      keyword: "douyin",
      pattern: /douyin\.com\/(?<ty>video|note)\/(?<vid>\d+)/,
      method: "parseCommon",
    },
    {
      keyword: "iesdouyin",
      pattern: /iesdouyin\.com\/share\/(?<ty>slides|video|note)\/(?<vid>\d+)/,
      method: "parseCommon",
    },
    {
      keyword: "m.douyin",
      pattern: /m\.douyin\.com\/share\/(?<ty>slides|video|note)\/(?<vid>\d+)/,
      method: "parseCommon",
    },
    {
      keyword: "jingxuan.douyin",
      pattern: /jingxuan\.douyin\.com\/m\/(?<ty>slides|video|note)\/(?<vid>\d+)/,
      method: "parseCommon",
    },
  ]

  constructor() {
    super()
    this.headers = { ...IOS_HEADERS }
  }

  async parseShort(match) {
    return this.parseWithRedirect(`https://${match[0]}`)
  }

  async parseCommon(match) {
    const { ty, vid } = match.groups
    if (ty === "slides") return this.parseSlides(vid)
    for (const url of [
      `https://m.douyin.com/share/${ty}/${vid}`,
      `https://www.iesdouyin.com/share/${ty}/${vid}`,
    ]) {
      try {
        return await this.parseVideoPage(url)
      } catch (error) {
        log.warn(`[parser] failed to parse ${url}: ${error.message}`)
      }
    }
    throw new ParseError("分享已删除或资源直链提取失败, 请稍后再试")
  }

  async parseVideoPage(url) {
    const response = await http.request(url, {
      headers: IOS_HEADERS,
      redirect: "manual",
      allowError: true,
      verify: false,
    })
    if (response.status !== 200) throw new ParseError(`status: ${response.status}`)
    const html = await response.text()
    const matched = /window\._ROUTER_DATA\s*=\s*(.*?)<\/script>/s.exec(html)
    if (!matched?.[1]) throw new ParseError("can't find _ROUTER_DATA in html")
    const data = videoDataFromRouter(JSON.parse(matched[1].trim()))
    const author = this.createAuthor(data.author?.nickname || "", avatarUrl(data.author))
    const result = this.result({
      title: data.desc,
      author,
      timestamp: data.create_time,
    })
    if (data.images?.length) {
      result.contents.push(
        ...this.createImages(
          data.images.map(image => pickUrl(image.url_list)).filter(Boolean),
          IOS_HEADERS,
        ),
      )
    } else if (data.video) {
      const videoUrl = pickUrl(data.video.play_addr)?.replace("playwm", "play")
      if (videoUrl) {
        result.video = this.createVideo(
          videoUrl,
          pickUrl(data.video.cover),
          Math.floor(Number(data.video.duration || 0) / 1000),
          { headers: IOS_HEADERS },
        )
      }
    }
    return result
  }

  async parseSlides(videoId) {
    const url = new URL("https://www.iesdouyin.com/web/api/v2/aweme/slidesinfo/")
    url.searchParams.set("aweme_ids", `[${videoId}]`)
    url.searchParams.set("request_source", "200")
    const data = await http.json(url, { headers: ANDROID_HEADERS, verify: false })
    const slides = data?.aweme_details?.[0]
    if (!slides) throw new ParseError("can't find slides data")
    const result = this.result({
      title: slides.desc,
      author: this.createAuthor(
        slides.author?.nickname || "",
        pickUrl(slides.author?.avatar_thumb),
      ),
      timestamp: slides.create_time,
    })
    const dynamicUrls = (slides.images || [])
      .filter(image => image.video)
      .map(image => pickUrl(image.video?.play_addr))
      .filter(Boolean)
    if (dynamicUrls.length) {
      result.contents.push(...dynamicUrls.map(urlValue => this.createGif(urlValue)))
    } else {
      result.contents.push(
        ...this.createImages(
          (slides.images || []).map(image => pickUrl(image.url_list)).filter(Boolean),
        ),
      )
    }
    return result
  }
}
