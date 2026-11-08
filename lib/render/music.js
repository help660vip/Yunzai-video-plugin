import { escapeThemeHtml as escape } from "./theme.js"

// The player is a static summary card, never an autoplaying media element.
export function renderMusicCard(data, { font = "", mode = "common", comments = "", stats = "", baseStyles = "" } = {}) {
  const post = data.post
  const cover = post.content.find(item => ["cover", "image", "graphic"].includes(item.type))?.src
  const audio = post.content.find(item => item.type === "audio")
  const lyric = post.content.find(item => item.type === "text" && item.text)?.text || ""
  const lines = lyric.split("\n").map(line => line.replace(/^(?:\[[^\]]*\])+\s*/, "").trim()).filter(Boolean).slice(0, 6)
  const album = typeof post.extra?.album === "string" ? post.extra.album : ""
  const dark = data.theme === "dark"
  return `<!doctype html><html lang="zh-CN" data-theme="${dark ? "dark" : "light"}"><head><meta charset="utf-8">${baseStyles}<style>
  @font-face{font-family:parser;src:url("${font}")}*{box-sizing:border-box}body{margin:0;padding:24px;background:transparent;font-family:parser,"Microsoft YaHei",sans-serif;color:#20242a}
  .result.music{--primary:#00a6b4;position:relative;isolation:isolate;width:752px;overflow:hidden;border-radius:24px;background:#f4f6f8;box-shadow:0 8px 30px #0002}.music.night{background:#101722;color:#e8ecf2}
  .music-ambient{position:absolute;inset:-80px;width:calc(100% + 160px);height:100%;object-fit:cover;filter:blur(60px);opacity:.24;z-index:-2}.music-veil{position:absolute;inset:0;background:linear-gradient(#ffffff75,#ffffffe8);z-index:-1}.night .music-veil{background:linear-gradient(#10172290,#101722f0)}
  .music-main{position:relative;padding:32px}.music-header{display:flex;align-items:center;gap:12px}.music-avatar{width:48px;height:48px;border-radius:50%;object-fit:cover}.music-author{min-width:0;flex:1}.music-author b{display:block;font-size:20px}.music-author small{display:block;margin-top:5px;font-size:12px;color:#7e8794}.music-platform{display:flex;align-items:center;gap:8px;color:#6f7782;font-size:16px}.music-platform img{width:26px;height:26px;object-fit:contain}.night .music-platform{color:#b0bac8}
  .music-art{position:relative;display:flex;justify-content:center;margin:38px 70px 0}.music-cover{position:relative;width:296px;height:296px;border-radius:22px;object-fit:cover;box-shadow:0 18px 45px #0005;z-index:1}.music-placeholder{display:grid;place-items:center;background:#dfe5ea;color:#82909e;font-size:90px}.night .music-placeholder{background:#263243}.music-record{position:absolute;left:calc(50% + 38px);top:24px;width:248px;height:248px;border-radius:50%;background:repeating-radial-gradient(circle,#111 0,#242424 2px,#111 4px);box-shadow:0 14px 35px #0004}.music-record img{position:absolute;left:82px;top:82px;width:84px;height:84px;border-radius:50%;object-fit:cover}.music-record:after{content:"";position:absolute;left:116px;top:116px;width:16px;height:16px;border-radius:50%;background:#f4f6f8}.night .music-record:after{background:#101722}
  .music-title{margin:35px 0 10px;font-size:32px;line-height:1.35;overflow-wrap:anywhere}.music-byline{color:#7b8794;font-size:18px;line-height:1.5;overflow-wrap:anywhere}.night .music-byline{color:#a8b4c4}.music-timing{display:flex;align-items:center;gap:14px;margin-top:25px;font-size:14px;color:#7b8794}.music-progress{height:3px;flex:1;background:#cdd5de;border-radius:3px}.night .music-progress{background:#405063}.music-speed{padding:3px 7px;border-radius:6px;background:#ffffff90}.night .music-speed{background:#ffffff12}
  .music-lyrics{margin-top:26px;padding:20px 24px;border-radius:14px;background:#ffffff75}.night .music-lyrics{background:#ffffff09}.music-lyrics h2{margin:0 0 12px;font-size:14px;color:#7b8794}.music-lyrics p{margin:5px 0;font-size:17px;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere}.music-summary{margin-top:24px;line-height:1.6;white-space:pre-wrap}.music-summary b{display:block;margin-bottom:8px;color:#3979b7}
  .music-source{display:flex;align-items:flex-end;gap:20px;margin-top:28px;color:#89919d;font-size:12px;overflow-wrap:anywhere}.music-source span{min-width:0;flex:1}.music-source img{width:86px;height:86px}.music-footer{margin-top:24px;padding-top:16px;border-top:1px solid #89919d33;color:#89919d;font-size:11px}
  </style></head><body><main class="result music ${escape(mode)} ${dark ? "night" : "day"}" data-platform="${escape(post.platform.id)}">
  ${cover ? `<img class="music-ambient" src="${escape(cover)}" alt=""><div class="music-veil" data-render-veil></div>` : ""}<div class="music-main">
  <header class="music-header">${post.author?.avatar ? `<img class="music-avatar" src="${escape(post.author.avatar)}" alt="">` : ""}<div class="music-author"><b>${escape(post.author?.name || "")}</b><small>音乐分享</small></div><div class="music-platform"><img src="${escape(post.platform.logo)}" alt="">${escape(post.platform.name)}</div></header>
  <div class="music-art">${cover ? `<div class="music-record"><img src="${escape(cover)}" alt=""></div><img class="music-cover" src="${escape(cover)}" alt="专辑封面">` : '<div class="music-cover music-placeholder"><i class="fa-icon fa-music"></i></div>'}</div>
  <h1 class="music-title">${escape(post.title)}</h1><div class="music-byline">${escape(post.author?.name || "")}${album ? ` · ${escape(album)}` : ""}</div>
  ${audio ? `<div class="music-timing"><i class="fa-icon fa-music"></i><div class="music-progress" aria-label="静态播放进度条"></div>${audio.speedup ? `<span class="music-speed">${escape(audio.speedup)}</span>` : ""}<span>${escape(audio.size)}</span><b>${escape(audio.duration)}</b></div>` : ""}
  ${lines.length ? `<section class="music-lyrics"><h2><i class="fa-icon fa-music"></i> 歌词</h2>${lines.map(line => `<p>${escape(line)}</p>`).join("")}</section>` : ""}
  ${post.ai_summary ? `<div class="music-summary"><b>AI 摘要</b>${escape(post.ai_summary)}</div>` : ""}${stats}${comments}
  <div class="music-source"><span>${escape(post.url)}</span>${post.qrcode ? `<img src="${escape(post.qrcode)}" alt="二维码">` : ""}</div><footer class="music-footer">${escape(data.meta.bot_name)} Parser · ${escape(data.meta.rendering_time)}</footer>
  </div></main></body></html>`
}
