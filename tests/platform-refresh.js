import assert from "node:assert/strict"
import { Response } from "node-fetch"
import { config } from "../lib/core/config.js"
import { http } from "../lib/core/http.js"
import { shouldBlockResult } from "../lib/core/safety.js"
import { registerParser, matchUrl } from "../lib/core/registry.js"
import { AudioContent, GraphicContent, ImageContent, LivePhotoContent, QuoteContent, StickerContent } from "../lib/core/model.js"
import { AcfunParser } from "../lib/parsers/acfun.js"
import { DouyinParser } from "../lib/parsers/douyin.js"
import { TwitterParser } from "../lib/parsers/twitter.js"
import { XiaohongshuParser } from "../lib/parsers/xiaohongshu.js"
import { TapTapParser, BuffParser, CoolapkParser, DsParser, DuitangParser, FiveEPlayParser, HupuParser, LofterParser, WmpvpParser } from "../lib/parsers/communities.js"
import { DoubanApiParser } from "../lib/parsers/douban-api.js"
import { IlluApiParser } from "../lib/parsers/illu-api.js"
import { MiyousheApiParser } from "../lib/parsers/miyoushe-api.js"
import { ZhihuApiParser } from "../lib/parsers/zhihu-api.js"
import { parseDiscourseContent, LinuxDoApiParser } from "../lib/parsers/discourse.js"
import { htmlToText, richHtml } from "../lib/parsers/shared.js"

const cases = []
const test = (name, run) => cases.push({ name, run })
const media = "https://media.invalid/synthetic.mp4"
const picture = "https://media.invalid/synthetic.jpg"
const withHttp = async (overrides, run) => {
  const original = Object.fromEntries(["request", "json", "text", "buffer", "browserRequest"].map(key => [key, http[key]]))
  for (const key of Object.keys(original)) http[key] = overrides[key] || (async () => { throw new Error("Unexpected unmocked HTTP call: " + key) })
  try { return await run() } finally { Object.assign(http, original) }
}
const withConfig = async (values, run) => {
  const original = Object.fromEntries(Object.keys(values).map(key => [key, config[key]]))
  Object.assign(config, values)
  try { return await run() } finally { Object.assign(config, original) }
}
const route = (Parser, url) => {
  registerParser(Parser)
  const found = matchUrl(url, Parser)
  assert.ok(found, "registered route: " + url)
  return found
}
const runRoute = (Parser, url) => {
  const found = route(Parser, url)
  return found.parser[found.method](found.match, found)
}

test("HTML semantic whitespace and anchors remain ordered around lazy media", () => {
  const parser = new DoubanApiParser()
  const html = '<h2>Heading</h2><p>Hello <b>world</b> <a href="/path"><span>Read</span> more</a></p><img src="/photo.jpg"><p>After</p>'
  const content = richHtml(parser, html, "https://example.invalid/")
  assert.equal(content[0], "Heading\nHello world Read more (https://example.invalid/path)")
  assert.ok(content[1] instanceof GraphicContent)
  assert.equal(content[2], "After")
  assert.equal(htmlToText('<p>First</p><h6>Next</h6><a href="#anchor">local</a>', "https://example.invalid/"), "First\nNext\nlocal")
  assert.equal(content.filter(item => typeof item === "string").join("").match(/Read/g).length, 1)
})

test("AcFun mobile metadata has source, dynamic HLS size and labelled statistics", async () => {
  let called = 0
  await withHttp({ json: async (url, options) => {
    called++
    assert.equal(new URL(url).pathname, "/rest/app/douga/info")
    assert.equal(options.params.dougaId, "123")
    return { title: "Synthetic", description: "<p>A <b>description</b></p>", createTimeMillis: 1000,
      durationMillis: 2000, coverUrl: picture, user: { id: "user", name: "User", headUrl: picture, ipLocation: "Test" },
      currentVideoInfo: { playInfos: [{ playUrls: ["https://media.invalid/a.m3u8", "https://media.invalid/b.m3u8"] }] },
      viewCount: 3, likeCount: 2, bananaCount: 1, danmakuCount: 4 }
  } }, async () => {
    const result = await new AcfunParser().parse({ groups: { acid: "123" } })
    assert.equal(result.url, "https://www.acfun.cn/v/ac123")
    assert.equal(result.author.id, "user")
    assert.equal(result.video.duration, 2)
    assert.equal(result.video.isDynamicSize, true)
    assert.deepEqual(result.stats.extra.banana, ["香蕉", 1])
    assert.equal(result.text, "A description")
    assert.equal(called, 1)
    await assert.rejects(() => new AcfunParser().parse({ groups: { acid: "123_2" } }), /多 P/)
  })
})

