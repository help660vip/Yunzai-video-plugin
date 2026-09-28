import crypto from "node:crypto"
import http2 from "node:http2"
import zlib from "node:zlib"
import { biliWireType } from "./bilibili-wire.js"
import { ParseError } from "../core/errors.js"

// Bilibili client protocol constants are public protocol identifiers, not user credentials.
export const BILI_APP = Object.freeze({
  appkey: "dfca71928277209b",
  secret: "b5475a8825547a4fc26c7d518eaaa02e",
  build: 1450000,
  mobi_app: "android_hd",
  platform: "android",
  channel: "bili",
  statistics: '{"appId":5,"platform":3,"version":"1.45.0","abtest":""}',
})
const buvid = "XY" + crypto.randomBytes(18).toString("hex").slice(0, 35).toUpperCase()
export function biliProtoType(name) {
  return biliWireType(name)
}

export function signBiliApp(params, { common = true, now = Date.now() } = {}) {
  const values = {
    ...(common ? {
      build: BILI_APP.build, mobi_app: BILI_APP.mobi_app, platform: BILI_APP.platform,
      channel: BILI_APP.channel, c_locale: "zh_CN", s_locale: "zh_CN", statistics: BILI_APP.statistics,
    } : {}),
    ts: Math.floor(now / 1000),
    ...params,
    appkey: BILI_APP.appkey,
  }
  delete values.sign
  const query = Object.keys(values).filter(key => values[key] !== null && values[key] !== undefined).sort()
    .map(key => [key, String(values[key])])
  // The application signature keeps "~" literal within form-encoded queries.
  const encoded = new URLSearchParams(query).toString().replace(/%7E/gi, "~").replace(/\*/g, "%2A")
  return { ...Object.fromEntries(query), sign: crypto.createHash("md5").update(encoded + BILI_APP.secret).digest("hex") }
}

export function biliGrpcHeaders(accessKey = "", mid = null) {
  const encode = (name, data) => {
    const type = biliProtoType(name)
    return Buffer.from(type.encode(type.fromObject(data)).finish()).toString("base64").replace(/=+$/, "")
  }
  const common = { build: BILI_APP.build, app: BILI_APP.mobi_app, platform: BILI_APP.platform, channel: "bilibili140", deviceId: buvid }
  return {
    "content-type": "application/grpc",
    accept: "application/grpc",
    "user-agent": "Mozilla/5.0 BiliDroid/1.45.0 os/android model/2201123C mobi_app/android_hd build/1450000 channel/bili innerVer/1450000 osVer/12 network/2",
    "app-key": BILI_APP.mobi_app,
    "x-bili-device-bin": encode("Device", { ...common, appId: 5, brand: "Xiaomi", model: "2201123C", os: "12" }),
    "x-bili-metadata-bin": encode("Session", { ...common, accessKey }),
    "x-bili-fawkes-req-bin": encode("Environment", { app: BILI_APP.mobi_app, environment: "prod" }),
    "x-bili-locale-bin": encode("Locale", { client: { language: "zh", region: "CN" }, server: { language: "zh", region: "CN" } }),
    "x-bili-network-bin": encode("Network", { kind: 1, operator: "46007" }),
    "x-bili-restriction-bin": "",
    "grpc-accept-encoding": "identity,gzip,deflate", "grpc-timeout": "20100m", te: "trailers", env: "prod", buvid,
    ...(accessKey ? { authorization: "identify_v1 " + accessKey, ...(mid ? { "x-bili-mid": String(mid) } : {}) } : {}),
  }
}

export function decodeBiliFrame(body, encoding = "identity", maxBytes = 16 * 1024 * 1024) {
  if (body.length < 5) throw new ParseError("B站响应帧不完整")
  const size = body.readUInt32BE(1)
  if (size > maxBytes || size + 5 > body.length) throw new ParseError("B站响应长度无效")
  const data = body.subarray(5, 5 + size)
  if (body[0] === 0) return data
  if (body[0] !== 1 || !["gzip", "deflate"].includes(encoding)) throw new ParseError("B站响应压缩格式不受支持")
  return encoding === "gzip"
    ? zlib.gunzipSync(data, { maxOutputLength: maxBytes })
    : zlib.inflateSync(data, { maxOutputLength: maxBytes })
}

