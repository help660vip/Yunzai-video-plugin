const DEFAULT_DOMAINS = Object.freeze({
  zh: "upos-sz-mirrorcos.bilivideo.com",
  en: "upos-sz-mirroraliov.bilivideo.com",
  ja: "upos-sz-mirroralib.bilivideo.com",
  proxy: "proxy-tf-all-ws.bilivideo.com",
})

const PCDN_PATTERN =
  /(?:\.mcdn\.bilivideo\.cn|szbdyd\.com|cos\.bilibili\.com\/.+pcdn|\.edge\.mountaintoys\.cn|xy\d+x\d+x\d+x\d+xy|\/pcdn\/|\/mcdn\/)/i
const PRIVATE_IP = /^https?:\/\/(?:10\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.|127\.)/i

export function validBiliCdnDomain(domain) {
  const value = String(domain || "").trim().toLowerCase()
  return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(value) &&
    (value === "bilivideo.com" || value.endsWith(".bilivideo.com"))
    ? value
    : null
}

export function isBiliPcdn(url) {
  if (!url) return false
  try {
    const parsed = new URL(String(url).includes("://") ? url : "https://" + String(url).replace(/^\/\//, ""))
    const host = parsed.hostname.toLowerCase().replace(/\.$/, "")
    return PCDN_PATTERN.test(url) || PRIVATE_IP.test(url) ||
      /^(?:\d{1,3}\.){3}\d{1,3}$/.test(host) || host.startsWith("[") ||
      /(?:\.mcdn\.bilivideo\.(?:cn|com|net)|\.szbdyd\.com|\.mountaintoys\.cn|\.nexusedgeio\.com|\.ahdohpiechei\.com)$/.test(host) ||
      host === "upos-sz-mirror14b.bilivideo.com" || parsed.searchParams.get("os")?.toLowerCase() === "mcdn" ||
      Boolean(parsed.port && !["80", "443"].includes(parsed.port)) ||
      (host.startsWith("upos-") && host.split(".")[0].includes("302"))
  } catch { return false }
}

export function biliSourceDomain(url) {
  try {
    const parsed = new URL(url)
    if (!parsed.hostname.toLowerCase().endsWith(".szbdyd.com")) return null
    const raw = parsed.searchParams.get("xy_usource") || ""
    const source = new URL(raw.includes("://") ? raw : "https://" + raw)
    return validBiliCdnDomain(source.hostname)
  } catch { return null }
}

function baseUrl(stream) {
  return stream?.baseUrl || stream?.base_url || stream?.url || null
}

function backups(stream) {
  return stream?.backupUrl || stream?.backup_url || stream?.backups || []
}

export function sanitizeBiliStreamUrls(stream, { region = "zh", domain = null } = {}) {
  if (!stream) return null
  const sourceUrls = [...new Set([baseUrl(stream), ...backups(stream)].filter(Boolean))]
  if (!sourceUrls.length) return []
  const cleanUrls = sourceUrls.filter(url => !isBiliPcdn(url))
  if (!cleanUrls.length) cleanUrls.push(sourceUrls[0])
  const replacement = biliSourceDomain(sourceUrls[0]) || validBiliCdnDomain(domain) || DEFAULT_DOMAINS[region] || DEFAULT_DOMAINS.zh
  const parsed = new URL(cleanUrls[0])
  parsed.host = replacement
  return [...new Set([parsed.href, ...cleanUrls])]
}

export async function probeBiliSourceSize(urls, headSize) {
  for (const url of urls || []) {
    try {
      const size = Number(await headSize(url))
      if (Number.isFinite(size) && size > 0) return size
    } catch {}
  }
  return null
}

export function sanitizeBiliStreamUrl(stream, options = {}) {
  return sanitizeBiliStreamUrls(stream, options)?.[0] || null
}