test("Douyin open metadata does not fetch ttwid or comments when comments are disabled", async () => {
  await withConfig({ parser_max_comments: 0 }, () => withHttp({ json: async (url, options) => {
    assert.ok(url.endsWith("/aweme/detail/"))
    assert.equal(options.headers.origin, "https://open.douyin.com")
    assert.equal(options.headers.referer, "https://open.douyin.com/")
    assert.deepEqual(options.params, { aweme_id: "1", aid: 6383 })
    return { aweme_detail: { aweme_id: "1", desc: "Synthetic", author: {}, video: {
      play_addr: { uri: "video-id", url_list: ["https://media.invalid/play?file_id=stable-file"] }, duration: 2000,
    } } }
  } }, async () => {
    const result = await new DouyinParser().parseWork("1")
    assert.equal(result.comments.length, 0)
    assert.equal(new URL(result.video.pathTask.url).searchParams.get("file_id"), "stable-file")
    assert.equal(new URL(result.video.pathTask.url).searchParams.has("ratio"), false)
  }))
})

test("Douyin ttwid registration is single-flight and refreshes after one hour", async () => {
  let count = 0
  await withHttp({ request: async () => {
    count++
    return new Response("{}", { headers: { "set-cookie": "ttwid=synthetic-" + count + "; Path=/; HttpOnly" } })
  } }, async () => {
    const parser = new DouyinParser()
    assert.deepEqual(await Promise.all([parser.ensureTtwid(), parser.ensureTtwid()]), ["synthetic-1", "synthetic-1"])
    assert.equal(count, 1)
    await parser.ensureTtwid()
    assert.equal(count, 1)
    parser.ttwidUpdatedAt -= 3600001
    assert.equal(await parser.ensureTtwid(), "synthetic-2")
    assert.equal(count, 2)
  })
})

const tweet = (id = "1", overrides = {}) => ({
  __typename: "Tweet", rest_id: id, core: { user_results: { result: {
    core: { name: "Synthetic", screen_name: "synthetic" }, profile_bio: { description: "Profile" },
    avatar: { image_url: picture },
  } } },
  legacy: { full_text: "Original", lang: "en", favorite_count: 1 }, views: {}, ...overrides,
})

test("X visitor token lifetime and in-flight renewal", async () => {
  let count = 0
  await withConfig({ parser_x_ck: "" }, () => withHttp({ json: async url => {
    assert.equal(url, "https://api.x.com/1.1/guest/activate.json")
    return { guest_token: "synthetic-" + ++count }
  } }, async () => {
    const parser = new TwitterParser()
    assert.deepEqual(await Promise.all([parser.ensureGuestToken(), parser.ensureGuestToken()]), ["synthetic-1", "synthetic-1"])
    assert.equal(count, 1)
    await parser.authHeaders()
    assert.equal(count, 1)
    parser.guestTokenCreatedAt -= 7200001
    assert.equal((await parser.authHeaders())["x-guest-token"], "synthetic-2")
  }))
})

