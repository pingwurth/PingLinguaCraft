'use client';

/**
 * 语流 页 —— 全部材料的连续研习流（底部导航「语流」入口）
 *
 * 队列 = 所有字幕就绪的材料，按「最近研习优先」排列（见 /api/stream/queue）；
 * 顺听模式：自动连播 + 字幕瀑布跟随 + 位图进度上报（听过计入闯关解锁）。
 * 空态：无就绪材料时引导去导入。
 */

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { StreamPlayer } from '@/features/stream/StreamPlayer';
import { api, type StreamQueueItem } from '@/lib/api';

/**
 * 语流页组件
 */
export default function StreamPage() {
  /* 语流队列（进入页面拉取一次；连播期间的进度变化不重排队列——顺序稳定性优先，
     故关掉重连重取：队列按最近研习排序，而本页进度上报恰好刷新排序键） */
  const queueQuery = useQuery({
    queryKey: ['stream-queue'],
    queryFn: () => api<{ queue: StreamQueueItem[] }>('/api/stream/queue'),
    refetchOnReconnect: false,
  });

  if (queueQuery.isLoading) {
    return <div className="p-10 text-center text-sm text-muted-foreground">汇聚语流中…</div>;
  }
  if (queueQuery.isError) {
    return <div className="p-10 text-center text-sm text-destructive">语流队列装载失败</div>;
  }
  const queue = queueQuery.data?.queue ?? [];
  if (queue.length === 0) {
    return (
      /* 空态：没有就绪材料，引导导入 */
      <div className="deckle mx-auto mt-10 max-w-md rounded-md border bg-card p-8 text-center">
        <span className="material-symbols-outlined text-4xl text-ochre">graphic_eq</span>
        <p className="mt-3 font-serif text-base">语流尚静，纳新入卷后方成溪河</p>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          导入音频/视频/文本并等待字幕就绪，即可在语流中连续研读全部材料。
        </p>
        <Link
          href="/import"
          className="mt-5 inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground"
        >
          <span className="material-symbols-outlined text-base">add</span>
          去导入
        </Link>
      </div>
    );
  }
  return <StreamPlayer queue={queue} />;
}
