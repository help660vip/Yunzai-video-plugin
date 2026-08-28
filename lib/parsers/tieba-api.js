import { config } from "../core/config.js"
import { http } from "../core/http.js"
import { decodeProto, encodeProto, loadProto } from "./codec.js"
import { OpenGraphParser, cleanText } from "./shared.js"

const TIEBA_PROTO = `
syntax = "proto3";
message CommonReq { int32 _client_type = 1; string _client_version = 2; }
message PbPageReqIdl {
  message DataReq {
    CommonReq common = 25; int64 kz = 4; int32 lz = 5; int32 r = 6;
    int64 pid = 7; int32 with_floor = 8; int32 floor_rn = 9;
    int32 rn = 13; int32 pn = 18; int32 floor_sort_type = 74;
  }
  DataReq data = 1;
}
message Error { int32 errorno = 1; string errmsg = 2; }
message Agree { int64 agree_num = 1; int64 disagree_num = 4; }
message SimpleForum {
  int64 id = 1; string name = 2; string first_class = 7; string second_class = 8;
  int32 member_num = 12; int32 post_num = 13;
}
message User {
  message Icon { string name = 1; }
  message PrivSets { int32 location = 1; int32 like = 2; int32 reply = 7; }
  message UserGrowth { int32 level_id = 1; }
  int64 id = 2; string name = 3; string name_show = 4; string portrait = 5;
  repeated Icon iconinfo = 17; int32 level_id = 23; int32 is_bawu = 25;
  string intro = 34; int32 gender = 42; PrivSets priv_sets = 45;
  string tieba_uid = 120; string ip_address = 127; UserGrowth user_growth = 137;
}
message PbContent {
  message TiebaPlusInfo { string title = 1; string desc = 2; string jump_url = 3; string app_icon = 6; }
  uint32 type = 1; string text = 2; string link = 3; string src = 4; string bsize = 5;
  string cdn_src = 8; string big_cdn_src = 9; string c = 11; uint32 during_time = 13;
  int64 uid = 15; uint32 width = 18; uint32 height = 19; string origin_src = 25;
  uint32 origin_size = 27; TiebaPlusInfo tiebaplus_info = 40;
}
message PollInfo {
  message PollOption { int64 num = 2; string text = 3; }
  int32 is_multi = 2; int64 total_num = 3; repeated PollOption options = 9;
  int64 total_poll = 11; string title = 12;
}
message VideoInfo {
  string video_url = 2; uint32 video_duration = 3; uint32 video_width = 4;
  uint32 video_height = 5; string thumbnail_url = 6; int32 play_count = 10;
}
message ThreadInfo {
  message OriginThreadInfo {
    string title = 1; string fname = 4; string tid = 5; int64 fid = 7;
    VideoInfo video_info = 13; repeated PbContent content = 14; PollInfo poll_info = 21; int64 pid = 25;
  }
  int64 id = 1; string title = 3; int32 reply_num = 4; int32 view_num = 5;
  User author = 18; int32 thread_type = 26; int64 fid = 27; string fname = 28;
  int32 create_time = 45; int64 post_id = 52; int64 author_id = 56;
  PollInfo poll_info = 74; VideoInfo video_info = 79; Agree agree = 126;
  int32 share_num = 135; OriginThreadInfo origin_thread_info = 141;
  repeated PbContent first_post_content = 142; int32 is_share_thread = 143;
}
message SubPostList {
  int64 id = 1; repeated PbContent content = 2; uint32 time = 3;
  int64 author_id = 4; string title = 5; uint32 floor = 6; User author = 7; Agree agree = 9;
}
message Post {
  message SubPost { repeated SubPostList sub_post_list = 2; }
  message SignatureContent { int32 type = 1; string text = 2; }
  message SignatureData { repeated SignatureContent content = 4; }
  message ChatContent { string bot_uk = 1; }
  message SpriteMemeInfo { int64 meme_id = 1; }
  int64 id = 1; uint32 floor = 3; uint32 time = 4; repeated PbContent content = 5;
  uint32 sub_post_number = 13; SubPost sub_post_list = 15; int64 author_id = 19;
  SignatureData signature = 21; User author = 23; Agree agree = 37;
  int64 tid = 46; ChatContent chat_content = 78; SpriteMemeInfo sprite_meme_info = 79;
}
message Page {
  int32 page_size = 1; int32 current_page = 3; int32 total_count = 4;
  int32 total_page = 5; int32 has_more = 6; int32 has_prev = 7;
}
message PbPageResIdl {
  message DataRes {
    SimpleForum forum = 2; Page page = 3; repeated Post post_list = 6;
    ThreadInfo thread = 8; repeated User user_list = 13; int64 thread_freq_num = 37;
  }
  Error error = 1; DataRes data = 2;
}
`

