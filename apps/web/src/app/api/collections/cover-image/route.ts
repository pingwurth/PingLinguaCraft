/**
 * 封面插画上传 API：POST /api/collections/cover-image（multipart）
 *
 * 建卷弹窗在立卷前先传图（此时卷尚无 id 可挂），图落
 * ~/.pinglc/media/covers/<uuid>.<ext>，回库内相对路径；建卷请求把该路径
 * 放进 cover JSON（契约见 @pinglc/core serializeCollectionCover）。
 * 已知余留：传图后放弃立卷会留下无主图文件——单用户自托管场景残留无害，
 * 不为此引入回收任务。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextResponse } from 'next/server';
import { MEDIA_ROOT } from '@/lib/db';

export const runtime = 'nodejs';

/** 单图上限 5MB（书影小图，与弹窗侧前置校验一致） */
const MAX_BYTES = 5 * 1024 * 1024;

/** 允许的插画 MIME → 扩展名（扩展名取自 mime 而非原始文件名，防怪后缀落盘） */
const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

/**
 * POST —— multipart: file(必，PNG/JPG/WebP ≤5MB)
 * @returns 201 { path }（cover JSON 的 image 字段值）/ 400 / 413
 */
export async function POST(request: Request) {
  // 前置体积闸（Content-Length 含 multipart 开销，放 64KiB 余量）：注定超限
  // 的请求在 formData 解析前拒绝，不白读整个 body
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > MAX_BYTES + 64 * 1024) {
    return NextResponse.json({ error: '封面插画超过 5MB' }, { status: 413 });
  }
  const form = await request.formData();
  const file = form.get('file') as File | null;
  const ext = file ? MIME_EXT[file.type] : undefined;
  if (!file || !ext) {
    return NextResponse.json({ error: '封面插画仅支持 PNG / JPG / WebP' }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: '封面插画超过 5MB' }, { status: 413 });
  }
  const dir = join(MEDIA_ROOT, 'covers');
  mkdirSync(dir, { recursive: true });
  // 文件名用 uuid（内容不可信，原始文件名不落盘）；≤5MB 小图整体读入内存可接受
  const name = `${crypto.randomUUID()}.${ext}`;
  writeFileSync(join(dir, name), Buffer.from(await file.arrayBuffer()));
  return NextResponse.json({ path: `covers/${name}` }, { status: 201 });
}
