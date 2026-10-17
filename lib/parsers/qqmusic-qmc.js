import fs from "node:fs"
import path from "node:path"

import { cacheLifecycle, temporaryCachePath } from "../core/cache-lifecycle.js"
import { safeUnlink } from "../core/utils.js"

// QMC key derivation and cipher behavior follows the publicly documented format
// and the MIT-licensed parser-lite reference credited by this project.

const QMC_V2_KEY_PREFIX = Buffer.from("QQMusic EncV2,Key:", "ascii")
const RC4_FIRST_SEGMENT_SIZE = 128
const RC4_SEGMENT_SIZE = 5120
const QMC_V2_DERIVE_KEY_1 = Buffer.from([
  0x33, 0x38, 0x36, 0x5a, 0x4a, 0x59, 0x21, 0x40,
  0x23, 0x2a, 0x24, 0x25, 0x5e, 0x26, 0x29, 0x28,
])
const QMC_V2_DERIVE_KEY_2 = Buffer.from([
  0x2a, 0x2a, 0x23, 0x21, 0x28, 0x23, 0x24, 0x25,
  0x26, 0x5e, 0x61, 0x31, 0x63, 0x5a, 0x2c, 0x54,
])
const OUTPUT_EXTENSIONS = Object.freeze({
  ".mflac": ".flac",
  ".mgg": ".ogg",
  ".mmp4": ".m4a",
  ".flac": ".flac",
  ".ogg": ".ogg",
  ".m4a": ".m4a",
  ".mp3": ".mp3",
})

export class QmcError extends Error {
  constructor(message) {
    super(message)
    this.name = "QmcError"
  }
}

function ensureBuffer(value, label) {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  if (typeof value === "string") return Buffer.from(value, "ascii")
  throw new QmcError(`${label} 必须是字节数据`)
}

function decodeBase64(value, label) {
  const encoded = ensureBuffer(value, label).toString("ascii").replace(/\s+/g, "")
  if (!encoded || encoded.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new QmcError(`${label} 不是有效的 Base64 数据`)
  }
  const decoded = Buffer.from(encoded, "base64")
  if (!decoded.length) throw new QmcError(`${label} 解码结果为空`)
  return decoded
}

export function simpleMakeKey(salt, length) {
  const key = Buffer.alloc(length)
  for (let index = 0; index < length; index += 1) {
    const value = Math.abs(Math.tan(Number(salt) + index * 0.1)) * 100
    key[index] = (Number.isFinite(value) ? Math.trunc(value) : Number.MAX_SAFE_INTEGER) & 0xff
  }
  return key
}

export function teaDecryptBlock(blockValue, keyValue) {
  const block = ensureBuffer(blockValue, "TEA 数据块")
  const key = ensureBuffer(keyValue, "TEA 密钥")
  if (block.length < 8) throw new QmcError("无效的 TEA 数据块")
  if (key.length < 16) throw new QmcError("无效的 TEA 密钥")
  let v0 = block.readUInt32BE(0)
  let v1 = block.readUInt32BE(4)
  const k0 = key.readUInt32BE(0)
  const k1 = key.readUInt32BE(4)
  const k2 = key.readUInt32BE(8)
  const k3 = key.readUInt32BE(12)
  const delta = 0x9e3779b9
  let sum = Math.imul(delta, 16) >>> 0
  for (let round = 0; round < 16; round += 1) {
    const v1Part = (
      ((((v0 << 4) >>> 0) + k2) >>> 0) ^
      ((v0 + sum) >>> 0) ^
      (((v0 >>> 5) + k3) >>> 0)
    ) >>> 0
    v1 = (v1 - v1Part) >>> 0
    const v0Part = (
      ((((v1 << 4) >>> 0) + k0) >>> 0) ^
      ((v1 + sum) >>> 0) ^
      (((v1 >>> 5) + k1) >>> 0)
    ) >>> 0
    v0 = (v0 - v0Part) >>> 0
    sum = (sum - delta) >>> 0
  }
  const output = Buffer.allocUnsafe(8)
  output.writeUInt32BE(v0, 0)
  output.writeUInt32BE(v1, 4)
  return output
}

