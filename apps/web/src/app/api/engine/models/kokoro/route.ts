/**
 * kokoro 模型下载：POST /api/engine/models/kokoro —— 创建 model_download 管线任务
 *
 * 下载经既有 jobs 管线执行（web 建任务行 + startPipeline → 引擎任务队列，
 * 进度查询走通用 GET /api/jobs/[id]）：web/引擎任一重启后 recovery 重跑
 * 即续传（引擎侧下载幂等、本地优先），不产生孤儿任务；此前此路由自带
 * 提交+轮询代理与任务快照类型，是管线之外的平行实现，已收敛。
 */

import { NextResponse } from 'next/server';
import { createJob, startPipeline } from '@/lib/jobs/pipeline';

export const runtime = 'nodejs';

/**
 * POST —— 创建下载任务（重复触发安全：已就绪时引擎任务即刻空转成功）
 * 返回 { jobId }（客户端轮询 /api/jobs/:id）
 */
export async function POST() {
  const jobId = createJob({ type: 'model_download', payload: { engine: 'kokoro' } });
  startPipeline(jobId);
  return NextResponse.json({ jobId });
}
