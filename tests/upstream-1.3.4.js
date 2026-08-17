import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"

import { config } from "../lib/core/config.js"
import { Creator, DownloadFunc } from "../lib/core/creator.js"
import { StreamDownloader } from "../lib/core/downloader.js"
import { ffmpeg } from "../lib/core/ffmpeg.js"
import { http } from "../lib/core/http.js"
import {
  AudioContent,
  ImageContent,
  LinkContent,
  LivePhotoContent,
  StickerContent,
} from "../lib/core/model.js"
import {
  BaseParser,
  clearRegistryForTests,
  enabledPlatforms,
  getParser,
  matchUrl,
  registerParser,
} from "../lib/core/registry.js"
import { cacheDir } from "../lib/core/paths.js"
import { md5Name } from "../lib/core/utils.js"
import { ytdlp } from "../lib/core/ytdlp.js"
import { DouyinParser } from "../lib/parsers/douyin.js"
import { HeyboxApiParser, heyboxInternals } from "../lib/parsers/heybox-api.js"
import { KuaishouParser } from "../lib/parsers/kuaishou.js"
import { MiyousheApiParser } from "../lib/parsers/miyoushe-api.js"
import { MIYOUSHE_STICKERS } from "../lib/parsers/miyoushe-stickers.js"
import { TwitterParser } from "../lib/parsers/twitter.js"
import { YouTubeParser } from "../lib/parsers/youtube.js"

const tests = []
const test = (name, fn) => tests.push({ name, fn })

test("DownloadFunc 对视频和音频使用统一的 URL 与请求头协议", async () => {
  let calls = 0
  const task = DownloadFunc(async () => {
    calls += 1
    return "fixture.media"
  }, {
    url: "https://media.invalid/original",
    extHeaders: { referer: "https://source.invalid/" },
    cacheKey: "download-func",
  })
  const video = Creator.video(task)
  const audio = Creator.audio(task)
  assert.equal(video.pathTask.url, task.url)
  assert.equal(audio.pathTask.headers.referer, "https://source.invalid/")
  assert.equal(await video.pathTask.get(), "fixture.media")
  assert.equal(await video.pathTask.get(), "fixture.media")
  assert.equal(await audio.pathTask.get(), "fixture.media")
  assert.equal(calls, 2)
  assert.equal("cover_path" in video, false)
})

test("解析器只在首次命中或显式获取时初始化", () => {
  clearRegistryForTests()
  let constructors = 0
  class LazyParser extends BaseParser {
    static platform = { name: "lazy-fixture", displayName: "Lazy Fixture" }
    static handlers = [{
      keyword: "lazy.invalid",
      pattern: /lazy\.invalid\/(\d+)/,
      method: "parse",
    }]
    constructor() {
      super()
      constructors += 1
    }
  }
  registerParser(LazyParser)
  assert.equal(constructors, 0)
  assert.deepEqual(enabledPlatforms(), ["Lazy Fixture"])
  assert.equal(constructors, 0)
  assert.equal(matchUrl("https://unrelated.invalid/1"), null)
  assert.equal(constructors, 0)
  const route = matchUrl("https://lazy.invalid/1")
  assert.equal(constructors, 1)
  assert.equal(getParser(LazyParser), route.parser)
  assert.equal(constructors, 1)
})

function xTweet(id, text, parentId = null) {
  return {
    __typename: "Tweet",
    rest_id: String(id),
    core: {
      user_results: {
        result: {
          rest_id: "user-" + id,
          core: { name: "User " + id, screen_name: "user" + id },
          legacy: { description: "profile" },
          avatar: { image_url: "https://img.invalid/avatar_normal.jpg" },
        },
      },
    },
    legacy: {
      full_text: text,
      display_text_range: [0, text.length],
      created_at: "Fri Feb 20 16:33:16 +0000 2026",
      favorite_count: 2,
      reply_count: 1,
      bookmark_count: 3,
      quote_count: 4,
      retweet_count: 5,
      in_reply_to_status_id_str: parentId,
      extended_entities: { media: [] },
    },
    views: { count: "10" },
  }
}

