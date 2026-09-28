import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import YAML from "yaml"

import {
  config,
  configPath,
  DEFAULT_CONFIG,
  onConfigChange,
  reloadConfig,
  saveConfig,
} from "../lib/core/config.js"
import { clearRegistryForTests, matchUrl, registerParser } from "../lib/core/registry.js"
import { YouTubeParser } from "../lib/parsers/youtube.js"
import {
  GUOBA_SECRET_MASK,
  guobaSchemas,
  supportGuoba,
} from "../guoba.support.js"

const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "yunzai-guoba-"))
const temporaryConfig = path.join(temporaryDir, "config.yaml")
const initial = {
  ...DEFAULT_CONFIG,
  parser_bili_ck: "fixture-cookie-value",
  preserved_unknown_key: "keep",
}
fs.writeFileSync(temporaryConfig, YAML.stringify(initial), "utf8")

let updates = 0
const stop = onConfigChange(() => {
  updates += 1
})

try {
  reloadConfig(temporaryConfig)

  const schemaFields = new Set(guobaSchemas.map(item => item.field).filter(Boolean))
  assert.deepEqual(
    Object.keys(DEFAULT_CONFIG).filter(key => !schemaFields.has(key)),
    [],
    "锅巴 schema 必须覆盖全部配置",
  )

  const support = supportGuoba()
  const formData = support.configInfo.getConfigData()
  assert.equal(formData.parser_bili_ck, GUOBA_SECRET_MASK)
  assert.equal(JSON.stringify(formData).includes("fixture-cookie-value"), false)

  let captured
  const Result = {
    ok(data, message) {
      return { ok: true, data, message }
    },
    error(data, message) {
      return { ok: false, data, message }
    },
  }
  const saved = supportGuoba({
    save(patch) {
      captured = patch
    },
  }).configInfo.setConfigData(
    {
      parser_bili_ck: GUOBA_SECRET_MASK,
      parser_max_size: 91,
    },
    { Result },
  )
  assert.equal(saved.ok, true)
  assert.deepEqual(captured, { parser_max_size: 91 })

  const beforeSave = updates
  saveConfig({ parser_max_size: 92 }, temporaryConfig)
  assert.equal(config.parser_max_size, 92)
  assert.equal(updates, beforeSave + 1)
  assert.equal(
    YAML.parse(fs.readFileSync(temporaryConfig, "utf8")).preserved_unknown_key,
    "keep",
  )

  const beforeInvalid = fs.readFileSync(temporaryConfig, "utf8")
  assert.throws(
    () => saveConfig({ parser_max_size: "invalid" }, temporaryConfig),
    /parser_max_size/,
  )
  assert.equal(fs.readFileSync(temporaryConfig, "utf8"), beforeInvalid)
  assert.equal(config.parser_max_size, 92)

  clearRegistryForTests()
  registerParser(YouTubeParser)
  assert.ok(matchUrl("https://youtu.be/abcdefghijk"))
  saveConfig({ parser_disabled_platforms: ["youtube"] }, temporaryConfig)
  assert.equal(matchUrl("https://youtu.be/abcdefghijk"), null)
  saveConfig({ parser_disabled_platforms: [] }, temporaryConfig)
  assert.ok(matchUrl("https://youtu.be/abcdefghijk"))

  globalThis.plugin = class {
    constructor(options) {
      Object.assign(this, options)
    }
  }
  const entry = await import("../index.js?guoba-hot-config-test")
  const commands = new entry.ParserCommandPlugin()
  saveConfig(
    {
      parser_lazy_download: true,
      parser_download_command: ["grab"],
    },
    temporaryConfig,
  )
  assert.ok(commands.rule.some(rule => rule.fnc === "lazyDownload" && rule.reg.includes("grab")))
  saveConfig({ parser_lazy_download: false }, temporaryConfig)
  assert.equal(commands.rule.some(rule => rule.fnc === "lazyDownload"), false)
  delete globalThis.plugin

  console.log("✓ 锅巴 schema、敏感值遮罩、原子保存及平台热启停")
} finally {
  stop()
  reloadConfig(configPath)
  fs.rmSync(temporaryDir, { recursive: true, force: true })
}
