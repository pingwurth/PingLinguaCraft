/**
 * 单档案 API：PATCH 更新 / DELETE 删除 / POST 设默认（按 query 参数区分）
 */

import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { providerProfiles } from '@/lib/db/schema';

export const runtime = 'nodejs';

/**
 * PATCH /api/providers/[id] —— 更新档案字段（apiKey 传空串=清除）
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await request.json()) as {
    name?: string;
    endpointUrl?: string;
    apiKey?: string;
    model?: string;
    params?: Record<string, unknown>;
  };
  const db = getDb();
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (body.name !== undefined) patch.name = body.name.trim();
  if (body.endpointUrl !== undefined) patch.endpointUrl = body.endpointUrl.trim() || null;
  if (body.apiKey !== undefined) patch.apiKey = body.apiKey.trim() || null;
  if (body.model !== undefined) patch.model = body.model.trim() || null;
  if (body.params !== undefined) patch.paramsJson = JSON.stringify(body.params);
  db.update(providerProfiles)
    .set(patch)
    .where(and(eq(providerProfiles.id, Number(id)), eq(providerProfiles.userId, 1)))
    .run();
  return NextResponse.json({ ok: true });
}

/**
 * POST /api/providers/[id]?action=default —— 设为该能力默认档案
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const url = new URL(request.url);
  const action = url.searchParams.get('action');
  if (action !== 'default') {
    return NextResponse.json({ error: '未知操作（支持 action=default）' }, { status: 400 });
  }
  const db = getDb();
  const row = db
    .select()
    .from(providerProfiles)
    .where(eq(providerProfiles.id, Number(id)))
    .all()[0];
  if (!row) return NextResponse.json({ error: '档案不存在' }, { status: 404 });
  const now = new Date();
  db.update(providerProfiles)
    .set({ isDefault: false, updatedAt: now })
    .where(eq(providerProfiles.capability, row.capability))
    .run();
  db.update(providerProfiles)
    .set({ isDefault: true, updatedAt: now })
    .where(eq(providerProfiles.id, row.id))
    .run();
  return NextResponse.json({ ok: true });
}

/**
 * DELETE /api/providers/[id] —— 删除档案（若是默认，剩余首个自动补位）
 */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = getDb();
  const row = db
    .select()
    .from(providerProfiles)
    .where(eq(providerProfiles.id, Number(id)))
    .all()[0];
  if (!row) return NextResponse.json({ error: '档案不存在' }, { status: 404 });
  db.delete(providerProfiles).where(eq(providerProfiles.id, row.id)).run();
  if (row.isDefault) {
    const next = db
      .select({ id: providerProfiles.id })
      .from(providerProfiles)
      .where(eq(providerProfiles.capability, row.capability))
      .all()[0];
    if (next) {
      db.update(providerProfiles)
        .set({ isDefault: true })
        .where(eq(providerProfiles.id, next.id))
        .run();
    }
  }
  return NextResponse.json({ ok: true });
}