test("X official responses retain original text, translation, biography and missing views", async () => {
  let calls = 0
  await withConfig({ parser_x_ck: "auth_token=synthetic; ct0=synthetic-csrf", parser_max_comments: 0 }, () => withHttp({ json: async (url, options) => {
    calls++
    assert.equal(options.headers["x-csrf-token"], "synthetic-csrf")
    if (url.includes("/TweetResultByRestId")) return { data: { tweetResult: { result: tweet("1", { is_translatable: true }) } } }
    assert.equal(url, "https://api.x.com/2/grok/translation.json")
    assert.deepEqual(options.body, { content_type: "POST", id: "1", dst_lang: "zh" })
    return { result: { text: "译文" } }
  } }, async () => {
    const result = await new TwitterParser().parse(["x.com/synthetic/status/1", "1"])
    assert.equal(result.text, "Original")
    assert.equal(result.content[0], "Original")
    assert.ok(result.content.at(-1) instanceof QuoteContent)
    assert.equal(result.content.at(-1).text, "译文")
    assert.equal(result.author.description, "Profile")
    assert.equal(result.stats.viewCount, null)
    assert.equal(calls, 2)
    config.parser_x_ck = ""
    assert.equal(result.comments.length, 0)
  }))
})

test("X bundled translations, image layout and deep sensitive references are preserved", async () => {
  const leaf = tweet("3", { legacy: { full_text: "safe description", possibly_sensitive: true } })
  const nested = tweet("2", { quoted_status_result: { result: leaf } })
  const value = tweet("1", {
    legacy: { full_text: "Original", lang: "en", extended_entities: { media: [{ type: "photo", media_url_https: picture }] } },
    quoted_status_result: { result: nested },
    grok_translated_post_with_availability: { is_available: true, data: { translation: "译文" } },
  })
  const result = new TwitterParser().collectTweet(value)
  assert.equal(result.imageContents[0].layout, "x")
  assert.equal(result.imageContents[0].pathTask.promise, null)
  assert.equal(result.author.avatar.promise, null)
  assert.equal(result.repost.repost.safety.sensitive, true)
  assert.equal(result.content.at(-1).text, "译文")
  await withConfig({ parser_r18_filter_enabled: true, parser_r18_platforms: ["twitter"], parser_block_x_sensitive: true }, async () => {
    assert.equal(shouldBlockResult(result), true)
  })
})

test("X primary result can retain optional comment trees without losing stronger safety metadata", async () => {
  const original = tweet("1")
  const secondary = tweet("1", { legacy: { full_text: "Original", possibly_sensitive: true } })
  const comment = tweet("2", { legacy: { full_text: "Reply", in_reply_to_status_id_str: "1" } })
  let count = 0
  await withConfig({ parser_max_comments: 1, parser_x_ck: "auth_token=synthetic; ct0=synthetic" }, () => withHttp({
    json: async url => {
      count++
      if (url.includes("/TweetResultByRestId")) return { data: { tweetResult: { result: original } } }
      assert.equal(url, "https://easycomment.ai/api/twitter/v1/free/get-tweet-detail")
      return { code: 100000, data: { data: { threaded_conversation_with_injections_v2: { instructions: [{
        type: "TimelineAddEntries", entries: [secondary, comment].map(result => ({
          content: { itemContent: { __typename: "TimelineTweet", tweet_results: { result } } },
        })),
      }] } } } }
    },
  }, async () => {
    const result = await new TwitterParser().parse(["", "1"])
    assert.equal(result.text, "Original")
    assert.equal(result.comments[0].content[0], "Reply")
    assert.equal(result.safety.sensitive, true)
    assert.equal(count, 2)
  }))
})

test("Rich community embedded video keeps DOM ordering and avoids duplicate cover images", () => {
  const content = richHtml(new BuffParser(), '<p>Before</p><div class="video-content" data-src="' + media +
    '"><img src="' + picture + '"></div><p>After</p>', "https://buff.163.com/")
  assert.equal(content.length, 3)
  assert.equal(content[0], "Before")
  assert.equal(content[1].pathTask.url, media)
  assert.equal(content[2], "After")
  assert.equal(content[1].pathTask.promise, null)
})

test("X excessively nested valid primary data never falls back to a less detailed provider", async () => {
  let value = tweet("40")
  for (let i = 39; i > 0; i--) value = tweet(String(i), { quoted_status_result: { result: value } })
  let count = 0
  await withConfig({ parser_x_ck: "auth_token=synthetic; ct0=synthetic" }, () => withHttp({ json: async url => {
    count++
    assert.ok(url.includes("/TweetResultByRestId"))
    return { data: { tweetResult: { result: value } } }
  } }, async () => {
    await assert.rejects(() => new TwitterParser().parse(["", "1"]), /层级过深/)
    assert.equal(count, 1)
  }))
})

