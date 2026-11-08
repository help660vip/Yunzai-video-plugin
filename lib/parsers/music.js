import { Buffer } from "node:buffer"
import path from "node:path"

import { Creator, DownloadFunc } from "../core/creator.js"
import { config } from "../core/config.js"
import { ParseError, TipError } from "../core/errors.js"
import { http } from "../core/http.js"
import { BaseParser } from "../core/registry.js"
import { QQ_HEADERS } from "../core/utils.js"
import { decryptQqMusicFile, qqMusicOutputExtension } from "./qqmusic-qmc.js"

function musicResult(parser, values) {
  const content = []
  if (values.cover) {
    content.push(Creator.image(values.cover, {
      needSend: false,
      headers: parser.headers,
      cacheKey: values.cacheKey + ":cover",
    }))
  }
  content.push(parser.createAudio(values.audio, values.duration, {
    cacheKey: values.cacheKey,
  }))
  if (values.lyric) content.push(values.lyric)
  return parser.result({
    contentId: values.contentId || values.cacheKey || null,
    title: values.title,
    author: parser.createAuthor(values.artist || "未知歌手", values.artistAvatar),
    text: values.lyric || null,
    url: values.url,
    content,
    comments: values.comments || [],
    extra: {
      album: values.album,
      info: values.info,
      lyric: values.lyric,
      content_type: "音乐",
    },
  })
}

export class NeteaseParser extends BaseParser {
  static platform = { name: "netease", displayName: "网易云音乐" }
  static handlers = [
    {
      keyword: "163cn.tv",
      pattern: /https?:\/\/[^\s<]*163cn\.tv\/[A-Za-z0-9]+/i,
      method: "parseShort",
    },
    {
      keyword: "music.163.com",
      pattern: /(?:music|y)\.163\.com\/(?:#\/)?(?:song\/?\?id=|song\/)(\d+)[^\s<]*/i,
      method: "parse",
    },
  ]

  async parseShort(match) {
    const response = await http.request(match[0])
    const redirected = response.url
    const found = /(?:song\/?\?id=|song\/)(\d+)/.exec(redirected)
    if (!found) throw new Error("网易云短链中未找到歌曲 ID")
    return this.parse(found)
  }

  async parse(match) {
    const id = match[1] || /(?:id=|song\/)(\d+)/.exec(match[0])?.[1]
    const detail = await http.json("https://music.163.com/api/song/detail", {
      params: { ids: `[${id}]` }, headers: this.headers,
    })
    if (detail.code !== 200) throw new ParseError(`网易云歌曲详情接口返回 code=${detail.code}`)
    const song = detail.songs?.[0]
    if (!song) throw new TipError("网易云音乐没有查到这首歌，歌单和专辑链接暂不支持解析")
    const outerUrl = "https://music.163.com/song/media/outer/url"
    const outer = await http.request(outerUrl, {
      params: { id: `${id}.mp3` }, headers: this.headers, redirect: "manual", allowError: true,
    })
    const location = outer.headers.get("location")
    outer.body?.destroy?.()
    if (![301, 302, 303, 307, 308].includes(outer.status) || !location) {
      throw new ParseError(`网易云音频外链接口没有音源跳转: ${outer.status}`)
    }
    const audio = new URL(location, outer.url || outerUrl)
    if (!/^https?:$/.test(audio.protocol)) throw new ParseError("网易云音频外链接口返回了无效跳转")
    if (audio.pathname.replace(/\/+$/, "") === "/404") {
      throw new TipError(song.fee
        ? "网易云音乐该歌曲需要 VIP 或付费，取不到整曲音源"
        : "网易云音乐没有可播放的音频源，可能受版权限制")
    }
    let lyric = ""
    try {
      const response = await http.json("https://music.163.com/api/song/lyric", {
        params: { id, lv: "-1", kv: "-1", tv: "-1" }, headers: this.headers,
      })
      lyric = response.lrc?.lyric || ""
    } catch {}
    return musicResult(this, {
      title: song.name || "未知歌曲",
      artist: (song.artists || []).map(artist => artist.name).filter(Boolean).join("、"),
      album: song.album?.name,
      cover: song.album?.picUrl,
      audio: audio.href,
      duration: Number(song.duration || 0) / 1000,
      lyric,
      url: "https://music.163.com/song/" + id,
      cacheKey: "netease:" + id,
      contentId: id,
    })
  }
}

export class KugouParser extends BaseParser {
  static platform = { name: "kugou", displayName: "酷狗音乐" }
  static handlers = [
    {
      keyword: "t1.kugou.com",
      pattern: /https?:\/\/t1\.kugou\.com\/[A-Za-z0-9]+[^\s<]*/i,
      method: "parse",
    },
    {
      keyword: "kugou.com",
      pattern: /https?:\/\/[^\s<]*kugou\.com[^\s<]+/i,
      method: "parse",
    },
  ]

