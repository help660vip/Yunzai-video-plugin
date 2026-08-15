import { unzipSync, strFromU8 } from "fflate"
import protobuf from "protobufjs"

export function loadProto(source, fileName = "inline.proto") {
  const root = new protobuf.Root()
  protobuf.parse(source, root, { filename: fileName, keepCase: true })
  return root
}

export function encodeProto(root, typeName, value) {
  const type = root.lookupType(typeName)
  const error = type.verify(value)
  if (error) throw new Error("Proto 参数无效: " + error)
  return type.encode(type.create(value)).finish()
}

export function decodeProto(root, typeName, buffer) {
  const type = root.lookupType(typeName)
  return type.toObject(type.decode(buffer), {
    longs: Number,
    enums: String,
    bytes: Buffer,
    defaults: true,
  })
}

export function unpackIlluPackage(buffer) {
  const files = unzipSync(new Uint8Array(buffer))
  const output = {}
  for (const [name, value] of Object.entries(files)) {
    output[name] = /\.(?:json|txt|html|md)$/i.test(name)
      ? strFromU8(value)
      : Buffer.from(value)
  }
  return output
}
