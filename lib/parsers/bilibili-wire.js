import protobuf from "protobufjs"

// Minimal wire contracts for the fields this client consumes. Names belong to
// this plugin's data model; unknown platform fields are skipped by protobufjs.
// No generated client, schema files or runtime from another project is required.
const layouts = {
  VideoRequest: { aid: [1, "int64"], bvid: [2, "string"] },
  VideoResponse: { video: [1, "VideoMeta"], pages: [2, "VideoPage", true], bvid: [14, "string"], error: [28, "int32"] },
  VideoMeta: { aid: [1, "int64"], cover: [6, "string"], title: [7, "string"], published: [8, "int64"], description: [10, "string"], duration: [16, "int64"], author: [22, "Profile"], counts: [23, "VideoCounts"] },
  Profile: { id: [1, "int64"], name: [2, "string"], avatar: [3, "string"], bio: [11, "string"] },
  VideoCounts: { views: [2, "int32"], danmaku: [3, "int32"], comments: [4, "int32"], favorites: [5, "int32"], coins: [6, "int32"], shares: [7, "int32"], likes: [10, "int32"] },
  VideoPage: { video: [1, "PageMeta"] },
  PageMeta: { cid: [1, "int64"], index: [2, "int32"], title: [4, "string"], duration: [5, "int64"], cover: [10, "string"] },
  PlaybackRequest: { aid: [1, "int64"], cid: [2, "int64"], quality: [3, "int64"], flags: [5, "int32"], download: [6, "uint32"], hostMode: [7, "int32"], allow4k: [8, "bool"], source: [9, "string"], previous: [10, "string"], codec: [12, "int32"] },
  PlaybackResponse: { media: [1, "PlaybackMedia"] },
  PlaybackMedia: { quality: [1, "uint32"], format: [2, "string"], milliseconds: [3, "uint64"], codec: [4, "uint32"], video: [5, "VideoTrack", true], audio: [6, "AudioTrack", true], dolby: [7, "ExtraAudio"], lossless: [9, "ExtraAudio"] },
  VideoTrack: { info: [1, "TrackQuality"], dash: [2, "VideoSource"], segments: [3, "SegmentList"] },
  TrackQuality: { quality: [1, "uint32"], format: [2, "string"], description: [3, "string"], vipRequired: [6, "bool"], loginRequired: [7, "bool"] },
  VideoSource: { url: [1, "string"], backups: [2, "string", true], bitrate: [3, "uint32"], codec: [4, "uint32"], size: [6, "uint64"] },
  SegmentList: { items: [1, "SegmentSource", true] },
  SegmentSource: { index: [1, "uint32"], duration: [2, "uint64"], size: [3, "uint64"], url: [4, "string"], backups: [5, "string", true] },
  AudioTrack: { quality: [1, "uint32"], url: [2, "string"], backups: [3, "string", true], bitrate: [4, "uint32"], codec: [5, "uint32"], size: [7, "uint64"] },
  ExtraAudio: { audio: [2, "AudioTrack"] },
  PostRequest: { userId: [1, "int64"], id: [2, "string"], shareId: [8, "string"], shareMode: [9, "int32"], timezone: [10, "int32"], player: [7, "PlayerOptions"] },
  PlayerOptions: { quality: [1, "int64"], flags: [3, "int64"] },
  PostResponse: { post: [1, "Post"] },
  Post: { kind: [1, "int32"], blocks: [3, "PostBlock", true], identity: [4, "PostIdentity"] },
  PostIdentity: { id: [1, "string"], url: [15, "string"] },
  PostBlock: { author: [2, "PostAuthor"], description: [4, "PostDescription"], media: [5, "PostMedia"], counts: [9, "PostCounts"], forwardAuthor: [13, "ForwardAuthor"], footer: [20, "PostFooter"], forwardCounts: [21, "PostCounts"], summary: [30, "ArticleSummary"], paragraph: [32, "ArticleBlock"] },
  PostAuthor: { id: [1, "int64"], dateLabel: [2, "string"], profile: [3, "Profile"], location: [14, "string"] },
  PostDescription: { nodes: [1, "DescriptionNode", true], text: [3, "string"] },
  DescriptionNode: { text: [1, "string"], kind: [2, "int32"], url: [3, "string"], icon: [6, "string"], size: [11, "int32"] },
  PostCounts: { shares: [1, "int64"], likes: [2, "int64"], comments: [3, "int64"] },
  PostFooter: { counts: [1, "PostCounts"] },
  ForwardAuthor: { labels: [1, "Label", true], id: [3, "int64"], dateLabel: [4, "string"], avatar: [6, "string"] },
  Label: { text: [1, "string"], url: [2, "string"] },
  PostMedia: { video: [2, "VideoCard"], series: [3, "SeriesCard"], forwarded: [6, "ForwardCard"], gallery: [7, "ImageList"], article: [8, "ArticleCard"], music: [9, "MusicCard"], generic: [10, "GenericCard"], live: [11, "LiveCard"], liveJson: [15, "JsonCard"] },
  VideoCard: { title: [1, "string"], cover: [2, "string"], aid: [7, "int64"], url: [21, "string"], bvid: [26, "string"] },
  SeriesCard: { title: [1, "string"], cover: [2, "string"], url: [20, "string"] },
  ForwardCard: { post: [1, "Post"] },
  ImageList: { images: [1, "Picture", true] },
  Picture: { url: [1, "string"], width: [2, "int64"], height: [3, "int64"] },
  ArticleCard: { id: [1, "int64"], title: [3, "string"], description: [4, "string"], covers: [5, "string", true] },
  MusicCard: { title: [4, "string"], cover: [5, "string"] },
  GenericCard: { title: [3, "string"], description: [4, "string"], cover: [5, "string"] },
  LiveCard: { id: [1, "int64"], url: [2, "string"], title: [3, "string"], cover: [4, "string"] },
  JsonCard: { json: [1, "string"] },
  ArticleRequest: { kind: [1, "int32"], id: [2, "int64"], shareId: [4, "string"], shareMode: [9, "int32"], timezone: [10, "int32"], player: [11, "PlayerOptions"] },
  ArticleResponse: { article: [1, "Article"] },
  Article: { id: [1, "int64"], kind: [2, "int32"], originalId: [3, "int64"], blocks: [4, "PostBlock", true], identity: [5, "PostIdentity"] },
  ArticleSummary: { heading: [1, "Paragraph"], body: [2, "Paragraph"], images: [4, "Picture", true] },
  ArticleBlock: { paragraph: [1, "Paragraph"], heading: [2, "bool"] },
  Paragraph: { text: [3, "TextNodes"], pictures: [4, "PictureBlock"], divider: [5, "PictureDivider"] },
  TextNodes: { nodes: [1, "TextNode", true] },
  TextNode: { raw: [2, "string"], word: [3, "Word"], sticker: [4, "InlineSticker"], link: [5, "InlineLink"] },
  Word: { text: [1, "string"] },
  InlineSticker: { label: [1, "Word"], url: [2, "string"] },
  InlineLink: { label: [1, "Word"], url: [2, "string"] },
  PictureBlock: { gallery: [1, "ImageList"] },
  PictureDivider: { picture: [1, "Picture"] },
  UserPostsRequest: { id: [1, "int64"], cursor: [2, "string"], timezone: [4, "int32"], page: [5, "int64"] },
  UserPostsResponse: { posts: [1, "Post", true], cursor: [2, "string"], hasMore: [3, "bool"] },
  CommentsRequest: { id: [1, "int64"], kind: [2, "int64"], cursor: [3, "CommentCursor"], extra: [4, "string"], filter: [8, "string"] },
  CommentCursor: { next: [1, "int64"], mode: [4, "int32"] },
  CommentsResponse: { replies: [2, "Reply", true], pinned: [4, "Reply"], top: [14, "Reply", true] },
  Reply: { replies: [1, "Reply", true], id: [2, "int64"], likes: [9, "int64"], published: [10, "int64"], count: [11, "int64"], body: [12, "ReplyBody"], author: [13, "ReplyAuthor"], context: [14, "ReplyContext"] },
  ReplyBody: { text: [1, "string"], emotes: [3, "ReplySticker", "map"], pictures: [9, "ReplyImage", true] },
  ReplySticker: { size: [1, "int64"], url: [2, "string"], text: [8, "string"] },
  ReplyImage: { url: [1, "string"] },
  ReplyAuthor: { id: [1, "int64"], name: [2, "string"], avatar: [4, "string"] },
  ReplyContext: { location: [25, "string"] },
  Session: { accessKey: [1, "string"], app: [2, "string"], build: [4, "int32"], channel: [5, "string"], deviceId: [6, "string"], platform: [7, "string"] },
  Device: { appId: [1, "int32"], build: [2, "int32"], deviceId: [3, "string"], app: [4, "string"], platform: [5, "string"], channel: [7, "string"], brand: [8, "string"], model: [9, "string"], os: [10, "string"] },
  Environment: { app: [1, "string"], environment: [2, "string"] },
  Locale: { client: [1, "Language"], server: [2, "Language"] },
  Language: { language: [1, "string"], region: [3, "string"] },
  Network: { kind: [1, "int32"], operator: [3, "string"] },
}
let root
export function biliWireType(name) {
  if (!root) {
    root = new protobuf.Root()
    for (const [typeName, fields] of Object.entries(layouts)) {
      const type = new protobuf.Type(typeName)
      for (const [fieldName, [id, kind, repeated]] of Object.entries(fields)) {
        type.add(repeated === "map"
          ? new protobuf.MapField(fieldName, id, "string", kind)
          : new protobuf.Field(fieldName, id, kind, repeated ? "repeated" : undefined))
      }
      root.add(type)
    }
    root.resolveAll()
  }
  return root.lookupType(name)
}
