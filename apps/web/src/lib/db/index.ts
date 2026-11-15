/**
 * 数据库连接管理（better-sqlite3 + Drizzle）
 *
 * 单例模式：首次调用时打开 ~/.pinglc/pinglc.db。WAL 模式提升并发读写性能
 * （播放页轮询与写入并存），busy 超时避免偶发锁冲突直接报错。
 *
 * 迁移已前置到应用启动时的 instrumentation 入口（src/instrumentation.ts →
 * lib/db/migrate.ts：启动一次性执行 + 迁移前自动快照）；此处保留同步兜底：
 * instrumentation 未覆盖的场景（脚本直接引入等）在首个连接上补跑，
 * 迁移状态全局单飞且失败缓存——失败后不再每次请求重开连接重跑迁移。
 */

import { drizzle } from 'drizzle-orm/better-sqlite3';
import { runMigrations, migrationFailure, openDatabase } from './migrate';
import * as schema from './schema';

// 路径常量对外维持从 '@/lib/db' 导出的既有用法
export { PINGLC_HOME, DB_PATH, MEDIA_ROOT } from './paths';

/** 数据库连接单例（懒加载） */
let dbInstance: ReturnType<typeof createDb> | null = null;

/**
 * 创建新的数据库连接（内部函数，外部请使用 getDb）
 *
 * 打开库文件前先检查迁移状态：此前迁移已失败时直接抛缓存错误（不再重开连接
 * 重跑）；成功路径下若 instrumentation 未执行过迁移则同步补跑（兜底）。
 * @returns Drizzle 数据库实例（含 schema 类型）
 */
function createDb() {
  // 之前迁移已失败：快速失败（重启进程才会重试）
  const failure = migrationFailure();
  if (failure) throw failure;

  // 建连引导（目录创建/WAL/busy 超时/打开前存在性记录）与启动路径共用 openDatabase，
  // 一处实现避免两条路径的连接参数漂移
  const { sqlite, dbExisted } = openDatabase();

  try {
    // 兜底迁移：正常路径由 instrumentation 启动时完成，此处通常为空操作
    runMigrations(sqlite, dbExisted);
  } catch (err) {
    // 迁移失败必须先关闭连接再抛出：句柄不关会泄漏（better-sqlite3 长持文件描述符）；
    // 附上下文后原样抛出，保留原始堆栈便于定位（可在 apps/web 下运行 pnpm db:migrate 复现详情）
    sqlite.close();
    console.error('[db] 自动迁移失败（连接已关闭，重启进程后才会重试）：', err);
    throw err;
  }
  // 外键强制（显式声明 better-sqlite3 的默认行为，自文档）：schema 声明的
  // ON DELETE cascade/set null 依赖此开关生效；存量悬空引用由启动路径的
  // cleanDanglingRefs 前置清理 + foreign_key_check 体检兜底
  sqlite.pragma('foreign_keys = ON');
  return drizzle(sqlite, { schema });
}

/**
 * 获取数据库连接单例
 * @returns Drizzle 数据库实例
 */
export function getDb() {
  if (!dbInstance) dbInstance = createDb();
  return dbInstance;
}