const ROOT = loadProto(TIEBA_PROTO, "tieba.proto")
const REFERER = { referer: "https://tieba.baidu.com/" }

function portrait(value) {
  const name = String(value || "").replace(/\?.*$/, "")
  return name ? "https://tb.himg.baidu.com/sys/portraith/item/" + name : null
}

function createAuthor(parser, value = {}) {
  return parser.createAuthor(value.name_show || value.name || "", portrait(value.portrait), value.intro, REFERER, {
    id: value.tieba_uid || value.id || value.portrait,
    location: value.ip_address,
  })
}

function contents(parser, parts = []) {
  const output = []
  let buffer = ""
  const flush = () => {
    const text = cleanText(buffer)
    if (text) output.push(text)
    buffer = ""
  }
  for (const part of parts) {
    const type = Number(part.type)
    if (type === 0) buffer += part.text || ""
    else if (type === 2 || type === 11) {
      flush()
      output.push(parser.createSticker(
        "https://gsp0.baidu.com/5aAHeD3nKhI2p27j8IqW0jdnxx1xbK/tb/editor/images/client/" +
          encodeURIComponent(part.text) +
          ".png",
        "small", part.c,
      ))
    } else if (type === 3 || type === 20) {
      const url = part.origin_src || part.big_cdn_src || part.cdn_src || part.src
      if (url) {
        flush()
        output.push(parser.createGraphic(url, null, { headers: REFERER }))
      }
    } else if (type === 4) buffer += "@" + (part.text || "") + " "
    else if (type === 1 && (part.link || part.text)) {
      flush()
      const url = part.link || part.text
      output.push(parser.createLink(url, { title: part.text || url }))
    }
    else if (type === 5 && part.src) {
      flush()
      output.push(parser.createVideo(part.src, null, part.during_time, { headers: REFERER }))
    } else if ([35, 36, 37].includes(type) && part.tiebaplus_info?.jump_url) {
      flush()
      output.push(parser.createLink(part.tiebaplus_info.jump_url, {
        title: part.tiebaplus_info.title,
        description: part.tiebaplus_info.desc,
        iconUrl: part.tiebaplus_info.app_icon,
      }))
    }
  }
  flush()
  return output
}

function poll(parser, value) {
  if (!value?.options?.length) return null
  return parser.createPoll({
    title: value.title,
    options: value.options.map(option => ({ text: option.text, votes: option.num })),
    totalVotes: value.total_num,
    totalVoters: value.total_poll,
    multiple: Boolean(value.is_multi),
  })
}

function commentNode(parser, post, users, parentAuthor = null) {
  const rawAuthor = post.author?.id ? post.author : users.get(String(post.author_id)) || {}
  const nodeAuthor = createAuthor(parser, rawAuthor)
  const content = contents(parser, post.content)
  const signature = cleanText((post.signature?.content || [])
    .filter(item => Number(item.type) === 0).map(item => item.text).join(""))
  if (signature) content.push(signature)
  const node = parser.createComment({
    author: nodeAuthor,
    parentAuthor,
    content,
    timestamp: post.time,
    stats: parser.createStats({
      likeCount: post.agree?.agree_num,
      commentCount: post.sub_post_number,
    }),
  })
  node.replies = (post.sub_post_list?.sub_post_list || []).slice(0, 3).map(reply =>
    commentNode(parser, reply, users, nodeAuthor),
  )
  return node
}

