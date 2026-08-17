import { Buffer } from "node:buffer"

import { Creator } from "../core/creator.js"
import { http } from "../core/http.js"
import { BaseParser } from "../core/registry.js"

function seconds(value) {
  if (typeof value === "number") return value
  const parts = String(value || "0").split(":").map(Number)
  if (parts.some(Number.isNaN)) return 0
  return parts.reduce((total, item) => total * 60 + item, 0)
}

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
  return parser.result({
    contentId: values.contentId || values.cacheKey || null,
    title: values.title,
    author: parser.createAuthor(values.artist || "未知歌手", values.artistAvatar),
    text: values.lyric || null,
    url: values.url,
    content,
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

  async fetch(endpoint, payload) {
    const data = await http.json("https://nextmusic.toubiec.cn/api/" + endpoint, {
      method: "POST",
      headers: { ...this.headers, referer: "https://wyapi.toubiec.cn/" },
      body: {
        ...payload,
        timestamp: Date.now(),
        ip: Array.from({ length: 4 }, () => Math.floor(Math.random() * 256)).join("."),
      },
    })
    if (data.code !== 200) throw new Error("网易云接口返回错误")
    return data.data || {}
  }

  async parse(match) {
    const id = match[1] || /(?:id=|song\/)(\d+)/.exec(match[0])?.[1]
    const song = await this.fetch("getSongInfo", { id })
    let lyric = ""
    try {
      lyric = (await this.fetch("getSongLyric", { id })).lrc || ""
    } catch {}
    let audio
    let level = "standard"
    for (const quality of ["lossless", "standard"]) {
      try {
        const found = await this.fetch("getSongUrl", { id, level: quality })
        if (found.url) {
          audio = found.url
          level = quality
          break
        }
      } catch {}
    }
    if (!audio) throw new Error("无法获取网易云音频地址")
    return musicResult(this, {
      title: song.name || "未知歌曲",
      artist: song.singer,
      album: song.album,
      cover: song.picimg,
      audio,
      duration: seconds(song.duration),
      lyric,
      info: "音质: " + level,
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

  async parse(match) {
    const id = match[1]
    const response = await http.json("https://parse-api.sokoko.org/api/kuwo/songs/", {
      params: { music_id: id, quality: "320k" },
    })
    if (response.code !== 200 || !response.data?.download_url) {
      throw new Error("酷我音乐接口返回错误")
    }
    const data = response.data
    return musicResult(this, {
      title: data.title,
      artist: data.artist,
      artistAvatar: data.artist_pic,
      album: data.album,
      cover: data.cover,
      audio: data.download_url,
      duration: Number(data.duration_seconds || 0),
      lyric: data.lyric,
      info: data.quality?.name,
      url: "https://www.kuwo.cn/play_detail/" + id,
      cacheKey: "kuwo:" + id,
      contentId: id,
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
      headers: { ...this.headers, "user-agent": "Mozilla/5.0 (iPhone)" },
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
