import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { http } from "../lib/core/http.js"
import { clearRegistryForTests, matchUrl, registerParser } from "../lib/core/registry.js"
import { QQMusicParser } from "../lib/parsers/music.js"
import {
  MapCipher,
  QmcCipher,
  Rc4Cipher,
  decryptQqMusicFile,
  deriveQmcKey,
  simpleMakeKey,
  teaDecryptBlock,
  validateQqAudio,
} from "../lib/parsers/qqmusic-qmc.js"

const cases = []
const test = (name, run) => cases.push({ name, run })

function teaEncryptBlock(block, key) {
  let v0 = block.readUInt32BE(0)
  let v1 = block.readUInt32BE(4)
  const k0 = key.readUInt32BE(0)
  const k1 = key.readUInt32BE(4)
  const k2 = key.readUInt32BE(8)
  const k3 = key.readUInt32BE(12)
  const delta = 0x9e3779b9
  let sum = 0
  for (let round = 0; round < 16; round += 1) {
    sum = (sum + delta) >>> 0
    const v0Part = (
      ((((v1 << 4) >>> 0) + k0) >>> 0) ^
      ((v1 + sum) >>> 0) ^
      (((v1 >>> 5) + k1) >>> 0)
    ) >>> 0
    v0 = (v0 + v0Part) >>> 0
    const v1Part = (
      ((((v0 << 4) >>> 0) + k2) >>> 0) ^
      ((v0 + sum) >>> 0) ^
      (((v0 >>> 5) + k3) >>> 0)
    ) >>> 0
    v1 = (v1 + v1Part) >>> 0
  }
  const output = Buffer.alloc(8)
  output.writeUInt32BE(v0, 0)
  output.writeUInt32BE(v1, 4)
  return output
}

function xorBlock(left, right) {
  const output = Buffer.alloc(8)
  for (let index = 0; index < 8; index += 1) output[index] = left[index] ^ right[index]
  return output
}

function encryptTencentTea(payload, key) {
  const padding = (8 - ((payload.length + 10) % 8)) % 8
  const plain = Buffer.concat([
    Buffer.from([0xf8 | padding]),
    Buffer.from(Array.from({ length: padding }, (_, index) => 0xa0 + index)),
    Buffer.from([0x12, 0x34]),
    payload,
    Buffer.alloc(7),
  ])
  const output = []
  let previousCipher = Buffer.alloc(8)
  let previousDecrypted = Buffer.alloc(8)
  for (let position = 0; position < plain.length; position += 8) {
    const block = plain.subarray(position, position + 8)
    const encrypted = teaEncryptBlock(xorBlock(block, previousCipher), key)
    const cipher = xorBlock(encrypted, previousDecrypted)
    output.push(cipher)
    previousDecrypted = xorBlock(block, previousCipher)
    previousCipher = cipher
  }
  return Buffer.concat(output)
}

function makeEkey(finalKey, version = 1) {
  const seed = finalKey.subarray(0, 8)
  const simple = simpleMakeKey(106, 8)
  const teaKey = Buffer.alloc(16)
  for (let index = 0; index < 8; index += 1) {
    teaKey[index * 2] = simple[index]
    teaKey[index * 2 + 1] = seed[index]
  }
  const v1 = Buffer.concat([seed, encryptTencentTea(finalKey.subarray(8), teaKey)])
  if (version === 1) return v1.toString("base64")
  const deriveKey2 = Buffer.from("2a2a232128232425265e6131635a2c54", "hex")
  const deriveKey1 = Buffer.from("3338365a4a592140232a24255e262928", "hex")
  const second = encryptTencentTea(Buffer.from(v1.toString("base64"), "ascii"), deriveKey2)
  const first = encryptTencentTea(second, deriveKey1)
  return Buffer.concat([Buffer.from("QQMusic EncV2,Key:", "ascii"), first]).toString("base64")
}

test("QMC primitives match fixed reference vectors", () => {
  assert.equal(simpleMakeKey(106, 8).toString("hex"), "695646382b20150b")
  assert.equal(
    teaDecryptBlock(Buffer.from("0011223344556677", "hex"), Buffer.from([...Array(16).keys()])).toString("hex"),
    "d0388edb0c5ef8b4",
  )
  const mapped = Buffer.from([...Array(32).keys()])
  new MapCipher(Buffer.from([...Array(16).keys()].map(value => value + 1))).decrypt(mapped, 32760)
  assert.equal(mapped.toString("hex"), "3f83c2423b44c6858ac94b344dcd8c3092d1532c55d594289ad95b245ddd9c20")

  const rc4Key = Buffer.from(Array.from({ length: 320 }, (_, index) => (index * 7 + 3) & 0xff))
  const rc4Data = Buffer.from(Array.from({ length: 6000 }, (_, index) => (index * 11 + 5) & 0xff))
  new Rc4Cipher(rc4Key).decrypt(rc4Data, 0)
  assert.equal(
    crypto.createHash("sha256").update(rc4Data).digest("hex"),
    "44eb36f3400923c5d6026e3b2fcbaaa79feac313312df9298044f465fa25bc2e",
  )
})

test("QMC v1 and v2 ekeys derive the complete cipher key", () => {
  const finalKey = Buffer.from(Array.from({ length: 96 }, (_, index) => (index * 13 + 17) & 0xff))
  assert.deepEqual(deriveQmcKey(makeEkey(finalKey, 1)), finalKey)
  assert.deepEqual(deriveQmcKey(makeEkey(finalKey, 2)), finalKey)
  assert.throws(() => deriveQmcKey("not-base64!"), /Base64/)
})