test("TapTap explore supports nested tags, stickers, comment images and lazy HLS", async () => {
  const calls = []
  await withConfig({ parser_max_comments: 2 }, () => withHttp({ json: async (url, options) => {
    calls.push(url)
    if (url.endsWith("moment/v3/detail")) return { data: {
      moment: { id_str: "1", created_time: 1, author: { user: { id: 2, name: "Author", avatar: picture } },
        topic: { title: "Topic", pin_video: { video_id: 4 } }, stat: { ups: 2 } },
      first_post: { contents: { json: [{ type: "paragraph", children: [
        { type: "tag", children: [{ text: "Tag" }] },
        { type: "tap_emoji", info: { style: "inline", img: { original_url: picture } }, children: [{ text: "[emote]" }] },
        { type: "tap_emoji", children: [{ text: "[missing]" }] },
      ] }] }, footer_images: [{ original_url: picture }] },
    } }
    if (url.endsWith("video-resource/v1/multi-get")) return { data: { list: [{
      video_id: 4, play_url: { url: "https://media.invalid/synthetic.m3u8" }, raw_cover: { url: picture }, info: { duration: 3 },
    }] } }
    assert.ok(url.endsWith("moment-comment/v1/by-moment"))
    assert.equal(options.params.limit, 2)
    return { data: { list: [{ author: { id: 3, name: "Reply" }, contents: { json: [{ text: "Comment" }] },
      images: [{ original_url: picture }], child_posts: [{ author: { name: "Child" }, contents: { json: [{ text: "Nested" }] } }] }] } }
  } }, async () => {
    const result = await runRoute(TapTapParser, "https://www.taptap.cn/explore/1")
    assert.equal(result.content[0], "Tag")
    assert.ok(result.content[1] instanceof StickerContent)
    assert.equal(result.content[2], "[missing]")
    assert.equal(result.videoContents[0].duration, 3)
    assert.ok(result.comments[0].content[1] instanceof ImageContent)
    assert.equal(result.comments[0].replies.length, 1)
    assert.equal(calls.length, 3)
  }))
})

