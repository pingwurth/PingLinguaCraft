/**
 * HTTP Range 头解析（单一字节区间，RFC 9110 语义）
 *
 * 媒体流式路由（/api/media/[id]）的纯逻辑（设计为双端可复用——移动端播放器
 * 将来对接本地/代理流时直接可用，当前仓库内唯一调用方是 web 路由）：把 Range
 * 头解析为「可直接用于 createReadStream 的字节区间」，并区分两种失败——
 * 「语法非法」（调用方应忽略 Range 回 200 全量）与「不可满足」（应回 416）。
 * 从 apps/web 的媒体路由抽入 core 以获得表驱动测试覆盖（RFC 9110 状态机的
 * 多区间/后缀溢出/倒置/单位大小写等边界极易回归，web 侧此前无测试基建）。
 *
 * 分片上限 maxChunkBytes 在解析的唯一出口统一钳制（不因区间写法绕过）：
 * - 普通区间（bytes=a-b / bytes=a-）锚定起点：end 收窄到 start + max - 1
 * - 后缀区间（bytes=-n）锚定文件尾：start 抬升到 end - max + 1——客户端要的
 *   是「最后 n 字节」（典型如探测 MP4 moov 的大尾部请求），从头部截断会把
 *   真正的尾部变成永远取不到的字节
 */

/** Range 解析三态结果：ok 可满足区间 / invalid 语法非法 / unsatisfiable 不可满足 */
export type HttpRangeResult =
  | { kind: 'ok'; start: number; end: number }
  | { kind: 'invalid' }
  | { kind: 'unsatisfiable' };

/** 单个 Range 分片默认上限：8MB（移动端网络友好；调用方可按场景覆盖） */
export const DEFAULT_MAX_CHUNK_BYTES = 8 * 1024 * 1024;

/**
 * 解析 Range 头为字节区间（含端点），并完成分片上限钳制
 * @param rangeHeader   请求头 Range 值，如 "bytes=0-1023" / "bytes=1024-" / "bytes=-500"
 * @param size          文件总大小（字节）；非有限正数视为空文件（不可满足），
 *                      防止负数/NaN 产出 start>end 或 NaN 端点流进 Content-Range/流式 API
 * @param maxChunkBytes 单区间分片上限；非有限或 <1 的值视为不限制（NaN 静默穿透
 *                      会退化成全文件 206，小数会产出小数端点让 createReadStream 抛错）
 * @returns ok 已钳制的可满足区间 / invalid 语法非法（忽略 Range 回 200）/ unsatisfiable 不可满足（416）
 */
export function parseRange(
  rangeHeader: string,
  size: number,
  maxChunkBytes: number = DEFAULT_MAX_CHUNK_BYTES
): HttpRangeResult {
  // 上限归一化为正整数再判「不限制」：小数上限会算出小数 end（Content-Range 非法、
  // createReadStream 抛 ERR_OUT_OF_RANGE），NaN 上限会静默穿透成「不限制」之外的语义
  const limit =
    Number.isFinite(maxChunkBytes) && maxChunkBytes >= 1
      ? Math.floor(maxChunkBytes)
      : Infinity;

  // 非单一区间：多区间（含逗号）、单位不符、缺连字符、非数字端点等 → 语法非法；
  // 单位 bytes 按 RFC 9110 为大小写不敏感 token（加 i 标志，与 nginx 等实现一致）
  const m = rangeHeader.trim().match(/^bytes=(\d*)-(\d*)$/i);
  if (!m) return { kind: 'invalid' };
  const startRaw = m[1]!;
  const endRaw = m[2]!;

  // 文件大小归一化：0/负数/NaN/非整数都无法承载任何字节区间，统一按不可满足处理
  // （正则命中的前提下 416 语义正确；size 来自 statSync 正常恒为非负整数，此为纯函数防御）
  if (!Number.isFinite(size) || size <= 0) return { kind: 'unsatisfiable' };

  // 后缀区间 "bytes=-500"：最后 500 字节；长度超限按 RFC 钳制为整个文件
  if (startRaw === '') {
    if (endRaw === '') return { kind: 'invalid' }; // "bytes=-"：缺后缀长度
    const len = Number(endRaw);
    // 后缀长度为 0（"bytes=-0"）引用零字节：语法合法但不可满足；
    // 正则限定 \d+ 无负数入参；溢出数值（超安全整数）远大于 size，min 钳制后仍语义正确
    if (len === 0) return { kind: 'unsatisfiable' };
    const clamped = Math.min(len, size);
    const end = size - 1;
    // 分片上限锚定文件尾：窗口超限时只保留最后 limit 字节（真正的尾部不丢）
    const start = Math.max(size - clamped, end - limit + 1);
    return { kind: 'ok', start, end };
  }

  // 正则已限定 \d+，无负数/非数字入参；溢出的起点必然 ≥ size，按不可满足处理（416）
  const start = Number(startRaw);
  if (start >= size) return { kind: 'unsatisfiable' };

  const end =
    endRaw === ''
      ? size - 1 // 开放区间 "bytes=1024-"：到文件尾
      : Math.min(Number(endRaw), size - 1); // 结束位超限按 RFC 钳制为文件尾（返回 206 而非 416）
  // 倒置区间（end < start）按 RFC 9110 为语法无效 → 忽略 Range 回 200
  if (end < start) return { kind: 'invalid' };
  // 分片上限锚定起点：窗口超限时收窄 end（与后缀区间的尾部锚定相对）
  return { kind: 'ok', start, end: Math.min(end, start + limit - 1) };
}
