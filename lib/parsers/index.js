import { registerParser } from "../core/registry.js"

import { AcfunParser } from "./acfun.js"
import { BilibiliParser } from "./bilibili.js"
import { DouyinParser } from "./douyin.js"
import { KuaishouParser } from "./kuaishou.js"
import { NgaParser } from "./nga.js"
import { TwitterParser } from "./twitter.js"
import { WeiboParser } from "./weibo.js"
import { XiaohongshuParser } from "./xiaohongshu.js"
import { YouTubeParser } from "./youtube.js"
import { TikTokParser } from "./tiktok.js"
import {
  BuffParser,
  CoolapkParser,
  DoubanParser,
  DoubaoParser,
  DsParser,
  DuitangParser,
  FiveEPlayParser,
  HeyboxParser,
  HupuParser,
  IlluParser,
  LinuxDoParser,
  LofterParser,
  MiyousheParser,
  TapTapParser,
  TiebaParser,
  WmpvpParser,
  ZhihuParser,
  ZlbParser,
} from "./communities.js"
import {
  KugouParser,
  KuwoParser,
  NeteaseParser,
  QsMusicParser,
} from "./music.js"

export function registerBuiltinParsers() {
  for (const ParserClass of [
    BilibiliParser,
    DouyinParser,
    KuaishouParser,
    WeiboParser,
    XiaohongshuParser,
    TwitterParser,
    AcfunParser,
    NgaParser,
    YouTubeParser,
    TikTokParser,
    BuffParser,
    CoolapkParser,
    DoubanParser,
    DoubaoParser,
    DsParser,
    DuitangParser,
    FiveEPlayParser,
    HeyboxParser,
    HupuParser,
    IlluParser,
    LinuxDoParser,
    LofterParser,
    MiyousheParser,
    TapTapParser,
    TiebaParser,
    WmpvpParser,
    ZhihuParser,
    ZlbParser,
    KugouParser,
    KuwoParser,
    NeteaseParser,
    QsMusicParser,
  ]) {
    registerParser(ParserClass)
  }
  return Promise.resolve()
}