test("X 富内容接口解析文章、链接卡和评论楼中楼", () => {
  const root = xTweet("100", "root")
  root.article = {
    article_results: {
      result: {
        title: "Article",
        preview_text: "Preview",
        cover_media: { media_info: { original_img_url: "https://img.invalid/article.jpg" } },
      },
    },
  }
  root.card = {
    legacy: {
      url: "https://target.invalid/",
      binding_values: [
        { key: "title", value: { string_value: "Target" } },
        { key: "description", value: { string_value: "Description" } },
        {
          key: "thumbnail_image",
          value: { image_value: { url: "https://img.invalid/card.jpg" } },
        },
      ],
    },
  }
  const comment = xTweet("101", "comment", "100")
  const reply = xTweet("102", "reply", "101")
  const wrap = tweet => ({ result: tweet })
  const entry = tweet => ({
    content: {
      itemContent: {
        __typename: "TimelineTweet",
        tweet_results: wrap(tweet),
      },
    },
  })
  const payload = {
    data: {
      data: {
        threaded_conversation_with_injections_v2: {
          instructions: [{
            type: "TimelineAddEntries",
            entries: [entry(root), entry(comment), entry(reply)],
          }],
        },
      },
    },
  }
  const result = new TwitterParser().collectEasyComment(payload, "100")
  assert.equal(result.title, "Article")
  assert.ok(result.content.some(item => item instanceof LinkContent))
  const articleImage = result.content.find(item => item instanceof ImageContent)
  assert.ok(articleImage)
  assert.equal(articleImage.pathTask.headers.host, undefined)
  assert.equal(articleImage.pathTask.cacheKey, "x:article-cover:100")
  assert.equal(result.comments.length, 1)
  assert.equal(result.comments[0].replies.length, 1)
})

test("抖音作品构造 Live Photo、非原声音乐、评论和嵌入链接", () => {
  const parser = new DouyinParser()
  const aweme = {
    aweme_id: "700",
    author: {
      uid: "u1",
      nickname: "作者",
      avatar_thumb: { url_list: ["https://img.invalid/avatar.jpg"] },
    },
    share_info: { share_desc: "标题", share_desc_info: "#标题# 正文" },
    share_url: "https://www.douyin.com/note/700?share=1",
    create_time: 1,
    region: "北京",
    statistics: { digg_count: 1, comment_count: 2, share_count: 3, collect_count: 4 },
    music: {
      is_original_sound: false,
      mid: "music",
      duration: 10,
      play_url: { uri: "https://audio.invalid/song.flac" },
    },
    images: [
      { clip_type: 2, uri: "still", url_list: ["https://img.invalid/still.jpg"] },
      {
        clip_type: 1,
        uri: "live",
        video: {
          play_addr: { uri: "video-id" },
          cover: { url_list: ["https://img.invalid/live.jpg"] },
        },
      },
    ],
  }
  const comment = parser.buildComment({
    text: "评论[赞]",
    create_time: 2,
    digg_count: 3,
    reply_comment_total: 4,
    ip_label: "上海",
    user: {
      uid: "c1",
      nickname: "评论者",
      avatar_thumb: { url_list: ["https://img.invalid/comment.jpg"] },
    },
  })
  const result = parser.buildWorkResult(aweme, [comment])
  assert.ok(result.content.some(item => item instanceof AudioContent))
  assert.ok(result.content.some(item => item instanceof LivePhotoContent))
  assert.ok(comment.content.some(item => item instanceof StickerContent))
  assert.equal(result.embedUrl.includes("vid=700"), true)
  assert.equal(result.comments.length, 1)
  const original = parser.buildWorkResult({
    ...aweme,
    aweme_id: "701",
    music: { ...aweme.music, is_original_sound: true },
    images: [],
    video: null,
  })
  assert.equal(original.audioContents.length, 0)
})

test("抖音直播状态与封面使用直播 API 数据", async () => {
  const original = http.json
  const parser = new DouyinParser()
  parser.ensureTtwid = async () => "fixture"
  http.json = async () => ({
    data: {
      data: [{
        id_str: "room",
        status: 2,
        title: "直播标题",
        cover: { url_list: ["https://img.invalid/live-cover.jpg"] },
        owner: {
          id_str: "owner",
          nickname: "主播",
          avatar_thumb: { url_list: ["https://img.invalid/owner.jpg"] },
        },
        room_view_stats: { display_value: 100 },
        like_count: 200,
      }],
    },
  })
  try {
    const result = await parser.parseWebRid("123")
    assert.equal(result.contentId, "room")
    assert.equal(result.content.at(-1), "直播中")
    assert.equal(result.extra.content_type, "直播")
  } finally {
    http.json = original
  }
})

test("快手评论接口生成父评论与子回复", async () => {
  const original = http.json
  http.json = async () => ({
    rootComments: [{
      comment_id: 1,
      content: "父[赞]",
      timestamp: 1000,
      likedCount: 2,
      headurl: "https://img.invalid/a.jpg",
      author_name: "A",
      user_id: 1,
      subCommentCount: 1,
    }],
    subCommentsMap: {
      1: {
        subComments: [{
          comment_id: 2,
          content: "子",
          timestamp: 2000,
          likedCount: 1,
          headurl: "https://img.invalid/b.jpg",
          author_name: "B",
          user_id: 2,
        }],
      },
    },
  })
  try {
    const comments = await new KuaishouParser().fetchComments("photo")
    assert.equal(comments.length, 1)
    assert.equal(comments[0].replies.length, 1)
    assert.ok(comments[0].content.some(item => item instanceof StickerContent))
  } finally {
    http.json = original
  }
})