function buildComments(parser, data, thread) {
  const users = new Map((data.user_list || []).map(user => [String(user.id), user]))
  const rows = (data.post_list || []).filter(post =>
    !post.chat_content?.bot_uk && String(post.id) !== String(thread.post_id) && Number(post.floor) !== 1,
  )
  return rows.slice(0, config.parser_max_comments).map(post =>
    commentNode(parser, post, users),
  )
}

async function fetchPost(postId) {
  const protobuf = encodeProto(ROOT, "PbPageReqIdl", {
    data: {
      common: { _client_type: 2, _client_version: "12.64.1.1" },
      kz: Number(postId), pn: 1, rn: 30, r: 0, lz: 0,
      with_floor: 1, floor_rn: 4, floor_sort_type: 1,
    },
  })
  const boundary = "-*_r1999"
  const body = Buffer.concat([
    Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="data"; filename="file"\r\n\r\n'),
    Buffer.from(protobuf),
    Buffer.from("\r\n--" + boundary + "--\r\n"),
  ])
  const response = await http.buffer("http://tiebac.baidu.com/c/f/pb/page", {
    method: "POST",
    params: { cmd: 302001 },
    body,
    headers: {
      "x_bd_data_type": "protobuf",
      "accept-encoding": "gzip",
      "user-agent": "miku/39",
      "content-type": "multipart/form-data; boundary=" + boundary,
    },
  })
  const value = decodeProto(ROOT, "PbPageResIdl", response)
  if (value.error?.errorno) throw new Error(value.error.errmsg || "贴吧接口返回错误")
  return value.data
}

export class TiebaApiParser extends OpenGraphParser {
  static platform = { name: "tieba", displayName: "百度贴吧" }
  static handlers = [{
    keyword: "tieba.baidu.com",
    pattern: /tieba\.baidu\.com\/p\/\d+[^\s<]*/i,
    method: "parse",
  }]

  async parse(match) {
    const postId = /\/p\/(\d+)/.exec(match[0])?.[1]
    if (!postId) return super.parse(match)
    try {
      const data = await fetchPost(postId)
      const thread = data.thread || {}
      const first = (data.post_list || []).find(post =>
        String(post.id) === String(thread.post_id) || Number(post.floor) === 1,
      ) || data.post_list?.[0] || {}
      const source = thread.origin_thread_info || {}
      const parts = source.content?.length
        ? source.content
        : thread.first_post_content?.length
          ? thread.first_post_content
          : first.content || []
      const content = contents(this, parts)
      const video = source.video_info?.video_url ? source.video_info : thread.video_info
      if (video?.video_url) {
        content.push(this.createVideo(video.video_url, video.thumbnail_url, video.video_duration, {
          headers: REFERER,
        }))
      }
      const vote = poll(this, source.poll_info?.options?.length ? source.poll_info : thread.poll_info)
      if (vote) content.push(vote)
      const title = cleanText(thread.title || source.title)
      if (title && !content.some(item => typeof item === "string" && item === title)) content.unshift(title)
      return this.result({
        contentId: postId,
        title,
        author: createAuthor(this, thread.author || first.author),
        content,
        text: content.filter(item => typeof item === "string").join("\n"),
        timestamp: thread.create_time || first.time,
        url: "https://tieba.baidu.com/p/" + postId,
        stats: this.createStats({
          viewCount: data.thread_freq_num || thread.view_num,
          likeCount: thread.agree?.agree_num,
          commentCount: thread.reply_num,
          shareCount: thread.share_num,
        }),
        comments: buildComments(this, data, thread),
        extra: { forum: { name: data.forum?.name, id: data.forum?.id } },
      })
    } catch {
      return super.parse(match)
    }
  }
}

export const tiebaInternals = Object.freeze({ contents, buildComments })