function xorEight(left, right) {
  if (left.length < 8 || right.length < 8) throw new QmcError("无效的 TEA 链数据")
  const output = Buffer.allocUnsafe(8)
  for (let index = 0; index < 8; index += 1) output[index] = left[index] ^ right[index]
  return output
}

export function decryptTencentTea(inputValue, keyValue) {
  const input = ensureBuffer(inputValue, "腾讯 TEA 数据")
  const key = ensureBuffer(keyValue, "腾讯 TEA 密钥")
  if (input.length % 8 !== 0) throw new QmcError("腾讯 TEA 数据长度不是 8 的倍数")
  if (input.length < 16) throw new QmcError("腾讯 TEA 数据过短")

  let decryptedBlock = teaDecryptBlock(input.subarray(0, 8), key)
  const paddingLength = decryptedBlock[0] & 7
  const outputLength = input.length - 1 - paddingLength - 2 - 7
  if (outputLength < 0) throw new QmcError("无效的腾讯 TEA 填充长度")
  const output = Buffer.alloc(outputLength)
  let previousCipher = Buffer.alloc(8)
  let currentCipher = Buffer.from(input.subarray(0, 8))
  let inputPosition = 8
  let blockPosition = 1 + paddingLength

  const decryptNextBlock = () => {
    previousCipher = currentCipher
    if (inputPosition + 8 > input.length) throw new QmcError("腾讯 TEA 数据意外结束")
    currentCipher = Buffer.from(input.subarray(inputPosition, inputPosition + 8))
    decryptedBlock = teaDecryptBlock(xorEight(decryptedBlock, currentCipher), key)
    inputPosition += 8
    blockPosition = 0
  }

  for (let saltIndex = 0; saltIndex < 2;) {
    if (blockPosition < 8) {
      blockPosition += 1
      saltIndex += 1
    } else {
      decryptNextBlock()
    }
  }
  for (let outputPosition = 0; outputPosition < outputLength;) {
    if (blockPosition < 8) {
      output[outputPosition] = decryptedBlock[blockPosition] ^ previousCipher[blockPosition]
      blockPosition += 1
      outputPosition += 1
    } else {
      decryptNextBlock()
    }
  }
  for (let zeroIndex = 0; zeroIndex < 7;) {
    if (blockPosition < 8) {
      if (decryptedBlock[blockPosition] !== previousCipher[blockPosition]) {
        throw new QmcError("腾讯 TEA 结尾校验失败")
      }
      blockPosition += 1
      zeroIndex += 1
    } else {
      decryptNextBlock()
    }
  }
  return output
}

export function deriveKeyV1(rawValue) {
  const raw = ensureBuffer(rawValue, "QMC v1 密钥")
  if (raw.length < 16) throw new QmcError("QMC 密钥长度过短")
  const simpleKey = simpleMakeKey(106, 8)
  const teaKey = Buffer.alloc(16)
  for (let index = 0; index < 8; index += 1) {
    teaKey[index * 2] = simpleKey[index]
    teaKey[index * 2 + 1] = raw[index]
  }
  return Buffer.concat([raw.subarray(0, 8), decryptTencentTea(raw.subarray(8), teaKey)])
}

export function deriveKeyV2(rawValue) {
  const raw = ensureBuffer(rawValue, "QMC v2 密钥")
  let buffer
  try {
    buffer = decryptTencentTea(raw, QMC_V2_DERIVE_KEY_1)
    buffer = decryptTencentTea(buffer, QMC_V2_DERIVE_KEY_2)
  } catch (error) {
    throw new QmcError(`QMC v2 TEA 解密失败: ${error.message}`)
  }
  return decodeBase64(buffer, "QMC v2 派生密钥")
}