test("小黑盒签名、Live Photo 与评论结构均为 Node 原生实现", () => {
  assert.equal(heyboxInternals.hkey(1700000000), heyboxInternals.hkey(1700000000))
  const signed = new URL(heyboxInternals.buildUrl("fixture", 1700000000))
  assert.equal(signed.searchParams.get("link_id"), "fixture")
  assert.ok(signed.searchParams.get("nonce"))
  const sm = heyboxInternals.smPayload()
  assert.equal(sm.appId, "heybox_website")
  assert.match(sm.data, /^[0-9a-f]+$/)

  const result = new HeyboxApiParser().collect({
    status: "ok",
    result: {
      link: {
        title: "小黑盒帖子",
        description: "说明",
        text: JSON.stringify([
          { type: "text", text: "正文[bigemoji_1]" },
          {
            type: "img",
            url: "https://img.invalid/live.jpg",
            live_url: "https://video.invalid/live.mp4",
          },
        ]),
        has_video: 0,
        create_at: 1,
        click: 2,
        link_award_num: 3,
        comment_num: 4,
        forward_num: 5,
        favour_count: 6,
        battery: { count: 7 },
        user: { username: "作者", userid: "u1", avatar: "https://img.invalid/u.jpg" },
      },
      comments: [{
        comment: [
          {
            text: "父评论",
            create_at: 1,
            up: 2,
            child_num: 1,
            user: { username: "A", userid: "a", avatar: "https://img.invalid/a.jpg" },
          },
          {
            text: "子评论",
            create_at: 2,
            up: 1,
            child_num: 0,
            user: { username: "B", userid: "b", avatar: "https://img.invalid/b.jpg" },
          },
        ],
      }],
    },
  }, "fixture")
  assert.ok(result.content.some(item => item instanceof LivePhotoContent))
  assert.ok(result.content.some(item => item instanceof StickerContent))
  assert.ok(
    result.content.find(item => item instanceof LivePhotoContent)
      .baseImage.url.endsWith("\\"),
  )
  assert.equal(result.comments[0].replies.length, 1)
})

test("米游社有序富文本支持链接卡、贴纸、B站嵌入与评论", () => {
  const structured = JSON.stringify([
    { insert: "正文_(星谷米游姬-好耶)" },
    {
      insert: {
        link_card: {
          title: "链接",
          origin_url: "https://target.invalid/",
          origin_user_nickname: "来源",
        },
      },
    },
    {
      insert: {
        custom_emoticon: {
          id: "e1",
          url: "https://img.invalid/emote.png",
        },
        backup_text: "表情",
      },
    },
    { insert: { video: "https://player.bilibili.com/player.html?bvid=BV1fixture" } },
  ])
  const payload = {
    retcode: 0,
    data: {
      post: {
        post: {
          post_id: "99",
          game_id: 8,
          subject: "标题",
          structured_content: structured,
          images: ["https://img.invalid/post.jpg"],
          created_at: 1,
          view_type: 2,
        },
        user: { uid: "u", nickname: "作者", avatar_url: "https://img.invalid/u.jpg" },
        stat: {
          view_num: 1,
          reply_num: 2,
          like_num: 3,
          bookmark_num: 4,
          forward_num: 5,
          share_num: 6,
        },
      },
    },
  }
  const comments = {
    retcode: 0,
    data: {
      list: [{
        reply: { struct_content: JSON.stringify([{ insert: "父评论" }]), updated_at: 2 },
        user: { uid: "a", nickname: "A", avatar_url: "https://img.invalid/a.jpg" },
        stat: { like_num: 1, sub_num: 1 },
        sub_replies: [{
          reply: { struct_content: JSON.stringify([{ insert: "子评论" }]), updated_at: 3 },
          user: { uid: "b", nickname: "B", avatar_url: "https://img.invalid/b.jpg" },
          stat: { like_num: 1, sub_num: 0 },
          sub_replies: [],
        }],
      }],
    },
  }
  const result = new MiyousheApiParser().collectPost(payload, comments, "99")
  assert.ok(result.content.filter(item => item instanceof LinkContent).length >= 2)
  assert.ok(result.content.some(item => item instanceof StickerContent))
  assert.ok(result.content.some(item => item instanceof ImageContent))
  assert.equal(result.comments[0].replies.length, 1)
  const sticker = result.content.find(item => item instanceof StickerContent)
  assert.equal(sticker.pathTask.url, MIYOUSHE_STICKERS["星谷米游姬-好耶"])
  assert.equal(Object.keys(MIYOUSHE_STICKERS).length, 3070)
  assert.deepEqual(
    new MiyousheApiParser().buildStructured(
      JSON.stringify([{ insert: "_(不存在的测试表情)" }]),
    ),
    ["_(不存在的测试表情)"],
  )
})

