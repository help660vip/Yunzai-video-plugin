// Capture bounded tiles instead of creating a single oversized browser bitmap.
export const MAX_RENDER_PIXELS = 32000000
export const MAX_RENDER_HEIGHT = 24000

export async function captureLongCard(page, selector = ".result") {
  const bounds = await page.$eval(selector, element => {
    const rect = element.getBoundingClientRect()
    return { x: rect.x + window.scrollX, y: rect.y + window.scrollY, width: Math.ceil(rect.width), height: Math.ceil(rect.height) }
  })
  const scale = page.viewport()?.deviceScaleFactor || 1
  const width = Math.ceil(bounds.width * scale), height = Math.ceil(bounds.height * scale)
  if (!Number.isFinite(width * height) || bounds.width <= 0 || bounds.width > 1600 || bounds.height <= 0 || bounds.height > MAX_RENDER_HEIGHT || width * height > MAX_RENDER_PIXELS) {
    throw new RangeError("渲染内容超过安全尺寸上限")
  }
  const { PNG } = await import("pngjs")
  const output = new PNG({ width, height })
  for (let offset = 0; offset < bounds.height; offset += 1000) {
    const tileHeight = Math.min(1000, bounds.height - offset)
    const buffer = await page.screenshot({ type: "png", omitBackground: true, captureBeyondViewport: true,
      clip: { x: bounds.x, y: bounds.y + offset, width: bounds.width, height: tileHeight } })
    const tile = PNG.sync.read(Buffer.from(buffer))
    const targetY = Math.round(offset * scale)
    PNG.bitblt(tile, output, 0, 0, Math.min(width, tile.width), Math.min(tile.height, height - targetY), 0, targetY)
  }
  return PNG.sync.write(output)
}
