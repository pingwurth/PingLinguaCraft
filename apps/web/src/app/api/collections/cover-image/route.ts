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
import { COVER_IMAGE_EXT_MIME, COVER_IMAGE_MAX_BYTES } from '@pinglc/core';
import { MEDIA_ROOT } from '@/lib/db';

export const runtime = 'nodejs';

/* 单图上限（core 单源：服务端闸与立卷弹窗前置校验一致） */
const MAX_BYTES = COVER_IMAGE_MAX_BYTES;

/** 允许的插画 MIME → 扩展名（自 core 扩展名↔MIME 对照表反转单源；扩展名
 *  取自 mime 而非原始文件名，防怪后缀落盘；jpeg 折叠为 jpg） */
const MIME_EXT: Record<string, string> = {};
for (const [ext, mime] of Object.entries(COVER_IMAGE_EXT_MIME)) MIME_EXT[mime] ??= ext;

/**
 * 文件头魔数嗅探（不信任客户端声明的 MIME：任意字节都能以 image/png 声明
 * 落盘，再被出图路由按扩展名的 Content-Type 回放）。
 * 注意：此表与 core 的 COVER_IMAGE_EXT_MIME 是两张独立清单（魔数↔MIME vs
 * 扩展名↔MIME）——core 新增格式（如 avif）时必须同步补魔数分支，否则该
 * 格式会被 MIME 表放行、再被嗅探拦成「内容与声明不符」
 * @returns 嗅探出的 MIME；无法识别返回 null
 */
function sniffImageMime(buf: Buffer): string | null {
  /* PNG 完整 8 字节签名（89 50 4E 47 0D 0A 1A 0A）：只查前 4 字节会让任意
     同前缀的载荷过闸 */
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buf.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

/**
 * POST —— multipart: file(必，PNG/JPG/WebP ≤5MB)
 * @returns 201 { path }（cover JSON 的 image 字段值）/ 400 / 413
 */
export async function POST(request: Request) {
  // 前置体积闸（Content-Length 含 multipart 开销，放 64KiB 余量）：注定超限
  // 的请求在 formData 解析前拒绝，不白读整个 body
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > MAX_BYTES + 64 * 1024) {
    return NextResponse.json({ error: `封面插画超过 ${COVER_IMAGE_MAX_BYTES / 1024 / 1024}MB` }, { status: 413 });
  }
  // formData 解析可能抛错（畸形/截断的 multipart、客户端中断）：包一层给可读
  // 的 400。判空/判体积都在 arrayBuffer 之前：缺 file 字段给格式错误而非笼统的
  // 「解析失败」，超大文件不先整段读入内存再拒绝
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: '请求体非法（multipart 解析失败）' }, { status: 400 });
  }
  const file = form.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: '缺少 file 字段' }, { status: 400 });
  }
  const declaredExt = MIME_EXT[file.type];
  if (!declaredExt) {
    return NextResponse.json({ error: '封面插画仅支持 PNG / JPG / WebP' }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: `封面插画超过 ${COVER_IMAGE_MAX_BYTES / 1024 / 1024}MB` }, { status: 413 });
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(await file.arrayBuffer());
  } catch {
    return NextResponse.json({ error: '请求体非法（读取上传内容失败）' }, { status: 400 });
  }
  // 魔数与声明的 MIME 必须一致（防伪装落盘）
  const sniffed = sniffImageMime(bytes);
  if (sniffed !== file.type) {
    return NextResponse.json({ error: '文件内容与声明的格式不符' }, { status: 400 });
  }
  const dir = join(MEDIA_ROOT, 'covers');
  mkdirSync(dir, { recursive: true });
  // 文件名用 uuid（内容不可信，原始文件名不落盘）；≤5MB 小图整体读入内存可接受
  const name = `${crypto.randomUUID()}.${declaredExt}`;
  writeFileSync(join(dir, name), bytes);
  return NextResponse.json({ path: `covers/${name}` }, { status: 201 });
}
