/**
 * API 客户端内核测试：parseApiResponse 的响应解析与错误契约（web/mobile
 * 双端共用，分支必须锁死）+ jsonHeaders 头归一化
 */

import { describe, expect, it } from 'vitest';
import { ApiError, jsonHeaders, parseApiResponse, type FetchResponseLike, type HeadersInput } from '../src/api/client';

/** 构造假响应（FetchResponseLike 结构化类型） */
function resp(ok: boolean, status: number, body: string): FetchResponseLike {
  return { ok, status, text: async () => body };
}

/** 经 globalThis 取运行时构造器（core 不依赖 DOM/Node 全局类型声明，测试同理） */
const HeadersCtor = (globalThis as unknown as { Headers: new (init?: Record<string, string>) => object })
  .Headers;
const FormDataCtor = (globalThis as unknown as { FormData: new () => object }).FormData;

describe('parseApiResponse（双端共享的错误/响应契约）', () => {
  it('JSON 成功：解析为对象', async () => {
    const r = await parseApiResponse<{ a: number }>(resp(true, 200, '{"a":1}'));
    expect(r).toEqual({ a: 1 });
  });

  it('空体成功：返回 null', async () => {
    const r = await parseApiResponse(resp(true, 204, ''));
    expect(r).toBeNull();
  });

  it('非 JSON 成功：透传文本（如字幕导出）', async () => {
    const r = await parseApiResponse<string>(resp(true, 200, '1\n00:00:01,000 --> x\nhello'));
    expect(r).toContain('-->');
  });

  it('非 2xx 且带 { error }：抛 ApiError（服务端消息 + 状态码 + name）', async () => {
    await expect(parseApiResponse(resp(false, 404, '{"error":"单词不存在"}'))).rejects.toSatisfy((e: unknown) => {
      expect(e).toBeInstanceOf(ApiError);
      const err = e as ApiError;
      expect(err.message).toBe('单词不存在');
      expect(err.status).toBe(404);
      expect(err.name).toBe('ApiError');
      return true;
    });
  });

  it('非 2xx 且无 { error }：回落通用消息', async () => {
    await expect(parseApiResponse(resp(false, 500, 'boom')).catch((e: ApiError) => {
      throw new Error(`${e.status}:${e.message}`);
    })).rejects.toThrow('500:请求失败 500');
  });

  it('非 2xx 的非 JSON 体：同样回落通用消息', async () => {
    await expect(parseApiResponse(resp(false, 502, '<html>bad gateway</html>'))).rejects.toThrow('请求失败 502');
  });
});

describe('jsonHeaders（请求头归一化）', () => {
  it('默认补 Content-Type: application/json', () => {
    expect(jsonHeaders(undefined, undefined).get('Content-Type')).toBe('application/json');
  });

  it('调用方已设 Content-Type 时不覆盖', () => {
    expect(jsonHeaders(undefined, { 'Content-Type': 'text/plain' }).get('Content-Type')).toBe('text/plain');
  });

  it('FormData 体不设 Content-Type（boundary 由 fetch 生成）', () => {
    const fd = new FormDataCtor();
    expect(jsonHeaders(fd, undefined).get('Content-Type')).toBeNull();
  });

  it('Headers 实例作为输入可正确合并（对象展开会静默丢弃其条目）', () => {
    const h = jsonHeaders(undefined, new HeadersCtor({ Authorization: 'Bearer x' }) as HeadersInput);
    expect(h.get('Authorization')).toBe('Bearer x');
    expect(h.get('Content-Type')).toBe('application/json');
  });
});
