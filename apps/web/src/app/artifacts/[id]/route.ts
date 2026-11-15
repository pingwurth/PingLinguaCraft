/**
 * AI 产物服务路由：GET /artifacts/[id] —— 关卡页等生成的 HTML
 *
 * 安全：AI 生成的 HTML 一律视为不可信——响应带严格 CSP（含 sandbox allow-scripts，
 * 直接打开也等效沙箱）；文件访问严格收窄在 ~/.pinglc/artifacts/ 之内
 * （resolve 归一化防 .. 穿越，前缀比对用「目录 + 分隔符」防兄弟目录撞前缀）。
 */

import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { eq } from 'drizzle-orm';
import { getDb, PINGLC_HOME } from '@/lib/db';
import { aiArtifacts } from '@/lib/db/schema';

export const runtime = 'nodejs';

/** 产物唯一合法目录（关卡页等由管线写入） */
const ARTIFACTS_DIR = join(PINGLC_HOME, 'artifacts');

/**
 * GET —— 产物内容（关卡页 HTML）
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = getDb();
  const row = db
    .select({ kind: aiArtifacts.kind, artifactPath: aiArtifacts.artifactPath })
    .from(aiArtifacts)
    .where(eq(aiArtifacts.id, Number(id)))
    .all()[0];
  if (!row?.artifactPath) return new Response('产物不存在', { status: 404 });

  // 路径归一化 + 目录收窄：resolve 只做词法归一（不展开符号链接）——先比对
  // 字面路径，再用 realpathSync 展开符号链接后二次收窄（目录内 symlink 指向
  // 库外文件的两段式逃逸），兄弟目录如 ~/.pinglc-backup 也会被拒
  const abs = resolve(row.artifactPath);
  if (abs !== ARTIFACTS_DIR && !abs.startsWith(ARTIFACTS_DIR + sep)) {
    return new Response('产物路径非法', { status: 403 });
  }
  if (!existsSync(abs)) return new Response('产物文件缺失', { status: 404 });
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    return new Response('产物文件缺失', { status: 404 });
  }
  const realRoot = realpathSync(ARTIFACTS_DIR);
  if (real !== realRoot && !real.startsWith(realRoot + sep)) {
    return new Response('产物路径非法', { status: 403 });
  }

  const html = readFileSync(abs, 'utf-8');
  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // 严格 CSP：禁外联；form-action/base-uri 显式禁（default-src 不回退这两项）；
      // sandbox allow-scripts 让文档以不透明源运行（直接打开也等效 iframe 沙箱：
      // 无同源权限、禁表单提交、禁顶层导航）；内联脚本与样式放行（自包含单文件页）
      'Content-Security-Policy':
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; media-src data:; form-action 'none'; base-uri 'none'; frame-ancestors 'self'; sandbox allow-scripts",
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=3600',
    },
  });
}