export function deriveQmcKey(rawKey) {
  let decoded = decodeBase64(rawKey, "QMC ekey")
  if (decoded.subarray(0, QMC_V2_KEY_PREFIX.length).equals(QMC_V2_KEY_PREFIX)) {
    decoded = deriveKeyV2(decoded.subarray(QMC_V2_KEY_PREFIX.length))
  }
  return deriveKeyV1(decoded)
}

function assertCipherInput(buffer, offset) {
  if (!(buffer instanceof Uint8Array)) throw new QmcError("QMC 解密目标必须是字节数据")
  if (!Number.isSafeInteger(offset) || offset < 0) throw new QmcError("无效的 QMC 文件偏移量")
}

export class MapCipher {
  constructor(keyValue) {
    this.key = Buffer.from(ensureBuffer(keyValue, "QMC map 密钥"))
    if (!this.key.length) throw new QmcError("QMC map 密钥不能为空")
    this.size = this.key.length
  }

  static rotate(value, bits) {
    const rotate = (bits + 4) % 8
    return (((value << rotate) & 0xff) | (value >>> rotate)) & 0xff
  }

  getMask(offset) {
    const normalized = offset > 0x7fff ? offset % 0x7fff : offset
    const index = ((normalized * normalized) + 71214) % this.size
    return MapCipher.rotate(this.key[index], index & 7)
  }

  decrypt(buffer, offset = 0) {
    assertCipherInput(buffer, offset)
    for (let index = 0; index < buffer.length; index += 1) {
      buffer[index] ^= this.getMask(offset + index)
    }
  }
}

export class Rc4Cipher {
  constructor(keyValue) {
    this.key = Buffer.from(ensureBuffer(keyValue, "QMC rc4 密钥"))
    if (!this.key.length) throw new QmcError("QMC rc4 密钥不能为空")
    this.size = this.key.length
    this.boxState = new Uint8Array(this.size)
    for (let index = 0; index < this.size; index += 1) this.boxState[index] = index & 0xff
    let cursor = 0
    for (let index = 0; index < this.size; index += 1) {
      cursor = (cursor + this.boxState[index] + this.key[index % this.size]) % this.size
      const value = this.boxState[index]
      this.boxState[index] = this.boxState[cursor]
      this.boxState[cursor] = value
    }
    this.hash = Rc4Cipher.getHashBase(this.key)
  }

  static getHashBase(keyValue) {
    const key = ensureBuffer(keyValue, "QMC rc4 密钥")
    let result = 1
    for (const value of key) {
      if (value === 0) continue
      const next = (result * value) >>> 0
      if (next === 0 || next <= result) break
      result = next
    }
    return result
  }

  getSegmentSkip(segmentId) {
    const seed = this.key[segmentId % this.size]
    if (seed === 0) return 0
    return Math.trunc((this.hash / ((segmentId + 1) * seed)) * 100) % this.size
  }

  decryptFirstSegment(buffer, offset) {
    for (let index = 0; index < buffer.length; index += 1) {
      buffer[index] ^= this.key[this.getSegmentSkip(offset + index)]
    }
  }

  decryptSegment(buffer, offset) {
    const box = Uint8Array.from(this.boxState)
    let first = 0
    let second = 0
    const skip = (offset % RC4_SEGMENT_SIZE) + this.getSegmentSkip(Math.floor(offset / RC4_SEGMENT_SIZE))
    for (let index = 0; index < skip + buffer.length; index += 1) {
      first = (first + 1) % this.size
      second = (box[first] + second) % this.size
      const value = box[first]
      box[first] = box[second]
      box[second] = value
      if (index >= skip) {
        buffer[index - skip] ^= box[(box[first] + box[second]) % this.size]
      }
    }
  }