test("Eight community APIs parse deterministic data without comment requests when disabled", async () => {
  await withConfig({ parser_max_comments: 0 }, async () => {
    const scenarios = [
      [BuffParser, "https://buff.163.com/s/topic-detail_share.html?social_topic_post_id=P1&comment_type=239",
        "https://buff.163.com/api/topic/posts/detail", { code: "OK", data: { user_infos: { u: { nickname: "Author" } },
          items: [{ author_id: "u", content: "Body", pictures: [{ image_url: picture }], ups_num: 1 }] } }],
      [DsParser, "https://ds.163.com/feed/abc", "https://inf.ds.163.com/v1/web/feed/basic/facade",
        { code: 200, result: { feed: { id: "abc", uid: "u", content: JSON.stringify({ body: { title: "Title", longText: "<h2>Body</h2><a href='/path'>Link</a>" } }), record: {} }, userInfos: [{ user: { uid: "u", nick: "Author" } }] } }],
      [DuitangParser, "https://www.duitang.com/atlas?id=1", "https://www.duitang.com/napi/vienna/atlas/detail/",
        { status: 1, data: { id: 1, desc: "Body", sender: { username: "Author" }, blogs: [{ photo: { path: picture } }] } }],
      [FiveEPlayParser, "https://csgo.5eplay.com/forum/1", "https://app.5eplay.com/api/csgo/forum/topic/1",
        { success: true, data: { content: { tid: "1", username: "Author", title: "Title", intro_text: "Body", images: [picture], video_data: { video_url: media }, share_data: {} }, comments: { total: 1, list: [{ content: "Do not show" }] } } }],
      [HupuParser, "https://bbs.hupu.com/1.html", "https://bbs.mobileapi.hupu.com/1/7.5.51/threads/1",
        { tid: "1", author: { name: "Author" }, offline_data: { data: { title: "Title", content: "<h2>Body</h2>" } }, video_info: { src: media, duration: "2" } }],
      [LofterParser, "https://synthetic.lofter.com/post/a_b", "https://api.lofter.com/oldapi/post/detail.api",
        { meta: { status: 200 }, response: { posts: [{ post: { title: "Title", content: "<p>Body</p>", blogInfo: { blogName: "synthetic", blogNickName: "Author" }, photoLinks: JSON.stringify([{ orign: picture }]) } }] } }],
      [WmpvpParser, "https://news.wmpvp.com/community-detail.html?id=1", "https://appengine.wmpvp.com/steamcn/community/post/getPostById",
        { result: { post: { title: "Title", content: "<p>Body</p>", communityUserItem: { nickname: "Author" }, images: [{ url: picture }] } } }],
    ]
    for (const [Parser, url, endpoint, payload] of scenarios) {
      let calls = 0
      await withHttp({ json: async (calledUrl, options) => {
        calls++
        assert.equal(calledUrl, endpoint)
        if (Parser === HupuParser) assert.match(options.params.sign, /^[0-9a-f]{32}$/)
        if (Parser === LofterParser) assert.equal(options.body.get("postid"), "11")
        return JSON.parse(JSON.stringify(payload))
      } }, async () => {
        const result = await runRoute(Parser, url)
        assert.equal(result.author.name, "Author", Parser.platform.name)
        assert.ok(result.contentId)
        assert.ok(result.content.length)
        assert.deepEqual(result.comments, [])
        assert.equal(calls, 1)
      })
    }
    let calls = 0
    await withHttp({ text: async url => {
      calls++
      assert.equal(url, "https://www.coolapk1s.com/feed/1")
      return '<script id="__NEXT_DATA__">' + JSON.stringify({ props: { pageProps: {
        feed: { username: "Author", message: "<p>Hello <a href='/feed/2'>more</a></p>", picArr: [picture] }, aiSummary: "Summary",
      } } }) + "</script>"
    } }, async () => {
      const result = await runRoute(CoolapkParser, "https://coolapk.com/feed/1")
      assert.equal(result.author.name, "Author")
      assert.equal(result.aiSummary, "Summary")
      assert.equal(result.content[0], "Hello more (https://coolapk.com/feed/2)")
      assert.equal(calls, 1)
    })
  })
})

test("BUFF news, video and gallery preserve media, replies and request parameters", async () => {
  await withConfig({ parser_max_comments: 2 }, () => withHttp({ json: async (url, options) => {
    if (url.endsWith("comment/share/detail")) return { code: "OK", data: { items: [{
      message: "Body[emote]", author: { nickname: "Comment" }, pictures: [{ icon_url: picture, is_emoji: true, name: "emote" }],
      replies: [{ message: "Reply", author: {} }],
    }] } }
    if (url.endsWith("market/preview/share_detail")) {
      assert.equal(options.params.preview_id, "V1")
      return { code: "OK", data: { preview: { user_id: "u", description: "Gallery", icon_url: picture },
        user_infos: { u: { nickname: "Author" } } } }
    }
    assert.ok(url.endsWith("news/share/detail"))
    return { code: "OK", data: { body: "<p>News <a href='/news'>Link</a></p>", author: "Author",
      video: [{ video_url: media, icon_url: picture, duration: "3.5" }] } }
  } }, async () => {
    for (const kind of ["211", "228", "216"]) {
      const url = kind === "216"
        ? "https://buff.163.com/s/preview_share.html?game=csgo&preview_id=V1&comment_type=216"
        : "https://buff.163.com/s/news-detail_share.html?article_id=1&comment_type=" + kind
      const result = await runRoute(BuffParser, url)
      assert.equal(result.author.name, "Author")
      assert.equal(result.comments[0].content[0], "Body")
      assert.ok(result.comments[0].content[1] instanceof StickerContent)
      assert.equal(result.comments[0].replies.length, 1)
      if (kind !== "216") assert.equal(result.videoContents[0].duration, 3.5)
    }
  }))
})

