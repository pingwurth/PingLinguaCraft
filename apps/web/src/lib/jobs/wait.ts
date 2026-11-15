/**
 * 任务等待工具（客户端）：提交任务后轮询至终态的共享实现
 *
 * 供词藏页 AI 笔记/深学卡等「mutationFn 内联等待任务完成」的场景使用
 * （轮询收在 mutationFn 里：isPending 全程为真，按钮不会提前恢复可点，
 * 组件卸载也不留游离的 interval）。注意与 QuizTab 那类「组件态轮询
 * （展示实时进度、容忍失败继续轮）」语义不同，不强行合并。
 */

import { api } from '@/lib/api';

/** 任务终态轮询间隔（毫秒） */
const POLL_INTERVAL_MS = 1500;

/**
 * 等待任务到终态（succeeded 返回；failed/cancelled 抛任务错误；超时抛超时）
 * @param jobId     任务 id
 * @param timeoutMs 兜底超时（毫秒，默认 120 秒）
 */
export async function waitForJob(jobId: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const { job } = await api<{ job: { status: string; error: string | null } }>(`/api/jobs/${jobId}`);
    if (job.status === 'succeeded') return;
    if (job.status === 'failed') throw new Error(job.error || '任务失败');
    if (job.status === 'cancelled') throw new Error('任务已取消');
    if (Date.now() > deadline) throw new Error('生成超时；数据可能稍后仍会就位，回来刷新即可');
  }
}