  async parse(match) {
    let url = match[0]
    const response = await http.request(url)
    url = response.url || url
    const html = await response.text()
    let hash = new URL(url).searchParams.get("hash")
    if (!hash) {
      const matched = /var dataFromSmarty\s*=\s*(\[.*?\]),/s.exec(html)
      if (matched) {
        try {
          hash = JSON.parse(matched[1])?.[0]?.hash
        } catch {}
      }
    }
    if (!hash) throw new Error("酷狗分享中未找到歌曲 hash")
    const data = await http.json(
      "https://m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash=" +
        encodeURIComponent(hash),
    )
    if (data.errcode !== 0 || !data.url) throw new Error("酷狗音乐解析失败")
    let lyric = ""
    try {
      const search = await http.json("https://krcs.kugou.com/search?hash=" + hash)
      const candidate = search.candidates?.[0]
      if (candidate) {
        const lyrics = await http.json(
          "https://lyrics.kugou.com/download?ver=1&id=" +
            candidate.id +
            "&accesskey=" +
            candidate.accesskey +
            "&fmt=lrc",
        )
        if (lyrics.content) lyric = Buffer.from(lyrics.content, "base64").toString("utf8")
      }
    } catch {}
    return musicResult(this, {
      title: data.songName,
      artist: data.singerName,
      album: data.albumName,
      cover: String(data.album_img || data.imgUrl || "").replace("{size}", "480"),
      audio: data.url,
      duration: Number(data.timeLength || 0),
      lyric,
      info: "比特率: " + (data.bitRate || "未知") + "K",
      url,
      cacheKey: "kugou:" + hash,
      contentId: hash,
    })
  }
}

export class KuwoParser extends BaseParser {
  static platform = { name: "kuwo", displayName: "酷我音乐" }
  static handlers = [
    {
      keyword: "kuwo.cn",
      pattern: /(?:www\.)?kuwo\.cn\/play_detail\/(\d+)[^\s<]*/i,
      method: "parse",
    },
  ]

  async fetchInfo(id) {
    const songs = await http.json("http://datacenter.kuwo.cn/d.c", {
      params: { resenc: "utf8", corp: "kuwo", ids: id, source: "kwplayer_ar_10.8.6.1_40.apk",
        cmd: "query", cmkey: "plist_pl2012", ft: "music" }, headers: this.headers,
    })
    if (!songs?.[0]) throw new ParseError("未找到酷我音乐歌曲")
    return songs[0]
  }