test("YouTube 频道接口失败时保留 yt-dlp 作者和媒体任务", async () => {
  const originalExtract = ytdlp.extractInfo
  ytdlp.extractInfo = async () => ({
    id: "fixture-video",
    channel: "Fixture Channel",
    authorName: "Fixture Channel@fixture",
    channelId: "fixture-channel",
    title: "Fixture",
    description: "",
    timestamp: 1,
    webpageUrl: "https://www.youtube.com/watch?v=fixture-video",
    ageLimit: 0,
    availability: "public",
    tags: [],
    categories: [],
    duration: 10,
    thumbnail: "https://img.invalid/youtube.jpg",
  })
  const parser = new YouTubeParser()
  parser.fetchAuthor = async () => {
    throw new Error("fixture channel API failure")
  }
  try {
    const result = await parser.parseVideo("https://youtu.be/fixture-video")
    assert.equal(result.author.name, "Fixture Channel")
    assert.equal(result.contentId, "fixture-video")
    assert.equal(result.videoContents.length, 1)
  } finally {
    ytdlp.extractInfo = originalExtract
  }
})

test("URL 缓存键保留查询参数但忽略片段", () => {
  const base = "https://media.invalid/file?token=one"
  assert.notEqual(md5Name(base, ".bin"), md5Name(base.replace("one", "two"), ".bin"))
  assert.equal(md5Name(base + "#first", ".bin"), md5Name(base + "#second", ".bin"))
  assert.throws(
    () => Creator.livePhoto("video", "image", { loop: 0 }),
    /loop/,
  )
})

test("动态媒体使用稳定缓存键识别真实格式，Range 续传校验完整大小", async () => {
  const downloader = new StreamDownloader()
  const originalRequest = downloader.http.request
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    Buffer.from("fixture"),
  ])
  let requests = 0
  downloader.http.request = async () => {
    requests += 1
    return new Response(png, {
      status: 200,
      headers: {
        "content-length": String(png.length),
        "content-type": "application/octet-stream",
      },
    })
  }
  let imagePath = null
  const resumePath = path.join(cacheDir, "fixture-resume.bin")
  try {
    imagePath = await downloader.downloadImage("https://dynamic.invalid/first", {
      cacheKey: "fixture:stable-image",
    })
    assert.equal(path.extname(imagePath), ".png")
    const cached = await downloader.downloadImage("https://dynamic.invalid/second", {
      cacheKey: "fixture:stable-image",
    })
    assert.equal(cached, imagePath)
    assert.equal(requests, 1)

    fs.writeFileSync(resumePath, "abc")
    downloader.http.request = async (url, options) => {
      assert.equal(options.headers.range, "bytes=3-")
      return new Response("def", {
        status: 206,
        headers: {
          "content-length": "3",
          "content-range": "bytes 3-5/6",
          "content-type": "application/octet-stream",
        },
      })
    }
    await downloader.downloadOnce("https://dynamic.invalid/resume", resumePath, {
      headers: {},
      chunkSize: 16,
      browser: false,
    })
    assert.equal(fs.readFileSync(resumePath, "utf8"), "abcdef")
  } finally {
    downloader.http.request = originalRequest
    if (imagePath) fs.rmSync(imagePath, { force: true })
    fs.rmSync(resumePath, { force: true })
  }
})

test("音频格式修正不可用时回退原始媒体", async () => {
  const downloader = new StreamDownloader()
  const originalDownload = downloader.download
  const originalToMp3 = ffmpeg.toMp3
  downloader.download = async () => "fixture.m4a"
  ffmpeg.toMp3 = async () => {
    throw new Error("fixture ffmpeg unavailable")
  }
  try {
    assert.equal(
      await downloader.downloadAudio("https://audio.invalid/fixture"),
      "fixture.m4a",
    )
  } finally {
    downloader.download = originalDownload
    ffmpeg.toMp3 = originalToMp3
  }
})

test("链接预览使用自适应高度，避免固定高度拉伸", () => {
  const source = fs.readFileSync(
    new URL("../lib/render/renderer.js", import.meta.url),
    "utf8",
  )
  assert.match(source, /\.link-preview\{[^}]*height:auto/)
  assert.match(source, /\.link-preview\{[^}]*object-fit:contain/)
})

let passed = 0
for (const item of tests) {
  try {
    await item.fn()
    passed += 1
    console.log("✓", item.name)
  } catch (error) {
    console.error("✗", item.name)
    console.error(error)
  }
}
console.log(`\n${passed}/${tests.length} upstream 1.3.4 tests passed`)
if (passed !== tests.length) process.exitCode = 1