// Unary gRPC over Node's native HTTP/2; certificate validation remains enabled.
export async function biliGrpc(method, requestType, replyType, data, { accessKey = "", mid = null, timeout = 20100 } = {}) {
  if (!/^\/bilibili\.[\w.]+\/\w+$/.test(method)) throw new TypeError("无效的 B站 RPC 方法")
  const type = biliProtoType(requestType)
  const payload = Buffer.from(type.encode(type.fromObject(data)).finish())
  const frame = Buffer.allocUnsafe(payload.length + 5)
  frame[0] = 0
  frame.writeUInt32BE(payload.length, 1)
  payload.copy(frame, 5)
  const response = await new Promise((resolve, reject) => {
    const session = http2.connect("https://app.bilibili.com")
    let request, complete = false, headers = {}, trailers = {}, total = 0
    const chunks = []
    const finish = (error, value) => {
      if (complete) return
      complete = true
      clearTimeout(timer)
      request?.close()
      session.destroy()
      error ? reject(error) : resolve(value)
    }
    const timer = setTimeout(() => finish(new ParseError("B站接口请求超时")), timeout)
    session.on("error", () => finish(new ParseError("B站接口连接失败")))
    session.on("connect", () => {
      request = session.request({ ":method": "POST", ":path": method, ...biliGrpcHeaders(accessKey, mid) })
      request.on("response", value => { headers = value })
      request.on("trailers", value => { trailers = value })
      request.on("error", () => finish(new ParseError("B站接口响应失败")))
      request.on("data", chunk => {
        total += chunk.length
        if (total > 16 * 1024 * 1024) finish(new ParseError("B站接口响应超过限制"))
        else chunks.push(chunk)
      })
      request.on("end", () => {
        const status = Number(trailers["grpc-status"] ?? headers["grpc-status"] ?? 0)
        if (Number(headers[":status"]) !== 200 || status !== 0) {
          // Never include request headers or platform response text in a user-facing error.
          finish(new ParseError("B站接口暂不可用 (" + (status || headers[":status"]) + ")"))
        } else finish(null, { body: Buffer.concat(chunks), encoding: headers["grpc-encoding"] || "identity" })
      })
      request.end(frame)
    })
  })
  const reply = biliProtoType(replyType)
  return reply.toObject(reply.decode(decodeBiliFrame(response.body, response.encoding)), { longs: String, enums: Number, arrays: true, objects: true })
}

const ALPHABET = "FcwAPNKTMug3GV5Lj7EJnHpWsx4tb8haYeviqBz6rkCy12mUSDQX9RdoZf"
const ENCODE_MAP = [8, 7, 0, 5, 1, 3, 2, 4, 6]
export function bvToAv(bvid) {
  if (!/^BV1[0-9A-Za-z]{9}$/.test(bvid)) throw new TypeError("无效的 BV 号")
  let value = 0n
  for (const index of [...ENCODE_MAP].reverse()) {
    const digit = ALPHABET.indexOf(bvid[index + 3])
    if (digit < 0) throw new TypeError("无效的 BV 号")
    value = value * 58n + BigInt(digit)
  }
  return String((value & 2251799813685247n) ^ 23442827791579n)
}

export function avToBv(aid) {
  const id = BigInt(aid)
  if (id <= 0n || id >= 2251799813685248n) throw new TypeError("无效的 AV 号")
  let value = (2251799813685248n | id) ^ 23442827791579n
  const digits = []
  for (const index of ENCODE_MAP) { digits[index] = ALPHABET[Number(value % 58n)]; value /= 58n }
  return "BV1" + digits.join("")
}