  decrypt(buffer, offset = 0) {
    assertCipherInput(buffer, offset)
    let remaining = buffer.length
    let processed = 0
    if (offset < RC4_FIRST_SEGMENT_SIZE) {
      const length = Math.min(remaining, RC4_FIRST_SEGMENT_SIZE - offset)
      this.decryptFirstSegment(buffer.subarray(processed, processed + length), offset)
      offset += length
      remaining -= length
      processed += length
      if (remaining === 0) return
    }
    if (offset % RC4_SEGMENT_SIZE !== 0) {
      const length = Math.min(remaining, RC4_SEGMENT_SIZE - (offset % RC4_SEGMENT_SIZE))
      this.decryptSegment(buffer.subarray(processed, processed + length), offset)
      offset += length
      remaining -= length
      processed += length
      if (remaining === 0) return
    }
    while (remaining > RC4_SEGMENT_SIZE) {
      this.decryptSegment(buffer.subarray(processed, processed + RC4_SEGMENT_SIZE), offset)
      offset += RC4_SEGMENT_SIZE
      remaining -= RC4_SEGMENT_SIZE
      processed += RC4_SEGMENT_SIZE
    }
    if (remaining > 0) this.decryptSegment(buffer.subarray(processed), offset)
  }
}

export class QmcCipher {
  constructor(keyValue) {
    const key = ensureBuffer(keyValue, "QMC 密钥")
    if (!key.length) throw new QmcError("QMC 密钥不能为空")
    this.cipher = key.length > 300 ? new Rc4Cipher(key) : new MapCipher(key)
  }

  decrypt(buffer, offset = 0) {
    this.cipher.decrypt(buffer, offset)
  }
}

function crc(data, bits, polynomial) {
  let value = 0
  const mask = (1 << bits) - 1
  for (const byte of data) {
    value ^= byte << (bits - 8)
    for (let index = 0; index < 8; index += 1) {
      value = ((value << 1) ^ ((value & (1 << (bits - 1))) ? polynomial : 0)) & mask
    }
  }
  return value
}

function flacFrameSamples(data, fixedBlock) {
  if (data.length < 7 || data[0] !== 0xff || (data[1] & 0xfe) !== 0xf8 || (data[3] & 1)) return null
  let position = 4
  const first = data[position]
  let number
  if (first < 0x80) {
    number = first
    position += 1
  } else {
    let count = 0
    while (count < 8 && (first & (0x80 >>> count))) count += 1
    if (count < 2 || count > 7 || data.length <= position + count) return null
    number = first & (0x7f >>> count)
    for (const byte of data.subarray(position + 1, position + count)) {
      if ((byte & 0xc0) !== 0x80) return null
      number = number * 64 + (byte & 0x3f)
    }
    position += count
  }
  const blockCode = data[2] >>> 4
  const rateCode = data[2] & 0xf
  if (blockCode === 0 || rateCode === 15) return null
  let samples
  if (blockCode === 1) samples = 192
  else if (blockCode >= 2 && blockCode <= 5) samples = 576 << (blockCode - 2)
  else if (blockCode === 6) {
    if (data.length <= position) return null
    samples = data[position] + 1
    position += 1
  } else if (blockCode === 7) {
    if (data.length <= position + 1) return null
    samples = data.readUInt16BE(position) + 1
    position += 2
  } else {
    samples = 256 << (blockCode - 8)
  }
  position += rateCode === 12 ? 1 : (rateCode === 13 || rateCode === 14 ? 2 : 0)
  if (data.length <= position || crc(data.subarray(0, position + 1), 8, 0x07)) return null
  return [(data[1] & 1) ? number : number * fixedBlock, samples]
}

