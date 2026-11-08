// Read only image headers; media rendering must not require a native image module.
const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])

function exifOrientation(data) {
  try {
    if (data.subarray(0, 6).toString("binary") === "Exif\0\0") data = data.subarray(6)
    const little = data.subarray(0, 2).toString() === "II"
    if (!little && data.subarray(0, 2).toString() !== "MM") return 1
    const u16 = offset => little ? data.readUInt16LE(offset) : data.readUInt16BE(offset)
    const u32 = offset => little ? data.readUInt32LE(offset) : data.readUInt32BE(offset)
    if (u16(2) !== 42) return 1
    const start = u32(4), entries = Math.min(u16(start), 256)
    for (let index = 0; index < entries; index++) {
      const offset = start + 2 + index * 12
      if (u16(offset) === 274 && u16(offset + 2) === 3 && u32(offset + 4) === 1) return u16(offset + 8)
    }
  } catch {}
  return 1
}

export function imageDimensions(input) {
  const data = Buffer.from(input || [])
  let width, height, orientation = 1
  try {
    if (data.length >= 24 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      width = data.readUInt32BE(16); height = data.readUInt32BE(20)
      for (let offset = 8; offset + 12 <= data.length;) {
        const length = data.readUInt32BE(offset)
        if (length > data.length - offset - 12) break
        if (data.subarray(offset + 4, offset + 8).toString() === "eXIf") orientation = exifOrientation(data.subarray(offset + 8, offset + 8 + length))
        offset += length + 12
      }
    } else if (data.length >= 10 && /^GIF8[79]a$/.test(data.subarray(0, 6).toString())) {
      width = data.readUInt16LE(6); height = data.readUInt16LE(8)
    } else if (data.length >= 12 && data.subarray(0, 4).toString() === "RIFF" && data.subarray(8, 12).toString() === "WEBP") {
      for (let offset = 12; offset + 8 <= data.length;) {
        const type = data.subarray(offset, offset + 4).toString(), length = data.readUInt32LE(offset + 4), start = offset + 8
        if (length > data.length - start) break
        if (type === "VP8X" && length >= 10) {
          width = data.readUIntLE(start + 4, 3) + 1; height = data.readUIntLE(start + 7, 3) + 1
        } else if (type === "VP8 " && length >= 10 && data.subarray(start + 3, start + 6).equals(Buffer.from([0x9d, 1, 0x2a]))) {
          width ??= data.readUInt16LE(start + 6) & 0x3fff; height ??= data.readUInt16LE(start + 8) & 0x3fff
        } else if (type === "VP8L" && length >= 5 && data[start] === 0x2f) {
          const bits = data.readUInt32LE(start + 1)
          width ??= (bits & 0x3fff) + 1; height ??= ((bits >>> 14) & 0x3fff) + 1
        } else if (type === "EXIF") orientation = exifOrientation(data.subarray(start, start + length))
        offset = start + length + (length & 1)
      }
    } else if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
      for (let offset = 2; offset < data.length;) {
        if (data[offset++] !== 0xff) break
        while (data[offset] === 0xff) offset++
        const marker = data[offset++]
        if (marker === 0xda || marker === 0xd9) break
        if (marker === 1 || marker >= 0xd0 && marker <= 0xd7) continue
        const length = data.readUInt16BE(offset)
        if (length < 2 || length > data.length - offset) break
        if (SOF.has(marker) && length >= 7) {
          height = data.readUInt16BE(offset + 3); width = data.readUInt16BE(offset + 5)
        } else if (marker === 0xe1) orientation = exifOrientation(data.subarray(offset + 2, offset + length))
        offset += length
      }
    } else {
      const svg = data.subarray(0, 65536).toString("utf8").match(/<svg\b([^>]*)>/i)?.[1]
      if (svg) {
        width = Number(svg.match(/\bwidth\s*=\s*["']([\d.]+)(?:px)?["']/i)?.[1])
        height = Number(svg.match(/\bheight\s*=\s*["']([\d.]+)(?:px)?["']/i)?.[1])
        const box = svg.match(/\bviewBox\s*=\s*["']\s*[-\d.]+[ ,]+[-\d.]+[ ,]+([\d.]+)[ ,]+([\d.]+)\s*["']/i)
        if (!(width > 0) || !(height > 0)) { width = Number(box?.[1]); height = Number(box?.[2]) }
      }
    }
  } catch { return {} }
  if (!(width > 0 && height > 0 && Number.isFinite(width * height))) return {}
  if ([5, 6, 7, 8].includes(orientation)) [width, height] = [height, width]
  return { width, height, aspect_ratio: width / height, orientation: height / width >= 0.9 ? "portrait" : "landscape" }
}

export const WEBP_MAX_DIMENSION = 16383

export function effectiveRenderFormat(format, dimensions) {
  const selected = format === "auto" ? "webp" : format
  return selected === "webp" && Math.max(dimensions.width || 0, dimensions.height || 0) > WEBP_MAX_DIMENSION ? "jpeg" : selected
}