test("QQ Music decrypted containers receive strict audio validation", () => {
  assert.equal(validateQqAudio(Buffer.from("fLaC fixture"), ".flac"), true)
  assert.equal(validateQqAudio(Buffer.from("OggS fixture"), ".ogg"), true)
  assert.equal(validateQqAudio(Buffer.from("0000ftypM4A "), ".m4a"), true)
  assert.equal(validateQqAudio(Buffer.from("ID3 fixture"), ".mp3"), true)
  assert.equal(validateQqAudio(Buffer.from([0xff, 0xfb, 0x90, 0x64]), ".mp3"), true)
  assert.throws(() => validateQqAudio(Buffer.from("not audio"), ".ogg"), /不是有效/)
  assert.throws(() => validateQqAudio(Buffer.from("OggS fixture"), ".wav"), /不是有效/)
})

test("encrypted .mgg files are decrypted atomically to valid Ogg", async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "yunzai-qqmusic-"))
  try {
    const finalKey = Buffer.from(Array.from({ length: 80 }, (_, index) => (index * 5 + 7) & 0xff))
    const clear = Buffer.concat([Buffer.from("OggS"), Buffer.from(Array.from({ length: 124 }, (_, index) => index))])
    const encrypted = Buffer.from(clear)
    new QmcCipher(finalKey).decrypt(encrypted, 0)
    const source = path.join(directory, "fixture.mgg")
    await fs.promises.writeFile(source, encrypted)
    const output = await decryptQqMusicFile(source, makeEkey(finalKey))
    assert.equal(path.extname(output), ".ogg")
    assert.deepEqual(await fs.promises.readFile(output), clear)
    assert.equal(await decryptQqMusicFile(source, makeEkey(finalKey)), output)
    await fs.promises.writeFile(output, Buffer.from("invalid stale cache"))
    assert.equal(await decryptQqMusicFile(source, makeEkey(finalKey)), output)
    assert.deepEqual(await fs.promises.readFile(output), clear)
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true })
  }
})

test("QQ Music routes cover short, mid, numeric and constrained share pages", () => {
  clearRegistryForTests()
  registerParser(QQMusicParser)
  const cases = [
    ["https://c6.y.qq.com/base/fcgi-bin/u?__=R8HMYy74qYwf", "parseShort"],
    ["https://y.qq.com/n/ryqq_v2/songDetail/0039MnYb0qxYhV", "parseMid"],
    ["https://y.qq.com/n/yqq/song/000Vk1cS3DV3FI.html", "parseMid"],
    ["https://y.qq.com/n/ryqq_v2/songDetail/584161671", "parseSongId"],
    ["https://y.qq.com/n/yqq/song/584161671.html", "parseSongId"],
    ["https://i.y.qq.com/v8/playsong.html?songmid=0039MnYb0qxYhV", "parseMid"],
    ["https://i.y.qq.com/v8/playsong.html?songid=496932669", "parseSongId"],
    ["https://i2.y.qq.com/n3/other/pages/playsong/index.html?ADTAG=ryqq.songDetail&songmid=0039MnYb0qxYhV&songid=0", "parseMid"],
    ["https://i2.y.qq.com/n3/other/pages/playsong/index.html?ADTAG=ryqq.songDetail&songmid=&songid=584161671", "parseSongId"],
  ]
  for (const [url, method] of cases) assert.equal(matchUrl(url, QQMusicParser)?.method, method, url)
  assert.equal(
    matchUrl("https://i2.y.qq.com/n3/other/pages/playsong/index.html?ADTAG=wrong&songmid=0039MnYb0qxYhV", QQMusicParser),
    null,
  )
})

test("QQ Music metadata stays lazy until the audio task is requested", async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "yunzai-qqmusic-parser-"))
  const source = path.join(directory, "fixture.ogg")
  await fs.promises.writeFile(source, Buffer.from("OggS fixture"))
  const originalJson = http.json
  let downloads = 0
  const parser = new QQMusicParser()
  parser.downloader = {
    download: async (url, options) => {
      downloads += 1
      assert.equal(url, "https://media.invalid/fixture.ogg")
      assert.equal(options.suffix, ".ogg")
      assert.equal(options.cacheKey, "qqmusic:0039MnYb0qxYhV:source")
      return source
    },
  }
  http.json = async (url, options) => {
    assert.equal(url, "https://parse-api.sokoko.org/api/qq/song")
    assert.deepEqual(options.params, { music_id: "0039MnYb0qxYhV", quality: "high" })
    return {
      code: 200,
      data: {
        id: "0039MnYb0qxYhV",
        title: "Fixture Song",
        artist: "Fixture Artist",
        artist_pic: "https://img.invalid/artist.jpg",
        album: "Fixture Album",
        cover: "https://img.invalid/cover.jpg",
        download_url: "https://media.invalid/fixture.ogg",
        duration_seconds: 123,
        lyric: "fixture lyric",
        quality: { name: "高品质" },
        ekey: "",
      },
    }
  }
  try {
    const result = await parser.parseMusic("0039MnYb0qxYhV")
    assert.equal(result.contentId, "0039MnYb0qxYhV")
    assert.equal(result.title, "Fixture Song")
    assert.equal(result.author.name, "Fixture Artist")
    assert.equal(result.audioContents[0].duration, 123)
    assert.equal(result.audioContents[0].pathTask.promise, null)
    assert.equal(downloads, 0)
    assert.equal(await result.audioContents[0].pathTask.get(), source)
    assert.equal(downloads, 1)
  } finally {
    http.json = originalJson
    await fs.promises.rm(directory, { recursive: true, force: true })
  }
})

let failed = 0
for (const item of cases) {
  try {
    await item.run()
    console.log("ok - " + item.name)
  } catch (error) {
    failed += 1
    console.error("not ok - " + item.name)
    console.error(error)
  }
}
if (failed) process.exit(1)
console.log(`QQ Music suites passed (${cases.length})`)