test("Community comments preserve nested replies, media and author identities", async () => {
  const ds = new DsParser()
  const dsComments = ds.buildComments([{
    userInfos: [{ user: { uid: "u", nick: "Author" } }],
    feedComments: [{ id: "1", uid: "u", content: "root", record: {} }],
    featuredReplies: [{ id: "2", uid: "u", content: "child[pic]", parent: "feed.user.1", replyId: "1",
      commentRich: { name: "pic", url: picture }, record: {} }],
  }])
  assert.equal(dsComments[0].replies[0].parentAuthor.name, "Author")
  assert.ok(dsComments[0].replies[0].content[1] instanceof ImageContent)
  const lofter = new LofterParser().comment({ publisherBlogInfo: { blogName: "id", blogNickName: "Author" },
    content: "<p>before[ok]after</p>", emotes: [{ name: "[ok]", url: picture }],
    l2Comments: [{ publisherBlogInfo: {}, content: "child" }] })
  assert.equal(lofter.author.id, "id")
  assert.ok(lofter.content[1] instanceof StickerContent)
  assert.equal(lofter.replies[0].content[0], "child")
  const hupu = new HupuParser().buildComments([
    { pid: "1", userName: "Author", content: "<p>root</p>" },
    { pid: "2", userName: "Reply", content: "<p>child</p>", quote: [{ pid: "1" }] },
  ])
  assert.equal(hupu.length, 1)
  assert.equal(hupu[0].replies[0].author.name, "Reply")
})

test("TapTap, Douban, Zhihu, Miyoushe and ILLU skip every optional comment call at zero", async () => {
  const previousIlluKey = process.env.ILLU_BMOB_SECRET_KEY
  process.env.ILLU_BMOB_SECRET_KEY = "synthetic-test-key"
  try {
    await withConfig({ parser_max_comments: 0 }, async () => {
      const scenarios = [
        [() => new TapTapParser().parse(["", "1"]), { data: { moment: { id_str: "1", topic: {}, author: {} }, first_post: {} } }, "/moment/v3/detail"],
        [() => new DoubanApiParser().parse(["douban.com/group/topic/1"]), { id: "1", content: "<p>Body</p>", author: {} }, "/group/topic/1"],
        [() => new ZhihuApiParser().parseArticle("1", "https://zhuanlan.zhihu.com/p/1"), { title: "Title", content: "<p>Body</p>", author: {} }, "/articles/1"],
        [() => new MiyousheApiParser().parse(["", "1"]), { retcode: 0, data: { post: { post: { post_id: "1", structured_content: "[]" }, user: {}, stat: {} } } }, "/getPostFull"],
        [() => new IlluApiParser().parseArticle("1"), { result: { dataObject: { title: "Title", description: "Body", author: {} } } }, "/getArticleByIdV2"],
      ]
      for (const [run, payload, endpoint] of scenarios) {
        let calls = 0
        await withHttp({ json: async url => { calls++; assert.ok(url.endsWith(endpoint)); return payload } }, async () => {
          const result = await run()
          assert.deepEqual(result.comments, [])
          assert.equal(calls, 1)
        })
      }
    })
  } finally {
    if (previousIlluKey === undefined) delete process.env.ILLU_BMOB_SECRET_KEY
    else process.env.ILLU_BMOB_SECRET_KEY = previousIlluKey
  }
})

test("Douban fractional dates and Discourse quote fallback/link labels", async () => {
  await withConfig({ parser_max_comments: 0 }, () => withHttp({ json: async () => ({
    id: "1", title: "Title", content: "<p>Body</p>", create_time: "2026-01-02 03:04:05.123", author: {},
  }) }, async () => {
    const result = await new DoubanApiParser().parse(["douban.com/group/topic/1"])
    assert.equal(result.timestamp, Math.floor(Date.parse("2026-01-02T03:04:05.123+08:00") / 1000))
  }))
  const content = parseDiscourseContent(new LinuxDoApiParser(),
    '<aside class="quote" data-display-name="Display"><blockquote>Quote</blockquote></aside><p><a href="/topic/1">Topic</a></p>',
    "https://linux.do")
  assert.equal(content[0].title, "Display")
  assert.equal(content[1], "Topic (https://linux.do/topic/1)")
})

