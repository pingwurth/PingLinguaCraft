/**
 * Next.js instrumentation 入口：服务进程启动时执行一次（先于任何请求路由）
 *
 * 职责：在首个请求到来前完成数据库迁移（含迁移前自动快照，见 lib/db/migrate.ts），
 * 取代 getDb() 的懒触发——消除「迁移失败后每请求重开连接重跑迁移」的抖动，
 * 并保证 DDL 执行前存在可回退的库文件快照。
 */

/**
 * Next 启动钩子（next dev 与 next start 均会调用一次）
 * 动态 import 必须包在 NEXT_RUNTIME === 'nodejs' 的静态 if 分支内：
 * Next 编译时把 process.env.NEXT_RUNTIME 求值为字面量，只对「if (常量) { ... }」
 * 形式的分支做依赖裁剪——早退守卫（if (...) return）之后的语句仍会被解析并收集
 * 依赖；一旦项目加入 middleware/edge 路由触发 Edge 编译，Edge bundle 会尝试打入
 * ./lib/db/migrate（better-sqlite3 / node:fs）而构建失败。
 */
export async function register(): Promise<void> {
  // 仅 Node 运行时执行；next build 的页面数据收集阶段（phase-production-build）
  // 也会加载本文件：构建机/CI 不应触碰用户库
  if (process.env.NEXT_RUNTIME === 'nodejs' && process.env.NEXT_PHASE !== 'phase-production-build') {
    const { ensureDatabaseReady } = await import('./lib/db/migrate');
    try {
      ensureDatabaseReady();
    } catch (err) {
      // fail fast：迁移失败的库不该静默对外服务；数据请求将由懒兜底路径的
      // 缓存错误拒绝（500），修复后重启进程重试
      console.error('[startup] 数据库迁移失败，服务将以错误拒绝数据请求（详见上方迁移日志）');
      throw err;
    }
  }
}
