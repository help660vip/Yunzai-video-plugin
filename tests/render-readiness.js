import assert from "node:assert/strict"
import { browserManager } from "../lib/render/browser-manager.js"
import { waitForPageAssets } from "../lib/render/readiness.js"

let polls = 0, cleanup = 0
const started = Date.now()
await waitForPageAssets({
  async evaluate(fn) {
    if (fn.toString().includes("querySelectorAll")) { cleanup++; return }
    return ++polls >= 3
  },
}, { timeoutMs: 500, pollMs: 5 })
assert.equal(polls, 3)
assert.equal(cleanup, 1)
assert(Date.now() - started < 500)
console.log("PASS resource polling stops when browser-owned state becomes ready")

polls = 0; cleanup = 0
const stalled = Date.now()
await waitForPageAssets({
  async evaluate(fn) {
    if (fn.toString().includes("querySelectorAll")) { cleanup++; return }
    polls++; return false
  },
}, { timeoutMs: 40, pollMs: 5 })
assert(polls >= 2)
assert.equal(cleanup, 1)
assert(Date.now() - stalled >= 35 && Date.now() - stalled < 1000)
console.log("PASS stalled images/fonts obey the Node-side deadline")

await assert.rejects(() => waitForPageAssets({
  async evaluate() { throw new Error("page closed") },
}), /page closed/)
console.log("PASS page failures remain visible to renderer fallback")

let enteredPage = false
try {
  await browserManager.withPage(null, async page => {
    enteredPage = true
    await page.setJavaScriptEnabled(false)
    await page.setRequestInterception(true)
    page.on("request", request => {
      if (request.url().startsWith("https://emoji.invalid/")) return
      void request.continue()
    })
    await page.setContent('<html><body><img class="emoji" src="https://emoji.invalid/pending" alt="⚠️"><script>window.untrustedExecuted=true</script></body></html>', { waitUntil: "domcontentloaded" })
    const before = Date.now()
    await waitForPageAssets(page, { timeoutMs: 180, pollMs: 30 })
    assert(Date.now() - before >= 150 && Date.now() - before < 3000)
    const fallback = await page.evaluate(() => ({ text: document.body.textContent, images: document.images.length, scriptRan: Boolean(window.untrustedExecuted) }))
    assert(fallback.text.includes("⚠️"))
    assert.equal(fallback.images, 0)
    assert.equal(fallback.scriptRan, false)
    console.log("PASS real browser: pending emoji falls back while page scripts stay disabled")

    await page.setContent('<html><body><img class="emoji" src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%221%22 height=%221%22%3E%3C/svg%3E" alt="ok"></body></html>', { waitUntil: "domcontentloaded" })
    await waitForPageAssets(page, { timeoutMs: 1000, pollMs: 30 })
    const loaded = await page.evaluate(() => ({ images: document.images.length, width: document.images[0]?.naturalWidth }))
    assert.equal(loaded.images, 1)
    assert.equal(loaded.width, 1)
    console.log("PASS real browser: successfully loaded emoji images are preserved")
  })
} catch (error) {
  if (enteredPage) throw error
  console.log("SKIP real-browser readiness check: no usable local browser")
} finally {
  await browserManager.close()
}