test("Xiaohongshu current discovery fields preserve Live Photo, stable authors and comment images", async () => {
  const payload = { noteData: { data: { noteData: { title: "Title", desc: "Body", user: { userId: "u", nickName: "Author" },
    lastUpdateTime: 2000, imageList: [{ fileId: "file", livePhoto: true, stream: { h264: [{ masterUrl: media }] } }] },
    commentData: { comments: [{ user: { userId: "c", nickname: "Reply" }, content: "Comment", pictures: [{ originUrl: picture }] }] } } } }
  await withConfig({ parser_max_comments: 2 }, () => withHttp({ text: async () =>
    "<script>window.__INITIAL_STATE__=" + JSON.stringify(payload) + "</script>",
  }, async () => {
    const result = await new XiaohongshuParser().parseDiscovery("https://www.xiaohongshu.com/discovery/item/1", "1")
    assert.equal(result.author.id, "u")
    assert.equal(result.timestamp, 2)
    assert.ok(result.orderedContent.some(item => item instanceof LivePhotoContent))
    assert.equal(result.comments[0].author.id, "c")
    assert.ok(result.comments[0].content[1] instanceof ImageContent)
  }))
})

test("Xiaohongshu canonical and short links accept valid IDs without query parameters", async () => {
  const id = "1234567890abcdef12345678"
  for (const path of ["explore/", "discovery/item/"]) {
    for (const suffix of ["", "?xsec_token=synthetic%3D&xsec_source=pc_share"]) {
      const found = route(XiaohongshuParser, "https://www.xiaohongshu.com/" + path + id + suffix)
      assert.equal(found.match.groups.xhsId, id)
      assert.equal(found.match.groups.query, id + suffix)
    }
  }
  for (const invalid of ["abc123", id + "a", id + "-suffix", "g".repeat(24)]) {
    assert.equal(matchUrl("https://www.xiaohongshu.com/explore/" + invalid, XiaohongshuParser), null)
  }
  const parser = new XiaohongshuParser()
  parser.getRedirectUrl = async () => "https://www.xiaohongshu.com/discovery/item/" + id
  parser.parseCommon = async match => {
    assert.equal(match.groups.query, id)
    assert.equal(match.groups.xhsId, id)
    return parser.result({ contentId: id })
  }
  const result = await parser.parseShort(["xhslink.com/o/synthetic"])
  assert.equal(result.contentId, id)
})

function commentPayload(values) {
  return { code: 100000, data: { data: { threaded_conversation_with_injections_v2: { instructions: [{
    type: "TimelineAddEntries", entries: values.map(result => ({
      content: { itemContent: { __typename: "TimelineTweet", tweet_results: { result } } },
    })),
  }] } } } }
}

test("X outer visibility adult warnings survive unwrapping even when generic sensitive blocking is disabled", async () => {
  const wrapper = { __typename: "TweetWithVisibilityResults", tweet: tweet("1"),
    tweetInterstitial: { text: { text: "Adult content" } } }
  await withConfig({
    parser_max_comments: 0, parser_x_ck: "auth_token=synthetic; ct0=synthetic",
    parser_r18_filter_enabled: true, parser_r18_platforms: ["twitter"], parser_block_x_sensitive: false,
  }, () => withHttp({ json: async () => ({ data: { tweetResult: { result: wrapper } } }) }, async () => {
    const result = await new TwitterParser().parse(["", "1"])
    assert.equal(result.safety.rating, "adult")
    assert.equal(shouldBlockResult(result), true)
    assert.equal(result.author.avatar.promise, null)
  }))
})

test("X restricted visibility response without tweet body does not fall back to another provider", async () => {
  let calls = 0
  await withConfig({
    parser_max_comments: 0, parser_x_ck: "auth_token=synthetic; ct0=synthetic",
    parser_r18_filter_enabled: true, parser_r18_platforms: ["twitter"], parser_block_x_sensitive: false,
  }, () => withHttp({ json: async url => {
    calls++
    assert.ok(url.includes("/TweetResultByRestId"))
    return { data: { tweetResult: { result: { __typename: "TweetWithVisibilityResults",
      tweetInterstitial: { text: { text: "Adult content" } } } } } }
  } }, async () => {
    const result = await new TwitterParser().parse(["", "1"])
    assert.equal(shouldBlockResult(result), true)
    assert.equal(result.allMedia.length, 0)
    assert.equal(calls, 1)
  }))
})

