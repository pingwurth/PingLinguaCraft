/**
 * 材料集封面插画路由：GET /api/collections/[id]/cover
 *
 * 读 collections.cover JSON 的 image 路径（契约见 @pinglc/core
 * parseCollectionCover），从 ~/.pinglc/media/covers/ 出图；未配置插画
 * （仅纹理/空）返回 404，前端据此回退纹理底渲染。小图整读 +
 * 私有长缓存（客户端 URL 带 ?v=<image> 内容版本参数，换图即换 URL，
 * 缓存随之失效——裸路径长缓存会让换封面后最长 24h 仍显示旧图）。
 */

import { readFileSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { parseCollectionCover } from '@pinglc/core';
import { and, eq } from 'drizzle-orm';
import { getDb, MEDIA_ROOT } from '@/lib/db';
import { collections } from '@/lib/db/schema';
import { parseIdParam } from '@/lib/server/params';

export const runtime = 'nodejs';

/** 插画扩展名 → MIME（与上传侧白名单一致） */
const EXT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

/**
 * GET —— 出图（200 全量；无配置/文件缺失 404，路径越界 403）
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const pid = parseIdParam(id);
  if (pid === null) return new Response('非法材料集 id', { status: 400 });

  const db = getDb();
  const rows = db
    .select({ cover: collections.cover })
    .from(collections)
    .where(and(eq(collections.id, pid), eq(collections.userId, 1)))
    .limit(1)
    .all();
  // 仅 DB 引用到的插画可被取出（无主残留文件不服务）
  const imagePath = parseCollectionCover(rows[0]?.cover)?.image;
  if (!imagePath) return new Response('该材料集无封面插画', { status: 404 });

  // 路径安全：解析后必须仍位于媒体根目录内（防目录穿越；上传侧白名单已挡
  // 一层，此处按 /api/media 同款收窄检查兜底）
  const mediaRoot = resolve(MEDIA_ROOT);
  const filePath = resolve(mediaRoot, imagePath);
  if (!filePath.startsWith(mediaRoot + sep)) {
    return new Response('非法路径', { status: 403 });
  }

  let size: number;
  try {
    const st = statSync(filePath);
    if (!st.isFile()) return new Response('封面插画缺失', { status: 404 });
    size = st.size;
  } catch {
    // 小图整读前的 stat 缺失（ENOENT 等）一律按「无插画」404，不区分故障类
    return new Response('封面插画缺失', { status: 404 });
  }

  const mime = EXT_MIME[imagePath.split('.').pop() ?? ''] ?? 'application/octet-stream';
  // ≤5MB 小图同步整读可接受（与上传侧 writeFileSync 同一权衡）
  const body = readFileSync(filePath);
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': mime,
      'Content-Length': String(size),
      // 单用户局域网同源场景；客户端以 ?v=<image> 版本化 URL 请求（见文件头注释），可较长时间缓存
      'Cache-Control': 'private, max-age=86400',
    },
  });
}
