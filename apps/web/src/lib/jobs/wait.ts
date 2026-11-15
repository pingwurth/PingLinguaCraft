/**
 * 任务等待工具（客户端）：提交任务后轮询至终态的共享实现
 *
 * 供词藏页 AI 笔记/深学卡等「mutationFn 内联等待任务完成」的场景使用
 * （轮询收在 mutationFn 里：isPending 全程为真，按钮不会提前恢复可点，
 * 组件卸载也不留游离的 interval）。注意与 QuizTab 那类「组件态轮询
 * （展示实时进度、容忍失败继续轮）」语义不同，不强行合并。
 */

import { ApiError, type JobDTO } from '@pinglc/core';
import { api } from '@/lib/api';

/** 任务终态轮询间隔（毫秒） */
const POLL_INTERVAL_MS = 1500;

/** 超时提示文案（数据可能晚到——服务端任务不受客户端超时影响） */
const TIMEOUT_MSG = '生成超时；数据可能稍后仍会就位，回来刷新即可';

/**
 * 等待任务到终态（succeeded 返回；failed 抛任务错误；超时抛超时）
 *
 * 真墙钟上界：每次轮询前检查剩余预算、休眠至多剩余量，且单次请求挂
 * AbortSignal 到期即断——单个 GET 挂死不会让整段等待悬空。瞬时网络抖动
 * 不判死（任务仍在服务端跑），继续轮到 deadline。
 * @param jobId     任务 id
 * @param timeoutMs 兜底超时（毫秒，默认 180 秒——structuredLLM 可能两轮
 *                  /llm/chat 往返 + 慢云模型，120s 偏紧）
 */
export async function waitForJob(jobId: string, timeoutMs = 180_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remain = deadline - Date.now();
    if (remain <= 0) throw new Error(TIMEOUT_MSG);
    await new Promise((r) => setTimeout(r, Math.min(POLL_INTERVAL_MS, remain)));
    let job: JobDTO;
    try {
      ({ job } = await api<{ job: JobDTO }>(`/api/jobs/${jobId}`, {
        signal: AbortSignal.timeout(Math.max(deadline - Date.now(), 1)),
      }));
    } catch (err) {
      // ApiError（服务端明确答复，如 404 任务不存在）是确定性失败：立刻上抛，
      // 别拖成 180s 空转后的「生成超时」（还会反复触发 recoverStaleJobs）；
      // 仅网络级异常 / 单次请求超时继续轮——任务仍在服务端跑
      if (err instanceof ApiError) throw err;
      if (deadline - Date.now() <= 0) throw new Error(TIMEOUT_MSG);
      continue;
    }
    // JobDTO.status 联合类型仍含 'cancelled'（引擎侧语义；web 落表目前不写）
    // ——防御性保留，一旦出现给准确文案，而非空转到超时
    if (job.status === 'succeeded') return;
    if (job.status === 'failed' || job.status === 'cancelled') {
      throw new Error(job.error || (job.status === 'cancelled' ? '任务已取消' : '任务失败'));
    }
    if (deadline - Date.now() <= 0) throw new Error(TIMEOUT_MSG);
  }
}
