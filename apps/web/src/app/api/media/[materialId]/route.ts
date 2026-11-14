/**
 * 媒体文件流式路由（GET /api/media/[materialId]）
 *
 * 支持 HTTP Range 请求（206 Partial Content）——视频拖动进度条/移动端 seek 的硬前提。
 * Node 运行时 + fs.createReadStream 直读 ~/.pinglc/media 下的文件，
 * 显式设置 Accept-Ranges / Content-Range / Content-Length 头。
 *
 * Range 语义遵循 RFC 9110：
 * - 语法非法 / 多区间 / 倒置区间 → 忽略 Range，回 200 全量（而非 416，浏览器视 416 为致命）
 * - 语法合法但不可满足（起点越界 / 后缀长度为 0 / 空文件）→ 416，并在 Content-Range 头告知总大小
 * - 溢出数值（超出安全整数，如 Long.MAX_VALUE 类客户端）按 RFC 钳制处理：
 *   后缀长度超限 → 整个文件；结束位超限 → 到文件尾；均返回 206 而非 416/200
 * - range 单位 bytes 大小写不敏感（RFC 9110 token 语义，主流实现一致）
 * - 可满足 → 206，分片上限 MAX_CHUNK 在唯一的出口处统一 clamp（不因区间写法绕过）
 */

import { createReadStream, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { resolve, sep } from 'node:path';
import { eq } from 'drizzle-orm';
import { getDb, MEDIA_ROOT } from '@/lib/db';
import { materials } from '@/lib/db/schema';

/** 强制 Node 运行时（默认即 Node，显式声明防止意外边缘化） */
export const runtime = 'nodejs';

/** 单个 Range 分片上限：8MB（移动端网络友好；对任意区间写法统一生效） */
const MAX_CHUNK = 8 * 1024 * 1024;

/** Range 解析三态结果 */
type RangeResult =
  | { kind: 'ok'; start: number; end: number }
  | { kind: 'invalid' }
  | { kind: 'unsatisfiable' };

/**
 * 解析 Range 头为字节区间（含端点），并区分「语法非法」与「不可满足」
 * @param rangeHeader 请求头 Range 值，如 "bytes=0-1023" / "bytes=1024-" / "bytes=-500"
 * @param size         文件总大小
 * @returns ok 可满足区间 / invalid 语法非法（调用方应忽略 Range 回 200）/ unsatisfiable 不可满足（416）
 */
function parseRange(rangeHeader: string, size: number): RangeResult {
  // 非单一区间：多区间（含逗号）、单位不符、缺连字符等 → 语法非法；
  // 单位 bytes 按 RFC 9110 为大小写不敏感 token（加 i 标志，与 nginx 等实现一致）
  const m = rangeHeader.trim().match(/^bytes=(\d*)-(\d*)$/i);
  if (!m) return { kind: 'invalid' };
  const startRaw = m[1]!;
  const endRaw = m[2]!;

  // 后缀区间 "bytes=-500"：最后 500 字节
  if (startRaw === '') {
    if (endRaw === '') return { kind: 'invalid' };
    const len = Number(endRaw);
    // 后缀长度为 0（"bytes=-0"）→ 引用零字节，语法合法但不可满足（防倒置区间）；
    // 正则限定 \d+ 无负数入参；溢出数值按 RFC 钳制为整个文件（可满足 206）
    if (len === 0) return { kind: 'unsatisfiable' };
    if (size === 0) return { kind: 'unsatisfiable' };
    const clamped = Math.min(len, size);
    return { kind: 'ok', start: size - clamped, end: size - 1 };
  }

  // 正则已限定 \d+，无负数/非数字入参；溢出的起点必然 ≥ size，按不可满足处理（416）
  const start = Number(startRaw);
  if (size === 0 || start >= size) return { kind: 'unsatisfiable' };

  if (endRaw === '') {
    // 开放区间 "bytes=1024-"：到文件尾（MAX_CHUNK 在出口统一 clamp）
    return { kind: 'ok', start, end: size - 1 };
  }
  const end = Number(endRaw);
  // 倒置区间（end < start）按 RFC 9110 为语法无效 → 忽略 Range 回 200；
  // 溢出的结束位不视为非法：下方 min(size-1) 按「到文件尾」钳制，返回 206
  if (end < start) return { kind: 'invalid' };
  return { kind: 'ok', start, end: Math.min(end, size - 1) };
}

/**
 * 构造 200 全量流式响应（无 Range 或 Range 语法非法时）
 * @param filePath 文件绝对路径
 * @param size     文件总大小
 * @param mime     媒体 MIME 类型
 * @returns 200 Response（流式）
 */
function fullResponse(filePath: string, size: number, mime: string): Response {
  const stream = Readable.toWeb(createReadStream(filePath)) as ReadableStream;
  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': mime,
      'Content-Length': String(size),
      'Accept-Ranges': 'bytes',
      // 单用户局域网场景：同源播放允许
      'Cache-Control': 'private, max-age=3600',
    },
  });
}

