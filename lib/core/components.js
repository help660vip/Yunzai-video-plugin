import { config } from "./config.js"

export const SEND_COMPONENTS = Object.freeze(["card", "url", "embed", "content", "cover", "video", "audio"])

// Null retains legacy switches; an explicit list takes precedence at runtime.
export function sendComponent(name) {
  if (name === "card") return true
  if (Array.isArray(config.parser_send_components)) return config.parser_send_components.includes(name)
  if (name === "url") return config.parser_append_url
  if (name === "embed") return config.parser_embed_url
  return ["content", "cover", "video", "audio"].includes(name)
}

export function forwardComponent(name) {
  if (!sendComponent(name)) return false
  if (Array.isArray(config.parser_forward_components)) return config.parser_forward_components.includes(name)
  if (name === "card") return config.parser_summary_in_forward
  if (name === "video") return config.parser_video_in_forward
  if (name === "content" || name === "cover") return config.parser_need_forward_contents
  return false
}
