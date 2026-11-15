/**
 * AI 档案 API：GET 列表（掩码 Key）/ POST 创建
 * 五能力 × {local | cloud}；api_key 只进不出
 */

import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { providerProfiles } from '@/lib/db/schema';
import { maskProfile } from '@/lib/server/providers';

export const runtime = 'nodejs';

/** 能力白名单 */
const CAPABILITIES = new Set(['stt', 'tts', 'align', 'translate', 'llm', 'speech_eval']);

/**
 * GET /api/providers —— 全部档案（按能力分组由前端处理；api_key 掩码为 hasKey）
 */
export async function GET() {
  const db = getDb();
  const rows = db
    .select()
    .from(providerProfiles)
    .where(eq(providerProfiles.userId, 1))
    .all()
    .map(maskProfile);
  return NextResponse.json({ providers: rows });
}

/**
 * POST /api/providers —— 创建档案
 * Body: { capability, name, kind, endpointUrl?, apiKey?, model?, params?, isDefault? }
 */
export async function POST(request: Request) {
  const body = (await request.json()) as {
    capability?: string;
    name?: string;
    kind?: string;
    endpointUrl?: string;
    apiKey?: string;
    model?: string;
    params?: Record<string, unknown>;
    isDefault?: boolean;
  };
  const capability = body.capability ?? '';
  const name = body.name?.trim();
  const kind = body.kind ?? 'cloud';
  if (!CAPABILITIES.has(capability)) {
    return NextResponse.json({ error: `能力必须为 ${[...CAPABILITIES].join('/')}` }, { status: 400 });
  }
  if (!name) return NextResponse.json({ error: '档案名不能为空' }, { status: 400 });
  if (kind !== 'local' && kind !== 'cloud') {
    return NextResponse.json({ error: '类型必须为 local/cloud' }, { status: 400 });
  }
  if (kind === 'cloud' && !body.endpointUrl?.trim()) {
    return NextResponse.json({ error: '云端档案必须填写端点 URL' }, { status: 400 });
  }
  // 口语评测档案：url→endpointUrl、secretKey→apiKey、provider/appId/secretId→params
  // （url/appId/secretId 必填，SecretKey 可后补）
  if (capability === 'speech_eval') {
    const params = (body.params ?? {}) as Record<string, unknown>;
    if (!body.endpointUrl?.trim() || !params.appId || !params.secretId) {
      return NextResponse.json({ error: '口语评测档案必须填写服务地址、appId 与 secretId' }, { status: 400 });
    }
  }

  const db = getDb();
  const now = new Date();
  // 同能力首个档案自动成为默认
  const existing = db
    .select({ id: providerProfiles.id })
    .from(providerProfiles)
    .where(eq(providerProfiles.capability, capability))
    .all();
  const isDefault = body.isDefault || existing.length === 0;

  const r = db
    .insert(providerProfiles)
    .values({
      userId: 1,
      capability,
      name,
      kind,
      endpointUrl: body.endpointUrl?.trim() || null,
      apiKey: body.apiKey?.trim() || null,
      model: body.model?.trim() || null,
      paramsJson: body.params ? JSON.stringify(body.params) : null,
      isDefault,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: providerProfiles.id })
    .all();

  // 新档案设为默认时，清除同能力其他默认
  if (isDefault) clearOtherDefaults(db, capability, r[0]!.id);
  return NextResponse.json({ id: r[0]!.id }, { status: 201 });
}

/** 清除同能力其他档案的默认位 */
function clearOtherDefaults(
  db: ReturnType<typeof getDb>,
  capability: string,
  keepId: number
): void {
  db.update(providerProfiles)
    .set({ isDefault: false, updatedAt: new Date() })
    .where(eq(providerProfiles.capability, capability))
    .run();
  db.update(providerProfiles)
    .set({ isDefault: true, updatedAt: new Date() })
    .where(eq(providerProfiles.id, keepId))
    .run();
}