test("X sensitive comments are gated only when selected for display and never start media downloads", async () => {
  const safe = tweet("2", { legacy: { full_text: "Safe reply", in_reply_to_status_id_str: "1" } })
  const restricted = tweet("3", { legacy: { full_text: "Reply image", in_reply_to_status_id_str: "1", possibly_sensitive: true,
    extended_entities: { media: [{ type: "photo", media_url_https: picture }] } } })
  const payload = commentPayload([tweet("1"), safe, restricted])
  await withConfig({ parser_r18_filter_enabled: true, parser_r18_platforms: ["twitter"], parser_block_x_sensitive: true, parser_max_comments: 0 }, async () => {
    const parser = new TwitterParser()
    assert.equal(shouldBlockResult(parser.collectEasyComment(payload, "1")), false)
    config.parser_max_comments = 1
    const first = parser.collectEasyComment(payload, "1")
    assert.equal(first.comments.length, 1)
    assert.equal(shouldBlockResult(first), false)
    config.parser_max_comments = 2
    const both = parser.collectEasyComment(payload, "1")
    assert.equal(shouldBlockResult(both), true)
    assert.equal(both.comments[1].content.find(item => item instanceof ImageContent).pathTask.promise, null)
    assert.equal(both.comments[1].author.avatar.promise, null)
  })
})

test("X comment replies and quoted visibility warnings recursively strengthen whole-result safety", async () => {
  const parent = tweet("2", { legacy: { full_text: "Safe reply", in_reply_to_status_id_str: "1" } })
  const child = tweet("3", {
    legacy: { full_text: "Nested reply", in_reply_to_status_id_str: "2" },
    quoted_status_result: { result: { __typename: "TweetWithVisibilityResults",
      tweet: tweet("4"), tweetInterstitial: { text: { text: "Adult content" } } } },
  })
  await withConfig({ parser_max_comments: 1, parser_r18_filter_enabled: true, parser_r18_platforms: ["twitter"], parser_block_x_sensitive: false }, async () => {
    const result = new TwitterParser().collectEasyComment(commentPayload([tweet("1"), parent, child]), "1")
    assert.equal(result.comments[0].replies.length, 1)
    assert.equal(result.safety.rating, "adult")
    assert.equal(shouldBlockResult(result), true)
  })
})

test("TapTap current image fields and fallback arrays produce unique original image media", async () => {
  const urls = [1, 2, 3, 4].map(id => "https://media.invalid/image-" + id + ".jpg")
  await withConfig({ parser_max_comments: 0 }, () => withHttp({ json: async url => {
    assert.ok(url.endsWith("moment/v3/detail"))
    return { data: { moment: { id_str: "1", author: {}, topic: { images: [{ url: urls[3] }, { image: { url: urls[0] } }] } },
      first_post: { contents: { json: [
        { type: "image", info: { img_url: urls[0] } },
        { type: "image", info: { img_url: "https://media.invalid/thumbnail.jpg", image: { original_url: urls[1] } } },
        { type: "image", info: { image: { url: urls[2] } } },
      ] }, images: [{ original_url: urls[1] }, { url: urls[3] }], footer_images: [{ original_url: urls[0] }] },
    } }
  } }, async () => {
    const result = await new TapTapParser().parse(["", "1"])
    assert.deepEqual(result.imageContents.map(item => item.pathTask.url), urls)
    assert.equal(result.imageContents.every(item => item.pathTask.promise === null), true)
  }))
})

let failures = 0
for (const item of cases) {
  try { await item.run(); process.stdout.write("✓ " + item.name + "\n") }
  catch (error) { failures++; console.error("✗ " + item.name); console.error(error) }
}
process.stdout.write((cases.length - failures) + "/" + cases.length + " platform tests passed\n")
if (failures) process.exitCode = 1