async function removeFlacTrailer(filePath) {
  const handle = await fs.promises.open(filePath, "r+")
  try {
    const header = Buffer.alloc(42)
    const { bytesRead } = await handle.read(header, 0, header.length, 0)
    if (
      bytesRead !== 42 || !header.subarray(0, 4).equals(Buffer.from("fLaC")) ||
      (header[4] & 0x7f) !== 0 || !header.subarray(5, 8).equals(Buffer.from([0, 0, 0x22]))
    ) return 0
    const info = header.subarray(8, 42)
    const totalSamples = info.readBigUInt64BE(10) & ((1n << 36n) - 1n)
    const fixedBlock = info.readUInt16BE(2)
    const maxFrame = info.readUIntBE(7, 3) || 1024 * 1024
    const { size } = await handle.stat()
    const start = Math.max(42, size - maxFrame - 30)
    const tail = Buffer.alloc(size - start)
    await handle.read(tail, 0, tail.length, start)
    for (let index = 0; index < tail.length - 30; index += 1) {
      if (tail[index] !== 0xff) continue
      const sampleInfo = flacFrameSamples(tail.subarray(index), fixedBlock)
      if (!sampleInfo || BigInt(sampleInfo[0] + sampleInfo[1]) !== totalSamples) continue
      if (crc(tail.subarray(index), 16, 0x8005) === 0) return 0
      if (tail.length - index > 32 && crc(tail.subarray(index, -30), 16, 0x8005) === 0) {
        await handle.truncate(size - 30)
        return 30
      }
    }
    return 0
  } finally {
    await handle.close()
  }
}

export function validateQqAudio(headerValue, extension) {
  const header = ensureBuffer(headerValue, "QQ音乐音频头")
  const suffix = String(extension).toLowerCase()
  const valid = {
    ".flac": header.subarray(0, 4).equals(Buffer.from("fLaC")),
    ".ogg": header.subarray(0, 4).equals(Buffer.from("OggS")),
    ".m4a": header.length >= 8 && header.subarray(4, 8).equals(Buffer.from("ftyp")),
    ".mp3": header.subarray(0, 3).equals(Buffer.from("ID3")) ||
      (header.length >= 2 && header[0] === 0xff && (header[1] & 0xe0) === 0xe0),
  }
  if (!Object.prototype.hasOwnProperty.call(valid, suffix) || !valid[suffix]) {
    throw new QmcError(`QQ音乐解密结果不是有效的 ${suffix || "未知格式"} 文件`)
  }
  return true
}

export function qqMusicOutputExtension(sourcePath) {
  return OUTPUT_EXTENSIONS[path.extname(String(sourcePath)).toLowerCase()] || null
}

export async function decryptQqMusicFile(sourcePath, ekey = "") {
  const source = path.resolve(sourcePath)
  const extension = qqMusicOutputExtension(source)
  if (!extension) throw new QmcError(`不支持的 QQ音乐源文件后缀: ${path.extname(source) || "(无)"}`)
  const parsed = path.parse(source)
  const target = path.join(parsed.dir, `${parsed.name}.decrypted${extension}`)
  try {
    const existing = await fs.promises.readFile(target)
    validateQqAudio(existing.subarray(0, 16), extension)
    await cacheLifecycle.touch(target)
    return target
  } catch (error) {
    if (error?.code !== "ENOENT" && !(error instanceof QmcError)) throw error
    if (error instanceof QmcError) await safeUnlink(target)
  }

  const temporary = temporaryCachePath(target)
  return cacheLifecycle.withActive([source, target, temporary], async () => {
    try {
      const decrypted = Buffer.from(await fs.promises.readFile(source))
      if (ekey) new QmcCipher(deriveQmcKey(ekey)).decrypt(decrypted, 0)
      validateQqAudio(decrypted.subarray(0, 16), extension)
      await fs.promises.mkdir(path.dirname(target), { recursive: true })
      await fs.promises.writeFile(temporary, decrypted, { flag: "wx" })
      if (extension === ".flac") await removeFlacTrailer(temporary)
      try {
        await fs.promises.rename(temporary, target)
      } catch (error) {
        if (!fs.existsSync(target)) throw error
        await safeUnlink(temporary)
      }
      await cacheLifecycle.touch(target)
      return target
    } catch (error) {
      await safeUnlink(temporary)
      throw error
    }
  })
}
