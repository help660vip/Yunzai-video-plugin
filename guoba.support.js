import {
  config,
  DEFAULT_CONFIG,
  PLATFORM_NAMES,
  saveConfig,
} from "./lib/core/config.js"

export const GUOBA_SECRET_MASK = "••••••••"

const SECRET_FIELDS = new Set([
  "parser_bili_ck",
  "parser_ytb_ck",
  "parser_xhs_ck",
  "parser_zhihu_ck",
  "parser_linuxdo_ck",
  "parser_proxy",
])

const platformOptions = PLATFORM_NAMES.map(value => ({ label: value, value }))
const switchField = (field, label, bottomHelpMessage) => ({
  field,
  label,
  component: "Switch",
  bottomHelpMessage,
})
const numberField = (field, label, min, max, addonAfter) => ({
  field,
  label,
  component: "InputNumber",
  required: true,
  componentProps: { min, max, ...(addonAfter ? { addonAfter } : {}) },
})
const inputField = (field, label, options = {}) => ({
  field,
  label,
  component: "Input",
  componentProps: {
    ...(options.secret ? { type: "password", autocomplete: "new-password" } : {}),
    ...(options.placeholder ? { placeholder: options.placeholder } : {}),
  },
  bottomHelpMessage: options.help,
})
const tagsField = (field, label, options = [], help) => ({
  field,
  label,
  component: "Select",
  componentProps: { mode: "tags", options },
  bottomHelpMessage: help,
})
const multiField = (field, label, options, help) => ({
  field,
  label,
  component: "Select",
  componentProps: { mode: "multiple", options },
  bottomHelpMessage: help,
})
const group = label => ({ label, component: "SOFT_GROUP_BEGIN" })

export const guobaSchemas = [
  group("基础与发送"),
  switchField("parser_need_upload", "音视频上传总开关", "兼容旧配置；独立开关显式设置后优先。"),
  switchField("parser_need_upload_audio", "额外上传音频文件"),
  switchField("parser_need_upload_video", "额外上传视频文件"),
  switchField("parser_use_base64", "媒体转 Base64", "仅跨机器人的协议端可能需要。"),
  numberField("parser_max_size", "单个媒体上限", 1, 2048, "MB"),
  numberField("parser_duration_maximum", "媒体时长上限", 1, 86400, "秒"),
  switchField("parser_append_url", "附加原始链接"),
  switchField("parser_embed_url", "附加播放链接"),
  switchField("parser_append_qrcode", "附加链接二维码"),
  switchField("parser_need_forward_contents", "图文使用合并转发"),
  numberField("parser_forward_text_threshold", "长文本转发阈值", 0, 4500),
  numberField("parser_max_comments", "最大评论数", 0, 20),
  numberField("parser_max_retries", "下载重试次数", 0, 20),
  switchField("parser_live_photo", "转换 Live Photo"),

  group("平台与访问控制"),
  multiField("parser_disabled_platforms", "禁用平台", platformOptions),
  tagsField("parser_blacklist_users", "用户黑名单", [], "可填写其他机器人 QQ 号，名单内消息不会解析。"),
  switchField("parser_group_blacklist_enabled", "群黑名单模式", "开启时名单内关闭；关闭时名单内开启。"),
  switchField("parser_lazy_download", "懒下载模式"),
  switchField("parser_lazy_download_tip", "显示懒下载提示"),
  numberField("parser_lazy_download_timeout", "懒下载有效期", 1, 3600, "秒"),
  tagsField("parser_download_command", "懒下载命令"),

  group("账号、Cookie 与网络"),
  inputField("parser_bili_ck", "B站 Cookie", { secret: true }),
  inputField("parser_ytb_ck", "YouTube Cookie", { secret: true }),
  inputField("parser_xhs_ck", "小红书 Cookie", { secret: true }),
  inputField("parser_zhihu_ck", "知乎 Cookie", { secret: true }),
  inputField("parser_linuxdo_ck", "Linux Do Cookie", { secret: true }),
  inputField("parser_proxy", "YouTube/TikTok 代理", {
    secret: true,
    placeholder: "http://127.0.0.1:7890",
  }),

  group("B站下载"),
  multiField("parser_bili_video_codes", "视频编码优先级", [
    { label: "AVC", value: "avc" },
    { label: "AV1", value: "av01" },
    { label: "HEVC", value: "hev" },
    { label: "未知", value: "unknown" },
  ]),
  {
    field: "parser_bili_video_quality",
    label: "视频清晰度",
    component: "Select",
    componentProps: {
      options: [16, 32, 64, 80, 112, 116, 120].map(value => ({
        label: String(value),
        value,
      })),
    },
  },
  inputField("parser_bili_cdn_region", "CDN 地区"),
  inputField("parser_bili_cdn_domain", "自定义 bilivideo.com CDN"),

  group("渲染"),
  {
    field: "parser_render_type",
    label: "渲染方式",
    component: "Select",
    componentProps: {
      options: ["default", "common", "htmlrender", "htmlkit"].map(value => ({
        label: value,
        value,
      })),
    },
  },
  inputField("parser_custom_font", "自定义字体文件"),
  numberField("parser_custom_font_weight", "标题字体粗细", 100, 1000),
  inputField("parser_emoji_cdn", "Emoji CDN"),
  {
    field: "parser_emoji_style",
    label: "Emoji 样式",
    component: "Select",
    componentProps: {
      options: ["apple", "google", "twitter", "facebook"].map(value => ({
        label: value,
        value,
      })),
    },
  },
  tagsField("parser_day_range", "白天主题时间", [], "恰好填写开始和结束两个 HH:mm 值。"),

  group("海外 R18 安全"),
  switchField("parser_r18_filter_enabled", "启用海外 R18 拦截"),
  multiField("parser_r18_platforms", "检查平台", platformOptions, "国内平台默认不进入关键词或 R18 判断。"),
  switchField("parser_block_x_sensitive", "拦截 X 敏感标记"),

  group("缓存与防重复"),
  numberField("parser_cache_retention_hours", "缓存保留时间", 1, 8760, "小时"),
  numberField("parser_cache_max_mb", "缓存容量上限", 1, 1048576, "MB"),
  switchField("parser_dedup_enabled", "同群内容去重"),
  numberField("parser_dedup_window_seconds", "去重窗口", 1, 3600, "秒"),
]

