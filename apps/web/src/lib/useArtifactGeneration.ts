'use client';

/**
 * 词产物生成回路 hook（手册页词源卡/辨析矩阵卡与词藏页深学行同构共用）
 *
 * 只封装「POST（force 由已有产物谓词在提交时求值）→ waitForJob → refetch」
 * 的生成回路；查询本身归调用方（各处门控与数据形态不同），refetch 由调用方
 * 传入指回自己的查询。
 */

import { useMutation } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { waitForJob } from '@/lib/jobs/wait';

/** 词产物 API 路径段（注意与管线侧 ai_artifacts.kind 联合是两个概念：
 *  此处 'deep' 在服务端落库为 kind='imitation'——命名区分防误混） */
export type WordArtifactPath = 'deep' | 'discriminate';

/**
 * 词产物生成回路 hook
 * @param wordId   单词 id
 * @param kind     产物 API 路径段
 * @param hasData  已有产物判定（提交时求值；按钮文案同判据复用）
 * @param refetch  生成结束后回填调用方自己的查询
 */
export function useArtifactGenerate(
  wordId: number,
  kind: WordArtifactPath,
  hasData: () => boolean,
  refetch: () => void,
) {
  return useMutation({
    mutationFn: async () => {
      // force 与已有数据绑定：按钮文案为「重新生成」时必须真重生成
      const r = await api<{ cached?: boolean; jobId?: string }>(`/api/words/${wordId}/${kind}`, {
        method: 'POST',
        body: JSON.stringify({ force: hasData() }),
      });
      if (r.cached || !r.jobId) return;
      // 轮询收在 mutationFn 内：isPending 全程为真（防重复建任务），卸载不留定时器
      await waitForJob(r.jobId);
    },
    // onSettled 而非 onSuccess：waitForJob 超时/异常时服务端任务可能仍已完成
    //（其超时文案自认「数据可能稍后仍会就位」），失败也回填一次查询，
    // 用户重进页面看到的才是 DB 真实落点
    onSettled: () => refetch(),
  });
}

/** 生成键文案（进行中优先于已有产物：重生成途中也换「生成中…」给用户确认
 *  点击已生效，而不是维持「重新生成」毫无反馈） */
export function genLabel(hasData: boolean, pending: boolean): string {
  if (pending) return '生成中…';
  if (hasData) return '重新生成';
  return '生成';
}
