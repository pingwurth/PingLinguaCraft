/**
 * 引擎状态 API：GET /api/engine —— 健康与能力探测（设置页/导入向导的数据源）
 */

import { NextResponse } from 'next/server';
import { engineCapabilities, engineHealth, EngineError } from '@/lib/server/engine';

export const runtime = 'nodejs';

/**
 * GET —— { healthy, capabilities }（引擎离线时 healthy=false，capabilities 为 null）
 */
export async function GET() {
  const healthy = await engineHealth();
  if (!healthy) return NextResponse.json({ healthy: false, capabilities: null });
  try {
    const capabilities = await engineCapabilities();
    return NextResponse.json({ healthy: true, capabilities });
  } catch (err) {
    const msg = err instanceof EngineError ? err.message : '能力探测失败';
    return NextResponse.json({ healthy: true, capabilities: null, error: msg });
  }
}
