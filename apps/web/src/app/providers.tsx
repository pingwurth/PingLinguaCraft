'use client';

/**
 * 全局客户端 Provider：TanStack Query（任务轮询/数据请求的状态中心）
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';

/**
 * Provider 组件：挂载在根布局，包裹所有客户端交互
 * @param props.children 页面内容
 */
export function Providers({ children }: { children: React.ReactNode }) {
  // useState 惰性初始化：客户端组件树只建一个 QueryClient
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // 任务/数据都为局域网自托管：失败快速重试，不长时间停摆
            retry: 1,
            refetchOnWindowFocus: false,
          },
        },
      })
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
