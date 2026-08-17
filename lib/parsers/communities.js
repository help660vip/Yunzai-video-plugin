import { OpenGraphParser } from "./shared.js"
import { DoubanApiParser } from "./douban-api.js"
import { IlluApiParser } from "./illu-api.js"
import { LinuxDoApiParser, ZlbApiParser } from "./discourse.js"
import { TiebaApiParser } from "./tieba-api.js"
import { ZhihuApiParser } from "./zhihu-api.js"
import { HeyboxApiParser } from "./heybox-api.js"
import { MiyousheApiParser } from "./miyoushe-api.js"

export const DoubanParser = DoubanApiParser
export const IlluParser = IlluApiParser
export const LinuxDoParser = LinuxDoApiParser
export const TiebaParser = TiebaApiParser
export const ZhihuParser = ZhihuApiParser
export const ZlbParser = ZlbApiParser
export const HeyboxParser = HeyboxApiParser
export const MiyousheParser = MiyousheApiParser

function parserClass(Base, name, displayName, handlers, headers = {}) {
  class PlatformParser extends Base {
    constructor() {
      super()
      this.headers = { ...this.headers, ...headers }
    }
  }
  PlatformParser.platform = { name, displayName }
  PlatformParser.handlers = handlers
  return PlatformParser
}

const urlTail = "[^\\s<]+"

export const BuffParser = parserClass(
  OpenGraphParser,
  "buff",
  "网易BUFF",
  [
    {
      keyword: "buff.163.com/s/news-detail_share.html",
      pattern: new RegExp("buff\\.163\\.com/s/news-detail_share\\.html\\?" + urlTail, "i"),
      params: { article_id: {}, comment_type: { oneOf: ["228", "211"] } },
      method: "parse",
    },
    {
      keyword: "buff.163.com/s/preview_share.html",
      pattern: new RegExp("buff\\.163\\.com/s/preview_share\\.html\\?" + urlTail, "i"),
      params: { game: {}, preview_id: {}, comment_type: { equals: "216" } },
      method: "parse",
    },
    {
      keyword: "buff.163.com/s/topic-detail_share.html",
      pattern: new RegExp("buff\\.163\\.com/s/topic-detail_share\\.html\\?" + urlTail, "i"),
      params: { social_topic_post_id: {}, comment_type: { equals: "239" } },
      method: "parse",
    },
  ],
)

export const CoolapkParser = parserClass(OpenGraphParser, "coolapk", "酷安", [
  {
    keyword: "coolapk.com/feed/",
    pattern: /(?:www\.)?coolapk\.com\/feed\/\d+[^\s<]*/i,
    method: "parse",
  },
  {
    keyword: "coolapk1s.com/feed/",
    pattern: /(?:www\.)?coolapk1s\.com\/feed\/\d+[^\s<]*/i,
    method: "parse",
  },
])

export const DoubaoParser = parserClass(OpenGraphParser, "doubao", "豆包", [
  {
    keyword: "doubao.com/video-sharing",
    pattern: new RegExp("(?:www\\.)?doubao\\.com/video-sharing\\?" + urlTail, "i"),
    params: { share_id: {}, video_id: {} },
    method: "parse",
  },
])

export const DsParser = parserClass(OpenGraphParser, "ds", "网易大神", [
  {
    keyword: "ds.163.com",
    pattern: /ds\.163\.com\/(?:article|feed)\/[A-Za-z0-9]+[^\s<]*/i,
    method: "parse",
  },
])

export const DuitangParser = parserClass(OpenGraphParser, "duitang", "堆糖", [
  {
    keyword: "duitang.com/blog",
    pattern: new RegExp("(?:www\\.)?duitang\\.com/blog/?" + urlTail, "i"),
    params: { id: { asInt: true } },
    method: "parse",
  },
  {
    keyword: "duitang.com/atlas",
    pattern: new RegExp("(?:www\\.)?duitang\\.com/atlas/?" + urlTail, "i"),
    params: { id: { asInt: true } },
    method: "parse",
  },
])

export const FiveEPlayParser = parserClass(OpenGraphParser, "fiveeplay", "5EPlay", [
  {
    keyword: "csgo.5eplay.com/forum",
    pattern: /csgo\.5eplay\.com\/forum\/(?:forum|share)\/\d+[^\s<]*/i,
    method: "parse",
  },
])

export const HupuParser = parserClass(OpenGraphParser, "hupu", "虎扑", [
  {
    keyword: "hupu.com",
    pattern: /(?:bbs|m)\.hupu\.com\/(?:bbs-share\/|bbs\/)?\d+(?:\.html)?[^\s<]*/i,
    method: "parse",
  },
])

export const LofterParser = parserClass(OpenGraphParser, "lofter", "LOFTER", [
  {
    keyword: "s.lofter.com",
    pattern: /s\.lofter\.com\/-s\/[0-9A-Za-z]+[^\s<]*/i,
    method: "parse",
  },
  {
    keyword: "lofter.com",
    pattern: /[0-9A-Za-z_-]+\.lofter\.com\/post\/[0-9A-Za-z]+_[0-9A-Za-z]+[^\s<]*/i,
    method: "parse",
  },
])

export const TapTapParser = parserClass(OpenGraphParser, "taptap", "TapTap", [
  {
    keyword: "taptap.cn",
    pattern: /(?:www\.)?taptap\.cn\/moment\/\d+[^\s<]*/i,
    method: "parse",
  },
])

export const WmpvpParser = parserClass(OpenGraphParser, "wmpvp", "完美世界电竞", [
  {
    keyword: "news.wmpvp.com/community",
    pattern: new RegExp("news\\.wmpvp\\.com/community-(?:pcDetail|detail)\\.html\\?" + urlTail, "i"),
    params: { id: { asInt: true } },
    method: "parse",
  },
  {
    keyword: "news.wmpvp.com/news.html",
    pattern: new RegExp("news\\.wmpvp\\.com/news\\.html\\?" + urlTail, "i"),
    params: { id: { asInt: true }, gameTypeStr: { asInt: true } },
    method: "parse",
  },
])
