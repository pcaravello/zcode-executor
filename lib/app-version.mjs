// 本文件负责：从 zcode.cjs 的位置推出已安装的 ZCode App 版本（fork，F-4）。
// 为什么：ZCode 4.0.0（runtime 0.18.0）起，start plan 的模型请求要带 App 版本——App 拉 app-server 时
// 设 ZCODE_APP_VERSION，运行时据此加 X-ZCode-App-Version 等请求头；本插件拉 app-server 时没有它，
// start plan 端点（zcode.z.ai/api/v1/zcode-plan/anthropic）回空响应，回合报
// 「Model returned no text, no tool calls, and no usage」。2026-11-28 WSL2 真机：同一会话、同一 JWT，
// 只加 ZCODE_APP_VERSION=4.0.0 就 done（verified.md）。
// 布局：
//   macOS   <App>.app/Contents/Resources/glm/zcode.cjs → <App>.app/Contents/Info.plist 的 CFBundleShortVersionString
//   Linux / Windows   <App>/resources/glm/zcode.cjs → <App>/resources/app.asar 里的 package.json 的 version
// 推不出来返回 null（ZCODE_BIN 指别处、布局变了）：调用方照旧不设，行为与以前一样。
import { closeSync, openSync, readFileSync, readSync } from 'node:fs';
import path from 'node:path';

const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const MAX_ASAR_HEADER = 64 * 1024 * 1024; // 头部 JSON 的上限：真机 4.0.0 约 8 MB
const MAX_PACKAGE_JSON = 1024 * 1024;

function readExact(fd, length, position) {
  const buf = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const n = readSync(fd, buf, done, length - done, position + done);
    if (n === 0) throw new Error('short read');
    done += n;
  }
  return buf;
}

/**
 * app.asar 里 package.json 的 version。asar 格式：前 16 字节是 Chromium pickle 的四个 uint32 LE
 * （4、头部 pickle 大小、头部负载大小、JSON 字符串长度），JSON 从第 16 字节开始；文件数据区从 8 + 头部 pickle 大小起，
 * 条目的 offset 是数据区内的偏移（字符串）。任何一步不对都返回 null。
 */
export function asarPackageVersion(asarPath) {
  let fd;
  try {
    fd = openSync(asarPath, 'r');
    const head = readExact(fd, 16, 0);
    const headerPickleSize = head.readUInt32LE(4);
    const jsonLength = head.readUInt32LE(12);
    if (jsonLength <= 0 || jsonLength > MAX_ASAR_HEADER || jsonLength + 8 > headerPickleSize + 8) return null;
    const header = JSON.parse(readExact(fd, jsonLength, 16).toString('utf8'));
    const entry = header?.files?.['package.json'];
    const offset = Number(entry?.offset);
    const size = Number(entry?.size);
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || size <= 0 || size > MAX_PACKAGE_JSON) return null;
    const pkg = JSON.parse(readExact(fd, size, 8 + headerPickleSize + offset).toString('utf8'));
    return typeof pkg?.version === 'string' && VERSION_RE.test(pkg.version) ? pkg.version : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** 从 zcode.cjs 的位置推 App 版本（macOS 先看 Info.plist，其余看 app.asar）。推不出来返回 null。 */
export function appVersionOf(zcodePath) {
  if (typeof zcodePath !== 'string' || !zcodePath) return null;
  const glmDir = path.dirname(zcodePath);
  try {
    const plist = readFileSync(path.resolve(glmDir, '../../Info.plist'), 'utf8');
    const v = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1] ?? null;
    if (v && VERSION_RE.test(v)) return v;
  } catch {
    // 不是 macOS 的 App 布局
  }
  return asarPackageVersion(path.resolve(glmDir, '../app.asar'));
}