/**
 * 媒体流响应处理
 * @param request  请求（携带可选 Range 头）
 * @param params   路由参数（materialId）
 * @returns 200 全量 / 206 分片 / 404 / 416
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ materialId: string }> }
) {
  const { materialId } = await params;
  const id = Number(materialId);
  if (!Number.isInteger(id) || id <= 0) {
    return new Response('非法材料 id', { status: 400 });
  }

  // 查询材料的媒体文件相对路径
  const db = getDb();
  const rows = db
    .select({ mediaPath: materials.mediaPath, mediaMime: materials.mediaMime })
    .from(materials)
    .where(eq(materials.id, id))
    .limit(1)
    .all();
  const row = rows[0];
  if (!row?.mediaPath) {
    return new Response('材料不存在或无媒体文件', { status: 404 });
  }

  // 路径安全：解析后必须仍位于媒体根目录内（防目录穿越）；根目录只 resolve 一次。
  // 用平台路径分隔符拼接前缀（Windows 为 '\'，硬编码 '/' 会使全部合法请求误判 403）
  const mediaRoot = resolve(MEDIA_ROOT);
  const filePath = resolve(mediaRoot, row.mediaPath);
  if (!filePath.startsWith(mediaRoot + sep)) {
    return new Response('非法路径', { status: 403 });
  }

  // 单次 stat + 按错误码分级：文件类缺失（ENOENT/ENOTDIR/EISDIR）→ 404；
  // 其余（EACCES 权限、EMFILE 描述符耗尽等真实服务端故障）→ 500 并留日志，
  // 不把服务器问题伪装成「文件不存在」误导排查方向
  let size: number;
  try {
    const st = statSync(filePath);
    if (!st.isFile()) {
      return new Response('媒体文件缺失', { status: 404 });
    }
    size = st.size;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') {
      return new Response('媒体文件缺失', { status: 404 });
    }
    console.error(`[media] stat 失败 (${code}): ${filePath}`, err);
    return new Response('媒体读取异常', { status: 500 });
  }

  const mime = row.mediaMime ?? 'application/octet-stream';
  const rangeHeader = request.headers.get('range');

  // 无 Range 头：200 全量流式响应
  if (!rangeHeader) {
    return fullResponse(filePath, size, mime);
  }

  const range = parseRange(rangeHeader, size);
  // 语法非法 → 按 RFC 9110 忽略 Range，回 200 全量（而非 416，浏览器把媒体的 416 视为致命）
  if (range.kind === 'invalid') {
    return fullResponse(filePath, size, mime);
  }
  // 语法合法但不可满足 → 416 并告知可请求范围；同样声明 Accept-Ranges
  // （RFC 9110 建议：缓存的 416 若缺此头，客户端可能放弃后续 Range 重试）
  if (range.kind === 'unsatisfiable') {
    return new Response(null, {
      status: 416,
      headers: { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' },
    });
  }

  // 分片上限在唯一出口统一 clamp：显式闭区间与开放区间同等受限
  const start = range.start;
  const end = Math.min(range.end, start + MAX_CHUNK - 1);
  const stream = Readable.toWeb(createReadStream(filePath, { start, end })) as ReadableStream;
  return new Response(stream, {
    status: 206,
    headers: {
      'Content-Type': mime,
      'Content-Length': String(end - start + 1),
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=3600',
    },
  });
}
