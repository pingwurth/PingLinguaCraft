// Next.js 配置：monorepo 内 TS 源码包需要显式转译；服务器组件包外部化数据库驱动
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // @pinglc/core 以 TS 源码发布（无构建产物），需让 Next 转译
  transpilePackages: ['@pinglc/core'],
  // better-sqlite3 为原生模块，服务端引用时不应被打包器处理
  serverExternalPackages: ['better-sqlite3'],
};

export default nextConfig;
