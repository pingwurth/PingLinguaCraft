// Next.js 配置：monorepo 内 TS 源码包需要显式转译；服务器组件包外部化数据库驱动；
// serwist 包装提供 PWA Service Worker（生产构建启用，开发自动禁用）
import withSerwistInit from '@serwist/next';

/** serwist 包装（sw.ts 源文件 → 构建期注入资源清单） */
const withSerwist = withSerwistInit({
  swSrc: 'src/app/sw.ts',
  swDest: 'public/sw.js',
  disable: process.env.NODE_ENV === 'development',
});

const nextConfig = {
  // @pinglc/core 以 TS 源码发布（无构建产物），需让 Next 转译
  transpilePackages: ['@pinglc/core'],
  // better-sqlite3 为原生模块，服务端引用时不应被打包器处理
  serverExternalPackages: ['better-sqlite3'],
};

export default withSerwist(nextConfig);
