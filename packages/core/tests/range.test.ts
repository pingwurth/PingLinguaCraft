/**
 * HTTP Range 解析测试：parseRange 表驱动覆盖 RFC 9110 单区间状态机
 * （web 媒体流式路由 /api/media/[id] 的解析内核，双端可复用）。
 * 边界族：常规/开放/后缀区间、单位大小写与空白、多区间与畸形输入、
 * 倒置区间、不可满足（起点越界/后缀 0/空文件）、数值溢出钳制、
 * 分片上限的「起点锚定 vs 文件尾锚定」两种方向、
 * 非法入参防御（负数/NaN/小数的 size 与上限）。
 */

import { describe, expect, it } from 'vitest';
import { parseRange, DEFAULT_MAX_CHUNK_BYTES } from '../src/media/range';

/** 期望值速记：可满足区间 */
const ok = (start: number, end: number) => ({ kind: 'ok' as const, start, end });
/** 期望值速记：语法非法（忽略 Range 回 200） */
const INVALID = { kind: 'invalid' as const };
/** 期望值速记：不可满足（416） */
const UNSAT = { kind: 'unsatisfiable' as const };

/** 样例文件大小：1000 字节（合法下界 0，合法上界 999） */
const SIZE = 1000;

describe('parseRange 基础语义（表驱动：输入 × 文件大小 → 期望）', () => {
  it.each([
    // —— 三种合法写法 ——
    ['bytes=0-0', SIZE, ok(0, 0)], // 单字节
    ['bytes=0-499', SIZE, ok(0, 499)], // 常规闭区间
    ['bytes=500-999', SIZE, ok(500, 999)], // 恰好到文件尾
    ['bytes=500-', SIZE, ok(500, 999)], // 开放区间：到文件尾
    ['bytes=-500', SIZE, ok(500, 999)], // 后缀区间：最后 500 字节
    ['bytes=-1', SIZE, ok(999, 999)], // 后缀单字节（最后 1 字节）
    // —— 单位大小写与首尾空白 ——
    ['Bytes=0-99', SIZE, ok(0, 99)], // 单位大小写不敏感（RFC 9110 token 语义）
    ['BYTES=-100', SIZE, ok(900, 999)],
    ['  bytes=0-99  ', SIZE, ok(0, 99)], // 首尾空白容忍
    // —— 结束位溢出：按 RFC 钳制为文件尾，返回 206 而非 416 ——
    ['bytes=0-99999', SIZE, ok(0, 999)],
    ['bytes=900-99999', SIZE, ok(900, 999)],
    ['bytes=0-99999999999', SIZE, ok(0, 999)], // Long.MAX_VALUE 类客户端
    // —— 后缀长度溢出：钳制为整个文件 ——
    ['bytes=-99999', SIZE, ok(0, 999)],
    ['bytes=-99999999999', SIZE, ok(0, 999)],
    // —— 语法非法：忽略 Range 回 200 全量 ——
    ['bytes=0-1,5-9', SIZE, INVALID], // 多区间（含逗号）
    ['bytes=0-1, 5-9', SIZE, INVALID],
    ['chunks=0-100', SIZE, INVALID], // 单位不符
    ['bytes=-', SIZE, INVALID], // 缺后缀长度
    ['bytes=', SIZE, INVALID], // 缺两个端点
    ['bytes=a-b', SIZE, INVALID], // 非数字端点
    ['bytes=100', SIZE, INVALID], // 缺连字符
    ['bytes=500-100', SIZE, INVALID], // 倒置区间（RFC 9110 语法无效）
    ['bytes=0-99 extra', SIZE, INVALID], // 尾部多余内容
    ['bytes=+5-99', SIZE, INVALID], // 正负号不属于 \d
    ['', SIZE, INVALID], // 空串
    // —— 语法合法但不可满足：416 ——
    ['bytes=1000-', SIZE, UNSAT], // 起点恰越界（size=1000，合法起点 0-999）
    ['bytes=1000-1999', SIZE, UNSAT],
    ['bytes=-0', SIZE, UNSAT], // 后缀长度 0 引用零字节
    ['bytes=99999999999999999999-', SIZE, UNSAT], // 起点溢出（超安全整数）必然 ≥ size
    // —— 空文件（size=0）：任何合法写法均不可满足 ——
    ['bytes=0-', 0, UNSAT],
    ['bytes=-500', 0, UNSAT],
    ['bytes=0-0', 0, UNSAT],
    // —— 非法 size 防御：负数/NaN 同样不可承载任何区间（防 NaN/倒置端点外泄）——
    ['bytes=0-99', -5, UNSAT],
    ['bytes=-10', -5, UNSAT],
    ['bytes=0-99', Number.NaN, UNSAT],
    ['bytes=-10', Number.NaN, UNSAT],
  ])('%s（size=%s）→ %j', (input, size, expected) => {
    expect(parseRange(input, size)).toEqual(expected);
  });
});