function getConfigData() {
  const data = {}
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    const value = config[key]
    data[key] = SECRET_FIELDS.has(key) && value ? GUOBA_SECRET_MASK : structuredCloneValue(value)
  }
  return data
}

function structuredCloneValue(value) {
  if (Array.isArray(value)) return [...value]
  if (value && typeof value === "object") return { ...value }
  return value
}

function preparePatch(data) {
  const patch = {}
  for (const [key, value] of Object.entries(data || {})) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_CONFIG, key)) continue
    if (SECRET_FIELDS.has(key)) {
      if (value === GUOBA_SECRET_MASK) continue
      patch[key] = value === "" || value === undefined ? null : value
      continue
    }
    patch[key] = value
  }
  return patch
}

function errorResult(Result, message) {
  if (typeof Result?.error === "function") return Result.error({}, message)
  if (typeof Result?.err === "function") return Result.err({}, message)
  throw new Error(message)
}

export function supportGuoba({ save = saveConfig } = {}) {
  return {
    pluginInfo: {
      name: "yunzai-video-plugin",
      title: "Yunzai Video Plugin",
      description: "32个平台的链接、视频、图文与音乐解析插件",
      author: "@help660vip",
      authorLink: "https://github.com/help660vip",
      link: "https://github.com/help660vip/Yunzai-video-plugin",
      isV3: true,
      isV2: false,
      showInMenu: true,
      icon: "mdi:video-wireless",
      iconColor: "#d94b40",
    },
    configInfo: {
      schemas: guobaSchemas,
      getConfigData,
      setConfigData(data, { Result }) {
        try {
          save(preparePatch(data))
          return Result.ok({}, "保存成功，配置已热更新")
        } catch (error) {
          return errorResult(Result, "保存失败：" + (error?.message || error))
        }
      },
    },
  }
}