  async fetchAudio(id) {
    for (const bitrate of [320, 192, 128]) {
      try {
        const response = await http.json("http://mobi.kuwo.cn/mobi.s", {
          params: { type: "convert_url_with_sign", br: `${bitrate}kmp3`, user: "0", priority: "bitrate",
            surl: "1", source: "kwplayer_ar_5.1.0.0_B_jiakong_vh.apk", rid: id, f: "web" },
          headers: this.headers,
        })
        const data = response.data || response
        const value = data.url || data.purl || data.surl
        const url = typeof value === "string" ? value.replace(/^\/\//, "https://") : ""
        if (/^https?:\/\//i.test(url)) return { url, quality: `MP3 ${bitrate}K` }
      } catch {}
    }
    throw new ParseError("无法获取酷我音乐音频下载地址")
  }

  async fetchLyric(id) {
    try {
      const response = await http.json("https://kuwo.cn/openapi/v1/www/lyric/getlyric", {
        params: { musicId: id }, headers: this.headers,
      })
      if (Number(response.code) !== 200) return ""
      return (response.data?.lrclist || []).map(row =>
        `${kuwoLrcTimestamp(row.time)}${String(row.lineLyric || "").split(/\s+/).filter(Boolean).join(" ")}`,
      ).join("\n")
    } catch { return "" }
  }

  comment(row, depth = 0) {
    return this.createComment({
      author: this.createAuthor(row.u_name, row.u_pic, null, this.headers, { id: row.u_id }),
      content: [row.msg || ""], timestamp: Number(row.time || 0),
      stats: this.createStats({ likes: Number(row.like_num || 0), comments: Number(row.child_comment_count || 0) }),
      replies: depth < 10 ? (row.child_comments || []).slice(0, 5).map(reply => this.comment(reply, depth + 1)) : [],
    })
  }

  async fetchComments(id) {
    const limit = Math.max(0, Number(config.parser_max_comments) || 0)
    if (!limit) return []
    try {
      const response = await http.json("https://ncomment.kuwo.cn/com.s", {
        params: { f: "web", type: "get_rec_comment", isadd: "1", aapiver: "1", uid: "", digest: "15",
          sid: id, start: "0", count: limit }, headers: this.headers,
      })
      if (String(response.code) !== "200") return []
      return [...(response.top_comments || []), ...(response.hot_comments || []), ...(response.comments || [])]
        .slice(0, limit).map(row => this.comment(row))
    } catch { return [] }
  }

  async parse(match) {
    const id = match[1]
    const [data, audio, lyric, comments] = await Promise.all([
      this.fetchInfo(id), this.fetchAudio(id), this.fetchLyric(id), this.fetchComments(id),
    ])
    return musicResult(this, {
      title: data.name,
      artist: data.artist,
      artistAvatar: data.artistPic,
      album: data.album,
      cover: data.albumpic,
      audio: audio.url,
      duration: Number(data.duration || 0),
      lyric, comments,
      info: audio.quality,
      url: "https://www.kuwo.cn/play_detail/" + id,
      cacheKey: "kuwo:" + id,
      contentId: id,
    })
  }
}

/** Format decimal seconds with decimal half-up rounding rather than floating point rounding. */
export function kuwoLrcTimestamp(value) {
  const normalized = String(value ?? "0")
  const matched = /^(\d+)(?:\.(\d*))?$/.exec(normalized)
  let centiseconds
  if (matched) {
    const fraction = (matched[2] || "").padEnd(3, "0")
    centiseconds = Number(matched[1]) * 100 + Number(fraction.slice(0, 2)) + (Number(fraction[2]) >= 5 ? 1 : 0)
  } else centiseconds = Math.max(0, Math.round(Number(value || 0) * 100))
  if (!Number.isFinite(centiseconds)) centiseconds = 0
  const minutes = Math.floor(centiseconds / 6000)
  const seconds = Math.floor(centiseconds % 6000 / 100)
  return `[${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(centiseconds % 100).padStart(2, "0")}]`
}

function qqMusicSourceSuffix(url, encrypted) {
  try {
    const suffix = path.extname(new URL(url).pathname).toLowerCase()
    if (qqMusicOutputExtension("source" + suffix)) return suffix
  } catch {}
  if (encrypted) throw new Error("QQ音乐加密音频地址缺少可识别的文件格式")
  return ".dat"
}

export class QQMusicParser extends BaseParser {
  static platform = { name: "qqmusic", displayName: "QQ音乐" }
  static handlers = [
    {
      keyword: "c6.y.qq.com/base/fcgi-bin/u",
      pattern: /https?:\/\/c6\.y\.qq\.com\/base\/fcgi-bin\/u\?[^\s<]*/i,
      params: { __: {} },
      method: "parseShort",
    },
    {
      keyword: "y.qq.com",
      pattern: /https?:\/\/y\.qq\.com\/n\/(?:ryqq_v2\/songDetail\/|yqq\/song\/)([A-Za-z0-9]{14})(?:\.html)?[^\s<]*/i,
      method: "parseMid",
    },
    {
      keyword: "y.qq.com",
      pattern: /https?:\/\/y\.qq\.com\/n\/(?:ryqq_v2\/songDetail\/|yqq\/song\/)([1-9][0-9]*)(?:\.html)?[^\s<]*/i,
      method: "parseSongId",
    },
    {
      keyword: "i.y.qq.com/v8/playsong.html",
      pattern: /https?:\/\/i\.y\.qq\.com\/v8\/playsong\.html\?[^\s<]*/i,
      params: { songmid: {} },
      method: "parseMid",
    },
    {
      keyword: "i.y.qq.com/v8/playsong.html",
      pattern: /https?:\/\/i\.y\.qq\.com\/v8\/playsong\.html\?[^\s<]*/i,
      params: { songid: {} },
      method: "parseSongId",
    },
    {
      keyword: "i2.y.qq.com/n3/other/pages/playsong/index.html",
      pattern: /https?:\/\/i2\.y\.qq\.com\/n3\/other\/pages\/playsong\/index\.html\?[^\s<]*/i,
      params: { songmid: {}, ADTAG: { equals: "ryqq.songDetail" } },
      method: "parseMid",
    },
    {
      keyword: "i2.y.qq.com/n3/other/pages/playsong/index.html",
      pattern: /https?:\/\/i2\.y\.qq\.com\/n3\/other\/pages\/playsong\/index\.html\?[^\s<]*/i,
      params: { songid: {}, ADTAG: { equals: "ryqq.songDetail" } },
      method: "parseSongId",
    },
  ]

  async parseShort(match) {
    return this.parseWithRedirect(match[0])
  }

  async parseMid(match, searched = {}) {
    const musicId = match[1] || searched.params?.songmid
    if (!musicId) throw new Error("QQ音乐链接中未找到 songmid")
    return this.parseMusic(musicId)
  }

  async parseSongId(match, searched = {}) {
    const musicId = match[1] || searched.params?.songid
    if (!musicId) throw new Error("QQ音乐链接中未找到 songid")
    return this.parseMusic(musicId)
  }

  async parseMusic(musicId) {
    const response = await http.json("https://parse-api.sokoko.org/api/qq/song", {
      params: { music_id: musicId, quality: "high" },
    })
    if (response?.code !== 200 || !response.data) {
      throw new Error("QQ音乐接口返回错误")
    }
    const data = response.data
    const audioUrl = String(data.download_url || "")
    if (!/^https?:\/\//i.test(audioUrl)) throw new Error("QQ音乐接口返回了无效音频地址")
    const mid = String(data.id || musicId)
    const ekey = String(data.ekey || "")
    const sourceSuffix = qqMusicSourceSuffix(audioUrl, Boolean(ekey))
    const audio = DownloadFunc(async () => {
      const source = await this.downloader.download(audioUrl, {
        suffix: sourceSuffix,
        headers: this.headers,
        cacheKey: `qqmusic:${mid}:source`,
        detectFormat: null,
      })
      return ekey ? decryptQqMusicFile(source, ekey) : source
    }, {
      url: audioUrl,
      extHeaders: this.headers,
      cacheKey: `qqmusic:${mid}`,
    })
    const quality = data.quality?.name || "高品质"
    return musicResult(this, {
      title: data.title || "未知歌曲",
      artist: data.artist,
      artistAvatar: data.artist_pic,
      album: data.album,
      cover: data.cover,
      audio,
      duration: Number(data.duration_seconds || 0),
      lyric: data.lyric,
      info: quality,
      url: `https://y.qq.com/n/yqq/song/${mid}`,
      cacheKey: `qqmusic:${mid}`,
      contentId: mid,
    })
  }
}

function findTrackData(value, depth = 0) {
  if (!value || depth > 8) return null
  if (value.audioWithLyricsOption) return value
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findTrackData(item, depth + 1)
      if (found) return found
    }
  } else if (typeof value === "object") {
    for (const item of Object.values(value)) {
      const found = findTrackData(item, depth + 1)
      if (found) return found
    }
  }
  return null
}

export class QsMusicParser extends BaseParser {
  static platform = { name: "qsmusic", displayName: "汽水音乐" }
  static handlers = [
    {
      keyword: "qishui.douyin.com",
      pattern: /https?:\/\/[^\s<]*qishui\.douyin\.com\/s\/[A-Za-z0-9]+\/[^\s<]*/i,
      method: "parse",
    },
  ]

  async parse(match) {
    const response = await http.request(match[0], {
      headers: { ...this.headers, ...QQ_HEADERS },
    })
    const html = await response.text()
    const matched = /_ROUTER_DATA\s*=\s*({[\s\S]*?});/.exec(html)
    if (!matched) throw new Error("汽水音乐页面未找到结构化数据")
    const page = findTrackData(JSON.parse(matched[1]))
    const track = page?.audioWithLyricsOption
    if (!track?.url) throw new Error("汽水音乐页面未找到音频")
    const lyric = (track.lyrics?.sentences || [])
      .map(item => item.text || (item.words || []).map(word => word.text).join(""))
      .filter(Boolean)
      .join("\n")
    return musicResult(this, {
      title: track.trackName,
      artist: track.artistName,
      album: track.trackInfo?.album?.name,
      cover: track.coverURL,
      audio: track.url,
      duration: Number(track.duration || 0),
      lyric,
      info: "汽水音乐",
      url: response.url || match[0],
      cacheKey: "qsmusic:" + (page.track_id || track.trackName),
      contentId: page.track_id || track.trackName,
    })
  }
}
