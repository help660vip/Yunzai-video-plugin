import { setTimeout as delay } from "node:timers/promises"

// Page timers and load callbacks can stop running when page scripts are disabled.
// Keep the deadline in Node and only query browser-owned image/font state.
export async function waitForPageAssets(page, { timeoutMs = 8000, pollMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (true) {
    const ready = await page.evaluate(() =>
      [...document.images].every(image => image.complete) &&
      (!document.fonts || document.fonts.status === "loaded"),
    )
    if (ready || Date.now() >= deadline) break
    await delay(Math.min(pollMs, Math.max(0, deadline - Date.now())))
  }
  await page.evaluate(() => {
    for (const image of document.querySelectorAll("img.emoji")) {
      if (!image.complete || !image.naturalWidth) {
        const fallback = document.createTextNode(image.alt || "")
        image.removeAttribute("src")
        image.replaceWith(fallback)
      }
    }
  })
}
