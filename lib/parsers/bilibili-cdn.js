const DEFAULT_DOMAINS = Object.freeze({
  zh: "upos-sz-mirrorcos.bilivideo.com",
  en: "upos-sz-mirroraliov.bilivideo.com",
  ja: "upos-sz-mirroralib.bilivideo.com",
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
  return Boolean(url && (PCDN_PATTERN.test(url) || PRIVATE_IP.test(url)))
}

function baseUrl(stream) {
  return stream?.baseUrl || stream?.base_url || null
}

function backups(stream) {
  return stream?.backupUrl || stream?.backup_url || []
}

export function sanitizeBiliStreamUrl(stream, { region = "zh", domain = null } = {}) {
  if (!stream) return null
  let source = baseUrl(stream)
  if (isBiliPcdn(source)) {
    source = backups(stream).find(url => !isBiliPcdn(url)) || source
  }
  if (!source) return null
  const replacement = validBiliCdnDomain(domain) || DEFAULT_DOMAINS[region] || DEFAULT_DOMAINS.zh
  const parsed = new URL(source)
  parsed.host = replacement
  return parsed.href
}