describe('parseRange 分片上限钳制', () => {
  /** 小尺寸样例：文件 100 字节，上限 10 字节 */
  const S = 100;
  const MAX = 10;

  it.each([
    // 普通区间：锚定起点，收窄 end
    ['bytes=0-99', ok(0, 9)],
    ['bytes=0-5', ok(0, 5)], // 区间本身小于上限：不动
    ['bytes=50-', ok(50, 59)], // 开放区间同样受限
    ['bytes=95-', ok(95, 99)], // 文件尾不足上限：给到尾
    ['bytes=0-99999', ok(0, 9)], // 结束位溢出先钳到尾，再受上限约束
    // 后缀区间：锚定文件尾——大尾部请求保留的是「最后」而非「最前」max 字节
    ['bytes=-50', ok(90, 99)],
    ['bytes=-100', ok(90, 99)], // 要整个文件（超上限）→ 只给最后 max 字节
    ['bytes=-10000', ok(90, 99)], // 后缀溢出钳为整个文件后仍受上限约束
    ['bytes=-5', ok(95, 99)], // 小于上限：完整满足
  ])('%s（size=%s, max=%s）→ %j', (input, expected) => {
    expect(parseRange(input, S, MAX)).toEqual(expected);
  });

  it('后缀区间尾部锚定：真实 MAX_CHUNK 场景下真正的尾部可达（MP4 moov 探测）', () => {
    // 20MB 后缀请求 + 8MB 上限：旧实现出口钳制返回 [size-20M, size-20M+8M)，
    // 尾部 12MB 永远取不到；现在返回最后 8MB，客户端可凭 Content-Range 续取前段
    const size = 100 * 1024 * 1024;
    expect(parseRange('bytes=-20971520', size)).toEqual(
      ok(size - DEFAULT_MAX_CHUNK_BYTES, size - 1)
    );
  });

  it('上限 ≤0 视为不限制', () => {
    expect(parseRange('bytes=0-99', 100, 0)).toEqual(ok(0, 99));
    expect(parseRange('bytes=-99', 100, -1)).toEqual(ok(1, 99));
  });

  it('上限非法防御：NaN 不限制、小数向下取整（端点必须保持整数）', () => {
    // NaN 静默穿透会退化成「不限制」之外的语义；小数上限会产出小数端点
    expect(parseRange('bytes=0-99', 100, Number.NaN)).toEqual(ok(0, 99));
    expect(parseRange('bytes=0-99', 100, 10.5)).toEqual(ok(0, 9)); // floor(10.5)=10
    expect(parseRange('bytes=0-99', 100, 0.5)).toEqual(ok(0, 99)); // <1 视为不限制
    expect(parseRange('bytes=0-99', 100, Number.POSITIVE_INFINITY)).toEqual(ok(0, 99));
  });

  it('默认参数：8MB 上限，小于该尺寸的文件不受影响', () => {
    expect(parseRange('bytes=0-999', SIZE)).toEqual(ok(0, 999));
    expect(DEFAULT_MAX_CHUNK_BYTES).toBe(8 * 1024 * 1024);
  });
});
